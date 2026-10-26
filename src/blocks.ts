import { hasAssertions } from './annotations.js';
import type { CodeBlock } from './types.js';

export type Interpreter = 'sh' | 'bash' | 'node';

/**
 * Languages readmeproof is willing to run (inside a container only).
 * Everything else is listed but never executed.
 */
const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
  sh: 'sh',
  bash: 'bash',
  shell: 'bash',
  js: 'node',
  javascript: 'node',
  node: 'node',
  mjs: 'node',
};

/** Shell-like languages whose commands are statically analysed (never executed during check). */
const SHELL_LIKE = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'shell-session', 'sh-session']);

const JS_LIKE = new Set(['js', 'javascript', 'node', 'mjs', 'cjs', 'ts', 'typescript', 'jsx', 'tsx']);

export function interpreterFor(language: string): Interpreter | undefined {
  return Object.hasOwn(INTERPRETERS, language) ? INTERPRETERS[language] : undefined;
}

export function isExecutableBlock(block: CodeBlock): boolean {
  return block.kind === 'fenced' && interpreterFor(block.language) !== undefined;
}

export function isShellLike(block: CodeBlock): boolean {
  return block.kind === 'fenced' && SHELL_LIKE.has(block.language);
}

export function isJsLike(block: CodeBlock): boolean {
  return block.kind === 'fenced' && JS_LIKE.has(block.language);
}

export function describeBlock(block: CodeBlock): {
  executable: boolean;
  interpreter: Interpreter | undefined;
  assertions: boolean;
  note: string;
} {
  const interpreter = block.kind === 'fenced' ? interpreterFor(block.language) : undefined;
  let note: string;
  if (block.annotation?.skip) note = 'marked skip';
  else if (interpreter) note = `runs with ${interpreter} in a container`;
  else if (block.kind === 'indented') note = 'indented code block (never executed)';
  else if (block.language === '') note = 'no language (never executed)';
  else note = `language "${block.language}" is not executable`;
  return { executable: interpreter !== undefined, interpreter, assertions: hasAssertions(block.annotation), note };
}

