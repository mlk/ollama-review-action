import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../src/config';

const ENV_KEYS = [
  'INPUT_MODEL',
  'INPUT_OLLAMA_API_KEY',
  'INPUT_OLLAMA_HOST',
  'INPUT_GITHUB-TOKEN',
  'INPUT_PROMPT',
  'INPUT_MAX_DIFF_CHARS',
  'INPUT_MAX_FILES',
  'INPUT_EXCLUDE_PATHS',
  'INPUT_CONTEXT_FILES',
  'INPUT_CONTEXT_MAX_CHARS',
  'INPUT_REASONING_EFFORT',
  'INPUT_TEMPERATURE',
  'INPUT_FAIL_ON',
  'INPUT_POST_REVIEW',
  'INPUT_INCREMENTAL',
  'OLLAMA_API_KEY',
  'GITHUB_TOKEN',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

function baseEnv(): void {
  process.env.INPUT_MODEL = 'glm-5.3';
  process.env.OLLAMA_API_KEY = 'key-from-env';
  process.env.GITHUB_TOKEN = 'gh-token';
}

describe('loadConfig', () => {
  it('requires a model', () => {
    process.env.OLLAMA_API_KEY = 'key';
    process.env.GITHUB_TOKEN = 'token';
    assert.throws(() => loadConfig(), /Input "model" is required/);
  });

  it('requires an API key', () => {
    process.env.INPUT_MODEL = 'glm-5.3';
    process.env.GITHUB_TOKEN = 'token';
    assert.throws(() => loadConfig(), /No Ollama API key found/);
  });

  it('requires a GitHub token', () => {
    process.env.INPUT_MODEL = 'glm-5.3';
    process.env.OLLAMA_API_KEY = 'key';
    assert.throws(() => loadConfig(), /No GitHub token found/);
  });

  it('reads the API key from the environment', () => {
    baseEnv();
    assert.equal(loadConfig().apiKey, 'key-from-env');
  });

  it('prefers the API key input over the environment', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_API_KEY = 'key-from-input';
    assert.equal(loadConfig().apiKey, 'key-from-input');
  });

  it('prefers the github-token input over the environment', () => {
    baseEnv();
    process.env['INPUT_GITHUB-TOKEN'] = 'input-token';
    assert.equal(loadConfig().token, 'input-token');
  });

  it('falls back to the GITHUB_TOKEN environment variable', () => {
    baseEnv();
    assert.equal(loadConfig().token, 'gh-token');
  });

  it('defaults the host to the Ollama cloud API', () => {
    baseEnv();
    assert.equal(loadConfig().host, 'https://ollama.com');
  });

  it('strips trailing slashes from the host', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_HOST = 'https://proxy.internal///';
    assert.equal(loadConfig().host, 'https://proxy.internal');
  });

  it('applies the documented defaults', () => {
    baseEnv();
    const config = loadConfig();

    assert.equal(config.maxDiffChars, 60000);
    assert.equal(config.maxFiles, 50);
    assert.equal(config.temperature, 0.2);
    assert.equal(config.failOn, 'none');
    assert.equal(config.postReview, true);
    assert.deepEqual(config.excludePaths, []);
    // The default list lives in action.yml; the loader only sees the input value.
    assert.deepEqual(config.contextFiles, []);
    assert.equal(config.contextMaxChars, 12000);
    assert.equal(config.extraPrompt, '');
    assert.equal(config.reasoningEffort, '');
  });

  it('parses numeric inputs', () => {
    baseEnv();
    process.env.INPUT_MAX_DIFF_CHARS = '1234';
    process.env.INPUT_MAX_FILES = '7';
    process.env.INPUT_TEMPERATURE = '0.9';

    const config = loadConfig();

    assert.equal(config.maxDiffChars, 1234);
    assert.equal(config.maxFiles, 7);
    assert.equal(config.temperature, 0.9);
  });

  it('rejects a non-positive number', () => {
    baseEnv();
    process.env.INPUT_MAX_FILES = '0';
    assert.throws(() => loadConfig(), /must be a positive number/);
  });

  it('rejects a non-numeric number', () => {
    baseEnv();
    process.env.INPUT_MAX_DIFF_CHARS = 'lots';
    assert.throws(() => loadConfig(), /must be a positive number/);
  });

  it('rejects a temperature outside 0..2', () => {
    baseEnv();
    process.env.INPUT_TEMPERATURE = '5';
    assert.throws(() => loadConfig(), /between 0 and 2/);
  });

  it('parses boolean inputs', () => {
    baseEnv();
    process.env.INPUT_POST_REVIEW = 'false';
    assert.equal(loadConfig().postReview, false);

    process.env.INPUT_POST_REVIEW = 'yes';
    assert.equal(loadConfig().postReview, true);
  });

  it('rejects a non-boolean value', () => {
    baseEnv();
    process.env.INPUT_POST_REVIEW = 'maybe';
    assert.throws(() => loadConfig(), /must be a boolean/);
  });

  it('defaults incremental re-review to true', () => {
    baseEnv();
    assert.equal(loadConfig().incremental, true);
  });

  it('can disable incremental re-review', () => {
    baseEnv();
    process.env.INPUT_INCREMENTAL = 'false';
    assert.equal(loadConfig().incremental, false);
  });

  it('accepts a fail_on severity', () => {
    baseEnv();
    process.env.INPUT_FAIL_ON = 'critical';
    assert.equal(loadConfig().failOn, 'critical');
  });

  it('rejects an unknown fail_on severity', () => {
    baseEnv();
    process.env.INPUT_FAIL_ON = 'catastrophic';
    assert.throws(() => loadConfig(), /must be one of none, nit, minor, major, critical, blocker/);
  });

  it('splits and trims exclude_paths', () => {
    baseEnv();
    process.env.INPUT_EXCLUDE_PATHS = ' **/*.lock , dist/** , ';
    assert.deepEqual(loadConfig().excludePaths, ['**/*.lock', 'dist/**']);
  });

  it('splits and trims context_files', () => {
    baseEnv();
    process.env.INPUT_CONTEXT_FILES = ' AGENTS.md , CONTRIBUTING.md ';
    assert.deepEqual(loadConfig().contextFiles, ['AGENTS.md', 'CONTRIBUTING.md']);
  });

  it('parses context_max_chars', () => {
    baseEnv();
    process.env.INPUT_CONTEXT_MAX_CHARS = '4000';
    assert.equal(loadConfig().contextMaxChars, 4000);
  });

  it('rejects a non-numeric context_max_chars', () => {
    baseEnv();
    process.env.INPUT_CONTEXT_MAX_CHARS = 'lots';
    assert.throws(() => loadConfig(), /context_max_chars/);
  });

  it('disables context files when set to none', () => {
    baseEnv();
    process.env.INPUT_CONTEXT_FILES = 'none';
    assert.deepEqual(loadConfig().contextFiles, []);
  });

  it('accepts an https host', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_HOST = 'https://proxy.internal:8443';
    assert.equal(loadConfig().host, 'https://proxy.internal:8443');
  });

  it('accepts loopback http hosts for local development', () => {
    baseEnv();
    for (const host of [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://127.1.2.3:11434',
      'http://[::1]:11434',
    ]) {
      process.env.INPUT_OLLAMA_HOST = host;
      assert.equal(loadConfig().host, host);
    }
  });

  it('rejects plain http for non-loopback hosts', () => {
    baseEnv();
    for (const host of [
      'http://ollama.com',
      'http://192.168.1.10:11434',
      'http://127.0.0.1.evil.com',
      'http://localhost.evil.example.com',
    ]) {
      process.env.INPUT_OLLAMA_HOST = host;
      assert.throws(() => loadConfig(), /must use https/);
    }
  });

  it('rejects non-http schemes', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_HOST = 'ftp://proxy.internal';
    assert.throws(() => loadConfig(), /must use https/);
  });

  it('rejects a host that is not a URL', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_HOST = 'not a url';
    assert.throws(() => loadConfig(), /not a valid URL/);
  });

  it('rejects a host with embedded credentials', () => {
    baseEnv();
    process.env.INPUT_OLLAMA_HOST = 'https://user:pass@proxy.internal';
    assert.throws(() => loadConfig(), /embedded credentials/);
  });
});
