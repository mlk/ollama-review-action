import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as github from '@actions/github';

import { anchorFindings, fetchChangedFiles, getPullRequestContext, replaceInlineComments, upsertSummaryComment } from '../src/github';
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

    const count = await replaceInlineComments(
      createOctokit(state),
      1,
      [{ path: 'src/app.ts', line: 2, side: 'RIGHT', body: 'a finding' }],
      '<!-- inline -->',
      'sha123',
    );

    assert.equal(count, 1);
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
        base: { ref: 'main' },
        user: { login: 'michael' },
      },
    } as typeof github.context.payload;

    const context = await getPullRequestContext(createOctokit(emptyState()));

    assert.equal(context.number, 7);
    assert.equal(context.title, 'A title');
    assert.equal(context.headSha, 'sha');
    assert.equal(context.author, 'michael');

    github.context.payload = savedPayload;
    process.env.GITHUB_REF = savedRef;
  });
});
