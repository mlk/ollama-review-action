import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildUserPrompt,
  OUTPUT_SCHEMA,
  REVIEW_PROFILES,
  SYSTEM_PROMPT,
  systemPromptFor,
} from '../src/prompt';
import { PullRequestContext } from '../src/types';

const context: PullRequestContext = {
  number: 42,
  headSha: 'abc123',
  title: 'Add items endpoint',
  body: 'Adds a route to list items.',
  author: 'michael',
  baseRef: 'main',
  headRef: 'feature/items',
};

describe('SYSTEM_PROMPT', () => {
  it('tells the model not to assert facts the diff cannot show', () => {
    assert.match(SYSTEM_PROMPT, /Do not assert facts the diff does not show/);
  });

  it('asks for JSON only', () => {
    assert.match(SYSTEM_PROMPT, /Respond with JSON only/);
  });
});

describe('systemPromptFor', () => {
  it('returns the default prompt byte-for-byte for the default profile', () => {
    assert.equal(systemPromptFor('default'), SYSTEM_PROMPT);
  });

  it('covers every advertised profile', () => {
    assert.deepEqual([...REVIEW_PROFILES], ['default', 'security', 'performance', 'maintainability']);
  });

  it('gives each profile a distinct focus section', () => {
    const prompts = REVIEW_PROFILES.map((profile) => systemPromptFor(profile));
    assert.equal(new Set(prompts).size, REVIEW_PROFILES.length);
  });

  it('keeps the honesty and anchoring rules in every profile', () => {
    for (const profile of REVIEW_PROFILES) {
      const prompt = systemPromptFor(profile);
      assert.match(prompt, /Do not assert facts the diff does not show/);
      assert.match(prompt, /Never speculate about code you cannot see/);
      assert.match(prompt, /If the diff is fine, return no findings/);
      assert.match(prompt, /file and a line number that appears in the annotated diff/);
      assert.match(prompt, /Respond with JSON only/);
    }
  });

  it('focuses each non-default profile on its concern', () => {
    assert.match(systemPromptFor('security'), /security as the lens/);
    assert.match(systemPromptFor('security'), /Injection/);
    assert.match(systemPromptFor('security'), /access control/i);

    assert.match(systemPromptFor('performance'), /performance as the lens/);
    assert.match(systemPromptFor('performance'), /N\+1 queries/);

    assert.match(systemPromptFor('maintainability'), /maintainability as the lens/);
    assert.match(systemPromptFor('maintainability'), /Duplicated logic/);
  });
});

describe('buildUserPrompt', () => {
  it('includes the pull request metadata', () => {
    const prompt = buildUserPrompt(context, 'DIFF HERE', '', 1);

    assert.match(prompt, /Pull request #42: Add items endpoint/);
    assert.match(prompt, /Author: michael/);
    assert.match(prompt, /Base branch: main/);
    assert.match(prompt, /Head branch: feature\/items/);
    assert.match(prompt, /Files in this chunk: 1/);
  });

  it('includes the diff', () => {
    assert.match(buildUserPrompt(context, 'DIFF HERE', '', 1), /DIFF HERE/);
  });

  it('includes the description when there is one', () => {
    assert.match(buildUserPrompt(context, '', '', 1), /Adds a route to list items\./);
  });

  it('omits the description section when the body is empty', () => {
    const prompt = buildUserPrompt({ ...context, body: '   ' }, '', '', 1);
    assert.doesNotMatch(prompt, /Description:/);
  });

  it('includes extra instructions when provided', () => {
    const prompt = buildUserPrompt(context, '', 'Focus on migrations.', 1);
    assert.match(prompt, /Focus on migrations\./);
  });

  it('omits the extra instructions section when there are none', () => {
    const prompt = buildUserPrompt(context, '', '', 1);
    assert.doesNotMatch(prompt, /Additional instructions/);
  });

  it('includes repository context files when given', () => {
    const prompt = buildUserPrompt(context, '', '', 1, [
      { path: 'AGENTS.md', content: 'House style: never use var.' },
      { path: 'README.md', content: 'A project about items.' },
    ]);

    assert.match(prompt, /AGENTS\.md/);
    assert.match(prompt, /House style: never use var\./);
    assert.match(prompt, /README\.md/);
    assert.match(prompt, /A project about items\./);
  });

  it('omits the repository context section when no files are given', () => {
    const prompt = buildUserPrompt(context, '', '', 1);
    assert.doesNotMatch(prompt, /Guidance from the repository/);
  });

  it('explains the line number annotation', () => {
    const prompt = buildUserPrompt(context, '', '', 1);
    assert.match(prompt, /line numbers of the new revision/);
    assert.match(prompt, /cannot comment on them/);
  });

  it('includes the output schema and the empty result shape', () => {
    const prompt = buildUserPrompt(context, '', '', 1);
    assert.ok(prompt.includes(OUTPUT_SCHEMA));
    assert.match(prompt, /"findings": \[\]/);
  });
});
