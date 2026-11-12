import { debug, info, setFailed, setOutput, summary as coreSummary, warning } from '@actions/core';
import { getOctokit } from '@actions/github';

import { Config, loadConfig } from './config';
import { chunkDiffs, renderDiff, truncate } from './diff';
import {
  anchorFindings,
  fetchChangedFiles,
  getPullRequestContext,
  replaceInlineComments,
  upsertSummaryComment,
} from './github';
import { ChatMessage, chatCompletion, OllamaClientOptions } from './ollama';
import { parseReview } from './parse';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { MARKER_INLINE, MARKER_SUMMARY, renderFindingBody, renderSummaryBody } from './render';
import { selectFiles } from './select';
import { Finding, meetsThreshold, SEVERITIES } from './types';

export type Octokit = ReturnType<typeof getOctokit>;

export interface Deps {
  loadConfig: () => Config;
  getOctokit: (token: string) => Octokit;
  chat: (options: OllamaClientOptions, messages: ChatMessage[]) => Promise<string>;
  info: (message: string) => void;
  warning: (message: string) => void;
  debug: (message: string) => void;
  setOutput: (name: string, value: unknown) => void;
  setFailed: (message: string) => void;
  writeSummary: (body: string) => Promise<void>;
}

export const defaultDeps: Deps = {
  loadConfig,
  getOctokit: (token) => getOctokit(token),
  chat: (options, messages) => chatCompletion(options, messages),
  info,
  warning,
  debug,
  setOutput,
  setFailed,
  writeSummary: async (body) => {
    await coreSummary.addRaw(body).write();
  },
};

export async function run(deps: Deps = defaultDeps): Promise<void> {
  const config = deps.loadConfig();
  const octokit = deps.getOctokit(config.token);

  deps.info(`Reviewing pull request with model "${config.model}" via ${config.host}.`);

  const pullRequest = await getPullRequestContext(octokit);
  deps.info(`PR #${pullRequest.number}: ${pullRequest.title}`);

  const files = await fetchChangedFiles(octokit, pullRequest.number);
  if (files.length === 0) {
    deps.info('No changed files to review.');
    return;
  }

  const selected = selectFiles(files, config.excludePaths, config.maxFiles);
  if (selected.length === 0) {
    deps.info('Nothing to review after filtering.');
    return;
  }

  const chunks = chunkDiffs(selected, config.maxDiffChars);
  deps.info(`Reviewing ${selected.length} file(s) in ${chunks.length} request(s).`);

  const summaries: string[] = [];
  const findings: Finding[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const diffText = truncate(renderDiff(chunk), config.maxDiffChars);
    const userPrompt = buildUserPrompt(pullRequest, diffText, config.extraPrompt, chunk.length);

    const response = await deps.chat(
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
      deps.warning(
        `Could not parse the model response for chunk ${index + 1}: ${(error as Error).message}`,
      );
      deps.debug(response);
    }
  }

  const summary =
    summaries.join('\n\n') || 'The model did not return a summary for this pull request.';
  const { anchored, unanchored } = anchorFindings(findings, selected);

  deps.info(`${anchored.length} anchored finding(s), ${unanchored.length} unanchored.`);

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

  let summaryCommentId = '';
  if (config.postReview) {
    summaryCommentId = String(
      await upsertSummaryComment(octokit, pullRequest.number, body, MARKER_SUMMARY),
    );

    await replaceInlineComments(
      octokit,
      pullRequest.number,
      comments,
      MARKER_INLINE,
      pullRequest.headSha,
    );
  } else {
    deps.info('post_review is false - not posting to GitHub.');
    deps.info(body);
  }

  try {
    await deps.writeSummary(body);
  } catch (error) {
    deps.warning(`Could not write the job summary: ${(error as Error).message}`);
  }

  deps.setOutput('summary', summary);
  deps.setOutput('findings_count', anchored.length);
  deps.setOutput('comment_id', summaryCommentId);

  const worst = anchored
    .map((finding) => finding.severity)
    .sort((a, b) => SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a))[0];

  const failed =
    worst !== undefined && config.failOn !== 'none' && meetsThreshold(worst, config.failOn);
  deps.setOutput('failed', failed ? 'true' : 'false');

  if (failed) {
    deps.setFailed(`The review found a ${worst} severity issue (fail_on=${config.failOn}).`);
  }
}
