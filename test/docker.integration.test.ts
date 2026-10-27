import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
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
 * REAL DOCKER integration tests. Every test here starts actual containers on a real daemon and verifies
 * the isolation guarantees from INSIDE the container (and, where useful, from the daemon via docker inspect).
 * Nothing in this file uses FakeDocker; the simulated orchestration tests live in docker.simulated.test.ts.
 *
 * When Docker is not available these tests are SKIPPED and say so loudly. A skipped run is NOT evidence that
 * isolation works. READMEPROOF_DOCKER_TESTS=1 turns "Docker unavailable" into a hard failure (used in CI) and
 * lets the tests pull the image. `npm run test:docker` additionally proves that the tests really executed
 * (see scripts/docker-proof.mjs).
 */
const SUITE = 'REAL DOCKER integration (actual containers)';
const REQUIRED = process.env['READMEPROOF_DOCKER_TESTS'] === '1';
const IMAGE = process.env['READMEPROOF_TEST_IMAGE'] ?? DEFAULT_IMAGE;
const runtime: DockerRuntime = createDockerRuntime(process.env['READMEPROOF_DOCKER'] || 'docker', process.env);
const SMALL = { timeoutMs: 30000, maxCaptureBytes: 1024 * 1024, killOutputBytes: 8 * 1024 * 1024 };

let skipReason: string | undefined;
let volumesBefore: string[] = [];

async function docker(args: string[]): Promise<string> {
  const r = await runtime.exec(args, SMALL);
  assert.equal(r.exitCode, 0, `docker ${args.join(' ')} failed: ${r.stderr.text}`);
  return r.stdout.text;
}

async function lines(args: string[]): Promise<string[]> {
  return (await docker(args)).split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** Ids of ALL readmeproof containers, running or stopped. */
function leftoverContainers(): Promise<string[]> {
  return lines(['ps', '-a', '-q', '--filter', 'label=readmeproof=1']);
}

/** Waits for a running readmeproof container to appear and returns its id. */
async function waitForRunningContainer(): Promise<string> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ids = await lines(['ps', '-q', '--filter', 'label=readmeproof=1']);
    if (ids[0] !== undefined) return ids[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no running readmeproof container appeared within 30 seconds');
}

/** Files that must never be copied into a container (names only; every one contains the canary). */
const SECRET_FILES = [
  '.env', '.env.local', '.env.production', '.ENV', '.Env.Staging', 'prod.env', 'sub/dir/.env', '.envrc',
  '.npmrc', 'sub/.npmrc', '.yarnrc.yml', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.git/config', '.git/HEAD',
  '.ssh/id_rsa', '.ssh/config', 'id_rsa', 'ID_RSA', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa.pub',
  'server.pem', 'tls.key', 'cert.p12', 'a.pfx', 'store.jks', 'x.keystore', 'vault.kdbx', 'putty.ppk', 'AuthKey_X.p8',
  'x.pkcs12', 'x.jceks', 'secret.gpg', '.gnupg/secring.gpg',
  'tf/prod.tfvars', 'tf/prod.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup', '.terraform/terraform.tfstate',
  '.aws/credentials', '.aws/config', '.docker/config.json', '.dockerconfigjson', '.kube/config', 'kubeconfig',
  '.azure/accessTokens.json', '.config/gh/hosts.yml', '.gem/credentials', '.m2/settings.xml',
  'credentials', 'credentials.json', 'credentials.toml', 'secrets.json', 'secrets.yml', 'secrets.yaml',
  'my-service-account-prod.json', '.vault-token', '.htpasswd', '.pgpass', '.my.cnf', '.s3cfg', '.boto', '.authinfo',
  '.bash_history', '.zsh_history', '.psql_history', 'node_modules/pkg/index.js', '.svn/entries', '.hg/hgrc',
];

/** Ordinary files that MUST be copied (proves the listing in the container is real and not empty). */
const KEEP_FILES = ['README.md', 'keep.txt', '.env.example', '.env.sample', '.env.template', '.gitignore', 'src/app.js', 'keys.md', 'environment.ts'];

describe(SUITE, () => {
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
      return;
    }
    volumesBefore = await lines(['volume', 'ls', '-q']);
  });

  /* Cleanup is verified after EVERY test, not only after the timeout test. */
  afterEach(async () => {
    if (skipReason) return;
    assert.deepEqual(await leftoverContainers(), [], 'a readmeproof container was left behind');
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
    return { dir, readme, result: report.results[0], report };
  }

  const test = (name: string, fn: () => Promise<void>) =>
    it(name, async (t) => {
      if (skipReason) {
        t.skip(skipReason);
        return;
      }
      await fn();
    });

  test('runs a block in a real container and checks declared assertions', async () => {
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

  test('has no network by default (no interface but loopback, connections fail)', async () => {
    const code = [
      "node -e \"const s=require('net').connect({host:'1.1.1.1',port:53,timeout:4000});",
      "s.on('connect',()=>{console.log('CONNECTED');process.exit(1)});",
      "s.on('error',()=>{console.log('NO-NETWORK');process.exit(0)});",
      "s.on('timeout',()=>{console.log('NO-NETWORK');process.exit(0)})\"",
    ].join('');
    const { result } = await runBlock(code, '<!-- readmeproof: output="NO-NETWORK" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.ok(!result?.stdout?.includes('CONNECTED'));
    const ifaces = await runBlock('ls /sys/class/net', '<!-- readmeproof: output-exact="lo" -->');
    assert.equal(ifaces.result?.status, 'PASS', JSON.stringify(ifaces.result));
  });

  test('has a read-only root filesystem and no capabilities', async () => {
    /* /var/tmp is world-writable on the image's root filesystem, so only --read-only (not file permissions) stops the write.
       CapBnd (the bounding set) is only empty with --cap-drop ALL; CapEff is empty for any non-root process anyway. */
    const code = 'touch /var/tmp/readmeproof-test 2>/dev/null && echo ROOTFS-WRITABLE || echo ROOTFS-READONLY; touch /tmp/ok-tmp && echo TMP-WRITABLE; touch /work/ok-work && echo WORK-WRITABLE; grep -E "^Cap(Eff|Prm|Bnd|Amb)" /proc/self/status';
    const { result } = await runBlock(code, '<!-- readmeproof: output="ROOTFS-READONLY" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const out = result?.stdout ?? '';
    assert.ok(!out.includes('ROOTFS-WRITABLE'), out);
    assert.ok(out.includes('TMP-WRITABLE') && out.includes('WORK-WRITABLE'), `scratch tmpfs areas must stay writable: ${out}`);
    for (const cap of ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']) assert.match(out, new RegExp(`${cap}:\\s+0000000000000000`), `${cap} must be empty: ${out}`);
  });

  test('cannot gain privileges (no-new-privileges)', async () => {
    const { result } = await runBlock('grep -E "^NoNewPrivs" /proc/self/status', '<!-- readmeproof: output="NoNewPrivs:\t1" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
  });

  test('privileged operations are denied (mount, chown, clock, sysctl)', async () => {
    const code = [
      'mount -t tmpfs tmpfs /mnt >/dev/null 2>&1 && echo MOUNT-ALLOWED || echo MOUNT-DENIED',
      'chown root:root /work >/dev/null 2>&1 && echo CHOWN-ALLOWED || echo CHOWN-DENIED',
      "date -s '2001-01-01' >/dev/null 2>&1 && echo CLOCK-ALLOWED || echo CLOCK-DENIED",
      'echo 1 > /proc/sys/kernel/hostname 2>/dev/null && echo SYSCTL-ALLOWED || echo SYSCTL-DENIED',
    ].join('\n');
    const { result } = await runBlock(code, '<!-- readmeproof: output="MOUNT-DENIED" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const out = result?.stdout ?? '';
    for (const denied of ['MOUNT-DENIED', 'CHOWN-DENIED', 'CLOCK-DENIED', 'SYSCTL-DENIED']) assert.ok(out.includes(denied), `${denied} missing in ${out}`);
    assert.ok(!out.includes('ALLOWED'), out);
  });

  test('has no docker socket and no host mounts', async () => {
    const { result, dir } = await runBlock('test -e /var/run/docker.sock && echo SOCKET || echo NO-SOCKET; cat /proc/mounts', '<!-- readmeproof: output="NO-SOCKET" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const mounts = result?.stdout ?? '';
    assert.ok(!mounts.includes(dir), 'host project path must not appear in mounts');
    assert.ok(!/docker\.sock/.test(mounts));
    assert.ok(!/\/(Users|home)\//.test(mounts.replace(/\/home\/node/g, '')), 'no host home mounts');
  });

  test('the live container has the expected hardened configuration (docker inspect)', async () => {
    const canary = { READMEPROOF_FAKE_SECRET: 'host-secret-value', GITHUB_TOKEN: 'host-secret-value', NPM_TOKEN: 'host-secret-value' };
    Object.assign(process.env, canary);
    try {
      const settings = { ...DEFAULT_SETTINGS, image: IMAGE, memoryMb: 256, cpus: 0.5, pidsLimit: 64 };
      const pending = runBlock('sleep 6', '', {}, { settings });
      const id = await waitForRunningContainer();
      const info = (JSON.parse(await docker(['inspect', id])) as Array<Record<string, any>>)[0] as Record<string, any>;
      await pending;
      const host = info['HostConfig'] as Record<string, any>;
      const config = info['Config'] as Record<string, any>;
      assert.equal(host['Privileged'], false);
      assert.equal(host['NetworkMode'], 'none');
      assert.equal(host['ReadonlyRootfs'], true);
      assert.equal(host['AutoRemove'], true);
      assert.deepEqual(host['CapDrop'], ['ALL']);
      assert.ok(!host['CapAdd'] || host['CapAdd'].length === 0, 'no capabilities may be added');
      assert.ok((host['SecurityOpt'] as string[]).some((s) => s.startsWith('no-new-privileges')));
      assert.ok(!(host['SecurityOpt'] as string[]).some((s) => /unconfined/.test(s)));
      assert.equal(config['User'], '1000:1000');
      assert.equal(host['Memory'], 256 * 1024 * 1024);
      assert.equal(host['MemorySwap'], 256 * 1024 * 1024);
      assert.equal(host['NanoCpus'], 500_000_000);
      assert.equal(host['PidsLimit'], 64);
      assert.ok(!host['Binds'] || host['Binds'].length === 0, 'no bind mounts');
      assert.ok(!host['Devices'] || host['Devices'].length === 0, 'no devices');
      assert.ok(!host['PidMode'], 'no shared pid namespace');
      assert.notEqual(host['IpcMode'], 'host');
      assert.ok(!host['UsernsMode']);
      for (const m of info['Mounts'] as Array<Record<string, string>>) {
        assert.equal(m['Type'], 'tmpfs', `only tmpfs mounts are allowed, found ${m['Type']} ${m['Source']}`);
        assert.ok(!/docker\.sock/.test(m['Destination'] ?? ''));
      }
      assert.equal(config['Labels']['readmeproof'], '1');
      const env = (config['Env'] as string[]).join('\n');
      assert.ok(!env.includes('host-secret-value'));
      assert.ok(!/FAKE_SECRET|GITHUB_TOKEN|NPM_TOKEN/.test(env));
    } finally {
      for (const k of Object.keys(canary)) delete process.env[k];
    }
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

  test('copies only sanitized project contents (wide secret-file matrix, canary content never arrives)', async () => {
    const canary = 'rp-canary-7f3a';
    const files: Record<string, string> = {};
    for (const f of SECRET_FILES) files[f] = `${canary} ${f}\n`;
    for (const f of KEEP_FILES.filter((k) => k !== 'README.md')) files[f] = 'ordinary content\n';
    const outsideDir = makeTempDir();
    writeTree(outsideDir, { 'host-secret.txt': `${canary} outside the project\n`, 'inner/more.txt': `${canary} inner\n` });
    const dir = makeTempDir();
    writeTree(dir, files);
    let linked = false;
    try {
      symlinkSync(path.join(outsideDir, 'host-secret.txt'), path.join(dir, 'leak-link.txt'), 'file');
      symlinkSync(outsideDir, path.join(dir, 'leak-dir'), 'junction');
      linked = true;
    } catch {
      /* symlinks need privileges on Windows; the planted outside canary is still checked below */
    }
    /* The pattern is written with a bracket so the README text itself never contains the canary. */
    const code = "find . -type f | sort; echo ---; grep -rl 'rp-canary-7f[3]a' . || echo NO-CANARY; echo ---; grep -rl 'outside the proj[e]ct' . || echo NO-HOST-FILE";
    const readme = `<!-- readmeproof: exit=0 output="NO-CANARY" -->\n\`\`\`sh\n${code}\n\`\`\`\n`;
    writeTree(dir, { 'README.md': readme });
    const doc = parseMarkdown(readme, 'README.md');
    const project: Project = { readmeAbs: path.join(dir, 'README.md'), readmeDisplay: 'README.md', readmeDir: dir, boundary: dir, projectDir: dir, pkg: undefined, rootWasOverridden: true };
    const report = await verifyBlocks({ doc, project, runtime, settings: { ...DEFAULT_SETTINGS, image: IMAGE }, timeoutSec: 60, maxOutputBytes: 256 * 1024, pull: false });
    const result = report.results[0];
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    const out = result?.stdout ?? '';
    const [listing = '', canaryPart = '', hostPart = ''] = out.split('---\n');
    const copied = listing.split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter((l) => l !== '').sort();
    assert.deepEqual(copied, [...KEEP_FILES].sort(), `unexpected set of files in the container:\n${listing}`);
    assert.match(canaryPart, /NO-CANARY/, 'a canary secret reached the container');
    assert.match(hostPart, /NO-HOST-FILE/, 'a file outside the project reached the container');
    for (const f of SECRET_FILES) assert.ok(!copied.includes(f), `${f} was copied`);
    assert.ok(report.execution.workspace && report.execution.workspace.skipped >= SECRET_FILES.length - 5, 'excluded files must be reported as skipped');
    if (linked) assert.ok(!copied.some((c) => c.startsWith('leak-')), 'symlinks must never be copied');
  });

  test('cannot modify the host project (workspace is a throwaway copy)', async () => {
    const { result, dir, readme } = await runBlock('echo tampered > README.md; echo created > new-file.txt; cat README.md', '<!-- readmeproof: exit=0 creates=new-file.txt output-exact="tampered" -->');
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    /* Inside the container the copy really was overwritten ... */
    assert.equal(result?.stdout?.trim(), 'tampered');
    /* ... while the host files are byte-for-byte untouched and nothing new appeared. */
    assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), readme);
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
    assert.deepEqual(await leftoverContainers(), [], 'no readmeproof container may remain after a timeout');
  });

  test('removes the container after normal completion, a failing exit and runaway output', async () => {
    /* Witness: the leftover check must be able to see a live container, otherwise "empty" proves nothing. */
    const pending = runBlock('sleep 4');
    const id = await waitForRunningContainer();
    assert.ok((await leftoverContainers()).includes(id), 'the cleanup check cannot see a running container');
    const normal = await pending;
    assert.equal(normal.result?.status, 'PASS', JSON.stringify(normal.result));
    assert.deepEqual(await leftoverContainers(), [], 'container left behind after a normal exit');
    assert.ok(!(await lines(['ps', '-a', '-q', '--no-trunc'])).some((c) => c.startsWith(id)), 'the exact container id must be gone');

    const failing = await runBlock('exit 9');
    assert.equal(failing.result?.status, 'FAIL');
    assert.deepEqual(await leftoverContainers(), [], 'container left behind after a failing exit');

    const flood = await runBlock('yes readmeproof-flood', '', {}, { maxOutputBytes: 2048 });
    assert.equal(flood.result?.status, 'FAIL');
    assert.match(flood.result?.reason ?? '', /runaway output/);
    assert.deepEqual(await leftoverContainers(), [], 'container left behind after runaway output was killed');
  });

  test('bounds captured output', async () => {
    const { result } = await runBlock('head -c 3000000 /dev/zero | tr "\\0" "x"', '', {}, { maxOutputBytes: 2048 });
    assert.ok((result?.stdout?.length ?? 0) <= 2048);
    assert.equal(result?.stdoutTruncated, true);
  });

  test('enforces the memory limit with a kernel OOM kill (not just any non-zero exit)', async () => {
    /* The allocating child must be killed by the cgroup OOM killer: exit 137 AND oom_kill >= 1 in the container's own cgroup. */
    /* cgroup v2 (current Linux, GitHub runners) and cgroup v1 (older kernels, some Docker Desktop VMs) are both real
       kernel enforcement; the block reads whichever layout the daemon uses and prints the same normalised lines. */
    const code = [
      'if [ -f /sys/fs/cgroup/memory.max ]; then',
      '  mem_max=$(cat /sys/fs/cgroup/memory.max); swap_max=$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo n/a)',
      "  oom() { awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events; }",
      'else',
      '  mem_max=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes); swap_max=$(cat /sys/fs/cgroup/memory/memory.memsw.limit_in_bytes 2>/dev/null || echo n/a)',
      "  oom() { awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory/memory.oom_control; }",
      'fi',
      'echo "memory_max=$mem_max"',
      'echo "swap_max=$swap_max"',
      'node -e "const a=[];for(;;)a.push(Buffer.alloc(16*1024*1024,1))"',
      'echo "child_exit=$?"',
      'echo "oom_kills=$(oom)"',
    ].join('\n');
    const { result } = await runBlock(code, '', {}, { settings: { ...DEFAULT_SETTINGS, image: IMAGE, memoryMb: 128 } });
    const out = result?.stdout ?? '';
    assert.equal(result?.status, 'PASS', `the wrapper itself must survive the OOM kill: ${JSON.stringify(result)}`);
    assert.match(out, /memory_max=134217728\n/, out);
    /* swap disabled: v2 reports 0, v1 reports memsw == the memory limit; "n/a" only when the kernel has no swap accounting */
    assert.match(out, /swap_max=(0|134217728|n\/a)\n/, out);
    assert.match(out, /child_exit=137\n/, `the allocating process must die from SIGKILL: ${out}`);
    const kills = Number(/oom_kills=(\d+)/.exec(out)?.[1] ?? '0');
    assert.ok(kills >= 1, `the kernel must record an OOM kill in the container cgroup: ${out}`);
  });

  test('enforces the CPU limit (measured CPU time stays near the quota)', async () => {
    /* Two busy loops for 4 seconds under --cpus 0.5. Unlimited they would use ~2 CPUs (or 1 on a single-core host). */
    const code = [
      'if [ -f /sys/fs/cgroup/cpu.max ]; then',
      '  quota=$(cat /sys/fs/cgroup/cpu.max)',
      "  usage() { awk '/^usage_usec/ {print $2}' /sys/fs/cgroup/cpu.stat; }",
      "  throttled() { awk '/^nr_throttled /{print $2}' /sys/fs/cgroup/cpu.stat; }",
      'else',
      '  quota="$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"',
      '  usage() { echo $(( $(cat /sys/fs/cgroup/cpuacct/cpuacct.usage) / 1000 )); }',
      "  throttled() { awk '/^nr_throttled /{print $2}' /sys/fs/cgroup/cpu/cpu.stat; }",
      'fi',
      'echo "$quota"',
      'u0=$(usage)',
      't0=$(date +%s%N)',
      "sh -c 'while :; do :; done' & p1=$!",
      "sh -c 'while :; do :; done' & p2=$!",
      'sleep 4',
      'u1=$(usage)',
      't1=$(date +%s%N)',
      'kill $p1 $p2',
      'echo "cpu_usec=$((u1-u0)) wall_usec=$(((t1-t0)/1000))"',
      'echo "throttled=$(throttled)"',
    ].join('\n');
    const { result } = await runBlock(code, '', {}, { settings: { ...DEFAULT_SETTINGS, image: IMAGE, cpus: 0.5 } });
    const out = result?.stdout ?? '';
    assert.equal(result?.status, 'PASS', JSON.stringify(result));
    assert.match(out, /^50000 100000$/m, `cpu.max must encode 0.5 CPU: ${out}`);
    const m = /cpu_usec=(\d+) wall_usec=(\d+)/.exec(out);
    assert.ok(m, `no measurement in ${out}`);
    const ratio = Number(m?.[1]) / Number(m?.[2]);
    assert.ok(ratio > 0.2, `the busy loops should have consumed CPU (ratio ${ratio.toFixed(2)})`);
    assert.ok(ratio < 0.7, `CPU use must be throttled to about 0.5 CPU, measured ${ratio.toFixed(2)}`);
    assert.ok(Number(/throttled=(\d+)/.exec(out)?.[1] ?? '0') > 0, `the kernel must report throttling: ${out}`);
  });

  test('enforces the PID limit (fork bomb is contained)', async () => {
    const code = 'ok=0; fail=0; i=0; while [ $i -lt 120 ]; do if (sleep 3 &) 2>/dev/null; then ok=$((ok+1)); else fail=$((fail+1)); fi; i=$((i+1)); done; echo "ok=$ok fail=$fail"';
    const { result } = await runBlock(code, '', {}, { settings: { ...DEFAULT_SETTINGS, image: IMAGE, pidsLimit: 24 } });
    assert.match(result?.stdout ?? '', /fail=[1-9][0-9]*/, `expected forks to be refused, got ${result?.stdout} / ${result?.stderr}`);
  });

  test('leaves no containers or dangling volumes behind after the whole suite', async () => {
    assert.deepEqual(await leftoverContainers(), []);
    const dangling = await lines(['volume', 'ls', '-q', '--filter', 'dangling=true']);
    assert.deepEqual(dangling.filter((v) => !volumesBefore.includes(v)), [], 'new dangling volumes appeared');
  });
});