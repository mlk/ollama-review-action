import * as core from '@actions/core';
import * as github from '@actions/github';

import { buildFileDiff } from './diff';
import { FileDiff, Finding, PullRequestContext } from './types';

const { context } = github;

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

export interface ReviewPayload {
  body: string;
  comments: ReviewComment[];
  marker: string;
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
  octokit: ReturnType<typeof github.getOctokit>,
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
  octokit: ReturnType<typeof github.getOctokit>,
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
  octokit: ReturnType<typeof github.getOctokit>,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return data.login;
  } catch {
    return undefined;
  }
}

/**
 * Creates the pull request review, or updates the previous review left by this
 * action when the pull request already has one (so repeated pushes do not spam
 * the conversation).
 */
export async function postReview(
  octokit: ReturnType<typeof github.getOctokit>,
  pullNumber: number,
  payload: ReviewPayload,
): Promise<number> {
  const { owner, repo } = ownerRepo();

  try {
    const login = await authenticatedLogin(octokit);
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const previous = [...reviews]
      .reverse()
      .find(
        (review) =>
          review.body?.includes(payload.marker) &&
          (login === undefined || review.user?.login === login),
      );

    if (previous) {
      try {
        const { data } = await octokit.rest.pulls.updateReview({
          owner,
          repo,
          pull_number: pullNumber,
          review_id: previous.id,
          body: payload.body,
          comments: payload.comments,
        });
        core.info(`Updated existing review ${data.id}.`);
        return data.id;
      } catch (error) {
        core.warning(
          `Could not update review ${previous.id} (${(error as Error).message}); creating a new one.`,
        );
      }
    }
  } catch (error) {
    core.debug(`Skipping review lookup: ${(error as Error).message}`);
  }

  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: 'COMMENT',
    body: payload.body,
    comments: payload.comments,
  });

  core.info(`Created review ${data.id}.`);
  return data.id;
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
