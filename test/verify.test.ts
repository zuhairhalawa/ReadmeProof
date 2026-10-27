import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/docker.js';
import { parseMarkdown } from '../src/markdown.js';
import { UsageError, type Project } from '../src/project.js';
import { buildVerifyReport } from '../src/report.js';
import { shellBody, verifyBlocks, type VerifyOptions } from '../src/verify.js';
import type { CodeBlock } from '../src/types.js';
import { FakeDocker, makeTempDir, readTar, writeTree, type FakeDockerOptions } from './helpers.js';

function setup(readme: string, files: Record<string, string> = {}) {
  const dir = makeTempDir();
  writeTree(dir, { 'README.md': readme, ...files });
  const doc = parseMarkdown(readme, 'README.md');
  const project: Project = { readmeAbs: dir + '/README.md', readmeDisplay: 'README.md', readmeDir: dir, boundary: dir, projectDir: dir, pkg: undefined, rootWasOverridden: true };
  return { dir, doc, project };
}

async function verify(readme: string, docker: FakeDocker, extra: Partial<VerifyOptions> = {}, files: Record<string, string> = {}) {
  const { doc, project } = setup(readme, files);
  const r = await verifyBlocks({ doc, project, runtime: docker, settings: DEFAULT_SETTINGS, timeoutSec: 60, maxOutputBytes: 4096, pull: false, ...extra });
  return { ...r, doc, project, report: buildVerifyReport(doc, project, r.execution, r.results, project.projectDir) };
}

const fence = (ann: string, code: string, lang = 'sh'): string => `${ann}\n\`\`\`${lang}\n${code}\n\`\`\`\n`;

describe('SIMULATED (FakeDocker, no daemon): verifyBlocks: assertions', () => {
  it('reports asserted PASS and smoke PASS separately', async () => {
    const readme = fence('<!-- readmeproof: name=a exit=0 output="hello" -->', 'echo hello') + '\n' + fence('', 'echo smoke');
    const docker = new FakeDocker({ run: (c) => ({ stdout: c.script.includes('x') ? 'hello\n' : 'hello\n' }) });
    const { results, report } = await verify(readme, docker);
    assert.deepEqual(results.map((r) => [r.status, r.verification, r.executed]), [['PASS', 'asserted', true], ['PASS', 'smoke', true]]);
    assert.equal(report.summary.execution?.assertedPassed, 1);
    assert.equal(report.summary.execution?.smokePassed, 1);
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.exitCode, 0);
    assert.match(report.notices.join(' '), /^$/);
  });

  it('warns when only smoke tests passed', async () => {
    const { report } = await verify(fence('', 'true'), new FakeDocker());
    assert.equal(report.verdict, 'PASS');
    assert.match(report.notices.join(' '), /Only smoke tests passed/);
  });

  it('FAILs on exit status mismatch, defaulting to expecting 0', async () => {
    const { results, report } = await verify(fence('', 'false'), new FakeDocker({ run: () => ({ exitCode: 1, stderr: 'boom' }) }));
    assert.equal(results[0]?.status, 'FAIL');
    assert.deepEqual(results[0]?.assertions[0], { kind: 'exit', expected: '0', actual: '1', passed: false });
    assert.equal(results[0]?.stderr, 'boom');
    assert.equal(report.exitCode, 1);
  });

  it('supports expected non-zero exit status', async () => {
    const { results } = await verify(fence('<!-- readmeproof: exit=2 -->', 'exit 2'), new FakeDocker({ run: () => ({ exitCode: 2 }) }));
    assert.equal(results[0]?.status, 'PASS');
    assert.equal(results[0]?.verification, 'asserted');
  });

  it('checks output (contains), output-exact and stderr', async () => {
    const readme = [
      fence('<!-- readmeproof: output="needle" -->', 'a'),
      fence('<!-- readmeproof: output="missing" -->', 'b'),
      fence('<!-- readmeproof: output-exact="a\\nb" -->', 'c'),
      fence('<!-- readmeproof: output-exact="a" -->', 'd'),
      fence('<!-- readmeproof: stderr="warn" exit=1 -->', 'e'),
    ].join('\n');
    const outs = ['has needle in it\n', 'nothing\n', 'a\r\nb\r\n', 'a\nextra\n', ''];
    let i = 0;
    const docker = new FakeDocker({ run: () => {
      const n = i++;
      return n === 4 ? { exitCode: 1, stderr: 'a warning here' } : { stdout: outs[n] ?? '' };
    } });
    const { results } = await verify(readme, docker);
    assert.deepEqual(results.map((r) => r.status), ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS']);
    assert.equal(results[1]?.assertions.find((a) => !a.passed)?.kind, 'output');
  });

  it('checks creates: created passes, missing and preexisting fail', async () => {
    const readme = [
      fence('<!-- readmeproof: creates=a.txt -->', 'x'),
      fence('<!-- readmeproof: creates=b.txt -->', 'x'),
      fence('<!-- readmeproof: creates=c.txt -->', 'x'),
    ].join('\n');
    const states = ['created', 'missing', 'preexisting'] as const;
    let i = 0;
    const docker = new FakeDocker({ run: () => {
      const s = states[i++] as (typeof states)[number];
      return { created: { [`${'abc'[i - 1]}.txt`]: s } };
    } });
    const { results } = await verify(readme, docker);
    assert.deepEqual(results.map((r) => r.status), ['PASS', 'FAIL', 'FAIL']);
    assert.match(results[2]?.assertions.find((a) => !a.passed)?.actual ?? '', /already existed/);
  });

  it('FAILs on timeout and runaway output without trusting partial output', async () => {
    const t = await verify(fence('', 'sleep 100'), new FakeDocker({ run: () => ({ timedOut: true, exitCode: 137 }) }));
    assert.equal(t.results[0]?.status, 'FAIL');
    assert.match(t.results[0]?.reason ?? '', /time limit/);
    const o = await verify(fence('', 'yes'), new FakeDocker({ run: () => ({ outputLimitExceeded: true, exitCode: 137 }) }));
    assert.match(o.results[0]?.reason ?? '', /runaway output/);
  });

  it('is UNVERIFIED (not FAIL) when expected output may have been truncated away', async () => {
    const docker = new FakeDocker({ run: () => ({ stdout: 'x'.repeat(10), stdoutTruncated: true }) });
    const { results } = await verify(fence('<!-- readmeproof: output="late" -->', 'big'), docker);
    assert.equal(results[0]?.status, 'UNVERIFIED');
  });

  it('is UNVERIFIED when the container could not run the block', async () => {
    const docker = new FakeDocker({ run: () => ({ started: false, exitCode: 125, stderr: 'daemon error' }) });
    const { results, report } = await verify(fence('', 'true'), docker);
    assert.equal(results[0]?.status, 'UNVERIFIED');
    assert.equal(results[0]?.executed, false);
    assert.equal(report.verdict, 'NOTHING_VERIFIED');
    assert.equal(report.exitCode, 4);
  });

  it('suggests --network when a failure looks network related', async () => {
    const docker = new FakeDocker({ run: () => ({ exitCode: 1, stderr: 'getaddrinfo EAI_AGAIN registry.npmjs.org' }) });
    const { results } = await verify(fence('', 'npm install left-pad'), docker);
    assert.match(results[0]?.fix ?? '', /--network/);
    const withNet = await verify(fence('', 'npm install left-pad'), docker, { settings: { ...DEFAULT_SETTINGS, network: true } });
    assert.doesNotMatch(withNet.results[0]?.fix ?? '', /--network/);
  });
});

describe('SIMULATED (FakeDocker, no daemon): verifyBlocks: availability is never a pass', () => {
  const cases: Array<[string, FakeDockerOptions]> = [
    ['docker CLI missing', { cliMissing: true }],
    ['daemon unreachable', { versionFails: { stderr: 'Cannot connect to the Docker daemon' } }],
    ['windows containers', { versionStdout: '27|windows' }],
    ['image missing without --pull', { imagePresent: false }],
  ];
  for (const [name, opts] of cases) {
    it(`${name}: UNAVAILABLE, nothing executed, exit code 3`, async () => {
      const docker = new FakeDocker(opts);
      const { results, execution, report } = await verify(fence('<!-- readmeproof: exit=0 -->', 'echo hi'), docker);
      assert.equal(execution.status, 'UNAVAILABLE');
      assert.ok(execution.reason && execution.fix);
      assert.deepEqual(results.map((r) => [r.status, r.executed]), [['UNVERIFIED', false]]);
      assert.equal(docker.runs.length, 0);
      assert.equal(report.verdict, 'UNAVAILABLE');
      assert.equal(report.exitCode, 3);
      assert.equal(report.summary.examplesExecuted, 0);
    });
  }

  it('pulls a missing image only with --pull', async () => {
    const docker = new FakeDocker({ imagePresent: false });
    const { execution } = await verify(fence('', 'true'), docker, { pull: true });
    assert.equal(execution.status, 'AVAILABLE');
    assert.ok(docker.calls.some((c) => c[0] === 'pull'));
    const failing = new FakeDocker({ imagePresent: false, pullOk: false });
    const r = await verify(fence('', 'true'), failing, { pull: true });
    assert.equal(r.execution.status, 'UNAVAILABLE');
    assert.match(r.execution.reason ?? '', /could not pull/);
  });

  it('does not even probe Docker when there is nothing to execute', async () => {
    const docker = new FakeDocker();
    const { execution, results, report } = await verify('# T\n\n```json\n{}\n```\n', docker);
    assert.equal(docker.calls.length, 0);
    assert.equal(execution.status, 'NOT_NEEDED');
    assert.equal(results[0]?.status, 'SKIP');
    assert.equal(report.verdict, 'NOTHING_VERIFIED');
    assert.equal(report.exitCode, 4);
  });
});

describe('SIMULATED (FakeDocker, no daemon): verifyBlocks: selection, skipping and policy', () => {
  const readme = [fence('<!-- readmeproof: name=one -->', 'echo 1'), fence('<!-- readmeproof: skip -->', 'echo skipped'), fence('', '{}', 'json'), fence('', 'echo 4')].join('\n');

  it('runs everything executable by default and reports skips', async () => {
    const docker = new FakeDocker();
    const { results } = await verify(readme, docker);
    assert.deepEqual(results.map((r) => r.status), ['PASS', 'SKIP', 'SKIP', 'PASS']);
    assert.equal(docker.runs.length, 2);
  });

  it('selects a single block by name or by line', async () => {
    const d1 = new FakeDocker();
    const byName = await verify(readme, d1, { block: 'one' });
    assert.equal(byName.results.length, 1);
    assert.equal(d1.runs.length, 1);
    const d2 = new FakeDocker();
    const lastBlock = parseMarkdown(readme, 'README.md').blocks[3] as CodeBlock;
    const byLine = await verify(readme, d2, { block: String(lastBlock.line) });
    assert.equal(byLine.results[0]?.line, lastBlock.line);
    assert.equal(d2.runs.length, 1);
  });

  it('rejects unknown block selectors with the list of names', async () => {
    await assert.rejects(verify(readme, new FakeDocker(), { block: 'nope' }), (e: Error) => e instanceof UsageError && /named blocks: one/.test(e.message));
  });

  it('reports an explicitly selected non-executable block as UNVERIFIED', async () => {
    const r = await verify('<!-- readmeproof: name=j -->\n```json\n{}\n```\n', new FakeDocker(), { block: 'j' });
    assert.equal(r.results[0]?.status, 'UNVERIFIED');
    assert.match(r.results[0]?.reason ?? '', /cannot be executed/);
  });

  it('applies the CLI timeout as a ceiling that annotations cannot raise', async () => {
    const docker = new FakeDocker();
    await verify(fence('<!-- readmeproof: timeout=500 -->', 'a') + fence('<!-- readmeproof: timeout=5 -->', 'b'), docker, { timeoutSec: 30 });
    assert.deepEqual(docker.runOptions.map((o) => o.timeoutMs), [30000, 5000]);
  });

  it('runs with the network disabled unless explicitly enabled', async () => {
    const off = new FakeDocker();
    await verify(fence('', 'a'), off);
    assert.ok(off.runs[0]?.args.join(' ').includes('--network none'));
    const on = new FakeDocker();
    const r = await verify(fence('', 'a'), on, { settings: { ...DEFAULT_SETTINGS, network: true } });
    assert.ok(on.runs[0]?.args.join(' ').includes('--network bridge'));
    assert.equal(r.report.execution?.network, true);
  });

  it('rejects an option-like image name', async () => {
    await assert.rejects(verify(fence('', 'a'), new FakeDocker(), { settings: { ...DEFAULT_SETTINGS, image: '--privileged' } }), UsageError);
  });

  it('refuses to copy a home directory into a container', async () => {
    const { doc, project } = setup(fence('', 'a'));
    const homeProject: Project = { ...project, projectDir: os.homedir() };
    await assert.rejects(
      verifyBlocks({ doc, project: homeProject, runtime: new FakeDocker(), settings: DEFAULT_SETTINGS, timeoutSec: 5, maxOutputBytes: 100, pull: false }),
      /home directory/,
    );
  });
});

describe('SIMULATED (FakeDocker, no daemon): verifyBlocks: sanitized workspace', () => {
  it('never sends secrets, .git or symlink targets into the container', async () => {
    const docker = new FakeDocker();
    await verify(fence('', 'ls -a'), docker, {}, {
      '.env': 'TOKEN=SECRET-VALUE',
      '.git/config': 'url = https://user:SECRET-VALUE@x',
      '.npmrc': '_authToken=SECRET-VALUE',
      'keys/id_rsa': 'SECRET-VALUE',
      'src/app.js': 'ok',
    });
    const entries = readTar(docker.runs[0]?.input ?? Buffer.alloc(0));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('work/src/app.js'));
    assert.ok(names.includes('work/README.md'));
    assert.ok(!names.some((n) => /\.env$|\.git|\.npmrc|id_rsa/.test(n)));
    assert.ok(entries.every((e) => !e.data.toString().includes('SECRET-VALUE')));
  });
});

describe('SIMULATED (FakeDocker, no daemon): shellBody', () => {
  const block = (content: string): CodeBlock => ({ id: 'x', line: 1, endLine: 2, contentLine: 2, kind: 'fenced', language: 'sh', info: 'sh', content, annotation: undefined, annotationLine: undefined });
  it('keeps plain scripts untouched', () => {
    assert.equal(shellBody(block('echo a\necho b\n'), 'sh'), 'echo a\necho b\n');
  });
  it('extracts commands from $ transcripts, including continuations', () => {
    const bs = String.fromCharCode(92);
    assert.equal(shellBody(block(`$ echo a\nA\n$ echo b ${bs}\n  c\nB\n`), 'bash'), `echo a\necho b ${bs}\n  c\n`);
  });
  it('never rewrites node blocks', () => {
    assert.equal(shellBody(block('$ not a prompt'), 'node'), '$ not a prompt');
  });
});

