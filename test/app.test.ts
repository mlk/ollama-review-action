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
  systemPrompts: string[];
  refs: Array<string | undefined>;
  compareCalls: string[];
}

interface Seed {
  issueComments?: Array<Record<string, unknown>>;
  reviewComments?: Array<Record<string, unknown>>;
  compare?: { behind_by?: number; files?: Array<{ filename: string; previous_filename?: string }> } | Error;
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
    systemPrompts: [],
    refs: [],
    compareCalls: [],
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
    contextFiles: ['AGENTS.md', 'README.md'],
    contextMaxChars: 12000,
    reasoningEffort: '',
    temperature: 0.2,
    profile: 'default',
    failOn: 'none',
    postReview: true,
    incremental: true,
    ...overrides,
  };
}

function makeOctokit(
  state: Recorded,
  files: Array<Record<string, unknown>>,
  contextFiles: Record<string, string> = {},
  seed: Seed = {},
): Octokit {
  const listIssueComments = async () => ({ data: seed.issueComments ?? [] });
  const listReviewComments = async () => ({ data: seed.reviewComments ?? [] });
  const listFiles = async () => ({ data: files });
  const getContent = async (params: { path: string; ref?: string }) => {
    state.refs.push(params.ref);
    const content = contextFiles[params.path];
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
  };

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
      repos: {
        getContent,
        compareCommitsWithBasehead: async (params: { basehead: string }) => {
          state.compareCalls.push(params.basehead);
          const compare = seed.compare;
          if (!compare) {
            throw new Error('compareCommitsWithBasehead was not stubbed');
          }
          if (compare instanceof Error) {
            throw compare;
          }
          return {
            data: {
              status: (compare.behind_by ?? 0) > 0 ? 'diverged' : 'ahead',
              behind_by: compare.behind_by ?? 0,
              files: compare.files ?? [],
            },
          };
        },
      },
    },
  } as unknown as Octokit;
}

function deps(
  state: Recorded,
  overrides: Partial<Deps> = {},
  files: Array<Record<string, unknown>> = [],
  contextFiles: Record<string, string> = {},
  seed: Seed = {},
): Deps {
  return {
    loadConfig: () => config(),
    getOctokit: () => makeOctokit(state, files, contextFiles, seed),
    chat: async (_options, messages) => {
      state.prompts.push(messages[1]?.content ?? '');
      state.systemPrompts.push(messages[0]?.content ?? '');
      return {
        content: JSON.stringify({
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
        }),
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      };
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
      base: { ref: 'main', sha: 'base-sha' },
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

  it('includes the token usage in the summary comment', async () => {
    await run(deps(recorded, {}, oneFile));

    const summary = recorded.created.find((call) => 'issue_number' in call);
    assert.match(String(summary?.body), /1,500 tokens \(1,000 in \/ 500 out\)/);
  });

  it('accumulates token usage across chunks', async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: `@@ -1,2 +1,2 @@\n a\n+${'x'.repeat(400)}`,
    }));

    await run(deps(recorded, { loadConfig: () => config({ maxDiffChars: 600 }) }, files));

    const expected = (recorded.prompts.length * 1500).toLocaleString('en-US');
    const summary = recorded.created.find((call) => 'issue_number' in call);
    assert.match(String(summary?.body), new RegExp(`${expected} tokens`));
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
          chat: async () => ({ content: 'this is not json' }),
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
            return { content: '{"summary":"s","findings":[]}' };
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
            return { content: '{"summary":"s","findings":[]}' };
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
            return { content: '{"summary":"s","findings":[]}' };
          },
        },
        oneFile,
      ),
    );

    assert.equal(seen.reasoningEffort, undefined);
  });

  it('includes repository context files in the prompt', async () => {
    await run(
      deps(recorded, {}, oneFile, { 'AGENTS.md': 'House style: never use var.' }),
    );

    assert.match(recorded.prompts[0] ?? '', /AGENTS\.md/);
    assert.match(recorded.prompts[0] ?? '', /House style: never use var\./);
  });

  it('reads context files from the base commit, not the head', async () => {
    await run(
      deps(recorded, {}, oneFile, { 'AGENTS.md': 'House style: never use var.' }),
    );

    assert.ok(recorded.refs.length > 0);
    for (const ref of recorded.refs) {
      assert.equal(ref, 'base-sha');
    }
  });

  it('carries on when a context file is missing', async () => {
    await run(deps(recorded, {}, oneFile));

    assert.equal(recorded.warnings.length, 0);
    assert.equal(recorded.outputs.failed, 'false');
  });

  it('omits the context section when context files are disabled', async () => {
    await run(
      deps(
        recorded,
        { loadConfig: () => config({ contextFiles: [] }) },
        oneFile,
        { 'AGENTS.md': 'House style: never use var.' },
      ),
    );

    assert.doesNotMatch(recorded.prompts[0] ?? '', /House style/);
  });

  it('carries the extra prompt into the request', async () => {
    await run(
      deps(recorded, { loadConfig: () => config({ extraPrompt: 'Focus on migrations.' }) }, oneFile),
    );

    assert.match(recorded.prompts[0] ?? '', /Focus on migrations\./);
  });

  it('uses the default profile system prompt by default', async () => {
    await run(deps(recorded, {}, oneFile));

    assert.match(recorded.systemPrompts[0] ?? '', /Look for:\n1\. Correctness bugs/);
  });

  it('uses the security profile and still appends the extra prompt', async () => {
    await run(
      deps(
        recorded,
        {
          loadConfig: () =>
            config({ profile: 'security', extraPrompt: 'Focus on the webhook handlers.' }),
        },
        oneFile,
      ),
    );

    const system = recorded.systemPrompts[0] ?? '';
    assert.match(system, /security as the lens/);
    assert.match(system, /Do not assert facts the diff does not show/);
    assert.doesNotMatch(system, /5\. Maintainability - duplicated logic/);
    // The extra prompt is appended to the profile's user message, not folded
    // into the system prompt.
    assert.match(recorded.prompts[0] ?? '', /Focus on the webhook handlers\./);
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

  describe('incremental re-review', () => {
    const twoFiles = [
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,3 +1,3 @@\n a\n+b\n c',
      },
      {
        filename: 'src/other.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,3 +1,3 @@\n x\n+y\n z',
      },
    ];
    const previousSha = '0123456789abcdef0123456789abcdef01234567';
    const previousSummary = {
      id: 42,
      body: `<!-- ollama-review-action:summary:model=glm-5.3:sha=${previousSha} -->\n## Ollama review\n`,
      user: { login: 'bot' },
    };

    it('records the head sha in the summary comment marker', async () => {
      await run(deps(recorded, {}, oneFile));

      const summary = recorded.created.find((call) => 'issue_number' in call);
      assert.match(String(summary?.body), /:sha=sha123/);
    });

    it('does a full review on the first run without calling compare', async () => {
      const logs: string[] = [];

      await run(
        deps(recorded, { info: (message) => logs.push(message) }, twoFiles),
      );

      assert.equal(recorded.compareCalls.length, 0);
      assert.ok(logs.some((line) => /full review/i.test(line)));
      const prompt = recorded.prompts.join('\n');
      assert.match(prompt, /src\/app\.ts/);
      assert.match(prompt, /src\/other\.ts/);
    });

    it('re-reviews only the files that changed since the last review', async () => {
      const seed = {
        issueComments: [previousSummary],
        reviewComments: [
          { id: 11, body: '<!-- ollama-review-action:inline -->old finding', path: 'src/app.ts', user: { login: 'bot' } },
          { id: 12, body: '<!-- ollama-review-action:inline -->old finding', path: 'src/other.ts', user: { login: 'bot' } },
        ],
        compare: { behind_by: 0, files: [{ filename: 'src/app.ts' }] },
      };

      await run(deps(recorded, {}, twoFiles, {}, seed));

      const prompt = recorded.prompts.join('\n');
      assert.match(prompt, /src\/app\.ts/);
      assert.doesNotMatch(prompt, /src\/other\.ts/);

      // Only the stale comment on the re-reviewed file is replaced.
      assert.deepEqual(recorded.deleted.map((call) => call.comment_id), [11]);

      const summary = recorded.updated[0];
      assert.ok(summary, 'expected the summary comment to be updated in place');
      assert.match(String(summary?.body), /Incremental review/);
      assert.match(String(summary?.body), /:sha=sha123/);
    });

    it('falls back to a full review when the branch was force-pushed', async () => {
      const logs: string[] = [];
      const seed = {
        issueComments: [previousSummary],
        compare: { behind_by: 2, files: [{ filename: 'src/app.ts' }] },
      };

      await run(
        deps(recorded, { info: (message) => logs.push(message) }, twoFiles, {}, seed),
      );

      const prompt = recorded.prompts.join('\n');
      assert.match(prompt, /src\/other\.ts/);
      assert.equal(recorded.compareCalls.length, 1);
      assert.ok(logs.some((line) => /rewritten/i.test(line)));
    });

    it('falls back to a full review when the compare fails', async () => {
      const logs: string[] = [];
      const seed = {
        issueComments: [previousSummary],
        compare: new Error('Not Found'),
      };

      await run(
        deps(recorded, { info: (message) => logs.push(message) }, twoFiles, {}, seed),
      );

      const prompt = recorded.prompts.join('\n');
      assert.match(prompt, /src\/other\.ts/);
      assert.ok(logs.some((line) => /falling back to a full review/i.test(line)));
    });

    it('does not call compare when the input is disabled', async () => {
      const seed = {
        issueComments: [previousSummary],
        compare: { behind_by: 0, files: [{ filename: 'src/app.ts' }] },
      };

      await run(
        deps(recorded, { loadConfig: () => config({ incremental: false }) }, twoFiles, {}, seed),
      );

      assert.equal(recorded.compareCalls.length, 0);
      assert.match(recorded.prompts.join('\n'), /src\/other\.ts/);
    });

    it('does nothing when no reviewed file changed since the last review', async () => {
      const logs: string[] = [];
      const seed = {
        issueComments: [previousSummary],
        compare: { behind_by: 0, files: [] },
      };

      await run(
        deps(recorded, { info: (message) => logs.push(message) }, twoFiles, {}, seed),
      );

      assert.equal(recorded.prompts.length, 0);
      assert.equal(recorded.created.length, 0);
      assert.ok(logs.some((line) => /leaving the existing review in place/i.test(line)));
    });

    it('does nothing when the head sha is unchanged', async () => {
      const logs: string[] = [];
      const seed = {
        issueComments: [
          { ...previousSummary, body: '<!-- ollama-review-action:summary:model=glm-5.3:sha=sha123 -->\n## Ollama review\n' },
        ],
      };

      await run(
        deps(recorded, { info: (message) => logs.push(message) }, twoFiles, {}, seed),
      );

      assert.equal(recorded.prompts.length, 0);
      assert.equal(recorded.compareCalls.length, 0);
      assert.ok(logs.some((line) => /not changed/i.test(line)));
    });

    const carriedComment = (severity?: string): Record<string, unknown> => ({
      id: 77,
      body: severity
        ? `**old finding**\n\n<!-- ollama-review-action:inline severity=${severity} -->`
        : '<!-- ollama-review-action:inline -->unparseable legacy comment',
      path: 'src/other.ts',
      user: { login: 'bot' },
    });
    const noFindings = {
      chat: async () => ({
        content: JSON.stringify({ summary: 'Nothing found.', findings: [] }),
      }),
    };

    it('fails the gate on a carried-over finding even with nothing new to report', async () => {
      const seed = {
        issueComments: [previousSummary],
        reviewComments: [carriedComment('critical')],
        compare: { behind_by: 0, files: [{ filename: 'src/app.ts' }] },
      };

      await run(
        deps(
          recorded,
          { ...noFindings, loadConfig: () => config({ failOn: 'critical' }) },
          twoFiles,
          {},
          seed,
        ),
      );

      assert.equal(recorded.outputs.findings_count, 0);
      assert.equal(recorded.outputs.failed, 'true');
      assert.equal(recorded.failures.length, 1);
      assert.match(recorded.failures[0] ?? '', /critical/);
    });

    it('does not fail the gate on a carried-over comment whose severity cannot be parsed', async () => {
      const seed = {
        issueComments: [previousSummary],
        reviewComments: [carriedComment(undefined)],
        compare: { behind_by: 0, files: [{ filename: 'src/app.ts' }] },
      };

      await run(
        deps(
          recorded,
          { ...noFindings, loadConfig: () => config({ failOn: 'critical' }) },
          twoFiles,
          {},
          seed,
        ),
      );

      assert.equal(recorded.outputs.failed, 'false');
      assert.equal(recorded.failures.length, 0);
    });

    it('fails the gate on the no-op path when a blocking finding still stands', async () => {
      const seed = {
        issueComments: [
          { ...previousSummary, body: '<!-- ollama-review-action:summary:model=glm-5.3:sha=sha123 -->\n## Ollama review\n' },
        ],
        reviewComments: [carriedComment('blocker')],
      };

      await run(
        deps(
          recorded,
          { loadConfig: () => config({ failOn: 'critical' }) },
          twoFiles,
          {},
          seed,
        ),
      );

      assert.equal(recorded.prompts.length, 0);
      assert.equal(recorded.outputs.failed, 'true');
      assert.match(recorded.failures[0] ?? '', /blocker/);
    });

    it('fails the gate when nothing was re-reviewed but a blocking finding still stands', async () => {
      const seed = {
        issueComments: [previousSummary],
        reviewComments: [carriedComment('major')],
        compare: { behind_by: 0, files: [] },
      };

      await run(
        deps(
          recorded,
          { loadConfig: () => config({ failOn: 'major' }) },
          twoFiles,
          {},
          seed,
        ),
      );

      assert.equal(recorded.prompts.length, 0);
      assert.equal(recorded.outputs.failed, 'true');
    });
  });
});
