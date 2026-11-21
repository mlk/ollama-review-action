import { info, warning } from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { buildFileDiff } from './diff';
import { parseInlineSeverity, parseSummarySha } from './render';
import { FileDiff, Finding, PullRequestContext, RepoContextFile, Severity } from './types';

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

function ownerRepo(): { owner: string; repo: string } {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  return { owner, repo };
}

interface PayloadPullRequest {
  head?: { sha?: string; ref?: string };
  base?: { ref?: string; sha?: string };
  title?: string;
  body?: string;
  user?: { login?: string };
}

export async function getPullRequestContext(
  octokit: ReturnType<typeof getOctokit>,
): Promise<PullRequestContext> {
  const { owner, repo } = ownerRepo();
  const payload = context.payload as Record<string, unknown>;
  const pullRequest = payload.pull_request as PayloadPullRequest | undefined;

  let number = context.issue.number;
  if (!number) {
    const ref = process.env.GITHUB_REF ?? '';
    const match = /refs\/pull\/(\d+)\//.exec(ref);
    if (match?.[1]) {
      number = Number.parseInt(match[1], 10);
    }
  }

  if (!number) {
    throw new Error(
      'This action must run on a pull_request (or pull_request_target) event - ' +
        'no pull request was found in the event payload.',
    );
  }

  if (pullRequest) {
    return {
      number,
      headSha: String(pullRequest.head?.sha ?? ''),
      baseSha: pullRequest.base?.sha,
      title: String(pullRequest.title ?? ''),
      body: String(pullRequest.body ?? ''),
      author: String(pullRequest.user?.login ?? 'unknown'),
      baseRef: String(pullRequest.base?.ref ?? ''),
      headRef: String(pullRequest.head?.ref ?? ''),
    };
  }

  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  return {
    number,
    headSha: data.head.sha,
    baseSha: data.base.sha,
    title: data.title,
    body: data.body ?? '',
    author: data.user?.login ?? 'unknown',
    baseRef: data.base.ref,
    headRef: data.head.ref,
  };
}

/**
 * Reads files from the repository at the given ref (the base commit, so a
 * contributor cannot steer the review by editing guidance in their own PR).
 * Missing or unreadable files are skipped - they are context, never worth
 * failing the review over.
 */
export async function fetchContextFiles(
  octokit: ReturnType<typeof getOctokit>,
  paths: string[],
  ref: string,
  maxChars: number,
): Promise<RepoContextFile[]> {
  const { owner, repo } = ownerRepo();
  const files: RepoContextFile[] = [];

  for (const path of paths) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

      if (Array.isArray(data) || data.type !== 'file') {
        info(`Skipping context file "${path}": not a regular file.`);
        continue;
      }
      if (!data.content) {
        info(`Skipping context file "${path}": no content returned (likely exceeds the 1 MB contents API limit).`);
        continue;
      }

      let content = Buffer.from(data.content, 'base64').toString('utf8').trim();
      if (content === '') {
        continue;
      }
      if (content.length > maxChars) {
        content = `${content.slice(0, maxChars)}\n[truncated]`;
      }

      files.push({ path, content });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        info(`Context file "${path}" not found at ${ref.slice(0, 7)}; skipping.`);
      } else {
        warning(`Could not read context file "${path}": ${(error as Error).message}`);
      }
    }
  }

  return files;
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export async function fetchChangedFiles(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
): Promise<FileDiff[]> {
  const { owner, repo } = ownerRepo();

  const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })) as ChangedFile[];

  return files.map((file) =>
    buildFileDiff({
      filename: file.filename,
      previous_filename: file.previous_filename ?? undefined,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? undefined,
    }),
  );
}

async function authenticatedLogin(
  octokit: ReturnType<typeof getOctokit>,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return data.login;
  } catch {
    return undefined;
  }
}

/** Finds the bot's own sticky comment carrying `marker`, if there is one. */
async function findStickyComment(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  marker: string,
) {
  const { owner, repo } = ownerRepo();
  const login = await authenticatedLogin(octokit);

  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });

  return existing
    .filter(
      (comment) =>
        comment.body?.includes(marker) && (login === undefined || comment.user?.login === login),
    )
    .pop();
}

/**
 * Returns the head commit SHA recorded in the sticky summary comment from the
 * previous run, or undefined when there is nothing to compare against (first
 * run, or the marker predates SHA recording).
 */
export async function fetchPreviousReviewSha(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  marker: string,
): Promise<string | undefined> {
  const previous = await findStickyComment(octokit, pullNumber, marker);
  if (!previous?.body) {
    return undefined;
  }
  return parseSummarySha(previous.body);
}

export interface CompareResult {
  /** True when every commit in `baseSha` is contained in `headSha` (history was not rewritten) and the file list is complete. */
  canIncrement: boolean;
  /** Why incrementing is not possible, when it is not. */
  reason?: 'rewritten' | 'truncated';
  /** Files that changed between the two commits. Only path fields are populated. */
  files: Array<{ filename: string; previous_filename?: string }>;
}

/** The compare API returns at most this many files; at the cap the list may be incomplete. */
export const COMPARE_FILE_LIMIT = 300;

/**
 * Compares two commits on the same branch. Used to find what changed since the
 * last review. A `basehead` of `base...head` compares the merge base against
 * `head`, so `behind_by > 0` means the PR branch no longer contains `baseSha`
 * - i.e. it was force-pushed or rebased, and the old review no longer maps
 * onto the current history.
 */
export async function compareCommitsSince(
  octokit: ReturnType<typeof getOctokit>,
  baseSha: string,
  headSha: string,
): Promise<CompareResult> {
  const { owner, repo } = ownerRepo();

  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
  });

  const behindBy = typeof data.behind_by === 'number' ? data.behind_by : 1;
  const files = (data.files ?? []).map((file) => ({
    filename: file.filename,
    previous_filename: file.previous_filename ?? undefined,
  }));

  if (behindBy !== 0) {
    return { canIncrement: false, reason: 'rewritten', files };
  }
  if (files.length >= COMPARE_FILE_LIMIT) {
    // The cap leaves no way to know whether files were dropped from the list.
    return { canIncrement: false, reason: 'truncated', files };
  }
  return { canIncrement: true, files };
}

/**
 * Posts the review summary as a sticky pull request comment.
 *
 * A review submitted through the pull request reviews API is immutable, so the
 * summary lives in an issue comment instead: that one can be edited in place
 * when the pull request is pushed to again.
 */
export async function upsertSummaryComment(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  body: string,
  marker: string,
): Promise<number> {
  const { owner, repo } = ownerRepo();

  const previous = await findStickyComment(octokit, pullNumber, marker);

  if (previous) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: previous.id,
      body,
    });
    info(`Updated summary comment ${data.id}.`);
    return data.id;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });

  info(`Created summary comment ${data.id}.`);
  return data.id;
}

/**
 * Removes the inline comments this action left on a previous run and posts the
 * current findings.
 *
 * When `onlyPaths` is given (incremental reviews), previous comments whose path
 * is not in the set are left alone: they belong to files that were not
 * re-reviewed, so their findings from the previous review are still current.
 * The severities of those kept comments are returned so callers can keep the
 * `fail_on` gate honest about findings that predate this run.
 */
export interface ReplaceInlineCommentsResult {
  /** Number of new inline comments posted. */
  posted: number;
  /** Severities of the kept comments whose path is outside `onlyPaths`; their findings still stand. */
  carriedSeverities: Severity[];
}

export async function replaceInlineComments(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  comments: ReviewComment[],
  marker: string,
  headSha: string,
  onlyPaths?: ReadonlySet<string>,
): Promise<ReplaceInlineCommentsResult> {
  const { owner, repo } = ownerRepo();
  const login = await authenticatedLogin(octokit);
  let carriedSeverities: Severity[] = [];

  try {
    const previous = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const mine = previous.filter(
      (comment) =>
        comment.body?.includes(marker) && (login === undefined || comment.user?.login === login),
    );

    const stale = onlyPaths
      ? mine.filter((comment) => (comment.path ? onlyPaths.has(comment.path) : true))
      : mine;
    const staleIds = new Set(stale.map((comment) => comment.id));
    const kept = mine.filter((comment) => !staleIds.has(comment.id));
    carriedSeverities = kept
      .map((comment) => parseInlineSeverity(comment.body ?? ''))
      .filter((severity): severity is Severity => severity !== undefined);

    for (const comment of stale) {
      try {
        await octokit.rest.pulls.deleteReviewComment({
          owner,
          repo,
          comment_id: comment.id,
        });
      } catch (error) {
        warning(
          `Could not remove the previous inline comment ${comment.id}: ${(error as Error).message}`,
        );
      }
    }

    if (stale.length > 0) {
      info(`Removed ${stale.length} inline comment(s) from the previous run.`);
    }
    if (kept.length > 0) {
      info(`Kept ${kept.length} inline comment(s) on files not re-reviewed in this run.`);
    }
  } catch (error) {
    warning(`Could not list previous inline comments: ${(error as Error).message}`);
  }

  for (const comment of comments) {
    const payload: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    };

    if (comment.start_line !== undefined) {
      payload.start_line = comment.start_line;
      payload.start_side = comment.start_side ?? 'RIGHT';
    }

    await octokit.rest.pulls.createReviewComment(payload);
  }

  info(`Posted ${comments.length} inline comment(s).`);
  return { posted: comments.length, carriedSeverities };
}

/**
 * Severities of the inline comments this action left on the pull request that
 * are still standing - used when a run posts nothing new but the `fail_on`
 * gate still has to account for findings from earlier runs.
 */
export async function fetchCarriedInlineSeverities(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  marker: string,
): Promise<Severity[]> {
  const { owner, repo } = ownerRepo();
  const login = await authenticatedLogin(octokit);

  try {
    const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    return comments
      .filter(
        (comment) =>
          comment.body?.includes(marker) &&
          (login === undefined || comment.user?.login === login),
      )
      .map((comment) => parseInlineSeverity(comment.body ?? ''))
      .filter((severity): severity is Severity => severity !== undefined);
  } catch (error) {
    warning(`Could not list previous inline comments: ${(error as Error).message}`);
    return [];
  }
}
/**
 * Maps model findings onto files and lines that GitHub actually accepts a
 * review comment on. Findings that cannot be anchored are returned separately
 * so they can still be shown in the summary.
 */
export function anchorFindings(
  findings: Finding[],
  diffs: FileDiff[],
): { anchored: Array<Finding & { diff: FileDiff }>; unanchored: Finding[] } {
  const byPath = new Map<string, FileDiff>();
  for (const diff of diffs) {
    byPath.set(diff.path, diff);
  }

  const anchored: Array<Finding & { diff: FileDiff }> = [];
  const unanchored: Finding[] = [];

  for (const finding of findings) {
    const normalized = finding.path.replace(/^[ab]\//, '');
    const diff = byPath.get(normalized) ?? byPath.get(finding.path);

    if (!diff) {
      unanchored.push(finding);
      continue;
    }

    if (diff.commentableLines.includes(finding.line)) {
      anchored.push({ ...finding, path: diff.path, diff });
      continue;
    }

    // Snap to the closest commentable line in the same file.
    const nearest = diff.commentableLines.reduce<number | undefined>((best, candidate) => {
      const distance = Math.abs(candidate - finding.line);
      if (best === undefined || distance < Math.abs(best - finding.line)) {
        return candidate;
      }
      return best;
    }, undefined);

    if (nearest !== undefined && Math.abs(nearest - finding.line) <= 5) {
      anchored.push({ ...finding, path: diff.path, line: nearest, end_line: undefined, diff });
      continue;
    }

    unanchored.push(finding);
  }

  return { anchored, unanchored };
}
