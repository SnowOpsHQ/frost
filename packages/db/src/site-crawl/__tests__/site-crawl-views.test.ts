// Spec: specs/site-crawl.spec.ts (CRAWL_PAGE_FILTERS, CRAWL_STATUS_CLASSES, CRAWL_INDEXABLE_FILTERS, CRAWL_PAGE_SORTS,
// CRAWL_PAGES_LIMITS, CRAWL_TREE_LIMITS, CRAWL_FRONTIER_STATES: the frontier is the authority for in-links and orphans),
// specs/site-crawl.schema.ts (CrawlPageFilterSchema, CrawlPageListRowSchema, CrawlTreeNodeSchema)
// Acceptance: specs/site-crawl.feature.md (Pages and Site structure, Task 7: The queries); plan
// docs/plans/phase-12-big-bets.md Task 7 (paged queries only, no client-side full list)
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { CrawlPageListRowSchema, CrawlTreeNodeSchema, defaultCrawlSettings, type CrawlPageRow } from '@app/specs/site-crawl.schema';
import { CRAWL_TREE_LIMITS } from '@app/specs/site-crawl.spec';
import { createDrizzle } from '../../client';
import { runMigrations } from '../../migrations';
import { createSiteCrawlRepository, type SiteCrawlRepository } from '../repository';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A migrated in-memory database: these queries read what they are given, and hundreds of seeded rows
 * written one at a time to a file were too slow on Windows CI.
 */
function store(): { siteCrawl: SiteCrawlRepository } {
  const raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  cleanups.push(async () => raw.close());
  return { siteCrawl: createSiteCrawlRepository(createDrizzle(raw)) };
}

const page = (runId: string, url: string, changes: Partial<CrawlPageRow> = {}): CrawlPageRow => ({
  runId,
  url,
  depth: 1,
  outcome: 'crawled',
  status: 200,
  finalUrl: null,
  contentType: 'text/html',
  title: 'A page',
  canonical: null,
  indexable: true,
  robotsCrawl: 'allowed',
  robotsGooglebot: 'allowed',
  wordCount: 300,
  linkTotal: 10,
  linksCut: false,
  score: 90,
  findings: [],
  outlinks: 10,
  bytes: 1_000,
  fetchedAt: 1,
  ...changes,
});

const ALL = {} as const;

describe('the Pages and Site structure queries (Task 7)', () => {
  test('crawl-pages-query-paged-and-filtered', async () => {
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
    const other = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 2 });
    const base = 'https://example.com/';
    // 250 plain pages, then a handful with something to filter on.
    for (let i = 0; i < 250; i++) await repo.putPage(page(run.id, `${base}p${String(i).padStart(3, '0')}`, { depth: 1 + (i % 3) }));
    await repo.putPage(page(run.id, `${base}gone`, { status: 404, indexable: false, score: 40, findings: [{ id: 'http-status-client-error', severity: 'error' }] }));
    await repo.putPage(page(run.id, `${base}moved`, { outcome: 'redirected', status: 301, indexable: false, score: null, wordCount: null }));
    await repo.putPage(page(run.id, `${base}broken`, { status: 503, indexable: false, score: 10, findings: [{ id: 'http-status-server-error', severity: 'error' }, { id: 'title-missing', severity: 'error' }] }));
    await repo.putPage(page(run.id, `${base}blocked`, { outcome: 'blocked-by-robots', status: null, indexable: null, score: null, wordCount: null, robotsCrawl: 'blocked', depth: 4 }));
    await repo.putPage(page(run.id, `${base}huge`, { linkTotal: 4_000, linksCut: true, findings: [{ id: 'title-missing', severity: 'error' }] }));
    await repo.putPage(page(other.id, `${base}other-run`, { status: 404 }));
    // In-links come from the frontier (the authority), joined on (run, url).
    await repo.enqueue(run.id, [{ url: `${base}gone`, depth: 1, source: 'link' }]);
    await repo.enqueue(run.id, [{ url: `${base}gone`, depth: 1, source: 'link' }]);

    // Paged: never more than asked, with the total the filter selects.
    const first = await repo.pagesPage(run.id, { filter: ALL, sort: 'order', direction: 'asc', offset: 0, limit: 200 });
    expect(first.total).toBe(255);
    expect(first.rows).toHaveLength(200);
    expect(first.rows[0]!.url).toBe(`${base}p000`);
    for (const row of first.rows) expect(CrawlPageListRowSchema.safeParse(row).success).toBe(true);
    const second = await repo.pagesPage(run.id, { filter: ALL, sort: 'order', direction: 'asc', offset: 200, limit: 200 });
    expect(second.total).toBe(255);
    expect(second.rows).toHaveLength(55);
    expect(second.rows.at(-1)!.url).toBe(`${base}huge`);
    // A limit past the cap reads the cap.
    expect((await repo.pagesPage(run.id, { filter: ALL, sort: 'order', direction: 'asc', offset: 0, limit: 10_000 })).rows).toHaveLength(200);

    const urls = async (filter: Parameters<typeof repo.pagesPage>[1]['filter']) => (await repo.pagesPage(run.id, { filter, sort: 'url', direction: 'asc', offset: 0, limit: 200 })).rows.map((row) => row.url.slice(base.length));
    expect(await urls({ status: '4xx' })).toEqual(['gone']);
    expect(await urls({ status: '3xx' })).toEqual(['moved']);
    expect(await urls({ status: '5xx' })).toEqual(['broken']);
    expect(await urls({ status: 'none' })).toEqual(['blocked']);
    expect(await urls({ indexable: 'no' })).toEqual(['broken', 'gone', 'moved']);
    expect(await urls({ indexable: 'unknown' })).toEqual(['blocked']);
    expect((await repo.pagesPage(run.id, { filter: { indexable: 'yes' }, sort: 'order', direction: 'asc', offset: 0, limit: 1 })).total).toBe(251);
    expect(await urls({ finding: 'title-missing' })).toEqual(['broken', 'huge']);
    expect(await urls({ finding: 'title-missing', status: '5xx' })).toEqual(['broken']);
    expect(await urls({ finding: 'canonical-missing' })).toEqual([]);
    expect(await urls({ depth: 4 })).toEqual(['blocked']);
    expect(await urls({ linksCut: true })).toEqual(['huge']);
    expect((await repo.pagesPage(run.id, { filter: { depth: 2 }, sort: 'order', direction: 'asc', offset: 0, limit: 1 })).total).toBe(83);

    const gone = (await repo.pagesPage(run.id, { filter: { status: '4xx' }, sort: 'order', direction: 'asc', offset: 0, limit: 1 })).rows[0]!;
    expect(gone.inlinks).toBe(2);
    expect(gone.findings).toEqual([{ id: 'http-status-client-error', severity: 'error' }]);
    expect('runId' in gone).toBe(false);
    // The listed row is strict: nothing more crosses IPC.
    expect(CrawlPageListRowSchema.safeParse({ ...gone, extra: 1 }).success).toBe(false);
    expect(CrawlPageListRowSchema.safeParse({ ...gone, runId: run.id }).success).toBe(false);
    // Another run's pages never show; a run with none answers none.
    expect((await repo.pagesPage(other.id, { filter: ALL, sort: 'order', direction: 'asc', offset: 0, limit: 200 })).total).toBe(1);
    expect(await repo.pagesPage('01900000-0000-7000-8000-000000000000', { filter: ALL, sort: 'order', direction: 'asc', offset: 0, limit: 200 })).toEqual({ total: 0, rows: [] });
  });

  test('crawl-pages-sorted-in-sql', async () => {
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
    const base = 'https://example.com/';
    await repo.putPage(page(run.id, `${base}b`, { score: 50, status: 200, depth: 2, wordCount: 20 }));
    await repo.putPage(page(run.id, `${base}a`, { score: 90, status: 404, depth: 1, wordCount: 900 }));
    await repo.putPage(page(run.id, `${base}c`, { score: null, status: null, depth: 3, wordCount: null, outcome: 'timeout' }));
    await repo.putPage(page(run.id, `${base}d`, { score: 70, status: 301, depth: 0, wordCount: 400 }));
    await repo.enqueue(run.id, [{ url: `${base}d`, depth: 0, source: 'start' }]);
    for (let i = 0; i < 3; i++) await repo.enqueue(run.id, [{ url: `${base}c`, depth: 3, source: 'link' }]);
    await repo.enqueue(run.id, [{ url: `${base}a`, depth: 1, source: 'link' }]);
    const order = async (sort: Parameters<typeof repo.pagesPage>[1]['sort'], direction: 'asc' | 'desc') =>
      (await repo.pagesPage(run.id, { filter: ALL, sort, direction, offset: 0, limit: 10 })).rows.map((row) => row.url.slice(base.length)).join('');
    expect(await order('order', 'asc')).toBe('bacd');
    expect(await order('order', 'desc')).toBe('dcab');
    expect(await order('url', 'asc')).toBe('abcd');
    expect(await order('url', 'desc')).toBe('dcba');
    // A page without the value sorts last either way.
    expect(await order('score', 'asc')).toBe('bdac');
    expect(await order('score', 'desc')).toBe('adbc');
    expect(await order('status', 'asc')).toBe('bdac');
    expect(await order('words', 'desc')).toBe('adbc');
    expect(await order('depth', 'asc')).toBe('dabc');
    expect(await order('inlinks', 'desc')).toBe('cabd');
    // The CSV export's fixed order: the same ids in the same sort, then rows read back by id in that order.
    const ids = await repo.pageOrder(run.id, { filter: ALL, sort: 'score', direction: 'desc' }, 10);
    expect(ids).toHaveLength(4);
    expect((await repo.pagesByIds(run.id, ids)).map((row) => row.url.slice(base.length)).join('')).toBe('adbc');
    expect((await repo.pagesByIds(run.id, [...ids].reverse())).map((row) => row.url.slice(base.length)).join('')).toBe('cbda');
    expect(await repo.pageOrder(run.id, { filter: { status: '4xx' }, sort: 'order', direction: 'asc' }, 10)).toHaveLength(1);
    // Another run's ids are never read.
    expect(await repo.pagesByIds('01900000-0000-7000-8000-000000000000', ids)).toEqual([]);
  });

  test('crawl-structure-tree', async () => {
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
    const urls = [
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/blog',
      'https://example.com/blog/',
      'https://example.com/blog/one',
      'https://example.com/blog/two?page=2',
      'https://example.com/blog/2026/post',
      'https://example.com/shop?sort=price',
      'https://shop.example.com/',
      'https://shop.example.com/cart',
      'http://example.com:8080/x',
    ];
    for (const [i, url] of urls.entries()) await repo.putPage(page(run.id, url, { depth: Math.min(i, 3) }));

    // The run's origins first: each one's pages, and the prefix to read below it.
    const root = await repo.treeLevel(run.id, null, CRAWL_TREE_LIMITS.maxChildren);
    expect(root).toEqual({
      more: 0,
      nodes: [
        { label: 'https://example.com', pages: 8, prefix: 'https://example.com/', url: null },
        { label: 'https://shop.example.com', pages: 2, prefix: 'https://shop.example.com/', url: null },
        { label: 'http://example.com:8080', pages: 1, prefix: 'http://example.com:8080/', url: null },
      ],
    });
    for (const node of root.nodes) expect(CrawlTreeNodeSchema.safeParse(node).success).toBe(true);
    // One level down: path segments, most pages first; query variants count under their path.
    const site = await repo.treeLevel(run.id, 'https://example.com/', CRAWL_TREE_LIMITS.maxChildren);
    expect(site).toEqual({
      more: 0,
      nodes: [
        { label: 'blog', pages: 5, prefix: 'https://example.com/blog/', url: 'https://example.com/blog' },
        { label: '', pages: 1, prefix: null, url: 'https://example.com/' },
        { label: 'about', pages: 1, prefix: null, url: 'https://example.com/about' },
        { label: 'shop', pages: 1, prefix: null, url: null },
      ],
    });
    expect(await repo.treeLevel(run.id, 'https://example.com/blog/', CRAWL_TREE_LIMITS.maxChildren)).toEqual({
      more: 0,
      nodes: [
        { label: '', pages: 1, prefix: null, url: 'https://example.com/blog/' },
        { label: '2026', pages: 1, prefix: 'https://example.com/blog/2026/', url: null },
        { label: 'one', pages: 1, prefix: null, url: 'https://example.com/blog/one' },
        { label: 'two', pages: 1, prefix: null, url: null },
      ],
    });
    // A prefix is a range on the (run, url) index: `/blog/` never takes `/blogs/`, and another run's pages never count.
    await repo.putPage(page(run.id, 'https://example.com/blogs/x'));
    const other = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 2 });
    await repo.putPage(page(other.id, 'https://example.com/blog/elsewhere'));
    expect((await repo.treeLevel(run.id, 'https://example.com/blog/', CRAWL_TREE_LIMITS.maxChildren)).nodes.map((node) => node.label)).toEqual(['', '2026', 'one', 'two']);

    // Bounded: a level holds at most `limit` nodes; the rest are counted, never read.
    for (let i = 0; i < 30; i++) await repo.putPage(page(run.id, `https://example.com/many/${i}`));
    const cut = await repo.treeLevel(run.id, 'https://example.com/many/', 10);
    expect(cut.nodes).toHaveLength(10);
    expect(cut.more).toBe(20);

    // The click-depth histogram, one bar per depth with pages.
    expect(await repo.depthHistogram(other.id)).toEqual([{ depth: 1, pages: 1 }]);
    expect((await repo.depthHistogram(run.id)).map((bar) => bar.depth)).toEqual([0, 1, 2, 3]);

    // Orphans: sitemap URLs never linked, read from the frontier.
    await repo.enqueue(run.id, [
      { url: 'https://example.com/listed-only', depth: 1, source: 'sitemap' },
      { url: 'https://example.com/about', depth: 1, source: 'sitemap' },
    ]);
    await repo.enqueue(run.id, [{ url: 'https://example.com/about', depth: 1, source: 'link' }]);
    expect(await repo.orphansOf(run.id, { limit: CRAWL_TREE_LIMITS.maxOrphansShown, offset: 0 })).toEqual(['https://example.com/listed-only']);
    expect(await repo.orphanCount(run.id)).toBe(1);
  });
});
