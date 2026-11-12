import { DiffLine, FileDiff } from './types';

/**
 * Parses a raw unified diff (as returned by the GitHub API in `patch`) into
 * structured lines, tracking line numbers in both the old and the new revision.
 */
export function parsePatch(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] as string, 10);
      newLine = Number.parseInt(hunk[3] as string, 10);
      inHunk = true;
      result.push({ kind: 'hunk', content: raw, hunkHeader: raw });
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue;
    }

    // "\ No newline at end of file" - carries no content.
    if (raw.startsWith('\\')) {
      continue;
    }

    if (raw.startsWith('+')) {
      result.push({ kind: 'add', content: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      result.push({ kind: 'del', content: raw.slice(1), oldLine });
      oldLine += 1;
    } else {
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      result.push({ kind: 'ctx', content, newLine, oldLine });
      newLine += 1;
      oldLine += 1;
    }
  }

  return result;
}

export function buildFileDiff(file: {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}): FileDiff {
  const patch = file.patch;
  const truncated = patch === undefined || patch === null || patch.trim() === '';
  const lines = truncated ? [] : parsePatch(patch);

  const commentable = new Set<number>();
  for (const line of lines) {
    if ((line.kind === 'add' || line.kind === 'ctx') && line.newLine !== undefined) {
      commentable.add(line.newLine);
    }
  }

  const diff: FileDiff = {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    lines,
    commentableLines: [...commentable].sort((a, b) => a - b),
    truncated,
  };

  if (file.previous_filename) {
    diff.previousPath = file.previous_filename;
  }

  return diff;
}

/**
 * Renders the diff in a form that is easy for a model to reason about: every
 * line is prefixed with its line number in the new revision of the file.
 */
export function renderDiff(diffs: FileDiff[]): string {
  const chunks: string[] = [];

  for (const diff of diffs) {
    const header = `### ${diff.path}  (${diff.status}, +${diff.additions}/-${diff.deletions})`;
    const body: string[] = [header];

    for (const line of diff.lines) {
      if (line.kind === 'hunk') {
        body.push(line.hunkHeader ?? '');
        continue;
      }
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const number = line.kind === 'del' ? '' : String(line.newLine ?? '');
      body.push(`${number.padStart(6)} | ${marker}${line.content}`);
    }

    chunks.push(body.join('\n'));
  }

  return chunks.join('\n\n');
}

/** Converts a glob pattern into a regular expression supporting `**`, `*` and `?`. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += '.+^${}()|[]\\'.includes(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${source}$`);
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * Splits the diff into chunks that each fit inside `maxChars`, so that large
 * pull requests are reviewed over several requests instead of being truncated.
 */
export function chunkDiffs(diffs: FileDiff[], maxChars: number): FileDiff[][] {
  const chunks: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let currentSize = 0;

  for (const diff of diffs) {
    const size = renderDiff([diff]).length;

    if (size > maxChars) {
      // A single file larger than the budget: keep it on its own and let the
      // caller truncate the rendered text.
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }
      chunks.push([diff]);
      continue;
    }

    if (currentSize + size > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(diff);
    currentSize += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/** Truncates a rendered diff to `maxChars`, keeping the head of the text. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const notice = `\n... [diff truncated at ${maxChars} characters] ...\n`;
  return text.slice(0, Math.max(0, maxChars - notice.length)) + notice;
}
