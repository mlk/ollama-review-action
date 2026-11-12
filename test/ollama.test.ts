import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { chatCompletion } from '../src/ollama';

type FetchCall = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (call: FetchCall, attempt: number) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;

  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const messages = [
  { role: 'system' as const, content: 'system' },
  { role: 'user' as const, content: 'user' },
];

const options = {
  host: 'https://ollama.com',
  apiKey: 'secret',
  model: 'glm-5.3',
  temperature: 0.2,
  retryDelayMs: 0,
};

describe('chatCompletion', () => {
  it('returns the assistant content', async () => {
    mockFetch(() => chatResponse('hello'));
    assert.equal(await chatCompletion(options, messages), 'hello');
  });

  it('posts to the chat completions endpoint with a bearer token', async () => {
    const { calls } = mockFetch(() => chatResponse('hello'));
    await chatCompletion(options, messages);

    assert.equal(calls[0]?.url, 'https://ollama.com/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('sends the model, messages and temperature', async () => {
    const { calls } = mockFetch(() => chatResponse('hello'));
    await chatCompletion(options, messages);

    const body = JSON.parse(String(calls[0]?.init.body));
    assert.equal(body.model, 'glm-5.3');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, messages);
  });

  it('requests JSON output by default', async () => {
    const { calls } = mockFetch(() => chatResponse('{}'));
    await chatCompletion(options, messages);

    const body = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  it('omits response_format when JSON mode is off', async () => {
    const { calls } = mockFetch(() => chatResponse('{}'));
    await chatCompletion(options, messages, false);

    const body = JSON.parse(String(calls[0]?.init.body));
    assert.equal(body.response_format, undefined);
  });

  it('sends the reasoning effort when set', async () => {
    const { calls } = mockFetch(() => chatResponse('{}'));
    await chatCompletion({ ...options, reasoningEffort: 'high' }, messages);

    const body = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(body.reasoning, { effort: 'high' });
  });

  it('throws on an empty response', async () => {
    mockFetch(() => jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    await assert.rejects(() => chatCompletion(options, messages), /empty response/);
  });

  it('falls back to plain text when the host rejects JSON mode', async () => {
    const { calls } = mockFetch((_call, attempt) => {
      if (attempt === 0) {
        return new Response('response_format is not supported', { status: 400 });
      }
      return chatResponse('plain');
    });

    assert.equal(await chatCompletion(options, messages), 'plain');
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(String(calls[1]?.init.body)).response_format, undefined);
  });

  it('retries a model id with the :cloud suffix when it is not found', async () => {
    const { calls } = mockFetch((_call, attempt) => {
      if (attempt === 0) {
        return new Response('model "glm-5.3" not found', { status: 404 });
      }
      return chatResponse('ok');
    });

    assert.equal(await chatCompletion(options, messages), 'ok');
    assert.equal(JSON.parse(String(calls[0]?.init.body)).model, 'glm-5.3');
    assert.equal(JSON.parse(String(calls[1]?.init.body)).model, 'glm-5.3:cloud');
  });

  it('does not retry the :cloud suffix twice', async () => {
    const { calls } = mockFetch(() => new Response('model not found', { status: 404 }));

    await assert.rejects(() => chatCompletion(options, messages), /Ollama request failed/);
    assert.equal(calls.length, 2);
  });

  it('does not retry a 400 that is not about JSON mode', async () => {
    const { calls } = mockFetch(() => new Response('bad request', { status: 400 }));

    await assert.rejects(() => chatCompletion(options, messages), /Ollama request failed/);
    assert.equal(calls.length, 1);
  });

  it('retries a server error and then succeeds', async () => {
    const { calls } = mockFetch((_call, attempt) => {
      if (attempt < 2) {
        return new Response('boom', { status: 500 });
      }
      return chatResponse('recovered');
    });

    assert.equal(await chatCompletion(options, messages), 'recovered');
    assert.equal(calls.length, 3);
  });

  it('retries a rate limit', async () => {
    const { calls } = mockFetch((_call, attempt) => {
      if (attempt === 0) {
        return new Response('slow down', { status: 429 });
      }
      return chatResponse('ok');
    });

    assert.equal(await chatCompletion(options, messages), 'ok');
    assert.equal(calls.length, 2);
  });

  it('gives up after exhausting the retries', async () => {
    const { calls } = mockFetch(() => new Response('boom', { status: 500 }));

    await assert.rejects(() => chatCompletion(options, messages), /Ollama request failed/);
    assert.equal(calls.length, 3);
  });

  it('does not retry a 401', async () => {
    const { calls } = mockFetch(() => new Response('unauthorized', { status: 401 }));

    await assert.rejects(() => chatCompletion(options, messages), /Ollama request failed/);
    assert.equal(calls.length, 1);
  });
});
