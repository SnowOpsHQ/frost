// Spec: specs/agent-protocol.schema.ts (fetch.*) · Acceptance: specs/agent-runtime.feature.md (Proxied fetch)
import { describe, expect, test } from 'vitest';
import { AGENT_PROTOCOL_LIMITS, type RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { createProxyFetch, ProxyFetchError } from '../proxy-fetch';

function setup() {
  const posted: RuntimeToMainMessage[] = [];
  let n = 0;
  const proxy = createProxyFetch(
    (message) => {
      posted.push(message);
      return true;
    },
    () => `req-${(n += 1)}`,
  );
  return { proxy, posted };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe('proxied fetch', () => {
  test('proxy-fetch-streams-body', async () => {
    const { proxy, posted } = setup();
    const pending = proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: '{"stream":true}' });
    await Promise.resolve();
    expect(posted).toEqual([
      {
        type: 'fetch.request',
        requestId: 'req-1',
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: [
          ['anthropic-version', '2023-06-01'],
          ['content-type', 'application/json'],
        ],
        body: '{"stream":true}',
      },
    ]);
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-1', status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    proxy.handle({ type: 'fetch.chunk', requestId: 'req-1', bytes: encode('data: one\n\n') });
    proxy.handle({ type: 'fetch.chunk', requestId: 'req-1', bytes: encode('data: two\n\n') });
    proxy.handle({ type: 'fetch.end', requestId: 'req-1' });
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n');
    expect(proxy.pending).toBe(0);
  });

  test('proxy-fetch-streams-body (bytes body, URL input)', async () => {
    const { proxy, posted } = setup();
    const pending = proxy.fetch(new URL('https://api.openai.com/v1/responses'), { method: 'post', body: encode('{}') });
    await Promise.resolve();
    expect(posted[0]).toMatchObject({ method: 'POST', url: 'https://api.openai.com/v1/responses', body: encode('{}') });
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-1', status: 204, statusText: 'No Content', headers: [] });
    expect((await pending).status).toBe(204);
  });

  test('proxy-fetch-strips-credentials', async () => {
    const { proxy, posted } = setup();
    void proxy.fetch('https://ai-gateway.vercel.sh/v4/ai/language-model', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer frost-placeholder-key',
        'x-api-key': 'frost-placeholder-key',
        'Proxy-Authorization': 'Basic abc',
        'api-key': 'k',
        Cookie: 'a=b',
        'ai-gateway-auth-method': 'api-key',
      },
      body: '{}',
    });
    await Promise.resolve();
    const request = posted[0];
    if (request?.type !== 'fetch.request') throw new Error('no request');
    expect(request.headers.map(([name]) => name)).toEqual(['ai-gateway-auth-method']);
  });

  test('proxy-fetch-abort', async () => {
    const { proxy, posted } = setup();
    // Aborted while waiting for the head.
    const before = new AbortController();
    const pending = proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', signal: before.signal });
    await Promise.resolve();
    before.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.at(-1)).toEqual({ type: 'fetch.abort', requestId: 'req-1' });
    // A late answer is ignored.
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-1', status: 200, statusText: 'OK', headers: [] });

    // Aborted while the body streams.
    const during = new AbortController();
    const streaming = proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', signal: during.signal });
    await Promise.resolve();
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-2', status: 200, statusText: 'OK', headers: [] });
    const response = await streaming;
    const reader = response.body!.getReader();
    proxy.handle({ type: 'fetch.chunk', requestId: 'req-2', bytes: encode('part') });
    expect((await reader.read()).value).toEqual(encode('part'));
    during.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.at(-1)).toEqual({ type: 'fetch.abort', requestId: 'req-2' });

    // Already aborted: nothing is posted.
    const count = posted.length;
    await expect(proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted.length).toBe(count);
    expect(proxy.pending).toBe(0);
  });

  test('proxy-fetch-abort (the body is cancelled)', async () => {
    const { proxy, posted } = setup();
    const pending = proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
    await Promise.resolve();
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-1', status: 200, statusText: 'OK', headers: [] });
    await (await pending).body!.cancel();
    expect(posted.at(-1)).toEqual({ type: 'fetch.abort', requestId: 'req-1' });
    expect(proxy.pending).toBe(0);
  });

  test('proxy-fetch-error', async () => {
    const { proxy } = setup();
    const refused = proxy.fetch('https://example.com/', { method: 'POST', body: '{}' });
    await Promise.resolve();
    proxy.handle({ type: 'fetch.error', requestId: 'req-1', code: 'refused', message: 'not allowed' });
    await expect(refused).rejects.toBeInstanceOf(ProxyFetchError);
    await expect(refused).rejects.toMatchObject({ code: 'refused' });

    const cut = proxy.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
    await Promise.resolve();
    proxy.handle({ type: 'fetch.response-start', requestId: 'req-2', status: 200, statusText: 'OK', headers: [] });
    const response = await cut;
    proxy.handle({ type: 'fetch.error', requestId: 'req-2', code: 'timeout', message: 'too slow' });
    await expect(response.text()).rejects.toMatchObject({ code: 'timeout' });
  });

  test('proxy-fetch-refuses-locally', async () => {
    const { proxy, posted } = setup();
    const url = 'https://api.anthropic.com/v1/messages';
    await expect(proxy.fetch(url, { method: 'POST', body: 'x'.repeat(AGENT_PROTOCOL_LIMITS.maxRequestBodyBytes + 1) })).rejects.toMatchObject({ code: 'too-large' });
    await expect(proxy.fetch(url, { method: 'PUT', body: '{}' })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(proxy.fetch(url, { method: 'POST', body: new ReadableStream(), duplex: 'half' } as RequestInit)).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(proxy.fetch(url, { method: 'GET', body: '{}' } as RequestInit)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(posted).toEqual([]);
  });
});
