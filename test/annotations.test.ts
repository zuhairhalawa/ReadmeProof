import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractAnnotationBody,
  hasAssertions,
  looksLikeAnnotation,
  parseAnnotationBody,
  validateCreatesPath,
} from '../src/annotations.js';

describe('extractAnnotationBody', () => {
  it('extracts the body of a readmeproof comment', () => {
    assert.equal(extractAnnotationBody('<!-- readmeproof: name=a -->'), ' name=a');
    assert.equal(extractAnnotationBody('<!--readmeproof:name=a-->\n'), 'name=a');
  });
  it('ignores other comments and html', () => {
    assert.equal(extractAnnotationBody('<!-- TODO -->'), undefined);
    assert.equal(extractAnnotationBody('<div>readmeproof:</div>'), undefined);
    assert.equal(extractAnnotationBody('<!-- readmeproof: a=b --> trailing'), undefined);
  });
  it('flags near-miss comments so typos are reported', () => {
    assert.equal(looksLikeAnnotation('<!-- readmeproof name=a -->'), true);
    assert.equal(looksLikeAnnotation('<!-- ReadmeProof: name=a -->'), true);
    assert.equal(looksLikeAnnotation('<!-- other -->'), false);
  });
});

describe('parseAnnotationBody', () => {
  it('parses every supported key', () => {
    const { annotation, errors } = parseAnnotationBody(
      ' name=quick.start-1 exit=3 output="hello world" output-exact="a\\nb" stderr=oops creates="out/a.txt, b.txt" timeout=30 skip',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(annotation, {
      name: 'quick.start-1',
      exit: 3,
      output: 'hello world',
      outputExact: 'a\nb',
      stderr: 'oops',
      creates: ['out/a.txt', 'b.txt'],
      timeoutSec: 30,
      skip: true,
    });
  });

  it('handles escaped quotes and backslashes in quoted values', () => {
    const { annotation, errors } = parseAnnotationBody(' output="say \\"hi\\" C:\\\\dir"');
    assert.deepEqual(errors, []);
    assert.equal(annotation.output, 'say "hi" C:\\dir');
  });

  it('reports unknown keys, duplicates and bad values', () => {
    const r = parseAnnotationBody(' nme=x exit=300 exit=1 timeout=0 name=-bad');
    assert.ok(r.errors.some((e) => e.includes('unknown key "nme"')));
    assert.ok(r.errors.some((e) => e.includes('"exit" must be an integer')));
    assert.ok(r.errors.some((e) => e.includes('duplicate key "exit"')));
    assert.ok(r.errors.some((e) => e.includes('"timeout"')));
    assert.ok(r.errors.some((e) => e.includes('"name"')));
  });

  it('rejects unterminated quotes, stray characters and bad escapes', () => {
    assert.ok(parseAnnotationBody(' output="abc').errors[0]?.includes('unterminated'));
    assert.ok(parseAnnotationBody(' =oops').errors[0]?.includes('unexpected character'));
    assert.ok(parseAnnotationBody(' output="a\\qb"').errors[0]?.includes('unsupported escape'));
    assert.ok(parseAnnotationBody(' output=a"b').errors[0]?.includes('quote'));
  });

  it('refuses annotations that try to escalate privileges', () => {
    for (const key of ['network', 'image', 'mount', 'env', 'privileged', 'volume', 'user']) {
      const r = parseAnnotationBody(` ${key}=true`);
      assert.ok(r.errors.some((e) => e.includes(`unknown key "${key}"`)), key);
    }
  });

  it('rejects oversized annotations', () => {
    const r = parseAnnotationBody(' output=' + 'a'.repeat(5000));
    assert.equal(r.errors.length, 1);
    const q = parseAnnotationBody(' output="' + 'a'.repeat(3000) + '"');
    assert.ok(q.errors[0]?.includes('longer'));
  });

  it('validates creates paths', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'C:/x', '..', "a'b", 'a\\..\\b']) {
      assert.notEqual(validateCreatesPath(bad), undefined, bad);
    }
    assert.equal(validateCreatesPath('out/result.txt'), undefined);
    assert.ok(parseAnnotationBody(' creates=../x').errors[0]?.includes('".."'));
    const many = Array.from({ length: 25 }, (_, i) => `f${i}`).join(',');
    assert.ok(parseAnnotationBody(` creates=${many}`).errors[0]?.includes('more than'));
  });

  it('treats skip as a flag only', () => {
    assert.ok(parseAnnotationBody(' skip=no').errors[0]?.includes('flag'));
  });
});

describe('hasAssertions', () => {
  it('is false for name/timeout/skip only', () => {
    assert.equal(hasAssertions(undefined), false);
    assert.equal(hasAssertions({ name: 'a', timeoutSec: 5, skip: true }), false);
  });
  it('is true for any behavioural assertion', () => {
    assert.equal(hasAssertions({ exit: 0 }), true);
    assert.equal(hasAssertions({ output: 'x' }), true);
    assert.equal(hasAssertions({ creates: ['a'] }), true);
    assert.equal(hasAssertions({ stderr: 'a' }), true);
    assert.equal(hasAssertions({ outputExact: '' }), true);
  });
});

