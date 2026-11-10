// Spec: specs/site-crawl.spec.ts (CRAWL_KEEP_HEADERS, CRAWL_SEPARATE_HEADERS, CRAWL_USER_AGENT_TOKEN, CRAWL_ROBOTS_TOKEN,
// CRAWL_ROBOTS_HOOK_MARGIN_MS, CRAWL_LIMITS, CRAWL_PAGE_OUTCOMES); specs/fetcher.spec.ts (CRAWL_FETCHER_LIMITS, the crawl lane,
// BoundedFetchRequest.allowRedirect); specs/seo-indexability.spec.ts (ROBOTS_FETCH_LIMITS, ROBOTS_UNKNOWN_OUTCOMES)
// Acceptance: specs/site-crawl.feature.md (Fetching, politeness and robots); plan docs/plans/phase-12-big-bets.md
// Decision 3 (K-B1), Decision 6, Threat model (crawl row) and Task 6a
//
// Every site here is a fake hop (no network): names are answered by a fake resolver, private starts are loopback.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { crawlRobotsRules, type CrawlRobotsRules } from '@app/seo-core';
import { CRAWL_FETCHER_LIMITS, type BoundedFetcher, type BoundedFetchRequest } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT } from '@app/specs/seo-javascript.spec';
import { ROBOTS_FETCH_LIMITS, ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CRAWL_KEEP_HEADERS, CRAWL_LIMITS, CRAWL_ROBOTS_HOOK_MARGIN_MS, CRAWL_ROBOTS_TOKEN, CRAWL_SEPARATE_HEADERS, CRAWL_USER_AGENT_TOKEN } from '@app/specs/site-crawl.spec';
import { createBoundedFetcher, type Hop, type HopResult, type Resolve } from '../../seo/fetcher';
import { createRobotsFetcher } from '../../seo/robots-fetch';
import { createCrawlFetcher, createCrawlLane, type CrawlRobotsSource } from '../fetch';

const BROWSE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SENT_UA = `${BROWSE_UA} ${CRAWL_USER_AGENT_TOKEN}`;
const encoder = new TextEncoder();

function body(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(text);
    },
  };
}
const html = (text = '<title>x</title>', status = 200, headers: Record<string, string | string[]> = { 'content-type': 'text/html' }, rawHeaders?: string[]): HopResult => ({ kind: 'response', status, body: body(text), headers, ...(rawHeaders ? { rawHeaders } : {}), cancel: () => undefined });
const redirect = (location: string, status = 301): HopResult => ({ kind: 'redirect', status, location });

type Route = HopResult | (() => HopResult | Promise<HopResult>);

/** Every request any hop made (page fetches and robots.txt alike), in order, with its time and options. */
interface Net {
  readonly requests: { url: string; at: number; userAgent: string | null | undefined; accept: string | undefined }[];
  hop(routes: Record<string, Route>): Hop;
  urls(): string[];
}
function fakeNet(): Net {
  const requests: Net['requests'] = [];
  return {
    requests,
    hop: (routes) => async (url, _signal, options) => {
      requests.push({ url, at: Date.now(), userAgent: options?.userAgent, accept: options?.accept });
      const route = routes[url];
      if (!route) throw new Error(`net::ERR_CONNECTION_REFUSED ${url}`);
      return typeof route === 'function' ? route() : route;
    },
    urls: () => requests.map((request) => request.url),
  };
}

/** Public names resolve to a public address; `intranet.example.com` to a private one. */
const resolve: Resolve = async (host) => (host === 'intranet.example.com' ? ['10.0.0.9'] : ['93.184.216.34']);

/** The crawl lane over `hop`, wrapped to record each call's request and how many calls ran at once per host name (the pacing key). */
function lane(hop: Hop) {
  const inner = createCrawlLane({ hop, resolve });
  const calls: BoundedFetchRequest[] = [];
  const running = new Map<string, number>();
  let maxInFlight = 0;
  const fetcher: BoundedFetcher = {
    async fetch(request) {
      calls.push(request);
      const origin = new URL(request.url).hostname;
      running.set(origin, (running.get(origin) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, running.get(origin)!);
      try {
        return await inner.fetch(request);
      } finally {
        running.set(origin, running.get(origin)! - 1);
      }
    },
    load: (origin) => inner.load(origin),
  };
  return { fetcher, calls, maxInFlight: () => maxInFlight };
}

const robotsFetch = (url: string, outcome: RobotsFetchOutcome, text = ''): RobotsFetch => ({ url, outcome, status: outcome === 'ok' ? 200 : null, finalUrl: outcome === 'ok' ? url : null, redirects: 0, body: outcome === 'ok' ? encoder.encode(text) : new Uint8Array(0), truncated: false });

/** A fake robots source by origin: a file's text, an outcome, or `never` (the lookup never answers). */
function fakeRobots(answers: Record<string, string | RobotsFetchOutcome | 'never' | { after: number; text: string }>) {
  const lookups: { url: string; exactOrigin: boolean }[] = [];
  const source: CrawlRobotsSource = {
    get(pageUrl, options) {
      const origin = new URL(pageUrl).origin;
      lookups.push({ url: pageUrl, exactOrigin: options?.exactOrigin === true });
      const answer = answers[origin] ?? 'unavailable';
      const robotsUrl = `${origin}/robots.txt`;
      if (answer === 'never') return new Promise(() => undefined);
      if (typeof answer === 'object') return new Promise((resolve) => setTimeout(() => resolve(robotsFetch(robotsUrl, 'ok', answer.text)), answer.after));
      if ((['ok', 'pending', 'unavailable', 'forbidden', 'too-many-redirects', 'private-redirect', 'server-error', 'unreachable', 'timeout', 'bad-redirect', 'no-location'] as string[]).includes(answer)) return Promise.resolve(robotsFetch(robotsUrl, answer as RobotsFetchOutcome));
      return Promise.resolve(robotsFetch(robotsUrl, 'ok', answer));
    },
  };
  return { source, lookups };
}

/** Advances the fake timers until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  for (let i = 0; i < 10_000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (!done) await vi.advanceTimersToNextTimerAsync();
  }
  if (!done) throw new Error('never settled');
  if (failed) throw error;
  return value as T;
}

const settings = (startUrl: string, extra: Partial<{ scope: 'host' | 'site' | 'path'; include: string[]; exclude: string[]; intervalMs: number }> = {}) => ({ startUrl, scope: 'host' as const, include: [], exclude: [], intervalMs: 1_000, ...extra });

function crawler(routes: Record<string, Route>, robots: CrawlRobotsSource, parseRobots?: (text: string) => CrawlRobotsRules) {
  const net = fakeNet();
  const lanes = lane(net.hop(routes));
  const crawl = createCrawlFetcher({ fetcher: lanes.fetcher, robots, userAgent: () => BROWSE_UA, ...(parseRobots ? { parseRobots } : {}) });
  return { net, lanes, crawl };
}

describe('crawl fetching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  test('crawl-lane-is-the-crawl-fetcher-limits', async () => {
    // The lane: one call in flight per origin, its floor between starts, a short queue.
    const net = fakeNet();
    const hop = net.hop({ 'https://example.com/a': () => new Promise<HopResult>(() => undefined), 'https://example.com/b': html() });
    const crawlLane = createCrawlLane({ hop, resolve });
    void crawlLane.fetch({ url: 'https://example.com/a', page: 'https://example.com/' });
    await vi.advanceTimersByTimeAsync(0);
    expect(crawlLane.load('https://example.com')).toEqual({ running: 1, queued: 0 });
    const queued = Array.from({ length: CRAWL_FETCHER_LIMITS.maxQueuedPerOrigin + 1 }, () => crawlLane.fetch({ url: 'https://example.com/b', page: 'https://example.com/' }));
    expect(await queued.at(-1)).toMatchObject({ outcome: 'busy' });
    expect(crawlLane.load('https://example.com').queued).toBe(CRAWL_FETCHER_LIMITS.maxQueuedPerOrigin);
  });

  test('crawl-is-polite', async () => {
    // K-B1 through the crawl fetcher: one fetch call per origin at a time; consecutive calls start at least the
    // effective interval apart; a redirecting page's hops (one call) follow each other at once.
    for (const intervalMs of [500, 750, 1_000, 2_500, 4_000]) {
      const routes: Record<string, Route> = {
        'https://example.com/r': redirect('/r2', 302),
        'https://example.com/r2': redirect('/final', 302),
        'https://example.com/final': () => new Promise<HopResult>((resolve) => setTimeout(() => resolve(html()), 120)),
        'https://example.com/p1': () => new Promise<HopResult>((resolve) => setTimeout(() => resolve(html()), intervalMs + 300)),
        'https://example.com/p2': html(),
        'https://example.com/p3': html(),
      };
      const { net, lanes, crawl } = crawler(routes, fakeRobots({ 'https://example.com': 'User-agent: *\nAllow: /\n' }).source);
      const run = crawl.forRun(settings('https://example.com/', { intervalMs }));
      const pages = ['/r', '/p1', '/p2', '/p3'].map((path) => run.fetchPage(`https://example.com${path}`));
      const results = await settle(Promise.all(pages));
      expect(results.map((r) => r.outcome), String(intervalMs)).toEqual(['response', 'response', 'response', 'response']);
      expect(results[0]).toMatchObject({ redirects: 2, finalUrl: 'https://example.com/final' });
      expect(lanes.maxInFlight(), String(intervalMs)).toBe(1);
      const at = (url: string) => net.requests.find((r) => r.url === url)!.at;
      // The hops of one call are not spaced.
      expect(at('https://example.com/r2') - at('https://example.com/r')).toBe(0);
      expect(at('https://example.com/final') - at('https://example.com/r')).toBe(0);
      // Each next call waits the full interval after the previous call started (or longer, when that call ran longer).
      const starts = ['/r', '/p1', '/p2', '/p3'].map((path) => at(`https://example.com${path}`));
      expect(starts[1]! - starts[0]!).toBe(intervalMs);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!, `${intervalMs} ${i}`).toBeGreaterThanOrEqual(intervalMs);
      // p1 ran longer than the interval: p2 starts when it ends, not earlier.
      expect(starts[2]! - starts[1]!).toBe(intervalMs + 300);
    }
  });

  test('crawl-is-polite-per-host', async () => {
    // K-B1, Task 6a review: pacing is per host name. Two hosts redirecting into a third never reach it inside their
    // calls (`redirected`, the target queued by Task 6b); the third host's own pages are then paced on their own.
    const routes: Record<string, Route> = {
      'https://a.example.com/x': redirect('https://c.example.com/1', 301),
      'https://b.example.com/y': redirect('https://c.example.com/2', 302),
      'https://c.example.com/1': html(),
      'https://c.example.com/2': html(),
      // http → https on one host: followed inside the call, and paced as one host.
      'http://d.example.com/p': redirect('https://d.example.com/p', 301),
      'https://d.example.com/p': html(),
      'https://d.example.com/q': html(),
      'http://d.example.com/r': html(),
    };
    const robots = fakeRobots({});
    const { net, lanes, crawl } = crawler(routes, robots.source);
    const run = crawl.forRun(settings('https://a.example.com/', { scope: 'site', intervalMs: 2_000 }));
    const [a, b] = await settle(Promise.all([run.fetchPage('https://a.example.com/x'), run.fetchPage('https://b.example.com/y')]));
    expect(a).toMatchObject({ outcome: 'redirected', status: 301, redirectTarget: 'https://c.example.com/1', finalUrl: 'https://c.example.com/1', redirects: 1, refusedUrl: null });
    expect(a.chain).toEqual([{ url: 'https://a.example.com/x', status: 301, location: 'https://c.example.com/1' }]);
    expect(b).toMatchObject({ outcome: 'redirected', redirectTarget: 'https://c.example.com/2' });
    expect(net.urls().filter((url) => url.includes('c.example.com'))).toEqual([]);
    // No robots lookup for the other host inside the call: Task 6b reads it when the target is fetched as a page.
    expect(robots.lookups.map((lookup) => new URL(lookup.url).hostname)).not.toContain('c.example.com');
    // The targets, fetched as pages, are paced as one host.
    await settle(Promise.all([run.fetchPage('https://c.example.com/1'), run.fetchPage('https://c.example.com/2')]));
    const at = (url: string) => net.requests.find((r) => r.url === url)!.at;
    expect(at('https://c.example.com/2') - at('https://c.example.com/1')).toBe(2_000);
    // http and https of one host share one pacing state and one call in flight.
    const [p] = await settle(Promise.all([run.fetchPage('http://d.example.com/p'), run.fetchPage('https://d.example.com/q'), run.fetchPage('http://d.example.com/r')]));
    expect(p).toMatchObject({ outcome: 'response', redirects: 1, finalUrl: 'https://d.example.com/p' });
    expect(at('https://d.example.com/p') - at('http://d.example.com/p')).toBe(0);
    expect(at('https://d.example.com/q') - at('http://d.example.com/p')).toBe(2_000);
    expect(at('http://d.example.com/r') - at('https://d.example.com/q')).toBe(2_000);
    expect(lanes.maxInFlight()).toBe(1);
  });

  test('crawl-pacing-survives-runs', async () => {
    // Task 6a review: pacing state belongs to the crawl fetcher; a paused run's last start and back-off hold for the next run.
    const routes: Record<string, Route> = { 'https://example.com/a': html('slow', 429), 'https://example.com/b': html() };
    const { net, crawl } = crawler(routes, fakeRobots({}).source);
    await settle(crawl.forRun(settings('https://example.com/', { intervalMs: 1_000 })).fetchPage('https://example.com/a'));
    // Paused; resumed as a new run at the floor (the interval is the run's): the back-off still doubles it, from the last start.
    const resumed = crawl.forRun(settings('https://example.com/', { intervalMs: 500 }));
    expect(resumed.politeness.intervalFor('example.com')).toBe(1_000);
    await settle(resumed.fetchPage('https://example.com/b'));
    expect(net.requests[1]!.at - net.requests[0]!.at).toBe(1_000);
  });

  test('crawl-keeps-a-learned-crawl-delay', async () => {
    // Task 6a review: a later lookup with no answer or an unknown outcome keeps the Crawl-delay an earlier one taught;
    // a known answer (a file without one, or no file) changes it.
    let answer: string | RobotsFetchOutcome = 'User-agent: *\nCrawl-delay: 4\n';
    const source: CrawlRobotsSource = { get: (pageUrl) => Promise.resolve(robotsFetch(`${new URL(pageUrl).origin}/robots.txt`, answer === 'server-error' || answer === 'timeout' || answer === 'unavailable' ? answer : 'ok', answer)) };
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 5; i++) routes[`https://example.com/${i}`] = html();
    const { crawl } = crawler(routes, source);
    const run = crawl.forRun(settings('https://example.com/'));
    await settle(run.fetchPage('https://example.com/0'));
    expect(run.politeness.intervalFor('example.com')).toBe(4_000);
    for (const unknown of ['server-error', 'timeout'] as const) {
      answer = unknown;
      expect(await settle(run.fetchPage('https://example.com/1'))).toMatchObject({ robots: { unreachable: true } });
      expect(run.politeness.intervalFor('example.com'), unknown).toBe(4_000);
    }
    answer = 'unavailable';
    await settle(run.fetchPage('https://example.com/2'));
    expect(run.politeness.intervalFor('example.com')).toBe(1_000);
  });

  test('crawl-honours-crawl-delay-and-retry-after', async () => {
    let hits = 0;
    const routes: Record<string, Route> = {
      'https://example.com/a': html(),
      'https://example.com/b': () => (++hits === 1 ? html('busy', 429, { 'content-type': 'text/html', 'retry-after': '20' }) : html()),
      'https://example.com/c': html(),
    };
    const { net, crawl } = crawler(routes, fakeRobots({ 'https://example.com': 'User-agent: frost-crawl\nCrawl-delay: 3\nAllow: /\n' }).source);
    const run = crawl.forRun(settings('https://example.com/', { intervalMs: 1_000 }));
    expect(await settle(run.fetchPage('https://example.com/a'))).toMatchObject({ outcome: 'response', robots: { crawlDelayMs: 3_000 } });
    expect(run.politeness.intervalFor('example.com')).toBe(3_000);
    const b = await settle(run.fetchPage('https://example.com/b'));
    expect(b).toMatchObject({ outcome: 'response', status: 429, headers: { 'retry-after': '20' }, slowDown: false });
    await settle(run.fetchPage('https://example.com/c'));
    const at = (url: string) => net.requests.find((r) => r.url === url)!.at;
    expect(at('https://example.com/b') - at('https://example.com/a')).toBe(3_000);
    // Retry-After (20 s) beats the backed-off interval (6 s).
    expect(at('https://example.com/c') - at('https://example.com/b')).toBe(20_000);
  });

  test('crawl-backs-off-and-pauses', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 6; i++) routes[`https://example.com/${i}`] = html('slow down', i % 2 === 0 ? 503 : 429);
    const { net, crawl } = crawler(routes, fakeRobots({ 'https://example.com': 'unavailable' }).source);
    const run = crawl.forRun(settings('https://example.com/', { intervalMs: 1_000 }));
    const results = [];
    for (let i = 0; i < CRAWL_LIMITS.backoffAfter; i++) results.push(await settle(run.fetchPage(`https://example.com/${i}`)));
    expect(results.map((r) => r.slowDown)).toEqual([false, false, false, false, true]);
    const starts = net.requests.map((r) => r.at);
    expect(starts.slice(1).map((at, i) => at - starts[i]!)).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  test('crawl-honours-robots', async () => {
    const routes: Record<string, Route> = { 'https://example.com/public': html(), 'https://example.com/private/x': html(), 'https://shop.example.com/a': html(), 'https://down.example.com/a': html(), 'https://none.example.com/a': html() };
    const robots = fakeRobots({
      'https://example.com': 'User-agent: *\nDisallow: /private\n\nUser-agent: googlebot\nDisallow: /public\n',
      // Our own group blocks everything although `*` allows it.
      'https://shop.example.com': 'User-agent: *\nAllow: /\n\nUser-agent: frost-crawl\nDisallow: /\n',
      'https://down.example.com': 'server-error',
      'https://none.example.com': 'unavailable',
    });
    const { net, crawl } = crawler(routes, robots.source);
    const run = crawl.forRun(settings('https://example.com/', { scope: 'site' }));
    expect(await settle(run.fetchPage('https://example.com/private/x'))).toMatchObject({ outcome: 'blocked-by-robots', status: null, robots: { crawl: 'blocked', googlebot: 'allowed', unreachable: false } });
    expect(await settle(run.fetchPage('https://shop.example.com/a'))).toMatchObject({ outcome: 'blocked-by-robots', robots: { crawl: 'blocked' } });
    expect(net.urls()).toEqual([]);
    expect(await settle(run.fetchPage('https://example.com/public'))).toMatchObject({ outcome: 'response', robots: { crawl: 'allowed', googlebot: 'blocked' } });
    // robots.txt the crawl cannot read: crawled at the default interval, flagged (the start-origin rule).
    const down = await settle(run.fetchPage('https://down.example.com/a'));
    expect(down).toMatchObject({ outcome: 'response', robots: { crawl: 'unknown', googlebot: 'unknown', unreachable: true, crawlDelayMs: null } });
    expect(down.robots.fetch?.outcome).toBe('server-error');
    expect(run.politeness.intervalFor('down.example.com')).toBe(1_000);
    // No robots.txt: everything allowed.
    expect(await settle(run.fetchPage('https://none.example.com/a'))).toMatchObject({ outcome: 'response', robots: { crawl: 'allowed', googlebot: 'allowed', unreachable: false } });
    expect(net.urls()).toEqual(['https://example.com/public', 'https://down.example.com/a', 'https://none.example.com/a']);
    // A public start's lookups are the shared ones (no exact-origin rule).
    expect(robots.lookups.every((lookup) => !lookup.exactOrigin)).toBe(true);
  });

  test('crawl-robots-matches-the-bare-token', async () => {
    const tokens: string[] = [];
    const texts: string[] = [];
    const parse = (text: string): CrawlRobotsRules => {
      texts.push(text);
      const rules = crawlRobotsRules(text);
      return {
        crawlDelayMs: rules.crawlDelayMs,
        allowed: (url, token) => {
          tokens.push(token);
          return rules.allowed(url, token);
        },
      };
    };
    const routes: Record<string, Route> = { 'https://a.example.com/x': html(), 'https://b.example.com/x': html() };
    const robots = fakeRobots({
      // A mozilla group is not the crawl's, though the header sent starts with Mozilla.
      'https://a.example.com': 'User-agent: *\nAllow: /\n\nUser-agent: mozilla\nDisallow: /\nCrawl-delay: 9\n',
      'https://b.example.com': 'User-agent: frost-crawl\nDisallow: /\n',
    });
    const { net, crawl } = crawler(routes, robots.source, parse);
    const run = crawl.forRun(settings('https://a.example.com/', { scope: 'site' }));
    expect(await settle(run.fetchPage('https://a.example.com/x'))).toMatchObject({ outcome: 'response', robots: { crawl: 'allowed', crawlDelayMs: null } });
    expect(net.requests[0]!.userAgent).toBe(SENT_UA);
    expect(await settle(run.fetchPage('https://b.example.com/x'))).toMatchObject({ outcome: 'blocked-by-robots' });
    expect(net.urls()).toEqual(['https://a.example.com/x']);
    expect(texts).toHaveLength(2);
    expect(new Set(tokens)).toEqual(new Set([CRAWL_ROBOTS_TOKEN, 'googlebot']));
    expect(tokens).not.toContain(SENT_UA);
    expect(run.politeness.intervalFor('a.example.com')).toBe(1_000);
  });

  test('crawl-private-start-is-origin-only', async () => {
    const net = fakeNet();
    const routes: Record<string, Route> = {
      'http://127.0.0.1:3000/robots.txt': html('User-agent: *\nAllow: /\n', 200, { 'content-type': 'text/plain' }),
      'http://127.0.0.1:3000/': html(),
      'http://127.0.0.1:3000/app': html(),
      'http://127.0.0.1:9229/json': html('{}'),
      'http://192.168.1.20:3000/': html(),
    };
    const hop = net.hop(routes);
    const lanes = lane(hop);
    const robots = createRobotsFetcher({ hop, fetcher: createBoundedFetcher({ hop, resolve }) });
    const crawl = createCrawlFetcher({ fetcher: lanes.fetcher, robots, userAgent: () => BROWSE_UA });
    const run = crawl.forRun(settings('http://127.0.0.1:3000/'));
    expect(run.scope.privateStart).toBe(true);
    expect(await settle(run.fetchPage('http://127.0.0.1:3000/'))).toMatchObject({ outcome: 'response' });
    expect(await settle(run.fetchPage('http://127.0.0.1:3000/app'))).toMatchObject({ outcome: 'response' });
    // Another port, another private host, another scheme: out of scope, never requested.
    for (const url of ['http://127.0.0.1:9229/json', 'http://192.168.1.20:3000/', 'https://127.0.0.1:3000/', 'http://localhost:3000/']) {
      expect(await settle(run.fetchPage(url)), url).toMatchObject({ outcome: 'out-of-scope', status: null });
    }
    expect(net.urls().filter((url) => !url.startsWith('http://127.0.0.1:3000/'))).toEqual([]);
    // Every page request is made for the start URL.
    expect(lanes.calls.map((call) => call.page)).toEqual(['http://127.0.0.1:3000/', 'http://127.0.0.1:3000/']);
    // robots.txt was asked once, with the exact-origin rule (cached apart from the sidebar's).
    expect(net.urls().filter((url) => url.endsWith('/robots.txt'))).toEqual(['http://127.0.0.1:3000/robots.txt']);
    expect(robots.peek('http://127.0.0.1:3000/', { exactOrigin: true })).toMatchObject({ outcome: 'ok' });
    expect(robots.peek('http://127.0.0.1:3000/')).toBeUndefined();
  });

  test('crawl-redirects-pass-the-crawl-policy', async () => {
    const routes: Record<string, Route> = {
      'https://example.com/a': redirect('/private/x', 301),
      'https://example.com/private/x': html(),
      'https://example.com/b': redirect('https://elsewhere.example.net/', 302),
      'https://elsewhere.example.net/': html(),
      'https://example.com/c': redirect('http://10.0.0.5/', 302),
      'https://example.com/c2': redirect('https://intranet.example.com/', 302),
      'https://example.com/d': redirect('/excluded/y', 302),
      'https://example.com/excluded/y': html(),
      'https://example.com/port': redirect('https://example.com:9443/', 302),
      'https://example.com:9443/': html(),
      'https://example.com/e': redirect('/ok', 301),
      'https://example.com/ok': html(),
    };
    const robots = fakeRobots({ 'https://example.com': 'User-agent: *\nDisallow: /private\n' });
    const { net, crawl } = crawler(routes, robots.source);
    const run = crawl.forRun(settings('https://example.com/', { exclude: ['/excluded'] }));
    const fetchAll = async (path: string) => settle(run.fetchPage(`https://example.com${path}`));
    expect(await fetchAll('/a')).toMatchObject({ outcome: 'blocked-by-robots', status: 301, finalUrl: 'https://example.com/a', refusedUrl: 'https://example.com/private/x', redirects: 0 });
    expect(await fetchAll('/b')).toMatchObject({ outcome: 'out-of-scope', status: 302, refusedUrl: 'https://elsewhere.example.net/' });
    // The fetcher's own address rule (a private literal; a name resolving to a private address).
    expect(await fetchAll('/c')).toMatchObject({ outcome: 'private-redirect', status: 302 });
    expect(await fetchAll('/c2')).toMatchObject({ outcome: 'private-redirect', status: 302 });
    expect(await fetchAll('/d')).toMatchObject({ outcome: 'out-of-scope', refusedUrl: 'https://example.com/excluded/y' });
    // A port the host scope does not allow: out of scope, never requested.
    expect(await fetchAll('/port')).toMatchObject({ outcome: 'out-of-scope', refusedUrl: 'https://example.com:9443/' });
    // An in-scope, allowed hop is followed in the same call.
    expect(await fetchAll('/e')).toMatchObject({ outcome: 'response', status: 200, redirects: 1, finalUrl: 'https://example.com/ok', refusedUrl: null });
    expect(net.urls()).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/c2', 'https://example.com/d', 'https://example.com/port', 'https://example.com/e', 'https://example.com/ok']);
    // Scope is decided before robots: no robots lookup for the out-of-scope host.
    expect(robots.lookups.map((lookup) => new URL(lookup.url).origin)).not.toContain('https://elsewhere.example.net');

    // A private start: 127.0.0.1:3000 → 127.0.0.1:9229 is refused with no request to :9229 at all, not even /robots.txt.
    const localNet = fakeNet();
    const localHop = localNet.hop({
      'http://127.0.0.1:3000/robots.txt': html('User-agent: *\nAllow: /\n', 200, { 'content-type': 'text/plain' }),
      'http://127.0.0.1:3000/x': redirect('http://127.0.0.1:9229/json', 302),
      'http://127.0.0.1:3000/y': redirect('http://192.168.1.5:3000/', 302),
      'http://127.0.0.1:3000/z': redirect('https://example.com/', 302),
      'http://127.0.0.1:9229/robots.txt': html('User-agent: *\nAllow: /\n'),
      'http://127.0.0.1:9229/json': html('{}'),
    });
    const localLane = lane(localHop);
    const localRobots = createRobotsFetcher({ hop: localHop, fetcher: createBoundedFetcher({ hop: localHop, resolve }) });
    const local = createCrawlFetcher({ fetcher: localLane.fetcher, robots: localRobots, userAgent: () => BROWSE_UA }).forRun(settings('http://127.0.0.1:3000/'));
    expect(await settle(local.fetchPage('http://127.0.0.1:3000/x'))).toMatchObject({ outcome: 'private-redirect', status: 302, refusedUrl: 'http://127.0.0.1:9229/json' });
    expect(await settle(local.fetchPage('http://127.0.0.1:3000/y'))).toMatchObject({ outcome: 'private-redirect', refusedUrl: 'http://192.168.1.5:3000/' });
    expect(await settle(local.fetchPage('http://127.0.0.1:3000/z'))).toMatchObject({ outcome: 'private-redirect', refusedUrl: 'https://example.com/' });
    expect(localNet.urls().filter((url) => url.includes(':9229') || url.includes('192.168.') || url.includes('example.com'))).toEqual([]);
  });

  test('crawl-robots-fetch-is-origin-only', async () => {
    const net = fakeNet();
    const hop = net.hop({
      'http://127.0.0.1:3000/robots.txt': redirect('http://127.0.0.1:9229/robots.txt', 302),
      'http://127.0.0.1:9229/robots.txt': html('User-agent: *\nDisallow: /\n', 200, { 'content-type': 'text/plain' }),
      'http://127.0.0.1:3000/page': html(),
    });
    const robots = createRobotsFetcher({ hop, fetcher: createBoundedFetcher({ hop, resolve }) });
    // The sidebar's lookup (no rule) behaves as before: a private page's robots.txt may redirect to another private port.
    expect(await settle(robots.get('http://127.0.0.1:3000/page'))).toMatchObject({ outcome: 'ok', finalUrl: 'http://127.0.0.1:9229/robots.txt' });
    expect(net.urls()).toEqual(['http://127.0.0.1:3000/robots.txt', 'http://127.0.0.1:9229/robots.txt']);
    // With the exact-origin rule: not followed, no request to :9229, `private-redirect` (no robots.txt), never `unreachable`;
    // the answer cached for the sidebar is not reused.
    const exact = await settle(robots.get('http://127.0.0.1:3000/page', { exactOrigin: true }));
    expect(exact).toMatchObject({ outcome: 'private-redirect', status: 302, redirects: 0 });
    expect(net.urls()).toEqual(['http://127.0.0.1:3000/robots.txt', 'http://127.0.0.1:9229/robots.txt', 'http://127.0.0.1:3000/robots.txt']);
    expect(robots.size()).toBe(2);
    expect(await settle(robots.get('http://127.0.0.1:3000/other', { exactOrigin: true }))).toBe(exact);
    expect(robots.peek('http://127.0.0.1:3000/', { exactOrigin: true })).toBe(exact);
    expect(robots.peek('http://127.0.0.1:3000/')).toMatchObject({ outcome: 'ok' });

    // Through the crawl: the shared fetcher already holds the followed answer (Disallow: /), the crawl is not blocked by it.
    const lanes = lane(hop);
    const run = createCrawlFetcher({ fetcher: lanes.fetcher, robots, userAgent: () => BROWSE_UA }).forRun(settings('http://127.0.0.1:3000/'));
    const page = await settle(run.fetchPage('http://127.0.0.1:3000/page'));
    expect(page).toMatchObject({ outcome: 'response', robots: { crawl: 'allowed', unreachable: false } });
    expect(page.robots.fetch?.outcome).toBe('private-redirect');

    // A fresh fetcher: the crawl's own lookup never reaches :9229.
    const fresh = fakeNet();
    const freshHop = fresh.hop({ 'http://127.0.0.1:3000/robots.txt': redirect('http://127.0.0.1:9229/robots.txt', 302), 'http://127.0.0.1:9229/robots.txt': html('User-agent: *\nDisallow: /\n'), 'http://127.0.0.1:3000/page': html() });
    const freshRobots = createRobotsFetcher({ hop: freshHop, fetcher: createBoundedFetcher({ hop: freshHop, resolve }) });
    const freshRun = createCrawlFetcher({ fetcher: lane(freshHop).fetcher, robots: freshRobots, userAgent: () => BROWSE_UA }).forRun(settings('http://127.0.0.1:3000/'));
    expect(await settle(freshRun.fetchPage('http://127.0.0.1:3000/page'))).toMatchObject({ outcome: 'response' });
    expect(fresh.urls()).toEqual(['http://127.0.0.1:3000/robots.txt', 'http://127.0.0.1:3000/page']);
    // Another scheme of the same host is another origin too.
    const scheme = fakeNet();
    const schemeHop = scheme.hop({ 'http://127.0.0.1:3000/robots.txt': redirect('https://127.0.0.1:3000/robots.txt', 301) });
    const schemeRobots = createRobotsFetcher({ hop: schemeHop, fetcher: createBoundedFetcher({ hop: schemeHop, resolve }) });
    expect(await settle(schemeRobots.get('http://127.0.0.1:3000/', { exactOrigin: true }))).toMatchObject({ outcome: 'private-redirect' });
    expect(scheme.urls()).toEqual(['http://127.0.0.1:3000/robots.txt']);
  });

  test('crawl-redirect-robots-timeout-refuses-the-hop', async () => {
    const limit = ROBOTS_FETCH_LIMITS.timeoutMs + CRAWL_ROBOTS_HOOK_MARGIN_MS;
    // Each case is a same-host hop from http to https (another origin, so another robots.txt; one host, so followed
    // inside the call). The first hop takes 5 s: with the hook's wait counted, the page's own 10 s deadline would pass.
    const slowRedirect = (to: string): Route => () => new Promise<HopResult>((resolve) => setTimeout(() => resolve(redirect(to, 302)), 5_000));
    const routes: Record<string, Route> = {};
    const answers: Record<string, string | RobotsFetchOutcome | 'never' | { after: number; text: string }> = {};
    const hostCase = (name: string, answer: string | RobotsFetchOutcome | 'never' | { after: number; text: string }, slow = true) => {
      routes[`http://${name}.example.com/a`] = slow ? slowRedirect(`https://${name}.example.com/a`) : redirect(`https://${name}.example.com/a`, 302);
      routes[`https://${name}.example.com/a`] = html();
      answers[`http://${name}.example.com`] = 'User-agent: *\nAllow: /\n';
      answers[`https://${name}.example.com`] = answer;
    };
    hostCase('t', 'timeout');
    hostCase('n', 'never');
    hostCase('late', { after: limit - 1, text: 'User-agent: *\nAllow: /\n' });
    const unknown = ROBOTS_UNKNOWN_OUTCOMES.filter((outcome) => outcome !== 'timeout');
    expect(unknown).toEqual(['server-error', 'unreachable', 'bad-redirect', 'no-location']);
    for (const outcome of unknown) hostCase(outcome, outcome, false);
    const robots = fakeRobots(answers);
    const { net, crawl } = crawler(routes, robots.source);
    const run = crawl.forRun(settings('https://www.example.com/', { scope: 'site' }));
    // An answered `timeout`: refused, `robots-timeout`.
    expect(await settle(run.fetchPage('http://t.example.com/a'))).toMatchObject({ outcome: 'robots-timeout', status: 302, refusedUrl: 'https://t.example.com/a', redirectTarget: null });
    // No answer by the hook's limit: refused at the limit, `robots-timeout`, never a page `timeout`.
    const started = Date.now();
    const never = await settle(run.fetchPage('http://n.example.com/a'));
    expect(never).toMatchObject({ outcome: 'robots-timeout', refusedUrl: 'https://n.example.com/a' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000 + limit);
    // An answer just inside the limit allowing it: followed, the page answered (the hook's wait is not the page's deadline).
    expect(await settle(run.fetchPage('http://late.example.com/a'))).toMatchObject({ outcome: 'response', status: 200, finalUrl: 'https://late.example.com/a' });
    expect(net.urls()).not.toContain('https://t.example.com/a');
    expect(net.urls()).not.toContain('https://n.example.com/a');
    // Every other unknown outcome, each its own case: the start-origin rule (followed, flagged robots-txt-unreachable).
    for (const outcome of unknown) {
      const page = await settle(run.fetchPage(`http://${outcome}.example.com/a`));
      expect(page, outcome).toMatchObject({ outcome: 'response', status: 200, finalUrl: `https://${outcome}.example.com/a`, robots: { crawl: 'unknown', unreachable: true } });
      expect(page.robots.fetch?.outcome, outcome).toBe(outcome);
      expect(net.urls(), outcome).toContain(`https://${outcome}.example.com/a`);
    }
  });

  test('crawl-keeps-the-headers-it-needs', async () => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, googlebot: nofollow', link: '</c>; rel="canonical"', 'retry-after': '5', 'set-cookie': 'sid=secret', server: 'test' };
    const raw = ['Content-Type', 'text/html; charset=utf-8', 'X-Robots-Tag', 'noindex', 'X-Robots-Tag', 'googlebot: nofollow', 'Link', '</c>; rel="canonical"', 'Retry-After', '5', 'Set-Cookie', 'sid=secret', 'Server', 'test'];
    const { lanes, crawl } = crawler({ 'https://example.com/a': html('<p>hello</p>', 200, headers, raw) }, fakeRobots({}).source);
    const page = await settle(crawl.forRun(settings('https://example.com/')).fetchPage('https://example.com/a'));
    expect(page.headers).toEqual({ 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex\ngooglebot: nofollow', link: '</c>; rel="canonical"', 'retry-after': '5' });
    expect(page.xRobotsTag).toEqual(['noindex', 'googlebot: nofollow']);
    expect(new TextDecoder().decode(page.body)).toBe('<p>hello</p>');
    expect(page).toMatchObject({ bytes: 12, truncated: false });
    expect(lanes.calls[0]).toMatchObject({ keepHeaders: [...CRAWL_KEEP_HEADERS], separateHeaders: [...CRAWL_SEPARATE_HEADERS], maxBytes: CRAWL_LIMITS.maxBodyBytes });
    // Every status's body is read (a 404 page is audited too).
    expect(lanes.calls[0]!.readBody?.(404) ?? true).toBe(true);
  });

  test('crawl-user-agent-identifies', async () => {
    const routes: Record<string, Route> = { 'https://example.com/a': html(), 'https://example.com/b': html() };
    const net = fakeNet();
    const lanes = lane(net.hop(routes));
    let ua = BROWSE_UA;
    const run = createCrawlFetcher({ fetcher: lanes.fetcher, robots: fakeRobots({}).source, userAgent: () => ua }).forRun(settings('https://example.com/start'));
    await settle(run.fetchPage('https://example.com/a'));
    // A browse user agent already carrying the token is not given it twice.
    ua = SENT_UA;
    await settle(run.fetchPage('https://example.com/b'));
    expect(net.requests.map((request) => request.userAgent)).toEqual([SENT_UA, SENT_UA]);
    expect(net.requests.map((request) => request.accept)).toEqual([SERVED_ACCEPT, SERVED_ACCEPT]);
    expect(lanes.calls.map((call) => call.page)).toEqual(['https://example.com/start', 'https://example.com/start']);
    expect(SENT_UA.endsWith(' frost-crawl/1')).toBe(true);
    expect(SENT_UA).not.toMatch(/bot\b/i);
  });

  test('crawl-fetch-abort', async () => {
    const { net, crawl } = crawler({ 'https://example.com/a': html(), 'https://example.com/b': html() }, fakeRobots({}).source);
    const run = crawl.forRun(settings('https://example.com/', { intervalMs: 4_000 }));
    await settle(run.fetchPage('https://example.com/a'));
    const controller = new AbortController();
    const waiting = run.fetchPage('https://example.com/b', controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await settle(waiting)).toMatchObject({ outcome: 'aborted', status: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(net.urls()).toEqual(['https://example.com/a']);
  });
});
