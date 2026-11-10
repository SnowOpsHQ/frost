// Spec: specs/site-crawl.spec.ts (CRAWL_LIMITS, CRAWL_REFUSED_OUTCOMES, CRAWL_FAILED_OUTCOMES), specs/site-crawl.schema.ts
// (CrawlPageRowSchema)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: the frontier as the authority;
// Deleting a project deletes its crawls); plan docs/plans/phase-12-big-bets.md Decision 6 (startup recovery:
// `deletedProjectsWithRows` also lists a tombstoned project that still has crawl runs) and Task 6b; the whole-branch
// review's `crawl-pacing-survives-a-restart` (CRAWL_PACING_LIMITS, CRAWL_PACING_MIGRATION_IDS, CrawlPacingSnapshotSchema)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultCrawlSettings, type CrawlPageRow } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS, CRAWL_PACING_LIMITS, CRAWL_PACING_MIGRATION_IDS } from '@app/specs/site-crawl.spec';
import { MIGRATIONS } from '../../migrations';
import { openSessionStore, type SessionStore } from '../../store';
import { SITE_CRAWL_PACING_MIGRATIONS } from '../migrations';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function store(): SessionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-crawl-db-'));
  const opened = openSessionStore({ dir });
  cleanups.push(async () => {
    await opened.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return opened;
}

const row = (runId: string, url: string, outcome: CrawlPageRow['outcome'], bytes = 0): CrawlPageRow => ({
  runId,
  url,
  depth: 0,
  outcome,
  status: outcome === 'crawled' ? 200 : null,
  finalUrl: null,
  contentType: null,
  title: null,
  canonical: null,
  indexable: null,
  robotsCrawl: 'allowed',
  robotsGooglebot: 'allowed',
  wordCount: null,
  linkTotal: 0,
  linksCut: false,
  score: null,
  findings: [],
  outlinks: 0,
  bytes,
  fetchedAt: 1,
});

describe('the crawl run storage (Task 6b)', () => {
  test('crawl-frontier-knows-urls-and-query-variants', async () => {
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
    await repo.enqueue(run.id, [
      { url: 'https://example.com/', depth: 0, source: 'start' },
      { url: 'https://example.com/list', depth: 1, source: 'link' },
      { url: 'https://example.com/list?page=1', depth: 1, source: 'link' },
      { url: 'https://example.com/list?page=2', depth: 1, source: 'link' },
      { url: 'https://example.com/list/sub?page=1', depth: 1, source: 'link' },
      { url: 'https://example.com/lists?page=1', depth: 1, source: 'link' },
    ]);
    expect(await repo.knownUrls(run.id, ['https://example.com/list?page=2', 'https://example.com/list?page=3', 'https://example.com/'])).toEqual(new Set(['https://example.com/list?page=2', 'https://example.com/']));
    expect(await repo.knownUrls(run.id, [])).toEqual(new Set());
    // Variants of exactly one path: its query strings, never a longer path's.
    expect(await repo.queryVariantCount(run.id, 'https://example.com/list')).toBe(2);
    expect(await repo.queryVariantCount(run.id, 'https://example.com/list/sub')).toBe(1);
    expect(await repo.queryVariantCount(run.id, 'https://example.com/nothing')).toBe(0);
    // Many URLs at once (past one statement's parameters).
    const many = Array.from({ length: 1_200 }, (_, i) => `https://example.com/m${i}`);
    await repo.enqueue(run.id, many.slice(0, 600).map((url) => ({ url, depth: 2, source: 'link' as const })));
    expect((await repo.knownUrls(run.id, many)).size).toBe(600);
  });

  test('crawl-page-counts-by-outcome', async () => {
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1 });
    for (const [i, outcome] of (['crawled', 'crawled', 'not-html', 'redirected', 'blocked-by-robots', 'out-of-scope', 'timeout', 'unreachable', 'parse-failed'] as const).entries()) {
      expect(await repo.putPage(row(run.id, `https://example.com/p${i}`, outcome, 100))).toBe(true);
    }
    expect(await repo.pageCounts(run.id)).toEqual({ pages: 9, refused: 2, failed: 2, bytes: 900 });
    const other = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 2 });
    expect(await repo.pageCounts(other.id)).toEqual({ pages: 0, refused: 0, failed: 0, bytes: 0 });
  });

  test('crawl-run-created-with-its-start-entry', async () => {
    // Council review round 3, item J: the run and its start URL's frontier entry are one write.
    const { siteCrawl: repo } = store();
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1, start: 'https://example.com/' });
    expect(run.counts.queued).toBe(1);
    expect(await repo.getRun(run.id)).toMatchObject({ state: 'queued', counts: { queued: 1 } });
    expect(await repo.frontierEntry(run.id, 'https://example.com/')).toEqual({ url: 'https://example.com/', depth: 0, state: 'queued', inlinks: 0, fromSitemap: false });
    expect(await repo.nextQueued(run.id, 10)).toEqual([{ url: 'https://example.com/', depth: 0 }]);
    // A start that is no crawl URL: nothing written, the run included.
    await expect(repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 2, start: 'javascript:alert(1)' })).rejects.toThrow();
    expect(await repo.listRuns()).toHaveLength(1);
  });

  test('deleted-projects-with-rows-lists-crawl-only-projects', async () => {
    const opened = store();
    const project = (await opened.changeIntel.createProject('Crawled only', 1_000))!;
    const live = (await opened.changeIntel.createProject('Live', 1_001))!;
    await opened.siteCrawl.createRun({ projectId: project.id, settings: defaultCrawlSettings('https://example.com/'), now: 1_002 });
    await opened.siteCrawl.createRun({ projectId: live.id, settings: defaultCrawlSettings('https://example.com/'), now: 1_003 });
    expect(await opened.changeIntel.deletedProjectsWithRows()).toEqual([]);
    expect(await opened.changeIntel.tombstoneProject(project.id, 2_000)).toBe(true);
    // A tombstoned project whose only rows are a crawl's is listed (startup recovery deletes them); a live one never.
    expect(await opened.changeIntel.deletedProjectsWithRows()).toEqual([project.id]);
    expect(await opened.siteCrawl.deleteRunsOfProject(project.id)).toBe(1);
    expect(await opened.changeIntel.deletedProjectsWithRows()).toEqual([]);
    expect(CRAWL_LIMITS.maxListedRuns).toBeGreaterThan(0);
  });

  test('crawl-run-pacing-stored', async () => {
    // `0246` adds `crawl_runs.pacing` in its own migration, in id order right after the SERP-API readings' `0245`.
    expect(SITE_CRAWL_PACING_MIGRATIONS.map((m) => m.id)).toEqual([...CRAWL_PACING_MIGRATION_IDS]);
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids.indexOf('0246_crawl_run_pacing')).toBe(ids.indexOf('0245_serp_api_readings') + 1);
    expect([...ids].sort()).toEqual(ids);

    const opened = store();
    const repo = opened.siteCrawl;
    const run = await repo.createRun({ projectId: null, settings: defaultCrawlSettings('https://example.com/'), now: 1_000 });
    // A run that never paused has none.
    expect(await repo.runPacing(run.id)).toEqual([]);
    const pacing = [
      { host: 'example.com', waitUntil: 61_000, inARow: 5 },
      { host: 'cdn.example.com', waitUntil: 2_000, inARow: 0 },
    ];
    expect(await repo.updateRun(run.id, { state: 'paused', reason: 'slow-down', pacing }, 1_500)).toBe(true);
    expect(await repo.runPacing(run.id)).toEqual(pacing);
    // A patch without `pacing` leaves it; `null` clears it.
    await repo.updateRun(run.id, { state: 'running', reason: null }, 1_600);
    expect(await repo.runPacing(run.id)).toEqual(pacing);
    await repo.updateRun(run.id, { pacing: null }, 1_700);
    expect(await repo.runPacing(run.id)).toEqual([]);
    // Bounded on the way in: invalid entries are dropped (never failing the run's end), at most `maxPacedHosts` kept.
    const long = 'a'.repeat(CRAWL_PACING_LIMITS.maxHostChars + 1);
    const many = Array.from({ length: CRAWL_LIMITS.maxPacedHosts + 10 }, (_, i) => ({ host: `h${i}.example`, waitUntil: 5_000, inARow: 1 }));
    await repo.updateRun(run.id, { pacing: [{ host: long, waitUntil: 5_000, inARow: 1 }, { host: 'x.example', waitUntil: -1, inARow: 1 }, { host: 'y.example', waitUntil: 5_000, inARow: 99 }, ...many] }, 1_800);
    expect(await repo.runPacing(run.id)).toEqual(many.slice(0, CRAWL_LIMITS.maxPacedHosts));
    // Leniently on the way out: a tampered value reads as none, or as its valid entries; the column's CHECK bounds its size.
    const raw = new DatabaseSync(opened.file);
    try {
      raw.prepare('UPDATE crawl_runs SET pacing = ? WHERE id = ?').run('not json', run.id);
      expect(await repo.runPacing(run.id)).toEqual([]);
      raw.prepare('UPDATE crawl_runs SET pacing = ? WHERE id = ?').run(JSON.stringify([{ host: 'ok.example', waitUntil: 9, inARow: 2 }, { host: 7 }]), run.id);
      expect(await repo.runPacing(run.id)).toEqual([{ host: 'ok.example', waitUntil: 9, inARow: 2 }]);
      expect(() => raw.prepare('UPDATE crawl_runs SET pacing = ? WHERE id = ?').run('x'.repeat(200_000), run.id)).toThrow(/CHECK/);
    } finally {
      raw.close();
    }
    expect(await repo.runPacing('01900000-0000-7000-8000-000000000000')).toEqual([]);
  });
});
