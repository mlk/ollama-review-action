import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidSuggestion, MARKER_INLINE, MARKER_SUMMARY, parseInlineSeverity, parseSummarySha, renderFindingBody, renderSummaryBody, severityEmoji } from '../src/render';
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

  it('ends with an inline marker carrying the severity', () => {
    const body = renderFindingBody(finding());
    assert.match(body, new RegExp(`${MARKER_INLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} severity=major -->`));
  });

  it('round-trips the severity through the marker', () => {
    const body = renderFindingBody(finding({ severity: 'blocker' }));
    assert.equal(parseInlineSeverity(body), 'blocker');
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

  it('includes the token usage in the footer when provided', () => {
    const body = renderSummaryBody('glm-5.3', 's', [finding()], [], {
      promptTokens: 8000,
      completionTokens: 4345,
      totalTokens: 12345,
    });

    assert.match(body, /12,345 tokens \(8,000 in \/ 4,345 out\)/);
  });

  it('omits the token usage from the footer when not provided', () => {
    const body = renderSummaryBody('glm-5.3', 's', [finding()], []);

    assert.doesNotMatch(body, /tokens/);
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

  it('records the head SHA in the marker when given one', () => {
    const body = renderSummaryBody('glm-5.3', 's', [], [], undefined, { headSha: 'abc1234def' });

    assert.ok(body.includes(`${MARKER_SUMMARY}:model=glm-5.3:sha=abc1234def -->`));
  });

  it('adds an incremental note when only some files were reviewed', () => {
    const body = renderSummaryBody('glm-5.3', 's', [], [], undefined, {
      headSha: 'abc1234def',
      incremental: { since: 'fed4321cafe', files: 2 },
    });

    assert.match(body, /Incremental review/);
    assert.match(body, /changed since `fed4321`/);
    assert.match(body, /2 files/);
  });
});

describe('parseSummarySha', () => {
  it('reads the SHA back out of a marker written by renderSummaryBody', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const body = renderSummaryBody('glm-5.3', 's', [], [], undefined, { headSha: sha });

    assert.equal(parseSummarySha(body), sha);
  });

  it('returns undefined for a marker without a SHA', () => {
    const body = renderSummaryBody('glm-5.3', 's', [], []);

    assert.equal(parseSummarySha(body), undefined);
  });

  it('returns undefined when there is no marker at all', () => {
    assert.equal(parseSummarySha('just a comment'), undefined);
  });
});

describe('parseInlineSeverity', () => {
  it('reads the severity from a marker written by renderFindingBody', () => {
    assert.equal(parseInlineSeverity(renderFindingBody(finding({ severity: 'critical' }))), 'critical');
  });

  it('falls back to the bolded header for comments posted before the marker carried severity', () => {
    const legacy = '**🟠 `critical` - something broke**\n\nbody\n\n<!-- ollama-review-action:inline -->';
    assert.equal(parseInlineSeverity(legacy), 'critical');
  });

  it('returns undefined when no severity can be found', () => {
    assert.equal(parseInlineSeverity('<!-- ollama-review-action:inline -->just a note'), undefined);
  });
});
