// Spec: specs/site-crawl.spec.ts (CRAWL_CSV_COLUMNS, CRAWL_SCORE_LABEL, CRAWL_CSV_READ_ROWS, crawlCsvFileName, CRAWL_WATCH,
// CRAWL_TREE_LIMITS, CRAWL_READ_REFUSALS, CRAWL_PAGE_FLAGS), specs/site-crawl.schema.ts (CrawlWatchViewSchema,
// CrawlPagesAnswerSchema, CrawlStructureAnswerSchema, CrawlCsvAnswerSchema), specs/seo-sidebar.spec.ts (CSV_FORMULA_PREFIXES,
// through `csvCell`), specs/data-sources.spec.ts (LEGAL_GATE_NOTE)
// Acceptance: specs/site-crawl.feature.md (Pages and Site structure, Task 7: Main); plan docs/plans/phase-12-big-bets.md
// Task 7 (`crawl-csv-written-by-main`: the save dialog in main, cells via `csvCell`)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { CrawlCsvAnswerSchema, CrawlPagesAnswerSchema, CrawlStructureAnswerSchema, CrawlWatchViewSchema, type CrawlPageRow } from '@app/specs/site-crawl.schema';
import { CRAWL_CSV_COLUMNS, CRAWL_CSV_READ_ROWS, CRAWL_PAGE_FLAGS, CRAWL_SCORE_LABEL, CRAWL_WATCH, crawlCsvFileName } from '@app/specs/site-crawl.spec';
import { createCrawlChanges, watchedCrawlRepo } from '../changes';
import { createCrawlIpcService, openOwnerOnly } from '../ipc';
import { createCrawlService } from '../service';
import { settingsFor, tempStore } from './run-fakes';

const HOME = 'https://example.com/';
const MISSING = '01900000-0000-7000-8000-0000000000ff';
const NOW = Date.UTC(2026, 10, 10, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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
  fetchedAt: NOW,
  ...changes,
});

function setup(options: { readonly open?: boolean; readonly choose?: (windowId: number | null, name: string) => Promise<string | null> } = {}) {
  const db = tempStore();
  cleanups.push(db.close);
  const changes = createCrawlChanges();
  const repo = watchedCrawlRepo(db.store.siteCrawl, changes.bump);
  const service = createCrawlService({ repo, crawler: () => null, isOpen: () => options.open === true, projectLive: async () => true, onChange: changes.bump, log: () => undefined });
  const chooseCsvPath = vi.fn(options.choose ?? (async () => null));
  const log = vi.fn();
  const ipc = createCrawlIpcService({ service, repo, changes, chooseCsvPath, now: () => NOW, log });
  return { ...db, repo, changes, service, ipc, chooseCsvPath, log };
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-crawl-csv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

const SORTED = { filter: {}, sort: 'order', direction: 'asc' } as const;

describe('the crawl IPC service in main (Task 7)', () => {
  test('crawl-csv-written-by-main', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'crawl.csv');
    const t = setup({ choose: async () => file });
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.putPage(page(run.id, `${HOME}a`, { title: '=HYPERLINK("https://evil.example","x")', findings: [{ id: 'title-too-short', severity: 'warning' }, { id: 'h1-missing', severity: 'error' }] }));
    await t.repo.putPage(page(run.id, `${HOME}b`, { title: '+1 "quoted", comma', linksCut: true, linkTotal: 2_400, wordCount: 12 }));
    await t.repo.putPage(page(run.id, `${HOME}c`, { outcome: 'blocked-by-robots', status: null, indexable: null, score: null, title: null, wordCount: null, robotsCrawl: 'blocked' }));
    await t.repo.enqueue(run.id, [{ url: `${HOME}a`, depth: 1, source: 'link' }]);

    const answer = await t.ipc.exportCsv(7, { runId: run.id, ...SORTED });
    expect(CrawlCsvAnswerSchema.parse(answer)).toEqual({ status: 'saved', rows: 3 });
    // Main's own dialog, parented to the sender's window, offering main's file name; the renderer named no path.
    expect(t.chooseCsvPath).toHaveBeenCalledWith(7, crawlCsvFileName(NOW));
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(lines[0]).toBe(CRAWL_CSV_COLUMNS.join(','));
    expect(lines[0]).toContain(CRAWL_SCORE_LABEL);
    expect(text.toLowerCase()).not.toContain('health score');
    // Every cell through `csvCell`: a formula-leading cell is neutralised, quotes and commas quoted.
    expect(lines[1]).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(lines[1]).toContain('title-too-short h1-missing');
    expect(lines[1]).toContain(',1,'); // its in-link, from the frontier
    expect(lines[2]).toContain(`"'+1 ""quoted"", comma"`);
    expect(lines[2]).toContain(`${CRAWL_PAGE_FLAGS.linksCut}; ${CRAWL_PAGE_FLAGS.clientRendered}`);
    expect(lines[3]!.startsWith(`${HOME}c,,blocked-by-robots,,`)).toBe(true);
    expect(lines[1]).toContain(new Date(NOW).toISOString());

    // The filter and sort the Pages view shows.
    expect(await t.ipc.exportCsv(null, { runId: run.id, filter: { linksCut: true }, sort: 'url', direction: 'asc' })).toEqual({ status: 'saved', rows: 1 });
    expect(readFileSync(file, 'utf8').split('\r\n')).toHaveLength(3);
  });

  test('crawl-csv-reads-in-chunks-and-writes-nothing-unasked', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'big.csv');
    let answer: string | null = file;
    const t = setup({ choose: async () => answer });
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    const many = CRAWL_CSV_READ_ROWS * 2 + 17;
    for (let i = 0; i < many; i++) await t.repo.putPage(page(run.id, `${HOME}p${i}`));
    const pagesByIds = vi.spyOn(t.repo, 'pagesByIds');
    const pagesPage = vi.spyOn(t.repo, 'pagesPage');
    expect(await t.ipc.exportCsv(null, { runId: run.id, ...SORTED })).toEqual({ status: 'saved', rows: many });
    // Read by id, a batch at a time; nothing counted (no `pagesPage`).
    expect(pagesByIds.mock.calls.length).toBe(3);
    expect(pagesByIds.mock.calls.every(([, ids]) => ids.length <= CRAWL_CSV_READ_ROWS)).toBe(true);
    expect(pagesPage).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8').split('\r\n')).toHaveLength(many + 2);
    // Cancelled, or anything but an absolute path: nothing written.
    answer = null;
    expect(await t.ipc.exportCsv(null, { runId: run.id, ...SORTED })).toEqual({ status: 'cancelled' });
    answer = 'relative.csv';
    expect(await t.ipc.exportCsv(null, { runId: run.id, ...SORTED })).toEqual({ status: 'cancelled' });
    // A run that is gone: refused before any dialog.
    t.chooseCsvPath.mockClear();
    expect(await t.ipc.exportCsv(null, { runId: MISSING, ...SORTED })).toEqual({ status: 'refused', reason: 'not-found' });
    expect(t.chooseCsvPath).not.toHaveBeenCalled();
    // A file that cannot be written: `write-failed`, one log line without the path.
    answer = path.join(dir, 'no-such-dir', 'x.csv');
    expect(await t.ipc.exportCsv(null, { runId: run.id, ...SORTED })).toEqual({ status: 'refused', reason: 'write-failed' });
    expect(t.log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('no-such-dir');
  });

  test('crawl-watch-long-polls-changes', async () => {
    const t = setup();
    const v0 = t.changes.version();
    // Nothing newer: the poll waits for the next write to the crawl tables.
    const release = new AbortController();
    let settled = false;
    const waiting = t.ipc.watch(v0, release.signal, null).then((view) => {
      settled = true;
      return view;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    const view = CrawlWatchViewSchema.parse(await waiting);
    expect(view.version).toBeGreaterThan(v0);
    expect(view.status.runs.map((r) => r.id)).toEqual([run.id]);
    expect(view.status.available).toBe(false);
    // A newer version answers at once; an abort (the router's timeout) answers the current view.
    expect((await t.ipc.watch(0, release.signal, null)).version).toBe(view.version);
    const aborted = new AbortController();
    const timedOut = t.ipc.watch(view.version, aborted.signal, null);
    aborted.abort();
    expect((await timedOut).version).toBe(view.version);
    // A page is one change: its row is not counted, the run's counts written after it are.
    await t.repo.putPage(page(run.id, `${HOME}a`));
    expect(t.changes.version()).toBe(view.version);
    const next = t.ipc.watch(view.version, new AbortController().signal, null);
    await t.repo.updateRun(run.id, { counts: { pages: 1 } }, 3);
    expect((await next).version).toBe(view.version + 1);
  });

  test('crawl-watch-evicts-only-the-same-window', async () => {
    const t = setup();
    const latest = t.changes.version();
    const answered: string[] = [];
    const poll = (window: number, name: string) => t.ipc.watch(latest, new AbortController().signal, window).then(() => answered.push(name));
    // Window 1 fills its share; window 2 polls once.
    const first = Array.from({ length: CRAWL_WATCH.maxPending }, (_, i) => poll(1, `w1-${i}`));
    const other = poll(2, 'w2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toEqual([]);
    // One more of window 1's answers window 1's oldest early, never window 2's.
    const extra = poll(1, 'w1-extra');
    await first[0];
    expect(answered).toEqual(['w1-0']);
    t.changes.bump();
    await Promise.all([...first, other, extra]);
    expect(CRAWL_WATCH.maxPending).toBe(4);
    expect(answered.slice(1).sort()).toEqual(['w1-1', 'w1-2', 'w1-3', 'w1-extra', 'w2']);
  });

  test('crawl-csv-dialog-first-then-a-fixed-set-streamed', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'live.csv');
    const calls: string[] = [];
    const t = setup({
      choose: async () => {
        calls.push('dialog');
        return file;
      },
    });
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    const many = CRAWL_CSV_READ_ROWS + 50;
    for (let i = 0; i < many; i++) await t.repo.putPage(page(run.id, `${HOME}p${String(i).padStart(4, '0')}`));
    const pageOrder = vi.spyOn(t.repo, 'pageOrder');
    const batches: number[] = [];
    // A crawl writing while the export runs: a new page that sorts first, and a rewritten one.
    const openCsv = async (target: string) => {
      calls.push('open');
      const sink = await openOwnerOnly(target);
      return {
        write: async (text: string) => {
          batches.push(text.split('\r\n').length - 1);
          await t.repo.putPage(page(run.id, `${HOME}a-new-${batches.length}`));
          await t.repo.putPage(page(run.id, `${HOME}p0001`, { title: 'rewritten' }));
          await sink.write(text);
        },
        close: () => sink.close(),
      };
    };
    const ipc = createCrawlIpcService({ service: t.service, repo: t.repo, changes: t.changes, chooseCsvPath: t.chooseCsvPath, openCsv, now: () => NOW });
    const realOrder = pageOrder.getMockImplementation() ?? t.store.siteCrawl.pageOrder;
    pageOrder.mockImplementation(async (...args) => {
      calls.push('order');
      return realOrder(...args);
    });
    expect(await ipc.exportCsv(null, { runId: run.id, filter: {}, sort: 'url', direction: 'asc' })).toEqual({ status: 'saved', rows: many });
    // The dialog before anything is read or opened; then the batches, appended in turn.
    expect(calls.slice(0, 3)).toEqual(['dialog', 'order', 'open']);
    expect(batches).toEqual([1, CRAWL_CSV_READ_ROWS, 50]);
    const lines = readFileSync(file, 'utf8').split('\r\n').filter((line) => line !== '');
    const urls = lines.slice(1).map((line) => line.split(',')[0]);
    // Exactly the pages there when it began, each once, in order: nothing written meanwhile slipped in.
    expect(urls).toHaveLength(many);
    expect(new Set(urls).size).toBe(many);
    expect(urls.some((url) => url!.includes('a-new'))).toBe(false);
    expect(urls).toEqual([...urls].sort());
  });

  test('crawl-csv-one-export-at-a-time', async () => {
    const dir = tempDir();
    let answer: (file: string | null) => void = () => undefined;
    const t = setup({ choose: () => new Promise<string | null>((resolve) => (answer = resolve)) });
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.putPage(page(run.id, `${HOME}a`));
    const first = t.ipc.exportCsv(null, { runId: run.id, ...SORTED });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await t.ipc.exportCsv(null, { runId: run.id, ...SORTED })).toEqual({ status: 'refused', reason: 'exporting' });
    answer(path.join(dir, 'one.csv'));
    expect(await first).toEqual({ status: 'saved', rows: 1 });
    // Once it is done, the next one runs.
    const again = t.ipc.exportCsv(null, { runId: run.id, ...SORTED });
    await new Promise((resolve) => setImmediate(resolve));
    answer(null);
    expect(await again).toEqual({ status: 'cancelled' });
  });

  test('crawl-ipc-passes-the-gate-through', async () => {
    const t = setup();
    expect(await t.ipc.start({ settings: settingsFor(HOME), projectId: null })).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.updateRun(run.id, { state: 'paused', reason: 'user' }, 2);
    expect(await t.ipc.resume(run.id)).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    expect((await t.ipc.status()).available).toBe(false);
    // Never gated: cancel, delete.
    expect(await t.ipc.cancel(run.id)).toEqual({ status: 'ok' });
    expect(await t.ipc.delete(run.id)).toEqual({ status: 'ok' });
    expect(await t.ipc.delete(run.id)).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('crawl-reads-answer-pages-and-structure', async () => {
    const t = setup();
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.putPage(page(run.id, HOME, { depth: 0 }));
    await t.repo.putPage(page(run.id, `${HOME}blog/one`, { status: 404 }));
    await t.repo.enqueue(run.id, [{ url: `${HOME}orphan`, depth: 1, source: 'sitemap' }]);
    const pages = CrawlPagesAnswerSchema.parse(await t.ipc.pages({ runId: run.id, filter: { status: '4xx' }, sort: 'order', direction: 'asc', offset: 0, limit: 50 }));
    expect(pages).toMatchObject({ status: 'ok', total: 1, offset: 0 });
    expect(pages.status === 'ok' && pages.rows.map((row) => row.url)).toEqual([`${HOME}blog/one`]);
    const root = CrawlStructureAnswerSchema.parse(await t.ipc.structure({ runId: run.id, prefix: null }));
    expect(root).toEqual({
      status: 'ok',
      tree: { prefix: null, nodes: [{ label: 'https://example.com', pages: 2, prefix: HOME, url: null }], more: 0 },
      depths: [
        { depth: 0, pages: 1 },
        { depth: 1, pages: 1 },
      ],
      orphans: { urls: [`${HOME}orphan`], total: 1 },
    });
    const level = await t.ipc.structure({ runId: run.id, prefix: HOME });
    expect(level.status === 'ok' && level.tree.nodes.map((node) => node.label)).toEqual(['', 'blog']);
    // A run that is gone, and a store that fails: answered as data.
    expect(await t.ipc.pages({ runId: MISSING, filter: {}, sort: 'order', direction: 'asc', offset: 0, limit: 50 })).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.ipc.structure({ runId: MISSING, prefix: null })).toEqual({ status: 'refused', reason: 'not-found' });
    vi.spyOn(t.repo, 'pagesPage').mockRejectedValueOnce(Object.assign(new Error('disk I/O error at /secret/path'), { code: 'ERR_SQLITE_ERROR' }));
    expect(await t.ipc.pages({ runId: run.id, filter: {}, sort: 'order', direction: 'asc', offset: 0, limit: 50 })).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(t.log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('/secret/path');
  });
});
