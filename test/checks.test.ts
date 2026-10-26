import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { classifyHref, isLikelyWrongName, levenshtein, packageNameFromSpec, runStaticChecks } from '../src/checks.js';
import { parseMarkdown } from '../src/markdown.js';
import { discoverProject } from '../src/project.js';
import type { Finding } from '../src/types.js';
import { copyFixture, makeTempDir, writeTree } from './helpers.js';

function analyze(dir: string, readme = 'README.md'): Finding[] {
  const file = path.join(dir, readme);
  const project = discoverProject(file, { cwd: dir });
  return runStaticChecks(parseMarkdown(readFileSync(file, 'utf8'), readme), project);
}

const fails = (f: Finding[]): Finding[] => f.filter((x) => x.status === 'FAIL');
const at = (f: Finding[], line: number, rule?: string): Finding[] => f.filter((x) => x.line === line && (rule === undefined || x.rule === rule));

describe('static checks: good fixture', () => {
  const findings = analyze(copyFixture('good-project'));
  it('has no failures', () => {
    assert.deepEqual(fails(findings), []);
  });
  it('verifies local links, assets, anchors, scripts, files and package names', () => {
    assert.equal(at(findings, 3, 'link')[0]?.status, 'PASS');
    assert.equal(at(findings, 13, 'link')[0]?.status, 'PASS');
    assert.equal(at(findings, 62, 'package-script').length, 2);
    assert.equal(at(findings, 19, 'package-name')[0]?.status, 'PASS');
    assert.equal(at(findings, 34, 'referenced-file')[0]?.status, 'PASS');
  });
  it('reports external links as UNVERIFIED, never as broken', () => {
    const ext = findings.filter((f) => f.rule === 'external-link');
    assert.equal(ext.length, 3);
    assert.ok(ext.every((f) => f.status === 'UNVERIFIED' && /not checked/.test(f.message)));
  });
  it('assigns stable ids sorted by line', () => {
    assert.match(findings[0]?.id ?? '', /^F0001$/);
    const lines = findings.map((f) => f.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  });
});

describe('static checks: broken fixture', () => {
  const dir = copyFixture('broken-project');
  const findings = analyze(dir);
  it('flags each defect at its exact line with evidence and a fix', () => {
    assert.equal(at(findings, 3, 'broken-link')[0]?.status, 'FAIL');
    assert.match(at(findings, 3)[0]?.message ?? '', /assets\/missing\.png/);
    assert.equal(at(findings, 5, 'broken-link')[0]?.status, 'FAIL');
    assert.equal(at(findings, 6, 'anchor').length, 2);
    assert.equal(at(findings, 7, 'path-traversal')[0]?.status, 'FAIL');
    assert.equal(at(findings, 13, 'package-name')[0]?.status, 'FAIL');
    assert.equal(at(findings, 14, 'package-script')[0]?.status, 'FAIL');
    assert.equal(at(findings, 15, 'missing-file')[0]?.status, 'FAIL');
    assert.equal(at(findings, 18, 'annotation')[0]?.status, 'FAIL');
    for (const f of fails(findings)) {
      assert.ok(f.evidence, `${f.rule}@${f.line} has evidence`);
      assert.ok(f.fix, `${f.rule}@${f.line} has a fix`);
      assert.equal(f.file, 'README.md');
    }
  });
  it('catches letter-case mismatches (Windows/macOS vs Linux)', () => {
    const f = at(findings, 7).filter((x) => x.rule !== 'path-traversal');
    assert.equal(f.length, 1);
    assert.equal(f[0]?.status, 'FAIL');
    assert.ok(f[0]?.rule === 'case-mismatch' || f[0]?.rule === 'broken-link');
  });
  it('treats unknown inline paths as UNVERIFIED because they may be generated', () => {
    const f = at(findings, 23, 'referenced-file');
    assert.equal(f[0]?.status, 'UNVERIFIED');
  });
  it('suggests close names', () => {
    const t = writeTemp({ 'README.md': '[x](docs/gide.md)\n', 'docs/guide.md': '# g\n' });
    const f = fails(analyze(t));
    assert.match(f[0]?.fix ?? '', /guide\.md/);
  });
});

function writeTemp(files: Record<string, string | Buffer>): string {
  const dir = makeTempDir();
  writeTree(dir, files);
  return dir;
}

describe('link handling', () => {
  it('handles encoded, angle-bracketed, absolute-root and query links', () => {
    const dir = writeTemp({
      'README.md': ['[a](my%20file.md)', '[b](<my file.md>)', '[c](/docs/guide.md)', '[d](docs/guide.md?plain=1)', '[e](docs)', '[f](bad%zz.md)'].join('\n') + '\n',
      'my file.md': '# x\n',
      'docs/guide.md': '# g\n',
      'package.json': '{"name":"p"}',
    });
    const f = analyze(dir);
    assert.equal(at(f, 1)[0]?.status, 'PASS');
    assert.equal(at(f, 2)[0]?.status, 'PASS');
    assert.equal(at(f, 3)[0]?.status, 'PASS');
    assert.equal(at(f, 4)[0]?.status, 'PASS');
    assert.equal(at(f, 5)[0]?.status, 'PASS');
  });

  it('classifies schemes without touching the network', () => {
    assert.equal(classifyHref('https://x.dev').type, 'external');
    assert.equal(classifyHref('//cdn.example.com/x.js').type, 'external');
    assert.equal(classifyHref('mailto:a@b.c').type, 'skipped');
    assert.equal(classifyHref('javascript:alert(1)').type, 'unsupported');
    assert.equal(classifyHref('file:///etc/passwd').type, 'absolute-local');
    assert.equal(classifyHref('C:\\Users\\x\\a.md').type, 'absolute-local');
    assert.equal(classifyHref('#frag').type, 'anchor');
    assert.deepEqual(classifyHref('a/b.md?x=1#h'), { type: 'local', pathPart: 'a/b.md', fragment: 'h' });
  });

  it('fails on file: URLs, drive paths and invalid percent-encoding', () => {
    /* markdown-it drops file: links and re-encodes bad escapes in [..](..) links, so raw HTML is the way these reach us. */
    const dir = writeTemp({ 'README.md': '[b](C:/Users/me/doc.md)\n\n<a href="file:///etc/passwd">a</a>\n\n<a href="bad%zz.md">c</a>\n' });
    const f = analyze(dir);
    assert.equal(fails(f).length, 3);
    assert.match(at(f, 1)[0]?.message ?? '', /absolute local path/);
    assert.match(at(f, 3)[0]?.message ?? '', /absolute local path/);
    assert.match(at(f, 5)[0]?.message ?? '', /percent-encoding/);
  });

  it('validates anchors in other markdown files and html anchors', () => {
    const dir = writeTemp({
      'README.md': '[a](docs/g.md#real-heading)\n[b](docs/g.md#custom-anchor)\n[c](docs/g.md#missing)\n[d](docs/code.js#L10)\n',
      'docs/g.md': '# Real heading\n\n<a id="custom-anchor"></a>\n',
      'docs/code.js': 'x',
    });
    const f = analyze(dir);
    assert.equal(at(f, 1)[0]?.status, 'PASS');
    assert.equal(at(f, 2)[0]?.status, 'PASS');
    assert.equal(at(f, 3)[0]?.status, 'FAIL');
    assert.equal(at(f, 4)[0]?.status, 'PASS');
  });

  it('allows links from a nested README to the repository root', () => {
    const dir = writeTemp({ '.git/HEAD': 'ref: x', 'LICENSE': 'MIT', 'packages/a/README.md': '[l](../../LICENSE)\n[out](../../../x.md)\n', 'packages/a/package.json': '{"name":"a"}' });
    const f = analyze(path.join(dir, 'packages', 'a'));
    assert.equal(at(f, 1)[0]?.status, 'PASS');
    assert.equal(at(f, 2)[0]?.rule, 'path-traversal');
  });

  it('detects symlink escapes without following them', (t) => {
    const outside = makeTempDir();
    writeTree(outside, { 'secret.md': '# secret\n' });
    const dir = writeTemp({ 'README.md': '[s](link/secret.md)\n[f](filelink.md)\n[ok](real.md)\n', 'real.md': '# ok\n' });
    /* Directory junctions work unprivileged on Windows; file symlinks may not. Test whatever we can create. */
    let dirLink = false;
    let fileLink = false;
    try {
      symlinkSync(outside, path.join(dir, 'link'), 'junction');
      dirLink = true;
    } catch {
      /* not permitted */
    }
    try {
      symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'filelink.md'), 'file');
      fileLink = true;
    } catch {
      /* not permitted */
    }
    if (!dirLink && !fileLink) {
      t.skip('symlinks not permitted on this system');
      return;
    }
    const f = analyze(dir);
    if (dirLink) {
      assert.equal(at(f, 1)[0]?.rule, 'symlink-escape');
      assert.equal(at(f, 1)[0]?.status, 'FAIL');
    }
    if (fileLink) assert.equal(at(f, 2)[0]?.rule, 'symlink-escape');
    assert.equal(at(f, 3)[0]?.status, 'PASS');
  });
});

describe('package script checks', () => {
  const pkg = JSON.stringify({ name: 'demo', scripts: { build: 'x', test: 'y', 'lint:fix': 'z' } });
  it('validates npm/yarn/pnpm/bun script references', () => {
    const dir = writeTemp({
      'package.json': pkg,
      'README.md': ['```sh', 'npm run build', 'npm test', 'npm run nope', 'yarn lint:fix', 'pnpm run lint:fix', 'yarn build', 'bun run missing', 'npm start', '```'].join('\n') + '\n',
    });
    const f = analyze(dir);
    assert.equal(at(f, 2)[0]?.status, 'PASS');
    assert.equal(at(f, 3)[0]?.status, 'PASS');
    assert.equal(at(f, 4)[0]?.status, 'FAIL');
    assert.equal(at(f, 5).length, 0);
    assert.equal(at(f, 6)[0]?.status, 'PASS');
    assert.equal(at(f, 7)[0]?.status, 'PASS');
    assert.equal(at(f, 8)[0]?.status, 'FAIL');
    assert.equal(at(f, 9)[0]?.status, 'FAIL');
    assert.match(at(f, 4)[0]?.fix ?? '', /build, lint:fix, test/);
  });

  it('npm start falls back to server.js when it exists', () => {
    const dir = writeTemp({ 'package.json': '{"name":"d"}', 'server.js': '', 'README.md': '```sh\nnpm start\n```\n' });
    assert.equal(at(analyze(dir), 2)[0]?.status, 'PASS');
  });

  it('does not guess after cd or with workspace flags', () => {
    const dir = writeTemp({
      'package.json': pkg,
      'README.md': '```sh\ncd sub\nnpm run nope\nnpm run other -w pkg\nnpm run x --prefix sub\n```\n',
    });
    const f = analyze(dir);
    assert.equal(at(f, 3)[0]?.status, 'UNVERIFIED');
    assert.equal(at(f, 4)[0]?.status, 'UNVERIFIED');
    assert.equal(at(f, 5)[0]?.status, 'UNVERIFIED');
    assert.equal(fails(f).length, 0);
  });

  it('is UNVERIFIED when there is no usable package.json', () => {
    const none = writeTemp({ 'README.md': '```sh\nnpm test\n```\n' });
    assert.equal(at(analyze(none), 2)[0]?.status, 'UNVERIFIED');
    const bad = writeTemp({ 'package.json': '{ not json', 'README.md': '```sh\nnpm test\n```\n' });
    const f = at(analyze(bad), 2)[0];
    assert.equal(f?.status, 'UNVERIFIED');
    assert.match(f?.message ?? '', /could not be parsed/);
  });

  it('checks commands in inline code and console blocks', () => {
    const dir = writeTemp({ 'package.json': pkg, 'README.md': 'Run `npm run nope` now.\n\n```console\n$ npm run nope2\nsome output\n```\n' });
    const f = fails(analyze(dir));
    assert.deepEqual(f.map((x) => x.line), [1, 4]);
  });

  it('skips blocks marked skip', () => {
    const dir = writeTemp({ 'package.json': pkg, 'README.md': '<!-- readmeproof: skip -->\n```sh\nnpm run nope\n```\n' });
    assert.equal(fails(analyze(dir)).length, 0);
  });
});

describe('referenced file checks', () => {
  it('checks interpreters and ./scripts', () => {
    const dir = writeTemp({
      'package.json': '{"name":"d"}',
      'scripts/a.js': '',
      'tool.py': '',
      'README.md': ['```sh', 'node scripts/a.js', 'node scripts/b.js', 'python tool.py', 'python3 -m http.server', 'node -e "1"', './run.sh', 'bash setup.sh --flag', '```'].join('\n') + '\n',
    });
    const f = analyze(dir);
    assert.equal(at(f, 2)[0]?.status, 'PASS');
    assert.equal(at(f, 3)[0]?.status, 'FAIL');
    assert.equal(at(f, 4)[0]?.status, 'PASS');
    assert.equal(at(f, 5).length, 0);
    assert.equal(at(f, 6).length, 0);
    assert.equal(at(f, 7)[0]?.status, 'FAIL');
    assert.equal(at(f, 8)[0]?.status, 'FAIL');
  });

  it('does not fail on files created by earlier README commands or build output', () => {
    const dir = writeTemp({
      'package.json': '{"name":"d"}',
      'README.md': ['```sh', 'echo "console.log(1)" > gen.js', 'node gen.js', 'node dist/cli.js', '```'].join('\n') + '\n',
    });
    const f = analyze(dir);
    assert.equal(at(f, 3)[0]?.status, 'UNVERIFIED');
    assert.equal(at(f, 4)[0]?.status, 'UNVERIFIED');
    assert.equal(fails(f).length, 0);
  });

  it('flags non-executable ./scripts on POSIX', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX file modes only');
      return;
    }
    const dir = writeTemp({ 'run.sh': '#!/bin/sh\n', 'README.md': '```sh\n./run.sh\n```\n' });
    chmodSync(path.join(dir, 'run.sh'), 0o644);
    assert.match(at(analyze(dir), 2)[0]?.message ?? '', /not executable/);
    chmodSync(path.join(dir, 'run.sh'), 0o755);
    assert.equal(at(analyze(dir), 2)[0]?.status, 'PASS');
  });

  it('refuses to follow traversal in command paths', () => {
    const dir = writeTemp({ 'README.md': '```sh\nnode ../../../../etc/x.js\n```\n' });
    assert.equal(at(analyze(dir), 2)[0]?.rule, 'path-traversal');
  });

  it('ignores prose that merely looks like a file (Node.js, and/or)', () => {
    const dir = writeTemp({ 'README.md': 'Works with `Node.js`, `and/or` `v1.2.3` and `Next.js`.\n' });
    assert.deepEqual(analyze(dir), []);
  });
});

describe('package name checks', () => {
  const base = { name: '@scope/widget', bin: { widget: 'cli.js' }, dependencies: { lodash: '1' } };
  const readme = (lines: string[]): string => ['```sh', ...lines, '```'].join('\n') + '\n';
  it('catches wrong scope, wrong case and typos where package.json proves the name', () => {
    const dir = writeTemp({
      'package.json': JSON.stringify(base),
      'README.md': readme(['npm install widget', 'npm i -g @other/widget', 'npm install @scope/widget', 'npm install @scope/widgit', 'npx widget --help', 'npx @scope/widget', 'npm install lodash', 'npm install react', 'pnpm add Widget@1.2.3']),
    });
    const f = analyze(dir);
    assert.equal(at(f, 2)[0]?.status, 'FAIL');
    assert.equal(at(f, 3)[0]?.status, 'FAIL');
    assert.equal(at(f, 4)[0]?.status, 'PASS');
    assert.equal(at(f, 5)[0]?.status, 'FAIL');
    assert.equal(at(f, 6).length, 0);
    assert.equal(at(f, 7)[0]?.status, 'PASS');
    assert.equal(at(f, 8).length, 0);
    assert.equal(at(f, 9).length, 0);
    assert.equal(at(f, 10)[0]?.status, 'FAIL');
    assert.match(at(f, 2)[0]?.fix ?? '', /@scope\/widget/);
  });
  it('checks imports in js blocks and ignores builtins/relative paths', () => {
    const dir = writeTemp({
      'package.json': JSON.stringify(base),
      'README.md': ['```js', "import fs from 'node:fs';", "import w from 'widget';", "const x = require('./local');", "import { a } from '@scope/widget/sub';", "import path from 'path';", '```'].join('\n') + '\n',
    });
    const f = analyze(dir);
    assert.equal(at(f, 3)[0]?.status, 'FAIL');
    assert.equal(at(f, 5)[0]?.status, 'PASS');
    assert.equal(at(f, 2).length + at(f, 4).length + at(f, 6).length, 0);
  });
  it('skips private packages and unreadable names', () => {
    const dir = writeTemp({ 'package.json': JSON.stringify({ ...base, private: true }), 'README.md': readme(['npm install widget']) });
    assert.equal(analyze(dir).length, 0);
  });
  it('parses package specs', () => {
    assert.equal(packageNameFromSpec('left-pad@1.0.0'), 'left-pad');
    assert.equal(packageNameFromSpec('@a/b@next'), '@a/b');
    assert.equal(packageNameFromSpec('user/repo'), undefined);
    assert.equal(packageNameFromSpec('./local'), undefined);
    assert.equal(packageNameFromSpec('github:a/b'), undefined);
    assert.equal(packageNameFromSpec('https://x.dev/a.tgz'), undefined);
    assert.equal(packageNameFromSpec('pkg.tgz'), undefined);
    assert.equal(packageNameFromSpec('-g'), undefined);
  });
  it('implements the mismatch heuristic conservatively', () => {
    assert.equal(isLikelyWrongName('widget', '@scope/widget'), true);
    assert.equal(isLikelyWrongName('widgit', 'widget'), true);
    assert.equal(isLikelyWrongName('react', '@scope/widget'), false);
    assert.equal(isLikelyWrongName('ab', 'ac'), false);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });
});

describe('annotation checks', () => {
  it('flags duplicate names and annotations on non-executable blocks', () => {
    const dir = writeTemp({
      'README.md': ['<!-- readmeproof: name=a -->', '```sh', 'true', '```', '', '<!-- readmeproof: name=a -->', '```sh', 'true', '```', '', '<!-- readmeproof: exit=0 -->', '```json', '{}', '```'].join('\n') + '\n',
    });
    const f = fails(analyze(dir));
    assert.deepEqual(f.map((x) => x.line), [6, 11]);
    assert.match(f[0]?.message ?? '', /already used at line 1/);
    assert.match(f[1]?.message ?? '', /cannot execute/);
  });
});

describe('static checking never executes anything', () => {
  it('does not run README commands or package scripts', () => {
    const dir = writeTemp({
      'package.json': JSON.stringify({ name: 'evil', scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'PWNED_SCRIPT\',\'x\')"', postinstall: 'touch PWNED_POST' } }),
      'README.md': '```sh\ntouch PWNED_README\nnpm run build\nnode evil.js\n```\n\n`npm run build`\n',
      'evil.js': "require('fs').writeFileSync('PWNED_NODE','x')",
    });
    analyze(dir);
    for (const marker of ['PWNED_README', 'PWNED_SCRIPT', 'PWNED_POST', 'PWNED_NODE']) {
      assert.equal(existsSync(path.join(dir, marker)), false, marker);
    }
  });
});

