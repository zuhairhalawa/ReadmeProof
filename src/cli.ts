import { parseArgs } from 'node:util';
import { runStaticChecks } from './checks.js';
import { createDockerRuntime, DEFAULT_IMAGE, DEFAULT_SETTINGS, type ContainerSettings, type DockerRuntime } from './docker.js';
import { parseMarkdown } from './markdown.js';
import { discoverProject, MAX_README_BYTES, resolveReadme, toDisplayPath, UsageError } from './project.js';
import {
  buildCheckReport,
  buildListReport,
  buildVerifyReport,
  EXIT,
  renderJson,
  renderText,
  type Report,
} from './report.js';
import { FileTooLargeError, readBoundedFile, sanitizeForTerminal } from './safe.js';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_CEILING_SEC, verifyBlocks } from './verify.js';
import { getVersion } from './version.js';

export const HELP = `readmeproof - check whether README instructions actually work

USAGE
  readmeproof check  [README.md | DIR] [options]     static checks (offline, never executes anything)
  readmeproof list   [README.md | DIR] [options]     list code blocks and annotations
  readmeproof verify [README.md | DIR] [options]     run examples inside disposable Docker containers

COMMANDS
  check    Parse the README and check relative links, assets, anchors, referenced files,
           package.json scripts and package names. Works offline, without Docker. README
           commands are never executed. External links are reported UNVERIFIED, not "broken".
  list     Show every fenced/indented code block with file:line, language, whether it is
           executable and which annotations it carries.
  verify   Execute supported blocks (sh, bash, shell, js) in a throwaway container and compare
           the real behaviour with declared assertions. This is the only command that runs
           README code, and only inside Docker. Without Docker the result is UNAVAILABLE.

GLOBAL OPTIONS
  --json            Print a stable JSON document instead of text
  --root <dir>      Project root (default: nearest directory with .git or package.json)
  --verbose         Also show PASS/SKIP results and external links
  --no-color        Disable colored output (also honours NO_COLOR)
  -V, --version     Print the version
  -h, --help        Print this help

VERIFY OPTIONS
  --block <name|line>   Verify only one block (annotation name=... or opening fence line)
  --image <image>       Container image (default: ${DEFAULT_IMAGE}); must already exist locally
  --pull                Let Docker pull the image if it is missing (network use by the daemon)
  --network             Give containers network access. OFF by default; opt-in only, see SECURITY.md
  --timeout <seconds>   Per-block time limit ceiling (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_CEILING_SEC})
  --memory <MB>         Container memory limit (default ${DEFAULT_SETTINGS.memoryMb})
  --cpus <n>            Container CPU limit (default ${DEFAULT_SETTINGS.cpus})
  --max-output <bytes>  Captured stdout/stderr per stream (default ${DEFAULT_MAX_OUTPUT_BYTES})

ANNOTATIONS (an HTML comment directly above a fenced code block)
  <!-- readmeproof: name=quickstart exit=0 output="Hello" creates=out.txt -->
  Keys: name, exit, output, output-exact, stderr, creates, timeout, skip
  Annotations can only assert or constrain; they cannot enable the network, change the
  image or relax any isolation setting.

RESULTS
  PASS  FAIL  SKIP  UNVERIFIED. Execution PASS is "asserted" (declared assertions held) or
  "smoke" (ran with exit 0, nothing asserted). If no example ran the verdict is NOTHING VERIFIED.

EXIT CODES
  0  OK                      3  Docker unavailable (verify)
  1  problems found          4  nothing verified (verify ran zero examples)
  2  usage / input error     5  incomplete (some examples could not be verified)
  70 internal error

EXAMPLES
  readmeproof check README.md
  readmeproof check . --json
  readmeproof list README.md
  readmeproof verify README.md --block quickstart
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  runtime?: DockerRuntime;
}

function parseNumber(name: string, raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number between ${min} and ${max}`);
  return n;
}

function loadDocument(target: string, io: CliIo, rootOverride: string | undefined) {
  const readmeAbs = resolveReadme(target, io.cwd);
  const opts: { cwd: string; rootOverride?: string } = { cwd: io.cwd };
  if (rootOverride !== undefined) opts.rootOverride = rootOverride;
  const project = discoverProject(readmeAbs, opts);
  let source: string;
  try {
    source = readBoundedFile(readmeAbs, MAX_README_BYTES);
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      throw new UsageError(`${toDisplayPath(readmeAbs, io.cwd)} is too large to analyse safely (${err.size} bytes; limit ${err.limit})`);
    }
    throw new UsageError(`cannot read ${toDisplayPath(readmeAbs, io.cwd)}: ${(err as Error).message}`);
  }
  const doc = parseMarkdown(source, project.readmeDisplay);
  return { project, doc };
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`readmeproof: ${sanitizeForTerminal(err.message)}\nTry "readmeproof --help".\n`);
      return EXIT.USAGE;
    }
    const detail = io.env['READMEPROOF_DEBUG'] === '1' && err instanceof Error ? `\n${err.stack ?? ''}` : '';
    io.stderr(`readmeproof: internal error: ${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}${detail}\n`);
    return EXIT.INTERNAL;
  }
}

async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
        json: { type: 'boolean' },
        root: { type: 'string' },
        verbose: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        block: { type: 'string' },
        image: { type: 'string' },
        pull: { type: 'boolean' },
        network: { type: 'boolean' },
        timeout: { type: 'string' },
        memory: { type: 'string' },
        cpus: { type: 'string' },
        'max-output': { type: 'string' },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.stdout(`${getVersion()}\n`);
    return EXIT.OK;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === 'help') {
    io.stdout(HELP);
    return command === undefined && !values.help ? EXIT.USAGE : EXIT.OK;
  }
  if (command !== 'check' && command !== 'list' && command !== 'verify') {
    throw new UsageError(`unknown command "${sanitizeForTerminal(command)}" (expected check, list or verify)`);
  }
  if (positionals.length > 2) throw new UsageError('expected at most one README path or directory');
  const target = positionals[1] ?? '.';

  if (command !== 'verify') {
    for (const flag of ['block', 'image', 'pull', 'network', 'timeout', 'memory', 'cpus', 'max-output'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} is only valid with "verify"`);
    }
  }

  const { project, doc } = loadDocument(target, io, values.root);
  let report: Report;

  if (command === 'list') {
    report = buildListReport(doc, project, io.cwd);
  } else if (command === 'check') {
    report = buildCheckReport(doc, project, runStaticChecks(doc, project), io.cwd);
  } else {
    const settings: ContainerSettings = {
      ...DEFAULT_SETTINGS,
      image: values.image ?? DEFAULT_IMAGE,
      network: values.network === true,
      memoryMb: parseNumber('memory', values.memory, 128, 16384, DEFAULT_SETTINGS.memoryMb),
      cpus: parseNumber('cpus', values.cpus, 0.1, 8, DEFAULT_SETTINGS.cpus),
    };
    const timeoutSec = parseNumber('timeout', values.timeout, 1, MAX_TIMEOUT_CEILING_SEC, DEFAULT_TIMEOUT_SEC);
    const maxOutputBytes = parseNumber('max-output', values['max-output'], 1024, 4 * 1024 * 1024, DEFAULT_MAX_OUTPUT_BYTES);
    const runtime = io.runtime ?? createDockerRuntime(io.env['READMEPROOF_DOCKER'] || 'docker', io.env);
    const verifyOptions: Parameters<typeof verifyBlocks>[0] = {
      doc,
      project,
      runtime,
      settings,
      timeoutSec,
      maxOutputBytes: Math.floor(maxOutputBytes),
      pull: values.pull === true,
    };
    if (values.block !== undefined) verifyOptions.block = values.block;
    if (values.verbose && !values.json) verifyOptions.onProgress = (m) => io.stderr(`readmeproof: ${m}\n`);
    const vr = await verifyBlocks(verifyOptions);
    report = buildVerifyReport(doc, project, vr.execution, vr.results, io.cwd);
  }

  if (values.json) {
    io.stdout(renderJson(report));
  } else {
    const color = io.stdoutIsTTY && values['no-color'] !== true && !io.env['NO_COLOR'];
    io.stdout(renderText(report, { color, verbose: values.verbose === true }));
  }
  return report.exitCode;
}

