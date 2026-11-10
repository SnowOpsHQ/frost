// Spec: specs/site-crawl.spec.ts (CRAWL_LIMITS, CRAWL_RUN_STATES, CRAWL_RUN_REASONS, CRAWL_PAGE_OUTCOMES, CRAWL_SLOW_DOWN_MESSAGE,
// CRAWL_REFUSALS), specs/site-crawl.schema.ts (CrawlSettingsSchema, CrawlPageRowSchema, CrawlPageJobSchema, CrawlPageAnalysisSchema),
// specs/seo-checks.spec.ts (SITEMAP_LIMITS), specs/seo-limits.spec.ts (SNAPSHOT_LIMITS.maxLinks)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit; crawl-pacing-survives-a-restart); plan docs/plans/phase-12-big-bets.md
// Decision 3 (K-B3), Decision 6 and Task 6b
//
// Every site here is a fake page fetcher (no network, no timer); the frontier and the rows are the real session database.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import { SITEMAP_LIMITS } from '@app/specs/seo-checks.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CrawlPageRowSchema, type CrawlPageAnalysis, type CrawlPageJob } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS, CRAWL_RUN_NOTES, CRAWL_SLOW_DOWN_MESSAGE } from '@app/specs/site-crawl.spec';
import { parseCrawlRobots, parseCrawlSitemap, type CrawlPageResult } from '../analyse';
import { createCrawler, type CrawlerDeps, type CrawlMemory } from '../crawler';
import { createCrawlFetcher, type CrawlRobotsSource } from '../fetch';
import { createCrawlService, type CrawlService } from '../service';
import { createPacing, type CrawlClock, type Pacing } from '../politeness';
import { createSitemapSeeder } from '../sitemaps';
import { fakeClock, fakeFetcher, htmlPage, inProcessAnalyse, settingsFor, tempStore, timerClock, type FakePage } from './run-fakes';

const HOME = 'https://example.com/';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(site: Record<string, FakePage> | ((url: string) => FakePage | undefined), { pacing, ...deps }: Partial<CrawlerDeps> & { projectLive?: (id: string) => Promise<boolean>; pacing?: Pacing } = {}) {
  const db = tempStore();
  cleanups.push(db.close);
  const now = fakeClock();
  const pages = typeof site === 'function' ? site : (url: string) => site[url];
  const fetcher = fakeFetcher(pages, now, pacing ? { pacing } : {});
  const analyse = vi.fn(deps.analyse ?? inProcessAnalyse);
  const projectLive = deps.projectLive ?? (async () => true);
  const makeService = (): CrawlService => {
    const crawler = createCrawler({ repo: db.store.siteCrawl, fetcher, projectLive, now, ...deps, analyse });
    return createCrawlService({ repo: db.store.siteCrawl, crawler: () => crawler, isOpen: () => true, projectLive, now, log: () => undefined });
  };
  const service = makeService();
  const repo = db.store.siteCrawl;
  const rows = async (runId: string) => repo.pagesOf(runId, { limit: 20_000, offset: 0 });
  return { ...db, fetcher, analyse, service, makeService, repo, rows };
}

async function started(service: CrawlService, settings: ReturnType<typeof settingsFor>, projectId: string | null = null): Promise<string> {
  const answer = await service.start({ settings, projectId });
  if (answer.status !== 'started') throw new Error(`not started: ${JSON.stringify(answer)}`);
  return answer.runId;
}

/** A chain: each page links the next one. */
const chain = (n: number): Record<string, FakePage> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${HOME}p${i}`, htmlPage(`Page ${i}`, i + 1 < n ? [`/p${i + 1}`] : [])]));

describe('crawl runs', () => {
  test('crawl-respects-max-pages-and-depth', async () => {
    // Depth: a chain of 16 pages from the start (depth 0): pages at depth 0–10 are recorded, the rest never fetched.
    const deep = setup(chain(16));
    const runId = await started(deep.service, settingsFor(`${HOME}p0`));
    await deep.service.idle();
    expect(deep.fetcher.fetched).toEqual(Array.from({ length: CRAWL_LIMITS.maxDepth + 1 }, (_, i) => `${HOME}p${i}`));
    expect((await deep.rows(runId)).map((row) => row.depth)).toEqual(Array.from({ length: CRAWL_LIMITS.maxDepth + 1 }, (_, i) => i));
    expect(await deep.repo.getRun(runId)).toMatchObject({ state: 'done', reason: null, counts: { pages: CRAWL_LIMITS.maxDepth + 1, queued: 0 } });

    // Max pages: a start linking 30 pages, `maxPages` 5: five rows, then done (`max-pages`) with URLs still queued.
    const wide = setup({ [HOME]: htmlPage('Home', Array.from({ length: 30 }, (_, i) => `/w${i}`)), ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${HOME}w${i}`, htmlPage(`W${i}`)])) });
    const wideRun = await started(wide.service, settingsFor(HOME, { maxPages: 5 }));
    await wide.service.idle();
    expect(wide.fetcher.fetched).toHaveLength(5);
    expect(await wide.rows(wideRun)).toHaveLength(5);
    const run = await wide.repo.getRun(wideRun);
    expect(run).toMatchObject({ state: 'done', reason: 'max-pages', counts: { pages: 5, queued: 26 } });
    expect(run!.finishedAt).not.toBeNull();
  });

  test('crawl-frontier-dedupes-percent-encoded-urls', async () => {
    // Council review, item 6: a link to `/%61bout` and one to `/about` are one frontier entry, fetched once, under the
    // normal form (RFC 3986 §6.2.2: unreserved escapes decoded) that the request and the scope's prefixes also use.
    const t = setup({ [HOME]: htmlPage('Home', ['/%61bout', '/about', '/%41bout']), [`${HOME}about`]: htmlPage('About'), [`${HOME}About`]: htmlPage('About, capital') });
    const runId = await started(t.service, settingsFor(HOME));
    await t.service.idle();
    expect(t.count('SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ?', runId)).toBe(3);
    expect(await t.repo.frontierEntry(runId, `${HOME}about`)).toMatchObject({ inlinks: 1 });
    expect(await t.repo.frontierEntry(runId, `${HOME}%61bout`)).toBeNull();
    expect([...t.fetcher.fetched].sort()).toEqual([HOME, `${HOME}About`, `${HOME}about`]);
  });

  test('crawl-html-only', async () => {
    const site: Record<string, FakePage> = {
      [HOME]: htmlPage('Home', ['/guide.pdf', '/logo.png', '/data.json', '/plain']),
      [`${HOME}guide.pdf`]: { html: '%PDF-1.7 <a href="/hidden">x</a>', contentType: 'application/pdf' },
      [`${HOME}logo.png`]: { html: 'PNG', contentType: 'image/png' },
      [`${HOME}data.json`]: { html: '{"a":"<a href=/hidden2>"}', contentType: 'application/json' },
      // No media type: read as HTML, as the sidebar's served audit reads it.
      [`${HOME}plain`]: { ...(htmlPage('Plain') as { html: string }), contentType: null },
    };
    const t = setup(site);
    const runId = await started(t.service, settingsFor(HOME));
    await t.service.idle();
    const rows = new Map((await t.rows(runId)).map((row) => [row.url, row]));
    for (const url of [`${HOME}guide.pdf`, `${HOME}logo.png`, `${HOME}data.json`]) {
      expect(rows.get(url), url).toMatchObject({ outcome: 'not-html', status: 200, title: null, score: null, findings: [], indexable: null, wordCount: null });
      expect(CrawlPageRowSchema.safeParse(rows.get(url)).success).toBe(true);
    }
    expect(rows.get(`${HOME}guide.pdf`)!.contentType).toBe('application/pdf');
    expect(rows.get(`${HOME}plain`)).toMatchObject({ outcome: 'crawled', title: 'Plain' });
    // Only HTML went to the worker; nothing in the other bodies was read for links.
    expect(t.analyse.mock.calls.map(([job]) => job.url).sort()).toEqual([HOME, `${HOME}plain`]);
    expect(t.fetcher.fetched).not.toContain(`${HOME}hidden`);
    expect(rows.get(HOME)).toMatchObject({ outcome: 'crawled', status: 200, title: 'Home', indexable: true, outlinks: 4, linkTotal: 4, linksCut: false });
    expect(rows.get(HOME)!.score).toBeGreaterThan(0);
  });

  test('crawl-resumes-from-frontier', async () => {
    const t = setup(chain(6));
    const held = t.fetcher.hold(`${HOME}p3`);
    const runId = await started(t.service, settingsFor(`${HOME}p0`));
    await held.started;
    // Quitting while p3 is being fetched: the run is paused (`quit`), p3 records nothing and stays queued.
    t.service.quit();
    await t.service.idle();
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'quit' });
    const before = (await t.rows(runId)).map((row) => row.url);
    expect(before).toEqual([`${HOME}p0`, `${HOME}p1`, `${HOME}p2`]);
    expect(await t.repo.frontierEntry(runId, `${HOME}p3`)).toMatchObject({ state: 'queued' });
    // A restart: a new service on the same database. Resume continues from the frontier, without fetching a recorded page again.
    t.fetcher.fetched.length = 0;
    const again = t.makeService();
    await again.startup();
    expect(await again.resume(runId)).toEqual({ status: 'resumed', runId });
    await again.idle();
    expect(t.fetcher.fetched).toEqual([`${HOME}p3`, `${HOME}p4`, `${HOME}p5`]);
    expect((await t.rows(runId)).map((row) => row.url)).toEqual(Array.from({ length: 6 }, (_, i) => `${HOME}p${i}`));
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'done', counts: { pages: 6, queued: 0 } });
  });

  test('crawl-pause-mid-page-replays-its-completion', async () => {
    // Council review, item 3: a Pause that lands while a page's row is written (`putPage`) leaves the page queued (its
    // links not yet discovered), so Resume fetches it again and discovers `/child`. The replay is idempotent: one row, its
    // links stored once, the run's counts equal to its rows, and each page's discoveries counted once (no inlink twice).
    const site: Record<string, FakePage> = { [HOME]: htmlPage('Home', ['/child', '/other']), [`${HOME}child`]: htmlPage('Child', ['/']), [`${HOME}other`]: htmlPage('Other', ['/child']) };
    const t = setup(site);
    let service!: CrawlService;
    /** Pauses the run once, right after the named repository write for `url` returns. */
    let pauseAfter: { readonly method: 'putPage' | 'enqueue'; readonly url: string } | null = { method: 'putPage', url: HOME };
    const pausing = new Proxy(t.repo, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          const hit =
            pauseAfter !== null &&
            key === pauseAfter.method &&
            (key === 'putPage' ? (args[0] as { url: string }).url === pauseAfter.url : (args[1] as { url: string; source: string }[]).some((entry) => entry.url === pauseAfter!.url && entry.source === 'link'));
          if (hit) {
            pauseAfter = null;
            void service.pause(key === 'putPage' ? (args[0] as { runId: string }).runId : (args[0] as string));
          }
          return result;
        };
      },
    });
    const crawler = createCrawler({ repo: pausing, fetcher: t.fetcher, analyse: inProcessAnalyse, projectLive: async () => true, now: fakeClock() });
    service = createCrawlService({ repo: t.repo, crawler: () => crawler, isOpen: () => true, projectLive: async () => true, log: () => undefined });

    const runId = await started(service, settingsFor(HOME));
    await service.idle();
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'user' });
    // The row is written, but the page's completion (its discoveries, its frontier entry) is not: it stays queued.
    expect(await t.repo.frontierEntry(runId, HOME)).toMatchObject({ state: 'queued' });
    expect(await t.repo.frontierEntry(runId, `${HOME}child`)).toBeNull();

    // Resume replays the page: fetched again, its links discovered, `/child` fetched.
    expect(await service.resume(runId)).toEqual({ status: 'resumed', runId });
    await service.idle();
    expect(t.fetcher.fetched).toEqual([HOME, HOME, `${HOME}child`, `${HOME}other`]);
    expect(t.count('SELECT count(*) AS n FROM crawl_pages WHERE run_id = ? AND url = ?', runId, HOME)).toBe(1);
    expect(t.count('SELECT count(*) AS n FROM crawl_links WHERE run_id = ?', runId)).toBe(4);
    // Inlinks: `/child` from the start and from `/other`; the start from `/child`; each discovering page once.
    expect(await t.repo.frontierEntry(runId, `${HOME}child`)).toMatchObject({ inlinks: 2, state: 'done' });
    expect(await t.repo.frontierEntry(runId, `${HOME}other`)).toMatchObject({ inlinks: 1, state: 'done' });
    expect(await t.repo.frontierEntry(runId, HOME)).toMatchObject({ inlinks: 1, state: 'done' });
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'done', counts: { pages: 3, queued: 0, refused: 0, failed: 0 } });
    expect((await t.repo.getRun(runId))!.counts.bytes).toBe((await t.rows(runId)).reduce((sum, row) => sum + row.bytes, 0));

    // A Pause that lands while the discoveries are written: they and the entry's `done` are one write, so the page is
    // complete and never replayed (its links are never discovered twice).
    t.fetcher.fetched.length = 0;
    pauseAfter = { method: 'enqueue', url: `${HOME}child` };
    const second = await started(service, settingsFor(HOME));
    await service.idle();
    expect(await t.repo.getRun(second)).toMatchObject({ state: 'paused', reason: 'user' });
    expect(await t.repo.frontierEntry(second, HOME)).toMatchObject({ state: 'done' });
    expect(await service.resume(second)).toEqual({ status: 'resumed', runId: second });
    await service.idle();
    expect(t.fetcher.fetched).toEqual([HOME, `${HOME}child`, `${HOME}other`]);
    expect(await t.repo.frontierEntry(second, `${HOME}child`)).toMatchObject({ inlinks: 2 });
    expect(await t.repo.getRun(second)).toMatchObject({ state: 'done', counts: { pages: 3 } });
  });

  test('crawl-pause-and-resume-by-the-user', async () => {
    const t = setup(chain(4));
    const held = t.fetcher.hold(`${HOME}p1`);
    const runId = await started(t.service, settingsFor(`${HOME}p0`));
    await held.started;
    expect(await t.service.pause(runId)).toEqual({ status: 'ok' });
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'user' });
    expect((await t.service.status()).activeRunId).toBeNull();
    // Paused stays paused: nothing runs until Resume.
    expect(await t.service.pause(runId)).toEqual({ status: 'refused', reason: 'not-running' });
    expect(await t.service.resume(runId)).toEqual({ status: 'resumed', runId });
    await t.service.idle();
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'done', counts: { pages: 4 } });
    // Cancel answers for a running or paused run only.
    expect(await t.service.cancel(runId)).toEqual({ status: 'refused', reason: 'not-running' });
  });

  test('crawl-never-resumes-on-start', async () => {
    const t = setup(chain(5));
    const held = t.fetcher.hold(`${HOME}p2`);
    const runId = await started(t.service, settingsFor(`${HOME}p0`));
    await held.started;
    await t.service.pause(runId);
    t.fetcher.fetched.length = 0;
    // A restart: start-up recovery and a status read, then another run started and finished.
    const again = t.makeService();
    await again.startup();
    expect((await again.status()).activeRunId).toBeNull();
    expect(t.fetcher.fetched).toEqual([]);
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'user' });
    const second = await started(again, settingsFor('https://example.com/other'));
    await again.idle();
    // Only the new run fetched; the paused one is still paused, its frontier untouched.
    expect(t.fetcher.fetched).toEqual(['https://example.com/other']);
    expect(second).not.toBe(runId);
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'user' });
    // p2 (its fetch stopped by the pause) is still queued, never fetched again.
    expect(await t.repo.queuedCount(runId)).toBe(1);
    expect(await t.repo.frontierEntry(runId, `${HOME}p2`)).toMatchObject({ state: 'queued' });
  });

  test('crawl-running-at-start-becomes-paused', async () => {
    const t = setup(chain(3));
    // A crash left one run `running` and one `queued`.
    const crashed = await t.repo.createRun({ projectId: null, settings: settingsFor(`${HOME}p0`), now: 1 });
    await t.repo.updateRun(crashed.id, { state: 'running' }, 2);
    const queued = await t.repo.createRun({ projectId: null, settings: settingsFor(`${HOME}p1`), now: 3 });
    const service = t.makeService();
    expect(await service.startup()).toBe(2);
    for (const id of [crashed.id, queued.id]) expect(await t.repo.getRun(id)).toMatchObject({ state: 'paused', reason: 'interrupted' });
    expect((await service.status()).activeRunId).toBeNull();
    expect(t.fetcher.fetched).toEqual([]);
  });

  test('crawl-links-cut-recorded', async () => {
    const links = Array.from({ length: 1_200 }, (_, i) => `/l${i}`);
    const t = setup({ [HOME]: htmlPage('Many links', links) });
    const runId = await started(t.service, settingsFor(HOME, { maxPages: 1 }));
    await t.service.idle();
    const [row] = await t.rows(runId);
    expect(row).toMatchObject({ outcome: 'crawled', linkTotal: 1_200, linksCut: true, outlinks: SNAPSHOT_LIMITS.maxLinks });
    expect(t.count('SELECT count(*) AS n FROM crawl_links WHERE run_id = ?', runId)).toBe(CRAWL_LIMITS.maxLinksStoredPerPage);
    // Discovery saw the links the served parse kept (1 000), never the ones past the cap.
    expect(t.count('SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ?', runId)).toBe(1 + SNAPSHOT_LIMITS.maxLinks);
    expect(await t.repo.frontierEntry(runId, `${HOME}l1100`)).toBeNull();
    expect(await t.repo.frontierEntry(runId, `${HOME}l0`)).toMatchObject({ inlinks: 1, depth: 1 });
  });

  test('crawl-redirected-target-enqueued', async () => {
    const t = setup({
      [HOME]: htmlPage('Home', ['/moved']),
      [`${HOME}moved`]: { redirectTo: 'https://www.example.com/new', status: 301 },
      'https://www.example.com/new': htmlPage('New'),
    });
    const runId = await started(t.service, settingsFor(HOME, { scope: 'site' }));
    await t.service.idle();
    expect(t.fetcher.fetched).toEqual([HOME, `${HOME}moved`, 'https://www.example.com/new']);
    const moved = await t.repo.getPage(runId, `${HOME}moved`);
    expect(moved).toMatchObject({ outcome: 'redirected', status: 301, finalUrl: 'https://www.example.com/new', depth: 1, score: null });
    // The target is a page of its own, one click deeper, linked once (by the redirecting page).
    expect(await t.repo.frontierEntry(runId, 'https://www.example.com/new')).toMatchObject({ depth: 2, inlinks: 1, state: 'done' });
    expect(await t.repo.getPage(runId, 'https://www.example.com/new')).toMatchObject({ outcome: 'crawled', depth: 2, title: 'New' });
  });

  test('crawl-deferred-and-slow-down-pause-the-run', async () => {
    let deferred = true;
    const site = (url: string): FakePage | undefined => {
      if (url === HOME) return htmlPage('Home', ['/a', '/b']);
      if (url === `${HOME}a`) return deferred ? { outcome: 'deferred' } : htmlPage('A');
      if (url === `${HOME}b`) return { slowDown: true, status: 429 };
      return undefined;
    };
    const t = setup(site);
    const runId = await started(t.service, settingsFor(HOME));
    await t.service.idle();
    // `deferred`: no row, the URL still queued, the run paused (`slow-down`).
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'slow-down' });
    expect(await t.repo.getPage(runId, `${HOME}a`)).toBeNull();
    expect(await t.repo.frontierEntry(runId, `${HOME}a`)).toMatchObject({ state: 'queued' });
    expect(CRAWL_SLOW_DOWN_MESSAGE).toBe('The site asked frost to slow down.');
    // Never resumed by itself; Resume fetches it again. Then a 429 that says slow down: recorded, and the run pauses.
    deferred = false;
    expect(await t.service.resume(runId)).toEqual({ status: 'resumed', runId });
    await t.service.idle();
    expect(await t.repo.getPage(runId, `${HOME}a`)).toMatchObject({ outcome: 'crawled' });
    expect(await t.repo.getPage(runId, `${HOME}b`)).toMatchObject({ status: 429 });
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'slow-down' });
  });

  test('crawl-pacing-survives-a-restart', async () => {
    // Whole-branch review (site-crawl.feature.md, crawl-pacing-survives-a-restart; CRAWL_PACING_LIMITS): the real crawl
    // fetcher's pacing on a fake clock. A run paused by five 429s with `Retry-After: 60` keeps the host's wait and back-off on
    // the run, so a restart (a new crawl fetcher) never lets Resume reach the site early or at the base interval.
    const kit = timerClock();
    const db = tempStore();
    cleanups.push(db.close);
    const repo = db.store.siteCrawl;
    const requests: { url: string; at: number }[] = [];
    let answer = (url: string): { status: number; headers: Record<string, string> } => (url === HOME ? { status: 200, headers: {} } : /\/p[1-5]$/.test(url) ? { status: 429, headers: { 'retry-after': '60' } } : { status: 200, headers: {} });
    const lane: BoundedFetcher = {
      async fetch(request) {
        requests.push({ url: request.url, at: kit.now() });
        const { status, headers } = answer(request.url);
        const body = new TextEncoder().encode(request.url === HOME ? '<!doctype html><title>Home</title>' + Array.from({ length: 9 }, (_, i) => `<a href="/p${i + 1}">p</a>`).join('') : '<!doctype html><title>Page</title>') as Uint8Array<ArrayBuffer>;
        return { url: request.url, outcome: 'response', status, finalUrl: request.url, redirects: 0, chain: [], headers: { 'content-type': 'text/html', ...headers }, body, truncated: false, durationMs: 5 };
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    const robots: CrawlRobotsSource = { get: async (pageUrl) => ({ url: `${new URL(pageUrl).origin}/robots.txt`, outcome: 'unavailable', status: null, finalUrl: null, redirects: 0, body: new Uint8Array(0), truncated: false }) };
    /** One app session: a new crawl fetcher (empty pacing), crawler and service on the same database. */
    const boot = (): CrawlService => {
      const fetcher = createCrawlFetcher({ fetcher: lane, robots, userAgent: () => 'Mozilla/5.0', clock: kit.clock });
      const crawler = createCrawler({ repo, fetcher, analyse: inProcessAnalyse, projectLive: async () => true, now: kit.now });
      return createCrawlService({ repo, crawler: () => crawler, isOpen: () => true, projectLive: async () => true, now: kit.now, log: () => undefined });
    };

    const first = boot();
    const runId = await started(first, settingsFor(HOME));
    await kit.settle(first.idle());
    // Home, then p1–p5 each answer 429 (Retry-After: 60): the fifth in a row pauses the run.
    expect(requests.map((r) => r.url)).toEqual([HOME, ...[1, 2, 3, 4, 5].map((i) => `${HOME}p${i}`)]);
    expect(await repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'slow-down' });
    const lastAt = requests[5]!.at;
    expect(await repo.runPacing(runId)).toEqual([{ host: 'example.com', waitUntil: lastAt + 60_000, inARow: CRAWL_LIMITS.backoffAfter }]);

    // A restart within the minute: Resume's first request waits until the stored time, never before.
    kit.advance(10_000);
    answer = (url) => (url === `${HOME}p6` ? { status: 429, headers: {} } : { status: 200, headers: {} });
    const second = boot();
    await second.startup();
    expect(await second.resume(runId)).toEqual({ status: 'resumed', runId });
    await kit.settle(second.idle());
    expect(requests[6]).toEqual({ url: `${HOME}p6`, at: lastAt + 60_000 });
    // The back-off came back too: one more 429 is the sixth in a row, so the run pauses again at once.
    expect(requests).toHaveLength(7);
    expect(await repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'slow-down' });

    // Another restart: the next request waits the full backed-off interval (1 s × 2⁵) from that request's start.
    kit.advance(1_000);
    const third = boot();
    await third.startup();
    expect(await third.resume(runId)).toEqual({ status: 'resumed', runId });
    await kit.settle(third.idle());
    expect(requests[7]).toEqual({ url: `${HOME}p7`, at: requests[6]!.at + 1_000 * 2 ** CRAWL_LIMITS.backoffAfter });
    expect(await repo.getRun(runId)).toMatchObject({ state: 'done' });
  });

  test('crawl-pacing-survives-a-crash', async () => {
    // Council review, item 5 (K-B1 across a crash): the pacing is stored as it changes, not only when the run pauses. A
    // 429 with `Retry-After: 60`, then a kill (no pause is written; start-up finds the run `running`), then Resume: the
    // first request waits until the stored time.
    const kit = timerClock();
    const db = tempStore();
    cleanups.push(db.close);
    const repo = db.store.siteCrawl;
    const requests: { url: string; at: number }[] = [];
    let answer = (url: string): number => (url === `${HOME}p1` ? 429 : 200);
    const lane: BoundedFetcher = {
      async fetch(request) {
        requests.push({ url: request.url, at: kit.now() });
        const status = answer(request.url);
        const body = new TextEncoder().encode(request.url === HOME ? '<!doctype html><title>Home</title><a href="/p1">1</a><a href="/p2">2</a>' : '<!doctype html><title>Page</title>') as Uint8Array<ArrayBuffer>;
        return { url: request.url, outcome: 'response', status, finalUrl: request.url, redirects: 0, chain: [], headers: { 'content-type': 'text/html', ...(status === 429 ? { 'retry-after': '60' } : {}) }, body, truncated: false, durationMs: 5 };
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    const robots: CrawlRobotsSource = { get: async (pageUrl) => ({ url: `${new URL(pageUrl).origin}/robots.txt`, outcome: 'unavailable', status: null, finalUrl: null, redirects: 0, body: new Uint8Array(0), truncated: false }) };
    /** One app session on the same database; `analyse` stands in for its crawl worker. */
    const boot = (analyse: CrawlerDeps['analyse']): CrawlService => {
      const fetcher = createCrawlFetcher({ fetcher: lane, robots, userAgent: () => 'Mozilla/5.0', clock: kit.clock });
      const crawler = createCrawler({ repo, fetcher, analyse, projectLive: async () => true, now: kit.now });
      return createCrawlService({ repo, crawler: () => crawler, isOpen: () => true, projectLive: async () => true, now: kit.now, log: () => undefined });
    };

    // The first session is killed while p1's 429 is being parsed: its parse never answers, and nothing more of it runs.
    let killed!: () => void;
    const kill = new Promise<void>((resolve) => (killed = resolve));
    const first = boot(async (job) => {
      if (job.url !== `${HOME}p1`) return inProcessAnalyse(job);
      killed();
      return new Promise<never>(() => undefined);
    });
    const runId = await started(first, settingsFor(HOME));
    await kit.settle(kill);
    expect(requests.map((r) => r.url)).toEqual([HOME, `${HOME}p1`]);
    const p1At = requests[1]!.at;
    expect(await repo.getRun(runId)).toMatchObject({ state: 'running' });
    // Stored as it changed: the host's Retry-After and its back-off.
    expect(await repo.runPacing(runId)).toEqual([{ host: 'example.com', waitUntil: p1At + 60_000, inARow: 1 }]);

    // The next start, ten seconds on: the run left `running` is paused (`interrupted`), and Resume waits the stored time.
    kit.advance(10_000);
    answer = () => 200;
    const second = boot(inProcessAnalyse);
    expect(await second.startup()).toBe(1);
    expect(await repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'interrupted' });
    expect(await second.resume(runId)).toEqual({ status: 'resumed', runId });
    await kit.settle(second.idle());
    expect(requests[2]).toEqual({ url: `${HOME}p1`, at: p1At + 60_000 });
    // p1's 200 clears the back-off: p2 follows at the run's own interval.
    expect(requests[3]).toEqual({ url: `${HOME}p2`, at: p1At + 60_000 + 1_000 });
    expect(await repo.getRun(runId)).toMatchObject({ state: 'done' });
    expect(await repo.runPacing(runId)).toEqual([]);
  });

  test('crawl-query-variants-counted-from-the-frontier', async () => {
    const variants = (from: number, n: number) => Array.from({ length: n }, (_, i) => `/list?page=${from + i}`);
    const t = setup({ [HOME]: htmlPage('Home', ['/other', ...variants(0, 30)]), [`${HOME}other`]: htmlPage('Other', [...variants(0, 3), ...variants(100, 5)]) });
    const runId = await started(t.service, settingsFor(HOME, { maxPages: 2 }));
    await t.service.idle();
    const variantRows = () => t.count("SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ? AND url LIKE 'https://example.com/list?%'", runId);
    // At most 20 query variants of one path, counted from SQLite: the second page's new variants are refused, its known ones counted as inlinks.
    expect(variantRows()).toBe(CRAWL_LIMITS.maxQueryVariantsPerPath);
    expect(await t.repo.frontierEntry(runId, `${HOME}list?page=0`)).toMatchObject({ inlinks: 2 });
    expect(await t.repo.frontierEntry(runId, `${HOME}list?page=100`)).toBeNull();
    // A new service (a restart) counts the same rows: the cap holds across runs of the crawler.
    const again = t.makeService();
    await again.startup();
    expect(variantRows()).toBe(CRAWL_LIMITS.maxQueryVariantsPerPath);
  });

  test('crawl-cancels-when-its-project-is-gone', async () => {
    let live = true;
    const t = setup(chain(6), { projectLive: async () => live });
    const project = '01900000-0000-7000-8000-000000000001';
    const held = t.fetcher.hold(`${HOME}p2`);
    const runId = await started(t.service, settingsFor(`${HOME}p0`), project);
    await held.started;
    // A synced tombstone arrives mid-run: the next fetch call never starts.
    live = false;
    held.release();
    await t.service.idle();
    // p2's fetch call was already waiting: its paced slot asks again right before the request (beforeRequest), so nothing is sent.
    expect(t.fetcher.fetched).toEqual([`${HOME}p0`, `${HOME}p1`]);
    expect(await t.repo.listRuns({ projectId: project })).toEqual([]);
  });

  test('crawl-in-memory-state-bounded', async () => {
    // K-B3: a 10 000-page fake site on 300 hosts of one site (each page links ten children, its parent and the start),
    // fetched through the real per-host pacing (more hosts than `maxPacedHosts`) on a fake clock; the worker is faked
    // (no parse). This counts the crawler's own structures at every page's peak and end, never the heap.
    const N = 10_000;
    const HOSTS = 300;
    const pageUrl = (i: number) => `https://h${i % HOSTS}.example.com/n/${i}`;
    const indexOf = (url: string) => Number(new URL(url).pathname.slice('/n/'.length));
    // The pacing's clock: no real timer; a wait moves time to its end, and every fetch takes a second.
    let at = 0;
    const clock: CrawlClock = {
      now: () => at,
      setTimeout(fn, ms) {
        const due = at + ms;
        const handle = setImmediate(() => {
          at = Math.max(at, due);
          fn();
        });
        return () => clearImmediate(handle);
      },
    };
    const analyse = async (job: CrawlPageJob): Promise<CrawlPageResult> => {
      at += 1_000;
      const i = indexOf(job.url);
      const children = Array.from({ length: 10 }, (_, k) => 10 * i + k + 1).filter((child) => child < N);
      const links = [...children, Math.floor((i - 1) / 10), 0].filter((n) => n >= 0).map((n) => ({ url: pageUrl(n), nofollow: false }));
      const page: CrawlPageAnalysis = { score: 90, indexable: true, findings: [], title: `Page ${i}`, canonical: null, wordCount: 100, linkTotal: links.length, links };
      return { ok: true, page };
    };
    const samples: CrawlMemory[] = [];
    const t = setup((url) => (/^https:\/\/h\d+\.example\.com\/n\/\d+$/.test(url) ? { html: '<title>x</title>' } : undefined), { analyse, observe: (memory: CrawlMemory) => void samples.push(memory), pacing: createPacing({ clock }) });
    const runId = await started(t.service, settingsFor(pageUrl(0), { scope: 'site', maxPages: N }));
    await t.service.idle();
    expect(await t.repo.getRun(runId)).toMatchObject({ state: 'done', counts: { pages: N, queued: 0 } });
    expect(samples.length).toBeGreaterThanOrEqual(N);
    const totals = samples.map((m) => m.frontierWindow + m.pendingLinks + m.pacedHosts);
    expect(Math.max(...totals)).toBeLessThan(CRAWL_LIMITS.maxInMemoryEntries);
    expect(Math.max(...samples.map((m) => m.frontierWindow))).toBeLessThanOrEqual(CRAWL_LIMITS.frontierWindow);
    // The pacing table was exercised up to its cap, and never past it.
    expect(Math.max(...samples.map((m) => m.pacedHosts))).toBe(CRAWL_LIMITS.maxPacedHosts);
    // Sampled while a page's links were held, too (the peak), and the query paths are keys of those links.
    expect(Math.max(...samples.map((m) => m.pendingLinks))).toBeGreaterThan(0);
    for (const m of samples) expect(m.queryPaths).toBeLessThanOrEqual(m.pendingLinks);
    // The worst case by the limits stays under the bound: a full window, a page's full link list, a full pacing table.
    expect(CRAWL_LIMITS.frontierWindow + SNAPSHOT_LIMITS.maxLinks + CRAWL_LIMITS.maxPacedHosts).toBeLessThan(CRAWL_LIMITS.maxInMemoryEntries);
  }, 300_000);
});

describe('sitemap seeding', () => {
  const encoder = new TextEncoder();
  const urlset = (urls: readonly string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
  const index = (files: readonly string[]) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${files.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;

  /** A seeder over a fake robots.txt; the sitemap files are served by the fake site (through the run's own fetch). */
  function seeder(files: Record<string, string>, robotsText: string | null) {
    const robots: CrawlRobotsSource = {
      get: async (pageUrl) => {
        const url = `${new URL(pageUrl).origin}/robots.txt`;
        const answer: RobotsFetch = robotsText === null ? { url, outcome: 'unavailable', status: 404, finalUrl: url, redirects: 0, body: new Uint8Array(0), truncated: false } : { url, outcome: 'ok', status: 200, finalUrl: url, redirects: 0, body: encoder.encode(robotsText), truncated: false };
        return answer;
      },
    };
    const parseRobots = async (text: string) => {
      const parsed = parseCrawlRobots({ text });
      if (!parsed.ok) throw new Error('robots');
      return parsed.robots;
    };
    const jobs: unknown[] = [];
    const sitemaps = createSitemapSeeder({ robots, parseRobots, analyse: async (input) => (jobs.push(input), parseCrawlSitemap(input)), now: () => 1_800_000_000_000 });
    /** `site` with the sitemap files served as XML. */
    const serve = (site: (url: string) => FakePage | undefined) => (url: string): FakePage | undefined => (files[url] === undefined ? site(url) : { html: files[url]!, contentType: 'application/xml' });
    const requested = (fetched: readonly string[]) => fetched.filter((url) => url.endsWith('.xml'));
    return { sitemaps, serve, requested, jobs };
  }

  test('crawl-sitemap-seeds', async () => {
    const listed = Array.from({ length: 12 }, (_, i) => `${HOME}s${i}`);
    const { sitemaps, serve, requested } = seeder(
      {
        'https://example.com/sitemap-index.xml': index(['https://example.com/pages.xml', 'https://example.com/more.xml']),
        'https://example.com/pages.xml': urlset([...listed.slice(0, 8), 'https://elsewhere.example.org/x', `${HOME}s0?utm_source=feed`]),
        'https://example.com/more.xml': urlset(listed.slice(8)),
      },
      'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml\n',
    );
    const site = (url: string): FakePage | undefined => (url === HOME ? htmlPage('Home', ['/s0']) : url.startsWith(`${HOME}s`) ? htmlPage(url) : undefined);
    const t = setup(serve(site), { sitemaps });
    const runId = await started(t.service, settingsFor(HOME, { sitemaps: true, maxPages: 20 }));
    await t.service.idle();
    // robots.txt's Sitemap: line, the index, its files: each through the run's own fetch, within SITEMAP_LIMITS.
    expect(requested(t.fetcher.fetched)).toEqual(['https://example.com/sitemap-index.xml', 'https://example.com/pages.xml', 'https://example.com/more.xml']);
    // Seeds are depth 1, source sitemap (no inlink); out-of-scope URLs are not queued; tracking parameters stripped.
    expect(await t.repo.frontierEntry(runId, `${HOME}s5`)).toMatchObject({ depth: 1, fromSitemap: true, inlinks: 0 });
    expect(await t.repo.frontierEntry(runId, 'https://elsewhere.example.org/x')).toBeNull();
    // s0 is both linked from the start page and listed: not an orphan; the others are orphans until a page links them.
    expect(await t.repo.frontierEntry(runId, `${HOME}s0`)).toMatchObject({ fromSitemap: true, inlinks: 1 });
    expect(await t.repo.orphanCount(runId)).toBe(11);
    // The sitemap files are no pages; the start URL first, then the seeds in sitemap order.
    expect(t.fetcher.fetched.filter((url) => !url.endsWith('.xml'))).toEqual([HOME, ...listed]);
    expect(await t.repo.getPage(runId, 'https://example.com/pages.xml')).toBeNull();
    // At most the run's maxPages URLs are seeded.
    const capped = seeder({ 'https://example.com/sitemap.xml': urlset(listed) }, null);
    const c = setup(capped.serve(site), { sitemaps: capped.sitemaps });
    const cappedRun = await started(c.service, settingsFor(HOME, { sitemaps: true, maxPages: 3 }));
    await c.service.idle();
    expect(c.count('SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ? AND from_sitemap = 1', cappedRun)).toBe(3);

    // Seeding off: no sitemap is requested.
    const off = seeder({ 'https://example.com/sitemap-index.xml': index([]) }, 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml\n');
    const u = setup(off.serve(site), { sitemaps: off.sitemaps });
    await started(u.service, settingsFor(HOME, { sitemaps: false, maxPages: 1 }));
    await u.service.idle();
    expect(off.requested(u.fetcher.fetched)).toEqual([]);
  });

  test('crawl-sitemap-slow-down-pauses-the-run', async () => {
    // Council review, item 4: the sitemap requests are paced and reported like pages, so five 429s in a row on them say
    // "slow down" as five on pages do. The run ends paused (`slow-down`) before any page is fetched.
    const kit = timerClock();
    const db = tempStore();
    cleanups.push(db.close);
    const repo = db.store.siteCrawl;
    const files = [1, 2, 3, 4, 5].map((i) => `${HOME}s${i}.xml`);
    const requests: string[] = [];
    const lane: BoundedFetcher = {
      async fetch(request) {
        requests.push(request.url);
        const busy = files.includes(request.url);
        const body = encoder.encode(busy ? '' : urlset([`${HOME}a`])) as Uint8Array<ArrayBuffer>;
        return { url: request.url, outcome: 'response', status: busy ? 429 : 200, finalUrl: request.url, redirects: 0, chain: [], headers: { 'content-type': busy ? 'text/plain' : 'application/xml' }, body, truncated: false, durationMs: 5 };
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    const robotsText = `User-agent: *\nAllow: /\n${files.map((file) => `Sitemap: ${file}`).join('\n')}\n`;
    const robots: CrawlRobotsSource = { get: async (pageUrl) => ({ url: `${new URL(pageUrl).origin}/robots.txt`, outcome: 'ok', status: 200, finalUrl: `${new URL(pageUrl).origin}/robots.txt`, redirects: 0, body: encoder.encode(robotsText), truncated: false }) };
    const parseRobots = async (text: string) => {
      const parsed = parseCrawlRobots({ text });
      if (!parsed.ok) throw new Error('robots');
      return parsed.robots;
    };
    const fetcher = createCrawlFetcher({ fetcher: lane, robots, userAgent: () => 'Mozilla/5.0', clock: kit.clock });
    const sitemaps = createSitemapSeeder({ robots, parseRobots, analyse: async (input) => parseCrawlSitemap(input), now: kit.now });
    const crawler = createCrawler({ repo, fetcher, analyse: inProcessAnalyse, sitemaps, projectLive: async () => true, now: kit.now });
    const service = createCrawlService({ repo, crawler: () => crawler, isOpen: () => true, projectLive: async () => true, now: kit.now, log: () => undefined });

    const runId = await started(service, settingsFor(HOME, { sitemaps: true }));
    await kit.settle(service.idle());
    expect(requests).toEqual(files);
    expect(await repo.getRun(runId)).toMatchObject({ state: 'paused', reason: 'slow-down', counts: { pages: 0, queued: 1 } });
    expect(await repo.pagesOf(runId, { limit: 10, offset: 0 })).toEqual([]);
    expect(await repo.frontierEntry(runId, HOME)).toMatchObject({ state: 'queued' });
    // The back-off is the run's pacing: a resume waits it out.
    expect(await repo.runPacing(runId)).toEqual([expect.objectContaining({ host: 'example.com', inARow: CRAWL_LIMITS.backoffAfter })]);
  });

  test('crawl-sitemap-falls-back-to-sitemap-xml', async () => {
    const { sitemaps, serve, requested } = seeder({ 'https://example.com/sitemap.xml': urlset([`${HOME}a`]) }, null);
    const u = setup(serve((url) => ({ [HOME]: htmlPage('Home'), [`${HOME}a`]: htmlPage('A') })[url]), { sitemaps });
    const runId = await started(u.service, settingsFor(HOME, { sitemaps: true }));
    await u.service.idle();
    expect(requested(u.fetcher.fetched)).toEqual(['https://example.com/sitemap.xml']);
    expect(await u.repo.orphansOf(runId, { limit: 10, offset: 0 })).toEqual([`${HOME}a`]);
  });

  test('crawl-sitemap-read-once-in-windows', async () => {
    // A file longer than one window is parsed once in the worker and handed out in windows, then released.
    const listed = Array.from({ length: CRAWL_LIMITS.sitemapUrlsPerJob + 300 }, (_, i) => `${HOME}w${i}`);
    const { sitemaps, serve, jobs } = seeder({ 'https://example.com/sitemap.xml': urlset(listed) }, null);
    const t = setup(serve((url) => (url === HOME ? htmlPage('Home') : undefined)), { sitemaps });
    const runId = await started(t.service, settingsFor(HOME, { sitemaps: true, maxPages: 2_000 }));
    await t.service.idle();
    expect(t.count('SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ? AND from_sitemap = 1', runId)).toBe(listed.length);
    const shapes = jobs.map((job) => Object.keys(job as object).sort().join(','));
    expect(shapes).toEqual(['job,key,take', 'key,skip,take', 'key,release']);
    // The bytes went to the worker once.
    expect(jobs.filter((job) => 'job' in (job as object))).toHaveLength(1);
  });

  test('crawl-sitemap-window-timeout-stops-seeding-with-a-note', async () => {
    const listed = Array.from({ length: CRAWL_LIMITS.sitemapUrlsPerJob + 10 }, (_, i) => `${HOME}w${i}`);
    const files = { 'https://example.com/sitemap.xml': urlset(listed) };
    const base = seeder(files, null);
    const logs: string[] = [];
    const robots: CrawlRobotsSource = { get: async () => null };
    const timingOut = createSitemapSeeder({
      robots,
      parseRobots: async () => {
        throw new Error('unused');
      },
      // The second window does not answer in time (the worker's deadline).
      analyse: async (input) => ('skip' in input ? { ok: false, reason: 'analysis-timeout' } : parseCrawlSitemap(input)),
      log: (line) => logs.push(line),
    });
    const t = setup(base.serve((url) => (url === HOME ? htmlPage('Home') : undefined)), { sitemaps: timingOut });
    const runId = await started(t.service, settingsFor(HOME, { sitemaps: true, maxPages: 2_000 }));
    await t.service.idle();
    expect(t.count('SELECT count(*) AS n FROM crawl_frontier WHERE run_id = ? AND from_sitemap = 1', runId)).toBe(CRAWL_LIMITS.sitemapUrlsPerJob);
    expect(logs).toEqual([expect.stringMatching(/^crawl: a sitemap window did not answer in time; seeding stopped/)]);
    expect((await t.service.status()).runs.find((run) => run.id === runId)).toMatchObject({ note: CRAWL_RUN_NOTES.sitemapTimeout, state: 'done' });
  });
});
