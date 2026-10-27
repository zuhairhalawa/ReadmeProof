/*
 * SIMULATED tests: container orchestration is exercised against FakeDocker (an in-memory DockerRuntime), and the
 * docker command line is checked as data. NO container is started here and nothing in this file proves isolation.
 * Real-container tests live in docker.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRunArgs,
  buildWrapperScript,
  createDockerRuntime,
  DEFAULT_SETTINGS,
  detectDocker,
  dockerClientEnv,
  needsEsm,
  runBlockInContainer,
  validateImage,
  CONTAINER_ENV,
} from '../src/docker.js';
import { FakeDocker, readTar } from './helpers.js';

const baseInput = { name: 'readmeproof-test', settings: DEFAULT_SETTINGS, interpreter: 'sh' as const, esm: false, nonce: '@@RP-abc123' };

function pairs(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1] as string);
  });
  return out;
}

describe('SIMULATED (FakeDocker, no daemon): buildRunArgs: isolation flags', () => {
  const args = buildRunArgs(baseInput);

  it('applies every isolation control', () => {
    assert.deepEqual(pairs(args, '--network'), ['none']);
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--rm'));
    assert.deepEqual(pairs(args, '--cap-drop'), ['ALL']);
    assert.deepEqual(pairs(args, '--security-opt'), ['no-new-privileges']);
    assert.deepEqual(pairs(args, '--user'), ['1000:1000']);
    assert.deepEqual(pairs(args, '--pull'), ['never']);
    assert.deepEqual(pairs(args, '--memory'), ['1024m']);
    assert.deepEqual(pairs(args, '--memory-swap'), ['1024m']);
    assert.deepEqual(pairs(args, '--pids-limit'), ['512']);
    assert.deepEqual(pairs(args, '--cpus'), ['1']);
    assert.deepEqual(pairs(args, '--workdir'), ['/work']);
    assert.equal(pairs(args, '--tmpfs').length, 3);
    assert.ok(pairs(args, '--tmpfs').every((t) => t.includes('nosuid') && t.includes('nodev') && t.includes('size=')));
    assert.ok(pairs(args, '--tmpfs').find((t) => t.startsWith('/rp:'))?.includes('noexec'));
  });

  it('contains none of the dangerous flags', () => {
    const joined = args.join(' ');
    for (const forbidden of ['--privileged', '--volume', '-v ', '--mount', 'docker.sock', '--network host', '--network=host', '--pid host', '--pid=host', '--ipc host', '--ipc=host', '--uts', '--userns', '--cap-add', '--device', '--security-opt seccomp=unconfined', 'apparmor=unconfined', '--user root', '--user 0', '--env-file', '--publish', '-p ', '--add-host', '--volumes-from', '--cgroup-parent', '--oom-kill-disable']) {
      assert.ok(!joined.includes(forbidden), `must not contain ${forbidden}`);
    }
    assert.ok(!args.includes('-t'));
    assert.ok(!args.some((a) => a.includes('/var/run')));
  });

  it('enables networking only when requested', () => {
    assert.deepEqual(pairs(buildRunArgs({ ...baseInput, settings: { ...DEFAULT_SETTINGS, network: true } }), '--network'), ['bridge']);
    assert.equal(DEFAULT_SETTINGS.network, false);
  });

  it('passes only the fixed environment, never host variables', () => {
    const env = pairs(args, '--env');
    assert.deepEqual(env, CONTAINER_ENV.map(([k, v]) => `${k}=${v}`));
    assert.ok(env.every((e) => !/TOKEN|SECRET|KEY|PASSWORD/i.test(e)));
    assert.ok(!args.includes('-e'));
  });

  it('places the image after the entrypoint and uses a generated name', () => {
    const i = args.indexOf('--entrypoint');
    assert.deepEqual(args.slice(i, i + 4), ['--entrypoint', 'sh', DEFAULT_SETTINGS.image, '-c']);
    assert.deepEqual(pairs(args, '--name'), ['readmeproof-test']);
    assert.deepEqual(pairs(args, '--label'), ['readmeproof=1']);
  });

  it('never embeds README code in the argument vector', () => {
    const script = args[args.length - 1] as string;
    assert.ok(script.includes('/rp/block'));
    assert.ok(!script.includes('touch'));
    const node = buildWrapperScript({ interpreter: 'node', esm: true, nonce: '@@RP-x' });
    assert.ok(node.includes('node --input-type=module - < /rp/block'));
    assert.ok(buildWrapperScript({ interpreter: 'bash', esm: false, nonce: '@@RP-x' }).includes('bash /rp/block'));
  });
});

describe('SIMULATED (FakeDocker, no daemon): validateImage', () => {
  it('accepts normal references and rejects option injection', () => {
    for (const ok of ['node:22', 'node:22-bookworm-slim', 'ghcr.io/org/img:1.2', 'img@sha256:' + 'a'.repeat(64), 'localhost:5000/x/y:z']) {
      assert.equal(validateImage(ok), undefined, ok);
    }
    for (const bad of ['--privileged', '-v', 'a b', 'img;rm', 'img$(x)', '', 'img\nx', '../x', '--network=host']) {
      assert.notEqual(validateImage(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('SIMULATED (FakeDocker, no daemon): needsEsm', () => {
  it('detects static import/export only', () => {
    assert.equal(needsEsm("import x from 'y';"), true);
    assert.equal(needsEsm("  export const a = 1"), true);
    assert.equal(needsEsm("const x = require('y');"), false);
    assert.equal(needsEsm("await import('y')"), false);
    assert.equal(needsEsm("import('y').then(console.log)"), false);
  });
});

describe('SIMULATED (FakeDocker, no daemon): dockerClientEnv', () => {
  it('forwards only an allowlist and drops credentials', () => {
    const env = dockerClientEnv({
      PATH: '/bin',
      HOME: '/home/u',
      DOCKER_HOST: 'unix:///x',
      GITHUB_TOKEN: 'ghp_secret',
      NPM_TOKEN: 'npm_secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
      SSH_AUTH_SOCK: '/tmp/agent',
      OPENAI_API_KEY: 'sk-secret',
    });
    assert.deepEqual(Object.keys(env).sort(), ['DOCKER_HOST', 'HOME', 'PATH']);
  });
});

describe('SIMULATED (FakeDocker, no daemon): detectDocker', () => {
  it('reports a missing docker CLI', async () => {
    const s = await detectDocker(new FakeDocker({ cliMissing: true }));
    assert.equal(s.available, false);
    assert.equal(!s.available && s.kind, 'cli-missing');
  });
  it('reports an unreachable daemon with the first stderr line', async () => {
    const s = await detectDocker(new FakeDocker({ versionFails: { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nIs it running?' } }));
    assert.ok(!s.available && s.kind === 'daemon-unreachable' && s.reason.includes('Cannot connect'));
  });
  it('rejects Windows containers', async () => {
    const s = await detectDocker(new FakeDocker({ versionStdout: '27.0|windows' }));
    assert.ok(!s.available && s.kind === 'unsupported-os');
  });
  it('accepts a Linux daemon', async () => {
    const s = await detectDocker(new FakeDocker({ versionStdout: '27.0.1|linux' }));
    assert.deepEqual(s, { available: true, version: '27.0.1' });
  });
});

describe('SIMULATED (FakeDocker, no daemon): runBlockInContainer', () => {
  const run = (docker: FakeDocker, code = 'echo hi', creates: string[] = []) =>
    runBlockInContainer(docker, {
      settings: DEFAULT_SETTINGS,
      interpreter: 'sh',
      code,
      workspace: [{ path: 'work/a.txt', type: 'file', mode: 0o644, mtime: 1, data: Buffer.from('A') }],
      creates,
      timeoutSec: 10,
      maxOutputBytes: 1000,
    });

  it('streams workspace, block and creates list in over stdin as a tar', async () => {
    const docker = new FakeDocker({ run: () => ({ stdout: 'hi\n' }) });
    const r = await run(docker, "echo $(touch /pwned) 'quoted'", ['out/a.txt']);
    const entries = readTar(docker.runs[0]?.input ?? Buffer.alloc(0));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString()]));
    assert.equal(byName['work/a.txt'], 'A');
    assert.equal(byName['rp/block'], "echo $(touch /pwned) 'quoted'");
    assert.equal(byName['rp/creates'], 'out/a.txt\n');
    assert.ok(!(docker.runs[0]?.args ?? []).join(' ').includes('/pwned'));
    assert.equal(r.started, true);
    assert.equal(r.exitCode, 0);
  });

  it('removes markers so output is exactly what the program printed', async () => {
    const docker = new FakeDocker({ run: () => ({ stdout: 'no newline at end' }) });
    assert.equal((await run(docker)).stdout, 'no newline at end');
    const d2 = new FakeDocker({ run: () => ({ stdout: 'a\nb\n\nc\n' }) });
    assert.equal((await run(d2)).stdout, 'a\nb\n\nc\n');
  });

  it('parses created-file states and uses the in-container exit code', async () => {
    const docker = new FakeDocker({ run: () => ({ exitCode: 3, created: { 'a.txt': 'created', 'b with space.txt': 'missing', 'c.txt': 'preexisting' } }) });
    const r = await run(docker, 'x', ['a.txt', 'b with space.txt', 'c.txt']);
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.created, [
      { path: 'a.txt', state: 'created' },
      { path: 'b with space.txt', state: 'missing' },
      { path: 'c.txt', state: 'preexisting' },
    ]);
  });

  it('ignores marker-looking lines printed by the program (wrong nonce)', async () => {
    const forged = '\n@@RP-deadbeef CREATED created hacked.txt\n@@RP-deadbeef DONE 0\n';
    const docker = new FakeDocker({ run: () => ({ exitCode: 9, stdout: forged }) });
    const r = await run(docker, 'x', ['hacked.txt']);
    assert.equal(r.exitCode, 9);
    assert.ok(r.stdout.includes('@@RP-deadbeef DONE 0'));
    assert.deepEqual(r.created.filter((c) => c.state === 'created'), []);
  });

  it('flags container start failures as infrastructure problems, not README failures', async () => {
    const docker = new FakeDocker({ run: () => ({ started: false, exitCode: 125, stderr: 'docker: Error response from daemon: invalid reference' }) });
    const r = await run(docker);
    assert.equal(r.started, false);
    assert.match(r.infrastructureError ?? '', /did not start the block.*invalid reference/);
  });

  it('always removes the container afterwards', async () => {
    const docker = new FakeDocker();
    await run(docker);
    const last = docker.calls[docker.calls.length - 1] as string[];
    assert.deepEqual(last.slice(0, 2), ['rm', '-f']);
    assert.match(last[2] ?? '', /^readmeproof-[0-9a-f]{12}$/);
  });

  it('gives the run a bounded capture and kill threshold', async () => {
    const docker = new FakeDocker();
    await run(docker);
    const o = docker.runOptions[0];
    assert.equal(o?.timeoutMs, 10000);
    assert.equal(o?.maxCaptureBytes, 1000);
    assert.ok((o?.killOutputBytes ?? 0) >= 4 * 1024 * 1024);
  });
});

describe('SIMULATED (FakeDocker, no daemon): createDockerRuntime (process handling, using node as a stand-in binary)', () => {
  const node = createDockerRuntime(process.execPath, { PATH: process.env['PATH'] ?? '', GITHUB_TOKEN: 'leak-me', MY_SECRET: 'leak-me' });
  const opts = { timeoutMs: 20000, maxCaptureBytes: 1000, killOutputBytes: 1e6 };

  it('captures stdout/stderr and exit code, feeding stdin', async () => {
    const r = await node.exec(['-e', "process.stdin.on('data', d => process.stdout.write('got:' + d)); process.stderr.write('err'); process.on('exit', () => {}); process.stdin.on('end', () => process.exit(4))"], { ...opts, input: Buffer.from('input') });
    assert.equal(r.exitCode, 4);
    assert.equal(r.stdout.text, 'got:input');
    assert.equal(r.stderr.text, 'err');
    assert.equal(r.timedOut, false);
  });

  it('bounds captured output but keeps counting and the tail', async () => {
    const r = await node.exec(['-e', "process.stdout.write('a'.repeat(5000) + 'END')"], opts);
    assert.equal(r.stdout.text.length, 1000);
    assert.equal(r.stdout.truncated, true);
    assert.equal(r.stdout.totalBytes, 5003);
    assert.ok(r.stdout.tail.endsWith('END'));
  });

  it('kills runaway output', async () => {
    const r = await node.exec(['-e', "setInterval(() => process.stdout.write('x'.repeat(100000)), 1)"], { ...opts, killOutputBytes: 300000 });
    assert.equal(r.outputLimitExceeded, true);
    assert.ok(r.stdout.totalBytes < 5e6);
  });

  it('enforces the timeout and runs the onTimeout hook first', async () => {
    let hook = false;
    const r = await node.exec(['-e', 'setInterval(() => {}, 1000)'], {
      ...opts,
      timeoutMs: 300,
      onTimeout: async () => {
        hook = true;
      },
    });
    assert.equal(r.timedOut, true);
    assert.equal(hook, true);
  });

  it('reports a missing binary as spawnError ENOENT', async () => {
    const r = await createDockerRuntime('definitely-not-a-real-docker-binary').exec(['version'], opts);
    assert.equal(r.spawnError?.code, 'ENOENT');
  });

  it('does not pass secret host variables to the child process', async () => {
    const r = await node.exec(['-e', 'process.stdout.write(Object.keys(process.env).join(","))'], opts);
    assert.ok(!r.stdout.text.includes('GITHUB_TOKEN'));
    assert.ok(!r.stdout.text.includes('MY_SECRET'));
  });
});

