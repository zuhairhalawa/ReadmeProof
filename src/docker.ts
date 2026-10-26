import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Interpreter } from './blocks.js';
import { buildTar, type TarEntry } from './tar.js';

/**
 * Docker isolation layer.
 *
 * Design rules (see SECURITY.md):
 *  - README commands only ever run inside a disposable container; there is no host fallback.
 *  - The project is streamed in as a tar over stdin into a tmpfs. No bind mounts, no volumes,
 *    no docker socket, no host home directory.
 *  - Nothing from the host environment reaches the container: only a fixed, short env list.
 *  - Annotations in the README can never change any of these settings.
 */

export const DEFAULT_IMAGE = 'node:22-bookworm-slim';
export const CONTAINER_USER = '1000:1000';

export interface ContainerSettings {
  image: string;
  /** Network access is off unless the user passes --network. */
  network: boolean;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  workTmpfsMb: number;
  tmpTmpfsMb: number;
}

export const DEFAULT_SETTINGS: ContainerSettings = {
  image: DEFAULT_IMAGE,
  network: false,
  memoryMb: 1024,
  cpus: 1,
  pidsLimit: 512,
  workTmpfsMb: 256,
  tmpTmpfsMb: 128,
};

const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/;

/** Returns an error message when `image` is not a plain image reference. */
export function validateImage(image: string): string | undefined {
  if (!IMAGE_PATTERN.test(image)) {
    return 'image reference must contain only letters, digits and . _ / : @ - and must not start with "-"';
  }
  return undefined;
}

export interface RunArgsInput {
  name: string;
  settings: ContainerSettings;
  interpreter: Interpreter;
  /** True when the block is JavaScript that needs ESM semantics. */
  esm: boolean;
  nonce: string;
}

/** The fixed in-container environment. Host variables are never forwarded. */
export const CONTAINER_ENV: ReadonlyArray<readonly [string, string]> = [
  ['HOME', '/tmp/home'],
  ['CI', 'true'],
  ['TERM', 'dumb'],
  ['NO_COLOR', '1'],
  ['LANG', 'C.UTF-8'],
  ['npm_config_cache', '/tmp/.npm'],
  ['npm_config_update_notifier', 'false'],
  ['npm_config_fund', 'false'],
  ['npm_config_audit', 'false'],
];

/** In-container wrapper. Markers carry a per-run nonce so program output cannot forge them. */
export function buildWrapperScript(input: Pick<RunArgsInput, 'interpreter' | 'esm' | 'nonce'>): string {
  const n = input.nonce;
  const run =
    input.interpreter === 'node'
      ? `node ${input.esm ? '--input-type=module ' : ''}- < /rp/block`
      : `${input.interpreter} /rp/block`;
  return [
    'tar -xf - -C / || { echo "readmeproof: could not unpack the workspace" >&2; exit 125; }',
    'exec 0</dev/null',
    'cd /work || exit 125',
    ': > /rp/pre',
    'while IFS= read -r rp_p; do [ -e "$rp_p" ] && printf "%s\\n" "$rp_p" >> /rp/pre; done < /rp/creates',
    `printf '\\n${n} STARTED\\n'`,
    run,
    'rp_code=$?',
    `printf '\\n${n} DONE %s\\n' "$rp_code"`,
    'while IFS= read -r rp_p; do',
    '  if grep -qxF -- "$rp_p" /rp/pre; then rp_s=preexisting; elif [ -e "$rp_p" ]; then rp_s=created; else rp_s=missing; fi',
    `  printf '\\n${n} CREATED %s %s\\n' "$rp_s" "$rp_p"`,
    'done < /rp/creates',
    'exit "$rp_code"',
  ].join('\n');
}

/** Pure function: the exact `docker run` argument vector. Unit-tested for forbidden flags. */
export function buildRunArgs(input: RunArgsInput): string[] {
  const s = input.settings;
  const args: string[] = [
    'run',
    '--rm',
    '-i',
    '--name', input.name,
    '--label', 'readmeproof=1',
    '--pull', 'never',
    '--network', s.network ? 'bridge' : 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', CONTAINER_USER,
    '--memory', `${s.memoryMb}m`,
    '--memory-swap', `${s.memoryMb}m`,
    '--cpus', String(s.cpus),
    '--pids-limit', String(s.pidsLimit),
    '--ulimit', 'nofile=2048:2048',
    '--ulimit', 'core=0',
    '--tmpfs', `/work:rw,exec,nosuid,nodev,size=${s.workTmpfsMb}m,uid=1000,gid=1000,mode=0755`,
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${s.tmpTmpfsMb}m,uid=1000,gid=1000,mode=1777`,
    '--tmpfs', '/rp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700',
    '--workdir', '/work',
    '--hostname', 'readmeproof',
  ];
  for (const [k, v] of CONTAINER_ENV) args.push('--env', `${k}=${v}`);
  args.push('--entrypoint', 'sh', s.image, '-c', buildWrapperScript(input));
  return args;
}

/* ---------- process runtime ---------- */

export interface Captured {
  /** Leading bytes, up to the cap. */
  text: string;
  /** Trailing bytes (only populated when output exceeded the cap). */
  tail: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ExecOptions {
  input?: Buffer;
  timeoutMs: number;
  /** Bytes kept per stream. */
  maxCaptureBytes: number;
  /** Kill the process when stdout+stderr together exceed this many bytes. */
  killOutputBytes: number;
  /** Called once when the timeout fires, before the process is killed. */
  onTimeout?: () => Promise<void>;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: Captured;
  stderr: Captured;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: { code: string | undefined; message: string };
  durationMs: number;
}

export interface DockerRuntime {
  exec(args: string[], options: ExecOptions): Promise<ExecResult>;
}

const TAIL_BYTES = 16 * 1024;

class Capture {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tailBuf: Buffer = Buffer.alloc(0);
  total = 0;
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < this.cap) {
      const room = this.cap - this.headBytes;
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.head.push(part);
      this.headBytes += part.length;
    }
    if (this.total > this.cap) {
      this.tailBuf = Buffer.concat([this.tailBuf, chunk]);
      if (this.tailBuf.length > TAIL_BYTES) this.tailBuf = this.tailBuf.subarray(this.tailBuf.length - TAIL_BYTES);
    }
  }
  result(): Captured {
    const truncated = this.total > this.cap;
    return {
      text: Buffer.concat(this.head).toString('utf8'),
      tail: truncated ? this.tailBuf.toString('utf8') : '',
      truncated,
      totalBytes: this.total,
    };
  }
}

/** Environment for the docker CLI process itself (not for containers). */
const CLIENT_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
  'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_API_VERSION', 'DOCKER_DEFAULT_PLATFORM',
  'ProgramData', 'ProgramFiles', 'ProgramW6432', 'XDG_CONFIG_HOME',
];

export function dockerClientEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CLIENT_ENV_ALLOWLIST) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function createDockerRuntime(binary = 'docker', parentEnv: NodeJS.ProcessEnv = process.env): DockerRuntime {
  return {
    exec(args, options) {
      return new Promise<ExecResult>((resolve) => {
        const started = Date.now();
        const out = new Capture(options.maxCaptureBytes);
        const err = new Capture(options.maxCaptureBytes);
        let timedOut = false;
        let overflow = false;
        let settled = false;
        let spawnError: ExecResult['spawnError'];
        const child = spawn(binary, args, {
          env: dockerClientEnv(parentEnv),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const result: ExecResult = {
            exitCode: code,
            stdout: out.result(),
            stderr: err.result(),
            timedOut,
            outputLimitExceeded: overflow,
            durationMs: Date.now() - started,
          };
          if (spawnError) result.spawnError = spawnError;
          resolve(result);
        };
        const checkOverflow = (): void => {
          if (!overflow && out.total + err.total > options.killOutputBytes) {
            overflow = true;
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          const kill = (): void => {
            child.kill('SIGKILL');
          };
          if (options.onTimeout) options.onTimeout().then(() => setTimeout(kill, 2000), kill);
          else kill();
        }, options.timeoutMs);
        child.stdout.on('data', (c: Buffer) => {
          out.push(c);
          checkOverflow();
        });
        child.stderr.on('data', (c: Buffer) => {
          err.push(c);
          checkOverflow();
        });
        child.on('error', (e: NodeJS.ErrnoException) => {
          spawnError = { code: e.code, message: e.message };
          finish(null);
        });
        child.on('close', (code) => finish(code));
        child.stdin.on('error', () => {
          /* EPIPE when the container exits before reading all input */
        });
        if (options.input) child.stdin.end(options.input);
        else child.stdin.end();
      });
    },
  };
}

/* ---------- availability ---------- */

export type DockerStatus =
  | { available: true; version: string }
  | { available: false; kind: 'cli-missing' | 'daemon-unreachable' | 'unsupported-os' | 'image-missing' | 'error'; reason: string; fix: string };

const SMALL: Pick<ExecOptions, 'maxCaptureBytes' | 'killOutputBytes'> = { maxCaptureBytes: 16 * 1024, killOutputBytes: 1024 * 1024 };

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 300);
}

export async function detectDocker(runtime: DockerRuntime): Promise<DockerStatus> {
  const r = await runtime.exec(['version', '--format', '{{.Server.Version}}|{{.Server.Os}}'], { ...SMALL, timeoutMs: 20000 });
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') {
      return {
        available: false,
        kind: 'cli-missing',
        reason: 'the docker command was not found on PATH',
        fix: 'Install Docker (https://docs.docker.com/get-docker/) and make sure "docker" is on PATH. Static checks (readmeproof check) work without Docker.',
      };
    }
    return { available: false, kind: 'error', reason: `could not start docker: ${r.spawnError.message}`, fix: 'Check that the docker binary is executable.' };
  }
  if (r.timedOut) {
    return { available: false, kind: 'daemon-unreachable', reason: 'docker did not answer within 20 seconds', fix: 'Start the Docker daemon (for example Docker Desktop) and retry.' };
  }
  if (r.exitCode !== 0) {
    const detail = firstLine(r.stderr.text);
    return {
      available: false,
      kind: 'daemon-unreachable',
      reason: `the Docker daemon is not reachable${detail ? `: ${detail}` : ''}`,
      fix: 'Start the Docker daemon (for example Docker Desktop) and retry. Nothing was executed.',
    };
  }
  const [version = '', os = ''] = r.stdout.text.trim().split('|');
  if (os !== 'linux') {
    return {
      available: false,
      kind: 'unsupported-os',
      reason: `the Docker daemon runs "${os || 'unknown'}" containers; Linux containers are required`,
      fix: 'Switch Docker Desktop to Linux containers.',
    };
  }
  return { available: true, version };
}

export async function imagePresent(runtime: DockerRuntime, image: string): Promise<boolean> {
  const r = await runtime.exec(['image', 'inspect', '--format', '{{.Id}}', image], { ...SMALL, timeoutMs: 30000 });
  return r.exitCode === 0 && !r.spawnError;
}

export async function pullImage(runtime: DockerRuntime, image: string): Promise<{ ok: boolean; detail: string }> {
  const r = await runtime.exec(['pull', '--quiet', image], { ...SMALL, timeoutMs: 15 * 60 * 1000 });
  if (r.exitCode === 0) return { ok: true, detail: '' };
  return { ok: false, detail: firstLine(r.stderr.text) || 'docker pull failed' };
}

/* ---------- running one block ---------- */

export interface ContainerRunInput {
  settings: ContainerSettings;
  interpreter: Interpreter;
  code: string;
  workspace: readonly TarEntry[];
  creates: readonly string[];
  timeoutSec: number;
  maxOutputBytes: number;
}

export interface CreatedState {
  path: string;
  state: 'created' | 'missing' | 'preexisting';
}

export interface ContainerRunResult {
  /** True when the block's command actually started inside the container. */
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  created: CreatedState[];
  durationMs: number;
  /** Set when the container could not run the block at all (not the README's fault). */
  infrastructureError?: string;
}

/** True when JS code needs ES module semantics (static import/export). */
export function needsEsm(code: string): boolean {
  for (const line of code.split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('import ') || t.startsWith('import{') || t.startsWith('import*') || t.startsWith('export ')) {
      if (!t.startsWith('import(')) return true;
    }
  }
  return false;
}

interface MarkerParse {
  started: boolean;
  doneCode: number | undefined;
  created: CreatedState[];
  visible: string;
}

function parseMarkers(cap: Captured, nonce: string): MarkerParse {
  const source = cap.truncated ? `${cap.text}\n${cap.tail}` : cap.text;
  let started = false;
  let doneCode: number | undefined;
  const created: CreatedState[] = [];
  const seen = new Set<string>();
  const prefix = `${nonce} `;
  for (const line of source.split('\n')) {
    if (!line.startsWith(prefix) || seen.has(line)) continue;
    seen.add(line);
    const rest = line.slice(prefix.length);
    if (rest === 'STARTED') started = true;
    else if (rest.startsWith('DONE ')) {
      const n = Number(rest.slice(5));
      if (Number.isInteger(n)) doneCode = n;
    } else if (rest.startsWith('CREATED ')) {
      const body = rest.slice(8);
      const sp = body.indexOf(' ');
      const state = body.slice(0, sp);
      if (sp > 0 && (state === 'created' || state === 'missing' || state === 'preexisting')) {
        created.push({ path: body.slice(sp + 1), state });
      }
    }
  }
  /* Markers are printed as "\n<marker>\n": cut the start marker out and everything from the done marker on. */
  let visible = cap.text;
  const startToken = `\n${nonce} STARTED\n`;
  const si = visible.indexOf(startToken);
  if (si >= 0) visible = visible.slice(0, si) + visible.slice(si + startToken.length);
  const di = visible.indexOf(`\n${nonce} DONE `);
  if (di >= 0) visible = visible.slice(0, di);
  return { started, doneCode, created, visible };
}

export async function runBlockInContainer(runtime: DockerRuntime, input: ContainerRunInput): Promise<ContainerRunResult> {
  const nonce = `@@RP-${randomBytes(12).toString('hex')}`;
  const name = `readmeproof-${randomBytes(6).toString('hex')}`;
  const esm = input.interpreter === 'node' && needsEsm(input.code);
  const now = Math.floor(Date.now() / 1000);
  const entries: TarEntry[] = [
    ...input.workspace,
    { path: 'rp/block', type: 'file', mode: 0o600, mtime: now, data: Buffer.from(input.code, 'utf8') },
    { path: 'rp/creates', type: 'file', mode: 0o600, mtime: now, data: Buffer.from(input.creates.map((c) => c + '\n').join(''), 'utf8') },
  ];
  const tar = buildTar(entries);
  const args = buildRunArgs({ name, settings: input.settings, interpreter: input.interpreter, esm, nonce });
  const res = await runtime.exec(args, {
    input: tar,
    timeoutMs: input.timeoutSec * 1000,
    maxCaptureBytes: input.maxOutputBytes,
    killOutputBytes: Math.max(input.maxOutputBytes * 16, 4 * 1024 * 1024),
    onTimeout: async () => {
      await runtime.exec(['kill', name], { ...SMALL, timeoutMs: 15000 });
    },
  });
  /* Belt and braces: --rm should already have removed it, but never leave containers behind. */
  await runtime.exec(['rm', '-f', name], { ...SMALL, timeoutMs: 30000 }).catch(() => undefined);

  const out = parseMarkers(res.stdout, nonce);
  const result: ContainerRunResult = {
    started: out.started,
    exitCode: out.doneCode ?? res.exitCode,
    timedOut: res.timedOut,
    outputLimitExceeded: res.outputLimitExceeded,
    stdout: out.visible,
    stderr: res.stderr.text,
    stdoutTruncated: res.stdout.truncated,
    stderrTruncated: res.stderr.truncated,
    created: out.created,
    durationMs: res.durationMs,
  };
  if (res.spawnError) {
    result.infrastructureError = `could not run docker: ${res.spawnError.message}`;
  } else if (!out.started && !res.timedOut) {
    result.infrastructureError = `the container did not start the block (docker exit code ${res.exitCode ?? 'none'}): ${firstLine(res.stderr.text) || 'no error output'}`;
  }
  return result;
}

