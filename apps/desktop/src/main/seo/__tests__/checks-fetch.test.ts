// Spec: specs/seo-checks.spec.ts (CHECK_FETCH_OUTCOMES, LINK_CHECK_LIMITS)
// Acceptance: specs/seo-checks.feature.md (Fetcher); review focus link-checks-are-bounded
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCheckFetch, netCheckHop, type CheckFetchOptions, type CheckHop } from '../checks-fetch';
import type { NetRequester } from '../robots-fetch';

afterEach(() => vi.useRealTimers());

const OPTIONS: CheckFetchOptions = { method: 'GET', maxBytes: 8, timeoutMs: 1_000, maxRedirects: 2, allowPrivate: false, userAgent: null, signal: new AbortController().signal };

async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

/** A hop answering from `routes` (URL → answer), recording every URL and method it was asked for. */
function routedHop(routes: Record<string, { redirect?: string | null; status?: number; body?: string[] }>) {
  const asked: { url: string; method: string }[] = [];
  const cancels: string[] = [];
  const hop: CheckHop = async (url, request) => {
    asked.push({ url, method: request.method });
    const route = routes[url];
    if (!route) throw new Error('refused');
    if (route.redirect !== undefined) return { kind: 'redirect', status: route.status ?? 301, location: route.redirect };
    return { kind: 'response', status: route.status ?? 200, body: chunks(...(route.body ?? [])), cancel: () => void cancels.push(url), headers: { contentType: 'text/html', contentEncoding: null, link: null } };
  };
  return { hop, asked, cancels };
}

describe('check fetch', () => {
  test('check-fetch-follows-checked-redirects', async () => {
    const { hop, asked } = routedHop({
      'https://a.test/1': { redirect: '/2' },
      'https://a.test/2': { redirect: 'https://b.test/3' },
      'https://b.test/3': { status: 200, body: ['ok'] },
      'https://a.test/loop': { redirect: '/loop' },
      'https://a.test/none': { redirect: null, status: 302 },
      'https://a.test/file': { redirect: 'file:///etc/passwd' },
    });
    const fetch = createCheckFetch(hop);
    await expect(fetch('https://a.test/1', OPTIONS)).resolves.toMatchObject({ outcome: 'response', status: 200, finalUrl: 'https://b.test/3', redirects: 2, truncated: false, headers: { contentType: 'text/html' } });
    expect(asked.map((a) => a.url)).toEqual(['https://a.test/1', 'https://a.test/2', 'https://b.test/3']);
    await expect(fetch('https://a.test/loop', OPTIONS)).resolves.toMatchObject({ outcome: 'too-many-redirects', redirects: 2 });
    await expect(fetch('https://a.test/none', OPTIONS)).resolves.toMatchObject({ outcome: 'no-location', status: 302 });
    await expect(fetch('https://a.test/file', OPTIONS)).resolves.toMatchObject({ outcome: 'bad-redirect' });
    await expect(fetch('ftp://a.test/x', OPTIONS)).resolves.toMatchObject({ outcome: 'bad-redirect' });
    await expect(fetch('https://nowhere.test/', OPTIONS)).resolves.toMatchObject({ outcome: 'unreachable', status: null });
  });

  test('check-fetch-refuses-private-redirects', async () => {
    const { hop, asked } = routedHop({ 'https://a.test/x': { redirect: 'http://192.168.1.1/admin' }, 'http://192.168.1.1/admin': { status: 200 } });
    const fetch = createCheckFetch(hop);
    await expect(fetch('https://a.test/x', OPTIONS)).resolves.toMatchObject({ outcome: 'private-redirect', finalUrl: 'http://192.168.1.1/admin' });
    expect(asked.map((a) => a.url)).toEqual(['https://a.test/x']);
    // The page itself is private: followed.
    await expect(fetch('https://a.test/x', { ...OPTIONS, allowPrivate: true })).resolves.toMatchObject({ outcome: 'response', status: 200 });
  });

  test('check-fetch-caps-body', async () => {
    const { hop, cancels } = routedHop({ 'https://a.test/big': { body: ['12345', '67890', 'abc'] }, 'https://a.test/small': { body: ['123'] } });
    const fetch = createCheckFetch(hop);
    const big = await fetch('https://a.test/big', OPTIONS);
    expect(new TextDecoder().decode(big.body)).toBe('12345678');
    expect(big.truncated).toBe(true);
    const small = await fetch('https://a.test/small', OPTIONS);
    expect(new TextDecoder().decode(small.body)).toBe('123');
    expect(small.truncated).toBe(false);
    // HEAD reads nothing; every answer's connection is closed.
    const head = await fetch('https://a.test/big', { ...OPTIONS, method: 'HEAD' });
    expect(head.body.byteLength).toBe(0);
    expect(cancels).toEqual(['https://a.test/big', 'https://a.test/small', 'https://a.test/big']);
  });

  test('check-fetch-deadline-and-abort', async () => {
    vi.useFakeTimers();
    const never: CheckHop = () => new Promise(() => undefined);
    const fetch = createCheckFetch(never);
    const timing = fetch('https://a.test/', { ...OPTIONS, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(timing).resolves.toMatchObject({ outcome: 'timeout' });
    const controller = new AbortController();
    const stopping = fetch('https://a.test/', { ...OPTIONS, signal: controller.signal });
    controller.abort();
    await expect(stopping).resolves.toMatchObject({ outcome: 'aborted' });
    await expect(fetch('https://a.test/', { ...OPTIONS, signal: controller.signal })).resolves.toMatchObject({ outcome: 'aborted' });
    // A body that never ends is cut by the deadline too.
    const hanging: CheckHop = async () => ({
      kind: 'response',
      status: 200,
      body: (async function* () {
        yield new Uint8Array(1);
        await new Promise(() => undefined);
      })(),
      cancel: () => undefined,
    });
    const slow = createCheckFetch(hanging)('https://a.test/', { ...OPTIONS, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(slow).resolves.toMatchObject({ outcome: 'timeout' });
  });

  test('check-hop-sends-method-and-agent', async () => {
    class FakeRequest extends EventEmitter {
      abort = vi.fn();
      end = vi.fn();
      setHeader = vi.fn();
    }
    const requests: { options: Electron.ClientRequestConstructorOptions; request: FakeRequest }[] = [];
    const net: NetRequester = {
      request: (options) => {
        const request = new FakeRequest();
        requests.push({ options, request });
        return request as unknown as Electron.ClientRequest;
      },
    };
    const session = {} as Electron.Session;
    const hop = netCheckHop(net, session);
    const signal = new AbortController().signal;
    const answering = hop('https://a.test/', { method: 'HEAD', userAgent: 'Mozilla/5.0 (compatible; Test)' }, signal);
    expect(requests[0]!.options).toMatchObject({ url: 'https://a.test/', session, method: 'HEAD', credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(requests[0]!.request.setHeader).toHaveBeenCalledWith('User-Agent', 'Mozilla/5.0 (compatible; Test)');
    const message = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html', link: ['<https://a.test/de>; rel="alternate"; hreflang="de"', 'x'] } });
    requests[0]!.request.emit('response', message);
    await expect(answering).resolves.toMatchObject({ kind: 'response', status: 200, headers: { contentType: 'text/html', contentEncoding: null, link: '<https://a.test/de>; rel="alternate"; hreflang="de"' } });
    // A user agent with a line break (or none) is never sent: frost's own instead.
    void hop('https://a.test/', { method: 'GET', userAgent: 'evil\r\nCookie: x' }, signal);
    void hop('https://a.test/', { method: 'GET', userAgent: null }, signal);
    expect(requests[1]!.request.setHeader).not.toHaveBeenCalled();
    expect(requests[2]!.request.setHeader).not.toHaveBeenCalled();
    expect(requests[1]!.options.method).toBe('GET');
  });
});
