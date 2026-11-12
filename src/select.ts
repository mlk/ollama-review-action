import { info, warning } from '@actions/core';

import { matchesAnyGlob } from './diff';
import { FileDiff } from './types';

/**
 * Picks the files worth sending to the model: not deleted, not excluded by
 * pattern, and not missing a patch (GitHub omits patches for very large
 * diffs, and there is nothing to review in those files).
 */
export function selectFiles(
  diffs: FileDiff[],
  excludePaths: string[],
  maxFiles: number,
): FileDiff[] {
  const selected: FileDiff[] = [];

  for (const diff of diffs) {
    if (diff.status === 'removed') {
      continue;
    }
    if (excludePaths.length > 0 && matchesAnyGlob(diff.path, excludePaths)) {
      info(`Skipping excluded path: ${diff.path}`);
      continue;
    }
    if (diff.truncated) {
      info(`Skipping ${diff.path}: GitHub did not return a patch for it.`);
      continue;
    }
    if (diff.commentableLines.length === 0) {
      info(`Skipping ${diff.path}: no reviewable lines in the diff.`);
      continue;
    }
    selected.push(diff);
  }

  if (selected.length > maxFiles) {
    warning(
      `Reviewing the first ${maxFiles} of ${selected.length} changed files (input "max_files").`,
    );
    return selected.slice(0, maxFiles);
  }

  return selected;
}
