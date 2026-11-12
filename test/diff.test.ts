import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFileDiff, chunkDiffs, globToRegExp, matchesAnyGlob, parsePatch, renderDiff } from '../src/diff';

describe('parsePatch', () => {
  it('tracks new and old line numbers across hunks', () => {
    const patch = [
      '@@ -10,7 +10,9 @@ class Foo {',
      '   const a = 1;',
      '-  const b = 2;',
      '+  const b = 3;',
      '+  const c = 4;',
      '   return a;',
      ' }',
    ].join('\n');

    const lines = parsePatch(patch);

    assert.equal(lines[0]?.kind, 'hunk');
    assert.deepEqual(
      lines.slice(1).map((line) => [line.kind, line.newLine, line.oldLine]),
      [
        ['ctx', 10, 10],
        ['del', undefined, 11],
        ['add', 11, undefined],
        ['add', 12, undefined],
        ['ctx', 13, 12],
        ['ctx', 14, 13],
      ],
    );
  });

  it('handles multiple hunks with independent counters', () => {
    const patch = ['@@ -1,2 +1,2 @@', '-a', '+b', '@@ -50,2 +50,3 @@', ' c', '+d', ' e'].join('\n');

    const lines = parsePatch(patch);

    assert.equal(lines.filter((line) => line.kind === 'add')[0]?.newLine, 1);
    assert.equal(lines.filter((line) => line.kind === 'add')[1]?.newLine, 51);
    assert.equal(lines.filter((line) => line.kind === 'ctx')[1]?.newLine, 52);
  });

  it('ignores the no-newline marker', () => {
    const lines = parsePatch('@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file');
    assert.equal(lines.length, 3);
  });
});

describe('buildFileDiff', () => {
  it('collects the lines GitHub accepts comments on', () => {
    const diff = buildFileDiff({
      filename: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d',
    });

    assert.deepEqual(diff.commentableLines, [1, 2, 3]);
    assert.equal(diff.truncated, false);
  });

  it('marks a missing patch as truncated', () => {
    const diff = buildFileDiff({
      filename: 'big.bin',
      status: 'modified',
      additions: 10,
      deletions: 10,
    });

    assert.equal(diff.truncated, true);
    assert.deepEqual(diff.commentableLines, []);
  });
});

describe('renderDiff', () => {
  it('prefixes every new-file line with its line number', () => {
    const diff = buildFileDiff({
      filename: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d',
    });

    const rendered = renderDiff([diff]);

    assert.match(rendered, /### src\/app\.ts {2}\(modified, \+1\/-1\)/);
    assert.match(rendered, /^ {5}2 \| \+c$/m);
    assert.match(rendered, /^ {7}\| -b$/m);
    assert.match(rendered, /^ {5}1 \| {2}a$/m);
  });
});

describe('globToRegExp', () => {
  it('matches a single segment', () => {
    assert.ok(globToRegExp('*.lock').test('yarn.lock'));
    assert.ok(!globToRegExp('*.lock').test('a/yarn.lock'));
  });

  it('matches any depth with **', () => {
    assert.ok(globToRegExp('**/*.lock').test('a/b/yarn.lock'));
    assert.ok(globToRegExp('dist/**').test('dist/a/b.js'));
    assert.ok(globToRegExp('**/*.ts').test('src/a/b.ts'));
  });

  it('escapes regex metacharacters', () => {
    assert.ok(globToRegExp('a+b.txt').test('a+b.txt'));
    assert.ok(!globToRegExp('a+b.txt').test('aab.txt'));
  });
});

describe('matchesAnyGlob', () => {
  it('returns false for an empty pattern list', () => {
    assert.equal(matchesAnyGlob('src/app.ts', []), false);
  });

  it('returns true when any pattern matches', () => {
    assert.equal(matchesAnyGlob('dist/app.js', ['**/*.ts', 'dist/**']), true);
  });
});

describe('chunkDiffs', () => {
  it('keeps small diffs in a single chunk', () => {
    const diffs = [
      buildFileDiff({ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' }),
      buildFileDiff({ filename: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+b' }),
    ];

    assert.equal(chunkDiffs(diffs, 100_000).length, 1);
  });

  it('splits diffs that exceed the budget', () => {
    const diffs = Array.from({ length: 10 }, (_, index) =>
      buildFileDiff({
        filename: `file-${index}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: `@@ -1 +1 @@\n+${'x'.repeat(200)}`,
      }),
    );

    const chunks = chunkDiffs(diffs, 500);

    assert.ok(chunks.length > 1);
    assert.equal(chunks.flat().length, 10);
  });

  it('puts an oversized file in a chunk of its own', () => {
    const diffs = [
      buildFileDiff({ filename: 'huge.ts', status: 'modified', additions: 1, deletions: 0, patch: `@@ -1 +1 @@\n+${'x'.repeat(5000)}` }),
    ];

    const chunks = chunkDiffs(diffs, 100);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.length, 1);
  });
});
