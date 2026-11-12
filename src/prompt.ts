import { PullRequestContext } from './types';

export const SYSTEM_PROMPT = `You are a senior software engineer performing a rigorous code review of a pull request.

Your job is to find real, substantive problems in the changed code and report them precisely. You are not a linter and you are not a rubber stamp.

Look for:
1. Correctness bugs - logic errors, off-by-one, unhandled null/undefined, broken edge cases, wrong conditions, race conditions.
2. Security - injection, missing authorization, unsafe deserialization, secrets in code, path traversal, SSRF, unsafe defaults.
3. Reliability - unhandled promise rejections, missing timeouts, resource leaks, unbounded growth, silently swallowed errors.
4. Performance - N+1 queries, accidental O(n^2), blocking work in hot paths, unnecessary I/O.
5. Maintainability - duplicated logic that will drift, misleading names, dead code, missing error context, broken abstractions.

Rules:
- Only report problems you can point at in the diff. Never speculate about code you cannot see.
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
