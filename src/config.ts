import * as core from '@actions/core';

import { isSeverity, Severity } from './types';

export interface Config {
  model: string;
  apiKey: string;
  host: string;
  token: string;
  extraPrompt: string;
  maxDiffChars: number;
  maxFiles: number;
  excludePaths: string[];
  reasoningEffort: string;
  temperature: number;
  failOn: Severity | 'none';
  postReview: boolean;
}

function getIntInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
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
  const raw = core.getInput(name).trim();
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

export function loadConfig(): Config {
  const model = core.getInput('model').trim();
  if (model === '') {
    throw new Error(
      'Input "model" is required. Pass a cloud model id, for example: ' +
        "with:\n  model: 'glm-5.3'",
    );
  }

  const apiKey = core.getInput('ollama_api_key').trim() || (process.env.OLLAMA_API_KEY ?? '').trim();
  if (apiKey === '') {
    throw new Error(
      'No Ollama API key found. Set the OLLAMA_API_KEY environment variable or pass the ' +
        '"ollama_api_key" input. Create a key at https://ollama.com/settings/keys',
    );
  }

  const host = (core.getInput('ollama_host').trim() || 'https://ollama.com').replace(/\/+$/, '');

  const token =
    core.getInput('github-token').trim() || (process.env.GITHUB_TOKEN ?? '').trim();
  if (token === '') {
    throw new Error(
      'No GitHub token found. Give the job "pull-requests: write" permission and pass ' +
        'GITHUB_TOKEN: ${{ github.token }}.',
    );
  }

  const failOnRaw = core.getInput('fail_on').trim().toLowerCase() || 'none';
  if (failOnRaw !== 'none' && !isSeverity(failOnRaw)) {
    throw new Error(`Input "fail_on" must be one of none, nit, minor, major, critical, blocker.`);
  }

  const temperatureRaw = core.getInput('temperature').trim();
  const temperature = temperatureRaw === '' ? 0.2 : Number(temperatureRaw);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Input "temperature" must be a number between 0 and 2, got "${temperatureRaw}".`);
  }

  const excludePaths = core
    .getInput('exclude_paths')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');

  return {
    model,
    apiKey,
    host,
    token,
    extraPrompt: core.getInput('prompt').trim(),
    maxDiffChars: getIntInput('max_diff_chars', 60000),
    maxFiles: getIntInput('max_files', 50),
    excludePaths,
    reasoningEffort: core.getInput('reasoning_effort').trim(),
    temperature,
    failOn: failOnRaw as Severity | 'none',
    postReview: getBoolInput('post_review', true),
  };
}
