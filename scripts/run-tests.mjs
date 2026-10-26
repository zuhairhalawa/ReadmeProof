import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* Runs compiled tests with the built-in node:test runner. Test files are passed
   explicitly so behaviour is identical on Node 20, 22 and 24 (glob semantics differ). */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, '.test-build', 'test');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = walk(testDir).sort();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}
const compact = process.argv.includes('--compact');
if (compact) {
  /* Compact mode: show only failing test names and the summary counters. */
  const out = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const text = (out.stdout ?? '') + (out.stderr ?? '');
  const failMark = String.fromCharCode(0x2716);
  const infoMark = String.fromCharCode(0x2139);
  const counters = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const lines = text.split('\n').filter((l) => {
    const t = l.trimStart();
    return t.startsWith(failMark) || t.startsWith('not ok') || counters.some((c) => l.startsWith(`${infoMark} ${c} `)) || l.includes('SKIPPED');
  });
  console.log(lines.join('\n'));
  process.exit(out.status ?? 1);
}
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(res.status ?? 1);
