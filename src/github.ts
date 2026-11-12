import { info, warning } from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { buildFileDiff } from './diff';
import { FileDiff, Finding, PullRequestContext } from './types';

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
  base?: { ref?: string };
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
    title: data.title,
    body: data.body ?? '',
    author: data.user?.login ?? 'unknown',
    baseRef: data.base.ref,
    headRef: data.head.ref,
  };
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
  const login = await authenticatedLogin(octokit);

  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });

  const previous = existing
    .filter(
      (comment) =>
        comment.body?.includes(marker) && (login === undefined || comment.user?.login === login),
    )
    .pop();

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
 */
export async function replaceInlineComments(
  octokit: ReturnType<typeof getOctokit>,
  pullNumber: number,
  comments: ReviewComment[],
  marker: string,
  headSha: string,
): Promise<number> {
  const { owner, repo } = ownerRepo();
  const login = await authenticatedLogin(octokit);

  try {
    const previous = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const stale = previous.filter(
      (comment) =>
        comment.body?.includes(marker) && (login === undefined || comment.user?.login === login),
    );

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
  return comments.length;
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
