import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HELP } from '../src/cli.js';
import { getVersion } from '../src/version.js';
import { copyFixture, FakeDocker, makeTempDir, repoRoot, runCli, writeTree } from './helpers.js';

const pkgVersion = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

describe('cli basics', () => {
  it('prints the version', async () => {
    const r = await runCli(['--version'], process.cwd());
    assert.equal(r.stdout.trim(), pkgVersion);
    assert.equal(getVersion(), pkgVersion);
    assert.equal(r.code, 0);
    assert.equal((await runCli(['-V'], process.cwd())).stdout.trim(), pkgVersion);
  });

  it('prints help for --help and documents the important contracts', async () => {
    const r = await runCli(['--help'], process.cwd());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, HELP);
    for (const needle of ['check', 'list', 'verify', '--json', '--network', '--block', 'NOTHING VERIFIED', 'UNAVAILABLE', 'EXIT CODES', '<!-- readmeproof:', 'cannot enable the network']) {
      assert.ok(HELP.includes(needle), needle);
    }
  });

  it('shows help and exits 2 when called without a command', async () => {
    const r = await runCli([], process.cwd());
    assert.equal(r.code, 2);
    assert.ok(r.stdout.includes('USAGE'));
  });

  it('rejects unknown commands, unknown options and stray arguments with exit 2', async () => {
    const dir = copyFixture('good-project');
    for (const argv of [['frobnicate'], ['check', '--nope'], ['check', 'a', 'b'], ['check', '--block', 'x'], ['list', '--network'], ['check', '--timeout', '5'], ['verify', '--timeout', 'abc'], ['verify', '--timeout', '0'], ['verify', '--memory', '1'], ['verify', '--cpus', '99']]) {
      const r = await runCli(argv, dir);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.stderr, /^readmeproof: /);
    }
  });

  it('exits 2 for missing files and directories without a README', async () => {
    const empty = makeTempDir();
    assert.equal((await runCli(['check', 'nope.md'], empty)).code, 2);
    const r = await runCli(['check', '.'], empty);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no README/);
  });
});

describe('check command', () => {
  it('passes a good project but says NOTHING VERIFIED (exit 0)', async () => {
    const dir = copyFixture('good-project');
    const r = await runCli(['check', '.'], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /NOTHING VERIFIED: zero examples were executed/);
    assert.match(r.stdout, /Result: NOTHING VERIFIED/);
    assert.doesNotMatch(r.stdout, /Result: PASS/);
    assert.match(r.stdout, /external link\(s\) were not checked/);
  });

  it('fails a broken project with file:line, evidence and fixes (exit 1)', async () => {
    const dir = copyFixture('broken-project');
    const r = await runCli(['check', 'README.md'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /README\.md:5 {2}FAIL +broken-link {2}file not found: docs\/setup\.md/);
    assert.match(r.stdout, /evidence: link target: docs\/setup\.md/);
    assert.match(r.stdout, /fix: /);
    assert.match(r.stdout, /Result: FAIL \(exit code 1\)/);
  });

  it('emits stable JSON with a documented shape', async () => {
    const dir = copyFixture('broken-project');
    const a = await runCli(['check', '.', '--json'], dir);
    const b = await runCli(['check', '.', '--json'], dir);
    assert.equal(a.stdout, b.stdout, 'deterministic');
    assert.equal(a.stderr, '');
    const j = JSON.parse(a.stdout) as Record<string, any>;
    assert.deepEqual(Object.keys(j), ['schemaVersion', 'tool', 'command', 'file', 'projectRoot', 'verdict', 'exitCode', 'summary', 'notices', 'blocks', 'findings']);
    assert.equal(j['schemaVersion'], 1);
    assert.deepEqual(j['tool'], { name: '@zuhairhalawa/readmeproof', version: pkgVersion });
    assert.equal(j['command'], 'check');
    assert.equal(j['file'], 'README.md');
    assert.equal(j['verdict'], 'FAIL');
    assert.equal(j['exitCode'], 1);
    assert.equal(a.code, 1);
    const f = j['findings'][0];
    assert.deepEqual(Object.keys(f), ['id', 'rule', 'status', 'file', 'line', 'message', 'evidence', 'fix']);
    assert.ok(['PASS', 'FAIL', 'SKIP', 'UNVERIFIED'].includes(f.status));
    assert.equal(j['summary'].examplesExecuted, 0);
    assert.equal(j['summary'].findings.FAIL, 10);
  });

  it('JSON for a clean README reports NOTHING_VERIFIED with exit code 0', async () => {
    const r = await runCli(['check', '.', '--json'], copyFixture('good-project'));
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'NOTHING_VERIFIED');
    assert.equal(j.exitCode, 0);
    assert.equal(r.code, 0);
    assert.match(j.notices[0], /no README example was executed/);
  });

  it('lists PASS/SKIP and external links with --verbose', async () => {
    const dir = copyFixture('good-project');
    const quiet = await runCli(['check', '.'], dir);
    const loud = await runCli(['check', '.', '--verbose'], dir);
    assert.ok(loud.stdout.length > quiet.stdout.length);
    assert.match(loud.stdout, /PASS +link {2}asset exists: assets\/logo\.png/);
    assert.match(loud.stdout, /external-link/);
  });

  it('accepts a directory or file path from another working directory', async () => {
    const dir = copyFixture('good-project');
    const r = await runCli(['check', path.join(dir, 'README.md'), '--json'], makeTempDir());
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).projectRoot.endsWith('good-project'), true);
  });
});

describe('list command', () => {
  it('lists blocks with line ranges, annotations and never executes', async () => {
    const dir = copyFixture('good-project');
    const r = await runCli(['list', 'README.md'], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /README\.md:33-35 {2}sh {2}executable {2}name=quickstart {2}\[exit=0 output\]/);
    assert.match(r.stdout, /README\.md:53-55 {2}text {2}not executable/);
    assert.match(r.stdout, /6 code block\(s\): 5 executable, 1 not executable, 2 annotated, 2 named/);
    const j = JSON.parse((await runCli(['list', 'README.md', '--json'], dir)).stdout);
    assert.equal(j.command, 'list');
    assert.equal(j.blocks.length, 6);
    assert.deepEqual(j.blocks[2].annotation, { name: 'quickstart', exit: 0, output: 'hello from acme' });
    assert.equal(j.verdict, 'LISTED');
    assert.equal(j.blocks[5].executable, false);
  });
});

describe('SIMULATED (FakeDocker, no daemon): verify command', () => {
  it('runs a named block through the runtime and exits 0 on PASS', async () => {
    const dir = copyFixture('good-project');
    const docker = new FakeDocker({ run: () => ({ stdout: 'hello from acme\n' }) });
    const r = await runCli(['verify', 'README.md', '--block', 'quickstart'], dir, docker);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /README\.md:33 {2}PASS \(asserted\) +quickstart/);
    assert.match(r.stdout, /Executed examples: 1 {2}\| {2}PASS \(asserted\): 1 {2}\| {2}PASS \(smoke only\): 0/);
    assert.equal(docker.runs.length, 1);
  });

  it('exits 1 with evidence when an assertion fails', async () => {
    const dir = copyFixture('good-project');
    const docker = new FakeDocker({ run: () => ({ stdout: 'something else\n' }) });
    const r = await runCli(['verify', '.', '--block', 'quickstart'], dir, docker);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /output: expected hello from acme; actual something else/);
    assert.match(r.stdout, /stdout:\n {6}something else/);
  });

  it('exits 3 and says UNAVAILABLE when Docker is missing', async () => {
    const dir = copyFixture('good-project');
    const r = await runCli(['verify', 'README.md', '--block', 'quickstart', '--json'], dir, new FakeDocker({ cliMissing: true }));
    assert.equal(r.code, 3);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'UNAVAILABLE');
    assert.equal(j.execution.status, 'UNAVAILABLE');
    assert.equal(j.summary.examplesExecuted, 0);
    assert.equal(j.results[0].status, 'UNVERIFIED');
    const text = await runCli(['verify', 'README.md', '--block', 'quickstart'], dir, new FakeDocker({ cliMissing: true }));
    assert.match(text.stdout, /Result: UNAVAILABLE \(exit code 3\)/);
    assert.doesNotMatch(text.stdout, /README\.md:\d+ +PASS/);
    assert.match(text.stdout, /Executed examples: 0 /);
  });

  it('exits 4 and says NOTHING VERIFIED when no example was executed', async () => {
    const dir = makeTempDir();
    writeTree(dir, { 'README.md': '# T\n\nNo runnable examples.\n\n```json\n{}\n```\n' });
    const r = await runCli(['verify', 'README.md'], dir, new FakeDocker());
    assert.equal(r.code, 4);
    assert.match(r.stdout, /NOTHING VERIFIED: zero examples were executed, so this is not a pass/);
    assert.match(r.stdout, /Result: NOTHING VERIFIED \(exit code 4\)/);
  });

  it('exits 2 for an unknown block name', async () => {
    const r = await runCli(['verify', 'README.md', '--block', 'ghost'], copyFixture('good-project'), new FakeDocker());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no code block named "ghost".*quickstart, makefile/);
  });

  it('passes --network only when asked and shows it prominently', async () => {
    const dir = copyFixture('good-project');
    const off = new FakeDocker({ run: () => ({ stdout: 'hello from acme\n' }) });
    const roff = await runCli(['verify', '.', '--block', 'quickstart'], dir, off);
    assert.match(roff.stdout, /network disabled/);
    assert.ok(off.runs[0]?.args.join(' ').includes('--network none'));
    const on = new FakeDocker({ run: () => ({ stdout: 'hello from acme\n' }) });
    const ron = await runCli(['verify', '.', '--block', 'quickstart', '--network'], dir, on);
    assert.match(ron.stdout, /network ENABLED \(--network\)/);
    assert.ok(on.runs[0]?.args.join(' ').includes('--network bridge'));
  });

  it('honours --image, --memory, --cpus and --timeout', async () => {
    const dir = copyFixture('good-project');
    const docker = new FakeDocker({ run: () => ({ stdout: 'hello from acme\n' }) });
    await runCli(['verify', '.', '--block', 'quickstart', '--image', 'node:20-alpine', '--memory', '256', '--cpus', '0.5', '--timeout', '7'], dir, docker);
    const args = docker.runs[0]?.args.join(' ') ?? '';
    assert.match(args, /--memory 256m/);
    assert.match(args, /--cpus 0\.5/);
    assert.match(args, /node:20-alpine -c/);
    assert.equal(docker.runOptions[0]?.timeoutMs, 7000);
  });

  it('produces valid JSON on stdout only', async () => {
    const dir = copyFixture('good-project');
    const docker = new FakeDocker({ run: () => ({ stdout: 'hello from acme\n' }) });
    const r = await runCli(['verify', '.', '--block', 'quickstart', '--json', '--verbose'], dir, docker);
    assert.equal(r.stderr, '');
    const j = JSON.parse(r.stdout);
    assert.equal(j.command, 'verify');
    assert.equal(j.results[0].verification, 'asserted');
    assert.equal(j.results[0].executed, true);
    assert.equal(j.execution.workspace.skipped >= 0, true);
  });
});

