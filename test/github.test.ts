import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as github from '@actions/github';

import { anchorFindings, compareCommitsSince, fetchChangedFiles, fetchContextFiles, fetchPreviousReviewSha, getPullRequestContext, replaceInlineComments, upsertSummaryComment } from '../src/github';
import { buildFileDiff } from '../src/diff';
import { Finding } from '../src/types';

process.env.GITHUB_REPOSITORY = 'owner/repo';

interface FakeState {
  issueComments: Array<Record<string, unknown>>;
  reviewComments: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  created: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
  deleted: Array<Record<string, unknown>>;
}

function createOctokit(state: FakeState): ReturnType<typeof github.getOctokit> {
  const listIssueComments = async () => ({ data: state.issueComments });
  const listReviewComments = async () => ({ data: state.reviewComments });
  const listFiles = async () => ({ data: state.files });

  return {
    paginate: async (fn: () => Promise<{ data: unknown[] }>) => {
      const result = await fn();
      return result.data;
    },
    rest: {
      issues: {
        listComments: listIssueComments,
        createComment: async (params: Record<string, unknown>) => {
          state.created.push(params);
          return { data: { id: 100 } };
        },
        updateComment: async (params: Record<string, unknown>) => {
          state.updated.push(params);
          return { data: { id: params.comment_id } };
        },
      },
      pulls: {
        listReviewComments,
        listFiles,
        listReviews: async () => ({ data: [] }),
        get: async () => ({
          data: {
            head: { sha: 'sha-from-api', ref: 'feature' },
            base: { ref: 'main', sha: 'base-sha-from-api' },
            title: 'From the API',
            body: 'Body',
            user: { login: 'michael' },
          },
        }),
        deleteReviewComment: async (params: Record<string, unknown>) => {
          state.deleted.push(params);
          return {};
        },
        createReviewComment: async (params: Record<string, unknown>) => {
          state.created.push(params);
          return { data: { id: 200 } };
        },
      },
      users: {
        getAuthenticated: async () => ({ data: { login: 'bot' } }),
      },
    },
  } as unknown as ReturnType<typeof github.getOctokit>;
}

function emptyState(): FakeState {
  return { issueComments: [], reviewComments: [], files: [], created: [], updated: [], deleted: [] };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'src/app.ts',
    line: 2,
    severity: 'major',
    title: 't',
    body: 'b',
    ...overrides,
  };
}

const diff = buildFileDiff({
  filename: 'src/app.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1,3 +1,3 @@\n a\n+b\n c',
});

function octokitWithContent(files: Record<string, string>, failWith?: number): ReturnType<typeof github.getOctokit> {
  return {
    rest: {
      repos: {
        getContent: async (params: { path: string }) => {
          if (failWith !== undefined) {
            const error = new Error('request failed') as Error & { status?: number };
            error.status = failWith;
            throw error;
          }
          const content = files[params.path];
          if (content === undefined) {
            const error = new Error('Not Found') as Error & { status?: number };
            error.status = 404;
            throw error;
          }
          return {
            data: {
              type: 'file',
              content: Buffer.from(content, 'utf8').toString('base64'),
            },
          };
        },
      },
    },
  } as unknown as ReturnType<typeof github.getOctokit>;
}

describe('fetchContextFiles', () => {
  it('returns the decoded content of each requested file', async () => {
    const octokit = octokitWithContent({ 'AGENTS.md': 'house rules', 'README.md': 'readme body' });

    const files = await fetchContextFiles(octokit, ['AGENTS.md', 'README.md'], 'sha123', 12_000);

    assert.deepEqual(files, [
      { path: 'AGENTS.md', content: 'house rules' },
      { path: 'README.md', content: 'readme body' },
    ]);
  });

  it('skips files that do not exist', async () => {
    const octokit = octokitWithContent({ 'AGENTS.md': 'house rules' });

    const files = await fetchContextFiles(octokit, ['AGENTS.md', 'CONTRIBUTING.md'], 'sha123', 12_000);

    assert.deepEqual(
      files.map((file) => file.path),
      ['AGENTS.md'],
    );
  });

  it('truncates very large files', async () => {
    const octokit = octokitWithContent({ 'README.md': 'x'.repeat(20_000) });

    const files = await fetchContextFiles(octokit, ['README.md'], 'sha123', 12_000);

    assert.equal(files.length, 1);
    assert.ok(files[0]?.content.endsWith('[truncated]'));
    assert.ok((files[0]?.content.length ?? 0) < 20_000);
  });

  it('truncates to the maxChars argument when provided', async () => {
    const octokit = octokitWithContent({ 'README.md': 'x'.repeat(5000) });

    const files = await fetchContextFiles(octokit, ['README.md'], 'sha123', 100);

    assert.equal(files.length, 1);
    assert.ok(files[0]?.content.startsWith('x'.repeat(100)));
    assert.ok(files[0]?.content.endsWith('[truncated]'));
  });

  it('carries on when the API fails instead of 404ing', async () => {
    const octokit = octokitWithContent({ 'AGENTS.md': 'house rules' }, 500);

    const files = await fetchContextFiles(octokit, ['AGENTS.md'], 'sha123', 12_000);

    assert.deepEqual(files, []);
  });
});

describe('anchorFindings', () => {
  it('anchors a finding on a line that is in the diff', () => {
    const { anchored, unanchored } = anchorFindings([finding({ line: 2 })], [diff]);

    assert.equal(anchored.length, 1);
    assert.equal(unanchored.length, 0);
    assert.equal(anchored[0]?.path, 'src/app.ts');
  });

  it('accepts a path with an a/ or b/ prefix', () => {
    const { anchored } = anchorFindings([finding({ path: 'b/src/app.ts' })], [diff]);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0]?.path, 'src/app.ts');
  });

  it('leaves a finding for an unknown file unanchored', () => {
    const { anchored, unanchored } = anchorFindings([finding({ path: 'src/other.ts' })], [diff]);

    assert.equal(anchored.length, 0);
    assert.equal(unanchored.length, 1);
  });

  it('snaps a line just outside the diff to the nearest one', () => {
    const { anchored } = anchorFindings([finding({ line: 4 })], [diff]);

    assert.equal(anchored.length, 1);
    assert.equal(anchored[0]?.line, 3);
  });

  it('leaves a line far outside the diff unanchored', () => {
    const { anchored, unanchored } = anchorFindings([finding({ line: 500 })], [diff]);

    assert.equal(anchored.length, 0);
    assert.equal(unanchored.length, 1);
  });

  it('drops the end line when the finding is snapped', () => {
    const { anchored } = anchorFindings([finding({ line: 4, end_line: 6 })], [diff]);
    assert.equal(anchored[0]?.end_line, undefined);
  });
});

describe('fetchChangedFiles', () => {
  it('maps the API response into file diffs', async () => {
    const state = emptyState();
    state.files = [
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1,2 +1,3 @@\n a\n+b\n+c',
      },
    ];

    const files = await fetchChangedFiles(createOctokit(state), 1);

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, 'src/app.ts');
    assert.equal(files[0]?.status, 'modified');
    assert.deepEqual(files[0]?.commentableLines, [1, 2, 3]);
  });

  it('records the previous path of a renamed file', async () => {
    const state = emptyState();
    state.files = [
      {
        filename: 'src/new.ts',
        previous_filename: 'src/old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+a',
      },
    ];

    const files = await fetchChangedFiles(createOctokit(state), 1);
    assert.equal(files[0]?.previousPath, 'src/old.ts');
  });

  it('marks a file without a patch as truncated', async () => {
    const state = emptyState();
    state.files = [
      { filename: 'big.bin', status: 'modified', additions: 1, deletions: 0 },
    ];

    const files = await fetchChangedFiles(createOctokit(state), 1);
    assert.equal(files[0]?.truncated, true);
  });
});

describe('fetchPreviousReviewSha', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('returns the sha recorded in the summary comment marker', async () => {
    const state = emptyState();
    state.issueComments = [
      { id: 55, body: `<!-- ollama-review-action:summary:model=glm-5.3:sha=${sha} -->\nbody`, user: { login: 'bot' } },
    ];

    const result = await fetchPreviousReviewSha(createOctokit(state), 1, '<!-- ollama-review-action:summary');

    assert.equal(result, sha);
  });

  it('returns undefined when there is no summary comment', async () => {
    const state = emptyState();

    const result = await fetchPreviousReviewSha(createOctokit(state), 1, '<!-- ollama-review-action:summary');

    assert.equal(result, undefined);
  });

  it('returns undefined when the marker has no sha (written before sha recording)', async () => {
    const state = emptyState();
    state.issueComments = [
      { id: 55, body: '<!-- ollama-review-action:summary:model=glm-5.3 -->\nbody', user: { login: 'bot' } },
    ];

    const result = await fetchPreviousReviewSha(createOctokit(state), 1, '<!-- ollama-review-action:summary');

    assert.equal(result, undefined);
  });

  it('ignores a summary comment written by somebody else', async () => {
    const state = emptyState();
    state.issueComments = [
      { id: 55, body: `<!-- ollama-review-action:summary:model=glm-5.3:sha=${sha} -->`, user: { login: 'someone-else' } },
    ];

    const result = await fetchPreviousReviewSha(createOctokit(state), 1, '<!-- ollama-review-action:summary');

    assert.equal(result, undefined);
  });
});

describe('compareCommitsSince', () => {
  function octokitWithCompare(response: unknown): ReturnType<typeof github.getOctokit> {
    return {
      rest: {
        repos: {
          compareCommitsWithBasehead: async () => ({ data: response }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>;
  }

  it('reports incremental as safe when the head contains the base commit', async () => {
    const octokit = octokitWithCompare({
      status: 'ahead',
      behind_by: 0,
      files: [
        { filename: 'src/app.ts', status: 'modified' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
      ],
    });

    const result = await compareCommitsSince(octokit, 'base-sha', 'head-sha');

    assert.equal(result.canIncrement, true);
    assert.deepEqual(result.files, [
      { filename: 'src/app.ts', previous_filename: undefined },
      { filename: 'src/new.ts', previous_filename: 'src/old.ts' },
    ]);
  });

  it('reports incremental as unsafe when the history was rewritten', async () => {
    const octokit = octokitWithCompare({
      status: 'diverged',
      behind_by: 2,
      files: [{ filename: 'src/app.ts', status: 'modified' }],
    });

    const result = await compareCommitsSince(octokit, 'base-sha', 'head-sha');

    assert.equal(result.canIncrement, false);
    assert.equal(result.reason, 'rewritten');
  });

  it('treats a full page of compare files as unreliable', async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: 'modified',
    }));
    const octokit = octokitWithCompare({ status: 'ahead', behind_by: 0, files });

    const result = await compareCommitsSince(octokit, 'base-sha', 'head-sha');

    assert.equal(result.canIncrement, false);
    assert.equal(result.reason, 'truncated');
  });

  it('treats a missing behind_by as unsafe', async () => {
    const octokit = octokitWithCompare({ status: 'ahead', files: [] });

    const result = await compareCommitsSince(octokit, 'base-sha', 'head-sha');

    assert.equal(result.canIncrement, false);
  });
});

describe('upsertSummaryComment', () => {
  it('creates the comment when there is none', async () => {
    const state = emptyState();
    const id = await upsertSummaryComment(createOctokit(state), 1, 'body', '<!-- marker');

    assert.equal(id, 100);
    assert.equal(state.created.length, 1);
    assert.equal(state.updated.length, 0);
  });

  it('updates the existing comment instead of creating a second one', async () => {
    const state = emptyState();
    state.issueComments = [
      { id: 55, body: '<!-- marker -->old', user: { login: 'bot' } },
    ];

    const id = await upsertSummaryComment(createOctokit(state), 1, 'new body', '<!-- marker');

    assert.equal(id, 55);
    assert.equal(state.created.length, 0);
    assert.equal(state.updated.length, 1);
    assert.equal(state.updated[0]?.comment_id, 55);
  });

  it('ignores a comment written by somebody else', async () => {
    const state = emptyState();
    state.issueComments = [{ id: 55, body: '<!-- marker -->', user: { login: 'someone-else' } }];

    await upsertSummaryComment(createOctokit(state), 1, 'body', '<!-- marker');

    assert.equal(state.created.length, 1);
    assert.equal(state.updated.length, 0);
  });

  it('ignores a comment without the marker', async () => {
    const state = emptyState();
    state.issueComments = [{ id: 55, body: 'some other comment', user: { login: 'bot' } }];

    await upsertSummaryComment(createOctokit(state), 1, 'body', '<!-- marker');

    assert.equal(state.created.length, 1);
  });
});

describe('replaceInlineComments', () => {
  it('posts the new comments with the commit id and side', async () => {
    const state = emptyState();

    const result = await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'a finding' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(result.posted, 1);
    assert.deepEqual(result.carriedSeverities, []);
    assert.equal(state.created.length, 1);
    assert.equal(state.created[0]?.commit_id, 'sha123');
    assert.equal(state.created[0]?.path, 'src/app.ts');
    assert.equal(state.created[0]?.line, 2);
    assert.equal(state.created[0]?.side, 'RIGHT');
  });

  it('passes start_line and start_side for a multi-line comment', async () => {
    const state = emptyState();

    await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 5, start_line: 3, side: 'RIGHT', start_side: 'RIGHT', body: 'b' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(state.created[0]?.start_line, 3);
    assert.equal(state.created[0]?.start_side, 'RIGHT');
  });

  it('omits start_line for a single-line comment', async () => {
    const state = emptyState();

    await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'b' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(state.created[0]?.start_line, undefined);
  });

  it('deletes the comments left by the previous run', async () => {
    const state = emptyState();
    state.reviewComments = [
      { id: 11, body: '<!-- inline -->old finding', user: { login: 'bot' } },
      { id: 12, body: '<!-- inline -->another', user: { login: 'bot' } },
    ];

    await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'new' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(state.deleted.length, 2);
    assert.deepEqual(state.deleted.map((call) => call.comment_id), [11, 12]);
    assert.equal(state.created.length, 1);
  });

  it('leaves comments from other authors alone', async () => {
    const state = emptyState();
    state.reviewComments = [{ id: 11, body: '<!-- inline -->', user: { login: 'human' } }];

    await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'new' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(state.deleted.length, 0);
  });

  it('only replaces comments on the given paths, keeping the rest', async () => {
    const state = emptyState();
    state.reviewComments = [
      { id: 11, body: '<!-- inline -->stale finding', path: 'src/keep.ts', user: { login: 'bot' } },
      { id: 12, body: '<!-- inline -->stale finding', path: 'src/changed.ts', user: { login: 'bot' } },
    ];

    await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/changed.ts', line: 2, side: 'RIGHT', body: 'new' }],
      '<!-- inline -->',
      'sha123',
      new Set(['src/changed.ts']),
    );

    assert.deepEqual(state.deleted.map((call) => call.comment_id), [12]);
    assert.equal(state.created.length, 1);
  });

  it('reports the severities of the kept comments', async () => {
    const state = emptyState();
    state.reviewComments = [
      { id: 11, body: '**old** <!-- ollama-review-action:inline severity=critical -->', path: 'src/keep.ts', user: { login: 'bot' } },
      { id: 12, body: '**\u{1F534} `blocker` - old finding**\n\ntext\n\n<!-- ollama-review-action:inline severity=blocker -->', path: 'src/keep2.ts', user: { login: 'bot' } },
      { id: 13, body: '<!-- ollama-review-action:inline -->no severity here', path: 'src/keep3.ts', user: { login: 'bot' } },
      { id: 14, body: '<!-- ollama-review-action:inline severity=major -->', path: 'src/changed.ts', user: { login: 'bot' } },
    ];

    const result = await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/changed.ts', line: 2, side: 'RIGHT', body: 'new' }],
      '<!-- ollama-review-action:inline',
      'sha123',
      new Set(['src/changed.ts']),
    );

    assert.deepEqual(result.carriedSeverities, ['critical', 'blocker']);
  });
});

describe('getPullRequestContext', () => {
  let savedPayload: typeof github.context.payload;
  let savedRef: string | undefined;

  beforeEach(() => {
    savedPayload = github.context.payload;
    savedRef = process.env.GITHUB_REF;
  });

  it('reads the pull request from the event payload', async () => {
    github.context.payload = {
      number: 7,
      pull_request: {
        number: 7,
        title: 'A title',
        body: 'A body',
        head: { sha: 'sha', ref: 'feature' },
        base: { ref: 'main', sha: 'base-sha' },
        user: { login: 'michael' },
      },
    } as typeof github.context.payload;

    const context = await getPullRequestContext(createOctokit(emptyState()));

    assert.equal(context.number, 7);
    assert.equal(context.title, 'A title');
    assert.equal(context.headSha, 'sha');
    assert.equal(context.baseSha, 'base-sha');
    assert.equal(context.author, 'michael');

    github.context.payload = savedPayload;
    process.env.GITHUB_REF = savedRef;
  });

  it('reads the pull request from the API when the payload does not carry it', async () => {
    github.context.payload = { number: 7 } as typeof github.context.payload;

    const context = await getPullRequestContext(createOctokit(emptyState()));

    assert.equal(context.number, 7);
    assert.equal(context.headSha, 'sha-from-api');
    assert.equal(context.baseSha, 'base-sha-from-api');
    assert.equal(context.title, 'From the API');

    github.context.payload = savedPayload;
    process.env.GITHUB_REF = savedRef;
  });
});
