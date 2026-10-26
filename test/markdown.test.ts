import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseMarkdown, scanHtmlAttributes, slugify } from '../src/markdown.js';
import { fixturesDir } from './helpers.js';

const good = readFileSync(path.join(fixturesDir, 'good-project', 'README.md'), 'utf8');

describe('parseMarkdown on a realistic README', () => {
  const doc = parseMarkdown(good, 'README.md');

  it('finds every code block with exact line references', () => {
    assert.deepEqual(
      doc.blocks.map((b) => [b.line, b.endLine, b.language, b.annotation?.name]),
      [
        [18, 20, 'sh', undefined],
        [24, 26, 'sh', undefined],
        [33, 35, 'sh', 'quickstart'],
        [40, 43, 'bash', 'makefile'],
        [47, 49, 'sh', undefined],
        [53, 55, 'text', undefined],
      ],
    );
    assert.equal(doc.blocks[2]?.contentLine, 34);
    assert.equal(doc.blocks[2]?.content, 'node scripts/hello.js\n');
    assert.equal(doc.blocks[2]?.annotationLine, 32);
    assert.equal(doc.blocks[3]?.annotationLine, 39);
    assert.deepEqual(doc.blocks[3]?.annotation?.creates, ['out/result.txt']);
  });

  it('finds links and images with line numbers', () => {
    const summary = doc.links.map((l) => `${l.line}:${l.kind}:${l.href}`);
    assert.ok(summary.includes('3:image:assets/logo.png'));
    assert.ok(summary.includes('5:image:https://img.shields.io/npm/v/acme-cli.svg'));
    assert.ok(summary.includes('5:link:https://www.npmjs.com/package/acme-cli'));
    assert.ok(summary.includes('11:link:#install'));
    assert.ok(summary.includes('13:link:docs/guide.md#getting-started'));
    assert.ok(summary.includes('60:link:#configuration'));
    const ref = doc.links.find((l) => l.href === 'https://example.com/acme/changelog');
    assert.equal(ref?.approximateLine, true);
    assert.equal(ref?.line, 65);
  });

  it('computes GitHub-style heading slugs and html anchors', () => {
    assert.deepEqual(doc.headings.map((h) => h.slug), ['acme-cli', 'table-of-contents', 'install', 'quick-start', 'configuration']);
    assert.deepEqual(doc.htmlAnchors, ['configuration']);
    assert.equal(doc.headings[3]?.line, 28);
  });

  it('collects inline code with lines', () => {
    const texts = doc.inlineCode.map((c) => `${c.line}:${c.text}`);
    assert.ok(texts.includes('62:npm test'));
    assert.ok(texts.includes('63:scripts/hello.js'));
  });
});

describe('parseMarkdown details', () => {
  it('keeps line numbers stable across CRLF and lone CR line endings', () => {
    const lf = '# T\n\n```sh\necho 1\n```\n\n[x](a.md)\n';
    for (const eol of ['\r\n', '\r']) {
      const doc = parseMarkdown(lf.split('\n').join(eol), 'R.md');
      assert.equal(doc.blocks[0]?.line, 3, JSON.stringify(eol));
      assert.equal(doc.links[0]?.line, 7, JSON.stringify(eol));
    }
  });

  it('handles tilde fences, info strings and unclosed fences', () => {
    const doc = parseMarkdown('~~~Bash title="x"\nls\n~~~\n\n```js\nunclosed();\n', 'R.md');
    assert.equal(doc.blocks[0]?.language, 'bash');
    assert.equal(doc.blocks[0]?.info, 'Bash title="x"');
    assert.equal(doc.blocks[1]?.language, 'js');
    assert.equal(doc.blocks[1]?.content, 'unclosed();\n');
  });

  it('lists indented code blocks as non-fenced', () => {
    const doc = parseMarkdown('Intro\n\n    npm install\n    npm test\n\nEnd\n', 'R.md');
    assert.equal(doc.blocks.length, 1);
    assert.equal(doc.blocks[0]?.kind, 'indented');
    assert.equal(doc.blocks[0]?.line, 3);
    assert.equal(doc.blocks[0]?.language, '');
  });

  it('keeps accurate lines inside lists and block quotes', () => {
    const src = ['- item', '', '  ```sh', '  echo hi', '  ```', '', '> quote with [l](q.md)', '>', '> ```sh', '> echo q', '> ```'].join('\n');
    const doc = parseMarkdown(src, 'R.md');
    assert.deepEqual(doc.blocks.map((b) => b.line), [3, 9]);
    assert.equal(doc.blocks[0]?.content, 'echo hi\n');
    assert.equal(doc.links[0]?.line, 7);
  });

  it('attaches annotations inside list items', () => {
    const src = ['- step', '', '  <!-- readmeproof: name=in-list exit=0 -->', '  ```sh', '  true', '  ```'].join('\n');
    const doc = parseMarkdown(src, 'R.md');
    assert.equal(doc.blocks[0]?.annotation?.name, 'in-list');
  });

  it('does not attach an annotation separated from its block by other content', () => {
    const src = '<!-- readmeproof: name=a -->\n\nSome paragraph.\n\n```sh\ntrue\n```\n';
    const doc = parseMarkdown(src, 'R.md');
    assert.equal(doc.blocks[0]?.annotation, undefined);
    assert.equal(doc.annotationIssues.length, 1);
    assert.match(doc.annotationIssues[0]?.message ?? '', /not immediately followed/);
    assert.equal(doc.annotationIssues[0]?.line, 1);
  });

  it('reports malformed annotations and annotations on indented blocks', () => {
    const doc = parseMarkdown('<!-- readmeproof exit=0 -->\n\n```sh\ntrue\n```\n\n<!-- readmeproof: exit=0 -->\n\n    indented\n', 'R.md');
    assert.equal(doc.annotationIssues.length, 2);
    assert.match(doc.annotationIssues[0]?.message ?? '', /malformed/);
    assert.match(doc.annotationIssues[1]?.message ?? '', /indented/);
  });

  it('reports invalid annotation values per error', () => {
    const doc = parseMarkdown('<!-- readmeproof: exit=999 bogus=1 -->\n```sh\ntrue\n```\n', 'R.md');
    assert.equal(doc.blocks[0]?.annotation, undefined);
    assert.equal(doc.annotationIssues.length, 2);
  });

  it('discovers html src/href but ignores commented-out html', () => {
    const src = [
      '<p align="center"><img src="assets/logo.png" width=10></p>',
      '',
      '<a href=\'docs/a.md\'>a</a> and inline <img src="x.png"> text',
      '',
      '<!-- <img src="hidden.png"> -->',
    ].join('\n');
    const doc = parseMarkdown(src, 'R.md');
    assert.deepEqual(doc.links.map((l) => [l.href, l.kind, l.line]), [
      ['assets/logo.png', 'html-src', 1],
      ['docs/a.md', 'html-href', 3],
      ['x.png', 'html-src', 3],
    ]);
  });

  it('numbers duplicate headings like GitHub', () => {
    const doc = parseMarkdown('# A\n## Usage\n## Usage\n## Usage\n', 'R.md');
    assert.deepEqual(doc.headings.map((h) => h.slug), ['a', 'usage', 'usage-1', 'usage-2']);
  });

  it('locates links precisely in hard-wrapped paragraphs', () => {
    const doc = parseMarkdown('First line\nsecond [a](one.md)\nthird [b](two.md)\n', 'R.md');
    assert.deepEqual(doc.links.map((l) => l.line), [2, 3]);
  });
});

describe('helpers', () => {
  it('slugify matches GitHub for common headings', () => {
    assert.equal(slugify('Quick start'), 'quick-start');
    assert.equal(slugify('What is this? (FAQ)'), 'what-is-this-faq');
    const eAcute = String.fromCharCode(0xe9);
    const uUmlaut = String.fromCharCode(0xfc);
    assert.equal(slugify(`Caf${eAcute} ${String.fromCharCode(0xdc)}ber`), `caf${eAcute}-${uUmlaut}ber`);
    assert.equal(slugify('under_score-dash'), 'under_score-dash');
  });
  it('scanHtmlAttributes handles unquoted values and bounds input', () => {
    assert.equal(scanHtmlAttributes('<img src=a.png>')[0]?.href, 'a.png');
    const big = '<img src="a.png">'.repeat(100000);
    assert.ok(scanHtmlAttributes(big).length < 2000);
  });
});

