import * as core from '@actions/core';
import * as github from '@actions/github';

import { loadConfig } from './config';
import { chunkDiffs, matchesAnyGlob, renderDiff, truncate } from './diff';
import { anchorFindings, fetchChangedFiles, getPullRequestContext, postReview } from './github';
import { chatCompletion } from './ollama';
import { parseReview } from './parse';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { Finding, FileDiff, meetsThreshold, SEVERITIES, Severity } from './types';

const { getOctokit } = github;

const MARKER_PREFIX = '<!-- ollama-review-action:';

function severityEmoji(severity: Severity): string {
  switch (severity) {
    case 'blocker':
      return '\u{1F534}';
    case 'critical':
      return '\u{1F7E2}';
    case 'major':
      return '\u{1F7E1}';
    case 'minor':
      return '\u{1F7E0}';
    default:
      return '\u{26AA}';
  }
}

function isValidSuggestion(finding: Finding): boolean {
  if (!finding.suggestion) {
    return false;
  }
  const lines = finding.suggestion.replace(/\n$/, '').split('\n');
  const expected = finding.end_line ? finding.end_line - finding.line + 1 : 1;
  return lines.length === expected && lines.every((line) => line.trim() !== '');
}

function renderFindingBody(finding: Finding): string {
  const parts: string[] = [];

  parts.push(`**${severityEmoji(finding.severity)} \`${finding.severity}\` - ${finding.title}**`);
  parts.push('');

  if (finding.body) {
    parts.push(finding.body);
    parts.push('');
  }

  if (finding.suggestion) {
    if (isValidSuggestion(finding)) {
      parts.push('```suggest');
      parts.push(finding.suggestion.replace(/\n$/, ''));
      parts.push('```');
    } else {
      parts.push('Suggested change:');
      parts.push('');
      parts.push('```');
      parts.push(finding.suggestion.replace(/\n$/, ''));
      parts.push('```');
    }
    parts.push('');
  }

  return parts.join('\n').trimEnd();
}

function renderSummaryBody(
  model: string,
  summary: string,
  findings: Finding[],
  unanchored: Finding[],
): string {
  const lines: string[] = [];

  lines.push(`${MARKER_PREFIX}model=${model} -->`);
  lines.push('');
  lines.push('## Ollama review');
  lines.push('');
  lines.push(summary);
  lines.push('');

  if (unanchored.length > 0) {
    lines.push('### Other observations');
    lines.push('');
    for (const finding of unanchored) {
      lines.push(
        `- **\`${finding.severity}\`** ${finding.title} - \`${finding.path}\` (line ${finding.line})`,
      );
      if (finding.body) {
        lines.push(`  ${finding.body.replace(/\n+/g, ' ')}`);
      }
    }
    lines.push('');
  }

  lines.push(
    `<sub>Reviewed with \`${model}\` - ${findings.length} finding${
      findings.length === 1 ? '' : 's'
    }.</sub>`,
  );

  return lines.join('\n');
}

function selectFiles(diffs: FileDiff[], excludePaths: string[], maxFiles: number): FileDiff[] {
  const selected: FileDiff[] = [];

  for (const diff of diffs) {
    if (diff.status === 'removed') {
      continue;
    }
    if (excludePaths.length > 0 && matchesAnyGlob(diff.path, excludePaths)) {
      core.info(`Skipping excluded path: ${diff.path}`);
      continue;
    }
    if (diff.truncated) {
      core.info(`Skipping ${diff.path}: GitHub did not return a patch for it.`);
      continue;
    }
    if (diff.commentableLines.length === 0) {
      core.info(`Skipping ${diff.path}: no reviewable lines in the diff.`);
      continue;
    }
    selected.push(diff);
  }

  if (selected.length > maxFiles) {
    core.warning(
      `Reviewing the first ${maxFiles} of ${selected.length} changed files (input "max_files").`,
    );
    return selected.slice(0, maxFiles);
  }

  return selected;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const octokit = getOctokit(config.token);

  core.info(`Reviewing pull request with model "${config.model}" via ${config.host}.`);

  const pullRequest = await getPullRequestContext(octokit);
  core.info(`PR #${pullRequest.number}: ${pullRequest.title}`);

  const files = await fetchChangedFiles(octokit, pullRequest.number);
  if (files.length === 0) {
    core.info('No changed files to review.');
    return;
  }

  const selected = selectFiles(files, config.excludePaths, config.maxFiles);
  if (selected.length === 0) {
    core.info('Nothing to review after filtering.');
    return;
  }

  const chunks = chunkDiffs(selected, config.maxDiffChars);
  core.info(`Reviewing ${selected.length} file(s) in ${chunks.length} request(s).`);

  const summaries: string[] = [];
  const findings: Finding[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const diffText = truncate(renderDiff(chunk), config.maxDiffChars);
    const userPrompt = buildUserPrompt(
      pullRequest,
      diffText,
      config.extraPrompt,
      chunk.length,
    );

    const response = await chatCompletion(
      {
        host: config.host,
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      },
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    );

    try {
      const review = parseReview(response);
      summaries.push(review.summary);
      findings.push(...review.findings);
    } catch (error) {
      core.warning(
        `Could not parse the model response for chunk ${index + 1}: ${(error as Error).message}`,
      );
      core.debug(response);
    }
  }

  const summary = summaries.join('\n\n') || 'The model did not return a summary for this pull request.';
  const { anchored, unanchored } = anchorFindings(findings, selected);

  core.info(`${anchored.length} anchored finding(s), ${unanchored.length} unanchored.`);

  const body = renderSummaryBody(config.model, summary, anchored, unanchored);
  const comments = anchored.map((finding) => {
    const comment: {
      path: string;
      line: number;
      start_line?: number;
      side: 'RIGHT';
      start_side?: 'RIGHT';
      body: string;
    } = {
      path: finding.path,
      line: finding.end_line ?? finding.line,
      side: 'RIGHT',
      body: renderFindingBody(finding),
    };
    if (finding.end_line && finding.end_line > finding.line) {
      comment.start_line = finding.line;
      comment.start_side = 'RIGHT';
    }
    return comment;
  });

  let reviewId = '';
  if (config.postReview) {
    reviewId = String(
      await postReview(octokit, pullRequest.number, {
        body,
        comments,
        marker: MARKER_PREFIX,
      }),
    );
  } else {
    core.info('post_review is false - not posting to GitHub.');
    core.info(body);
  }

  await core.summary.addRaw(body).write();

  core.setOutput('summary', summary);
  core.setOutput('findings_count', anchored.length);
  core.setOutput('review_id', reviewId);

  const worst = anchored
    .map((finding) => finding.severity)
    .sort((a, b) => SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a))[0];

  const failed = worst !== undefined && config.failOn !== 'none' && meetsThreshold(worst, config.failOn);
  core.setOutput('failed', failed ? 'true' : 'false');

  if (failed) {
    core.setFailed(`The review found a ${worst} severity issue (fail_on=${config.failOn}).`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
