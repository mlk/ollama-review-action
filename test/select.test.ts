import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFileDiff } from '../src/diff';
import { selectFiles } from '../src/select';
import { FileDiff } from '../src/types';

function diff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  const base = buildFileDiff({
    filename: path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1,2 +1,2 @@\n a\n+b',
  });

  return { ...base, ...overrides };
}

describe('selectFiles', () => {
  it('keeps a normal file', () => {
    const selected = selectFiles([diff('src/app.ts')], [], 50);
    assert.equal(selected.length, 1);
  });

  it('skips deleted files', () => {
    const selected = selectFiles([diff('src/gone.ts', { status: 'removed' })], [], 50);
    assert.equal(selected.length, 0);
  });

  it('skips excluded paths', () => {
    const selected = selectFiles(
      [diff('src/app.ts'), diff('yarn.lock'), diff('dist/bundle.js')],
      ['**/*.lock', 'dist/**'],
      50,
    );

    assert.deepEqual(selected.map((file) => file.path), ['src/app.ts']);
  });

  it('skips files whose patch GitHub did not return', () => {
    const selected = selectFiles([diff('big.bin', { truncated: true })], [], 50);
    assert.equal(selected.length, 0);
  });

  it('skips files with no reviewable lines', () => {
    const selected = selectFiles([diff('empty.ts', { commentableLines: [] })], [], 50);
    assert.equal(selected.length, 0);
  });

  it('caps the number of files', () => {
    const files = Array.from({ length: 10 }, (_, index) => diff(`file-${index}.ts`));
    const selected = selectFiles(files, [], 3);

    assert.equal(selected.length, 3);
    assert.equal(selected[0]?.path, 'file-0.ts');
  });

  it('keeps everything when under the cap', () => {
    const files = Array.from({ length: 3 }, (_, index) => diff(`file-${index}.ts`));
    assert.equal(selectFiles(files, [], 3).length, 3);
  });
});
