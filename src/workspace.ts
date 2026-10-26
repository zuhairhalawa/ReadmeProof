import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';
import type { TarEntry } from './tar.js';

/**
 * Builds the sanitized copy of the project that is sent into the container.
 * Nothing here is ever written to the host; entries stream into the container as a tar.
 */

export interface WorkspaceLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxDepth: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxFiles: 5000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxDepth: 40,
};

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface Workspace {
  entries: TarEntry[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  skipped: SkippedItem[];
  skippedCount: number;
}

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.bzr', 'node_modules', '.ssh', '.aws', '.gnupg', '.gpg', '.docker', '.kube',
  '.azure', '.config', '.npm', '.terraform', '.vault', '.idea', '.vscode',
]);

const EXCLUDED_FILES = new Set([
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.dockercfg',
  '.htpasswd', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yml', 'secrets.yaml',
  'kubeconfig', '.vault-token', '.bash_history', '.zsh_history', '.psql_history', '.node_repl_history',
  '.ds_store', 'thumbs.db', 'terraform.tfstate', 'terraform.tfstate.backup', '.git',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.gpg', '.p8', '.tfstate', '.tfvars', '.ppk', '.crt-key',
]);

const ENV_SAFE_SUFFIXES = new Set(['.example', '.sample', '.template', '.dist', '.defaults']);

/** Returns a reason when `name` (a single path segment) must never be copied. */
export function excludedReason(name: string, isDir: boolean): string | undefined {
  const lower = name.toLowerCase();
  if (isDir) {
    if (EXCLUDED_DIRS.has(lower)) return 'excluded directory';
    return undefined;
  }
  if (EXCLUDED_FILES.has(lower)) return 'credential or history file';
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) {
    const suffix = lower.startsWith('.env.') ? lower.slice(4) : '';
    if (!ENV_SAFE_SUFFIXES.has(suffix)) return 'environment file';
  }
  if (lower.startsWith('id_rsa') || lower.startsWith('id_dsa') || lower.startsWith('id_ecdsa') || lower.startsWith('id_ed25519')) {
    return 'SSH key';
  }
  const ext = path.extname(lower);
  if (EXCLUDED_EXTENSIONS.has(ext)) return 'key or certificate material';
  if (lower.includes('service-account') && ext === '.json') return 'service account credentials';
  return undefined;
}

function readFileNoFollow(file: string, maxBytes: number): Buffer | undefined {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < st.size) {
      const n = readSync(fd, buf, total, st.size - total, null);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

export function collectWorkspace(root: string, limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS, prefix = 'work'): Workspace {
  const ws: Workspace = { entries: [], fileCount: 0, dirCount: 0, totalBytes: 0, skipped: [], skippedCount: 0 };
  const skip = (p: string, reason: string): void => {
    ws.skippedCount++;
    if (ws.skipped.length < 200) ws.skipped.push({ path: p, reason });
  };

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (depth > limits.maxDepth) {
      skip(relDir, 'directory nesting too deep');
      return;
    }
    let names: string[];
    try {
      names = readdirSync(absDir).sort();
    } catch {
      skip(relDir || '.', 'directory unreadable');
      return;
    }
    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        skip(rel, 'unreadable');
        continue;
      }
      if (st.isSymbolicLink()) {
        skip(rel, 'symlink (never copied or followed)');
        continue;
      }
      if (st.isDirectory()) {
        const reason = excludedReason(name, true);
        if (reason) {
          skip(rel + '/', reason);
          continue;
        }
        ws.dirCount++;
        ws.entries.push({ path: `${prefix}/${rel}`, type: 'dir', mode: 0o755, mtime: Math.max(0, Math.floor(st.mtimeMs / 1000)) });
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        skip(rel, 'special file');
        continue;
      }
      const reason = excludedReason(name, false);
      if (reason) {
        skip(rel, reason);
        continue;
      }
      if (st.size > limits.maxFileBytes) {
        skip(rel, `larger than ${limits.maxFileBytes} bytes`);
        continue;
      }
      if (ws.fileCount + 1 > limits.maxFiles) {
        throw new WorkspaceError(`project has more than ${limits.maxFiles} files; pass --root to a smaller directory`);
      }
      if (ws.totalBytes + st.size > limits.maxTotalBytes) {
        throw new WorkspaceError(`project is larger than ${limits.maxTotalBytes} bytes after exclusions; pass --root to a smaller directory`);
      }
      let data: Buffer | undefined;
      try {
        data = readFileNoFollow(abs, limits.maxFileBytes);
      } catch {
        data = undefined;
      }
      if (data === undefined) {
        skip(rel, 'unreadable or changed while copying');
        continue;
      }
      const executable = (st.mode & 0o111) !== 0 || (process.platform === 'win32' && data.subarray(0, 2).toString('latin1') === '#!');
      ws.fileCount++;
      ws.totalBytes += data.length;
      ws.entries.push({
        path: `${prefix}/${rel}`,
        type: 'file',
        mode: executable ? 0o755 : 0o644,
        mtime: Math.max(0, Math.floor(st.mtimeMs / 1000)),
        data,
      });
    }
  };

  walk(root, '', 0);
  return ws;
}

