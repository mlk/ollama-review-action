import { getInput } from '@actions/core';

import { isReviewProfile, ReviewProfile, REVIEW_PROFILES } from './prompt';
import { isSeverity, Severity } from './types';

/** Default per-file cap for context files, in characters. Kept in sync with the
 * context_max_chars input default in action.yml. */
export const DEFAULT_CONTEXT_MAX_CHARS = 12_000;

export interface Config {
  model: string;
  apiKey: string;
  host: string;
  token: string;
  extraPrompt: string;
  maxDiffChars: number;
  maxFiles: number;
  excludePaths: string[];
  contextFiles: string[];
  contextMaxChars: number;
  reasoningEffort: string;
  temperature: number;
  profile: ReviewProfile;
  failOn: Severity | 'none';
  postReview: boolean;
}

function getIntInput(name: string, fallback: number): number {
  const raw = getInput(name).trim();
  if (raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Input "${name}" must be a positive number, got "${raw}".`);
  }
  return Math.floor(value);
}

function getBoolInput(name: string, fallback: boolean): boolean {
  const raw = getInput(name).trim();
  if (raw === '') {
    return fallback;
  }
  if (/^(true|yes|1)$/i.test(raw)) {
    return true;
  }
  if (/^(false|no|0)$/i.test(raw)) {
    return false;
  }
  throw new Error(`Input "${name}" must be a boolean, got "${raw}".`);
}

/**
 * The API key is sent as a bearer token to every request, so the host must be
 * somewhere that token is safe to send. https:// is required, with the only
 * exception of loopback addresses for local development.
 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host === '::1' || host === '::ffff:127.0.0.1' || host === '::ffff:7f00:1') {
    return true;
  }
  const octets = host.split('.');
  if (octets.length !== 4) {
    return false;
  }
  if (octets[0] !== '127') {
    return false;
  }
  return octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validateHost(raw: string): string {
  const host = (raw.trim() || 'https://ollama.com').replace(/\/+$/, '');

  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Input "ollama_host" is not a valid URL, got "${host}".`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Input "ollama_host" must use https://, got "${url.protocol}//" in "${host}".`);
  }

  if (url.username || url.password) {
    throw new Error(`Input "ollama_host" must not contain embedded credentials, got "${host}".`);
  }

  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      `Input "ollama_host" must use https:// - plain http is only allowed for local development ` +
        `(localhost, 127.0.0.0/8, [::1]), got "${host}".`,
    );
  }

  return host;
}

function getContextFiles(raw: string): string[] {
  const trimmed = raw.trim();
  if (/^(none|off|false)$/i.test(trimmed)) {
    return [];
  }
  return trimmed
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

export function loadConfig(): Config {
  const model = getInput('model').trim();
  if (model === '') {
    throw new Error(
      'Input "model" is required. Pass a cloud model id, for example: ' +
        "with:\n  model: 'glm-5.3'",
    );
  }

  const apiKey = getInput('ollama_api_key').trim() || (process.env.OLLAMA_API_KEY ?? '').trim();
  if (apiKey === '') {
    throw new Error(
      'No Ollama API key found. Set the OLLAMA_API_KEY environment variable or pass the ' +
        '"ollama_api_key" input. Create a key at https://ollama.com/settings/keys',
    );
  }

  const host = validateHost(getInput('ollama_host'));

  const token = getInput('github-token').trim() || (process.env.GITHUB_TOKEN ?? '').trim();
  if (token === '') {
    throw new Error(
      'No GitHub token found. Give the job "pull-requests: write" permission and make sure ' +
        'the action can see a token, for example by adding:\n' +
        '  env:\n    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    );
  }

  const profileRaw = getInput('profile').trim().toLowerCase() || 'default';
  if (!isReviewProfile(profileRaw)) {
    throw new Error(`Input "profile" must be one of ${REVIEW_PROFILES.join(', ')}, got "${profileRaw}".`);
  }

  const failOnRaw = getInput('fail_on').trim().toLowerCase() || 'none';
  if (failOnRaw !== 'none' && !isSeverity(failOnRaw)) {
    throw new Error(`Input "fail_on" must be one of none, nit, minor, major, critical, blocker.`);
  }

  const temperatureRaw = getInput('temperature').trim();
  const temperature = temperatureRaw === '' ? 0.2 : Number(temperatureRaw);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Input "temperature" must be a number between 0 and 2, got "${temperatureRaw}".`);
  }

  const excludePaths = getInput('exclude_paths')
    .split(',')
    .map((pattern: string) => pattern.trim())
    .filter((pattern: string) => pattern !== '');

  return {
    model,
    apiKey,
    host,
    token,
    extraPrompt: getInput('prompt').trim(),
    maxDiffChars: getIntInput('max_diff_chars', 60000),
    maxFiles: getIntInput('max_files', 50),
    excludePaths,
    contextFiles: getContextFiles(getInput('context_files')),
    contextMaxChars: getIntInput('context_max_chars', DEFAULT_CONTEXT_MAX_CHARS),
    reasoningEffort: getInput('reasoning_effort').trim(),
    temperature,
    profile: profileRaw,
    failOn: failOnRaw as Severity | 'none',
    postReview: getBoolInput('post_review', true),
  };
}
