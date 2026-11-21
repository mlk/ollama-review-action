import { debug, info, setFailed, setOutput, summary as coreSummary, warning } from '@actions/core';
import { getOctokit } from '@actions/github';

import { Config, loadConfig } from './config';
import { chunkDiffs, renderDiff, truncate } from './diff';
import {
  anchorFindings,
  compareCommitsSince,
  fetchCarriedInlineSeverities,
  fetchChangedFiles,
  fetchContextFiles,
  fetchPreviousReviewSha,
  getPullRequestContext,
  replaceInlineComments,
  upsertSummaryComment,
} from './github';
import { ChatMessage, ChatResult, chatCompletion, OllamaClientOptions } from './ollama';
import { parseReview } from './parse';
import { buildUserPrompt, systemPromptFor } from './prompt';
import { MARKER_INLINE, MARKER_SUMMARY, renderFindingBody, renderSummaryBody } from './render';
import { selectFiles } from './select';
import { Finding, meetsThreshold, SEVERITIES, Severity, TokenUsage } from './types';

export type Octokit = ReturnType<typeof getOctokit>;

export interface Deps {
  loadConfig: () => Config;
  getOctokit: (token: string) => Octokit;
  chat: (options: OllamaClientOptions, messages: ChatMessage[]) => Promise<ChatResult>;
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

function worstSeverity(severities: Severity[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const severity of severities) {
    if (!worst || SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(worst)) {
      worst = severity;
    }
  }
  return worst;
}

export async function run(deps: Deps = defaultDeps): Promise<void> {
  const config = deps.loadConfig();
  const octokit = deps.getOctokit(config.token);

  const applyFailGate = (severities: Severity[]): void => {
    const worst = worstSeverity(severities);
    const failed =
      worst !== undefined && config.failOn !== 'none' && meetsThreshold(worst, config.failOn);
    deps.setOutput('failed', failed ? 'true' : 'false');
    if (failed && worst) {
      deps.setFailed(`The review found a ${worst} severity issue (fail_on=${config.failOn}).`);
    }
  };

  deps.info(`Reviewing pull request with model "${config.model}" via ${config.host}.`);

  const pullRequest = await getPullRequestContext(octokit);
  deps.info(`PR #${pullRequest.number}: ${pullRequest.title}`);

  const files = await fetchChangedFiles(octokit, pullRequest.number);
  if (files.length === 0) {
    deps.info('No changed files to review.');
    applyFailGate(await fetchCarriedInlineSeverities(octokit, pullRequest.number, MARKER_INLINE));
    return;
  }

  const selected = selectFiles(files, config.excludePaths, config.maxFiles);
  if (selected.length === 0) {
    deps.info('Nothing to review after filtering.');
    applyFailGate(await fetchCarriedInlineSeverities(octokit, pullRequest.number, MARKER_INLINE));
    return;
  }

  // Narrow to the files that changed since the last review, so a synchronize
  // event does not re-review (and re-bill) the whole pull request. Findings
  // for the skipped files are already posted on the pull request, so nothing
  // is lost by not re-sending them to the model.
  const shortSha = (sha: string): string => sha.slice(0, 7);
  let reviewed = selected;
  let incrementalSince: string | undefined;
  if (config.incremental) {
    const previous = await fetchPreviousReviewSha(octokit, pullRequest.number, MARKER_SUMMARY);
    if (!previous) {
      deps.info('No previous review found for this pull request - doing a full review.');
    } else if (previous === pullRequest.headSha) {
      deps.info(
        `The head commit has not changed since the last review (${shortSha(previous)}); nothing to do.`,
      );
      applyFailGate(
        await fetchCarriedInlineSeverities(octokit, pullRequest.number, MARKER_INLINE),
      );
      return;
    } else {
      try {
        const compare = await compareCommitsSince(octokit, previous, pullRequest.headSha);
        if (!compare.canIncrement) {
          deps.info(
            compare.reason === 'truncated'
              ? `The comparison lists ${compare.files.length} or more files and may be incomplete; falling back to a full review.`
              : `The branch history was rewritten since ${shortSha(previous)} (force-push or rebase); falling back to a full review.`,
          );
        } else {
          const changedPaths = new Set<string>();
          for (const file of compare.files) {
            changedPaths.add(file.filename);
            if (file.previous_filename) {
              changedPaths.add(file.previous_filename);
            }
          }
          const narrowed = selected.filter(
            (diff) =>
              changedPaths.has(diff.path) ||
              (diff.previousPath !== undefined && changedPaths.has(diff.previousPath)),
          );
          if (narrowed.length === 0) {
            deps.info(
              `No reviewed files changed since the last review (${shortSha(previous)}); leaving the existing review in place.`,
            );
            applyFailGate(
              await fetchCarriedInlineSeverities(octokit, pullRequest.number, MARKER_INLINE),
            );
            return;
          }
          incrementalSince = previous;
          deps.info(
            `Incremental review: re-reviewing ${narrowed.length} of ${selected.length} file(s) that changed since ${shortSha(previous)}.`,
          );
          reviewed = narrowed;
        }
      } catch (error) {
        deps.info(
          `Could not compare with the previous review at ${shortSha(previous)} (${(error as Error).message}); falling back to a full review.`,
        );
      }
    }
  }

  let contextFiles: Awaited<ReturnType<typeof fetchContextFiles>> = [];
  if (config.contextFiles.length > 0) {
    try {
      // Guidance comes from the base commit: a pull request must not be able to
      // steer its own review by editing guidance in the same diff. The PR's own
      // edits to those files are still visible to the model through the diff.
      contextFiles = await fetchContextFiles(
        octokit,
        config.contextFiles,
        pullRequest.baseSha || pullRequest.baseRef,
        config.contextMaxChars,
      );
    } catch (error) {
      deps.warning(`Could not read repository context files: ${(error as Error).message}`);
    }
    if (contextFiles.length > 0) {
      deps.info(
        `Including ${contextFiles.length} context file(s): ${contextFiles.map((f) => f.path).join(', ')}`,
      );
    }
  }


  const systemPrompt = systemPromptFor(config.profile);

  const chunks = chunkDiffs(reviewed, config.maxDiffChars);
  deps.info(`Reviewing ${reviewed.length} file(s) in ${chunks.length} request(s).`);

  const summaries: string[] = [];
  const findings: Finding[] = [];
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;

  for (const [index, chunk] of chunks.entries()) {
    const diffText = truncate(renderDiff(chunk), config.maxDiffChars);
    const userPrompt = buildUserPrompt(
      pullRequest,
      diffText,
      config.extraPrompt,
      chunk.length,
      contextFiles,
    );

    const response = await deps.chat(
      {
        host: config.host,
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      },
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    );

    if (response.usage) {
      totalUsage.promptTokens += response.usage.promptTokens;
      totalUsage.completionTokens += response.usage.completionTokens;
      totalUsage.totalTokens += response.usage.totalTokens;
      sawUsage = true;
    }

    try {
      const review = parseReview(response.content);
      summaries.push(review.summary);
      findings.push(...review.findings);
    } catch (error) {
      deps.warning(
        `Could not parse the model response for chunk ${index + 1}: ${(error as Error).message}`,
      );
      deps.debug(response.content);
    }
  }

  const summary =
    summaries.join('\n\n') || 'The model did not return a summary for this pull request.';
  const { anchored, unanchored } = anchorFindings(findings, reviewed);

  deps.info(`${anchored.length} anchored finding(s), ${unanchored.length} unanchored.`);

  const body = renderSummaryBody(
    config.model,
    summary,
    anchored,
    unanchored,
    sawUsage ? totalUsage : undefined,
    {
      headSha: pullRequest.headSha || undefined,
      ...(incrementalSince
        ? { incremental: { since: incrementalSince, files: reviewed.length } }
        : {}),
    },
  );
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
  // Severities of the findings that are kept on the pull request from earlier
  // runs (files not re-reviewed). The gate has to count those alongside this
  // run's findings, or a carried-over blocker would stop failing the check.
  let carriedSeverities: Severity[] = [];
  if (config.postReview) {
    summaryCommentId = String(
      await upsertSummaryComment(octokit, pullRequest.number, body, MARKER_SUMMARY),
    );

    // Paths whose previous inline comments are replaced with this run's findings:
    // exactly the files that were re-reviewed (plus their old names on renames).
    const reReviewedPaths = incrementalSince
      ? new Set(
          reviewed.flatMap((diff) =>
            diff.previousPath ? [diff.path, diff.previousPath] : [diff.path],
          ),
        )
      : undefined;
    const result = await replaceInlineComments(
      octokit,
      pullRequest.number,
      comments,
      MARKER_INLINE,
      pullRequest.headSha,
      reReviewedPaths,
    );
    carriedSeverities = result.carriedSeverities;
  } else {
    deps.info('post_review is false - not posting to GitHub.');
    deps.info(body);
    carriedSeverities = await fetchCarriedInlineSeverities(
      octokit,
      pullRequest.number,
      MARKER_INLINE,
    );
  }

  try {
    await deps.writeSummary(body);
  } catch (error) {
    deps.warning(`Could not write the job summary: ${(error as Error).message}`);
  }

  deps.setOutput('summary', summary);
  deps.setOutput('findings_count', anchored.length);
  deps.setOutput('comment_id', summaryCommentId);

  applyFailGate([...anchored.map((finding) => finding.severity), ...carriedSeverities]);
}
