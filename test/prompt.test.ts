import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUserPrompt, OUTPUT_SCHEMA, SYSTEM_PROMPT } from '../src/prompt';
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
