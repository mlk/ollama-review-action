import { PullRequestContext, RepoContextFile } from './types';

export const REVIEW_PROFILES = ['default', 'security', 'performance', 'maintainability'] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

export function isReviewProfile(value: string): value is ReviewProfile {
  return (REVIEW_PROFILES as readonly string[]).includes(value);
}

const INTRO =
  'You are a senior software engineer performing a rigorous code review of a pull request.\n\n' +
  'Your job is to find real, substantive problems in the changed code and report them precisely. You are not a linter and you are not a rubber stamp.';

const FOCUS: Record<ReviewProfile, string> = {
  default: `Look for:
1. Correctness bugs - logic errors, off-by-one, unhandled null/undefined, broken edge cases, wrong conditions, race conditions.
2. Security - injection, missing authorization, unsafe deserialization, secrets in code, path traversal, SSRF, unsafe defaults.
3. Reliability - unhandled promise rejections, missing timeouts, resource leaks, unbounded growth, silently swallowed errors.
4. Performance - N+1 queries, accidental O(n^2), blocking work in hot paths, unnecessary I/O.
5. Maintainability - duplicated logic that will drift, misleading names, dead code, missing error context, broken abstractions.`,

  security: `Look for, with security as the lens:
1. Injection - SQL, command, template and log injection, path traversal, SSRF, unsafe deserialization, unsafe XML/regex handling.
2. Authentication and access control - missing or broken authorization checks, privilege escalation, insecure direct object references, weak session or token handling.
3. Secrets and sensitive data - credentials in code, secrets in logs, PII exposure, overly broad data returned to callers.
4. Unsafe defaults and cryptography - weak or misused crypto, missing input validation at trust boundaries, disabled certificate verification, permissive CORS, unsafe redirect targets.
5. Correctness bugs only where they create a security impact - a logic error that bypasses a check, corrupts an auth decision, or exposes data. Do not report general bugs that have no security consequence.
Do not invent vulnerabilities: if the diff does not show the missing check, unsafe call or exposed secret, there is no finding - the honesty rules below apply in full.`,

  performance: `Look for, with performance as the lens:
1. Accidental quadratic behaviour - nested loops over the same collection, repeated scans, O(n^2) algorithms on inputs that can grow.
2. N+1 queries and chatty I/O - queries or network requests inside loops, missing batching, loops that serialize what could be parallel.
3. Blocking work on hot paths - synchronous I/O in request handlers, CPU-heavy work that does not need to happen per request, missing caching of expensive repeated computation.
4. Unbounded growth - caches and buffers without limits, leaking listeners or handles, missing pagination, memory growth per request.
5. Waste - redundant computation, recomputed values that could be hoisted, unnecessary allocations and copies on hot paths.
Only report a performance issue you can point at in the diff. "This might be slow" without a concrete mechanism is not a finding.`,

  maintainability: `Look for, with maintainability as the lens:
1. Duplicated logic that will drift - copy-pasted blocks with small variations that should be shared or generated.
2. Misleading names and broken abstractions - names that lie about what the code does, leaky abstractions, functions that do several unrelated things.
3. Dead code and leftovers - unreachable branches, unused variables and imports, commented-out code, feature flags that will never flip.
4. Missing error context - swallowed errors, generic messages that do not say what failed or where, error handling that loses the cause.
5. Structural problems - hidden coupling, action at a distance, unclear control flow, inconsistent patterns for the same task.
Do not report style, formatting or naming preferences that a linter would own - report structural issues that will cost real time to change later.`,
};

const RULES = `Rules:
- Only report problems you can point at in the diff. Never speculate about code you cannot see.
- Do not assert facts the diff does not show. Whether a library, model, service, API or version exists is not something the diff can tell you, and you cannot check. If it matters, raise it as a question ("confirm that X is available in the backend") rather than a claim. A confident wrong fact is worse than a missing finding.
- Do not report formatting, import ordering, naming preferences, or anything a linter/formatter already handles.
- Do not report the same problem twice. One finding per distinct issue.
- If the diff is fine, return no findings. An honest short review beats a padded one.
- Every finding must reference a file and a line number that appears in the annotated diff. Line numbers refer to the NEW version of the file.
- Prefer the most severe correct severity:
  blocker = will break production or lose data,
  critical = security hole, data loss, crash on a realistic path,
  major = real bug or serious design problem,
  minor = limited-impact bug or maintainability trap,
  nit = small polish item that is still worth saying.
- Give a concrete fix. When you can, show the replacement code.
- Keep the body tight: what is wrong, why it matters, what to do. No filler.

Respond with JSON only. No prose outside the JSON object.`;

/**
 * Builds the system prompt for a review profile. Honesty and line-anchoring
 * rules are kept verbatim for every profile; only the focus section changes.
 */
export function systemPromptFor(profile: ReviewProfile): string {
  return `${INTRO}\n\n${FOCUS[profile]}\n\n${RULES}`;
}

export const SYSTEM_PROMPT = systemPromptFor('default');

export const OUTPUT_SCHEMA = `{
  "summary": "2-4 sentences assessing the change overall: what it does, whether it looks correct, and the single most important thing to fix.",
  "findings": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "end_line": 47,
      "severity": "blocker|critical|major|minor|nit",
      "title": "Short imperative title",
      "body": "What is wrong, why it matters, and how to fix it.",
      "suggestion": "Optional replacement code for the line range."
    }
  ]
}`;

export function buildUserPrompt(
  context: PullRequestContext,
  diffText: string,
  extraPrompt: string,
  fileCount: number,
  contextFiles: RepoContextFile[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    [
      `Pull request #${context.number}: ${context.title}`,
      `Author: ${context.author}`,
      `Base branch: ${context.baseRef}`,
      `Head branch: ${context.headRef}`,
      `Files in this chunk: ${fileCount}`,
    ].join('\n'),
  );

  const description = context.body.trim();
  if (contextFiles.length > 0) {
    const rendered = contextFiles.map((file) => `### ${file.path}\n${file.content}`).join('\n\n');
    sections.push(
      `Guidance from the repository (files from the base commit, before this pull request). Treat it as authoritative for the project's conventions and intent:\n\n${rendered}`,
    );
  }

  if (description !== '') {
    sections.push(`Description:\n${description}`);
  }

  sections.push(
    [
      'The diff below is annotated with line numbers of the new revision of each file.',
      'A line number appears in the left column for every line that exists in the new file.',
      'Lines prefixed with "-" were deleted and have no line number; you cannot comment on them.',
      '',
      diffText,
    ].join('\n'),
  );

  if (extraPrompt !== '') {
    sections.push(`Additional instructions from the repository owner:\n${extraPrompt}`);
  }

  sections.push(
    [
      'Return JSON only, in exactly this shape:',
      OUTPUT_SCHEMA,
      '',
      'If there are no problems, return {"summary": "...", "findings": []}.',
    ].join('\n'),
  );

  return sections.join('\n\n---\n\n');
}
