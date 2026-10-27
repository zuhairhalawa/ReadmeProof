/*
 * Pack the package, install the tarball into a FRESH temporary project outside this repository,
 * and exercise the real installed executable. Also inspects the packaged file list for
 * unwanted or sensitive content.
 *
 * Usage: node scripts/pack-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
/* READMEPROOF_DOCKER_TESTS=1 makes real-container verification of the INSTALLED executable mandatory: no skipping, no UNAVAILABLE. */
const requireDocker = process.env.READMEPROOF_DOCKER_TESTS === '1';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failures++;
}

function run(cmd, args, opts = {}) {
  const { shell: shellOpt, ...rest } = opts;
  const useShell = shellOpt ?? (isWin && cmd.replaceAll('"', '').endsWith('.cmd'));
  const base = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...rest };
  /* Windows .cmd shims need a shell; build one quoted command string (all arguments are fixed literals or temp paths). */
  const quote = (a) => (/[\s&|<>^]/.test(a) && !a.startsWith('"') ? `"${a}"` : a);
  const res = useShell ? spawnSync([cmd, ...args].map(quote).join(' '), { ...base, shell: true }) : spawnSync(cmd, args, base);
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'readmeproof-pack-')));
console.log(`work directory: ${work}`);
try {
  /* 1. pack */
  const packDir = path.join(work, 'pack');
  mkdirSync(packDir);
  const packed = run(npm, ['pack', '--json', '--pack-destination', packDir], { cwd: repo });
  check('npm pack succeeds', packed.code === 0, packed.stderr);
  if (packed.code !== 0) throw new Error('pack failed');
  const info = JSON.parse(packed.stdout)[0];
  const tarball = path.join(packDir, info.filename);
  console.log(`tarball: ${info.filename} (${info.size} bytes, ${info.entryCount} files, unpacked ${info.unpackedSize} bytes)`);

  /* 2. inspect the file list */
  const files = info.files.map((f) => f.path.split('\\').join('/'));
  const allowed = (f) => f.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md'].includes(f);
  const unexpected = files.filter((f) => !allowed(f));
  check('only dist/, README.md, LICENSE, SECURITY.md, CHANGELOG.md, package.json are packaged', unexpected.length === 0, unexpected.join(', '));
  const forbidden = files.filter((f) => /(^|\/)(\.env|\.git|\.npmrc|test|tests|scripts|src|fixtures|\.github|node_modules|\.test-build)(\/|$)|\.(map|tgz|log|pem|key)$|tsconfig|\.ts$/.test(f) && !f.endsWith('.d.ts'));
  check('no sources, tests, fixtures, configs, maps or key material are packaged', forbidden.length === 0, forbidden.join(', '));
  check('bin entry is packaged', files.includes('dist/bin.js'));
  check('type declarations are packaged', files.includes('dist/index.d.ts'));

  /* 3. scan packaged text for secrets and personal paths */
  const unpack = path.join(work, 'unpacked');
  mkdirSync(unpack);
  /* Relative paths only: GNU tar (e.g. Git for Windows) reads "C:" in an archive path as a remote host. */
  const untar = run('tar', ['-xzf', info.filename, '-C', path.relative(packDir, unpack)], { cwd: packDir });
  check('tarball can be extracted', untar.code === 0, untar.stderr);
  const patterns = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
    [/npm_[A-Za-z0-9]{30,}/, 'npm token'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
    [/sk-[A-Za-z0-9]{32,}/, 'API key'],
    [/_authToken\s*=\s*[A-Za-z0-9-_]{8,}/, 'npm auth token'],
    [new RegExp('(?<![A-Za-z0-9])' + os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '$&') + '(?![A-Za-z0-9])', 'i'), 'local username'],
    [/[A-Za-z]:[\\/]+Users[\\/]/, 'Windows user path'],
    [/\/home\/[a-z0-9_-]+\//i, 'POSIX home path'],
  ];
  const hits = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const text = readFileSync(p, 'utf8');
        for (const [re, label] of patterns) if (re.test(text)) hits.push(`${path.relative(unpack, p)}: ${label}`);
      }
    }
  })(unpack);
  check('no secrets, tokens or personal paths inside the package', hits.length === 0, hits.join('; '));

  /* 4. fresh project outside the repo + install */
  const proj = path.join(work, 'consumer');
  mkdirSync(proj);
  writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
  const install = run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], { cwd: proj });
  check('npm install of the tarball succeeds in a fresh project', install.code === 0, install.stderr);
  /* The installed executable is the shim npm created in node_modules/.bin, run from any working directory. */
  const shim = path.join(proj, 'node_modules', '.bin', isWin ? 'readmeproof.cmd' : 'readmeproof');
  check('installed bin shim exists', statSync(shim, { throwIfNoEntry: false }) !== undefined, shim);
  const exec = (args, cwd = proj, env) => run(isWin ? `"${shim}"` : shim, args, { cwd, shell: isWin, ...(env ? { env: { ...process.env, ...env } } : {}) });

  /* 5. run the real installed executable */
  const v = exec(['--version']);
  check(`readmeproof --version prints ${pkg.version}`, v.code === 0 && v.stdout.trim() === pkg.version, `${v.code} ${v.stdout} ${v.stderr}`);
  const h = exec(['--help']);
  check('readmeproof --help exits 0 and shows usage', h.code === 0 && h.stdout.includes('USAGE') && h.stdout.includes('verify'), h.stderr);

  const good = path.join(work, 'good-project');
  const broken = path.join(work, 'broken-project');
  cpSync(path.join(repo, 'test', 'fixtures', 'good-project'), good, { recursive: true });
  cpSync(path.join(repo, 'test', 'fixtures', 'broken-project'), broken, { recursive: true });
  mkdirSync(path.join(good, '.git'));
  mkdirSync(path.join(broken, '.git'));

  const c1 = exec(['check', 'README.md'], good);
  check('check (good project) exits 0 and says NOTHING VERIFIED', c1.code === 0 && c1.stdout.includes('NOTHING VERIFIED'), `${c1.code}\n${c1.stdout}${c1.stderr}`);
  const c2 = exec(['check', '.', '--json'], broken);
  let j;
  try {
    j = JSON.parse(c2.stdout);
  } catch {
    j = undefined;
  }
  check('check . --json (broken project) exits 1 with valid JSON', c2.code === 1 && j && j.verdict === 'FAIL' && j.schemaVersion === 1 && j.findings.some((f) => f.status === 'FAIL'), `${c2.code} ${c2.stdout.slice(0, 200)}`);
  const c3 = exec(['check', '.', '--json'], good);
  const j3 = JSON.parse(c3.stdout || '{}');
  check('check . --json (good project) reports NOTHING_VERIFIED, exit 0', c3.code === 0 && j3.verdict === 'NOTHING_VERIFIED' && j3.summary.examplesExecuted === 0);
  const l = exec(['list', 'README.md'], good);
  check('list exits 0 and shows named blocks', l.code === 0 && l.stdout.includes('name=quickstart'), l.stdout);
  const u = exec(['bogus']);
  check('unknown command exits 2', u.code === 2, `${u.code}`);
  const m = exec(['check', 'does-not-exist.md']);
  check('missing README exits 2', m.code === 2, `${m.code}`);

  /* 6. guarantees that must hold with or without Docker: reading never executes, and there is no host fallback */
  const hostile = path.join(work, 'hostile-project');
  mkdirSync(path.join(hostile, '.git'), { recursive: true });
  writeFileSync(path.join(hostile, 'README.md'), ['# Hostile', '', '<!-- readmeproof: name=evil -->', '```sh', 'touch HOST-EXECUTED.txt', '```', ''].join('\n'));
  const hostExecuted = () => existsSync(path.join(hostile, 'HOST-EXECUTED.txt'));
  const hc = exec(['check', 'README.md'], hostile);
  const hl = exec(['list', 'README.md'], hostile);
  check('check and list never execute README commands (installed executable)', (hc.code === 0 || hc.code === 1) && hl.code === 0 && !hostExecuted(), `${hc.code} ${hl.code}\n${hc.stderr}${hl.stderr}`);
  const nf = exec(['verify', 'README.md', '--json'], hostile, { READMEPROOF_DOCKER: path.join(work, 'no-such-docker-binary') });
  let nfj;
  try {
    nfj = JSON.parse(nf.stdout);
  } catch {
    nfj = undefined;
  }
  check('verify without a usable docker exits 3 UNAVAILABLE and does NOT fall back to the host', nf.code === 3 && nfj?.verdict === 'UNAVAILABLE' && nfj.summary.examplesExecuted === 0 && !hostExecuted(), `${nf.code} ${nf.stdout.slice(0, 300)} ${nf.stderr}`);

  /* 7. real containers through the INSTALLED executable. Mandatory when READMEPROOF_DOCKER_TESTS=1. */
  const image = 'node:22-bookworm-slim';
  const dockerOs = run('docker', ['version', '--format', '{{.Server.Os}}']);
  const dockerUp = dockerOs.code === 0 && dockerOs.stdout.trim() === 'linux';
  let imageThere = dockerUp && run('docker', ['image', 'inspect', image]).code === 0;
  if (dockerUp && !imageThere && requireDocker) {
    console.log(`pulling ${image} (READMEPROOF_DOCKER_TESTS=1)`);
    imageThere = run('docker', ['pull', '--quiet', image]).code === 0;
  }
  if (requireDocker) {
    check('READMEPROOF_DOCKER_TESTS=1: a Linux Docker daemon and the image are available (skipping is not allowed)', dockerUp && imageThere, `docker up: ${dockerUp}, image present: ${imageThere}`);
  }
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  if (dockerUp && imageThere) {
    const daemonTime = () => new Date(run('docker', ['info', '--format', '{{.SystemTime}}']).stdout.trim());
    const leftover = () => run('docker', ['ps', '-a', '-q', '--filter', 'label=readmeproof=1']).stdout.trim();
    const t0 = new Date(daemonTime().getTime() - 1000);
    let expectedStarts = 0;

    /* 7a. the documented quickstart example */
    const ver = exec(['verify', 'README.md', '--block', 'quickstart', '--json'], good);
    expectedStarts += 1;
    const vj = parseJson(ver.stdout);
    check('verify --block quickstart passes in a real container', ver.code === 0 && vj?.verdict === 'PASS' && vj.results[0].verification === 'asserted' && vj.results[0].executed === true, `${ver.code} ${ver.stdout.slice(0, 400)} ${ver.stderr}`);

    /* 7b. isolation probes executed by the installed CLI, with host secrets planted in env and in the project */
    const canary = 'smoke-canary-secret-value';
    const sec = path.join(work, 'security-project');
    mkdirSync(path.join(sec, '.git'), { recursive: true });
    mkdirSync(path.join(sec, '.ssh'), { recursive: true });
    for (const [f, c] of [['.env', `TOKEN=${canary}\n`], ['.npmrc', `//registry/:_authToken=${canary}\n`], ['id_rsa', canary], ['.ssh/id_rsa', canary], ['.git/config', canary], ['keep.txt', 'original\n']]) {
      writeFileSync(path.join(sec, f), c);
    }
    const probes = [
      ['name=uid output-exact="1000"', 'id -u'],
      ['name=network output-exact="lo"', 'ls /sys/class/net'],
      ['name=rootfs output-exact="ROOTFS-READONLY"', 'touch /var/tmp/probe 2>/dev/null && echo ROOTFS-WRITABLE || echo ROOTFS-READONLY'],
      ['name=capabilities output-exact="CapBnd:0000000000000000"', "grep -E '^CapBnd' /proc/self/status | tr -d '[:space:]'"],
      ['name=nonewprivs output-exact="NoNewPrivs:1"', "grep -E '^NoNewPrivs' /proc/self/status | tr -d '[:space:]'"],
      ['name=nosocket output-exact="NO-SOCKET"', 'test -e /var/run/docker.sock && echo SOCKET || echo NO-SOCKET'],
      ['name=nosecretenv output-exact="0"', "env | grep -c 'smoke-canary-secret-[v]alue' || true"],
      ['name=nosecretfiles output-exact="checked"', 'for f in .env .npmrc id_rsa .git .ssh; do [ -e "$f" ] && echo "LEAK:$f"; done; echo checked'],
      ['name=writesstay exit=0 creates=created-in-container.txt', 'echo changed > keep.txt; echo new > created-in-container.txt'],
    ];
    writeFileSync(path.join(sec, 'README.md'), '# Isolation probes\n\n' + probes.map(([a, code]) => `<!-- readmeproof: ${a} -->\n\`\`\`sh\n${code}\n\`\`\`\n`).join('\n'));
    const secEnv = { GITHUB_TOKEN: canary, NPM_TOKEN: canary, READMEPROOF_SMOKE_SECRET: canary };
    const sv = exec(['verify', 'README.md', '--json'], sec, secEnv);
    expectedStarts += probes.length;
    const sj = parseJson(sv.stdout);
    const notPassed = (sj?.results ?? []).filter((r) => !(r.status === 'PASS' && r.verification === 'asserted' && r.executed === true)).map((r) => `${r.name}: ${r.status} ${r.reason}`);
    check(`all ${probes.length} isolation probes (non-root, no network, read-only rootfs, no caps, no-new-privs, no socket, no env secrets, no secret files, writes stay in the container) pass via the installed CLI`, sv.code === 0 && sj?.verdict === 'PASS' && sj.results.length === probes.length && notPassed.length === 0, `${sv.code} ${notPassed.join('; ')} ${sv.stderr}`);
    check('the host project is untouched by the container (no new files, files unchanged)', readFileSync(path.join(sec, 'keep.txt'), 'utf8') === 'original\n' && !existsSync(path.join(sec, 'created-in-container.txt')));

    /* 7c. failure and time-limit handling through the installed CLI */
    const bad = path.join(work, 'failing-project');
    mkdirSync(path.join(bad, '.git'), { recursive: true });
    writeFileSync(path.join(bad, 'README.md'), '# Failing\n\n<!-- readmeproof: name=bad exit=0 -->\n```sh\nexit 3\n```\n\n<!-- readmeproof: name=slow -->\n```sh\nsleep 30\n```\n');
    const bv = exec(['verify', 'README.md', '--block', 'bad', '--json'], bad);
    expectedStarts += 1;
    const bj = parseJson(bv.stdout);
    check('a failing example exits 1 with verdict FAIL and its real exit code', bv.code === 1 && bj?.verdict === 'FAIL' && bj.results[0].exitCode === 3, `${bv.code} ${bv.stdout.slice(0, 300)}`);
    const sl = exec(['verify', 'README.md', '--block', 'slow', '--timeout', '3', '--json'], bad);
    expectedStarts += 1;
    const slj = parseJson(sl.stdout);
    check('an example exceeding --timeout is killed: exit 1, timedOut', sl.code === 1 && slj?.results?.[0]?.timedOut === true, `${sl.code} ${sl.stdout.slice(0, 300)}`);

    /* 7d. evidence from the daemon itself, and cleanup */
    const t1 = daemonTime();
    const ev = run('docker', ['events', '--since', t0.toISOString(), '--until', t1.toISOString(), '--filter', 'type=container', '--filter', 'event=start', '--filter', 'label=readmeproof=1', '--format', '{{.Actor.ID}}']);
    const started = new Set(ev.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).size;
    check(`the Docker daemon recorded ${started} readmeproof container starts caused by the installed executable (expected at least ${expectedStarts})`, ev.code === 0 && started >= expectedStarts, ev.stderr);
    check('no readmeproof container is left behind after normal, failing and timed-out runs', leftover() === '', leftover());
    console.log(`REAL CONTAINER VERIFICATION OF THE INSTALLED EXECUTABLE: executed (${started} containers)`);
  } else {
    const ver = exec(['verify', 'README.md', '--block', 'quickstart', '--json'], good);
    const vj = parseJson(ver.stdout);
    check(`verify reports UNAVAILABLE with exit 3 and executes nothing (Docker ${dockerUp ? 'up but image missing' : 'not available'}; NO isolation verification happened)`, ver.code === 3 && vj?.verdict === 'UNAVAILABLE' && vj.summary.examplesExecuted === 0, `${ver.code} ${ver.stdout.slice(0, 400)} ${ver.stderr}`);
    console.log('NOTE  real container execution through the packed executable was NOT exercised in this run (set READMEPROOF_DOCKER_TESTS=1 on a machine with Docker to require it).');
  }} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pack/install smoke checks passed');

