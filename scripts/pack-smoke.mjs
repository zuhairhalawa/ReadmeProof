/*
 * Pack the package, install the tarball into a FRESH temporary project outside this repository,
 * and exercise the real installed executable. Also inspects the packaged file list for
 * unwanted or sensitive content.
 *
 * Usage: node scripts/pack-smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

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
  const untar = run('tar', ['-xzf', tarball, '-C', unpack]);
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
  const exec = (args, cwd = proj) => run(isWin ? `"${shim}"` : shim, args, { cwd, shell: isWin });

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

  /* 6. verify: depends on Docker. Expected outcome is derived from the environment, never assumed. */
  const image = 'node:22-bookworm-slim';
  const dockerUp = run('docker', ['version', '--format', '{{.Server.Os}}']).code === 0;
  const imageThere = dockerUp && run('docker', ['image', 'inspect', image]).code === 0;
  const ver = exec(['verify', 'README.md', '--block', 'quickstart', '--json'], good);
  let vj;
  try {
    vj = JSON.parse(ver.stdout);
  } catch {
    vj = undefined;
  }
  if (imageThere) {
    check('verify --block quickstart passes in a real container (Docker + image available)', ver.code === 0 && vj?.results?.[0]?.verification === 'asserted' && vj.results[0].executed === true, `${ver.code} ${ver.stdout.slice(0, 400)} ${ver.stderr}`);
  } else {
    check(`verify reports UNAVAILABLE with exit 3 and executes nothing (Docker ${dockerUp ? 'up but image missing' : 'not available'}; NO isolation verification happened)`, ver.code === 3 && vj?.verdict === 'UNAVAILABLE' && vj.summary.examplesExecuted === 0, `${ver.code} ${ver.stdout.slice(0, 400)} ${ver.stderr}`);
    console.log('NOTE  container execution through the packed executable was NOT exercised in this run.');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pack/install smoke checks passed');

