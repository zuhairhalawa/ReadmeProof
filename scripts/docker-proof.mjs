/*
 * Strict proof that the REAL Docker integration tests executed.
 *
 * A green test run is not enough: the integration tests skip themselves when Docker is unavailable. This script
 * fails unless ALL of the following hold, using evidence that does not come from the tests' own assertions:
 *
 *   1. a Linux Docker daemon answers (docker info);
 *   2. every test declared in test/docker.integration.test.ts ran and passed (TAP report): none skipped, todo,
 *      cancelled or failed, and the executed names equal the declared names;
 *   3. the daemon's own event log shows readmeproof-labelled containers were actually started during the run
 *      (at least one per executed test);
 *   4. no readmeproof container is left behind afterwards.
 *
 * Usage (after compiling tests; `npm run test:docker` does both): node scripts/docker-proof.mjs
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = 'REAL DOCKER integration (actual containers)';
const MIN_TESTS = 20; /* guards against someone silently deleting tests */
const compiled = join(root, '.test-build', 'test', 'docker.integration.test.js');
const sourcePath = join(root, 'test', 'docker.integration.test.ts');
const docker = process.env.READMEPROOF_DOCKER || 'docker';

const problems = [];
const fail = (m) => problems.push(m);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: root, ...opts });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/* 1. daemon */
const info = run(docker, ['info', '--format', '{{json .}}']);
if (info.code !== 0) {
  console.error(`DOCKER PROOF FAILED: the Docker daemon is not reachable: ${info.stderr.trim().split('\n')[0] || info.error?.message}`);
  process.exit(1);
}
const daemon = JSON.parse(info.stdout);
if (daemon.OSType !== 'linux') fail(`daemon OSType is "${daemon.OSType}", expected linux`);
const startTime = new Date(new Date(daemon.SystemTime).getTime() - 1000).toISOString();
console.log(`daemon: Docker ${daemon.ServerVersion}, ${daemon.OSType}, cgroup v${daemon.CgroupVersion}, kernel ${daemon.KernelVersion}`);

/* 2. declared tests */
const source = readFileSync(sourcePath, 'utf8');
const declared = [...source.matchAll(/^\s*test\('((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1]);
if (declared.length < MIN_TESTS) fail(`only ${declared.length} real Docker tests are declared; at least ${MIN_TESTS} are required`);
if (new Set(declared).size !== declared.length) fail('duplicate test names in the integration file');

/* run them */
const tests = run(process.execPath, ['--test', '--test-reporter=tap', compiled], { env: { ...process.env, READMEPROOF_DOCKER_TESTS: '1' } });
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
if (tests.code !== 0) fail(`the integration test run exited with code ${tests.code}`);

const results = [];
for (const line of tests.stdout.split('\n')) {
  const m = /^(\s*)(not ok|ok) \d+ - (.*)$/.exec(line);
  if (!m) continue;
  const [, indent, status, rest] = m;
  const directive = /\s#\s*(SKIP|TODO|cancelled|CANCELLED)\b/.exec(rest);
  const name = rest.replace(/\s#\s.*$/, '').trim();
  results.push({ nested: indent.length > 0, ok: status === 'ok', directive: directive?.[1], name });
}
const suite = results.find((r) => !r.nested && r.name === SUITE);
if (!suite) fail(`suite "${SUITE}" did not appear in the report`);
else if (!suite.ok) fail('the suite itself failed');
const executed = results.filter((r) => r.nested);
const notPassed = executed.filter((r) => !r.ok || r.directive);
for (const r of notPassed) fail(`test not passed: "${r.name}"${r.directive ? ` (${r.directive})` : ''}${r.ok ? '' : ' (failed)'}`);
const executedNames = new Set(executed.filter((r) => r.ok && !r.directive).map((r) => r.name));
for (const d of declared) if (!executedNames.has(d)) fail(`declared test did not execute and pass: "${d}"`);
for (const name of executedNames) if (!declared.includes(name)) fail(`unexpected test executed: "${name}"`);
if (/DOCKER INTEGRATION TESTS SKIPPED/.test(tests.stdout + tests.stderr)) fail('the tests reported that Docker integration tests were skipped');

/* 3. daemon-side evidence */
const endInfo = run(docker, ['info', '--format', '{{.SystemTime}}']);
const endTime = new Date(endInfo.stdout.trim()).toISOString();
const events = run(docker, ['events', '--since', startTime, '--until', endTime, '--filter', 'type=container', '--filter', 'event=start', '--filter', 'label=readmeproof=1', '--format', '{{.Actor.ID}}']);
const started = new Set(events.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).size;
if (events.code !== 0) fail(`docker events failed: ${events.stderr.trim()}`);
if (started < executedNames.size) fail(`the daemon recorded only ${started} readmeproof container starts for ${executedNames.size} executed tests`);

/* 4. cleanup */
const left = run(docker, ['ps', '-a', '-q', '--filter', 'label=readmeproof=1']).stdout.trim();
if (left) fail(`readmeproof containers were left behind: ${left.split('\n').join(', ')}`);

const summary = [
  `REAL DOCKER PROOF: ${problems.length === 0 ? 'PASSED' : 'FAILED'}`,
  `  daemon: Docker ${daemon.ServerVersion} (${daemon.OSType}, cgroup v${daemon.CgroupVersion})`,
  `  real tests declared: ${declared.length}; executed and passed: ${[...executedNames].filter((n) => declared.includes(n)).length}; skipped/todo/failed: ${notPassed.length}`,
  `  readmeproof containers started during the run (daemon event log): ${started}`,
  `  readmeproof containers left behind: ${left ? left.split('\n').length : 0}`,
];
console.log('\n' + summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + summary.join('\n') + '\n```\n');
if (problems.length > 0) {
  console.error('\n' + problems.map((p) => `PROBLEM: ${p}`).join('\n'));
  process.exit(1);
}