import { readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { hasAssertions } from './annotations.js';
import { interpreterFor, isJsLike, isShellLike } from './blocks.js';
import { parseMarkdown } from './markdown.js';
import { MAX_LINKED_MARKDOWN_BYTES, type Project } from './project.js';
import { clip, readBoundedFile, resolveContained } from './safe.js';
import { extractShellCommands, type ShellCommand, type Word } from './shell.js';
import type { CodeBlock, Finding, LinkRef, ParsedDocument, Status } from './types.js';

/**
 * Static checks. Pure analysis: reads files (bounded, contained) but never executes
 * anything from the README or the repository, and never touches the network.
 */

const BS = String.fromCharCode(92);
const SLASH2 = '/' + '/';

type Extra = { evidence?: string; fix?: string };

class Collector {
  readonly items: Array<Omit<Finding, 'id'>> = [];
  constructor(private readonly file: string) {}
  add(rule: string, status: Status, line: number, message: string, extra: Extra = {}): void {
    const f: Omit<Finding, 'id'> = { rule, status, file: this.file, line, message };
    if (extra.evidence !== undefined) f.evidence = extra.evidence;
    if (extra.fix !== undefined) f.fix = extra.fix;
    this.items.push(f);
  }
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 8) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/* ---------- link classification ---------- */

export type LinkClass =
  | { type: 'anchor'; fragment: string }
  | { type: 'external'; url: string }
  | { type: 'skipped'; scheme: string }
  | { type: 'unsupported'; scheme: string }
  | { type: 'absolute-local'; why: string }
  | { type: 'local'; pathPart: string; fragment: string };

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const NON_FILE_SCHEMES = new Set(['mailto', 'tel', 'sms', 'data', 'irc', 'ircs', 'magnet', 'geo', 'xmpp', 'sip', 'news', 'ftp', 'ftps', 'ssh', 'git']);

export function classifyHref(rawHref: string): LinkClass {
  const href = rawHref.trim();
  if (href.startsWith('#')) return { type: 'anchor', fragment: href.slice(1) };
  if (href.startsWith(SLASH2)) return { type: 'external', url: 'https:' + href };
  const m = SCHEME.exec(href);
  if (m) {
    const scheme = (m[1] as string).toLowerCase();
    if (scheme.length === 1) return { type: 'absolute-local', why: 'Windows drive path' };
    if (scheme === 'http' || scheme === 'https') return { type: 'external', url: href };
    if (scheme === 'file') return { type: 'absolute-local', why: 'file: URL' };
    if (NON_FILE_SCHEMES.has(scheme)) return { type: 'skipped', scheme };
    return { type: 'unsupported', scheme };
  }
  let pathPart = href;
  let fragment = '';
  const hash = pathPart.indexOf('#');
  if (hash >= 0) {
    fragment = pathPart.slice(hash + 1);
    pathPart = pathPart.slice(0, hash);
  }
  const q = pathPart.indexOf('?');
  if (q >= 0) pathPart = pathPart.slice(0, q);
  return { type: 'local', pathPart, fragment };
}

/* ---------- filesystem helpers (bounded, cached) ---------- */

class FsCache {
  private dirs = new Map<string, string[] | null>();
  private anchors = new Map<string, Set<string> | { error: string }>();

  list(dir: string): string[] | null {
    if (this.dirs.has(dir)) return this.dirs.get(dir) as string[] | null;
    let v: string[] | null;
    try {
      v = readdirSync(dir);
    } catch {
      v = null;
    }
    this.dirs.set(dir, v);
    return v;
  }

  /** On case-insensitive filesystems a wrongly-cased link "exists" locally but breaks on Linux/GitHub. */
  caseMismatch(boundary: string, lexical: string): string | undefined {
    const rel = path.relative(boundary, lexical);
    if (rel === '' || rel.startsWith('..')) return undefined;
    let dir = boundary;
    const actual: string[] = [];
    let mismatch = false;
    for (const seg of rel.split(path.sep)) {
      const entries = this.list(dir);
      if (entries === null) return undefined;
      if (entries.includes(seg)) {
        actual.push(seg);
        dir = path.join(dir, seg);
        continue;
      }
      const alt = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
      if (alt === undefined) return undefined;
      mismatch = true;
      actual.push(alt);
      dir = path.join(dir, alt);
    }
    return mismatch ? path.join(boundary, ...actual) : undefined;
  }

  suggest(lexical: string): string | undefined {
    const dir = path.dirname(lexical);
    const base = path.basename(lexical);
    const entries = this.list(dir);
    if (!entries) return undefined;
    let best: string | undefined;
    let bestScore = 3;
    for (const e of entries) {
      const d = levenshtein(e.toLowerCase(), base.toLowerCase());
      if (d < bestScore) {
        bestScore = d;
        best = e;
      }
    }
    return best;
  }

  markdownAnchors(file: string): Set<string> | { error: string } {
    const cached = this.anchors.get(file);
    if (cached) return cached;
    let result: Set<string> | { error: string };
    try {
      const doc = parseMarkdown(readBoundedFile(file, MAX_LINKED_MARKDOWN_BYTES), file);
      result = anchorSet(doc);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.anchors.set(file, result);
    return result;
  }
}

function anchorSet(doc: ParsedDocument): Set<string> {
  const s = new Set<string>();
  for (const h of doc.headings) s.add(h.slug.toLowerCase());
  for (const a of doc.htmlAnchors) s.add(a.toLowerCase());
  return s;
}

/** Path of `abs` relative to `base`, with forward slashes, for messages. */
function showRel(base: string, abs: string): string {
  return path.relative(base, abs).split(path.sep).join('/');
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function isMarkdownFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === '.md' || ext === '.markdown';
}

/* ---------- main entry ---------- */

export function runStaticChecks(doc: ParsedDocument, project: Project): Finding[] {
  const out = new Collector(doc.file);
  const cache = new FsCache();

  for (const reason of doc.truncated) {
    out.add('parse-limit', 'UNVERIFIED', 1, `analysis was limited: ${reason}`, {
      fix: 'Split the README into smaller documents so every part can be checked.',
    });
  }

  checkAnnotations(doc, out);
  checkLinks(doc, project, cache, out);
  checkInlineFileRefs(doc, project, cache, out);
  checkCommands(doc, project, cache, out);
  checkImports(doc, project, out);

  const sorted = out.items
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.line - b.f.line || a.f.rule.localeCompare(b.f.rule) || a.i - b.i)
    .map(({ f }) => f);
  const width = Math.max(4, String(sorted.length).length);
  return sorted.map((f, idx) => ({ id: `F${String(idx + 1).padStart(width, '0')}`, ...f }));
}

/* ---------- annotations ---------- */

function checkAnnotations(doc: ParsedDocument, out: Collector): void {
  for (const issue of doc.annotationIssues) {
    out.add('annotation', 'FAIL', issue.line, issue.message, { evidence: issue.evidence, fix: issue.fix });
  }
  const names = new Map<string, CodeBlock>();
  for (const b of doc.blocks) {
    const a = b.annotation;
    if (!a) continue;
    if (a.name !== undefined) {
      const first = names.get(a.name);
      if (first) {
        out.add('annotation', 'FAIL', b.annotationLine ?? b.line, `block name "${a.name}" is already used at line ${first.annotationLine ?? first.line}`, {
          fix: 'Give every named block a unique name.',
        });
      } else names.set(a.name, b);
    }
    if (interpreterFor(b.language) === undefined && !a.skip && (hasAssertions(a) || a.name !== undefined)) {
      out.add(
        'annotation',
        'FAIL',
        b.annotationLine ?? b.line,
        `annotation is attached to a "${b.language || 'plain'}" block, which readmeproof cannot execute`,
        { fix: 'Annotate a sh, bash, shell or js block, or remove the annotation.' },
      );
    }
  }
}

/* ---------- links ---------- */

function checkLinks(doc: ParsedDocument, project: Project, cache: FsCache, out: Collector): void {
  const selfAnchors = anchorSet(doc);
  for (const link of doc.links) {
    const cls = classifyHref(link.href);
    const evidence = `${link.kind === 'image' || link.kind === 'html-src' ? 'asset' : 'link'} target: ${clip(link.href)}`;
    const lineNote = link.approximateLine ? ' (line is approximate: reference-style link)' : '';
    switch (cls.type) {
      case 'external':
        out.add('external-link', 'UNVERIFIED', link.line, `external link not checked (offline): ${clip(cls.url, 120)}`, {
          evidence,
          fix: 'readmeproof never contacts the network during static checks; use a link checker to validate external URLs.',
        });
        break;
      case 'skipped':
        out.add('link', 'SKIP', link.line, `${cls.scheme}: link is not a file reference`, { evidence });
        break;
      case 'unsupported':
        out.add('link', 'UNVERIFIED', link.line, `link uses the "${cls.scheme}:" scheme, which cannot be checked`, { evidence });
        break;
      case 'absolute-local':
        out.add('link', 'FAIL', link.line, `link is an absolute local path (${cls.why}); it will not work for other readers`, {
          evidence,
          fix: 'Use a path relative to the README, for example ./docs/guide.md.',
        });
        break;
      case 'anchor': {
        const frag = anchorKey(cls.fragment);
        if (frag === '' || selfAnchors.has(frag) || frag === 'readme' || frag === 'top') {
          out.add('anchor', 'PASS', link.line, `anchor #${clip(cls.fragment, 60)} exists`, { evidence });
        } else {
          out.add('anchor', 'FAIL', link.line, `anchor #${clip(cls.fragment, 60)} does not match any heading in this file${lineNote}`, {
            evidence,
            fix: closestAnchorFix(frag, selfAnchors),
          });
        }
        break;
      }
      case 'local':
        checkLocalLink(link, cls.pathPart, cls.fragment, project, cache, selfAnchors, out, evidence, lineNote);
        break;
    }
  }
}

function anchorKey(fragment: string): string {
  const decoded = safeDecode(fragment) ?? fragment;
  const lower = decoded.toLowerCase();
  return lower.startsWith('user-content-') ? lower.slice('user-content-'.length) : lower;
}

function closestAnchorFix(frag: string, anchors: Set<string>): string {
  let best: string | undefined;
  let bestScore = 4;
  for (const a of anchors) {
    const d = levenshtein(a, frag);
    if (d < bestScore) {
      bestScore = d;
      best = a;
    }
  }
  return best ? `Did you mean #${best}? Anchors follow the GitHub heading slug rules.` : 'Fix the anchor or add the heading it points to.';
}

function checkLocalLink(
  link: LinkRef,
  pathPart: string,
  fragment: string,
  project: Project,
  cache: FsCache,
  selfAnchors: Set<string>,
  out: Collector,
  evidence: string,
  lineNote: string,
): void {
  if (pathPart === '') {
    out.add('link', 'SKIP', link.line, 'link has no path component', { evidence });
    return;
  }
  const decoded = safeDecode(pathPart);
  if (decoded === undefined) {
    out.add('link', 'FAIL', link.line, 'link contains invalid percent-encoding', {
      evidence,
      fix: 'Encode special characters correctly, for example %20 for a space.',
    });
    return;
  }
  const normalized = decoded.split(BS).join('/');
  const joined = normalized.startsWith('/')
    ? path.join(project.boundary, normalized)
    : path.resolve(project.readmeDir, normalized);
  const res = resolveContained(project.boundary, joined);
  if (!res.ok) {
    const rule = res.reason === 'symlink-escape' ? 'symlink-escape' : 'path-traversal';
    out.add(rule, 'FAIL', link.line, `link ${res.detail}${lineNote}`, {
      evidence,
      fix: 'Links must stay inside the repository. Move the file into the project or remove the link.',
    });
    return;
  }
  if (!res.exists) {
    const hint = cache.suggest(path.resolve(joined));
    out.add('broken-link', 'FAIL', link.line, `${link.kind === 'image' || link.kind === 'html-src' ? 'asset' : 'file'} not found: ${clip(normalized, 120)}${lineNote}`, {
      evidence,
      fix: hint ? `Did you mean ${hint}? Otherwise create the file or fix the path.` : 'Create the file or fix the path.',
    });
    return;
  }
  const mismatchAbs = cache.caseMismatch(project.boundary, path.resolve(joined));
  if (mismatchAbs !== undefined) {
    const mismatch = showRel(project.readmeDir, mismatchAbs);
    out.add('case-mismatch', 'FAIL', link.line, `link path differs in letter case from the real file (${mismatch}); it works on Windows/macOS but breaks on Linux and GitHub`, {
      evidence,
      fix: `Change the link to use the exact case: ${mismatch}`,
    });
    return;
  }
  if (fragment !== '' && res.kind === 'file' && isMarkdownFile(res.resolved)) {
    const key = anchorKey(fragment);
    const same = res.resolved === project.readmeAbs;
    const set = same ? selfAnchors : cache.markdownAnchors(res.resolved);
    if ('error' in set) {
      out.add('anchor', 'UNVERIFIED', link.line, `anchor not checked: ${set.error}`, { evidence });
      return;
    }
    if (!set.has(key)) {
      out.add('anchor', 'FAIL', link.line, `anchor #${clip(fragment, 60)} not found in ${clip(normalized, 80)}${lineNote}`, {
        evidence,
        fix: closestAnchorFix(key, set),
      });
      return;
    }
  }
  out.add('link', 'PASS', link.line, `${link.kind === 'image' || link.kind === 'html-src' ? 'asset' : 'file'} exists: ${clip(normalized, 120)}`, { evidence });
}

/* ---------- inline-code file references ---------- */

const BARE_EXTENSIONS = new Set(['json', 'yml', 'yaml', 'toml', 'md', 'lock', 'txt', 'sh', 'cfg', 'ini', 'conf', 'png', 'svg', 'jpg', 'jpeg', 'gif', 'html', 'css']);
const PATH_EXTENSIONS = new Set([...BARE_EXTENSIONS, 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'php', 'ps1', 'bat']);
const GENERATED_DIRS = new Set(['dist', 'build', 'out', 'target', 'coverage', 'node_modules', '.next', '.nuxt', '.cache', 'tmp', 'temp', 'bin', 'obj', 'public']);

function looksLikeLocalPath(text: string): boolean {
  if (text.length === 0 || text.length > 200) return false;
  for (const ch of text) {
    if (' *{}<>$|:?`"\'()[]!,;=&^%'.includes(ch) || ch.charCodeAt(0) < 32) return false;
  }
  if (text.startsWith('-') || text.startsWith('@') || text.startsWith('/') || text.startsWith('~') || text.startsWith('#')) return false;
  if (text.includes(SLASH2) || text.includes(BS)) return false;
  const cleaned = text.endsWith('/') ? text.slice(0, -1) : text;
  const ext = path.extname(cleaned).slice(1).toLowerCase();
  const rel = text.startsWith('./') || text.startsWith('../');
  if (rel) return cleaned.length > 2;
  if (cleaned.includes('/')) return PATH_EXTENSIONS.has(ext) || text.endsWith('/');
  return BARE_EXTENSIONS.has(ext) && /^[A-Za-z0-9._-]+$/.test(cleaned);
}

function firstSegment(p: string): string {
  const clean = p.startsWith('./') ? p.slice(2) : p;
  return clean.split('/')[0] ?? '';
}

function checkInlineFileRefs(doc: ParsedDocument, project: Project, cache: FsCache, out: Collector): void {
  const seen = new Set<string>();
  for (const ic of doc.inlineCode) {
    const text = ic.text.trim();
    if (!looksLikeLocalPath(text)) continue;
    const key = `${ic.line}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = resolveContained(project.boundary, path.resolve(project.projectDir, text));
    if (!res.ok) {
      out.add('path-traversal', 'FAIL', ic.line, `referenced path ${res.detail}`, { evidence: `\`${clip(text)}\`` });
      continue;
    }
    if (res.exists) {
      const mismatchAbs = cache.caseMismatch(project.boundary, path.resolve(project.projectDir, text));
      if (mismatchAbs !== undefined) {
        const mismatch = showRel(project.projectDir, mismatchAbs);
        out.add('case-mismatch', 'FAIL', ic.line, `referenced path differs in letter case from the real file (${mismatch})`, {
          evidence: `\`${clip(text)}\``,
          fix: `Use the exact case: ${mismatch}`,
        });
      } else out.add('referenced-file', 'PASS', ic.line, `referenced path exists: ${clip(text)}`, { evidence: `\`${clip(text)}\`` });
      continue;
    }
    const generated = GENERATED_DIRS.has(firstSegment(text));
    out.add('referenced-file', 'UNVERIFIED', ic.line, `referenced path not found: ${clip(text)}${generated ? ' (looks like build output)' : ''}`, {
      evidence: `\`${clip(text)}\``,
      fix: 'If the file is generated by a build step this is expected; otherwise fix the path or add the file.',
    });
  }
}

/* ---------- commands: scripts, files, package names ---------- */

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_SUBCOMMANDS = new Set(['run', 'run-script', 'rum', 'urn']);
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall']);
const YARN_SCRIPT_SHORTCUTS = new Set(['test', 'start', 'build', 'dev', 'lint']);
const DIR_FLAGS = new Set(['--workspace', '-w', '--workspaces', '--prefix', '-C', '--filter', '-F', '--cwd', '--dir', '--recursive', '-r']);
const FLAGS_WITH_VALUE = new Set(['--registry', '--tag', '--prefix', '-C', '--workspace', '-w', '--filter', '-F', '--cwd', '--dir', '--save-prefix', '--userconfig', '--cache', '--loglevel', '--otp', '--scope']);
const INTERPRETER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  node: ['.js', '.mjs', '.cjs', '.ts'],
  nodejs: ['.js', '.mjs', '.cjs'],
  deno: ['.js', '.ts', '.mjs', '.tsx'],
  tsx: ['.ts', '.tsx', '.js', '.mjs'],
  'ts-node': ['.ts', '.js'],
  python: ['.py'],
  python3: ['.py'],
  py: ['.py'],
  ruby: ['.rb'],
  perl: ['.pl'],
  php: ['.php'],
  bash: ['.sh', '.bash'],
  sh: ['.sh'],
  zsh: ['.sh', '.zsh'],
};
const NODE_FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions']);
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '--check']);

const NPM_NAME = /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/;

function plain(words: Word[]): string[] {
  return words.map((w) => w.text);
}

/** Remove a trailing @version/@tag from a package spec. Returns undefined when it is not a plain registry name. */
export function packageNameFromSpec(spec: string): string | undefined {
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~') || spec.startsWith('-')) return undefined;
  if (spec.includes(':') || spec.includes(SLASH2) || spec.includes(BS)) return undefined;
  let name = spec;
  const at = spec.lastIndexOf('@');
  if (at > 0) name = spec.slice(0, at);
  if (!NPM_NAME.test(name)) return undefined;
  /* "user/repo" is a GitHub shorthand, not a registry name. */
  if (!name.startsWith('@') && name.includes('/')) return undefined;
  const lower = name.toLowerCase();
  if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz') || lower.endsWith('.zip')) return undefined;
  return name;
}

function baseName(pkgName: string): string {
  return (pkgName.split('/').pop() as string).toLowerCase();
}

/** True when `candidate` is not `actual` but is close enough to be an obvious mix-up of it. */
export function isLikelyWrongName(candidate: string, actual: string): boolean {
  if (candidate === actual) return false;
  const cb = baseName(candidate);
  const ab = baseName(actual);
  if (cb === ab) return true;
  return ab.length >= 6 && levenshtein(cb, ab) <= 2;
}

interface PackageRef {
  name: string;
  line: number;
  via: 'install' | 'exec' | 'import';
  raw: string;
}

interface ScriptRef {
  manager: string;
  script: string;
  line: number;
  raw: string;
  skipReason?: string;
}

interface FileRef {
  path: string;
  line: number;
  raw: string;
  executeDirectly: boolean;
  skipReason?: string;
}

function nonFlagArgs(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function analyzeCommand(cmd: ShellCommand): { scripts: ScriptRef[]; packages: PackageRef[]; files: FileRef[] } {
  const res = { scripts: [] as ScriptRef[], packages: [] as PackageRef[], files: [] as FileRef[] };
  const words = cmd.words;
  if (words.length === 0) return res;
  const texts = plain(words);
  const first = texts[0] as string;
  const args = texts.slice(1);
  const dynamicAny = words.some((w) => w.dynamic);
  const dirChange =
    cmd.cwdChanged ? 'runs after cd, so relative lookups are unreliable' : args.some((a) => DIR_FLAGS.has(a) || a.startsWith('--workspace=') || a.startsWith('--prefix=') || a.startsWith('--filter=')) ? 'targets another workspace or directory' : undefined;

  if (MANAGERS.has(first)) {
    const sub = args.find((a) => !a.startsWith('-'));
    const subIdx = sub === undefined ? -1 : args.indexOf(sub);
    const rest = subIdx >= 0 ? args.slice(subIdx + 1) : [];
    const mk = (script: string): ScriptRef => {
      const r: ScriptRef = { manager: first, script, line: cmd.line, raw: cmd.raw };
      if (dirChange) r.skipReason = dirChange;
      return r;
    };
    if (sub !== undefined) {
      if (RUN_SUBCOMMANDS.has(sub) || (first === 'bun' && sub === 'run')) {
        const script = nonFlagArgs(rest, FLAGS_WITH_VALUE)[0];
        if (script !== undefined && /^[A-Za-z0-9:_.@/-]+$/.test(script) && !dynamicAny) res.scripts.push(mk(script));
      } else if (first === 'npm' && (sub === 'test' || sub === 't' || sub === 'tst' || sub === 'start')) {
        res.scripts.push(mk(sub === 'start' ? 'start' : 'test'));
      } else if ((first === 'pnpm' || first === 'yarn') && YARN_SCRIPT_SHORTCUTS.has(sub)) {
        res.scripts.push(mk(sub));
      } else if (INSTALL_SUBCOMMANDS.has(sub) && !dirChange) {
        for (const spec of nonFlagArgs(rest, FLAGS_WITH_VALUE)) {
          const name = packageNameFromSpec(spec);
          if (name !== undefined && !dynamicAny) res.packages.push({ name, line: cmd.line, via: 'install', raw: cmd.raw });
        }
      } else if (sub === 'dlx' || sub === 'exec' || sub === 'x') {
        const spec = nonFlagArgs(rest, new Set(['--package', '-p']))[0];
        const name = spec === undefined ? undefined : packageNameFromSpec(spec);
        if (name !== undefined && !dynamicAny) res.packages.push({ name, line: cmd.line, via: 'exec', raw: cmd.raw });
      }
    }
    return res;
  }

  if (first === 'npx' || first === 'bunx') {
    let pkgFlag: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if ((a === '-p' || a === '--package') && args[i + 1] !== undefined) pkgFlag = args[i + 1];
      else if (a.startsWith('--package=')) pkgFlag = a.slice('--package='.length);
    }
    const spec = pkgFlag ?? nonFlagArgs(args, new Set(['-p', '--package', '-c', '--call', '--registry']))[0];
    const name = spec === undefined ? undefined : packageNameFromSpec(spec);
    if (name !== undefined && !dynamicAny) res.packages.push({ name, line: cmd.line, via: 'exec', raw: cmd.raw });
    return res;
  }

  const exts = Object.hasOwn(INTERPRETER_COMMANDS, first) ? INTERPRETER_COMMANDS[first] : undefined;
  if (exts) {
    if (args.some((a) => NODE_EVAL_FLAGS.has(a)) || args.includes('-m') || args.includes('-c')) return res;
    const candidates = nonFlagArgs(args, first.startsWith('python') || first === 'py' ? new Set(['-W', '-X']) : NODE_FLAGS_WITH_VALUE);
    let file = candidates[0];
    if (first === 'deno' && file === 'run') file = candidates[1];
    if (file !== undefined) {
      const idx = texts.indexOf(file);
      const word = words[idx];
      const ext = path.extname(file).toLowerCase();
      if (word && !word.dynamic && exts.includes(ext) && !file.startsWith('/') && !file.startsWith('~') && !/^[A-Za-z]:/.test(file) && !file.includes('://')) {
        const ref: FileRef = { path: file, line: cmd.line, raw: cmd.raw, executeDirectly: false };
        if (dirChange) ref.skipReason = dirChange;
        res.files.push(ref);
      }
    }
    return res;
  }

  if ((first.startsWith('./') || first.startsWith('../')) && !(words[0] as Word).dynamic && first.length > 2) {
    const ref: FileRef = { path: first, line: cmd.line, raw: cmd.raw, executeDirectly: true };
    if (dirChange) ref.skipReason = dirChange;
    res.files.push(ref);
  }
  return res;
}

/** Paths that an earlier command in the README plausibly creates. */
function createdPaths(cmd: ShellCommand): string[] {
  const out: string[] = [];
  const t = cmd.words.map((w) => w.text);
  for (let i = 0; i < t.length; i++) {
    const w = t[i] as string;
    const next = t[i + 1];
    if ((w.startsWith('>') || w === '-o' || w === '--output' || w === '-O') && next !== undefined) out.push(next);
    if (['touch', 'mkdir', 'tee'].includes(w)) for (const a of t.slice(i + 1)) if (!a.startsWith('-')) out.push(a);
    if ((w === 'cp' || w === 'mv') && t.length > i + 2) out.push(t[t.length - 1] as string);
  }
  return out.map((p) => (p.startsWith('./') ? p.slice(2) : p).replace(/[/]+$/, ''));
}

function commandsOf(doc: ParsedDocument): ShellCommand[] {
  const all: ShellCommand[] = [];
  const items: Array<{ line: number; cmds: ShellCommand[] }> = [];
  for (const b of doc.blocks) {
    if (!isShellLike(b) || b.annotation?.skip) continue;
    items.push({ line: b.line, cmds: extractShellCommands(b.content, b.contentLine) });
  }
  for (const ic of doc.inlineCode) {
    const t = ic.text.trim();
    const head = t.split(' ')[0] ?? '';
    if (t.includes(' ') && (MANAGERS.has(head) || head === 'npx')) {
      items.push({ line: ic.line, cmds: extractShellCommands(t, ic.line) });
    }
  }
  items.sort((a, b) => a.line - b.line);
  for (const it of items) all.push(...it.cmds);
  return all;
}

function checkCommands(doc: ParsedDocument, project: Project, cache: FsCache, out: Collector): void {
  const pkg = project.pkg;
  const created = new Set<string>();
  for (const cmd of commandsOf(doc)) {
    const { scripts, packages, files } = analyzeCommand(cmd);

    for (const s of scripts) {
      const evidence = clip(s.raw);
      if (s.skipReason) {
        out.add('package-script', 'UNVERIFIED', s.line, `script "${s.script}" not checked: command ${s.skipReason}`, { evidence });
        continue;
      }
      if (!pkg || !pkg.valid) {
        out.add('package-script', 'UNVERIFIED', s.line, `script "${s.script}" not checked: ${pkg?.error ?? 'no package.json found for this README'}`, {
          evidence,
          fix: 'Run readmeproof from a project that has a package.json, or pass --root.',
        });
        continue;
      }
      if (pkg.scripts.has(s.script)) {
        out.add('package-script', 'PASS', s.line, `package.json defines script "${s.script}"`, { evidence });
      } else if (s.manager === 'npm' && s.script === 'start' && cache.list(project.projectDir)?.includes('server.js')) {
        out.add('package-script', 'PASS', s.line, 'npm start falls back to "node server.js", which exists', { evidence });
      } else {
        const available = [...pkg.scripts].sort().slice(0, 10);
        out.add('package-script', 'FAIL', s.line, `package.json has no script named "${s.script}"`, {
          evidence,
          fix: available.length > 0 ? `Add the script or use one of: ${available.join(', ')}.` : 'Add the script to package.json "scripts" or fix the command.',
        });
      }
    }

    for (const f of files) {
      const evidence = clip(f.raw);
      const norm = f.path.startsWith('./') ? f.path.slice(2) : f.path;
      if (f.skipReason) {
        out.add('missing-file', 'UNVERIFIED', f.line, `file ${clip(f.path, 80)} not checked: command ${f.skipReason}`, { evidence });
        continue;
      }
      const abs = path.resolve(project.projectDir, f.path);
      const res = resolveContained(project.boundary, abs);
      if (!res.ok) {
        out.add(res.reason === 'symlink-escape' ? 'symlink-escape' : 'path-traversal', 'FAIL', f.line, `command refers to a path that ${res.detail}`, { evidence });
        continue;
      }
      if (res.exists) {
        const mismatchAbs = cache.caseMismatch(project.boundary, abs);
        const mismatch = mismatchAbs === undefined ? '' : showRel(project.projectDir, mismatchAbs);
        if (mismatchAbs !== undefined) {
          out.add('case-mismatch', 'FAIL', f.line, `command path differs in letter case from the real file (${mismatch})`, {
            evidence,
            fix: `Use the exact case: ${mismatch}`,
          });
        } else if (f.executeDirectly && process.platform !== 'win32' && res.kind === 'file' && isNotExecutable(abs)) {
          out.add('missing-file', 'FAIL', f.line, `${clip(f.path, 80)} exists but is not executable`, {
            evidence,
            fix: `Run chmod +x ${clip(f.path, 80)} and commit the mode, or invoke it through an interpreter.`,
          });
        } else out.add('referenced-file', 'PASS', f.line, `command file exists: ${clip(f.path, 80)}`, { evidence });
        continue;
      }
      if (created.has(norm)) {
        out.add('referenced-file', 'UNVERIFIED', f.line, `${clip(f.path, 80)} does not exist yet but an earlier README command appears to create it`, { evidence });
      } else if (GENERATED_DIRS.has(firstSegment(f.path)) && firstSegment(f.path) !== 'bin') {
        out.add('referenced-file', 'UNVERIFIED', f.line, `${clip(f.path, 80)} not found (looks like build output)`, {
          evidence,
          fix: 'Expected if a build step creates it; document that step before this command.',
        });
      } else {
        const hint = cache.suggest(abs);
        out.add('missing-file', 'FAIL', f.line, `command refers to a file that does not exist: ${clip(f.path, 80)}`, {
          evidence,
          fix: hint ? `Did you mean ${hint}? Otherwise add the file or fix the path.` : 'Add the file or fix the path in the README.',
        });
      }
    }

    for (const p of packages) checkPackageName(p, pkg, out);

    for (const c of createdPaths(cmd)) created.add(c);
  }
}

function isNotExecutable(abs: string): boolean {
  try {
    return (statSync(abs).mode & 0o111) === 0;
  } catch {
    return false;
  }
}

function checkPackageName(ref: PackageRef, pkg: Project['pkg'], out: Collector): void {
  if (!pkg || !pkg.valid || !pkg.name || pkg.private) return;
  const evidence = clip(ref.raw);
  if (ref.name === pkg.name) {
    out.add('package-name', 'PASS', ref.line, `package name "${ref.name}" matches package.json`, { evidence });
    return;
  }
  if (pkg.dependencies.has(ref.name)) return;
  if (ref.via === 'exec' && pkg.bins.has(ref.name)) return;
  if (isLikelyWrongName(ref.name, pkg.name)) {
    out.add('package-name', 'FAIL', ref.line, `README refers to "${ref.name}" but package.json name is "${pkg.name}"`, {
      evidence,
      fix: `Use "${pkg.name}"${pkg.bins.size > 0 && ref.via === 'exec' ? ` (or the bin name: ${[...pkg.bins].join(', ')})` : ''}.`,
    });
  }
}

/* ---------- JS imports ---------- */

const IMPORT_RE = /(?:from[\s]+|require[\s]*[(][\s]*|import[\s]+|import[\s]*[(][\s]*)(['"])([^'"\n]{1,214})\1/g;
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0] as string]));

function checkImports(doc: ParsedDocument, project: Project, out: Collector): void {
  const pkg = project.pkg;
  if (!pkg || !pkg.valid || !pkg.name || pkg.private) return;
  for (const b of doc.blocks) {
    if (!isJsLike(b) || b.annotation?.skip) continue;
    const lines = b.content.split('\n');
    for (let i = 0; i < lines.length && i < 2000; i++) {
      const line = lines[i] as string;
      if (line.length > 2000) continue;
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(line)) !== null) {
        const spec = m[2] as string;
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.includes(':')) continue;
        const segs = spec.split('/');
        const name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] as string);
        if (BUILTINS.has(name) || !NPM_NAME.test(name)) continue;
        checkPackageName({ name, line: b.contentLine + i, via: 'import', raw: line.trim() }, pkg, out);
      }
    }
  }
}

