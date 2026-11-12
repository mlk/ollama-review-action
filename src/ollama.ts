import { warning } from '@actions/core';

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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  error?: { message?: string };
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return body ? `${response.status} ${response.statusText} - ${body}` : `${response.status} ${response.statusText}`;
}

/**
 * Calls the Ollama OpenAI-compatible chat completions endpoint.
 * Returns the assistant message content.
 */
export async function chatCompletion(
  options: OllamaClientOptions,
  messages: ChatMessage[],
  useJsonMode = true,
): Promise<string> {
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
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
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

    return content;
  }

  throw lastError ?? new Error('Ollama request failed.');
}
