import { closeSync, fstatSync, openSync, readSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';

const BACKSLASH = String.fromCharCode(92);

/**
 * Replace control characters (including ANSI escape introducers) so untrusted text
 * can be printed to a terminal without being interpreted. Newlines are kept only
 * when `keepNewlines` is set.
 */
export function sanitizeForTerminal(input: string, keepNewlines = false): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' && keepNewlines) {
      out += ch;
    } else if (ch === '\t') {
      out += '  ';
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += BACKSLASH + 'x' + code.toString(16).padStart(2, '0');
    } else if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f
    ) {
      /* Bidirectional override characters can visually reorder text ("trojan source"). */
      out += BACKSLASH + 'u' + code.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

/** Shorten text for evidence strings. */
export function clip(input: string, max = 160): string {
  const oneLine = input.replace(/[\s]+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 3)) + '...';
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly file: string,
    public readonly size: number,
    public readonly limit: number,
  ) {
    super(`${file} is ${size} bytes, which exceeds the ${limit} byte limit`);
    this.name = 'FileTooLargeError';
  }
}

/**
 * Read a regular file with a hard size cap. The size is checked on the open file
 * descriptor and again while reading, so a file growing mid-read cannot exceed the cap.
 */
export function readBoundedFile(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.size > maxBytes) throw new FileTooLargeError(file, st.size, maxBytes);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new FileTooLargeError(file, total, maxBytes);
    }
    return buf.subarray(0, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** True when `child` is `parent` or located inside it (purely lexical). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export type Containment =
  | { ok: true; resolved: string; exists: boolean; kind: 'file' | 'dir' | 'other' | 'missing' }
  | { ok: false; reason: 'traversal' | 'symlink-escape' | 'invalid'; detail: string };

/**
 * Resolve `target` (absolute, already joined) and make sure it stays inside `root`,
 * both lexically and after resolving symlinks. Never touches anything outside `root`.
 */
export function resolveContained(root: string, target: string): Containment {
  if (target.includes(String.fromCharCode(0))) {
    return { ok: false, reason: 'invalid', detail: 'path contains a NUL byte' };
  }
  const lexical = path.resolve(target);
  if (!isInside(root, lexical)) {
    return { ok: false, reason: 'traversal', detail: 'path resolves outside the project root' };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: 'invalid', detail: 'project root is not accessible' };
  }
  let lst;
  try {
    lst = lstatSync(lexical);
  } catch {
    /* Missing: still verify the nearest existing ancestor does not escape through a symlink. */
    let ancestor = path.dirname(lexical);
    for (let i = 0; i < 64; i++) {
      try {
        const realAncestor = realpathSync(ancestor);
        if (!isInside(realRoot, realAncestor)) {
          return {
            ok: false,
            reason: 'symlink-escape',
            detail: 'a parent directory is a symlink leaving the project root',
          };
        }
        break;
      } catch {
        const next = path.dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
    }
    return { ok: true, resolved: lexical, exists: false, kind: 'missing' };
  }
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    /* Dangling symlink. */
    return { ok: true, resolved: lexical, exists: false, kind: 'missing' };
  }
  if (!isInside(realRoot, real)) {
    return {
      ok: false,
      reason: 'symlink-escape',
      detail: 'resolves through a symlink to a location outside the project root',
    };
  }
  const st = lst.isSymbolicLink() ? safeStat(real) : lst;
  const kind = st?.isDirectory() ? 'dir' : st?.isFile() ? 'file' : 'other';
  return { ok: true, resolved: real, exists: true, kind };
}

function safeStat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}
