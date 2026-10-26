import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractShellCommands } from '../src/shell.js';

const texts = (c: ReturnType<typeof extractShellCommands>[number]): string[] => c.words.map((w) => w.text);

describe('extractShellCommands', () => {
  it('splits commands on && || ; and pipes and records lines', () => {
    const cmds = extractShellCommands('npm ci && npm test\nnode a.js | cat\necho hi; echo there', 10);
    assert.deepEqual(cmds.map(texts), [['npm', 'ci'], ['npm', 'test'], ['node', 'a.js'], ['cat'], ['echo', 'hi'], ['echo', 'there']]);
    assert.deepEqual(cmds.map((c) => c.line), [10, 10, 11, 11, 12, 12]);
  });

  it('handles quotes, escapes and comments', () => {
    const cmds = extractShellCommands("echo 'a  b' \"c d\" e\\ f # comment\n# only comment", 1);
    assert.deepEqual(cmds.map(texts), [['echo', 'a  b', 'c d', 'e f']]);
  });

  it('joins backslash continuations', () => {
    const bs = String.fromCharCode(92);
    const cmds = extractShellCommands(`npm run build ${bs}\n  --silent\nnpm test`, 5);
    assert.deepEqual(cmds.map(texts), [['npm', 'run', 'build', '--silent'], ['npm', 'test']]);
    assert.equal(cmds[1]?.line, 7);
  });

  it('treats $ prompt blocks as transcripts and ignores output lines', () => {
    const cmds = extractShellCommands('$ npm install foo\nadded 1 package\n$ node x.js', 1);
    assert.deepEqual(cmds.map(texts), [['npm', 'install', 'foo'], ['node', 'x.js']]);
    assert.deepEqual(cmds.map((c) => c.line), [1, 3]);
  });

  it('skips heredoc bodies', () => {
    const cmds = extractShellCommands("cat <<'EOF' > a.txt\nnpm run secret\nEOF\nnpm test", 1);
    assert.deepEqual(cmds.map((c) => texts(c)[0]), ['cat', 'npm']);
    assert.ok(!cmds.some((c) => texts(c).includes('secret')));
    assert.equal(cmds[1]?.line, 4);
  });

  it('strips env assignments and sudo prefixes', () => {
    const cmds = extractShellCommands('CI=1 NODE_ENV=test npm test\nsudo npm install -g x', 1);
    assert.deepEqual(cmds.map(texts), [['npm', 'test'], ['npm', 'install', '-g', 'x']]);
  });

  it('marks dynamic words and never expands anything', () => {
    const [cmd] = extractShellCommands('node "$HOME/x.js" $(whoami) *.js ~/y', 1);
    assert.ok(cmd);
    assert.deepEqual(cmd.words.map((w) => w.dynamic), [false, true, true, true, true]);
    assert.equal(cmd.words[1]?.text, '$HOME/x.js');
  });

  it('flags commands after cd', () => {
    const cmds = extractShellCommands('cd sub\nnpm test', 1);
    assert.equal(cmds[0]?.cwdChanged, false);
    assert.equal(cmds[1]?.cwdChanged, true);
    const same = extractShellCommands('cd sub && npm test', 1);
    assert.equal(same[1]?.cwdChanged, true);
  });

  it('stays bounded on pathological input', () => {
    const long = 'a '.repeat(100000);
    const cmds = extractShellCommands(long, 1);
    assert.ok((cmds[0]?.words.length ?? 0) <= 200);
    const many = Array.from({ length: 20000 }, () => 'echo x').join('\n');
    assert.ok(extractShellCommands(many, 1).length <= 5000);
    assert.doesNotThrow(() => extractShellCommands("echo '" + 'x'.repeat(10000), 1));
  });
});

