// Spec: specs/update-client.spec.ts (Consent and privacy, UPDATE_FETCH_LIMITS) · Acceptance: specs/update-client.feature.md (Requests)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { UPDATE_ALLOWED_REQUEST_HEADERS, UPDATE_FETCH_LIMITS, updateUserAgent } from '@app/specs/update-client.spec';
import { MAX_ENVELOPE_BYTES } from '@app/specs/update-manifest.spec';
import { getBytes, hardenUpdateSession, netTransport, updateRequestHeaders, type UpdateGetDeps, type UpdateNet } from '../fetch';
import { nodeTransport, startFakeFeed, tableResolver, type FakeFeed } from './fake-feed';

const UA = updateUserAgent('1.2.0');
const ENVELOPE = { ...UPDATE_FETCH_LIMITS.envelope, maxBytes: MAX_ENVELOPE_BYTES, maxRedirects: UPDATE_FETCH_LIMITS.maxRedirects };

let feed: FakeFeed;
beforeEach(async () => {
  feed = await startFakeFeed();
});
afterEach(async () => {
  await feed.close();
});

const deps = (overrides: Partial<UpdateGetDeps> = {}): UpdateGetDeps => ({
  hop: nodeTransport({ https: { 'updates.frost-feed.com': feed.port } }),
  resolve: tableResolver({ 'updates.frost-feed.com': ['93.184.215.14'] }),
  isPackaged: false,
  userAgent: UA,
  ...overrides,
});

describe('update requests', () => {
  test('feed-request-carries-nothing', async () => {
    feed.route('/feed.json', { body: '{}' });
    // Over http: to loopback and over (mapped) https:, the server sees the same three headers.
    for (const url of [`${feed.origin}/feed.json`, 'https://updates.frost-feed.com/feed.json']) {
      const got = await getBytes(url, deps(), ENVELOPE);
      expect(got).toEqual({ ok: true, bytes: new Uint8Array(Buffer.from('{}')) });
    }
    expect(feed.requests).toHaveLength(2);
    for (const request of feed.requests) {
      expect(request.method).toBe('GET');
      expect(request.path).toBe('/feed.json');
      expect(Object.keys(request.headers).sort()).toEqual(['connection', 'host', 'user-agent']);
      expect(request.headers['user-agent']).toBe('frost/1.2.0 (update check)');
      expect(request.headers.connection).toBe('close');
    }
    expect(feed.requests[1]!.headers.host).toBe('updates.frost-feed.com');

    // The Electron transport: what it asks of `net.request`, and the only header it sets.
    const calls: { options: Record<string, unknown>; headers: [string, string][] }[] = [];
    const net: UpdateNet = {
      request(options) {
        const request = new EventEmitter() as EventEmitter & { setHeader(n: string, v: string): void; abort(): void; end(): void };
        const call = { options: options as unknown as Record<string, unknown>, headers: [] as [string, string][] };
        calls.push(call);
        request.setHeader = (name, value) => void call.headers.push([name, value]);
        request.abort = () => undefined;
        request.end = () => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-length': '2' }, [Symbol.asyncIterator]: async function* () {
            yield new Uint8Array([123, 125]);
          } });
          queueMicrotask(() => request.emit('response', response));
        };
        return request as unknown as Electron.ClientRequest;
      },
    };
    const session = { marker: 'update-session' } as unknown as Electron.Session;
    const hop = netTransport(net, session);
    const result = await hop('https://updates.frost-feed.com/feed.json', new AbortController().signal, UA);
    expect(result.kind).toBe('response');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({
      url: 'https://updates.frost-feed.com/feed.json',
      method: 'GET',
      session,
      credentials: 'omit',
      useSessionCookies: false,
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(calls[0]!.headers).toEqual([['User-Agent', UA]]);

    // The update session's header filter: only User-Agent, forced to the update agent.
    expect(UPDATE_ALLOWED_REQUEST_HEADERS).toEqual(['user-agent']);
    expect(updateRequestHeaders({ 'User-Agent': 'Mozilla/5.0 something', Cookie: 'a=b', 'Accept-Language': 'de-DE', Referer: 'https://x.example.com/', Authorization: 'Basic x', 'X-Install-Id': 'abc' }, UA)).toEqual({ 'User-Agent': UA });
    expect(updateRequestHeaders({}, UA)).toEqual({ 'User-Agent': UA });
    const listeners: { headers?: (details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void; request?: (details: { url: string; method: string }, callback: (response: { cancel: boolean }) => void) => void } = {};
    const agents: string[] = [];
    hardenUpdateSession(
      {
        setUserAgent: (agent: string) => void agents.push(agent),
        webRequest: {
          onBeforeSendHeaders: (listener: NonNullable<typeof listeners.headers>) => void (listeners.headers = listener),
          onBeforeRequest: (listener: NonNullable<typeof listeners.request>) => void (listeners.request = listener),
        },
      },
      UA,
      { isPackaged: false },
    );
    expect(agents).toEqual([UA]);
    let sent: Record<string, string> | undefined;
    listeners.headers!({ requestHeaders: { 'User-Agent': 'x', Cookie: 'a=b', 'Accept-Language': 'en' } }, (response) => (sent = response.requestHeaders));
    expect(sent).toEqual({ 'User-Agent': UA });
    // Only GETs to https: (or http: loopback) leave the update session.
    const cancelled = (url: string, method = 'GET') => {
      let cancel: boolean | undefined;
      listeners.request!({ url, method }, (response) => (cancel = response.cancel));
      return cancel;
    };
    expect(cancelled('https://updates.frost-feed.com/feed.json')).toBe(false);
    expect(cancelled('http://127.0.0.1:1234/feed.json')).toBe(false);
    expect(cancelled('https://updates.frost-feed.com/feed.json', 'POST')).toBe(true);
    expect(cancelled('http://updates.frost-feed.com/feed.json')).toBe(true);
    expect(cancelled('file:///etc/passwd')).toBe(true);
    // A packaged build's update session lets no http: out at all.
    hardenUpdateSession({ setUserAgent: () => undefined, webRequest: { onBeforeSendHeaders: () => undefined, onBeforeRequest: (listener: NonNullable<typeof listeners.request>) => void (listeners.request = listener) } }, UA, { isPackaged: true });
    expect(cancelled('http://127.0.0.1:1234/feed.json')).toBe(true);
    expect(cancelled('https://updates.frost-feed.com/feed.json')).toBe(false);
  });

  test('hop-rules', async () => {
    feed.route('/ok', { body: 'ok' });
    const reason = async (url: string, overrides: Partial<UpdateGetDeps> = {}) => {
      const got = await getBytes(url, deps(overrides), ENVELOPE);
      return got.ok ? 'ok' : got.reason;
    };
    expect(await reason(`${feed.origin}/ok`)).toBe('ok');
    expect(await reason('https://updates.frost-feed.com/ok')).toBe('ok');
    // http: only to a loopback literal, and only unpackaged.
    expect(await reason(`${feed.origin}/ok`, { isPackaged: true })).toBe('insecure-url');
    expect(await reason(`http://localhost:${feed.port}/ok`)).toBe('insecure-url');
    expect(await reason('http://updates.frost-feed.com/ok')).toBe('insecure-url');
    expect(await reason('ftp://updates.frost-feed.com/ok')).toBe('insecure-url');
    expect(await reason('https://user:pw@updates.frost-feed.com/ok')).toBe('insecure-url');
    // A private literal, a local-only name, a name resolving to a private address: never requested.
    const before = feed.requests.length;
    for (const url of ['https://10.0.0.1/ok', 'https://127.0.0.1/ok', 'https://[::1]/ok', 'https://[::ffff:192.168.0.1]/ok', 'https://169.254.169.254/ok', 'https://localhost/ok', 'https://updates.local/ok', 'https://updates/ok', 'https://intranet.frost-feed.com/ok']) {
      const resolve = tableResolver({ 'intranet.frost-feed.com': ['93.184.215.14', '192.168.1.10'] });
      expect([url, await reason(url, { resolve })]).toEqual([url, 'private-address']);
    }
    expect(feed.requests.length).toBe(before);
    // A name that does not resolve is unreachable; a resolver answering null (the e2e seam) is not checked.
    expect(await reason('https://nowhere.frost-feed.com/ok')).toBe('unreachable');
    expect(await reason('https://updates.frost-feed.com/ok', { resolve: async () => null })).toBe('ok');
    // A public literal is not resolved.
    const resolve = tableResolver({});
    expect(await reason('https://93.184.215.14/ok', { resolve })).toBe('unreachable');
    expect(resolve.asked).toEqual([]);
    // Statuses other than 200.
    feed.route('/gone', { status: 404 });
    feed.route('/partial', { status: 206, body: 'x' });
    expect(await reason(`${feed.origin}/gone`)).toBe('http-status');
    expect(await reason(`${feed.origin}/partial`)).toBe('http-status');
    // A redirect without a Location, or to garbage.
    feed.route('/no-location', (_request, response) => response.writeHead(302).end());
    feed.route('/bad-location', { redirect: 'https://[bad' });
    expect(await reason(`${feed.origin}/no-location`)).toBe('bad-redirect');
    expect(await reason(`${feed.origin}/bad-location`)).toBe('bad-redirect');
    // The caller's abort.
    const controller = new AbortController();
    controller.abort();
    const aborted = await getBytes(`${feed.origin}/ok`, deps(), ENVELOPE, controller.signal);
    expect(aborted).toEqual({ ok: false, reason: 'aborted' });
  });
});
