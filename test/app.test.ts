import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as github from '@actions/github';

import { Deps, Octokit, run } from '../src/app';
import { Config } from '../src/config';

process.env.GITHUB_REPOSITORY = 'owner/repo';

interface Recorded {
  outputs: Record<string, unknown>;
  failures: string[];
  summaries: string[];
  warnings: string[];
  created: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
  deleted: Array<Record<string, unknown>>;
  prompts: string[];
}

let recorded: Recorded;

function emptyRecorded(): Recorded {
  return {
    outputs: {},
    failures: [],
    summaries: [],
    warnings: [],
    created: [],
    updated: [],
    deleted: [],
    prompts: [],
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    model: 'glm-5.3',
    apiKey: 'key',
    host: 'https://ollama.com',
    token: 'token',
    extraPrompt: '',
    maxDiffChars: 60000,
    maxFiles: 50,
    excludePaths: [],
    reasoningEffort: '',
    temperature: 0.2,
    failOn: 'none',
    postReview: true,
    ...overrides,
  };
}

function makeOctokit(state: Recorded, files: Array<Record<string, unknown>>): Octokit {
  const listIssueComments = async () => ({ data: [] });
  const listReviewComments = async () => ({ data: [] });
  const listFiles = async () => ({ data: files });

  return {
    paginate: async (fn: () => Promise<{ data: unknown[] }>) => (await fn()).data,
    rest: {
      issues: {
        listComments: listIssueComments,
        createComment: async (params: Record<string, unknown>) => {
          state.created.push(params);
          return { data: { id: 100 } };
        },
        updateComment: async (params: Record<string, unknown>) => {
          state.updated.push(params);
          return { data: { id: 100 } };
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
  } as unknown as Octokit;
}

function deps(
  state: Recorded,
  overrides: Partial<Deps> = {},
  files: Array<Record<string, unknown>> = [],
): Deps {
  return {
    loadConfig: () => config(),
    getOctokit: () => makeOctokit(state, files),
    chat: async (_options, messages) => {
      state.prompts.push(messages[1]?.content ?? '');
      return JSON.stringify({
        summary: 'Looks fine.',
        findings: [
          {
            path: 'src/app.ts',
            line: 2,
            severity: 'major',
            title: 'Something is wrong',
            body: 'Here is why.',
          },
        ],
      });
    },
    info: () => {},
    warning: (message) => state.warnings.push(message),
    debug: () => {},
    setOutput: (name, value) => {
      state.outputs[name] = value;
    },
    setFailed: (message) => state.failures.push(message),
    writeSummary: async (body) => {
      state.summaries.push(body);
    },
    ...overrides,
  };
}

const oneFile = [
  {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1,3 +1,3 @@\n a\n+b\n c',
  },
];

beforeEach(() => {
  recorded = emptyRecorded();
  github.context.payload = {
    number: 7,
    pull_request: {
      number: 7,
      title: 'A title',
      body: 'A body',
      head: { sha: 'sha123', ref: 'feature' },
      base: { ref: 'main' },
      user: { login: 'michael' },
    },
  } as typeof github.context.payload;
});

describe('run', () => {
  it('posts the summary and the inline findings', async () => {
    await run(deps(recorded, {}, oneFile));

    const summary = recorded.created.find((call) => 'issue_number' in call);
    assert.ok(summary, 'expected a summary comment');
    assert.match(String(summary.body), /## Ollama review/);

    const inline = recorded.created.filter((call) => 'path' in call);
    assert.equal(inline.length, 1);
    assert.equal(inline[0]?.path, 'src/app.ts');
    assert.equal(inline[0]?.line, 2);
    assert.equal(inline[0]?.commit_id, 'sha123');
  });

  it('sets the documented outputs', async () => {
    await run(deps(recorded, {}, oneFile));

    assert.equal(recorded.outputs.summary, 'Looks fine.');
    assert.equal(recorded.outputs.findings_count, 1);
    assert.equal(recorded.outputs.comment_id, '100');
    assert.equal(recorded.outputs.failed, 'false');
  });

  it('writes the job summary', async () => {
    await run(deps(recorded, {}, oneFile));
    assert.equal(recorded.summaries.length, 1);
  });

  it('fails the job when a finding reaches the fail_on threshold', async () => {
    await run(
      deps(
        recorded,
        { loadConfig: () => config({ failOn: 'major' }) },
        oneFile,
      ),
    );

    assert.equal(recorded.outputs.failed, 'true');
    assert.equal(recorded.failures.length, 1);
    assert.match(recorded.failures[0] ?? '', /major severity issue/);
  });

  it('does not fail when nothing reaches the threshold', async () => {
    await run(
      deps(
        recorded,
        { loadConfig: () => config({ failOn: 'critical' }) },
        oneFile,
      ),
    );

    assert.equal(recorded.outputs.failed, 'false');
    assert.equal(recorded.failures.length, 0);
  });

  it('does nothing when there are no changed files', async () => {
    await run(deps(recorded, {}, []));

    assert.equal(recorded.created.length, 0);
    assert.equal(recorded.outputs.summary, undefined);
  });

  it('does nothing when every file is filtered out', async () => {
    await run(
      deps(
        recorded,
        { loadConfig: () => config({ excludePaths: ['**/*.ts'] }) },
        oneFile,
      ),
    );

    assert.equal(recorded.created.length, 0);
  });

  it('does not post when post_review is false', async () => {
    await run(deps(recorded, { loadConfig: () => config({ postReview: false }) }, oneFile));

    assert.equal(recorded.created.length, 0);
    assert.equal(recorded.outputs.findings_count, 1);
  });

  it('warns but carries on when a chunk cannot be parsed', async () => {
    await run(
      deps(
        recorded,
        {
          chat: async () => 'this is not json',
        },
        oneFile,
      ),
    );

    assert.equal(recorded.warnings.length, 1);
    assert.match(recorded.warnings[0] ?? '', /Could not parse the model response/);
    assert.equal(recorded.outputs.findings_count, 0);
  });

  it('splits a large diff across several requests', async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: `@@ -1,2 +1,2 @@\n a\n+${'x'.repeat(400)}`,
    }));

    await run(deps(recorded, { loadConfig: () => config({ maxDiffChars: 600 }) }, files));

    assert.ok(recorded.prompts.length > 1, 'expected more than one request');
  });

  it('passes the configured model and temperature to the model', async () => {
    let seen: Record<string, unknown> = {};

    await run(
      deps(
        recorded,
        {
          loadConfig: () => config({ model: 'kimi-k3.1-pro', temperature: 0.7 }),
          chat: async (options) => {
            seen = options as unknown as Record<string, unknown>;
            return '{"summary":"s","findings":[]}';
          },
        },
        oneFile,
      ),
    );

    assert.equal(seen.model, 'kimi-k3.1-pro');
    assert.equal(seen.temperature, 0.7);
  });

  it('passes the reasoning effort when configured', async () => {
    let seen: Record<string, unknown> = {};

    await run(
      deps(
        recorded,
        {
          loadConfig: () => config({ reasoningEffort: 'high' }),
          chat: async (options) => {
            seen = options as unknown as Record<string, unknown>;
            return '{"summary":"s","findings":[]}';
          },
        },
        oneFile,
      ),
    );

    assert.equal(seen.reasoningEffort, 'high');
  });

  it('omits the reasoning effort when it is not configured', async () => {
    let seen: Record<string, unknown> = {};

    await run(
      deps(
        recorded,
        {
          chat: async (options) => {
            seen = options as unknown as Record<string, unknown>;
            return '{"summary":"s","findings":[]}';
          },
        },
        oneFile,
      ),
    );

    assert.equal(seen.reasoningEffort, undefined);
  });

  it('carries the extra prompt into the request', async () => {
    await run(
      deps(recorded, { loadConfig: () => config({ extraPrompt: 'Focus on migrations.' }) }, oneFile),
    );

    assert.match(recorded.prompts[0] ?? '', /Focus on migrations\./);
  });

  it('warns but does not fail when the job summary cannot be written', async () => {
    await run(
      deps(
        recorded,
        {
          writeSummary: async () => {
            throw new Error('no summary file');
          },
        },
        oneFile,
      ),
    );

    assert.match(recorded.warnings[0] ?? '', /Could not write the job summary/);
    assert.equal(recorded.failures.length, 0);
  });
});
