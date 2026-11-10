// Spec: specs/site-crawl.spec.ts (CRAWL_ROBOTS_TOKEN, CRAWL_SITEMAP_ACCEPT, CRAWL_LIMITS, MAX_CRAWL_DELAY_MS), specs/seo-checks.spec.ts
// (SITEMAP_LIMITS), specs/fetcher.spec.ts (the crawl lane, BoundedFetchRequest.allowRedirect)
// Acceptance: specs/site-crawl.feature.md (Sitemap seeding: every sitemap request is a crawl request; robots.txt that does not
// parse; beforeRequest); plan docs/plans/phase-12-big-bets.md Decision 6, Threat model (crawl row) and Task 6b (review fixes)
//
// The real crawl fetcher (scope, robots.txt through main's robots fetcher, pacing, the redirect hook) over fake hops: no network,
// fake timers. The sitemap files are read by the crawl worker's code in this process.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CRAWL_SITEMAP_ACCEPT } from '@app/specs/site-crawl.spec';
import { createBoundedFetcher, type Hop, type HopResult, type Resolve } from '../../seo/fetcher';
import { createRobotsFetcher } from '../../seo/robots-fetch';
import { parseCrawlRobots, parseCrawlSitemap } from '../analyse';
import { createCrawlFetcher, createCrawlLane, type CrawlRobotsSource } from '../fetch';
import { createSitemapSeeder } from '../sitemaps';
import { settingsFor } from './run-fakes';

const encoder = new TextEncoder();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function body(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(text);
    },
  };
}
const answer = (text: string, status = 200, headers: Record<string, string> = { 'content-type': 'application/xml' }): HopResult => ({ kind: 'response', status, body: body(text), headers, cancel: () => undefined });
const redirect = (location: string, status = 302): HopResult => ({ kind: 'redirect', status, location });
const robotsTxt = (text: string) => answer(text, 200, { 'content-type': 'text/plain' });
const urlset = (urls: readonly string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const resolve: Resolve = async () => ['93.184.216.34'];

/** Every request any hop made, with its time and `Accept`. */
function fakeNet(routes: Record<string, HopResult>) {
  const requests: { url: string; at: number; accept: string | undefined }[] = [];
  const hop: Hop = async (url, _signal, options) => {
    requests.push({ url, at: Date.now(), accept: options?.accept });
    const route = routes[url];
    if (!route) throw new Error(`net::ERR_CONNECTION_REFUSED ${url}`);
    return route;
  };
  return { hop, requests, urls: () => requests.map((request) => request.url) };
}

/** Advances the fake timers until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      error = e;
    },
  );
  for (let i = 0; i < 10_000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (!done) await vi.advanceTimersToNextTimerAsync();
  }
  if (!done) throw new Error('never settled');
  if (error !== undefined) throw error;
  return value as T;
}

const inProcessRobots = async (text: string) => {
  const parsed = parseCrawlRobots({ text });
  if (!parsed.ok) throw new Error('robots');
  return parsed.robots;
};

/** A run's seeding over the real crawl fetcher: main's robots fetcher and the crawl lane on `routes`. */
function rig(routes: Record<string, HopResult>, startUrl: string) {
  const net = fakeNet(routes);
  const robots = createRobotsFetcher({ hop: net.hop, fetcher: createBoundedFetcher({ hop: net.hop, resolve }) });
  const crawl = createCrawlFetcher({ fetcher: createCrawlLane({ hop: net.hop, resolve }), robots, userAgent: () => UA });
  const settings = settingsFor(startUrl, { sitemaps: true });
  const run = crawl.forRun(settings);
  const seeded: string[] = [];
  const controller = new AbortController();
  const seeder = createSitemapSeeder({ robots, parseRobots: inProcessRobots, analyse: async (input) => parseCrawlSitemap(input) });
  const seed = () =>
    settle(
      seeder.seed({
        runId: '01900000-0000-7000-8000-000000000001',
        settings,
        scope: run.scope,
        fetch: (url, options) => run.fetchPage(url, controller.signal, options),
        signal: controller.signal,
        seed: async (urls) => (seeded.push(...urls), urls.length),
      }),
    );
  return { net, run, seeded, seed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('sitemap requests are crawl requests', () => {
  test('crawl-sitemap-private-start-stays-on-its-origin', async () => {
    const t = rig(
      {
        'http://127.0.0.1:3000/robots.txt': robotsTxt('User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:9229/x\nSitemap: /sitemap.xml\n'),
        'http://127.0.0.1:3000/sitemap.xml': redirect('http://127.0.0.1:9229/y'),
        'http://127.0.0.1:9229/x': answer(urlset(['http://127.0.0.1:9229/a'])),
        'http://127.0.0.1:9229/y': answer(urlset(['http://127.0.0.1:9229/b'])),
        'http://127.0.0.1:9229/robots.txt': robotsTxt('User-agent: *\nAllow: /\n'),
      },
      'http://127.0.0.1:3000/',
    );
    expect(await t.seed()).toEqual({ seeded: 0, note: null, slowDown: false });
    // Not one request reached :9229 (not its sitemap, its redirect target, nor its robots.txt).
    expect(t.net.urls().filter((url) => url.includes(':9229'))).toEqual([]);
    expect(t.net.urls()).toEqual(['http://127.0.0.1:3000/robots.txt', 'http://127.0.0.1:3000/sitemap.xml']);
    expect(t.seeded).toEqual([]);
  });

  test('crawl-sitemap-honours-crawl-delay-and-retry-after', async () => {
    const delayed = rig(
      {
        'https://example.com/robots.txt': robotsTxt('User-agent: *\nAllow: /\nCrawl-delay: 10\nSitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml\nSitemap: https://example.com/c.xml\n'),
        'https://example.com/a.xml': answer(urlset(['https://example.com/1'])),
        'https://example.com/b.xml': answer(urlset(['https://example.com/2'])),
        'https://example.com/c.xml': answer(urlset(['https://example.com/3'])),
      },
      'https://example.com/',
    );
    expect(await delayed.seed()).toEqual({ seeded: 3, note: null, slowDown: false });
    const files = delayed.net.requests.filter((request) => request.url.endsWith('.xml'));
    expect(files.map((request) => request.url)).toEqual(['https://example.com/a.xml', 'https://example.com/b.xml', 'https://example.com/c.xml']);
    for (let i = 1; i < files.length; i++) expect(files[i]!.at - files[i - 1]!.at).toBeGreaterThanOrEqual(10_000);
    // Each answer is reported to the host's pacing: a 503 with Retry-After holds the next request back.
    const busy = rig(
      {
        'https://example.org/robots.txt': robotsTxt('User-agent: *\nAllow: /\nSitemap: https://example.org/a.xml\nSitemap: https://example.org/b.xml\n'),
        'https://example.org/a.xml': answer('', 503, { 'content-type': 'text/plain', 'retry-after': '30' }),
        'https://example.org/b.xml': answer(urlset(['https://example.org/1'])),
      },
      'https://example.org/',
    );
    await busy.seed();
    const [a, b] = busy.net.requests.filter((request) => request.url.endsWith('.xml'));
    expect(b!.at - a!.at).toBeGreaterThanOrEqual(30_000);
    expect(a!.accept).toBe(CRAWL_SITEMAP_ACCEPT);
  });

  test('crawl-sitemap-disallowed-by-robots-is-not-fetched', async () => {
    const t = rig(
      {
        'https://example.com/robots.txt': robotsTxt('User-agent: frost-crawl\nDisallow: /private/\n\nUser-agent: *\nAllow: /\n\nSitemap: https://example.com/private/s.xml\nSitemap: https://example.com/ok.xml\n'),
        'https://example.com/private/s.xml': answer(urlset(['https://example.com/secret'])),
        'https://example.com/ok.xml': answer(urlset(['https://example.com/open', 'https://elsewhere.example.org/out'])),
      },
      'https://example.com/',
    );
    await t.seed();
    expect(t.net.urls()).not.toContain('https://example.com/private/s.xml');
    expect(t.net.urls()).toContain('https://example.com/ok.xml');
    expect(t.seeded).toEqual(['https://example.com/open', 'https://elsewhere.example.org/out']);
    // An out-of-scope sitemap (another site) is never requested either.
    const out = rig({ 'https://example.com/robots.txt': robotsTxt('User-agent: *\nAllow: /\nSitemap: https://elsewhere.example.org/s.xml\n') }, 'https://example.com/');
    await out.seed();
    expect(out.net.urls()).toEqual(['https://example.com/robots.txt']);
  });

  test('crawl-sitemap-robots-unreachable-is-not-fetched', async () => {
    // Council review, item 2 (RFC 9309 §2.3.1.4): robots.txt that cannot be read (a 5xx here) refuses the sitemap request
    // like any page: the fallback `/sitemap.xml` is never requested, nothing is seeded.
    const t = rig({ 'https://example.com/robots.txt': answer('', 503, { 'content-type': 'text/plain' }), 'https://example.com/sitemap.xml': answer(urlset(['https://example.com/a'])) }, 'https://example.com/');
    expect(await t.seed()).toEqual({ seeded: 0, note: null, slowDown: false });
    expect(t.net.urls()).toEqual(['https://example.com/robots.txt']);
    expect(t.seeded).toEqual([]);
  });
});

describe('robots.txt the worker cannot parse', () => {
  test('crawl-robots-unparsed-is-blocked', async () => {
    const net = fakeNet({ 'https://example.com/page': answer('<title>x</title>', 200, { 'content-type': 'text/html' }) });
    // Main's robots fetcher answers one cached object (as the real one does).
    const fetched: RobotsFetch = { url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: encoder.encode('User-agent: *\nAllow: /\n'), truncated: false };
    const robots: CrawlRobotsSource = { get: async () => fetched };
    let fail = true;
    const parseRobots = vi.fn(async (text: string) => {
      if (fail) throw new Error('worker timed out');
      const { crawlRobotsRulesOf } = await import('../analyse');
      return crawlRobotsRulesOf(await inProcessRobots(text));
    });
    const run = createCrawlFetcher({ fetcher: createCrawlLane({ hop: net.hop, resolve }), robots, userAgent: () => UA, parseRobots }).forRun(settingsFor('https://example.com/'));
    // Fetched but unparsed: blocked (recorded blocked-by-robots), never unknown; nothing requested.
    expect(await settle(run.fetchPage('https://example.com/page'))).toMatchObject({ outcome: 'blocked-by-robots', robots: { crawl: 'blocked', unreachable: false, unparsed: true } });
    expect(net.urls()).toEqual([]);
    // The failed parse was not kept: the next page asks again, and is fetched.
    fail = false;
    expect(await settle(run.fetchPage('https://example.com/page'))).toMatchObject({ outcome: 'response', robots: { crawl: 'allowed' } });
    expect(parseRobots).toHaveBeenCalledTimes(2);
    expect(net.urls()).toEqual(['https://example.com/page']);
  });
});

describe('robots.txt the worker parses late', () => {
  test('crawl-sitemap-robots-parse-stall-is-blocked', async () => {
    // Council review, item 1, the sitemap path: robots.txt is fetched `ok` (Disallow: /, a Sitemap: line) but the crawl
    // worker's parse never answers. The seeder reads its Sitemap: line, yet the sitemap request (a crawl request) is
    // refused: nothing but robots.txt is ever requested, nothing seeded.
    const net = fakeNet({
      'https://example.com/robots.txt': robotsTxt('User-agent: *\nDisallow: /\nSitemap: https://example.com/s.xml\n'),
      'https://example.com/s.xml': answer(urlset(['https://example.com/a'])),
      'https://example.com/sitemap.xml': answer(urlset(['https://example.com/b'])),
    });
    const robots = createRobotsFetcher({ hop: net.hop, fetcher: createBoundedFetcher({ hop: net.hop, resolve }) });
    const crawl = createCrawlFetcher({ fetcher: createCrawlLane({ hop: net.hop, resolve }), robots, userAgent: () => UA, parseRobots: () => new Promise(() => undefined) });
    const settings = settingsFor('https://example.com/', { sitemaps: true });
    const run = crawl.forRun(settings);
    const controller = new AbortController();
    const seeded: string[] = [];
    const seeder = createSitemapSeeder({ robots, parseRobots: inProcessRobots, analyse: async (input) => parseCrawlSitemap(input) });
    const result = await settle(
      seeder.seed({
        runId: '01900000-0000-7000-8000-000000000001',
        settings,
        scope: run.scope,
        fetch: (url, options) => run.fetchPage(url, controller.signal, options),
        signal: controller.signal,
        seed: async (urls) => (seeded.push(...urls), urls.length),
      }),
    );
    expect(result).toEqual({ seeded: 0, note: null, slowDown: false });
    expect(seeded).toEqual([]);
    expect(net.urls()).toEqual(['https://example.com/robots.txt']);
  });
});

describe('the last check before a request', () => {
  test('crawl-before-request-is-asked-in-the-paced-slot', async () => {
    const net = fakeNet({ 'https://example.com/a': answer('<title>a</title>', 200, { 'content-type': 'text/html' }), 'https://example.com/b': answer('<title>b</title>', 200, { 'content-type': 'text/html' }) });
    // No robots.txt (a 404): everything allowed. (No answer at all would refuse every page: `robots-unreachable`.)
    const robots: CrawlRobotsSource = { get: async () => ({ url: 'https://example.com/robots.txt', outcome: 'unavailable', status: 404, finalUrl: null, redirects: 0, body: new Uint8Array(0), truncated: false }) };
    const run = createCrawlFetcher({ fetcher: createCrawlLane({ hop: net.hop, resolve }), robots, userAgent: () => UA }).forRun(settingsFor('https://example.com/'));
    expect(await settle(run.fetchPage('https://example.com/a'))).toMatchObject({ outcome: 'response' });
    // The second call waits its interval; the project is deleted meanwhile: asked after the wait, nothing is sent.
    let live = true;
    const asked: number[] = [];
    const pending = run.fetchPage('https://example.com/b', undefined, {
      beforeRequest: async () => {
        asked.push(Date.now());
        return live;
      },
    });
    live = false;
    expect(await settle(pending)).toMatchObject({ outcome: 'aborted', status: null });
    expect(asked).toHaveLength(1);
    expect(net.urls()).toEqual(['https://example.com/a']);
    expect(asked[0]! - net.requests[0]!.at).toBeGreaterThanOrEqual(1_000);
  });
});

describe('the worker keeps a sitemap across windows', () => {
  test('crawl-sitemap-window-cache', () => {
    const job = { kind: 'sitemap' as const, bytes: encoder.encode(urlset(['https://example.com/1', 'https://example.com/2', 'https://example.com/3'])), fileUrl: 'https://example.com/s.xml', pageUrl: 'https://example.com/', canonicalUrl: null, urlBudget: 10, now: 0 };
    expect(parseCrawlSitemap({ key: 'k1', job, take: 2 })).toMatchObject({ ok: true, urls: ['https://example.com/1', 'https://example.com/2'], total: 3 });
    expect(parseCrawlSitemap({ key: 'k1', skip: 2, take: 2 })).toMatchObject({ ok: true, urls: ['https://example.com/3'], total: 3 });
    // Another key is not held; a release drops the file; a window after it is refused.
    expect(parseCrawlSitemap({ key: 'k2', skip: 0, take: 2 })).toEqual({ ok: false, reason: 'invalid-job' });
    expect(parseCrawlSitemap({ key: 'k1', release: true })).toMatchObject({ ok: true, urls: [] });
    expect(parseCrawlSitemap({ key: 'k1', skip: 0, take: 2 })).toEqual({ ok: false, reason: 'invalid-job' });
    expect(parseCrawlSitemap({ key: 'k1', job, take: 5_000 })).toEqual({ ok: false, reason: 'invalid-job' });
  });
});
