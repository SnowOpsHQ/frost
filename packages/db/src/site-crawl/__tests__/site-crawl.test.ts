// Spec: specs/site-crawl.spec.ts (SITE_CRAWL_TABLES, SITE_CRAWL_MIGRATION_IDS, CRAWL_RUN_STATES, CRAWL_RUN_REASONS, CRAWL_PAGE_OUTCOMES,
// CRAWL_ROBOTS_VERDICTS, CRAWL_FRONTIER_STATES, CRAWL_LIMITS), specs/site-crawl.schema.ts (CrawlSettingsSchema, CrawlPageRowSchema,
// CrawlRunViewSchema); plan docs/plans/phase-12-big-bets.md Global constraints (migrations 0240/0241, placed after PHASE11_MIGRATIONS)
// Acceptance: specs/site-crawl.feature.md (Storage)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { defaultCrawlSettings, CrawlPageRowSchema, CrawlRunViewSchema, type CrawlPageRow } from '@app/specs/site-crawl.schema';
import {
  CRAWL_FRONTIER_STATES,
  CRAWL_LIMITS,
  CRAWL_PAGE_OUTCOMES,
  CRAWL_ROBOTS_VERDICTS,
  CRAWL_RUN_REASONS,
  CRAWL_RUN_STATES,
  SITE_CRAWL_MIGRATION_IDS,
  SITE_CRAWL_TABLES,
} from '@app/specs/site-crawl.spec';
import { createDrizzle } from '../../client';
import { uuidv7 } from '../../change-intel/ids';
import { MIGRATIONS, runMigrations } from '../../migrations';
import { PHASE11_MIGRATIONS } from '../../phase11-migrations';
import { openSessionStore } from '../../store';
import { SITE_CRAWL_MIGRATIONS } from '../migrations';
import { createSiteCrawlRepository, type SiteCrawlRepository } from '../repository';
import * as schema from '../schema';

let raw: DatabaseSync;
let repo: SiteCrawlRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createSiteCrawlRepository(createDrizzle(raw));
});

const count = (table: string, where = '1 = 1', ...params: (string | number)[]) => Number(raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params)!['n']);
const named = (type: string) =>
  raw
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'crawl\\_%' ESCAPE '\\' ORDER BY rowid")
    .all(type)
    .map((row) => String(row['name']));

function sqliteColumns(table: string) {
  return raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function drizzleColumns(table: SQLiteTable) {
  return getTableConfig(table)
    .columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull || column.primary }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PROJECT = uuidv7(1_000);
const OTHER_PROJECT = uuidv7(2_000);
const page = (runId: string, url: string, changes: Partial<CrawlPageRow> = {}): CrawlPageRow => ({
  runId,
  url,
  depth: 1,
  outcome: 'crawled',
  status: 200,
  finalUrl: url,
  contentType: 'text/html; charset=utf-8',
  title: 'A page',
  canonical: url,
  indexable: true,
  robotsCrawl: 'allowed',
  robotsGooglebot: 'allowed',
  wordCount: 420,
  linkTotal: 12,
  linksCut: false,
  score: 93,
  findings: [{ id: 'meta-description-too-short', severity: 'warning' }],
  outlinks: 12,
  bytes: 18_000,
  fetchedAt: 5_000,
  ...changes,
});

/** Inserts a raw row with `column = value` changed, answering whether SQLite accepted it. */
function accepts(sql: string, ...params: (string | number | null)[]): boolean {
  try {
    raw.prepare(sql).run(...params);
    return true;
  } catch {
    return false;
  }
}

describe('site crawl storage', () => {
  test('site-crawl-migrations-create-schema', () => {
    // Spread right after Phase 11's block, in id order (plan Global constraints).
    expect(SITE_CRAWL_MIGRATIONS.map((m) => m.id)).toEqual([...SITE_CRAWL_MIGRATION_IDS]);
    const at = MIGRATIONS.indexOf(SITE_CRAWL_MIGRATIONS[0]!);
    expect(at).toBe(MIGRATIONS.indexOf(PHASE11_MIGRATIONS[PHASE11_MIGRATIONS.length - 1]!) + 1);
    expect(MIGRATIONS.slice(at, at + SITE_CRAWL_MIGRATIONS.length)).toEqual(SITE_CRAWL_MIGRATIONS);
    expect(SITE_CRAWL_MIGRATIONS.every((m) => m.id >= '0240' && m.id < '0250')).toBe(true);

    // Exactly the spec's tables, column for column with the Drizzle schema, with its indexes.
    const tables = [schema.crawlRuns, schema.crawlPages, schema.crawlLinks, schema.crawlFrontier];
    expect(named('table')).toEqual([...SITE_CRAWL_TABLES]);
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([...SITE_CRAWL_TABLES]);
    for (const table of tables) expect(sqliteColumns(getTableConfig(table).name), getTableConfig(table).name).toEqual(drizzleColumns(table));
    expect(named('index').sort()).toEqual(tables.flatMap((table) => getTableConfig(table).indexes.map((index) => index.config.name)).sort());
    // The `(run_id, url)` lookups are indexed (unique per run for pages and the frontier).
    const indexed = (table: string) =>
      raw
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .map((row) => ({ unique: row['unique'] === 1, columns: raw.prepare(`PRAGMA index_info(${String(row['name'])})`).all().map((c) => String(c['name'])) }));
    expect(indexed('crawl_pages')).toContainEqual({ unique: true, columns: ['run_id', 'url'] });
    expect(indexed('crawl_frontier')).toContainEqual({ unique: true, columns: ['run_id', 'url'] });
    expect(indexed('crawl_links')).toContainEqual({ unique: false, columns: ['run_id', 'to_url'] });
    expect(named('trigger').sort()).toEqual(['crawl_frontier_run_exists', 'crawl_links_run_exists', 'crawl_pages_run_exists', 'crawl_runs_delete_rows']);

    // The CHECKs accept exactly the spec's values.
    const run = (state: string, reason: string | null) =>
      accepts("INSERT INTO crawl_runs (id, project_id, start_url, settings, state, reason, pages, queued, refused, failed, bytes, created_at, updated_at, finished_at) VALUES (?, NULL, 'https://example.com/', '{}', ?, ?, 0, 0, 0, 0, 0, 1, 1, NULL)", uuidv7(), state, reason);
    for (const state of CRAWL_RUN_STATES) expect(run(state, null), state).toBe(true);
    for (const reason of CRAWL_RUN_REASONS) expect(run('paused', reason), reason).toBe(true);
    for (const bad of ['RUNNING', 'stopped', '']) expect(run(bad, null), bad).toBe(false);
    expect(run('paused', 'because')).toBe(false);
    const runId = uuidv7();
    expect(run('queued', null)).toBe(true);
    raw.prepare("UPDATE crawl_runs SET id = ? WHERE rowid = (SELECT max(rowid) FROM crawl_runs)").run(runId);
    const pageRow = (url: string, outcome: string, verdict = 'allowed') =>
      accepts("INSERT INTO crawl_pages (run_id, url, depth, outcome, robots_crawl, robots_googlebot, link_total, links_cut, findings, outlinks, bytes, fetched_at) VALUES (?, ?, 0, ?, ?, ?, 0, 0, '[]', 0, 0, 1)", runId, url, outcome, verdict, verdict);
    CRAWL_PAGE_OUTCOMES.forEach((outcome, i) => expect(pageRow(`https://example.com/${i}`, outcome), outcome).toBe(true));
    CRAWL_ROBOTS_VERDICTS.forEach((verdict, i) => expect(pageRow(`https://example.com/v${i}`, 'crawled', verdict), verdict).toBe(true));
    expect(pageRow('https://example.com/x', 'fetched')).toBe(false);
    expect(pageRow('https://example.com/y', 'crawled', 'maybe')).toBe(false);
    const frontier = (url: string, state: string) => accepts('INSERT INTO crawl_frontier (run_id, url, depth, state) VALUES (?, ?, 0, ?)', runId, url, state);
    CRAWL_FRONTIER_STATES.forEach((state, i) => expect(frontier(`https://example.com/f${i}`, state), state).toBe(true));
    expect(frontier('https://example.com/g', 'fetching')).toBe(false);
    expect(accepts("INSERT INTO crawl_frontier (run_id, url, depth, state, from_sitemap) VALUES (?, 'https://example.com/s', 0, 'queued', 2)", runId)).toBe(false);
    expect(accepts("INSERT INTO crawl_frontier (run_id, url, depth, state, inlinks) VALUES (?, 'https://example.com/n', 0, 'queued', -1)", runId)).toBe(false);
    // Bounds: a URL past the cap, a depth past maxDepth.
    expect(pageRow(`https://example.com/${'a'.repeat(CRAWL_LIMITS.maxUrlChars)}`, 'crawled')).toBe(false);
    expect(accepts('INSERT INTO crawl_frontier (run_id, url, depth, state) VALUES (?, ?, ?, ?)', runId, 'https://example.com/deep', CRAWL_LIMITS.maxDepth + 1, 'queued')).toBe(false);
  });

  test('crawl-repository-round-trips', async () => {
    const settings = { ...defaultCrawlSettings('https://example.com/'), include: ['/blog/'], maxPages: 50 };
    const run = await repo.createRun({ projectId: PROJECT, settings, now: 10_000 });
    expect(CrawlRunViewSchema.parse(run)).toEqual(run);
    expect(run).toMatchObject({ projectId: PROJECT, startUrl: 'https://example.com/', settings, state: 'queued', reason: null, counts: { pages: 0, queued: 0, refused: 0, failed: 0, bytes: 0 }, createdAt: 10_000, updatedAt: 10_000, finishedAt: null });
    expect(await repo.getRun(run.id)).toEqual(run);
    expect(await repo.getRun(uuidv7())).toBeNull();
    // Invalid settings are refused (nothing written).
    await expect(repo.createRun({ projectId: null, settings: { ...settings, scope: 'site', startUrl: 'http://127.0.0.1:3000/' }, now: 1 })).rejects.toThrow();
    expect(count('crawl_runs')).toBe(1);

    const loose = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.org/'), now: 11_000 });
    const other = await repo.createRun({ projectId: OTHER_PROJECT, settings: defaultCrawlSettings('https://example.net/'), now: 12_000 });
    // Newest first; by project.
    expect((await repo.listRuns()).map((r) => r.id)).toEqual([other.id, loose.id, run.id]);
    expect((await repo.listRuns({ projectId: PROJECT })).map((r) => r.id)).toEqual([run.id]);
    expect((await repo.listRuns({ projectId: OTHER_PROJECT })).map((r) => r.id)).toEqual([other.id]);
    expect(await repo.listRuns({ limit: 1 })).toHaveLength(1);

    // State and counts.
    expect(await repo.updateRun(run.id, { state: 'running', counts: { queued: 3 } }, 13_000)).toBe(true);
    expect(await repo.getRun(run.id)).toMatchObject({ state: 'running', reason: null, counts: { pages: 0, queued: 3, refused: 0, failed: 0, bytes: 0 }, updatedAt: 13_000 });
    expect(await repo.updateRun(run.id, { state: 'done', reason: 'max-pages', counts: { pages: 3, queued: 1, refused: 1, failed: 1, bytes: 36_000 }, finishedAt: 14_000 }, 14_000)).toBe(true);
    expect(await repo.getRun(run.id)).toMatchObject({ state: 'done', reason: 'max-pages', counts: { pages: 3, queued: 1, refused: 1, failed: 1, bytes: 36_000 }, finishedAt: 14_000 });
    expect(await repo.updateRun(uuidv7(), { state: 'paused' }, 1)).toBe(false);

    // Pages: inserted, replaced by URL, read back, paged in crawl order.
    const a = page(run.id, 'https://example.com/blog/a', { depth: 0 });
    expect(await repo.putPage(a)).toBe(true);
    expect(await repo.getPage(run.id, a.url)).toEqual(a);
    const a2 = page(run.id, a.url, { depth: 0, status: 404, outcome: 'crawled', indexable: false, score: 59, findings: [{ id: 'http-status-client-error', severity: 'error' }] });
    expect(await repo.putPage(a2)).toBe(true);
    expect(await repo.getPage(run.id, a.url)).toEqual(a2);
    expect(count('crawl_pages')).toBe(1);
    const refused = page(run.id, 'https://example.com/blog/robots', { outcome: 'blocked-by-robots', status: null, finalUrl: null, contentType: null, title: null, canonical: null, indexable: null, robotsCrawl: 'blocked', wordCount: null, linkTotal: 0, score: null, findings: [], outlinks: 0, bytes: 0 });
    expect(await repo.putPage(refused)).toBe(true);
    for (let i = 0; i < 5; i++) await repo.putPage(page(run.id, `https://example.com/blog/p${i}`));
    const all = await repo.pagesOf(run.id, { limit: 100, offset: 0 });
    expect(all.map((p) => p.url)).toEqual([a.url, refused.url, ...[0, 1, 2, 3, 4].map((i) => `https://example.com/blog/p${i}`)]);
    for (const row of all) expect(CrawlPageRowSchema.parse(row)).toEqual(row);
    expect((await repo.pagesOf(run.id, { limit: 2, offset: 2 })).map((p) => p.url)).toEqual(['https://example.com/blog/p0', 'https://example.com/blog/p1']);
    expect(await repo.pagesOf(loose.id, { limit: 10, offset: 0 })).toEqual([]);
    // An invalid row is refused; a run that does not exist takes no rows.
    expect(await repo.putPage({ ...page(run.id, 'https://example.com/x'), findings: [{ id: 'og-title-missing' as never, severity: 'info' }] })).toBe(false);
    expect(await repo.putPage({ ...page(run.id, 'https://example.com/x'), url: 'javascript:alert(1)' })).toBe(false);
    expect(await repo.putPage(page(uuidv7(), 'https://example.com/x'))).toBe(false);

    // Links: stored per page, replaced by a later put, capped at maxLinksStoredPerPage.
    const links = Array.from({ length: CRAWL_LIMITS.maxLinksStoredPerPage + 50 }, (_, i) => ({ toUrl: `https://example.com/l${i}`, internal: i % 2 === 0, nofollow: i % 7 === 0 }));
    expect(await repo.putLinks(run.id, a.url, links)).toBe(CRAWL_LIMITS.maxLinksStoredPerPage);
    expect(count('crawl_links', 'run_id = ?', run.id)).toBe(CRAWL_LIMITS.maxLinksStoredPerPage);
    expect(await repo.linksOf(run.id, a.url)).toEqual(links.slice(0, CRAWL_LIMITS.maxLinksStoredPerPage));
    expect(await repo.putLinks(run.id, a.url, links.slice(0, 3))).toBe(3);
    expect(await repo.linksOf(run.id, a.url)).toEqual(links.slice(0, 3));
    expect(await repo.putLinks(run.id, 'https://example.com/never-crawled', links)).toBe(0);

    // The frontier: each URL once per run (the seen-set), oldest first, marked done.
    const link = (url: string, depth = 1) => ({ url, depth, source: 'link' as const });
    expect(await repo.enqueue(run.id, [link('https://example.com/q1'), link('https://example.com/q2'), link('https://example.com/q1', 2)])).toBe(2);
    expect(await repo.enqueue(run.id, [link('https://example.com/q2', 3), link('https://example.com/q3', 2)])).toBe(1);
    expect(await repo.enqueue(loose.id, [{ url: 'https://example.com/q1', depth: 0, source: 'start' }])).toBe(1);
    expect(await repo.queuedCount(run.id)).toBe(3);
    expect(await repo.nextQueued(run.id, 2)).toEqual([{ url: 'https://example.com/q1', depth: 1 }, { url: 'https://example.com/q2', depth: 1 }]);
    await repo.markDone(run.id, ['https://example.com/q1']);
    expect(await repo.nextQueued(run.id, 5)).toEqual([{ url: 'https://example.com/q2', depth: 1 }, { url: 'https://example.com/q3', depth: 2 }]);
    // Done stays seen: never queued again.
    expect(await repo.enqueue(run.id, [link('https://example.com/q1')])).toBe(0);
    await repo.markDone(run.id, ['https://example.com/q2', 'https://example.com/q3']);
    expect(await repo.nextQueued(run.id, 5)).toEqual([]);
    expect(await repo.queuedCount(run.id)).toBe(0);
    expect(await repo.queuedCount(loose.id)).toBe(1);
    // A large batch (a page's 1 000 links) goes in at once.
    const many = Array.from({ length: 1_000 }, (_, i) => link(`https://example.org/m${i}`));
    expect(await repo.enqueue(loose.id, many)).toBe(1_000);

  });

  test('crawl-startup-pauses-running-and-queued', async () => {
    const make = async (state: (typeof CRAWL_RUN_STATES)[number], reason: (typeof CRAWL_RUN_REASONS)[number] | null = null) => {
      const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
      if (state !== 'queued') await repo.updateRun(run.id, { state, reason }, 2_000);
      return run.id;
    };
    const running = await make('running');
    const queued = await make('queued');
    const paused = await make('paused', 'user');
    const done = await make('done');
    const cancelled = await make('cancelled', 'user');
    const failed = await make('failed', 'error');
    // Start-up: every `running` or `queued` run becomes `paused` (interrupted); nothing else changes.
    expect(await repo.pauseInterrupted(3_000)).toBe(2);
    for (const id of [running, queued]) expect(await repo.getRun(id)).toMatchObject({ state: 'paused', reason: 'interrupted', updatedAt: 3_000 });
    expect(await repo.getRun(paused)).toMatchObject({ state: 'paused', reason: 'user', updatedAt: 2_000 });
    expect(await repo.getRun(done)).toMatchObject({ state: 'done', updatedAt: 2_000 });
    expect(await repo.getRun(cancelled)).toMatchObject({ state: 'cancelled', updatedAt: 2_000 });
    expect(await repo.getRun(failed)).toMatchObject({ state: 'failed', updatedAt: 2_000 });
    expect(await repo.pauseInterrupted(4_000)).toBe(0);
  });

  test('crawl-frontier-counts-inlinks-and-orphans', async () => {
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
    const entry = (url: string) => repo.frontierEntry(run.id, url);
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/', depth: 0, source: 'start' }])).toBe(1);
    expect(await entry('https://example.com/')).toEqual({ url: 'https://example.com/', depth: 0, state: 'queued', inlinks: 0, fromSitemap: false });
    // Sitemap seeds: listed, not inlinks.
    expect(await repo.enqueue(run.id, ['a', 'b', 'c', 'd'].map((p) => ({ url: `https://example.com/${p}`, depth: 1, source: 'sitemap' as const })))).toBe(4);
    expect(await entry('https://example.com/a')).toMatchObject({ depth: 1, inlinks: 0, fromSitemap: true });
    expect(await repo.orphanCount(run.id)).toBe(4);
    // Links from crawled pages: one inlink per discovering page (a URL twice on one page counts once).
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/a', depth: 1, source: 'link' }, { url: 'https://example.com/a', depth: 1, source: 'link' }, { url: 'https://example.com/e', depth: 3, source: 'link' }])).toBe(1);
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/a', depth: 2, source: 'link' }, { url: 'https://example.com/e', depth: 2, source: 'link' }])).toBe(0);
    expect(await entry('https://example.com/a')).toMatchObject({ depth: 1, inlinks: 2, fromSitemap: true });
    // Met again while queued: the lower depth is kept.
    expect(await entry('https://example.com/e')).toMatchObject({ depth: 2, inlinks: 2, fromSitemap: false });
    // Once done, depth stays; inlinks still count; a later sitemap listing sets the flag.
    await repo.markDone(run.id, ['https://example.com/e']);
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/e', depth: 1, source: 'link' }, { url: 'https://example.com/b', depth: 0, source: 'start' }])).toBe(0);
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/e', depth: 1, source: 'sitemap' }])).toBe(0);
    expect(await entry('https://example.com/e')).toMatchObject({ depth: 2, state: 'done', inlinks: 3, fromSitemap: true });
    // `b` met as a start-like seed: no inlink, depth lowered while queued.
    expect(await entry('https://example.com/b')).toMatchObject({ depth: 0, inlinks: 0, fromSitemap: true });
    // Orphans: listed by a sitemap, linked by no crawled page.
    expect(await repo.orphansOf(run.id, { limit: 10, offset: 0 })).toEqual(['https://example.com/b', 'https://example.com/c', 'https://example.com/d']);
    expect(await repo.orphansOf(run.id, { limit: 1, offset: 1 })).toEqual(['https://example.com/c']);
    expect(await repo.orphanCount(run.id)).toBe(3);
    expect(await entry('https://example.com/never')).toBeNull();
  });

  test('crawl-reads-are-lenient', async () => {
    const run = await repo.createRun({ projectId: PROJECT, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
    // A finding id no longer a crawl rule (or malformed) is dropped on read; the row stays.
    expect(await repo.putPage(page(run.id, 'https://example.com/'))).toBe(true);
    raw
      .prepare('UPDATE crawl_pages SET findings = ? WHERE run_id = ?')
      .run(JSON.stringify([{ id: 'title-missing', severity: 'error' }, { id: 'retired-rule', severity: 'warning' }, { id: 'og-title-missing', severity: 'info' }, { id: 'h1-missing', severity: 'fatal' }, 'junk']), run.id);
    expect((await repo.getPage(run.id, 'https://example.com/'))?.findings).toEqual([{ id: 'title-missing', severity: 'error' }]);
    raw.prepare("UPDATE crawl_pages SET findings = 'not json' WHERE run_id = ?").run(run.id);
    expect((await repo.getPage(run.id, 'https://example.com/'))?.findings).toEqual([]);
    expect(await repo.pagesOf(run.id, { limit: 10, offset: 0 })).toHaveLength(1);
    // Strict on write: an unknown finding id is still refused.
    expect(await repo.putPage({ ...page(run.id, 'https://example.com/x'), findings: [{ id: 'retired-rule' as never, severity: 'info' }] })).toBe(false);

    // Settings that no longer parse: the run is still listed (settings null) and deletable.
    for (const settings of ['{"startUrl":"https://example.com/","scope":"galaxy"}', 'not json', JSON.stringify({ ...defaultCrawlSettings('https://elsewhere.example.com/') })]) {
      raw.prepare('UPDATE crawl_runs SET settings = ? WHERE id = ?').run(settings, run.id);
      expect(await repo.getRun(run.id)).toMatchObject({ id: run.id, startUrl: 'https://example.com/', settings: null, state: 'queued' });
    }
    expect((await repo.listRuns({ projectId: PROJECT })).map((r) => r.id)).toEqual([run.id]);
    expect(CrawlRunViewSchema.safeParse(await repo.getRun(run.id)).success).toBe(true);
    expect(await repo.deleteRun(run.id)).toBe(true);
    expect(await repo.listRuns()).toEqual([]);
    // Strict on write: invalid settings are refused.
    await expect(repo.createRun({ projectId: null, settings: { ...defaultCrawlSettings('https://example.com/'), maxPages: 0 }, now: 1 })).rejects.toThrow();
  });

  test('crawl-writes-rethrow-other-errors', async () => {
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
    // Only "no such crawl run" answers false / 0 ...
    expect(await repo.putPage(page(uuidv7(), 'https://example.com/'))).toBe(false);
    expect(await repo.enqueue(uuidv7(), [{ url: 'https://example.com/', depth: 0, source: 'start' }])).toBe(0);
    // ... any other failure is thrown, nothing written.
    raw.exec("CREATE TRIGGER crawl_pages_test_fail BEFORE INSERT ON crawl_pages BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    raw.exec("CREATE TRIGGER crawl_frontier_test_fail BEFORE INSERT ON crawl_frontier BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    // (Drizzle may wrap the SQLite error; SQLite's message is on it or its cause.)
    const diskOnFire = (error: unknown) => error instanceof Error && `${error.message} ${String((error.cause as Error | undefined)?.message)}`.includes('disk on fire');
    await expect(repo.putPage(page(run.id, 'https://example.com/'))).rejects.toSatisfy(diskOnFire);
    await expect(repo.enqueue(run.id, [{ url: 'https://example.com/', depth: 0, source: 'start' }])).rejects.toSatisfy(diskOnFire);
    expect(count('crawl_pages')).toBe(0);
    expect(count('crawl_frontier')).toBe(0);
  });

  test('crawl-delete-run-purges-rows', async () => {
    const run = await repo.createRun({ projectId: PROJECT, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
    const kept = await repo.createRun({ projectId: PROJECT, settings: defaultCrawlSettings('https://example.com/'), now: 2_000 });
    for (const id of [run.id, kept.id]) {
      await repo.putPage(page(id, 'https://example.com/'));
      await repo.putLinks(id, 'https://example.com/', [{ toUrl: 'https://example.com/a', internal: true, nofollow: false }]);
      await repo.enqueue(id, [{ url: 'https://example.com/a', depth: 1, source: 'link' }]);
    }
    const rows = (id: string) => Object.fromEntries(SITE_CRAWL_TABLES.map((table) => [table, count(table, table === 'crawl_runs' ? 'id = ?' : 'run_id = ?', id)]));
    expect(rows(run.id)).toEqual({ crawl_runs: 1, crawl_pages: 1, crawl_links: 1, crawl_frontier: 1 });

    expect(await repo.deleteRun(run.id)).toBe(true);
    expect(rows(run.id)).toEqual({ crawl_runs: 0, crawl_pages: 0, crawl_links: 0, crawl_frontier: 0 });
    expect(rows(kept.id)).toEqual({ crawl_runs: 1, crawl_pages: 1, crawl_links: 1, crawl_frontier: 1 });
    expect(await repo.deleteRun(run.id)).toBe(false);
    expect(await repo.listRuns({ projectId: PROJECT })).toHaveLength(1);

    // The cascade is the trigger's, whoever deletes the run.
    raw.prepare('DELETE FROM crawl_runs WHERE id = ?').run(kept.id);
    expect(rows(kept.id)).toEqual({ crawl_runs: 0, crawl_pages: 0, crawl_links: 0, crawl_frontier: 0 });

    // A crawl that writes after its run was deleted writes nothing.
    expect(await repo.putPage(page(run.id, 'https://example.com/late'))).toBe(false);
    expect(await repo.enqueue(run.id, [{ url: 'https://example.com/late', depth: 1, source: 'link' }])).toBe(0);
    expect(accepts("INSERT INTO crawl_links (run_id, from_page, to_url, internal, nofollow) VALUES (?, 1, 'https://example.com/', 1, 0)", run.id)).toBe(false);
    expect(accepts("INSERT INTO crawl_frontier (run_id, url, depth, state) VALUES (?, 'https://example.com/', 0, 'queued')", run.id)).toBe(false);
    for (const table of SITE_CRAWL_TABLES) expect(count(table), table).toBe(0);
  });

  test('crawl-delete-project-runs-in-chunks', async () => {
    const settings = defaultCrawlSettings('https://example.com/');
    const big = await repo.createRun({ projectId: PROJECT, settings, now: 1_000 });
    const small = await repo.createRun({ projectId: PROJECT, settings, now: 2_000 });
    const elsewhere = await repo.createRun({ projectId: OTHER_PROJECT, settings, now: 3_000 });
    const loose = await repo.createRun({ projectId: null, settings, now: 4_000 });
    // More rows than one delete chunk in every table of the big run.
    const rows = CRAWL_LIMITS.deleteChunkRows + 7;
    const fill = raw.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO crawl_frontier (run_id, url, depth, state) SELECT ?, 'https://example.com/f' || i, 1, 'done' FROM n`);
    fill.run(rows, big.id);
    raw
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO crawl_pages (run_id, url, depth, outcome, robots_crawl, robots_googlebot, link_total, links_cut, findings, outlinks, bytes, fetched_at)
      SELECT ?, 'https://example.com/p' || i, 1, 'crawled', 'allowed', 'allowed', 0, 0, '[]', 0, 0, 1 FROM n`)
      .run(rows, big.id);
    raw
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO crawl_links (run_id, from_page, to_url, internal, nofollow) SELECT ?, 1, 'https://example.com/l' || i, 1, 0 FROM n`)
      .run(rows * 2, big.id);
    for (const run of [small, elsewhere, loose]) await repo.enqueue(run.id, [{ url: 'https://example.com/', depth: 0, source: 'start' }]);

    expect(await repo.projectsWithRuns([PROJECT, OTHER_PROJECT, uuidv7(), PROJECT])).toEqual([PROJECT, OTHER_PROJECT]);
    expect(await repo.projectsWithRuns([])).toEqual([]);

    // The delete yields between chunks, so this observer runs while it is in progress and sees the
    // run's links fall one chunk at a time, before its pages and frontier go and the run row last.
    const deleting = repo.deleteRunsOfProject(PROJECT);
    const seen: { links: number; pages: number; runs: number }[] = [];
    for (let settled = false; !settled; ) {
      seen.push({ links: count('crawl_links', 'run_id = ?', big.id), pages: count('crawl_pages', 'run_id = ?', big.id), runs: count('crawl_runs', 'id = ?', big.id) });
      settled = await Promise.race([deleting.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))]);
    }
    expect(await deleting).toBe(2);
    const linkCounts = [...new Set(seen.map((s) => s.links))];
    expect(linkCounts).toEqual(expect.arrayContaining([rows * 2 - CRAWL_LIMITS.deleteChunkRows]));
    expect(linkCounts.every((n) => n === rows * 2 || n % CRAWL_LIMITS.deleteChunkRows === (rows * 2) % CRAWL_LIMITS.deleteChunkRows || n === 0)).toBe(true);
    // The run row stays until its rows are gone (links first, then pages).
    expect(seen.some((s) => s.links === 0 && s.pages > 0 && s.runs === 1)).toBe(true);
    for (const run of [big, small]) for (const table of SITE_CRAWL_TABLES) expect(count(table, table === 'crawl_runs' ? 'id = ?' : 'run_id = ?', run.id), table).toBe(0);
    for (const run of [elsewhere, loose]) expect(await repo.getRun(run.id)).not.toBeNull();
    expect(await repo.projectsWithRuns([PROJECT, OTHER_PROJECT])).toEqual([OTHER_PROJECT]);
    expect(await repo.deleteRunsOfProject(PROJECT)).toBe(0);
  });

  test('crawl-store-exposes-the-repository', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-db-crawl-'));
    try {
      const store = openSessionStore({ dir });
      const run = await store.siteCrawl.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
      expect((await store.siteCrawl.listRuns()).map((r) => r.id)).toEqual([run.id]);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
