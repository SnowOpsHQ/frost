// Spec: specs/site-crawl.spec.ts (CRAWL_RUN_REASONS: project-deleted), specs/projects.spec.ts (DELETE_PROJECT)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: Deleting a project deletes its
// crawls); plan docs/plans/phase-12-big-bets.md Decision 6 ("Deleting a project deletes its crawls") and Task 6b
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RunState, StartRunAnswer } from '@app/specs/projects.schema';
import type { CaptureRuns } from '../../changes/capture-run';
import { createProjectsService } from '../../changes/projects';
import { createCrawler } from '../crawler';
import { createCrawlService } from '../service';
import { fakeClock, fakeFetcher, htmlPage, inProcessAnalyse, settingsFor, tempStore } from './run-fakes';

const HOME = 'https://example.com/';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const IDLE: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [], blockedReason: null };

function setup() {
  const db = tempStore();
  cleanups.push(db.close);
  const now = fakeClock();
  const fetcher = fakeFetcher((url) => (url.startsWith(HOME) ? htmlPage(url, ['/a', '/b', '/c']) : undefined), now);
  const projectLive = async (id: string) => (await db.store.changeIntel.project(id)) !== null;
  const makeCrawls = () => {
    const crawler = createCrawler({ repo: db.store.siteCrawl, fetcher, analyse: inProcessAnalyse, projectLive, now });
    return createCrawlService({ repo: db.store.siteCrawl, crawler: () => crawler, isOpen: () => true, projectLive, now, log: () => undefined });
  };
  const runs = { start: vi.fn(async (): Promise<StartRunAnswer> => ({ status: 'refused', reason: 'busy' })), cancel: vi.fn(() => true), stop: vi.fn(() => undefined), running: vi.fn(() => null), state: vi.fn(() => IDLE), watch: vi.fn(async () => IDLE) } satisfies CaptureRuns;
  const makeProjects = (crawls: ReturnType<typeof makeCrawls>) =>
    createProjectsService({
      store: db.store.changeIntel,
      files: { unlink: async () => true, lock: async () => () => undefined, fileFor: (hash: string) => hash },
      confirmDelete: async () => true,
      confirmRankRun: async () => true,
      settings: { rankRunDisclosureAccepted: async () => true, setRankRunDisclosureAccepted: async () => true },
      activeUrl: () => null,
      runs,
      crawls,
      now,
      log: () => undefined,
    });
  const rows = () => ['crawl_runs', 'crawl_pages', 'crawl_links', 'crawl_frontier'].map((table) => db.count(`SELECT count(*) AS n FROM ${table}`));
  return { ...db, fetcher, makeCrawls, makeProjects, rows, now };
}

describe('deleting a project deletes its crawls', () => {
  test('project-delete-removes-its-crawls', async () => {
    const t = setup();
    const crawls = t.makeCrawls();
    const projects = t.makeProjects(crawls);
    const created = await projects.create('Crawled only');
    if (created.status !== 'created') throw new Error('not created');
    const projectId = created.project.id;
    // A finished crawl and a running one (held on its second page), and nothing else in the project.
    const first = await crawls.start({ settings: settingsFor(HOME, { maxPages: 2 }), projectId });
    await crawls.idle();
    const held = t.fetcher.hold(`${HOME}a`);
    const second = await crawls.start({ settings: settingsFor(HOME), projectId });
    await held.started;
    expect([first.status, second.status]).toEqual(['started', 'started']);
    expect(t.rows().every((n) => n > 0)).toBe(true);
    // A local delete: the running crawl is cancelled and awaited, then every run and its rows go.
    expect(await projects.remove(projectId)).toMatchObject({ status: 'deleted' });
    expect((await crawls.status()).activeRunId).toBeNull();
    expect(t.rows()).toEqual([0, 0, 0, 0]);
    const fetchedThen = t.fetcher.fetched.length;
    held.release();
    await crawls.idle();
    expect(t.fetcher.fetched).toHaveLength(fetchedThen);
    expect(t.rows()).toEqual([0, 0, 0, 0]);
  });

  test('project-delete-interrupted-is-finished-at-start-up', async () => {
    const t = setup();
    const crawls = t.makeCrawls();
    const projects = t.makeProjects(crawls);
    const created = await projects.create('Crawled only');
    if (created.status !== 'created') throw new Error('not created');
    const projectId = created.project.id;
    await crawls.start({ settings: settingsFor(HOME, { maxPages: 2 }), projectId });
    await crawls.idle();
    // The delete was interrupted after the tombstone by a crash while a crawl ran: its run is left `running`, its rows behind.
    const [run] = await t.store.siteCrawl.listRuns({ projectId });
    expect(await t.store.siteCrawl.updateRun(run!.id, { state: 'running', reason: null, finishedAt: null }, t.now())).toBe(true);
    expect(await t.store.changeIntel.tombstoneProject(projectId, t.now())).toBe(true);
    expect(t.rows()[0]).toBe(1);
    // Start-up recovery: the running run becomes paused (never resumed), the project is listed (its only rows are a crawl's) and its crawls deleted.
    expect(await t.store.changeIntel.deletedProjectsWithRows()).toEqual([projectId]);
    const again = t.makeCrawls();
    expect(await again.startup()).toBe(1);
    expect(await t.store.siteCrawl.getRun(run!.id)).toMatchObject({ state: 'paused', reason: 'interrupted' });
    expect((await again.status()).activeRunId).toBeNull();
    expect(await t.makeProjects(again).purgeDeleted()).toBe(1);
    expect(t.rows()).toEqual([0, 0, 0, 0]);
    expect(await t.store.changeIntel.deletedProjectsWithRows()).toEqual([]);
  });
});
