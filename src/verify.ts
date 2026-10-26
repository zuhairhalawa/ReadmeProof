import { hasAssertions } from './annotations.js';
import { interpreterFor } from './blocks.js';
import {
  detectDocker,
  imagePresent,
  pullImage,
  runBlockInContainer,
  validateImage,
  type ContainerRunResult,
  type ContainerSettings,
  type DockerRuntime,
} from './docker.js';
import { isDangerousRoot, UsageError, type Project } from './project.js';
import { clip } from './safe.js';
import type { AssertionResult, BlockResult, CodeBlock, ParsedDocument } from './types.js';
import { collectWorkspace, WorkspaceError, type Workspace } from './workspace.js';

export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_CEILING_SEC = 900;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface VerifyOptions {
  doc: ParsedDocument;
  project: Project;
  runtime: DockerRuntime;
  settings: ContainerSettings;
  /** Select a single block by annotation name or opening-fence line number. */
  block?: string;
  /** Per-block timeout ceiling in seconds. */
  timeoutSec: number;
  maxOutputBytes: number;
  /** Allow `docker pull` when the image is not present locally. */
  pull: boolean;
  onProgress?: (message: string) => void;
}

export type ExecutionStatus = 'NOT_NEEDED' | 'AVAILABLE' | 'UNAVAILABLE';

export interface ExecutionInfo {
  requested: true;
  backend: 'docker';
  status: ExecutionStatus;
  image: string;
  network: boolean;
  dockerVersion?: string;
  reason?: string;
  fix?: string;
  workspace?: { files: number; bytes: number; skipped: number };
}

export interface VerifyReport {
  execution: ExecutionInfo;
  results: BlockResult[];
}

function baseResult(doc: ParsedDocument, b: CodeBlock): BlockResult {
  const r: BlockResult = {
    id: b.id,
    file: doc.file,
    line: b.line,
    endLine: b.endLine,
    language: b.language,
    status: 'UNVERIFIED',
    executed: false,
    reason: '',
    assertions: [],
  };
  if (b.annotation?.name !== undefined) r.name = b.annotation.name;
  return r;
}

export function selectBlock(doc: ParsedDocument, selector: string): CodeBlock {
  const byName = doc.blocks.find((b) => b.annotation?.name === selector);
  if (byName) return byName;
  if (/^[0-9]+$/.test(selector)) {
    const n = Number(selector);
    const byLine = doc.blocks.find((b) => b.line === n);
    if (byLine) return byLine;
  }
  const names = doc.blocks.map((b) => b.annotation?.name).filter((n): n is string => n !== undefined);
  throw new UsageError(
    `no code block named "${clip(selector, 60)}" in ${doc.file}` +
      (names.length > 0 ? ` (named blocks: ${names.join(', ')})` : ' (this README has no named blocks; add <!-- readmeproof: name=... --> above a block, or pass a line number)'),
  );
}

function normalizeEol(s: string): string {
  return s.split('\r\n').join('\n');
}

export function evaluateAssertions(block: CodeBlock, run: ContainerRunResult): AssertionResult[] {
  const a = block.annotation;
  const out: AssertionResult[] = [];
  const expectedExit = a?.exit ?? 0;
  const actualExit = run.exitCode;
  out.push({
    kind: 'exit',
    expected: String(expectedExit),
    actual: actualExit === null ? 'none' : String(actualExit),
    passed: actualExit === expectedExit,
  });
  const stdout = normalizeEol(run.stdout);
  const stderr = normalizeEol(run.stderr);
  if (a?.output !== undefined) {
    out.push({ kind: 'output', expected: a.output, actual: clip(stdout, 300), passed: stdout.includes(normalizeEol(a.output)) });
  }
  if (a?.outputExact !== undefined) {
    out.push({
      kind: 'output-exact',
      expected: a.outputExact,
      actual: clip(stdout, 300),
      passed: stdout.trimEnd() === normalizeEol(a.outputExact).trimEnd(),
    });
  }
  if (a?.stderr !== undefined) {
    out.push({ kind: 'stderr', expected: a.stderr, actual: clip(stderr, 300), passed: stderr.includes(normalizeEol(a.stderr)) });
  }
  for (const p of a?.creates ?? []) {
    const found = run.created.find((c) => c.path === p);
    const state = found?.state ?? 'unknown';
    out.push({
      kind: 'creates',
      expected: `${p} is created by the block`,
      actual: state === 'created' ? 'created' : state === 'preexisting' ? 'already existed before the block ran' : state === 'missing' ? 'not found after the block ran' : 'not reported',
      passed: state === 'created',
    });
  }
  return out;
}

function networkHint(run: ContainerRunResult, networkEnabled: boolean): string | undefined {
  if (networkEnabled) return undefined;
  const text = `${run.stderr}\n${run.stdout}`.toLowerCase();
  if (/(enotfound|eai_again|getaddrinfo|could not resolve|temporary failure in name resolution|network is unreachable|econnrefused|unable to connect|failed to fetch)/.test(text)) {
    return 'The block appears to need network access, which is disabled by default. If you trust this README, re-run with --network (see SECURITY.md).';
  }
  return undefined;
}

export function resultFromRun(doc: ParsedDocument, block: CodeBlock, run: ContainerRunResult, networkEnabled: boolean): BlockResult {
  const r = baseResult(doc, block);
  r.durationMs = run.durationMs;
  r.executed = run.started;
  if (run.exitCode !== null) r.exitCode = run.exitCode;
  r.stdout = run.stdout;
  r.stderr = run.stderr;
  r.stdoutTruncated = run.stdoutTruncated;
  r.stderrTruncated = run.stderrTruncated;
  r.timedOut = run.timedOut;

  if (run.infrastructureError !== undefined) {
    r.status = 'UNVERIFIED';
    r.reason = `could not execute: ${run.infrastructureError}`;
    r.fix = 'This is a problem with the container setup, not with the README. Check that the image is a Linux image with sh, tar and grep.';
    return r;
  }
  if (run.timedOut) {
    r.status = 'FAIL';
    r.reason = 'the block did not finish before the time limit and was killed';
    r.assertions = [{ kind: 'exit', expected: String(block.annotation?.exit ?? 0), actual: 'timed out', passed: false }];
    r.fix = 'Make the example finish faster, or raise the limit with --timeout (or timeout=<seconds> in the annotation, never above --timeout).';
    return r;
  }
  if (run.outputLimitExceeded) {
    r.status = 'FAIL';
    r.reason = 'the block produced runaway output and was killed';
    r.fix = 'Reduce the amount of output the example prints.';
    return r;
  }
  r.assertions = evaluateAssertions(block, run);
  const failed = r.assertions.filter((x) => !x.passed);
  if (failed.length === 0) {
    r.status = 'PASS';
    r.verification = hasAssertions(block.annotation) ? 'asserted' : 'smoke';
    r.reason = r.verification === 'asserted' ? 'all declared assertions were satisfied' : 'ran and exited with status 0 (no assertions declared, so this only shows the command does not crash)';
    return r;
  }
  const truncatedOutputIssue = failed.every((f) => (f.kind === 'output' || f.kind === 'output-exact') && run.stdoutTruncated) ;
  if (truncatedOutputIssue) {
    r.status = 'UNVERIFIED';
    r.reason = 'expected output was not found, but stdout was truncated so the result cannot be trusted';
    r.fix = 'Reduce the output of the example or assert on a smaller piece of it.';
    return r;
  }
  r.status = 'FAIL';
  r.reason = failed.map((f) => `${f.kind}: expected ${clip(f.expected, 80)}, got ${clip(f.actual, 80)}`).join('; ');
  const hint = networkHint(run, networkEnabled);
  if (hint) r.fix = hint;
  else if (run.exitCode === 127) r.fix = 'A command was not found in the container image. Use --image to choose an image that contains the tools the README needs.';
  else if (run.exitCode === 137) r.fix = 'The process was killed (possibly out of memory). Check resource limits.';
  else r.fix = 'Run the block in a clean checkout to compare; fix the README or the declared assertions.';
  return r;
}

function notExecutableResult(doc: ParsedDocument, b: CodeBlock, selected: boolean): BlockResult {
  const r = baseResult(doc, b);
  if (b.annotation?.skip) {
    r.status = 'SKIP';
    r.reason = 'marked skip in the README';
    return r;
  }
  const what = b.kind === 'indented' ? 'indented code block' : b.language === '' ? 'block without a language' : `"${b.language}" block`;
  if (selected) {
    r.status = 'UNVERIFIED';
    r.reason = `${what} cannot be executed (supported: sh, bash, shell, js)`;
    r.fix = 'Change the code fence language to sh, bash, shell or js if this is meant to be a runnable example.';
  } else {
    r.status = 'SKIP';
    r.reason = `${what} is not executable`;
  }
  return r;
}

export async function verifyBlocks(opts: VerifyOptions): Promise<VerifyReport> {
  const { doc, project, settings } = opts;
  const imageProblem = validateImage(settings.image);
  if (imageProblem) throw new UsageError(`--image: ${imageProblem}`);

  let candidates: CodeBlock[];
  let explicit = false;
  if (opts.block !== undefined) {
    candidates = [selectBlock(doc, opts.block)];
    explicit = true;
  } else candidates = doc.blocks;

  const execution: ExecutionInfo = {
    requested: true,
    backend: 'docker',
    status: 'NOT_NEEDED',
    image: settings.image,
    network: settings.network,
  };
  const results: BlockResult[] = [];
  const runnable: CodeBlock[] = [];
  const order = new Map<string, number>();
  candidates.forEach((b, i) => order.set(b.id, i));

  for (const b of candidates) {
    if (b.annotation?.skip || b.kind !== 'fenced' || interpreterFor(b.language) === undefined) {
      results.push(notExecutableResult(doc, b, explicit));
    } else runnable.push(b);
  }

  const finish = (): VerifyReport => {
    results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { execution, results };
  };

  if (runnable.length === 0) return finish();

  const danger = isDangerousRoot(project.projectDir);
  if (danger) {
    throw new UsageError(`refusing to copy the project into a container: ${danger}. Pass --root <project directory> to choose a smaller directory.`);
  }

  const unavailable = (reason: string, fix: string): VerifyReport => {
    execution.status = 'UNAVAILABLE';
    execution.reason = reason;
    execution.fix = fix;
    for (const b of runnable) {
      const r = baseResult(doc, b);
      r.status = 'UNVERIFIED';
      r.reason = 'not executed because container execution is UNAVAILABLE (see above)';
      results.push(r);
    }
    return finish();
  };

  opts.onProgress?.('checking Docker availability');
  const status = await detectDocker(opts.runtime);
  if (!status.available) return unavailable(status.reason, status.fix);
  execution.dockerVersion = status.version;

  if (!(await imagePresent(opts.runtime, settings.image))) {
    if (!opts.pull) {
      return unavailable(
        `image ${settings.image} is not present locally`,
        `Run "docker pull ${settings.image}" or pass --pull to let readmeproof pull it (the pull is performed by the Docker daemon, not by README code). Nothing was executed.`,
      );
    }
    opts.onProgress?.(`pulling ${settings.image}`);
    const pulled = await pullImage(opts.runtime, settings.image);
    if (!pulled.ok) return unavailable(`could not pull ${settings.image}: ${pulled.detail}`, 'Check your connection and the image name.');
  }

  let ws: Workspace;
  try {
    ws = collectWorkspace(project.projectDir);
  } catch (err) {
    if (err instanceof WorkspaceError) throw new UsageError(err.message);
    throw err;
  }
  execution.status = 'AVAILABLE';
  execution.workspace = { files: ws.fileCount, bytes: ws.totalBytes, skipped: ws.skippedCount };

  for (const b of runnable) {
    const interpreter = interpreterFor(b.language);
    if (interpreter === undefined) continue;
    opts.onProgress?.(`running ${b.id}${b.annotation?.name ? ` (${b.annotation.name})` : ''}`);
    const ceiling = Math.max(1, Math.min(opts.timeoutSec, MAX_TIMEOUT_CEILING_SEC));
    const timeoutSec = Math.min(b.annotation?.timeoutSec ?? ceiling, ceiling);
    const run = await runBlockInContainer(opts.runtime, {
      settings,
      interpreter,
      code: shellBody(b, interpreter),
      workspace: ws.entries,
      creates: b.annotation?.creates ?? [],
      timeoutSec,
      maxOutputBytes: opts.maxOutputBytes,
    });
    results.push(resultFromRun(doc, b, run, settings.network));
  }
  return finish();
}

/** For shell blocks written as terminal transcripts ("$ cmd"), keep only the commands. */
export function shellBody(block: CodeBlock, interpreter: string): string {
  if (interpreter === 'node') return block.content;
  const lines = block.content.split('\n');
  const first = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (first === undefined || !first.trimStart().startsWith('$ ')) return block.content;
  const out: string[] = [];
  let continued = false;
  for (const line of lines) {
    const t = line.trimStart();
    if (continued) {
      out.push(line);
      continued = line.endsWith(String.fromCharCode(92));
    } else if (t.startsWith('$ ')) {
      const cmd = t.slice(2);
      out.push(cmd);
      continued = cmd.endsWith(String.fromCharCode(92));
    }
  }
  return out.join('\n') + '\n';
}

