import type { Annotation } from './types.js';

/**
 * Annotation convention
 * ---------------------
 * An HTML comment placed immediately before a fenced code block (blank lines allowed):
 *
 *   <!-- readmeproof: name=quickstart exit=0 output="Hello" creates=out.txt -->
 *
 * Comments are invisible when the README is rendered. Annotations can only *constrain
 * and assert*; they can never grant privileges (no network, image, mounts, env), because
 * README contents are untrusted input.
 */
export const ANNOTATION_PREFIX = 'readmeproof:';

export const MAX_ANNOTATION_BODY = 4096;
export const MAX_VALUE_LENGTH = 2048;
export const MAX_CREATES = 20;
export const MAX_TIMEOUT_SEC = 3600;

const BS = String.fromCharCode(92);
const NUL = String.fromCharCode(0);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_START = /^[A-Za-z]$/;
const KEY_CHAR = /^[A-Za-z0-9-]$/;

export interface AnnotationParse {
  annotation: Annotation;
  errors: string[];
}

/** Returns the comment body when `html` is a (possibly invalid) readmeproof comment. */
export function extractAnnotationBody(html: string): string | undefined {
  const t = html.trim();
  if (!t.startsWith('<!--') || !t.endsWith('-->') || t.length < 7) return undefined;
  const inner = t.slice(4, -3).trim();
  if (!inner.toLowerCase().startsWith(ANNOTATION_PREFIX)) return undefined;
  return inner.slice(ANNOTATION_PREFIX.length);
}

/** True for any HTML comment that merely starts like an annotation (typos included). */
export function looksLikeAnnotation(html: string): boolean {
  const t = html.trim();
  if (!t.startsWith('<!--')) return false;
  const inner = t.slice(4).trimStart().toLowerCase();
  return inner.startsWith('readmeproof');
}

interface Pair {
  key: string;
  value: string | undefined;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === String.fromCharCode(9) || c === '\n' || c === '\r';
}

function tokenize(body: string, errors: string[]): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i] as string;
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (!KEY_START.test(c)) {
      errors.push(`unexpected character ${JSON.stringify(c)} at position ${i + 1}`);
      return pairs;
    }
    let key = '';
    while (i < n && KEY_CHAR.test(body[i] as string)) key += body[i++];
    if (body[i] !== '=') {
      pairs.push({ key, value: undefined });
      continue;
    }
    i++;
    let value = '';
    if (body[i] === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const ch = body[i] as string;
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        if (ch === BS) {
          const next = body[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += String.fromCharCode(9);
          else if (next === '"' || next === BS) value += next;
          else {
            errors.push(
              `unsupported escape in value of "${key}" (supported: backslash-n, backslash-t, backslash-quote, double backslash)`,
            );
            return pairs;
          }
          i += 2;
          continue;
        }
        value += ch;
        i++;
        if (value.length > MAX_VALUE_LENGTH) {
          errors.push(`value of "${key}" is longer than ${MAX_VALUE_LENGTH} characters`);
          return pairs;
        }
      }
      if (!closed) {
        errors.push(`unterminated quoted value for "${key}"`);
        return pairs;
      }
    } else {
      while (i < n) {
        const ch = body[i] as string;
        if (isSpace(ch)) break;
        if (ch === '"') {
          errors.push(`unexpected quote inside unquoted value for "${key}"`);
          return pairs;
        }
        value += ch;
        i++;
      }
      if (value.length > MAX_VALUE_LENGTH) {
        errors.push(`value of "${key}" is longer than ${MAX_VALUE_LENGTH} characters`);
        return pairs;
      }
    }
    pairs.push({ key, value });
  }
  return pairs;
}

/** Validate a relative path declared in `creates=`. Returns an error message or undefined. */
export function validateCreatesPath(p: string): string | undefined {
  if (p.length === 0) return 'empty path';
  if (p.includes(NUL) || p.includes('\n') || p.includes('\r')) return 'path contains control characters';
  if (p.startsWith('/') || p.startsWith(BS) || /^[A-Za-z]:/.test(p)) {
    return `"${p}" must be relative to the project root`;
  }
  const parts = p.split(BS).join('/').split('/');
  if (parts.some((s) => s === '..')) return `"${p}" must not contain ".."`;
  if (p.includes("'") || p.includes('"')) return `"${p}" must not contain quotes`;
  return undefined;
}

export function parseAnnotationBody(body: string): AnnotationParse {
  const errors: string[] = [];
  const annotation: Annotation = {};
  if (body.length > MAX_ANNOTATION_BODY) {
    return { annotation, errors: [`annotation is longer than ${MAX_ANNOTATION_BODY} characters`] };
  }
  const pairs = tokenize(body, errors);
  const seen = new Set<string>();
  for (const { key, value } of pairs) {
    if (seen.has(key)) {
      errors.push(`duplicate key "${key}"`);
      continue;
    }
    seen.add(key);
    switch (key) {
      case 'skip':
        if (value !== undefined && value !== 'true') errors.push('"skip" is a flag; write it without a value');
        else annotation.skip = true;
        break;
      case 'name':
        if (value === undefined || !NAME_PATTERN.test(value)) {
          errors.push('"name" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
        } else annotation.name = value;
        break;
      case 'exit': {
        const n = value !== undefined && /^[0-9]{1,3}$/.test(value) ? Number(value) : NaN;
        if (!(n >= 0 && n <= 255)) errors.push('"exit" must be an integer from 0 to 255');
        else annotation.exit = n;
        break;
      }
      case 'timeout': {
        const n = value !== undefined && /^[0-9]{1,4}$/.test(value) ? Number(value) : NaN;
        if (!(n >= 1 && n <= MAX_TIMEOUT_SEC)) errors.push(`"timeout" must be whole seconds from 1 to ${MAX_TIMEOUT_SEC}`);
        else annotation.timeoutSec = n;
        break;
      }
      case 'output':
        if (value === undefined || value === '') errors.push('"output" needs a non-empty value');
        else annotation.output = value;
        break;
      case 'output-exact':
        if (value === undefined) errors.push('"output-exact" needs a value');
        else annotation.outputExact = value;
        break;
      case 'stderr':
        if (value === undefined || value === '') errors.push('"stderr" needs a non-empty value');
        else annotation.stderr = value;
        break;
      case 'creates': {
        if (value === undefined || value === '') {
          errors.push('"creates" needs one or more comma-separated paths');
          break;
        }
        const paths = value.split(',').map((s) => s.trim());
        if (paths.length > MAX_CREATES) {
          errors.push(`"creates" lists more than ${MAX_CREATES} paths`);
          break;
        }
        let ok = true;
        for (const p of paths) {
          const err = validateCreatesPath(p);
          if (err) {
            errors.push(`"creates": ${err}`);
            ok = false;
          }
        }
        if (ok) annotation.creates = paths;
        break;
      }
      default:
        errors.push(`unknown key "${key}" (known: name, exit, output, output-exact, stderr, creates, timeout, skip)`);
    }
  }
  return { annotation, errors };
}

/** True when the annotation declares at least one assertion about behaviour. */
export function hasAssertions(a: Annotation | undefined): boolean {
  if (!a) return false;
  return (
    a.exit !== undefined ||
    a.output !== undefined ||
    a.outputExact !== undefined ||
    a.stderr !== undefined ||
    (a.creates !== undefined && a.creates.length > 0)
  );
}
