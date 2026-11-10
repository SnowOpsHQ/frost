// Spec: specs/site-crawl.spec.ts (CRAWL_AVAILABLE, CRAWL_REFUSALS, CrawlServiceAnswer), specs/site-crawl.schema.ts
// (CrawlStatusViewSchema, CrawlStartInputSchema), specs/data-sources.spec.ts (LEGAL_GATE_NOTE)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: The service); plan
// docs/plans/phase-12-big-bets.md "As built" (legal gates: main refuses start and resume while `crawl` is closed)
import { afterEach, describe, expect, test } from 'vitest';
import { LEGAL_GATE_NOTE, type LegalGateId } from '@app/specs/data-sources.spec';
import { CrawlStatusViewSchema } from '@app/specs/site-crawl.schema';
import { CRAWL_AVAILABLE } from '@app/specs/site-crawl.spec';
import { createLegalGates } from '../../data-sources/gates';
import { createCrawler } from '../crawler';
import { createCrawlService } from '../service';
import { fakeClock, fakeFetcher, htmlPage, inProcessAnalyse, settingsFor, tempStore } from './run-fakes';

const HOME = 'https://example.com/';
const PROJECT = '01900000-0000-7000-8000-0000000000aa';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(isOpen: (id: LegalGateId) => boolean = () => true, projectLive: (id: string) => Promise<boolean> = async () => true) {
  const db = tempStore();
  cleanups.push(db.close);
  const now = fakeClock();
  const fetcher = fakeFetcher((url) => (url.startsWith(HOME) ? htmlPage(url, ['/next']) : undefined), now);
  const crawler = createCrawler({ repo: db.store.siteCrawl, fetcher, analyse: inProcessAnalyse, projectLive, now });
  const service = createCrawlService({ repo: db.store.siteCrawl, crawler: () => crawler, isOpen, projectLive, now, log: () => undefined });
  return { ...db, fetcher, service, repo: db.store.siteCrawl };
}

describe('the crawl service', () => {
  test('crawl-gate-refuses-in-main', async () => {
    // As shipped: L6 has no owner's note, so the gate is closed and main refuses, whatever is sent.
    expect(CRAWL_AVAILABLE).toBe(false);
    const gates = createLegalGates({ packaged: true, switchValue: 'crawl' });
    expect(gates.isOpen('crawl')).toBe(false);
    const t = setup((id) => gates.isOpen(id));
    expect(await t.service.start({ settings: settingsFor(HOME), projectId: null })).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    // A paused run (from a build where the gate was open) is listed, but not resumed.
    const paused = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.updateRun(paused.id, { state: 'paused', reason: 'user' }, 2);
    expect(await t.service.resume(paused.id)).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    expect(t.fetcher.fetched).toEqual([]);
    expect(t.count('SELECT count(*) AS n FROM crawl_runs')).toBe(1);
    // The view carries the gate; viewing, cancelling and deleting are never gated.
    const view = await t.service.status();
    expect(CrawlStatusViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ available: false, activeRunId: null });
    expect(view.runs.map((run) => run.id)).toEqual([paused.id]);
    expect(await t.service.cancel(paused.id)).toEqual({ status: 'ok' });
    expect(await t.repo.getRun(paused.id)).toMatchObject({ state: 'cancelled', reason: 'user' });
    expect(await t.service.delete(paused.id)).toEqual({ status: 'ok' });
    expect(t.count('SELECT count(*) AS n FROM crawl_runs')).toBe(0);
  });

  test('crawl-start-checks-its-input', async () => {
    const t = setup();
    expect(await t.service.start({ settings: { ...settingsFor(HOME), pattern: '.*' }, projectId: null })).toEqual({ status: 'refused', reason: 'invalid-settings' });
    expect(await t.service.start({ settings: settingsFor('http://127.0.0.1:3000/', { scope: 'site' }), projectId: null })).toEqual({ status: 'refused', reason: 'invalid-settings' });
    expect(await t.service.start('nonsense')).toEqual({ status: 'refused', reason: 'invalid-settings' });
    // A project that is not live: refused, nothing stored.
    const gone = setup(() => true, async () => false);
    expect(await gone.service.start({ settings: settingsFor(HOME), projectId: PROJECT })).toEqual({ status: 'refused', reason: 'not-found' });
    expect(gone.count('SELECT count(*) AS n FROM crawl_runs')).toBe(0);
    expect(await t.service.resume('01900000-0000-7000-8000-0000000000ff')).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('crawl-one-at-a-time', async () => {
    const t = setup();
    const held = t.fetcher.hold(HOME);
    const first = await t.service.start({ settings: settingsFor(HOME, { maxPages: 2 }), projectId: null });
    expect(first.status).toBe('started');
    await held.started;
    expect(await t.service.start({ settings: settingsFor(`${HOME}x`), projectId: null })).toEqual({ status: 'refused', reason: 'busy' });
    const runId = (first as { runId: string }).runId;
    expect((await t.service.status()).activeRunId).toBe(runId);
    // Two starts at once: one runs, the other is busy.
    held.release();
    await t.service.idle();
    const both = await Promise.all([t.service.start({ settings: settingsFor(`${HOME}a`), projectId: null }), t.service.start({ settings: settingsFor(`${HOME}b`), projectId: null })]);
    expect(both.map((answer) => answer.status).sort()).toEqual(['refused', 'started']);
    await t.service.idle();
  });

  test('crawl-settings-unreadable-is-not-resumable', async () => {
    const t = setup();
    const run = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 1 });
    await t.repo.updateRun(run.id, { state: 'paused', reason: 'user' }, 2);
    // A newer build's settings (or a tampered file): listed with `settings: null`, never resumed, still deletable.
    const writable = new (await import('node:sqlite')).DatabaseSync(t.store.file);
    writable.prepare('UPDATE crawl_runs SET settings = ? WHERE id = ?').run('{"startUrl":"https://example.com/","future":true}', run.id);
    writable.close();
    expect((await t.service.status()).runs[0]).toMatchObject({ id: run.id, settings: null });
    expect(await t.service.resume(run.id)).toEqual({ status: 'refused', reason: 'not-resumable' });
    const done = await t.repo.createRun({ projectId: null, settings: settingsFor(HOME), now: 3 });
    await t.repo.updateRun(done.id, { state: 'done' }, 4);
    expect(await t.service.resume(done.id)).toEqual({ status: 'refused', reason: 'not-resumable' });
    expect(await t.service.delete(run.id)).toEqual({ status: 'ok' });
    expect(t.fetcher.fetched).toEqual([]);
  });

  test('crawl-start-racing-a-project-delete', async () => {
    // The start's own project check passes (held open a moment); the project is deleted while the start is still claiming.
    let calls = 0;
    let open!: () => void;
    const held = new Promise<void>((resolve) => (open = resolve));
    let live = true;
    const projectLive = async () => {
      calls += 1;
      if (calls === 1) {
        await held;
        return true;
      }
      return live;
    };
    const t = setup(() => true, projectLive);
    const order: string[] = [];
    const starting = t.service.start({ settings: settingsFor(HOME), projectId: PROJECT }).then((answer) => (order.push('started'), answer));
    live = false;
    const deleting = t.service.deleteProjectCrawls(PROJECT).then((n) => (order.push('deleted'), n));
    open();
    expect((await starting).status).toBe('started');
    await deleting;
    await t.service.idle();
    // The delete waited for the start's claim, then stopped its run; the run checked its project before anything: no fetch, no rows.
    expect(order).toEqual(['started', 'deleted']);
    expect(t.fetcher.fetched).toEqual([]);
    for (const table of ['crawl_runs', 'crawl_pages', 'crawl_frontier']) expect(t.count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    // A resume racing a delete: the same.
    const u = setup(() => true, async () => true);
    const run = await u.repo.createRun({ projectId: PROJECT, settings: settingsFor(HOME), now: 1 });
    await u.repo.updateRun(run.id, { state: 'paused', reason: 'user' }, 2);
    const resuming = u.service.resume(run.id);
    const deleted = u.service.deleteProjectCrawls(PROJECT);
    expect(await resuming).toEqual({ status: 'resumed', runId: run.id });
    await deleted;
    await u.service.idle();
    expect(u.count('SELECT count(*) AS n FROM crawl_runs')).toBe(0);
    expect(u.count('SELECT count(*) AS n FROM crawl_pages')).toBe(0);
  });

  test('crawl-delete-of-a-running-run-waits-for-it', async () => {
    const t = setup();
    const held = t.fetcher.hold(`${HOME}next`);
    const answer = await t.service.start({ settings: settingsFor(HOME), projectId: null });
    const runId = (answer as { runId: string }).runId;
    await held.started;
    expect(await t.service.delete(runId)).toEqual({ status: 'ok' });
    expect(await t.repo.getRun(runId)).toBeNull();
    for (const table of ['crawl_pages', 'crawl_links', 'crawl_frontier']) expect(t.count(`SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect((await t.service.status()).activeRunId).toBeNull();
  });
});
