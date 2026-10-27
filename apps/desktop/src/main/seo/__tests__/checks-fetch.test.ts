// Spec: specs/seo-checks.spec.ts (CHECK_FETCH_OUTCOMES, LINK_CHECK_LIMITS); specs/fetcher.spec.ts (Lanes)
// Acceptance: specs/seo-checks.feature.md (Fetcher); review focus link-checks-are-bounded
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FETCH_OUTCOMES, type BoundedFetcher, type BoundedFetchRequest } from '@app/specs/fetcher.spec';
import { CHECK_FETCH_OUTCOMES } from '@app/specs/seo-checks.spec';
import { createCheckFetch, type CheckFetchOptions } from '../checks-fetch';
import { createBoundedFetcher, type Hop, type HopResult } from '../fetcher';

afterEach(() => vi.useRealTimers());

const PAGE = 'https://a.test/page';
const OPTIONS: CheckFetchOptions = { method: 'GET', maxBytes: 8, timeoutMs: 1_000, maxRedirects: 2, page: PAGE, userAgent: null, signal: new AbortController().signal };

async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

/** A hop answering from `routes` (URL → answer), recording every URL, method and user agent it was asked for. */
function routedHop(routes: Record<string, { redirect?: string | null; status?: number; body?: string[]; headers?: Record<string, string | string[]> }>) {
  const asked: { url: string; method: string | undefined; userAgent: string | null | undefined }[] = [];
  const cancels: string[] = [];
  const hop: Hop = async (url, _signal, options) => {
    asked.push({ url, method: options?.method, userAgent: options?.userAgent });
    const route = routes[url];
    if (!route) throw new Error('refused');
    if (route.redirect !== undefined) return { kind: 'redirect', status: route.status ?? 301, location: route.redirect };
    return { kind: 'response', status: route.status ?? 200, body: chunks(...(route.body ?? [])), cancel: () => void cancels.push(url), headers: route.headers ?? { 'content-type': 'text/html' } };
  };
  return { hop, asked, cancels };
}

/** The checks' fetch over a bounded fetcher (no rate-limit wait, so tests need no clock). */
const checkFetch = (hop: Hop) => createCheckFetch(createBoundedFetcher({ hop, limits: { perOriginIntervalMs: 0 } }));

describe('check fetch', () => {
  test('check-fetch-outcomes-map', () => {
    // Every outcome the shared fetcher can give is one the checks know.
    expect(CHECK_FETCH_OUTCOMES.every((outcome) => (FETCH_OUTCOMES as readonly string[]).includes(outcome))).toBe(true);
  });

  test('check-fetch-follows-checked-redirects', async () => {
    const { hop, asked } = routedHop({
      'https://a.test/1': { redirect: '/2' },
      'https://a.test/2': { redirect: 'https://b.test/3' },
      'https://b.test/3': { status: 200, body: ['ok'] },
      'https://a.test/loop': { redirect: '/loop' },
      'https://a.test/none': { redirect: null, status: 302 },
      'https://a.test/file': { redirect: 'file:///etc/passwd' },
    });
    const fetch = checkFetch(hop);
    await expect(fetch('https://a.test/1', OPTIONS)).resolves.toMatchObject({ outcome: 'response', status: 200, finalUrl: 'https://b.test/3', redirects: 2, truncated: false, headers: { contentType: 'text/html' } });
    expect(asked.map((a) => a.url)).toEqual(['https://a.test/1', 'https://a.test/2', 'https://b.test/3']);
    await expect(fetch('https://a.test/loop', OPTIONS)).resolves.toMatchObject({ outcome: 'too-many-redirects', redirects: 2 });
    await expect(fetch('https://a.test/none', OPTIONS)).resolves.toMatchObject({ outcome: 'no-location', status: 302 });
    await expect(fetch('https://a.test/file', OPTIONS)).resolves.toMatchObject({ outcome: 'bad-redirect' });
    await expect(fetch('ftp://a.test/x', OPTIONS)).resolves.toMatchObject({ outcome: 'bad-redirect' });
    await expect(fetch('https://nowhere.test/', OPTIONS)).resolves.toMatchObject({ outcome: 'unreachable', status: null, finalUrl: 'https://nowhere.test/' });
  });

  test('check-fetch-refuses-private-redirects', async () => {
    const { hop, asked } = routedHop({ 'https://a.test/x': { redirect: 'http://192.168.1.1/admin' }, 'http://192.168.1.1/admin': { status: 200 } });
    const fetch = checkFetch(hop);
    await expect(fetch('https://a.test/x', OPTIONS)).resolves.toMatchObject({ outcome: 'private-redirect', status: 301, redirects: 0 });
    // A private target asked for directly is refused the same way, before any request.
    await expect(fetch('http://192.168.1.1/admin', OPTIONS)).resolves.toMatchObject({ outcome: 'private-redirect', status: null });
    expect(asked.map((a) => a.url)).toEqual(['https://a.test/x']);
    // The page itself is private: followed.
    await expect(fetch('https://a.test/x', { ...OPTIONS, page: 'http://localhost:3000/' })).resolves.toMatchObject({ outcome: 'response', status: 200 });
  });

  test('check-fetch-caps-body', async () => {
    const { hop, cancels } = routedHop({ 'https://a.test/big': { body: ['12345', '67890', 'abc'] }, 'https://a.test/small': { body: ['123'] } });
    const fetch = checkFetch(hop);
    const big = await fetch('https://a.test/big', OPTIONS);
    expect(new TextDecoder().decode(big.body)).toBe('12345678');
    expect(big.truncated).toBe(true);
    const small = await fetch('https://a.test/small', OPTIONS);
    expect(new TextDecoder().decode(small.body)).toBe('123');
    expect(small.truncated).toBe(false);
    // HEAD (and a GET with no byte budget) reads nothing; every answer's connection is closed.
    const head = await fetch('https://a.test/big', { ...OPTIONS, method: 'HEAD' });
    expect(head.body.byteLength).toBe(0);
    const none = await fetch('https://a.test/big', { ...OPTIONS, maxBytes: 0 });
    expect(none.body.byteLength).toBe(0);
    expect(cancels).toEqual(['https://a.test/big', 'https://a.test/small', 'https://a.test/big', 'https://a.test/big']);
  });

  test('check-fetch-deadline-and-abort', async () => {
    vi.useFakeTimers();
    const never: Hop = () => new Promise<HopResult>(() => undefined);
    const fetch = checkFetch(never);
    const timing = fetch('https://a.test/', { ...OPTIONS, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(timing).resolves.toMatchObject({ outcome: 'timeout' });
    const controller = new AbortController();
    const stopping = fetch('https://a.test/', { ...OPTIONS, signal: controller.signal });
    controller.abort();
    await expect(stopping).resolves.toMatchObject({ outcome: 'aborted' });
    await expect(fetch('https://a.test/', { ...OPTIONS, signal: controller.signal })).resolves.toMatchObject({ outcome: 'aborted' });
    // A body that never ends is cut by the deadline too.
    const hanging: Hop = async () => ({
      kind: 'response',
      status: 200,
      body: (async function* () {
        yield new Uint8Array(1);
        await new Promise(() => undefined);
      })(),
      cancel: () => undefined,
    });
    const slow = checkFetch(hanging)('https://a.test/', { ...OPTIONS, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(slow).resolves.toMatchObject({ outcome: 'timeout' });
  });

  test('check-fetch-sends-method-agent-and-reads-headers', async () => {
    const link = ['<https://a.test/de>; rel="alternate"; hreflang="de"', `<https://a.test/fr>; rel="alternate"; hreflang="fr"${' '.repeat(2_000)}`];
    const { hop, asked } = routedHop({ 'https://a.test/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', link, 'set-cookie': 'a=1' } } });
    const fetch = checkFetch(hop);
    const answer = await fetch('https://a.test/', { ...OPTIONS, method: 'HEAD', userAgent: 'Mozilla/5.0 (compatible; Test)' });
    expect(asked[0]).toEqual({ url: 'https://a.test/', method: 'HEAD', userAgent: 'Mozilla/5.0 (compatible; Test)' });
    // Every Link header is read (joined), past the fetcher's default header cap.
    expect(answer.headers).toEqual({ contentType: 'text/html', contentEncoding: 'gzip', link: link.join(', ') });
    // A user agent with a line break (or none) is never sent: frost's own instead.
    await fetch('https://a.test/', { ...OPTIONS, userAgent: 'evil\r\nCookie: x' });
    await fetch('https://a.test/', { ...OPTIONS, userAgent: null });
    expect(asked.slice(1).map((a) => [a.method, a.userAgent])).toEqual([
      ['GET', null],
      ['GET', null],
    ]);
  });

  test('check-fetch-uses-the-given-fetcher', async () => {
    // Everything goes through the fetcher it is given (main: the `checks` lane), with the page and caps.
    const requests: BoundedFetchRequest[] = [];
    const fetcher: BoundedFetcher = {
      fetch: async (request) => (requests.push(request), { url: request.url, outcome: 'busy', status: null, finalUrl: null, redirects: 0, chain: [], headers: {}, body: new Uint8Array(0), truncated: false, durationMs: 0 }),
      load: () => ({ running: 0, queued: 0 }),
    };
    const answer = await createCheckFetch(fetcher)('https://a.test/x', OPTIONS);
    expect(requests).toEqual([expect.objectContaining({ url: 'https://a.test/x', page: PAGE, method: 'GET', maxBytes: 8, timeoutMs: 1_000, maxRedirects: 2, signal: OPTIONS.signal })]);
    // A full queue asked nothing: no answer, never cached.
    expect(answer).toMatchObject({ outcome: 'unreachable', status: null, finalUrl: 'https://a.test/x' });
  });
});
