// Spec: specs/data-sources.spec.ts (DATA_API_REQUESTS, isAllowedDataRequest, SERPAPI_QUERY_NAMES,
// DATA_API_REQUEST_HEADERS, DATA_API_LIMITS, DATA_API_REFUSALS, DATA_API_REFUSAL_MESSAGES, DATA_API_E2E_SWITCH),
// specs/data-sources.schema.ts (DataApiE2eSeamSchema, isDataApiE2eBase, parseDataApiE2eSeam),
// specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/data-sources.feature.md (Requests) · plan docs/plans/phase-12-big-bets.md, Decision 4,
// Global constraints "Secrets" and "Third-party requests", Threat model, Task 1
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DATA_API_E2E_SWITCH,
  DATA_API_LIMITS,
  DATA_API_REFUSAL_MESSAGES,
  DATA_API_REQUESTS,
  DATA_PROVIDER_PURPOSE,
  DATA_PROVIDERS,
  isAllowedDataRequest,
  SERPAPI_QUERY_NAMES,
} from '@app/specs/data-sources.spec';
import { DATA_API_E2E_SEAM_MAX_CHARS, isDataApiE2eBase, parseDataApiE2eSeam } from '@app/specs/data-sources.schema';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { remoteDebuggingRefusal } from '../../security/policy';
import { createDataApiClient, type DataApiBuild } from '../api-client';
import { dataApiE2eSeamFrom } from '../e2e-seam';
import { allOpen, dataStore, DFS_LOGIN, DFS_PASSWORD, OPENAI_KEY, PERPLEXITY_KEY, recordingFetch, SERPAPI_KEY, SERPER_KEY } from './fakes';

const SERPAPI_URL = DATA_API_REQUESTS.serpapi[0]!.url;
/** A SerpApi URL with `params` encoded by `URLSearchParams` (as Task 3's builder does). */
const serpapiUrl = (params: Record<string, string>): string => `${SERPAPI_URL}?${new URLSearchParams(params).toString()}`;
const serpapiBuild: DataApiBuild = (secrets) => ({ method: 'GET', url: serpapiUrl({ engine: 'google', q: 'frost browser', hl: 'en', api_key: secrets.serpapi! }) });

/** A store with every provider's key set. */
async function keyedStore() {
  const setup = dataStore();
  for (const [slot, key] of [
    ['serpapi', SERPAPI_KEY],
    ['serper', SERPER_KEY],
    ['perplexity', PERPLEXITY_KEY],
    ['openai-search', OPENAI_KEY],
    ['dataforseo-login', DFS_LOGIN],
    ['dataforseo-password', DFS_PASSWORD],
  ] as const) {
    expect(await setup.store.setKey(slot, key)).toBe('stored');
  }
  return setup;
}

function client(store: Awaited<ReturnType<typeof keyedStore>>['store'], fetch: ReturnType<typeof recordingFetch>['fetch'], extra: Partial<Parameters<typeof createDataApiClient>[0]> = {}) {
  const log = vi.fn<(line: string) => void>();
  return { log, api: createDataApiClient({ store, isOpen: allOpen, fetch, log, sleep: async () => undefined, ...extra }) };
}

/** A body stream of `chunk`-byte pieces, up to `total` bytes; counts pulls and notes a cancel. */
function countingBody(total: number, chunk = 256 * 1024) {
  const state = { pulled: 0, sent: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      const size = Math.min(chunk, total - state.sent);
      if (size <= 0) return controller.close();
      state.sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('data API client', () => {
  test('data-api-allowlist (the spec table)', () => {
    for (const provider of DATA_PROVIDERS) {
      for (const target of DATA_API_REQUESTS[provider]) {
        expect(target.purpose).toBe(DATA_PROVIDER_PURPOSE[provider]);
        expect(isAllowedDataRequest(provider, target.purpose, target.method, target.url), provider).toBe(true);
        // Another provider's or purpose's request is not this one's.
        for (const other of DATA_PROVIDERS.filter((p) => p !== provider)) expect(isAllowedDataRequest(other, DATA_PROVIDER_PURPOSE[other], target.method, target.url), `${other} → ${target.url}`).toBe(false);
        expect(isAllowedDataRequest(provider, target.purpose === 'serp' ? 'ai-search' : 'serp', target.method, target.url)).toBe(false);
        const url = new URL(target.url);
        for (const bad of [
          `${url.origin}:443${url.pathname}`,
          target.url.replace('https://', 'http://'),
          `https://${url.hostname}:8443${url.pathname}`,
          `https://evil.example${url.pathname}`,
          `https://${url.hostname}.evil.example${url.pathname}`,
          `https://user:pw@${url.hostname}${url.pathname}`,
          `${target.url}/`,
          `${target.url}x`,
          `${url.origin}/other`,
          `${target.url}#frag`,
          `${target.url}?`,
          `${target.url}?x=1`,
          target.url.toUpperCase(),
          ` ${target.url}`,
          `${url.origin}/./${url.pathname.slice(1)}`,
        ]) {
          expect(isAllowedDataRequest(provider, target.purpose, target.method, bad), bad).toBe(false);
        }
        for (const method of ['PUT', 'DELETE', 'PATCH', 'get', 'post', target.method === 'GET' ? 'POST' : 'GET']) expect(isAllowedDataRequest(provider, target.purpose, method, target.url), method).toBe(false);
      }
    }
    // SerpApi's GET takes its own query names only, each once.
    const names = SERPAPI_QUERY_NAMES.map((name) => `${name}=v`).join('&');
    expect(isAllowedDataRequest('serpapi', 'serp', 'GET', `${SERPAPI_URL}?${names}`)).toBe(true);
    expect(isAllowedDataRequest('serpapi', 'serp', 'GET', `${SERPAPI_URL}?q=a&q=b`)).toBe(false);
    expect(isAllowedDataRequest('serpapi', 'serp', 'GET', `${SERPAPI_URL}?q=a&no_cache=true`)).toBe(false);
    expect(isAllowedDataRequest('serpapi', 'serp', 'GET', `${SERPAPI_URL}?q=a#x`)).toBe(false);
    // Spellings the URL parser would rewrite, or that name the key twice, are refused.
    for (const bad of [
      'https://SerpApi.com/search.json',
      'https://serpapi.com./search.json',
      'https://serpapi.com/search%2Ejson',
      'https://serpapi.com/x/../search.json',
      `${SERPAPI_URL}?api_key=a&api%5Fkey=b`,
    ]) {
      expect(isAllowedDataRequest('serpapi', 'serp', 'GET', bad), bad).toBe(false);
    }
    // Nothing else is a provider.
    for (const value of ['nope', '__proto__', 42, null]) expect(isAllowedDataRequest(value, 'serp', 'GET', SERPAPI_URL)).toBe(false);
  });

  test('data-api-allowlist (refused before any request)', async () => {
    const { store } = await keyedStore();
    const { fetch, calls } = recordingFetch();
    const { api } = client(store, fetch);
    const bad: DataApiBuild[] = [
      () => ({ method: 'GET', url: 'https://evil.example/search.json?q=x' }),
      (s) => ({ method: 'GET', url: `https://serpapi.com:8443/search.json?api_key=${s.serpapi}` }),
      (s) => ({ method: 'GET', url: `https://serpapi.com/account?api_key=${s.serpapi}` }),
      (s) => ({ method: 'POST', url: `${SERPAPI_URL}?api_key=${s.serpapi}`, body: '{}' }),
      (s) => ({ method: 'GET', url: `${SERPAPI_URL}?api_key=${s.serpapi}&no_cache=true` }),
      // A header outside the allowlist, or a body on a GET.
      (s) => ({ method: 'GET', url: `${SERPAPI_URL}?api_key=${s.serpapi}`, headers: { cookie: 'a=b' } }),
      (s) => ({ method: 'GET', url: `${SERPAPI_URL}?api_key=${s.serpapi}`, body: 'x' }),
      // A body larger than the cap.
      () => ({ method: 'POST', url: 'https://google.serper.dev/search', body: 'x'.repeat(DATA_API_LIMITS.maxRequestBytes + 1) }),
      // A header value with a line break.
      (s) => ({ method: 'POST', url: 'https://google.serper.dev/search', headers: { 'x-api-key': `${s.serper}\r\nx: y` }, body: '{}' }),
      // A build that throws (with the key in its message): refused, never rethrown.
      (s) => {
        throw new Error(`bad ${s.serpapi}`);
      },
    ];
    for (const [index, build] of bad.entries()) {
      const provider = index >= 7 && index < 9 ? 'serper' : 'serpapi';
      const outcome = await api.dataApiRequest(provider, 'serp', build);
      expect(outcome, String(index)).toEqual({ ok: false, refusal: 'not-allowed', message: DATA_API_REFUSAL_MESSAGES['not-allowed'] });
    }
    // A purpose the provider doesn't serve.
    expect(await api.dataApiRequest('serpapi', 'ai-search', serpapiBuild)).toMatchObject({ ok: false, refusal: 'not-allowed' });
    expect(calls).toEqual([]);
  });

  test('data-api-sends-exactly-what-was-allowed', async () => {
    const { store } = await keyedStore();
    const { fetch, calls } = recordingFetch();
    const { api } = client(store, fetch);
    const outcome = await api.dataApiRequest('perplexity', 'ai-search', (s) => ({
      method: 'POST',
      url: 'https://api.perplexity.ai/v1/sonar',
      headers: { authorization: `Bearer ${s.perplexity}`, 'content-type': 'application/json' },
      body: '{"model":"sonar","messages":[]}',
    }));
    expect(outcome).toEqual({ ok: true, status: 200, body: '{"ok":true}', url: 'https://api.perplexity.ai/v1/sonar' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.perplexity.ai/v1/sonar');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', body: '{"model":"sonar","messages":[]}' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${PERPLEXITY_KEY}`);
  });

  test('data-api-refuses-redirects', async () => {
    const { store } = await keyedStore();
    // Electron 45's `redirect: 'error'` rejection.
    const electron = recordingFetch(() => Promise.reject(new Error("Attempted to redirect, but redirect policy was 'error'")));
    expect(await client(store, electron.fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toEqual({ ok: false, refusal: 'redirect', message: DATA_API_REFUSAL_MESSAGES.redirect, url: `${SERPAPI_URL}?engine=google&q=frost+browser&hl=en` });
    // A 3xx that reached the client anyway is a redirect too (never followed).
    const status = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect(await client(store, status.fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toMatchObject({ ok: false, refusal: 'redirect' });
    expect(status.calls).toHaveLength(1);

    // A real redirect over loopback (Node's fetch through the e2e seam): refused, the target never hit.
    let targetHits = 0;
    const target = await serve((_request, response) => {
      targetHits += 1;
      response.end('{}');
    });
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: `${target}/search.json` });
      response.end();
    });
    const real = createDataApiClient({ store, isOpen: allOpen, fetch: (url, init) => globalThis.fetch(url, init), seam: { serpapi: origin }, sleep: async () => undefined });
    expect(await real.dataApiRequest('serpapi', 'serp', serpapiBuild)).toMatchObject({ ok: false, refusal: 'redirect' });
    expect(targetHits).toBe(0);
  });

  test('data-api-response-capped', async () => {
    const { store } = await keyedStore();
    // Exactly the cap is read.
    const exact = countingBody(DATA_API_LIMITS.maxResponseBytes);
    const ok = await client(store, recordingFetch(() => new Response(exact.stream, { status: 200 })).fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(ok.ok && ok.body.length).toBe(DATA_API_LIMITS.maxResponseBytes);

    // One byte more is `too-large`, and the body is not read further.
    const over = countingBody(64 * 1024 * 1024);
    const outcome = await client(store, recordingFetch(() => new Response(over.stream, { status: 200 })).fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(outcome).toMatchObject({ ok: false, refusal: 'too-large', message: DATA_API_REFUSAL_MESSAGES['too-large'] });
    expect(over.state.cancelled).toBe(true);
    expect(over.state.sent).toBeLessThanOrEqual(DATA_API_LIMITS.maxResponseBytes + 2 * 256 * 1024);

    // A declared length over the cap: not read at all.
    const declared = countingBody(DATA_API_LIMITS.maxResponseBytes + 1);
    const refused = await client(store, recordingFetch(() => new Response(declared.stream, { status: 200, headers: { 'content-length': String(DATA_API_LIMITS.maxResponseBytes + 1) } })).fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(refused).toMatchObject({ ok: false, refusal: 'too-large' });
    expect(declared.state.sent).toBe(0);
  });

  test('data-api-error-body-withheld', async () => {
    const { store } = await keyedStore();
    const body = `{"error":"Invalid API key ${SERPAPI_KEY}","detail":"secret provider text"}`;
    const { fetch } = recordingFetch(() => new Response(body, { status: 401 }));
    const { api, log } = client(store, fetch);
    const outcome = await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(outcome).toEqual({ ok: false, refusal: 'http-error', message: DATA_API_REFUSAL_MESSAGES['http-error'], status: 401, url: `${SERPAPI_URL}?engine=google&q=frost+browser&hl=en` });
    expect(JSON.stringify(outcome)).not.toContain('provider text');
    expect(JSON.stringify(log.mock.calls)).not.toContain('provider text');
    expect(JSON.stringify(log.mock.calls)).not.toContain(SERPAPI_KEY);
  });

  test('data-api-timeout-and-network', async () => {
    const { store } = await keyedStore();
    // No answer within the time cap: aborted, `timeout`.
    const hang = recordingFetch((_url, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    expect(await client(store, hang.fetch, { timeoutMs: 20 }).api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toMatchObject({ ok: false, refusal: 'timeout' });
    // A body that stalls is bounded by the same cap.
    const stall = recordingFetch((_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x7b]));
          init.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    });
    expect(await client(store, stall.fetch, { timeoutMs: 20 }).api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toMatchObject({ ok: false, refusal: 'timeout' });
    const down = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await client(store, down.fetch).api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toMatchObject({ ok: false, refusal: 'network', message: DATA_API_REFUSAL_MESSAGES.network });
  });

  test('serpapi-key-never-in-a-logged-url', async () => {
    const { store } = await keyedStore();
    const order: string[] = [];
    const withKey = store.withKey.bind(store);
    const watched = {
      ...store,
      withKey: (async (slot, fn) => {
        order.push(`open ${slot}`);
        const result = await withKey(slot, fn);
        order.push(`close ${slot}`);
        return result;
      }) as typeof store.withKey,
    };
    const { fetch, calls } = recordingFetch((url) => {
      order.push('fetch');
      return new Response(`{"search_metadata":{"status":"Success"},"echo":"${new URL(url).searchParams.get('q')}"}`, { status: 200 });
    });
    const { api, log } = client(watched, fetch);
    const outcome = await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    // The request went out with the key, from inside the `withKey` closure.
    expect(calls[0]!.url).toBe(`${SERPAPI_URL}?engine=google&q=frost+browser&hl=en&api_key=${SERPAPI_KEY}`);
    expect(order).toEqual(['open serpapi', 'fetch', 'close serpapi']);
    // What comes back, and every log line, carries the key-less URL only.
    expect(outcome).toMatchObject({ ok: true, status: 200, url: `${SERPAPI_URL}?engine=google&q=frost+browser&hl=en` });
    expect(JSON.stringify(outcome)).not.toContain(SERPAPI_KEY);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(SERPAPI_KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain('api_key');
    // A key placed in another parameter is never returned either: the URL falls back to origin and path.
    // The key anywhere but `api_key` (once, exactly), or missing there: refused before any request.
    const sent = calls.length;
    for (const build of [
      (s: { serpapi?: string }) => serpapiUrl({ q: s.serpapi!, api_key: s.serpapi! }),
      (s: { serpapi?: string }) => serpapiUrl({ q: `x ${s.serpapi!} y`, api_key: s.serpapi! }),
      (s: { serpapi?: string }) => serpapiUrl({ api_key: `${s.serpapi!}x` }),
      () => serpapiUrl({ q: 'frost' }),
      () => serpapiUrl({ q: 'frost', api_key: 'someone-elses-key-123' }),
    ] satisfies ((s: { serpapi?: string }) => string)[]) {
      const sneaky = await api.dataApiRequest('serpapi', 'serp', (s) => ({ method: 'GET', url: build(s) }));
      expect(sneaky).toEqual({ ok: false, refusal: 'not-allowed', message: DATA_API_REFUSAL_MESSAGES['not-allowed'] });
    }
    expect(calls).toHaveLength(sent);
    // Every refusal after the key was read keeps the key-less URL too.
    for (const answer of [() => Promise.reject(new TypeError('fetch failed')), () => new Response('nope', { status: 500 })]) {
      const failing = client(store, recordingFetch(answer).fetch);
      const refused = await failing.api.dataApiRequest('serpapi', 'serp', serpapiBuild);
      expect(JSON.stringify(refused)).not.toContain(SERPAPI_KEY);
      expect(JSON.stringify(failing.log.mock.calls)).not.toContain(SERPAPI_KEY);
    }
  });

  test('serpapi-key-with-query-characters', async () => {
    // A key holding `&start=1` is one `api_key` value when encoded, and refused when pasted raw.
    const KEY = 'serpapi-0123456789&start=1';
    const { store } = dataStore();
    expect(await store.setKey('serpapi', KEY)).toBe('stored');
    const { fetch, calls } = recordingFetch();
    const { api, log } = client(store, fetch);
    const outcome = await api.dataApiRequest('serpapi', 'serp', (s) => ({ method: 'GET', url: serpapiUrl({ q: 'frost', api_key: s.serpapi! }) }));
    expect(outcome).toMatchObject({ ok: true, url: `${SERPAPI_URL}?q=frost` });
    const sentUrl = new URL(calls[0]!.url);
    expect(sentUrl.searchParams.getAll('api_key')).toEqual([KEY]);
    expect(sentUrl.searchParams.has('start')).toBe(false);
    // Concatenated, the key splits into `api_key` and `start`: refused, nothing sent.
    const raw = await api.dataApiRequest('serpapi', 'serp', (s) => ({ method: 'GET', url: `${SERPAPI_URL}?q=frost&api_key=${s.serpapi}` }));
    expect(raw).toEqual({ ok: false, refusal: 'not-allowed', message: DATA_API_REFUSAL_MESSAGES['not-allowed'] });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify([outcome, raw, log.mock.calls])).not.toContain('0123456789&start');
  });

  test('data-api-header-not-a-bytestring', async () => {
    const { store } = await keyedStore();
    const { fetch, calls } = recordingFetch();
    const { api } = client(store, fetch);
    const outcome = await api.dataApiRequest('serper', 'serp', (s) => ({ method: 'POST', url: 'https://google.serper.dev/search', headers: { 'x-api-key': `${s.serper}\u0100` }, body: '{}' }));
    expect(outcome).toEqual({ ok: false, refusal: 'not-allowed', message: DATA_API_REFUSAL_MESSAGES['not-allowed'] });
    expect(calls).toEqual([]);
  });

  test('data-api-busy-when-too-many-wait', async () => {
    const { store } = await keyedStore();
    const clock = 50_000;
    const pending: (() => void)[] = [];
    const { fetch, calls } = recordingFetch();
    const withKey = vi.spyOn(store, 'withKey');
    const api = createDataApiClient({ store, isOpen: allOpen, fetch, now: () => clock, sleep: () => new Promise<void>((resolve) => pending.push(resolve)) });
    const first = await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(first.ok).toBe(true);
    // The next `maxWaitingPerProvider` wait without holding a key; one more is `busy`.
    const waiting = Array.from({ length: DATA_API_LIMITS.maxWaitingPerProvider }, () => api.dataApiRequest('serpapi', 'serp', serpapiBuild));
    await vi.waitFor(() => expect(pending).toHaveLength(DATA_API_LIMITS.maxWaitingPerProvider));
    expect(withKey).toHaveBeenCalledTimes(1);
    expect(await api.dataApiRequest('serpapi', 'serp', serpapiBuild)).toEqual({ ok: false, refusal: 'busy', message: DATA_API_REFUSAL_MESSAGES.busy });
    // Another provider is not held up.
    expect((await api.dataApiRequest('perplexity', 'ai-search', (s) => ({ method: 'POST', url: 'https://api.perplexity.ai/v1/sonar', headers: { authorization: `Bearer ${s.perplexity}` }, body: '{}' }))).ok).toBe(true);
    for (const resolve of pending.splice(0)) resolve();
    expect((await Promise.all(waiting)).every((outcome) => outcome.ok)).toBe(true);
    expect(calls).toHaveLength(2 + DATA_API_LIMITS.maxWaitingPerProvider);
  });

  test('data-api-spaced-per-provider', async () => {
    const { store } = await keyedStore();
    let clock = 10_000;
    const sleeps: number[] = [];
    const { fetch, calls } = recordingFetch();
    const api = createDataApiClient({
      store,
      isOpen: allOpen,
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const serper: DataApiBuild = (s) => ({ method: 'POST', url: 'https://google.serper.dev/search', headers: { 'x-api-key': s.serper!, 'content-type': 'application/json' }, body: '{"q":"x"}' });
    await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    clock += 200;
    await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    // Another provider has its own spacing.
    await api.dataApiRequest('serper', 'serp', serper);
    clock += DATA_API_LIMITS.minIntervalMs.serpapi * 5;
    await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
    expect(sleeps).toEqual([DATA_API_LIMITS.minIntervalMs.serpapi - 200]);
    expect(calls).toHaveLength(4);
    // Two at once: the second waits a full interval.
    sleeps.length = 0;
    await Promise.all([api.dataApiRequest('serper', 'serp', serper), api.dataApiRequest('serper', 'serp', serper)]);
    expect(sleeps).toEqual([DATA_API_LIMITS.minIntervalMs.serper]);
  });

  test('data-api-e2e-seam-only-unpackaged', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-data-seam-'));
    try {
      const requests: string[] = [];
      const fake = await serve((request, response) => {
        requests.push(`${request.method} ${request.url} ${request.headers['x-api-key'] ?? ''}`);
        response.setHeader('content-type', 'application/json');
        response.end('{"organic":[]}');
      });
      const file = path.join(dir, 'seam.json');
      writeFileSync(file, JSON.stringify({ serper: fake, serpapi: fake }));
      const log = vi.fn();
      const seam = dataApiE2eSeamFrom({ packaged: false, switchValue: file, log });
      expect(seam).toEqual({ serper: fake, serpapi: fake });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('unpackaged'));

      // The allowed request goes to the loopback base, same method, path and query.
      const { store } = await keyedStore();
      const api = createDataApiClient({ store, isOpen: allOpen, fetch: (url, init) => globalThis.fetch(url, init), seam, sleep: async () => undefined });
      const outcome = await api.dataApiRequest('serper', 'serp', (s) => ({ method: 'POST', url: 'https://google.serper.dev/search', headers: { 'x-api-key': s.serper!, 'content-type': 'application/json' }, body: '{"q":"x"}' }));
      expect(outcome).toEqual({ ok: true, status: 200, body: '{"organic":[]}', url: 'https://google.serper.dev/search' });
      await api.dataApiRequest('serpapi', 'serp', serpapiBuild);
      expect(requests).toEqual([`POST /search ${SERPER_KEY}`, `GET /search.json?engine=google&q=frost+browser&hl=en&api_key=${SERPAPI_KEY} `]);
      // The allowlist is still checked against the canonical URL: the loopback URL itself is refused.
      expect(await api.dataApiRequest('serper', 'serp', () => ({ method: 'POST', url: `${fake}/search`, body: '{}' }))).toMatchObject({ ok: false, refusal: 'not-allowed' });

      // Not JSON, an unknown provider, a non-loopback base, too long, missing: the seam stays off.
      for (const content of ['nope', JSON.stringify({ bing: fake }), JSON.stringify({ serper: 'https://google.serper.dev' }), JSON.stringify({ serper: fake, pad: 'x'.repeat(DATA_API_E2E_SEAM_MAX_CHARS) })]) {
        writeFileSync(file, content);
        expect(dataApiE2eSeamFrom({ packaged: false, switchValue: file }), content.slice(0, 40)).toBeNull();
      }
      expect(dataApiE2eSeamFrom({ packaged: false, switchValue: path.join(dir, 'missing.json') })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }

    // Only bare loopback http origins with a port.
    expect(isDataApiE2eBase('http://127.0.0.1:41234')).toBe(true);
    for (const base of ['http://127.0.0.1:41234/', 'http://127.0.0.1:41234/v1', 'https://127.0.0.1:41234', 'http://localhost:41234', 'http://127.0.0.2:41234', 'http://127.0.0.1', 'http://u:p@127.0.0.1:41234', 'http://127.0.0.1:41234?x', 42]) {
      expect(isDataApiE2eBase(base), String(base)).toBe(false);
      expect(parseDataApiE2eSeam(JSON.stringify({ serpapi: base }))).toBeNull();
    }

    // Packaged: the file is never read, and the app refuses to start with the switch.
    const readFile = vi.fn(() => JSON.stringify({ serpapi: 'http://127.0.0.1:41234' }));
    expect(dataApiE2eSeamFrom({ packaged: true, switchValue: '/tmp/seam.json', readFile })).toBeNull();
    expect(dataApiE2eSeamFrom({ packaged: false, switchValue: '', readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(DATA_API_E2E_SWITCH);
    expect(remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (name) => name === DATA_API_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBe(`${PACKAGED_DEBUG_REFUSAL} (${DATA_API_E2E_SWITCH})`);
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: (name) => name === DATA_API_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBeNull();
  });
});
