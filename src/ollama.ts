import { warning } from '@actions/core';

import { TokenUsage } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaClientOptions {
  host: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  retries?: number;
  /** Base delay for the exponential backoff between retries. */
  retryDelayMs?: number;
}

export interface ChatResult {
  content: string;
  usage?: TokenUsage;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: { message?: string };
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A redirect we refuse to follow. Retrying will not change the answer. */
class RedirectError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return undefined;
  }
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined;
}

function parseUsage(usage: ChatCompletionResponse['usage']): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = tokenCount(usage.prompt_tokens);
  const completionTokens = tokenCount(usage.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }
  const totalTokens = tokenCount(usage.total_tokens) ?? promptTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return body ? `${response.status} ${response.statusText} - ${body}` : `${response.status} ${response.statusText}`;
}

/**
 * Fetches `url` without letting the runtime silently follow redirects. The
 * request carries the Ollama bearer token, so a redirect to a different
 * origin is refused outright; same-origin redirects are followed (up to
 * MAX_REDIRECTS) with the method/body adjusted per the usual fetch rules.
 */
async function fetchSameOrigin(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const origin = new URL(url).origin;
  let currentUrl = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = init.headers;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
    });

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new RedirectError(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${url}.`);
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new RedirectError(`Invalid redirect location "${location}" from ${currentUrl}.`);
    }

    if (next.origin !== origin) {
      throw new RedirectError(
        `Refusing to follow redirect from ${origin} to ${next.origin}: ` +
          'the Authorization header would be sent to a different origin.',
      );
    }

    const stripBody =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD');
    if (stripBody) {
      method = 'GET';
      body = undefined;
      headers = dropHeader(headers, 'content-type');
    }

    currentUrl = next.href;
  }
}

function dropHeader(
  headers: RequestInit['headers'],
  name: string,
): RequestInit['headers'] {
  if (!headers) {
    return headers;
  }
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.delete(lower);
    return copy;
  }
  if (Array.isArray(headers)) {
    return (headers as Array<[string, string]>).filter(([key]) => key.toLowerCase() !== lower);
  }
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() !== lower) {
      copy[key] = value;
    }
  }
  return copy;
}

/**
 * Calls the Ollama OpenAI-compatible chat completions endpoint.
 * Returns the assistant message content and, when the host reports it, the token usage.
 */
export async function chatCompletion(
  options: OllamaClientOptions,
  messages: ChatMessage[],
  useJsonMode = true,
): Promise<ChatResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const endpoint = `${options.host}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: false,
    temperature: options.temperature,
  };

  if (useJsonMode) {
    body.response_format = { type: 'json_object' };
  }

  if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;

    try {
      response = await fetchSameOrigin(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A refused redirect is a fact about the endpoint, not a transient failure.
      if (error instanceof RedirectError) {
        throw error;
      }
      // A network error or a timeout. These are worth retrying.
      const err = error instanceof Error ? error : new Error(String(error));
      lastError =
        err.name === 'TimeoutError' || err.name === 'AbortError'
          ? new Error(`Ollama request timed out after ${timeoutMs}ms.`)
          : err;

      if (attempt === retries) {
        break;
      }

      await sleep(2 ** attempt * retryDelayMs);
      continue;
    }

    if (!response.ok) {
      const detail = await readError(response);

      // 400 means the request itself is wrong - retrying will not help.
      if (response.status === 400 && useJsonMode && /response_format|json/i.test(detail)) {
        // The model or host does not support JSON mode - fall back to plain text.
        return chatCompletion(options, messages, false);
      }

      // The direct cloud API uses plain ids ("glm-5.3") while a local Ollama
      // server uses the ":cloud" suffix ("glm-5.3:cloud"). Try the other form
      // before giving up.
      if (
        (response.status === 404 || response.status === 400) &&
        !options.model.endsWith(':cloud') &&
        /model|not found|does not exist/i.test(detail)
      ) {
        warning(`Model "${options.model}" was not found, retrying as "${options.model}:cloud".`);
        return chatCompletion({ ...options, model: `${options.model}:cloud` }, messages, useJsonMode);
      }

      // Only rate limits and server errors are worth another attempt. A 401 or a
      // 404 will fail the same way every time, so fail immediately.
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Ollama request failed: ${detail}`);
      }

      lastError = new Error(`Ollama request failed: ${detail}`);

      if (attempt === retries) {
        break;
      }

      await sleep(2 ** attempt * retryDelayMs);
      continue;
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const message = payload.choices?.[0]?.message;
    const content = message?.content?.trim();

    if (!content) {
      throw new Error('Ollama returned an empty response.');
    }

    return { content, usage: parseUsage(payload.usage) };
  }

  throw lastError ?? new Error('Ollama request failed.');
}
