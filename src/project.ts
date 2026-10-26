import { existsSync, lstatSync, readdirSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, readBoundedFile, resolveContained } from './safe.js';

export const MAX_README_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
export const MAX_LINKED_MARKDOWN_BYTES = 2 * 1024 * 1024;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface PackageInfo {
  dir: string;
  file: string;
  valid: boolean;
  error?: string;
  name?: string;
  private: boolean;
  scripts: Set<string>;
  dependencies: Set<string>;
  bins: Set<string>;
}

export interface Project {
  /** Absolute path of the README. */
  readmeAbs: string;
  /** Path shown to users (relative to cwd when inside it, with forward slashes). */
  readmeDisplay: string;
  readmeDir: string;
  /** Link containment boundary: links may not resolve outside this directory. */
  boundary: string;
  /** Directory holding package.json (or the boundary when there is none). Used for scripts and copying. */
  projectDir: string;
  pkg: PackageInfo | undefined;
  rootWasOverridden: boolean;
}

const README_NAMES = ['readme.md', 'readme.markdown', 'readme.mdx', 'readme'];

export function toDisplayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  const shown = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  return shown.split(path.sep).join('/');
}

/** Find the README inside a directory without following symlinks that leave it. */
export function findReadmeInDir(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const byLower = new Map<string, string>();
  for (const e of entries.sort()) if (!byLower.has(e.toLowerCase())) byLower.set(e.toLowerCase(), e);
  for (const candidate of README_NAMES) {
    const actual = byLower.get(candidate);
    if (actual === undefined) continue;
    const full = path.join(dir, actual);
    const res = resolveContained(dir, full);
    if (!res.ok || res.kind !== 'file') continue;
    return full;
  }
  return undefined;
}

export function resolveReadme(target: string, cwd: string): string {
  const abs = path.resolve(cwd, target);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new UsageError(`cannot read "${target}": no such file or directory`);
  }
  if (st.isDirectory()) {
    const found = findReadmeInDir(abs);
    if (!found) throw new UsageError(`no README (README.md, README.markdown, ...) found in "${target}"`);
    return found;
  }
  if (!st.isFile()) throw new UsageError(`"${target}" is not a regular file`);
  return abs;
}

function ancestors(start: string): string[] {
  const out: string[] = [];
  let cur = start;
  for (let i = 0; i < 256; i++) {
    out.push(cur);
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return out;
}

export function loadPackageJson(dir: string): PackageInfo | undefined {
  const file = path.join(dir, 'package.json');
  let lst;
  try {
    lst = lstatSync(file);
  } catch {
    return undefined;
  }
  const info: PackageInfo = {
    dir,
    file,
    valid: false,
    private: false,
    scripts: new Set(),
    dependencies: new Set(),
    bins: new Set(),
  };
  if (!lst.isFile()) {
    info.error = 'package.json is not a regular file';
    return info;
  }
  let data: unknown;
  try {
    data = JSON.parse(readBoundedFile(file, MAX_PACKAGE_JSON_BYTES));
  } catch (err) {
    info.error = `package.json could not be parsed: ${(err as Error).message}`;
    return info;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    info.error = 'package.json is not a JSON object';
    return info;
  }
  const obj = data as Record<string, unknown>;
  info.valid = true;
  if (typeof obj['name'] === 'string') info.name = obj['name'];
  info.private = obj['private'] === true;
  const keys = (v: unknown): string[] =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v as object) : [];
  for (const k of keys(obj['scripts'])) info.scripts.add(k);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const k of keys(obj[field])) info.dependencies.add(k);
  }
  const bin = obj['bin'];
  if (typeof bin === 'string' && info.name) info.bins.add(info.name.split('/').pop() as string);
  else for (const k of keys(bin)) info.bins.add(k);
  return info;
}

export interface DiscoverOptions {
  rootOverride?: string;
  cwd: string;
}

export function discoverProject(readmeAbs: string, opts: DiscoverOptions): Project {
  const readmeDir = path.dirname(readmeAbs);
  let boundary: string;
  let projectDir: string;
  let pkg: PackageInfo | undefined;
  if (opts.rootOverride !== undefined) {
    const root = path.resolve(opts.cwd, opts.rootOverride);
    let real: string;
    try {
      real = realpathSync(root);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new UsageError(`--root "${opts.rootOverride}" is not an accessible directory`);
    }
    if (!isInside(real, (() => { try { return realpathSync(readmeAbs); } catch { return readmeAbs; } })())) {
      throw new UsageError(`the README is not inside --root "${opts.rootOverride}"`);
    }
    boundary = real;
    projectDir = real;
    pkg = loadPackageJson(real);
  } else {
    const chain = ancestors(readmeDir);
    const gitRoot = chain.find((d) => existsSync(path.join(d, '.git')));
    const pkgDir = chain.find((d) => existsSync(path.join(d, 'package.json')));
    boundary = gitRoot ?? pkgDir ?? readmeDir;
    /* The package dir must not be above the containment boundary. */
    projectDir = pkgDir !== undefined && isInside(boundary, pkgDir) ? pkgDir : boundary;
    pkg = loadPackageJson(projectDir);
  }
  return {
    readmeAbs,
    readmeDisplay: toDisplayPath(readmeAbs, opts.cwd),
    readmeDir,
    boundary,
    projectDir,
    pkg,
    rootWasOverridden: opts.rootOverride !== undefined,
  };
}

/** Directories that must never be copied wholesale into a container. */
export function isDangerousRoot(dir: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return 'the project directory is not accessible';
  }
  if (path.dirname(real) === real) return 'the project directory is the filesystem root';
  let home: string | undefined;
  try {
    home = realpathSync(os.homedir());
  } catch {
    home = undefined;
  }
  if (home !== undefined && real === home) return 'the project directory is your home directory';
  if (home !== undefined && isInside(real, home)) return 'the project directory contains your home directory';
  return undefined;
}

