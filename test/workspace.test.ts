import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectWorkspace, excludedReason, WorkspaceError } from '../src/workspace.js';
import { makeTempDir, writeTree } from './helpers.js';

const SECRET = 'SUPERSECRET-DO-NOT-LEAK';

describe('excludedReason', () => {
  it('excludes credentials, keys, history and VCS data', () => {
    for (const f of ['.env', '.env.local', '.env.production', 'prod.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'tls.key', 'cert.p12', 'a.pfx', 'x.kdbx', '.pypirc', '.git-credentials', 'credentials', '.bash_history', 'terraform.tfstate', 'prod.tfvars', 'my-service-account-1.json', '.git', 'Thumbs.db', '.yarnrc.yml', '.envrc', '.ENVRC', '.Env.Staging', '.ENV', 'ID_RSA', 'id_ecdsa', 'id_dsa', 'x.pkcs12', 'x.jceks', 'store.jks', 'x.keystore', 'putty.ppk', 'AuthKey_X.p8', 'prod.tfvars.json', 'terraform.tfstate.backup', '.pgpass', '.my.cnf', '.s3cfg', '.boto', '.authinfo', '.dockerconfigjson', 'credentials.toml', 'credentials.yaml', '.vault-token', '.htpasswd', '.psql_history', '.zsh_history', '_netrc', 'kubeconfig', 'CREDENTIALS.JSON', 'Secrets.YML']) {
      assert.notEqual(excludedReason(f, false), undefined, f);
    }
    for (const d of ['.git', '.ssh', '.aws', '.gnupg', 'node_modules', '.docker', '.kube', '.config', '.NPM', '.gem', '.m2', '.SSH', '.Aws', '.azure', '.terraform', '.hg', '.svn', '.vault']) {
      assert.notEqual(excludedReason(d, true), undefined, d);
    }
  });
  it('keeps ordinary files and env templates', () => {
    for (const f of ['README.md', 'package.json', '.env.example', '.env.sample', '.env.template', '.gitignore', 'index.js', 'environment.ts', 'keys.md', 'credentials.md', 'secrets.md', 'envrc.md', 'environment', 'README.md', 'cert.pub.md']) {
      assert.equal(excludedReason(f, false), undefined, f);
    }
    assert.equal(excludedReason('.github', true), undefined);
    assert.equal(excludedReason('src', true), undefined);
  });
});

describe('collectWorkspace', () => {
  function project(): string {
    const dir = makeTempDir();
    writeTree(dir, {
      'README.md': '# hi\n',
      'package.json': '{}',
      '.env': `TOKEN=${SECRET}\n`,
      '.env.local': SECRET,
      '.env.example': 'TOKEN=changeme\n',
      '.npmrc': `//registry.npmjs.org/:_authToken=${SECRET}\n`,
      '.git/config': `[remote]\nurl=https://user:${SECRET}@example.com/r.git\n`,
      '.git/HEAD': 'ref',
      '.ssh/id_rsa': SECRET,
      'id_rsa': SECRET,
      'deploy.pem': SECRET,
      'node_modules/dep/index.js': SECRET,
      'src/index.js': 'console.log(1)\n',
      'src/deep/er/file.txt': 'x',
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
    });
    return dir;
  }

  it('copies project files under work/ and never includes secrets, .git or node_modules', () => {
    const ws = collectWorkspace(project());
    const names = ws.entries.map((e) => e.path);
    assert.ok(names.includes('work/README.md'));
    assert.ok(names.includes('work/.env.example'));
    assert.ok(names.includes('work/src/deep/er/file.txt'));
    assert.ok(names.every((n) => n.startsWith('work/')));
    for (const bad of ['.env', '.env.local', '.npmrc', '.git', '.ssh', 'id_rsa', 'deploy.pem', 'node_modules']) {
      assert.ok(!names.some((n) => n === `work/${bad}` || n.startsWith(`work/${bad}/`)), bad);
    }
    for (const e of ws.entries) assert.ok(!e.data?.toString().includes(SECRET), e.path);
    assert.ok(ws.skippedCount >= 8);
    assert.ok(ws.skipped.some((s) => s.path === '.env' && s.reason === 'environment file'));
  });

  it('marks shebang scripts executable', () => {
    const ws = collectWorkspace(project());
    assert.equal(ws.entries.find((e) => e.path === 'work/scripts/run.sh')?.mode, 0o755);
    assert.equal(ws.entries.find((e) => e.path === 'work/README.md')?.mode, 0o644);
  });

  it('preserves the exec bit on POSIX', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX file modes only');
      return;
    }
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'tool'), 'binary');
    chmodSync(path.join(dir, 'tool'), 0o755);
    assert.equal(collectWorkspace(dir).entries[0]?.mode, 0o755);
  });

  it('never copies or follows symlinks', (t) => {
    const outside = makeTempDir();
    writeTree(outside, { 'host-secret.txt': SECRET });
    const dir = makeTempDir();
    writeTree(dir, { 'ok.txt': 'ok' });
    let fileLink = false;
    let dirLink = false;
    try {
      symlinkSync(path.join(outside, 'host-secret.txt'), path.join(dir, 'link.txt'), 'file');
      fileLink = true;
    } catch {
      /* not permitted (unprivileged Windows) */
    }
    try {
      symlinkSync(outside, path.join(dir, 'linkdir'), 'junction');
      dirLink = true;
    } catch {
      /* not permitted */
    }
    if (!fileLink && !dirLink) {
      t.skip('symlinks not permitted on this system');
      return;
    }
    const ws = collectWorkspace(dir);
    assert.deepEqual(ws.entries.map((e) => e.path), ['work/ok.txt']);
    if (fileLink) assert.ok(ws.skipped.some((s) => s.path === 'link.txt' && /symlink/.test(s.reason)));
    if (dirLink) assert.ok(ws.skipped.some((s) => s.path === 'linkdir' && /symlink/.test(s.reason)));
    for (const e of ws.entries) assert.ok(!e.data?.toString().includes(SECRET));
  });

  it('skips oversized files and enforces file-count and total-size limits', () => {
    const dir = makeTempDir();
    writeTree(dir, { 'big.bin': Buffer.alloc(2000), 'a.txt': 'a', 'b.txt': 'b' });
    const limits = { maxFiles: 10, maxTotalBytes: 1000, maxFileBytes: 1500, maxDepth: 5 };
    const ws = collectWorkspace(dir, limits);
    assert.deepEqual(ws.entries.map((e) => e.path), ['work/a.txt', 'work/b.txt']);
    assert.ok(ws.skipped.some((s) => s.path === 'big.bin'));
    assert.throws(() => collectWorkspace(dir, { ...limits, maxFiles: 1 }), WorkspaceError);
    assert.throws(() => collectWorkspace(dir, { ...limits, maxTotalBytes: 1, maxFileBytes: 1500 }), /larger than/);
  });

  it('limits directory depth', () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(path.join(dir, 'a', 'b', 'c', 'd', 'f.txt'), 'x');
    const ws = collectWorkspace(dir, { maxFiles: 10, maxTotalBytes: 1e6, maxFileBytes: 1e6, maxDepth: 2 });
    assert.ok(!ws.entries.some((e) => e.path.endsWith('f.txt')));
    assert.ok(ws.skipped.some((s) => /too deep/.test(s.reason)));
  });
});

