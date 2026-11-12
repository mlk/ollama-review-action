export type Severity = 'blocker' | 'critical' | 'major' | 'minor' | 'nit';

export const SEVERITIES: Severity[] = ['nit', 'minor', 'major', 'critical', 'blocker'];

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as string[]).includes(value);
}

/** Returns true when `severity` is at least as serious as `threshold`. */
export function meetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(threshold);
}

export interface Finding {
  /** Repository-relative path of the file the finding applies to. */
  path: string;
  /** Line number in the new revision of the file. */
  line: number;
  /** Optional last line of a multi-line range. */
  end_line?: number;
  severity: Severity;
  title: string;
  body: string;
  /** Optional replacement code, rendered as a GitHub suggestion block. */
  suggestion?: string;
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  /** Line number in the new revision of the file. */
  newLine?: number;
  /** Line number in the previous revision of the file. */
  oldLine?: number;
  /** Present on `hunk` lines: the raw `@@ -a,b +c,d @@` header. */
  hunkHeader?: string;
}

export interface FileDiff {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Raw unified diff from the GitHub API. Undefined when GitHub truncates it. */
  patch?: string;
  lines: DiffLine[];
  /** New-file line numbers that GitHub accepts review comments on. */
  commentableLines: number[];
  /** True when GitHub omitted the patch because the diff is too large. */
  truncated: boolean;
}

export interface PullRequestContext {
  number: number;
  headSha: string;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
}
