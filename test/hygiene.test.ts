import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from './helpers.js';

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

describe('source hygiene', () => {
  it('keeps src/, test/ and scripts/ free of non-ASCII and invisible characters (no trojan-source risk)', () => {
    const files = [
      ...walk(path.join(repoRoot, 'src'), ['.ts']),
      ...walk(path.join(repoRoot, 'test'), ['.ts']),
      ...walk(path.join(repoRoot, 'scripts'), ['.mjs']),
    ];
    assert.ok(files.length > 10);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7e) {
          offenders.push(`${path.relative(repoRoot, f)} at offset ${i}: U+${text.charCodeAt(i).toString(16)}`);
          break;
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('compiles the CLI entry with an LF-terminated shebang (CRLF breaks it on Linux)', () => {
    const bin = readFileSync(path.join(repoRoot, '.test-build', 'src', 'bin.js'), 'utf8');
    assert.ok(bin.startsWith('#!/usr/bin/env node\n'));
    assert.ok(!bin.includes('\r'));
  });

  it('declares the bin entry that the build produces', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { bin: Record<string, string>; files: string[]; license: string; engines: { node: string } };
    assert.deepEqual(pkg.bin, { readmeproof: 'dist/bin.js' });
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.engines.node, '>=20');
    assert.ok(!pkg.files.some((f) => /test|src|scripts|fixtures|\.env/.test(f)));
  });
});


describe('simulated vs real Docker tests stay distinct', () => {
  const testDir = path.join(repoRoot, 'test');
  const sources = readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).map((f) => ({ f, text: readFileSync(path.join(testDir, f), 'utf8') }));

  it('the real-container file never uses the simulated FakeDocker', () => {
    const real = sources.find((s) => s.f === 'docker.integration.test.ts');
    assert.ok(real, 'docker.integration.test.ts must exist');
    assert.ok(!/import[^;]*FakeDocker/.test(real.text), 'must not import FakeDocker');
    assert.ok(/REAL DOCKER integration \(actual containers\)/.test(real.text));
  });

  it('every suite that instantiates FakeDocker is labelled SIMULATED', () => {
    let suitesChecked = 0;
    for (const s of sources.filter((x) => x.f !== 'hygiene.test.ts' && /import[^;]*FakeDocker/.test(x.text))) {
      for (const chunk of s.text.split(/^describe\('/m).slice(1)) {
        const title = chunk.slice(0, chunk.indexOf("'"));
        if (!/new FakeDocker/.test(chunk)) continue;
        suitesChecked++;
        assert.ok(title.startsWith('SIMULATED'), `${s.f}: suite "${title}" uses FakeDocker but is not labelled SIMULATED`);
      }
    }
    assert.ok(suitesChecked >= 5, 'expected to find the simulated suites');
  });

  it('declares enough real Docker tests that docker-proof can demand them', () => {
    const real = sources.find((s) => s.f === 'docker.integration.test.ts');
    const declared = [...(real?.text ?? '').matchAll(/^\s*test\('/gm)].length;
    assert.ok(declared >= 20, `only ${declared} real Docker tests declared`);
  });
});