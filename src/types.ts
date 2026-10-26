/** Result status used everywhere. */
export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'UNVERIFIED';

/** How a PASS from execution was earned. */
export type VerificationLevel = 'smoke' | 'asserted';

export interface Annotation {
  /** Optional block name, usable with `verify --block <name>`. */
  name?: string;
  /** Expected exit status (0-255). */
  exit?: number;
  /** stdout must contain this text. */
  output?: string;
  /** stdout (trailing whitespace trimmed) must equal this text. */
  outputExact?: string;
  /** stderr must contain this text. */
  stderr?: string;
  /** Paths that must exist after the block ran and must not exist before. */
  creates?: string[];
  /** Per-block timeout in seconds (can never exceed the CLI limit). */
  timeoutSec?: number;
  /** Do not execute this block. */
  skip?: boolean;
}

export interface AnnotationIssue {
  line: number;
  message: string;
  fix: string;
  evidence: string;
}

export interface CodeBlock {
  /** Stable id: `<file>:<line>`. */
  id: string;
  /** 1-based line of the opening fence (or first line for indented blocks). */
  line: number;
  /** 1-based line of the last line of the block (closing fence when present). */
  endLine: number;
  /** 1-based line of the first content line. */
  contentLine: number;
  kind: 'fenced' | 'indented';
  /** Lower-cased first word of the info string ('' when none). */
  language: string;
  info: string;
  content: string;
  annotation: Annotation | undefined;
  /** 1-based line of the annotation comment, when present. */
  annotationLine: number | undefined;
}

export type LinkKind = 'link' | 'image' | 'html-src' | 'html-href';

export interface LinkRef {
  kind: LinkKind;
  /** Raw destination as written. */
  href: string;
  line: number;
  /** True when the line could not be located exactly and is the start of the containing block. */
  approximateLine: boolean;
}

export interface HeadingRef {
  text: string;
  slug: string;
  line: number;
}

export interface InlineCode {
  text: string;
  line: number;
}

export interface ParsedDocument {
  file: string;
  lineCount: number;
  blocks: CodeBlock[];
  links: LinkRef[];
  headings: HeadingRef[];
  inlineCode: InlineCode[];
  /** Explicit HTML anchors (id="..." / name="...") usable as link fragments. */
  htmlAnchors: string[];
  annotationIssues: AnnotationIssue[];
  /** Reasons the parse was truncated (limits hit). Empty for normal documents. */
  truncated: string[];
}

export interface Finding {
  id: string;
  rule: string;
  status: Status;
  file: string;
  line: number;
  message: string;
  evidence?: string;
  fix?: string;
}

export interface AssertionResult {
  kind: 'exit' | 'output' | 'output-exact' | 'stderr' | 'creates';
  expected: string;
  actual: string;
  passed: boolean;
}

export interface BlockResult {
  id: string;
  name?: string;
  file: string;
  line: number;
  endLine: number;
  language: string;
  status: Status;
  /** True only when the block's command actually ran inside a container. */
  executed: boolean;
  /** Present only when status is PASS. */
  verification?: VerificationLevel;
  reason: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  assertions: AssertionResult[];
  fix?: string;
}
