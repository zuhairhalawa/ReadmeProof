import { hasAssertions } from './annotations.js';
import { describeBlock } from './blocks.js';
import { toDisplayPath, type Project } from './project.js';
import { sanitizeForTerminal } from './safe.js';
import type { BlockResult, CodeBlock, Finding, ParsedDocument, Status } from './types.js';
import type { ExecutionInfo } from './verify.js';
import { getVersion, PACKAGE_NAME } from './version.js';

export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  NOTHING_VERIFIED: 4,
  INCOMPLETE: 5,
  INTERNAL: 70,
} as const;

export type Verdict = 'PASS' | 'FAIL' | 'NOTHING_VERIFIED' | 'UNAVAILABLE' | 'INCOMPLETE' | 'LISTED';

export interface BlockInfo {
  id: string;
  name?: string;
  line: number;
  endLine: number;
  kind: 'fenced' | 'indented';
  language: string;
  executable: boolean;
  interpreter?: string;
  annotated: boolean;
  hasAssertions: boolean;
  note: string;
  annotation?: CodeBlock['annotation'];
}

export interface StatusCounts {
  PASS: number;
  FAIL: number;
  SKIP: number;
  UNVERIFIED: number;
}

export interface ExecutionSummary {
  executed: number;
  smokePassed: number;
  assertedPassed: number;
  failed: number;
  skipped: number;
  unverified: number;
}

export interface Report {
  schemaVersion: 1;
  tool: { name: string; version: string };
  command: 'check' | 'list' | 'verify';
  file: string;
  projectRoot: string;
  blocks: BlockInfo[];
  findings?: Finding[];
  execution?: ExecutionInfo;
  results?: BlockResult[];
  summary: {
    blocks: { total: number; executable: number; notExecutable: number; annotated: number; named: number };
    findings?: StatusCounts;
    execution?: ExecutionSummary;
    examplesExecuted: number;
  };
  verdict: Verdict;
  notices: string[];
  exitCode: number;
}

export function blockInfo(b: CodeBlock): BlockInfo {
  const d = describeBlock(b);
  const info: BlockInfo = {
    id: b.id,
    line: b.line,
    endLine: b.endLine,
    kind: b.kind,
    language: b.language,
    executable: d.executable && !b.annotation?.skip,
    annotated: b.annotation !== undefined,
    hasAssertions: hasAssertions(b.annotation),
    note: d.note,
  };
  if (b.annotation?.name !== undefined) info.name = b.annotation.name;
  if (d.interpreter !== undefined) info.interpreter = d.interpreter;
  if (b.annotation !== undefined) info.annotation = b.annotation;
  return info;
}

function blockSummary(blocks: BlockInfo[]): Report['summary']['blocks'] {
  const executable = blocks.filter((b) => b.executable).length;
  return {
    total: blocks.length,
    executable,
    notExecutable: blocks.length - executable,
    annotated: blocks.filter((b) => b.annotated).length,
    named: blocks.filter((b) => b.name !== undefined).length,
  };
}

export function countStatuses(items: Array<{ status: Status }>): StatusCounts {
  const c: StatusCounts = { PASS: 0, FAIL: 0, SKIP: 0, UNVERIFIED: 0 };
  for (const i of items) c[i.status]++;
  return c;
}

function base(command: Report['command'], doc: ParsedDocument, project: Project, cwd: string): Report {
  const blocks = doc.blocks.map(blockInfo);
  const root = toDisplayPath(project.projectDir, cwd);
  return {
    schemaVersion: 1,
    tool: { name: PACKAGE_NAME, version: getVersion() },
    command,
    file: doc.file,
    projectRoot: root === '' ? '.' : root,
    blocks,
    summary: { blocks: blockSummary(blocks), examplesExecuted: 0 },
    verdict: 'LISTED',
    notices: [],
    exitCode: EXIT.OK,
  };
}

export function buildListReport(doc: ParsedDocument, project: Project, cwd: string): Report {
  return base('list', doc, project, cwd);
}

export function buildCheckReport(doc: ParsedDocument, project: Project, findings: Finding[], cwd: string): Report {
  const r = base('check', doc, project, cwd);
  r.findings = findings;
  const counts = countStatuses(findings);
  r.summary.findings = counts;
  if (counts.FAIL > 0) {
    r.verdict = 'FAIL';
    r.exitCode = EXIT.FAILED;
  } else {
    /* Static checks passing is not proof that any example works. */
    r.verdict = 'NOTHING_VERIFIED';
    r.exitCode = EXIT.OK;
    r.notices.push('Static checks only: no README example was executed, so nothing about runtime behaviour has been verified.');
  }
  return r;
}

export function summarizeExecution(results: BlockResult[]): ExecutionSummary {
  const s: ExecutionSummary = { executed: 0, smokePassed: 0, assertedPassed: 0, failed: 0, skipped: 0, unverified: 0 };
  for (const r of results) {
    if (r.executed) s.executed++;
    if (r.status === 'PASS') {
      if (r.verification === 'asserted') s.assertedPassed++;
      else s.smokePassed++;
    } else if (r.status === 'FAIL') s.failed++;
    else if (r.status === 'SKIP') s.skipped++;
    else s.unverified++;
  }
  return s;
}

export function buildVerifyReport(
  doc: ParsedDocument,
  project: Project,
  execution: ExecutionInfo,
  results: BlockResult[],
  cwd: string,
): Report {
  const r = base('verify', doc, project, cwd);
  r.execution = execution;
  r.results = results;
  const s = summarizeExecution(results);
  r.summary.execution = s;
  r.summary.examplesExecuted = s.executed;
  const runnableUnverified = results.filter((x) => x.status === 'UNVERIFIED' && (x.executed || execution.status === 'AVAILABLE')).length;
  if (s.failed > 0) {
    r.verdict = 'FAIL';
    r.exitCode = EXIT.FAILED;
  } else if (execution.status === 'UNAVAILABLE') {
    r.verdict = 'UNAVAILABLE';
    r.exitCode = EXIT.UNAVAILABLE;
    r.notices.push('Docker execution is UNAVAILABLE. Nothing was executed and nothing was verified; this is not a pass.');
  } else if (s.executed === 0) {
    r.verdict = 'NOTHING_VERIFIED';
    r.exitCode = EXIT.NOTHING_VERIFIED;
  } else if (runnableUnverified > 0) {
    r.verdict = 'INCOMPLETE';
    r.exitCode = EXIT.INCOMPLETE;
  } else {
    r.verdict = 'PASS';
    r.exitCode = EXIT.OK;
  }
  if (s.executed > 0 && s.assertedPassed === 0 && s.failed === 0) {
    r.notices.push('Only smoke tests passed: no declared assertions were checked. Add <!-- readmeproof: exit=0 output="..." --> annotations to assert behaviour.');
  }
  return r;
}

/** JSON key order is part of the stable output contract (schemaVersion 1). */
export function orderedReport(report: Report): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: report.schemaVersion,
    tool: report.tool,
    command: report.command,
    file: report.file,
    projectRoot: report.projectRoot,
    verdict: report.verdict,
    exitCode: report.exitCode,
    summary: report.summary,
    notices: report.notices,
    blocks: report.blocks,
  };
  if (report.findings) out['findings'] = report.findings;
  if (report.execution) out['execution'] = report.execution;
  if (report.results) out['results'] = report.results;
  return out;
}

export function renderJson(report: Report): string {
  return JSON.stringify(orderedReport(report), null, 2) + '\n';
}

/* ---------- text rendering ---------- */

export interface RenderOptions {
  color: boolean;
  verbose: boolean;
}

function paint(opts: RenderOptions, status: string, text: string): string {
  if (!opts.color) return text;
  const code = status === 'PASS' ? '32' : status === 'FAIL' ? '31' : status === 'UNVERIFIED' ? '33' : '90';
  const esc = String.fromCharCode(27);
  return `${esc}[${code}m${text}${esc}[0m`;
}

const s = (x: string): string => sanitizeForTerminal(x);

function renderBlockList(blocks: BlockInfo[], file: string, lines: string[]): void {
  if (blocks.length === 0) {
    lines.push('  (no code blocks found)');
    return;
  }
  for (const b of blocks) {
    const range = b.endLine > b.line ? `${b.line}-${b.endLine}` : `${b.line}`;
    const lang = b.language === '' ? (b.kind === 'indented' ? 'indented' : 'plain') : b.language;
    const name = b.name ? `  name=${b.name}` : '';
    const ann = b.annotation ? `  [${describeAnnotation(b)}]` : '';
    const exec = b.executable ? 'executable' : 'not executable';
    lines.push(`  ${s(file)}:${range}  ${s(lang)}  ${exec}${name}${ann}`);
  }
}

function describeAnnotation(b: BlockInfo): string {
  const a = b.annotation;
  if (!a) return '';
  const parts: string[] = [];
  if (a.skip) parts.push('skip');
  if (a.exit !== undefined) parts.push(`exit=${a.exit}`);
  if (a.output !== undefined) parts.push('output');
  if (a.outputExact !== undefined) parts.push('output-exact');
  if (a.stderr !== undefined) parts.push('stderr');
  if (a.creates !== undefined) parts.push(`creates=${a.creates.length}`);
  if (a.timeoutSec !== undefined) parts.push(`timeout=${a.timeoutSec}`);
  return parts.length > 0 ? parts.join(' ') : 'annotated';
}

export function renderText(report: Report, opts: RenderOptions): string {
  const lines: string[] = [];
  const title = report.command === 'check' ? 'static check of' : report.command === 'list' ? 'code blocks in' : 'execution check of';
  lines.push(`readmeproof ${report.tool.version} - ${title} ${s(report.file)} (project: ${s(report.projectRoot)})`);
  lines.push('');

  if (report.command === 'list') {
    renderBlockList(report.blocks, report.file, lines);
    lines.push('');
    const b = report.summary.blocks;
    lines.push(`${b.total} code block(s): ${b.executable} executable, ${b.notExecutable} not executable, ${b.annotated} annotated, ${b.named} named.`);
    lines.push('Listing never executes anything.');
    return lines.join('\n') + '\n';
  }

  if (report.command === 'check') renderFindings(report, opts, lines);
  else renderVerification(report, opts, lines);

  const b = report.summary.blocks;
  lines.push('');
  lines.push(`Code blocks: ${b.total} (${b.executable} executable, ${b.notExecutable} not executable; ${b.annotated} annotated)`);
  if (report.summary.findings) {
    const c = report.summary.findings;
    lines.push(`Static checks: ${c.PASS} PASS, ${c.FAIL} FAIL, ${c.SKIP} SKIP, ${c.UNVERIFIED} UNVERIFIED`);
  }
  if (report.summary.execution) {
    const e = report.summary.execution;
    lines.push(
      `Executed examples: ${e.executed}  |  PASS (asserted): ${e.assertedPassed}  |  PASS (smoke only): ${e.smokePassed}  |  FAIL: ${e.failed}  |  SKIP: ${e.skipped}  |  UNVERIFIED: ${e.unverified}`,
    );
  }
  for (const n of report.notices) lines.push(s(n));
  if (report.verdict === 'NOTHING_VERIFIED') {
    lines.push(
      report.command === 'check'
        ? 'NOTHING VERIFIED: zero examples were executed. Run "readmeproof verify <README>" to run them in a Docker container.'
        : 'NOTHING VERIFIED: zero examples were executed, so this is not a pass.',
    );
  }
  const verdictText = report.verdict === 'NOTHING_VERIFIED' ? 'NOTHING VERIFIED' : report.verdict;
  const colorKey = report.verdict === 'PASS' ? 'PASS' : report.verdict === 'FAIL' ? 'FAIL' : 'UNVERIFIED';
  lines.push(`Result: ${paint(opts, colorKey, verdictText)} (exit code ${report.exitCode})`);
  return lines.join('\n') + '\n';
}

function renderFindings(report: Report, opts: RenderOptions, lines: string[]): void {
  const findings = report.findings ?? [];
  const external = findings.filter((f) => f.rule === 'external-link');
  const shown = findings.filter((f) => {
    if (f.status === 'FAIL') return true;
    if (opts.verbose) return true;
    if (f.status === 'UNVERIFIED') return f.rule !== 'external-link';
    return false;
  });
  for (const f of shown) {
    lines.push(`${s(f.file)}:${f.line}  ${paint(opts, f.status, f.status.padEnd(10))} ${f.rule}  ${s(f.message)}`);
    if (f.evidence) lines.push(`    evidence: ${s(f.evidence)}`);
    if (f.fix && f.status !== 'PASS') lines.push(`    fix: ${s(f.fix)}`);
  }
  if (shown.length === 0) lines.push('No problems found by static checks.');
  if (!opts.verbose && external.length > 0) {
    lines.push(`${external.length} external link(s) were not checked (static checks are offline). Use --verbose to list them.`);
  }
}

function excerpt(text: string | undefined, maxLines: number): string[] {
  if (!text) return [];
  const all = sanitizeForTerminal(text.trimEnd(), true).split('\n');
  const lines = all.slice(0, maxLines).map((l) => `      ${l.length > 200 ? l.slice(0, 199) + '...' : l}`);
  if (all.length > maxLines) lines.push(`      ... (${all.length - maxLines} more line(s))`);
  return lines;
}

function renderVerification(report: Report, opts: RenderOptions, lines: string[]): void {
  const ex = report.execution;
  if (ex) {
    lines.push(
      `Execution backend: docker, image ${s(ex.image)}, network ${ex.network ? 'ENABLED (--network)' : 'disabled'}, status ${ex.status}${ex.dockerVersion ? ` (docker ${s(ex.dockerVersion)})` : ''}`,
    );
    if (ex.workspace) {
      lines.push(`Workspace: ${ex.workspace.files} file(s), ${ex.workspace.bytes} byte(s) copied; ${ex.workspace.skipped} item(s) excluded (secrets, .git, symlinks, ...)`);
    }
    if (ex.status === 'UNAVAILABLE') {
      lines.push(`UNAVAILABLE: ${s(ex.reason ?? '')}`);
      if (ex.fix) lines.push(`  fix: ${s(ex.fix)}`);
    }
    lines.push('');
  }
  for (const r of report.results ?? []) {
    if (!opts.verbose && r.status === 'SKIP') continue;
    const label = r.status === 'PASS' ? `PASS (${r.verification ?? 'smoke'})` : r.status;
    const name = r.name ? ` ${s(r.name)}` : '';
    lines.push(`${s(r.file)}:${r.line}  ${paint(opts, r.status, label.padEnd(15))}${name}  ${s(r.reason)}`);
    if (r.status === 'FAIL' || r.status === 'UNVERIFIED' || opts.verbose) {
      for (const a of r.assertions.filter((x) => !x.passed)) {
        lines.push(`    ${a.kind}: expected ${s(a.expected)}; actual ${s(a.actual)}`);
      }
      if (r.status === 'FAIL') {
        if (r.stderr) {
          lines.push('    stderr:');
          lines.push(...excerpt(r.stderr, 12));
        }
        if (r.stdout) {
          lines.push('    stdout:');
          lines.push(...excerpt(r.stdout, 12));
        }
        if (r.stdoutTruncated || r.stderrTruncated) lines.push('    (output was truncated at the capture limit)');
      }
      if (r.fix) lines.push(`    fix: ${s(r.fix)}`);
    }
  }
  const hidden = (report.results ?? []).filter((r) => r.status === 'SKIP').length;
  if (!opts.verbose && hidden > 0) lines.push(`${hidden} block(s) skipped (not executable or marked skip). Use --verbose to list them.`);
}

