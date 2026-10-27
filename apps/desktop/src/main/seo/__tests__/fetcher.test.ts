// Spec: specs/fetcher.spec.ts (FETCHER_LIMITS, FETCH_OUTCOMES, BoundedFetchRequest / BoundedFetchResult, Lanes)
// Acceptance: specs/seo-javascript.feature.md (Bounded fetcher)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHECKS_FETCHER_LIMITS, FETCHER_LANES, FETCHER_LIMITS } from '@app/specs/fetcher.spec';
import { LINK_CHECK_LIMITS } from '@app/specs/seo-checks.spec';
import { createCheckFetch } from '../checks-fetch';
import { checkLink } from '../checks-links';
import { runBounded } from '../checks-scheduler';
import { createBoundedFetcher, createFetcherLanes, netHop, type Hop, type HopResult, type NetRequester } from '../fetcher';
import { createRobotsFetcher } from '../robots-fetch';
import { createServedHtml } from '../served';

const encoder = new TextEncoder();
function body(chunks: (string | number)[], read = { count: 0 }): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        read.count++;
        yield typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk).fill(0x78);
      }
    },
  };
}
const ok = (text: string, status = 200, headers?: Record<string, string | string[]>): HopResult => ({ kind: 'response', status, body: body([text]), ...(headers ? { headers } : {}), cancel: vi.fn() });
const redirect = (location: string | null, status = 301): HopResult => ({ kind: 'redirect', status, location });

/** A hop answering by URL; records every URL asked and its options. */
function fakeHop(routes: Record<string, HopResult | (() => Promise<HopResult>)>) {
  const asked: { url: string; options: Parameters<Hop>[2] }[] = [];
  const hop: Hop = async (url, _signal, options) => {
    asked.push({ url, options });
    const route = routes[url];
    if (!route) throw new Error(`net::ERR_CONNECTION_REFUSED ${url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { hop, asked, urls: () => asked.map((a) => a.url) };
}

const PAGE = 'https://example.com/page';

describe('bounded fetcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('fetcher-refuses-non-web', async () => {
    const { hop, asked } = fakeHop({});
    const fetcher = createBoundedFetcher({ hop });
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/', 'javascript:alert(1)', 'not a url', '']) {
      expect(await fetcher.fetch({ url, page: PAGE }), url).toMatchObject({ outcome: 'not-web', status: null, finalUrl: null, body: new Uint8Array(0) });
    }
    expect(asked).toHaveLength(0);
  });

  test('fetcher-follows-bounded-redirects', async () => {
    const chain: Record<string, HopResult> = { 'http://example.com/a': redirect('https://example.com/a') };
    for (let i = 0; i < 4; i++) chain[i === 0 ? 'https://example.com/a' : `https://cdn.example.net/${i}`] = redirect(`https://cdn.example.net/${i + 1}`, 302);
    chain['https://cdn.example.net/4'] = ok('done');
    const { hop, urls } = fakeHop(chain);
    const fetched = await createBoundedFetcher({ hop }).fetch({ url: 'http://example.com/a', page: PAGE });
    expect(fetched).toMatchObject({ outcome: 'response', status: 200, redirects: 5, finalUrl: 'https://cdn.example.net/4' });
    expect(fetched.chain[0]).toEqual({ url: 'http://example.com/a', status: 301, location: 'https://example.com/a' });
    expect(urls()).toHaveLength(6);
    // A call may lower the cap.
    const lower = fakeHop(chain);
    expect(await createBoundedFetcher({ hop: lower.hop }).fetch({ url: 'http://example.com/a', page: PAGE, maxRedirects: 2 })).toMatchObject({ outcome: 'too-many-redirects', redirects: 2, status: 302 });
    expect(lower.urls()).toHaveLength(3);
    for (const location of ['file:///etc/passwd', 'javascript:alert(1)', 'http://']) {
      const bad = fakeHop({ 'https://example.com/x': redirect(location, 302) });
      expect(await createBoundedFetcher({ hop: bad.hop }).fetch({ url: 'https://example.com/x', page: PAGE }), location).toMatchObject({ outcome: 'bad-redirect', redirects: 0 });
      expect(bad.urls()).toEqual(['https://example.com/x']);
    }
    const none = fakeHop({ 'https://example.com/x': redirect(null, 302) });
    expect(await createBoundedFetcher({ hop: none.hop }).fetch({ url: 'https://example.com/x', page: PAGE })).toMatchObject({ outcome: 'no-location' });
  });

  test('fetcher-refuses-private-unless-page-private', async () => {
    const { hop, asked } = fakeHop({ 'http://127.0.0.1:8080/x': ok('local'), 'https://example.com/r': redirect('http://192.168.1.1/admin') });
    const fetcher = createBoundedFetcher({ hop });
    for (const url of ['http://127.0.0.1:8080/x', 'http://localhost/', 'http://10.0.0.1/', 'http://[::1]/', 'http://printer.local/']) {
      expect(await fetcher.fetch({ url, page: PAGE }), url).toMatchObject({ outcome: 'private-address', status: null });
    }
    expect(asked).toHaveLength(0);
    expect(await fetcher.fetch({ url: 'https://example.com/r', page: PAGE })).toMatchObject({ outcome: 'private-redirect', status: 301, redirects: 0 });
    expect(asked.map((a) => a.url)).toEqual(['https://example.com/r']);
    // A page on a private host (a dev server) may fetch private hosts.
    expect(await fetcher.fetch({ url: 'http://127.0.0.1:8080/x', page: 'http://localhost:3000/' })).toMatchObject({ outcome: 'response', status: 200 });
  });

  test('fetcher-caps-body-and-time', async () => {
    const read = { count: 0 };
    const cancel = vi.fn();
    const chunk = 64 * 1024;
    const { hop } = fakeHop({ 'https://big.example/': { kind: 'response', status: 200, body: body(Array.from({ length: 100 }, () => chunk), read), cancel } });
    const fetched = await createBoundedFetcher({ hop }).fetch({ url: 'https://big.example/', page: PAGE, maxBytes: 200_000 });
    expect(fetched).toMatchObject({ outcome: 'response', truncated: true });
    expect(fetched.body.byteLength).toBe(200_000);
    expect(read.count).toBe(Math.ceil(200_000 / chunk));
    expect(cancel).toHaveBeenCalled();
    // A hop that never settles: one deadline from the call.
    const never = fakeHop({ 'https://slow.example/': () => new Promise<HopResult>(() => undefined) });
    let settled: unknown;
    void createBoundedFetcher({ hop: never.hop })
      .fetch({ url: 'https://slow.example/', page: PAGE, timeoutMs: 1_000 })
      .then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ outcome: 'timeout', status: null });
    // A body that never ends times out too, and the hop's signal is aborted.
    let signal: AbortSignal | undefined;
    const stalled: Hop = async (_url, s) => {
      signal = s;
      return { kind: 'response', status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: vi.fn() };
    };
    const slowBody = createBoundedFetcher({ hop: stalled }).fetch({ url: 'https://drip.example/', page: PAGE });
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.timeoutMs);
    await expect(slowBody).resolves.toMatchObject({ outcome: 'timeout', status: 200 });
    expect(signal?.aborted).toBe(true);
    // A network error.
    expect(await createBoundedFetcher({ hop: fakeHop({}).hop }).fetch({ url: 'https://down.example/', page: PAGE })).toMatchObject({ outcome: 'unreachable', status: null });
  });

  test('fetcher-reads-body-by-status', async () => {
    const notFound = ok('missing', 404, { 'Content-Type': 'text/html', 'Set-Cookie': ['a=1', 'b=2'], 'X-Robots-Tag': ['noindex', 'nofollow'] });
    const { hop, asked } = fakeHop({ 'https://a.example/404': notFound, 'https://a.example/ok': ok('fine', 200, { 'content-type': 'text/html; charset=utf-8' }) });
    const fetcher = createBoundedFetcher({ hop, limits: { perOriginIntervalMs: 0 } });
    const skipped = await fetcher.fetch({ url: 'https://a.example/404', page: PAGE, readBody: (status) => status === 200, keepHeaders: ['content-type', 'x-robots-tag'] });
    expect(skipped).toMatchObject({ outcome: 'response', status: 404, body: new Uint8Array(0), headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' } });
    expect(skipped.headers).not.toHaveProperty('set-cookie');
    expect((notFound as { cancel: () => void }).cancel).toHaveBeenCalled();
    const read = await fetcher.fetch({ url: 'https://a.example/ok', page: PAGE });
    expect(new TextDecoder().decode(read.body)).toBe('fine');
    expect(read.headers).toEqual({ 'content-type': 'text/html; charset=utf-8' });
    // HEAD never reads a body, and the method reaches the hop.
    const head = await fetcher.fetch({ url: 'https://a.example/ok', page: PAGE, method: 'HEAD' });
    expect(head.body.byteLength).toBe(0);
    expect(asked.at(-1)?.options).toMatchObject({ method: 'HEAD', userAgent: null });
  });

  test('fetcher-rate-limits-per-origin', async () => {
    let now = 10_000;
    const releases: ((value: HopResult) => void)[] = [];
    const pending = () => new Promise<HopResult>((resolve) => releases.push(resolve));
    const { hop, urls } = fakeHop({ 'https://r.example/1': pending, 'https://r.example/2': pending, 'https://r.example/3': pending, 'https://other.example/': pending });
    const fetcher = createBoundedFetcher({ hop, now: () => now });
    // The first request to an idle origin starts in the same tick.
    void fetcher.fetch({ url: 'https://r.example/1', page: PAGE });
    expect(urls()).toEqual(['https://r.example/1']);
    void fetcher.fetch({ url: 'https://r.example/2', page: PAGE });
    void fetcher.fetch({ url: 'https://r.example/3', page: PAGE });
    // Another origin does not wait.
    void fetcher.fetch({ url: 'https://other.example/', page: PAGE });
    expect(urls()).toEqual(['https://r.example/1', 'https://other.example/']);
    expect(fetcher.load('https://r.example')).toEqual({ running: 1, queued: 2 });
    // The second starts once the interval has passed; the third waits for a free slot.
    now += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(urls()).toEqual(['https://r.example/1', 'https://other.example/', 'https://r.example/2']);
    now += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(fetcher.load('https://r.example')).toEqual({ running: FETCHER_LIMITS.perOriginConcurrency, queued: 1 });
    releases[0]!(ok('one'));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls().at(-1)).toBe('https://r.example/3');
    // Sequential requests to one origin are spaced too.
    const seq = fakeHop({ 'https://s.example/a': ok('a'), 'https://s.example/b': ok('b') });
    let t = 0;
    const spaced = createBoundedFetcher({ hop: seq.hop, now: () => t });
    await spaced.fetch({ url: 'https://s.example/a', page: PAGE });
    void spaced.fetch({ url: 'https://s.example/b', page: PAGE });
    expect(seq.urls()).toEqual(['https://s.example/a']);
    t += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(seq.urls()).toEqual(['https://s.example/a', 'https://s.example/b']);
  });

  test('fetcher-queue-is-bounded', async () => {
    const { hop, urls } = fakeHop({ 'https://q.example/': () => new Promise<HopResult>(() => undefined) });
    const fetcher = createBoundedFetcher({ hop, limits: { perOriginConcurrency: 1, maxQueuedPerOrigin: 2 } });
    void fetcher.fetch({ url: 'https://q.example/', page: PAGE });
    void fetcher.fetch({ url: 'https://q.example/', page: PAGE });
    const controller = new AbortController();
    const queued = fetcher.fetch({ url: 'https://q.example/', page: PAGE, signal: controller.signal });
    expect(await fetcher.fetch({ url: 'https://q.example/', page: PAGE })).toMatchObject({ outcome: 'busy', status: null });
    expect(urls()).toHaveLength(1);
    // Aborted while queued: out of the queue, never requested.
    controller.abort();
    await expect(queued).resolves.toMatchObject({ outcome: 'aborted' });
    expect(fetcher.load('https://q.example')).toEqual({ running: 1, queued: 1 });
    // Aborted while running.
    const running = new AbortController();
    const live = createBoundedFetcher({ hop }).fetch({ url: 'https://q.example/', page: PAGE, signal: running.signal });
    running.abort();
    await expect(live).resolves.toMatchObject({ outcome: 'aborted' });
    // Already aborted: nothing requested.
    const before = urls().length;
    expect(await createBoundedFetcher({ hop }).fetch({ url: 'https://q.example/', page: PAGE, signal: AbortSignal.abort() })).toMatchObject({ outcome: 'aborted' });
    expect(urls()).toHaveLength(before);
  });

  test('robots-shares-the-fetcher', async () => {
    const { hop, urls } = fakeHop({ 'https://example.com/robots.txt': ok('User-agent: *\n'), 'https://example.com/page': () => new Promise<HopResult>(() => undefined) });
    const shared = createBoundedFetcher({ hop, limits: { perOriginConcurrency: 1 } });
    void shared.fetch({ url: 'https://example.com/page', page: PAGE });
    const robots = createRobotsFetcher({ hop, fetcher: shared });
    let answered = false;
    void robots.get(PAGE).then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(0);
    // The origin's one slot is taken: robots.txt waits in the shared queue.
    expect(answered).toBe(false);
    expect(shared.load('https://example.com').queued).toBe(1);
    expect(urls()).toEqual(['https://example.com/page']);
  });
});

describe('fetcher lanes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('checks-lane-limits', () => {
    // The checks' lane keeps the link check's own per-origin bounds (`LINK_CHECK_LIMITS`).
    expect(FETCHER_LANES.checks).toBe(CHECKS_FETCHER_LIMITS);
    expect(CHECKS_FETCHER_LIMITS.perOriginConcurrency).toBe(LINK_CHECK_LIMITS.perOriginConcurrency);
    expect(CHECKS_FETCHER_LIMITS.perOriginIntervalMs).toBe(LINK_CHECK_LIMITS.perOriginIntervalMs);
    expect(FETCHER_LANES.audit).toMatchObject({ perOriginConcurrency: FETCHER_LIMITS.perOriginConcurrency, perOriginIntervalMs: FETCHER_LIMITS.perOriginIntervalMs, maxQueuedPerOrigin: FETCHER_LIMITS.maxQueuedPerOrigin });
  });

  test('audit-never-waits-behind-a-link-check', async () => {
    // A 500-link check on the page's own origin whose requests never answer, holding every slot.
    const links = Array.from({ length: LINK_CHECK_LIMITS.maxLinks }, (_, i) => `https://example.com/link/${i}`);
    const routes: Record<string, HopResult | (() => Promise<HopResult>)> = { 'https://example.com/robots.txt': ok('User-agent: *\nDisallow:\n'), [PAGE]: ok('<!doctype html><title>t</title>', 200, { 'content-type': 'text/html' }) };
    for (const url of links) routes[url] = () => new Promise<HopResult>(() => undefined);
    const { hop, urls } = fakeHop(routes);
    const lanes = createFetcherLanes({ hop });
    const fetch = createCheckFetch(lanes.checks);
    const run = new AbortController();
    void runBounded(links, (url) => new URL(url).origin, (url, signal) => checkLink(url, { fetch, page: PAGE, userAgent: null, getOnly: new Set(), signal }), { perOrigin: LINK_CHECK_LIMITS.perOriginConcurrency, intervalMs: LINK_CHECK_LIMITS.perOriginIntervalMs, maxConcurrency: LINK_CHECK_LIMITS.maxConcurrency, signal: run.signal });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_LIMITS.perOriginIntervalMs * 4);
    expect(lanes.checks.load('https://example.com').running).toBe(LINK_CHECK_LIMITS.perOriginConcurrency);
    // The audit's robots.txt and served HTML of that origin start at once, in the audit lane.
    const robots = createRobotsFetcher({ hop, fetcher: lanes.audit });
    const served = createServedHtml({ fetcher: lanes.audit, parse: async () => ({ ok: false, reason: 'parse-failed' }) });
    const asked = urls().length;
    let robotsAnswer: unknown;
    let servedAnswer: unknown;
    void robots.get(PAGE).then((answer) => (robotsAnswer = answer));
    void served.get(1, PAGE, null).then((answer) => (servedAnswer = answer));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls().slice(asked)).toContain('https://example.com/robots.txt');
    expect(robotsAnswer).toMatchObject({ outcome: 'ok' });
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(urls().slice(asked)).toContain(PAGE);
    expect(servedAnswer).toBeDefined();
    expect(lanes.audit.load('https://example.com').queued).toBe(0);
    // On one shared queue the same check would hold robots.txt back.
    const shared = createBoundedFetcher({ hop });
    for (const url of links.slice(0, 3)) void shared.fetch({ url, page: PAGE });
    let sharedAnswer: unknown;
    void createRobotsFetcher({ hop, fetcher: shared })
      .get(PAGE)
      .then((answer) => (sharedAnswer = answer));
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs * 4);
    expect(sharedAnswer).toBeUndefined();
    run.abort();
  });
});

describe('net hop', () => {
  test('net-hop-sends-user-agent-and-no-cookies', async () => {
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
    const hop = netHop(net, session);
    const answering = hop('https://example.com/', new AbortController().signal, { userAgent: 'Googlebot/2.1', accept: 'text/html', method: 'GET' });
    expect(requests[0]!.options).toMatchObject({ url: 'https://example.com/', session, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(requests[0]!.request.setHeader).toHaveBeenCalledWith('User-Agent', 'Googlebot/2.1');
    expect(requests[0]!.request.setHeader).toHaveBeenCalledWith('Accept', 'text/html');
    const message = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
    requests[0]!.request.emit('response', message);
    await expect(answering).resolves.toMatchObject({ kind: 'response', status: 200, headers: { 'content-type': 'text/html' } });
    // Without a user agent the session's own is sent (no header set).
    void hop('https://example.com/', new AbortController().signal, { method: 'HEAD' });
    expect(requests[1]!.options).toMatchObject({ method: 'HEAD' });
    expect(requests[1]!.request.setHeader).not.toHaveBeenCalled();
  });
});
