import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractJsonObject, parseReview } from '../src/parse';
import { meetsThreshold } from '../src/types';

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  it('strips markdown fences', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  });

  it('strips reasoning blocks', () => {
    const response = '<think>Let me think about this.</think>\n{"a":1}';
    assert.deepEqual(extractJsonObject(response), { a: 1 });
  });

  it('extracts JSON surrounded by prose', () => {
    const response = 'Here is the review:\n{"a":1}\nHope this helps!';
    assert.deepEqual(extractJsonObject(response), { a: 1 });
  });

  it('throws when there is no JSON at all', () => {
    assert.throws(() => extractJsonObject('no json here'));
  });

  it('keeps code fences that appear inside a JSON string value', () => {
    const response = JSON.stringify({
      summary: 'fix it',
      findings: [
        {
          path: 'a.ts',
          line: 1,
          severity: 'minor',
          title: 't',
          body: 'use:\n\n```js\nconst x = 1;\n```',
        },
      ],
    });

    const parsed = extractJsonObject(response) as { findings: Array<{ body: string }> };

    assert.match(parsed.findings[0]!.body, /```js/);
  });

  it('handles braces inside JSON string values', () => {
    const response = '{"summary":"use { and } braces","findings":[]}';
    const parsed = extractJsonObject(response) as { summary: string };
    assert.equal(parsed.summary, 'use { and } braces');
  });

  it('finds the JSON object after reasoning text containing braces', () => {
    const response = '<think>the { shape } of things</think>\n{"summary":"ok","findings":[]}';
    const parsed = extractJsonObject(response) as { summary: string };
    assert.equal(parsed.summary, 'ok');
  });

  it('recovers the JSON when it is wrapped in a fenced block', () => {
    const response = '```json\n{"summary":"ok","findings":[]}\n```';
    const parsed = extractJsonObject(response) as { summary: string };
    assert.equal(parsed.summary, 'ok');
  });
});

describe('parseReview', () => {
  it('parses a summary and findings', () => {
    const review = parseReview(
      JSON.stringify({
        summary: 'Looks mostly fine.',
        findings: [
          {
            path: 'src/app.ts',
            line: 12,
            severity: 'critical',
            title: 'Null dereference',
            body: 'x can be null here.',
            suggestion: 'if (x === null) return;',
          },
        ],
      }),
    );

    assert.equal(review.summary, 'Looks mostly fine.');
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0]?.severity, 'critical');
    assert.equal(review.findings[0]?.suggestion, 'if (x === null) return;');
  });

  it('drops findings without a path or a usable line', () => {
    const review = parseReview(
      JSON.stringify({
        summary: 's',
        findings: [
          { path: '', line: 3, severity: 'minor', title: 't', body: 'b' },
          { path: 'a.ts', line: 'x', severity: 'minor', title: 't', body: 'b' },
          { path: 'a.ts', line: 0, severity: 'minor', title: 't', body: 'b' },
        ],
      }),
    );

    assert.equal(review.findings.length, 0);
  });

  it('normalizes unknown severities', () => {
    const review = parseReview(
      JSON.stringify({
        summary: 's',
        findings: [{ path: 'a.ts', line: 1, severity: 'URGENT', title: 't', body: 'b' }],
      }),
    );

    assert.equal(review.findings[0]?.severity, 'minor');
  });

  it('keeps end_line only when it is after line', () => {
    const review = parseReview(
      JSON.stringify({
        summary: 's',
        findings: [{ path: 'a.ts', line: 10, end_line: 12, severity: 'minor', title: 't', body: 'b' }],
      }),
    );

    assert.equal(review.findings[0]?.end_line, 12);
  });

  it('returns an empty finding list when the model reports no issues', () => {
    const review = parseReview(JSON.stringify({ summary: 'No issues found.', findings: [] }));
    assert.equal(review.findings.length, 0);
    assert.equal(review.summary, 'No issues found.');
  });
});

describe('meetsThreshold', () => {
  it('ranks severities', () => {
    assert.equal(meetsThreshold('critical', 'major'), true);
    assert.equal(meetsThreshold('minor', 'major'), false);
    assert.equal(meetsThreshold('major', 'major'), true);
    assert.equal(meetsThreshold('nit', 'nit'), true);
  });
});
