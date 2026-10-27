// Spec: specs/fetcher.spec.ts (FETCHER_LIMITS, FETCH_OUTCOMES, BoundedFetchRequest / BoundedFetchResult, Lanes)
// Acceptance: specs/seo-javascript.feature.md (Bounded fetcher)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHECKS_FETCHER_LIMITS, FETCHER_LANES, FETCHER_LIMITS } from '@app/specs/fetcher.spec';
import { LINK_CHECK_LIMITS } from '@app/specs/seo-checks.spec';
import { createCheckFetch } from '../checks-fetch';
import { checkLink } from '../checks-links';
import { runBounded } from '../checks-scheduler';
import { createBoundedFetcher, createFetcherLanes, netHop, netResolver, withE2ePublicHosts, type Hop, type HopResult, type NetRequester, type Resolve } from '../fetcher';
import { isIpLiteral, isPrivateAddress, isPrivateHost, NON_PUBLIC_IPV4_BLOCKS, NON_PUBLIC_NAME_SUFFIXES, parseIpv4 } from '@app/specs/private-address.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
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

  test('private-address-ranges', () => {
    const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    // Every IPv4 block, at both ends, as a URL host and in IPv4-in-IPv6 forms.
    for (const [base, prefix] of NON_PUBLIC_IPV4_BLOCKS) {
      const first = parseIpv4(base)!;
      for (const inside of [first, first + 2 ** (32 - prefix) - 1]) {
        const v4 = dotted(inside);
        expect(isPrivateHost(new URL(`http://${v4}/`).hostname), v4).toBe(true);
        expect(isPrivateAddress(v4), v4).toBe(true);
        const hex = `${(inside >>> 16).toString(16)}:${(inside & 0xffff).toString(16)}`;
        for (const v6 of [`::ffff:${v4}`, `::${v4}`, `64:ff9b::${v4}`, `2002:${hex}::1`]) {
          expect(isPrivateAddress(v6), v6).toBe(true);
          expect(isPrivateHost(new URL(`http://[${v6}]/`).hostname), v6).toBe(true);
        }
      }
    }
    // The review's ranges by name: carrier-grade NAT (overlay VPNs), broadcast, documentation.
    for (const v4 of ['100.64.0.1', '100.100.100.100', '100.127.255.254', '255.255.255.255', '192.0.2.7', '198.51.100.7', '203.0.113.7', '198.18.0.1', '224.0.0.1', '240.0.0.1']) expect(isPrivateAddress(v4), v4).toBe(true);
    for (const v4 of ['100.63.255.255', '100.128.0.0', '8.8.8.8', '93.184.216.34']) expect(isPrivateAddress(v4), v4).toBe(false);
    for (const v6 of ['::', '::1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'fec0::1', 'feff::1', 'ff02::1', '2001:db8::1', '3fff::1', '3fff:fff::1', '100::1']) expect(isPrivateAddress(v6), v6).toBe(true);
    // 6to4 and NAT64 of a public IPv4 address are public; so is ordinary global unicast.
    for (const v6 of ['2002:808:808::1', '64:ff9b::8.8.8.8', '::ffff:8.8.8.8', '2606:4700::1111', '3fff:1000::1', 'fe00::1']) expect(isPrivateAddress(v6), v6).toBe(false);
    // Names, with trailing dots.
    for (const suffix of ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.test', '.invalid', '.onion']) {
      expect(NON_PUBLIC_NAME_SUFFIXES).toContain(suffix);
      for (const host of [`box${suffix}`, `a.b${suffix}.`, `a${suffix}..`]) expect(isPrivateHost(host), host).toBe(true);
      expect(isPrivateHost(`box${suffix.replaceAll('.', '-')}.com`), suffix).toBe(false);
    }
    for (const host of ['localhost', 'localhost.', 'LOCALHOST..', 'nas', 'router.']) expect(isPrivateHost(host), host).toBe(true);
    for (const host of ['example.com', 'example.com.', 'localhost.example.com']) expect(isPrivateHost(host), host).toBe(false);
    expect([isIpLiteral('1.2.3.4'), isIpLiteral('[::1]'), isIpLiteral('example.com')]).toEqual([true, true, false]);
  });

  test('fetcher-resolves-names-before-each-hop', async () => {
    const { hop, urls } = fakeHop({
      'https://a.example.com/start': redirect('https://b.example.com/next', 302),
      'https://b.example.com/next': redirect('http://10.0.0.1/admin', 302),
      'https://c.example.com/next': redirect('https://rebind.example.com/x', 302),
      'https://ok.example.com/': ok('fine'),
    });
    const answers: Record<string, readonly string[]> = { 'a.example.com': ['93.184.216.34'], 'b.example.com': ['93.184.216.35'], 'c.example.com': ['93.184.216.36'], 'ok.example.com': ['93.184.216.37', '2606:4700::1111'], 'rebind.example.com': ['93.184.216.38', '10.0.0.5'], 'tailnet.example.com': ['100.101.102.103'], 'v6.example.com': ['fd00::1'] };
    const resolved: string[] = [];
    const resolve: Resolve = async (host) => {
      resolved.push(host);
      const found = answers[host];
      if (!found) throw new Error('ERR_NAME_NOT_RESOLVED');
      return found;
    };
    const fetcher = createBoundedFetcher({ hop, resolve, limits: { perOriginIntervalMs: 0 } });
    // public → public → a private literal: refused at the third hop, never requested.
    expect(await fetcher.fetch({ url: 'https://a.example.com/start', page: PAGE })).toMatchObject({ outcome: 'private-redirect', redirects: 1, status: 302 });
    expect(urls()).toEqual(['https://a.example.com/start', 'https://b.example.com/next']);
    // A public name that resolves to a private address: refused on the first hop or any later one.
    for (const host of ['tailnet.example.com', 'v6.example.com']) expect(await fetcher.fetch({ url: `https://${host}/`, page: PAGE }), host).toMatchObject({ outcome: 'private-address', status: null });
    expect(await fetcher.fetch({ url: 'https://c.example.com/next', page: PAGE })).toMatchObject({ outcome: 'private-redirect', redirects: 0 });
    expect(urls()).not.toContain('https://rebind.example.com/x');
    // Every address public: fetched. A name that does not resolve: unreachable, never requested.
    expect(await fetcher.fetch({ url: 'https://ok.example.com/', page: PAGE })).toMatchObject({ outcome: 'response', status: 200 });
    expect(await fetcher.fetch({ url: 'https://nowhere.example.com/', page: PAGE })).toMatchObject({ outcome: 'unreachable', status: null });
    expect(urls()).not.toContain('https://nowhere.example.com/');
    expect(resolved).toEqual(expect.arrayContaining(['a.example.com', 'b.example.com', 'tailnet.example.com', 'v6.example.com', 'ok.example.com']));
    // Literals are not resolved; a private page is not checked at all.
    resolved.length = 0;
    await fetcher.fetch({ url: 'https://93.184.216.34/', page: PAGE });
    await fetcher.fetch({ url: 'https://tailnet.example.com/', page: 'http://localhost:3000/' });
    expect(resolved).toEqual([]);
    // robots.txt of a public name that resolves privately: no robots.txt (as a private redirect), never fetched.
    const robots = createRobotsFetcher({ hop, fetcher });
    expect(await robots.get('https://tailnet.example.com/page')).toMatchObject({ outcome: 'private-redirect', status: null });
    expect(urls()).not.toContain('https://tailnet.example.com/robots.txt');
    // Resolution counts against the deadline.
    const slow = createBoundedFetcher({ hop, resolve: () => new Promise(() => undefined) });
    const pending = slow.fetch({ url: 'https://ok.example.com/', page: PAGE, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' });
  });

  test('net-resolver-and-e2e-seam', async () => {
    const session = { resolveHost: vi.fn(async () => ({ endpoints: [{ address: '127.0.0.1', family: 'ipv4' }, { address: '::1', family: 'ipv6' }] })) };
    const resolve = netResolver(session);
    expect(await resolve('site.example.com')).toEqual(['127.0.0.1', '::1']);
    // The seam exempts only the names it lists; packaged builds refuse its switch.
    const seamed = withE2ePublicHosts(resolve, ['Checks.frost-e2e.net', ' ']);
    expect(await seamed('checks.frost-e2e.net')).toBeNull();
    expect(await seamed('other.frost-e2e.net')).toEqual(['127.0.0.1', '::1']);
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(E2E_PUBLIC_HOSTS_SWITCH);
    const { hop, urls } = fakeHop({ 'http://checks.frost-e2e.net/': ok('seam') });
    expect(await createBoundedFetcher({ hop, resolve: seamed }).fetch({ url: 'http://checks.frost-e2e.net/', page: PAGE })).toMatchObject({ outcome: 'response' });
    expect(await createBoundedFetcher({ hop, resolve: seamed }).fetch({ url: 'http://other.frost-e2e.net/', page: PAGE })).toMatchObject({ outcome: 'private-address' });
    expect(urls()).toEqual(['http://checks.frost-e2e.net/']);
  });

  test('fetcher-caps-body-and-time', async () => {
    const read = { count: 0 };
    const cancel = vi.fn();
    const chunk = 64 * 1024;
    const { hop } = fakeHop({ 'https://big.example.net/': { kind: 'response', status: 200, body: body(Array.from({ length: 100 }, () => chunk), read), cancel } });
    const fetched = await createBoundedFetcher({ hop }).fetch({ url: 'https://big.example.net/', page: PAGE, maxBytes: 200_000 });
    expect(fetched).toMatchObject({ outcome: 'response', truncated: true });
    expect(fetched.body.byteLength).toBe(200_000);
    expect(read.count).toBe(Math.ceil(200_000 / chunk));
    expect(cancel).toHaveBeenCalled();
    // A cap that is a whole number of chunks: a body that goes on is still `truncated`, one that ends is not.
    const exact = fakeHop({ 'https://exact.example.net/more': { kind: 'response', status: 200, body: body([chunk, chunk, chunk]), cancel: vi.fn() }, 'https://exact.example.net/end': { kind: 'response', status: 200, body: body([chunk, chunk]), cancel: vi.fn() } });
    const exactFetcher = createBoundedFetcher({ hop: exact.hop, limits: { perOriginIntervalMs: 0 } });
    expect(await exactFetcher.fetch({ url: 'https://exact.example.net/more', page: PAGE, maxBytes: 2 * chunk })).toMatchObject({ outcome: 'response', truncated: true, body: expect.objectContaining({ byteLength: 2 * chunk }) });
    expect(await exactFetcher.fetch({ url: 'https://exact.example.net/end', page: PAGE, maxBytes: 2 * chunk })).toMatchObject({ outcome: 'response', truncated: false, body: expect.objectContaining({ byteLength: 2 * chunk }) });
    // A hop that never settles: one deadline from the call.
    const never = fakeHop({ 'https://slow.example.net/': () => new Promise<HopResult>(() => undefined) });
    let settled: unknown;
    void createBoundedFetcher({ hop: never.hop })
      .fetch({ url: 'https://slow.example.net/', page: PAGE, timeoutMs: 1_000 })
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
    const slowBody = createBoundedFetcher({ hop: stalled }).fetch({ url: 'https://drip.example.net/', page: PAGE });
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.timeoutMs);
    await expect(slowBody).resolves.toMatchObject({ outcome: 'timeout', status: 200 });
    expect(signal?.aborted).toBe(true);
    // A network error.
    expect(await createBoundedFetcher({ hop: fakeHop({}).hop }).fetch({ url: 'https://down.example.net/', page: PAGE })).toMatchObject({ outcome: 'unreachable', status: null });
  });

  test('fetcher-reads-body-by-status', async () => {
    const notFound = ok('missing', 404, { 'Content-Type': 'text/html', 'Set-Cookie': ['a=1', 'b=2'], 'X-Robots-Tag': ['noindex', 'nofollow'] });
    const { hop, asked } = fakeHop({ 'https://a.example.net/404': notFound, 'https://a.example.net/ok': ok('fine', 200, { 'content-type': 'text/html; charset=utf-8' }) });
    const fetcher = createBoundedFetcher({ hop, limits: { perOriginIntervalMs: 0 } });
    const skipped = await fetcher.fetch({ url: 'https://a.example.net/404', page: PAGE, readBody: (status) => status === 200, keepHeaders: ['content-type', 'x-robots-tag'] });
    expect(skipped).toMatchObject({ outcome: 'response', status: 404, body: new Uint8Array(0), headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' } });
    expect(skipped.headers).not.toHaveProperty('set-cookie');
    expect((notFound as { cancel: () => void }).cancel).toHaveBeenCalled();
    const read = await fetcher.fetch({ url: 'https://a.example.net/ok', page: PAGE });
    expect(new TextDecoder().decode(read.body)).toBe('fine');
    expect(read.headers).toEqual({ 'content-type': 'text/html; charset=utf-8' });
    // HEAD never reads a body, and the method reaches the hop.
    const head = await fetcher.fetch({ url: 'https://a.example.net/ok', page: PAGE, method: 'HEAD' });
    expect(head.body.byteLength).toBe(0);
    expect(asked.at(-1)?.options).toMatchObject({ method: 'HEAD', userAgent: null });
  });

  test('fetcher-rate-limits-per-origin', async () => {
    let now = 10_000;
    const releases: ((value: HopResult) => void)[] = [];
    const pending = () => new Promise<HopResult>((resolve) => releases.push(resolve));
    const { hop, urls } = fakeHop({ 'https://r.example.net/1': pending, 'https://r.example.net/2': pending, 'https://r.example.net/3': pending, 'https://other.example.net/': pending });
    const fetcher = createBoundedFetcher({ hop, now: () => now });
    // The first request to an idle origin starts in the same tick.
    void fetcher.fetch({ url: 'https://r.example.net/1', page: PAGE });
    expect(urls()).toEqual(['https://r.example.net/1']);
    void fetcher.fetch({ url: 'https://r.example.net/2', page: PAGE });
    void fetcher.fetch({ url: 'https://r.example.net/3', page: PAGE });
    // Another origin does not wait.
    void fetcher.fetch({ url: 'https://other.example.net/', page: PAGE });
    expect(urls()).toEqual(['https://r.example.net/1', 'https://other.example.net/']);
    expect(fetcher.load('https://r.example.net')).toEqual({ running: 1, queued: 2 });
    // The second starts once the interval has passed; the third waits for a free slot.
    now += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(urls()).toEqual(['https://r.example.net/1', 'https://other.example.net/', 'https://r.example.net/2']);
    now += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(fetcher.load('https://r.example.net')).toEqual({ running: FETCHER_LIMITS.perOriginConcurrency, queued: 1 });
    releases[0]!(ok('one'));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls().at(-1)).toBe('https://r.example.net/3');
    // Sequential requests to one origin are spaced too.
    const seq = fakeHop({ 'https://s.example.net/a': ok('a'), 'https://s.example.net/b': ok('b') });
    let t = 0;
    const spaced = createBoundedFetcher({ hop: seq.hop, now: () => t });
    await spaced.fetch({ url: 'https://s.example.net/a', page: PAGE });
    void spaced.fetch({ url: 'https://s.example.net/b', page: PAGE });
    expect(seq.urls()).toEqual(['https://s.example.net/a']);
    t += FETCHER_LIMITS.perOriginIntervalMs;
    await vi.advanceTimersByTimeAsync(FETCHER_LIMITS.perOriginIntervalMs);
    expect(seq.urls()).toEqual(['https://s.example.net/a', 'https://s.example.net/b']);
  });

  test('fetcher-queue-is-bounded', async () => {
    const { hop, urls } = fakeHop({ 'https://q.example.net/': () => new Promise<HopResult>(() => undefined) });
    const fetcher = createBoundedFetcher({ hop, limits: { perOriginConcurrency: 1, maxQueuedPerOrigin: 2 } });
    void fetcher.fetch({ url: 'https://q.example.net/', page: PAGE });
    void fetcher.fetch({ url: 'https://q.example.net/', page: PAGE });
    const controller = new AbortController();
    const queued = fetcher.fetch({ url: 'https://q.example.net/', page: PAGE, signal: controller.signal });
    expect(await fetcher.fetch({ url: 'https://q.example.net/', page: PAGE })).toMatchObject({ outcome: 'busy', status: null });
    expect(urls()).toHaveLength(1);
    // Aborted while queued: out of the queue, never requested.
    controller.abort();
    await expect(queued).resolves.toMatchObject({ outcome: 'aborted' });
    expect(fetcher.load('https://q.example.net')).toEqual({ running: 1, queued: 1 });
    // Aborted while running.
    const running = new AbortController();
    const live = createBoundedFetcher({ hop }).fetch({ url: 'https://q.example.net/', page: PAGE, signal: running.signal });
    running.abort();
    await expect(live).resolves.toMatchObject({ outcome: 'aborted' });
    // Already aborted: nothing requested.
    const before = urls().length;
    expect(await createBoundedFetcher({ hop }).fetch({ url: 'https://q.example.net/', page: PAGE, signal: AbortSignal.abort() })).toMatchObject({ outcome: 'aborted' });
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
    const lanes = createFetcherLanes({ hop, resolve: async () => ['93.184.216.34'] });
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
