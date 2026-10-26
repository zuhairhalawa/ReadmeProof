import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import type { Captured, DockerRuntime, ExecOptions, ExecResult } from '../src/docker.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesDir = path.join(repoRoot, 'test', 'fixtures');

const tempDirs: string[] = [];

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Create a temp directory (realpath'd: macOS /var is a symlink) that is removed after the run. */
export function makeTempDir(prefix = 'rp-test-'): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(d);
  /* Marker so project discovery never walks above the temp dir into unrelated parents. */
  mkdirSync(path.join(d, '.git'));
  return d;
}

export function writeTree(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Copy a committed fixture into a temp dir so the repository's own .git never becomes the project boundary. */
export function copyFixture(name: string): string {
  const dest = path.join(makeTempDir(), name);
  cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

export interface Captured2 {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], cwd: string, runtime?: DockerRuntime, env: NodeJS.ProcessEnv = {}): Promise<Captured2> {
  let stdout = '';
  let stderr = '';
  const io: Parameters<typeof main>[1] = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    cwd,
    env,
    stdoutIsTTY: false,
  };
  if (runtime) io.runtime = runtime;
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

/* ---------- tar reader (independent of the writer under test) ---------- */

export interface ReadEntry {
  name: string;
  type: string;
  mode: number;
  size: number;
  data: Buffer;
}

function field(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? len : nul).toString('utf8');
}

export function readTar(buf: Buffer): ReadEntry[] {
  const entries: ReadEntry[] = [];
  let off = 0;
  let paxPath: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = field(h, 0, 100);
    const size = parseInt(field(h, 124, 12), 8);
    const type = String.fromCharCode(h[156] ?? 0x30);
    const mode = parseInt(field(h, 100, 8), 8);
    const stored = field(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (parseInt(stored, 8) !== sum) throw new Error(`bad tar checksum for ${name}`);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const text = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      paxPath = m?.[1];
      continue;
    }
    entries.push({ name: paxPath ?? name, type, mode, size, data: Buffer.from(data) });
    paxPath = undefined;
  }
  return entries;
}

/* ---------- fake Docker runtime ---------- */

export interface FakeRunOutcome {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** When false the block never starts (simulates container/unpack failure). */
  started?: boolean;
  created?: Record<string, 'created' | 'missing' | 'preexisting'>;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
  stdoutTruncated?: boolean;
}

export interface RunContext {
  args: string[];
  input: Buffer;
  nonce: string;
  script: string;
}

export interface FakeDockerOptions {
  versionStdout?: string;
  versionFails?: { stderr: string };
  cliMissing?: boolean;
  imagePresent?: boolean;
  pullOk?: boolean;
  run?: (ctx: RunContext) => FakeRunOutcome;
}

function cap(text: string, truncated = false): Captured {
  return { text, tail: '', truncated, totalBytes: Buffer.byteLength(text) };
}

export class FakeDocker implements DockerRuntime {
  readonly calls: string[][] = [];
  readonly runs: RunContext[] = [];
  readonly runOptions: ExecOptions[] = [];
  constructor(private readonly opts: FakeDockerOptions = {}) {}

  exec(args: string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push(args);
    if (args[0] === 'run') this.runOptions.push(options);
    const base = (over: Partial<ExecResult>): ExecResult => ({
      exitCode: 0,
      stdout: cap(''),
      stderr: cap(''),
      timedOut: false,
      outputLimitExceeded: false,
      durationMs: 5,
      ...over,
    });
    const o = this.opts;
    switch (args[0]) {
      case 'version':
        if (o.cliMissing) return Promise.resolve(base({ exitCode: null, spawnError: { code: 'ENOENT', message: 'spawn docker ENOENT' } }));
        if (o.versionFails) return Promise.resolve(base({ exitCode: 1, stderr: cap(o.versionFails.stderr) }));
        return Promise.resolve(base({ stdout: cap(o.versionStdout ?? '27.0.1|linux') }));
      case 'image':
        return Promise.resolve(base({ exitCode: o.imagePresent === false ? 1 : 0 }));
      case 'pull':
        return Promise.resolve(base({ exitCode: o.pullOk === false ? 1 : 0, stderr: cap(o.pullOk === false ? 'pull access denied' : '') }));
      case 'run': {
        const script = args[args.length - 1] as string;
        const nonce = /@@RP-[0-9a-f]+/.exec(script)?.[0] ?? '';
        const ctx: RunContext = { args, input: options.input ?? Buffer.alloc(0), nonce, script };
        this.runs.push(ctx);
        const out = o.run ? o.run(ctx) : {};
        const started = out.started !== false;
        const exit = out.exitCode ?? 0;
        let stdout = '';
        if (started) stdout += `\n${nonce} STARTED\n`;
        stdout += out.stdout ?? '';
        if (started) {
          stdout += `\n${nonce} DONE ${exit}\n`;
          for (const [p, state] of Object.entries(out.created ?? {})) stdout += `\n${nonce} CREATED ${state} ${p}\n`;
        }
        return Promise.resolve(
          base({
            exitCode: exit,
            stdout: cap(stdout, out.stdoutTruncated === true),
            stderr: cap(out.stderr ?? ''),
            timedOut: out.timedOut === true,
            outputLimitExceeded: out.outputLimitExceeded === true,
          }),
        );
      }
      default:
        return Promise.resolve(base({}));
    }
  }
}

