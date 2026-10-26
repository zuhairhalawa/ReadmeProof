/**
 * A deliberately small POSIX-shell *tokenizer*. It never evaluates anything: no variable
 * expansion, no command substitution, no globbing. It only splits README shell snippets into
 * commands and words so static checks can look at what the snippet refers to.
 */

const BS = String.fromCharCode(92);

export interface Word {
  text: string;
  /** True when the word contains expansions (variables, command substitution, globs, ~). */
  dynamic: boolean;
}

export interface ShellCommand {
  words: Word[];
  /** 1-based line in the README where the command starts. */
  line: number;
  raw: string;
  /** True when a cd/pushd earlier in the same block makes relative paths unreliable. */
  cwdChanged: boolean;
}

const MAX_LINES = 5000;
const MAX_WORDS_PER_COMMAND = 200;

interface LogicalLine {
  text: string;
  index: number;
}

function isPrompt(line: string): boolean {
  return line.startsWith('$ ');
}

/** Split into logical lines: prompt handling, comments are kept for the tokenizer, continuations joined. */
function logicalLines(content: string): LogicalLine[] {
  const lines = content.split('\n').slice(0, MAX_LINES);
  const firstReal = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const transcript = firstReal !== undefined && isPrompt(firstReal.trimStart());
  const out: LogicalLine[] = [];
  let current: LogicalLine | undefined;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    if (current === undefined) {
      if (transcript) {
        const t = line.trimStart();
        if (!isPrompt(t)) continue;
        line = t.slice(2);
      }
      current = { text: '', index: i };
    }
    if (line.endsWith(BS)) {
      current.text += line.slice(0, -1) + ' ';
      continue;
    }
    current.text += line;
    out.push(current);
    current = undefined;
  }
  if (current !== undefined) out.push(current);
  return out;
}

function heredocDelimiter(text: string): string | undefined {
  const idx = text.indexOf('<<');
  if (idx < 0 || text[idx + 2] === '<') return undefined;
  let rest = text.slice(idx + 2).trimStart();
  if (rest.startsWith('-')) rest = rest.slice(1).trimStart();
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : '';
  if (quote) rest = rest.slice(1);
  let delim = '';
  for (const ch of rest) {
    if (ch === quote || ch === ' ' || ch === String.fromCharCode(9) || ch === ';' || ch === '|' || ch === '&' || ch === ')') break;
    delim += ch;
  }
  return delim === '' ? undefined : delim;
}

interface RawCommand {
  words: Word[];
}

function tokenizeLine(text: string): RawCommand[] {
  const commands: RawCommand[] = [];
  let words: Word[] = [];
  let cur = '';
  let dynamic = false;
  let inWord = false;
  const endWord = (): void => {
    if (inWord) {
      if (words.length < MAX_WORDS_PER_COMMAND) words.push({ text: cur, dynamic });
    }
    cur = '';
    dynamic = false;
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push({ words });
    words = [];
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === "'") {
      inWord = true;
      i++;
      while (i < n && text[i] !== "'") cur += text[i++];
      i++;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && text[i] !== '"') {
        const d = text[i] as string;
        if (d === BS && i + 1 < n) {
          cur += text[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' || d === '`') dynamic = true;
        cur += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === BS && i + 1 < n) {
      inWord = true;
      cur += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      /* Command substitution is kept inside the word (and marked dynamic); it is never evaluated. */
      inWord = true;
      dynamic = true;
      let depth = 0;
      while (i < n) {
        const d = text[i] as string;
        cur += d;
        i++;
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
      }
      continue;
    }
    if (c === '`') {
      inWord = true;
      dynamic = true;
      cur += c;
      i++;
      while (i < n && text[i] !== '`') cur += text[i++];
      if (i < n) cur += text[i++];
      continue;
    }
    if (c === '#' && !inWord) break;
    if (c === ' ' || c === String.fromCharCode(9)) {
      endWord();
      i++;
      continue;
    }
    if (c === ';' || c === '(' || c === ')' || c === '{' && !inWord && (text[i + 1] === ' ') || c === '}' && !inWord) {
      endCommand();
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      endCommand();
      i++;
      if (text[i] === c) i++;
      continue;
    }
    if (c === '>' || c === '<') {
      /* Redirections: keep as a word marker so callers can see output is redirected. */
      endWord();
      let op = c;
      i++;
      while (i < n && (text[i] === '>' || text[i] === '<' || text[i] === '&')) op += text[i++];
      words.push({ text: op, dynamic: false });
      continue;
    }
    inWord = true;
    if (c === '$' || c === '`' || c === '*' || c === '?' || c === '[' || (c === '~' && cur === '')) dynamic = true;
    cur += c;
    i++;
  }
  endCommand();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'time', 'exec', 'command', 'nohup', 'env']);

/** Extract commands from a block of shell-like text. `firstContentLine` is the 1-based README line of its first line. */
export function extractShellCommands(content: string, firstContentLine: number): ShellCommand[] {
  const out: ShellCommand[] = [];
  let cwdChanged = false;
  const lines = logicalLines(content);
  const raw = content.split('\n');
  let skipUntil: string | undefined;
  let skipFrom = -1;
  for (const logical of lines) {
    if (skipUntil !== undefined) {
      if (logical.index > skipFrom && logical.text.trim() === skipUntil) skipUntil = undefined;
      continue;
    }
    const delim = heredocDelimiter(logical.text);
    for (const cmd of tokenizeLine(logical.text)) {
      let words = cmd.words;
      while (words.length > 0) {
        const w = (words[0] as Word).text;
        if (ASSIGNMENT.test(w) || WRAPPERS.has(w)) words = words.slice(1);
        else break;
      }
      if (words.length === 0) continue;
      const first = (words[0] as Word).text;
      const command: ShellCommand = {
        words,
        line: firstContentLine + logical.index,
        raw: (raw[logical.index] ?? '').trim(),
        cwdChanged,
      };
      out.push(command);
      if (first === 'cd' || first === 'pushd') cwdChanged = true;
    }
    if (delim !== undefined) {
      skipUntil = delim;
      skipFrom = logical.index;
    }
  }
  return out;
}

