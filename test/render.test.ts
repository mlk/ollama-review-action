import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidSuggestion, MARKER_INLINE, MARKER_SUMMARY, renderFindingBody, renderSummaryBody, severityEmoji } from '../src/render';
import { Finding } from '../src/types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'src/app.ts',
    line: 10,
    severity: 'major',
    title: 'Something is wrong',
    body: 'Here is why.',
    ...overrides,
  };
}

describe('severityEmoji', () => {
  it('gives each severity its own colour', () => {
    const emojis = (['blocker', 'critical', 'major', 'minor', 'nit'] as const).map(severityEmoji);
    assert.equal(new Set(emojis).size, emojis.length);
  });
});

describe('isValidSuggestion', () => {
  it('accepts a one-line suggestion for a one-line finding', () => {
    assert.equal(isValidSuggestion(finding({ suggestion: 'const x = 1;' })), true);
  });

  it('accepts a multi-line suggestion that matches the range', () => {
    const multi = finding({ line: 10, end_line: 12, suggestion: 'a\nb\nc' });
    assert.equal(isValidSuggestion(multi), true);
  });

  it('rejects a suggestion whose length does not match the range', () => {
    const multi = finding({ line: 10, end_line: 12, suggestion: 'a\nb' });
    assert.equal(isValidSuggestion(multi), false);
  });

  it('rejects a multi-line suggestion for a single-line finding', () => {
    assert.equal(isValidSuggestion(finding({ suggestion: 'a\nb' })), false);
  });

  it('rejects a suggestion with blank lines', () => {
    assert.equal(isValidSuggestion(finding({ suggestion: 'a\n\n' })), false);
  });

  it('rejects a missing suggestion', () => {
    assert.equal(isValidSuggestion(finding()), false);
  });
});

describe('renderFindingBody', () => {
  it('includes the severity, title and body', () => {
    const body = renderFindingBody(finding());

    assert.match(body, /\*\*.*`major` - Something is wrong\*\*/);
    assert.match(body, /Here is why\./);
  });

  it('renders a matching suggestion as a GitHub suggestion block', () => {
    const body = renderFindingBody(finding({ suggestion: 'const x = 1;' }));

    assert.match(body, /```suggest\nconst x = 1;\n```/);
    assert.doesNotMatch(body, /Suggested change/);
  });

  it('renders a mismatched suggestion as a plain code block', () => {
    const body = renderFindingBody(finding({ suggestion: 'a\nb' }));

    assert.match(body, /Suggested change:/);
    assert.match(body, /```\na\nb\n```/);
    assert.doesNotMatch(body, /```suggest/);
  });

  it('omits the body section when there is no body', () => {
    const body = renderFindingBody(finding({ body: '' }));
    assert.match(body, /`major` - Something is wrong/);
  });

  it('ends with the inline marker so stale comments can be found', () => {
    assert.match(renderFindingBody(finding()), new RegExp(MARKER_INLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('renderSummaryBody', () => {
  it('includes the marker, heading, summary and finding count', () => {
    const body = renderSummaryBody('glm-5.3', 'All good.', [finding()], []);

    assert.ok(body.includes(`${MARKER_SUMMARY}:model=glm-5.3 -->`));
    assert.match(body, /## Ollama review/);
    assert.match(body, /All good\./);
    assert.match(body, /1 finding\./);
  });

  it('pluralises the finding count', () => {
    const body = renderSummaryBody('glm-5.3', 's', [finding(), finding()], []);
    assert.match(body, /2 findings\./);
  });

  it('lists unanchored findings under other observations', () => {
    const body = renderSummaryBody('glm-5.3', 's', [], [finding({ title: 'Loose end' })]);

    assert.match(body, /### Other observations/);
    assert.match(body, /Loose end/);
    assert.match(body, /`src\/app\.ts` \(line 10\)/);
  });

  it('omits the other observations section when nothing is unanchored', () => {
    const body = renderSummaryBody('glm-5.3', 's', [finding()], []);
    assert.doesNotMatch(body, /Other observations/);
  });
});
