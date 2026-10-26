import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTar, validateTarPath } from '../src/tar.js';
import { readTar } from './helpers.js';

describe('buildTar', () => {
  it('round-trips files and directories with an independent reader', () => {
    const tar = buildTar([
      { path: 'work/src', type: 'dir', mode: 0o755, mtime: 1700000000 },
      { path: 'work/src/a.txt', type: 'file', mode: 0o644, mtime: 1700000000, data: Buffer.from('hello') },
      { path: 'work/run.sh', type: 'file', mode: 0o755, mtime: 1700000000, data: Buffer.alloc(1000, 65) },
      { path: 'work/empty', type: 'file', mode: 0o644, mtime: 0 },
    ]);
    assert.equal(tar.length % 512, 0);
    const entries = readTar(tar);
    assert.deepEqual(entries.map((e) => [e.name, e.type]), [['work/src/', '5'], ['work/src/a.txt', '0'], ['work/run.sh', '0'], ['work/empty', '0']]);
    assert.equal(entries[1]?.data.toString(), 'hello');
    assert.equal(entries[2]?.mode, 0o755);
    assert.equal(entries[2]?.data.length, 1000);
  });

  it('uses PAX headers for long and non-ASCII names', () => {
    const long = 'work/' + 'd/'.repeat(80) + 'file.txt';
    const uni = 'work/caf' + String.fromCharCode(0xe9, 0x20, 0x2713) + '.txt';
    const entries = readTar(
      buildTar([
        { path: long, type: 'file', mode: 0o644, mtime: 1, data: Buffer.from('x') },
        { path: uni, type: 'file', mode: 0o644, mtime: 1, data: Buffer.from('y') },
      ]),
    );
    assert.equal(entries[0]?.name, long);
    assert.equal(entries[1]?.name, uni);
  });

  it('rejects traversal and absolute paths', () => {
    for (const bad of ['../x', '/abs', 'a/../b', '', 'a//b', 'a/' + String.fromCharCode(0)]) {
      assert.throws(() => validateTarPath(bad), /unsafe tar path/, JSON.stringify(bad));
      assert.throws(() => buildTar([{ path: bad, type: 'file', mode: 0o644, mtime: 0 }]));
    }
  });
});

