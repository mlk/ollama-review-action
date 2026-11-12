import { Finding, isSeverity, Severity } from './types';

export interface ParsedReview {
  summary: string;
  findings: Finding[];
}

/**
 * Slices the first balanced JSON object out of `text`, ignoring braces that
 * appear inside string literals.
 */
function sliceJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in the model response.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error('Unterminated JSON object in the model response.');
}

/**
 * Extracts the JSON object from a model response, tolerating markdown fences,
 * reasoning blocks and leading/trailing prose.
 */
export function extractJsonObject(text: string): unknown {
  let cleaned = text.trim();

  // Only strip a fence when the whole response is a single fenced block. A
  // fence can legitimately appear inside a JSON string value.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(cleaned);
  if (fence?.[1]) {
    cleaned = fence[1].trim();
  }

  // Strip thinking blocks emitted by reasoning models. An unterminated block
  // only loses its opening tag, so a JSON payload after it survives.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  cleaned = cleaned.replace(/<think>/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to locating a balanced object somewhere in the response.
  }

  let cursor = cleaned.indexOf('{');
  while (cursor !== -1) {
    const remainder = cleaned.slice(cursor);
    try {
      return JSON.parse(sliceJsonObject(remainder));
    } catch {
      cursor = cleaned.indexOf('{', cursor + 1);
    }
  }

  throw new Error('No JSON object found in the model response.');
}

function normalizeSeverity(value: unknown): Severity {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (isSeverity(lower)) {
      return lower;
    }
    // Common synonyms seen in the wild.
    if (['blocker', 'critical'].includes(lower)) {
      return 'critical';
    }
    if (['error', 'high', 'important'].includes(lower)) {
      return 'major';
    }
    if (['warning', 'warn', 'medium', 'moderate'].includes(lower)) {
      return 'minor';
    }
    if (['info', 'informational', 'style', 'low', 'trivial'].includes(lower)) {
      return 'nit';
    }
  }
  return 'minor';
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * Parses the model response into a summary and a list of findings, dropping
 * anything that is structurally invalid.
 */
export function parseReview(text: string): ParsedReview {
  const payload = extractJsonObject(text);

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('The model response was not a JSON object.');
  }

  const record = payload as Record<string, unknown>;
  const summary = asString(record.summary) || 'No summary was provided.';
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];

  const findings: Finding[] = [];

  for (const entry of rawFindings) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const item = entry as Record<string, unknown>;
    const path = asString(item.path);
    const line = Number(item.line);
    const body = asString(item.body);
    const title = asString(item.title);

    if (path === '' || !Number.isFinite(line) || line < 1) {
      continue;
    }

    const finding: Finding = {
      path,
      line: Math.floor(line),
      severity: normalizeSeverity(item.severity),
      title: title || 'Review comment',
      body,
    };

    const endLine = Number(item.end_line);
    if (Number.isFinite(endLine) && endLine > finding.line) {
      finding.end_line = Math.floor(endLine);
    }

    const suggestion = asString(item.suggestion);
    if (suggestion !== '') {
      finding.suggestion = suggestion;
    }

    findings.push(finding);
  }

  return { summary, findings };
}
