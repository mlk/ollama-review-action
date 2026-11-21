import { Finding, Severity, TokenUsage } from './types';

export const MARKER_SUMMARY = '<!-- ollama-review-action:summary';
export const MARKER_INLINE = '<!-- ollama-review-action:inline -->';

export function severityEmoji(severity: Severity): string {
  switch (severity) {
    case 'blocker':
      return '\u{1F534}';
    case 'critical':
      return '\u{1F7E0}';
    case 'major':
      return '\u{1F7E1}';
    case 'minor':
      return '\u{1F535}';
    default:
      return '\u{26AA}';
  }
}

/**
 * A GitHub suggestion block replaces the commented line range, so it is only
 * valid when the number of suggested lines matches that range exactly.
 */
export function isValidSuggestion(finding: Finding): boolean {
  if (!finding.suggestion) {
    return false;
  }
  const lines = finding.suggestion.replace(/\n$/, '').split('\n');
  const expected = finding.end_line ? finding.end_line - finding.line + 1 : 1;
  return lines.length === expected && lines.every((line) => line.trim() !== '');
}

export function renderFindingBody(finding: Finding): string {
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

  parts.push(MARKER_INLINE);

  return parts.join('\n').trimEnd();
}

/** Parses the marker written by {@link renderSummaryBody}, returning the head SHA that was reviewed, if any. */
export function parseSummarySha(body: string): string | undefined {
  const marker = new RegExp(`${MARKER_SUMMARY}[^>]*-->`).exec(body);
  if (!marker) {
    return undefined;
  }
  const sha = /:sha=([^\s>]{6,64})/i.exec(marker[0]);
  return sha?.[1];
}

export interface SummaryBodyOptions {
  /** Head commit this review covers. Recorded in the marker so the next run knows where to start from. */
  headSha?: string;
  /** Set when only some files were re-reviewed; adds a note explaining the scope. */
  incremental?: { since: string; files: number };
}

export function renderSummaryBody(
  model: string,
  summary: string,
  findings: Finding[],
  unanchored: Finding[],
  usage?: TokenUsage,
  options: SummaryBodyOptions = {},
): string {
  const lines: string[] = [];

  const marker = options.headSha ? `:model=${model}:sha=${options.headSha}` : `:model=${model}`;
  lines.push(`${MARKER_SUMMARY}${marker} -->`);
  lines.push('');
  lines.push('## Ollama review');
  lines.push('');
  lines.push(summary);
  lines.push('');

  if (options.incremental) {
    const { since, files } = options.incremental;
    lines.push(
      `_Incremental review: only the ${files} file${files === 1 ? '' : 's'} that changed since \`${since.slice(0, 7)}\` were re-reviewed; findings on unchanged files are from the previous review._`,
    );
    lines.push('');
  }

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

  const format = (value: number): string => value.toLocaleString('en-US');
  const footer = [
    `Reviewed with \`${model}\` - ${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
  ];

  if (usage) {
    footer.push(
      `${format(usage.totalTokens)} tokens (${format(usage.promptTokens)} in / ${format(
        usage.completionTokens,
      )} out)`,
    );
  }

  lines.push(`<sub>${footer.join(' · ')}</sub>`);

  return lines.join('\n');
}
