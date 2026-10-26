import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import {
  createDockerRuntime,
  DEFAULT_IMAGE,
  DEFAULT_SETTINGS,
  detectDocker,
  imagePresent,
  pullImage,
  type DockerRuntime,
} from '../src/docker.js';
import { parseMarkdown } from '../src/markdown.js';
import type { Project } from '../src/project.js';
import { verifyBlocks } from '../src/verify.js';
import { makeTempDir, writeTree } from './helpers.js';

/**
 * REAL Docker integration tests. They run against an actual daemon and verify the isolation
 * guarantees from inside the container. When Docker is not available they are SKIPPED and say so;
 * a skipped run is NOT evidence that isolation works.
 *
 * READMEPROOF_DOCKER_TESTS=1 turns "Docker unavailable" into a hard failure (used in CI) and lets
 * the tests pull the image.
 */
const REQUIRED = process.env['READMEPROOF_DOCKER_TESTS'] === '1';
const IMAGE = process.env['READMEPROOF_TEST_IMAGE'] ?? DEFAULT_IMAGE;
const runtime: DockerRuntime = createDockerRuntime(process.env['READMEPROOF_DOCKER'] || 'docker', process.env);

let skipReason: string | undefined;

describe('real Docker isolation', () => {
  before(async () => {
    const status = await detectDocker(runtime);
    if (!status.available) {
      skipReason = `Docker unavailable: ${status.reason}`;
    } else if (!(await imagePresent(runtime, IMAGE))) {
      if (REQUIRED) {
        const pulled = await pullImage(runtime, IMAGE);
        if (!pulled.ok) skipReason = `image ${IMAGE} could not be pulled: ${pulled.detail}`;
      } else {
        skipReason = `image ${IMAGE} is not present locally (docker pull ${IMAGE} to enable these tests)`;
      }
    }
    if (skipReason) {
      const msg = `DOCKER INTEGRATION TESTS SKIPPED - ${skipReason}. Container isolation was NOT verified in this run.`;
      console.log(`\n!!! ${msg}\n`);
      if (REQUIRED) throw new Error(msg);
    }
  });

  async function runBlock(code: string, annotation = '', files: Record<string, string> = {}, overrides: Partial<Parameters<typeof verifyBlocks>[0]> = {}, lang = 'sh') {
    const dir = makeTempDir();
    const readme = `${annotation}\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    writeTree(dir, { 'README.md': readme, ...files });
    const doc = parseMarkdown(readme, 'README.md');
    const project: Project = { readmeAbs: path.join(dir, 'README.md'), readmeDisplay: 'README.md', readmeDir: dir, boundary: dir, projectDir: dir, pkg: undefined, rootWasOverridden: true };
    const report = await verifyBlocks({
      doc,
      project,
      runtime,
      settings: { ...DEFAULT_SETTINGS, image: IMAGE },
      timeoutSec: 60,
      maxOutputBytes: 64 * 1024,
      pull: false,
      ...overrides,
    });
    return { dir, result: report.results[0], report };
  }

  const test = (name: string, fn: () => Promise<void>) =>
    it(name, async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }
      await fn();
    });

  test('runs a block and checks declared assertions', async () => {
    const { result, report } = await runBlock('echo hello-from-container', '<!-- readmeproof: exit=0 output="hello-from-container" -->');
    assert.equal(report.execution.status, 'AVAILABLE');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.equal(result?.verification, 'asserted');
    assert.equal(result?.executed, true);
  });

  test('runs as a non-root user', async () => {
    const { result } = await runBlock('id -u', '<!-- readmeproof: output-exact="1000" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
  });

  test('has no network by default', async () => {
    const code = [
      "node -e \"const s=require('net').connect({host:'1.1.1.1',port:53,timeout:4000});",
      "s.on('connect',()=>{console.log('CONNECTED');process.exit(1)});",
      "s.on('error',()=>{console.log('NO-NETWORK');process.exit(0)});",
      "s.on('timeout',()=>{console.log('NO-NETWORK');process.exit(0)})\"",
    ].join('');
    const { result } = await runBlock(code, '<!-- readmeproof: output="NO-NETWORK" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.ok(!result?.stdout?.includes('CONNECTED'));
  });

  test('has a read-only root filesystem and no capabilities', async () => {
    const { result } = await runBlock('touch /etc/readmeproof-test 2>/dev/null && echo WRITABLE || echo READONLY; grep -E "^CapEff" /proc/self/status', '<!-- readmeproof: output="READONLY" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.match(result?.stdout ?? '', /CapEff:\s+0000000000000000/);
  });

  test('cannot gain privileges (no-new-privileges)', async () => {
    const { result } = await runBlock('grep -E "^NoNewPrivs" /proc/self/status', '<!-- readmeproof: output="NoNewPrivs:\t1" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
  });

  test('has no docker socket and no host mounts', async () => {
    const { result, dir } = await runBlock('test -e /var/run/docker.sock && echo SOCKET || echo NO-SOCKET; cat /proc/mounts', '<!-- readmeproof: output="NO-SOCKET" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const mounts = result?.stdout ?? '';
    assert.ok(!mounts.includes(dir), 'host project path must not appear in mounts');
    assert.ok(!/docker\.sock/.test(mounts));
    assert.ok(!/\/(Users|home)\//.test(mounts.replace(/\/home\/node/g, '')), 'no host home mounts');
  });

  test('does not inherit host environment variables or credentials', async () => {
    process.env['READMEPROOF_FAKE_SECRET'] = 'host-secret-value';
    process.env['GITHUB_TOKEN'] = 'host-secret-value';
    process.env['NPM_TOKEN'] = 'host-secret-value';
    try {
      const { result } = await runBlock('env', '<!-- readmeproof: output="HOME=/tmp/home" -->');
      assert.equal(result?.status, 'PASS', JSON.stringify(result));
      assert.ok(!(result?.stdout ?? '').includes('host-secret-value'));
      assert.ok(!/FAKE_SECRET|GITHUB_TOKEN|NPM_TOKEN/.test(result?.stdout ?? ''));
    } finally {
      delete process.env['READMEPROOF_FAKE_SECRET'];
      delete process.env['GITHUB_TOKEN'];
      delete process.env['NPM_TOKEN'];
    }
  });

  test('copies only sanitized project contents (no .env, .git, keys)', async () => {
    const { result } = await runBlock(
      'ls -A; for f in .env .git .npmrc id_rsa; do [ -e "$f" ] && echo "LEAK:$f"; done; echo checked',
      '<!-- readmeproof: output="checked" -->',
      { '.env': 'TOKEN=x', '.git/config': 'x', '.npmrc': 'x', 'id_rsa': 'x', 'keep.txt': 'ok' },
    );
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.ok(!result?.stdout?.includes('LEAK:'), result?.stdout);
    assert.ok(result?.stdout?.includes('keep.txt'));
    assert.ok(result?.stdout?.includes('README.md'));
  });

  test('cannot modify the host project (workspace is a throwaway copy)', async () => {
    const { result, dir } = await runBlock('echo tampered > README.md; echo created > new-file.txt', '<!-- readmeproof: exit=0 creates=new-file.txt -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.ok(!readFileSync(path.join(dir, 'README.md'), 'utf8').includes('tampered'));
    assert.throws(() => readFileSync(path.join(dir, 'new-file.txt')));
  });

  test('verifies created files and detects pre-existing ones', async () => {
    const ok = await runBlock('mkdir -p out && echo x > out/r.txt', '<!-- readmeproof: creates=out/r.txt -->');
    assert.equal(ok.result?.status, 'PASS', JSON.stringify(ok.result));
    const pre = await runBlock('true', '<!-- readmeproof: creates=README.md -->');
    assert.equal(pre.result?.status, 'FAIL');
    const missing = await runBlock('true', '<!-- readmeproof: creates=nope.txt -->');
    assert.equal(missing.result?.status, 'FAIL');
  });

  test('reports real exit codes and stderr', async () => {
    const { result } = await runBlock('echo oops >&2; exit 7', '<!-- readmeproof: exit=7 stderr="oops" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const bad = await runBlock('exit 3');
    assert.equal(bad.result?.status, 'FAIL');
    assert.equal(bad.result?.exitCode, 3);
  });

  test('runs js blocks (CommonJS and ESM) with cwd = project copy', async () => {
    const cjs = await runBlock("console.log(require('fs').existsSync('README.md') ? 'cwd-ok' : 'cwd-bad')", '<!-- readmeproof: output="cwd-ok" -->', {}, {}, 'js');
    assert.equal(cjs.result?.status, 'PASS', JSON.stringify(cjs.result));
    const esm = await runBlock("import os from 'node:os';\nconsole.log(typeof os.cpus)", '<!-- readmeproof: output="function" -->', {}, {}, 'js');
    assert.equal(esm.result?.status, 'PASS', JSON.stringify(esm.result));
  });

  test('enforces the time limit and leaves no container behind', async () => {
    const { result } = await runBlock('sleep 60', '', {}, { timeoutSec: 4 });
    assert.equal(result?.status, 'FAIL');
    assert.equal(result?.timedOut, true);
    const ps = await runtime.exec(['ps', '-a', '-q', '--filter', 'label=readmeproof=1'], { timeoutMs: 20000, maxCaptureBytes: 4096, killOutputBytes: 65536 });
    assert.equal(ps.stdout.text.trim(), '', 'no readmeproof container may remain');
  });

  test('bounds captured output', async () => {
    const { result } = await runBlock('head -c 3000000 /dev/zero | tr "\\0" "x"', '', {}, { maxOutputBytes: 2048 });
    assert.ok((result?.stdout?.length ?? 0) <= 2048);
    assert.equal(result?.stdoutTruncated, true);
  });

  test('enforces the memory limit', async () => {
    const { result } = await runBlock("const a=[];for(;;)a.push(Buffer.alloc(16*1024*1024,1))", '', {}, { settings: { ...DEFAULT_SETTINGS, image: IMAGE, memoryMb: 128 } }, 'js');
    assert.equal(result?.status, 'FAIL');
    assert.notEqual(result?.exitCode, 0);
  });

  test('enforces the PID limit (fork bomb is contained)', async () => {
    const code = 'ok=0; fail=0; i=0; while [ $i -lt 120 ]; do if (sleep 3 &) 2>/dev/null; then ok=$((ok+1)); else fail=$((fail+1)); fi; i=$((i+1)); done; echo "ok=$ok fail=$fail"';
    const { result } = await runBlock(code, '', {}, { settings: { ...DEFAULT_SETTINGS, image: IMAGE, pidsLimit: 24 } });
    assert.match(result?.stdout ?? '', /fail=[1-9][0-9]*/, `expected forks to be refused, got ${result?.stdout} / ${result?.stderr}`);
  });
});

