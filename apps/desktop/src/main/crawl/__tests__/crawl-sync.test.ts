// Spec: specs/site-crawl.spec.ts (CRAWL_RUN_REASONS: project-deleted), specs/sync.spec.ts (SYNC_CONFIG_FILE_NAME, SYNC_TABLES)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: Deleting a project deletes its
// crawls), specs/sync-engine.feature.md (Service); plan docs/plans/phase-12-big-bets.md Decision 6 (a synced tombstone runs
// the same cleanup when the pull ends, in its own try) and Task 6b
//
// Two devices are real session databases; the replica is the sync engine tests' libSQL fixture. Nothing restarts and no
// capture run happens: the pull alone deletes the crawls.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { LibsqlDriver } from '@app/db/driver-libsql';
import { createNodeSqliteDriver } from '@app/db/driver-node-sqlite';
import type { SqlDriver } from '@app/db/driver-types';
import { openSessionStore, type SessionStore } from '@app/db';
import { SYNC_CONFIG_FILE_NAME } from '@app/specs/sync.spec';
import type { SafeStorageLike } from '../../sync/config';
import { ensureSyncState, runSyncPass } from '../../sync/engine';
import { startSyncService } from '../../sync/service';
import { openFixture, type Fixture } from '../../sync/__tests__/fixtures';
import { createCrawler } from '../crawler';
import { createCrawlService, type CrawlService } from '../service';
import { fakeClock, fakeFetcher, htmlPage, inProcessAnalyse, settingsFor } from './run-fakes';

const HOME = 'https://example.com/';
const NOW = () => 5_000_000;
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text) => Buffer.from(`v11${Buffer.from(text).toString('hex')}`),
  decryptString: (bytes) => Buffer.from(bytes.toString().slice(3), 'hex').toString(),
};

let fx: Fixture;
const closers: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fx = await openFixture();
  await ensureSyncState(fx.replica);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await fx.close();
});

/** A device: its session store, the engine's driver on the same file, and its userData directory. */
function device(name: string): { store: SessionStore; driver: SqlDriver; userData: string; raw: DatabaseSync } {
  const userData = path.join(fx.dir, `device-${name}`);
  mkdirSync(userData);
  const store = openSessionStore({ dir: userData });
  const raw = new DatabaseSync(store.file, { timeout: 10_000 });
  const driver = createNodeSqliteDriver(raw);
  closers.push(async () => {
    await driver.close();
    await store.close();
  });
  return { store, driver, userData, raw };
}

const CASES = ['running', 'paused', 'done', 'on its final fetch'] as const;

describe('a synced project tombstone', () => {
  test.each(CASES)('synced-tombstone-deletes-crawls-at-pull (a crawl %s)', async (kind) => {
    const a = device('a');
    const b = device('b');
    const projectId = (await a.store.changeIntel.createProject('Site', 1_000))!.id;
    await runSyncPass({ source: a.driver, replica: fx.replica, deviceId: 'device-a', now: NOW });
    await runSyncPass({ source: b.driver, replica: fx.replica, deviceId: 'device-b', now: NOW });
    expect(await b.store.changeIntel.project(projectId)).not.toBeNull();

    // On B, a crawl of the project in the case's state.
    const now = fakeClock();
    const fetcher = fakeFetcher((url) => (url.startsWith(HOME) ? htmlPage(url, ['/a', '/b', '/c']) : undefined), now);
    const projectLive = async (id: string) => (await b.store.changeIntel.project(id)) !== null;
    const crawler = createCrawler({ repo: b.store.siteCrawl, fetcher, analyse: inProcessAnalyse, projectLive, now });
    const crawls: CrawlService = createCrawlService({ repo: b.store.siteCrawl, crawler: () => crawler, isOpen: () => true, projectLive, now, log: () => undefined });
    const held = kind === 'done' ? null : fetcher.hold(kind === 'on its final fetch' ? `${HOME}a` : HOME);
    const answer = await crawls.start({ settings: settingsFor(HOME, { maxPages: 2 }), projectId });
    expect(answer.status).toBe('started');
    if (held) await held.started;
    if (kind === 'paused') await crawls.pause((answer as { runId: string }).runId);
    if (kind === 'done') await crawls.idle();
    const runs = () => b.raw.prepare('SELECT count(*) AS n FROM crawl_runs').get()!['n'];
    const rows = () => ['crawl_runs', 'crawl_pages', 'crawl_links', 'crawl_frontier'].map((table) => Number(b.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']));
    expect(runs()).toBe(1);

    // A deletes the project; the tombstone reaches B by sync pull (B's sync service, local staging over the shared replica).
    expect(await a.store.changeIntel.tombstoneProject(projectId, 2_000)).toBe(true);
    await runSyncPass({ source: a.driver, replica: fx.replica, deviceId: 'device-a', now: NOW });
    writeFileSync(path.join(b.userData, SYNC_CONFIG_FILE_NAME), '{"enabled":true}');
    const logs: string[] = [];
    const replica = fx.replica as LibsqlDriver;
    const shared = Object.assign(Object.create(replica) as LibsqlDriver, { close: async () => undefined });
    const sync = startSyncService({ app: { getPath: () => b.userData }, safeStorage, sessionFile: b.store.file, log: (line) => logs.push(line), platform: 'linux', openReplica: async () => shared, crawls, now: NOW });
    closers.push(() => sync.dispose());
    await sync.whenStarted;
    await sync.idle();
    expect(sync.status()).toMatchObject({ state: 'running', passes: 1 });
    expect(await b.store.changeIntel.project(projectId)).toBeNull();
    // Once the pull completes: no crawl row is left, and the crawl that was running is over.
    expect(rows()).toEqual([0, 0, 0, 0]);
    expect((await crawls.status()).activeRunId).toBeNull();
    // A fetch that answers late writes nothing.
    const fetched = fetcher.fetched.length;
    held?.release();
    await crawls.idle();
    expect(fetcher.fetched).toHaveLength(fetched);
    expect(rows()).toEqual([0, 0, 0, 0]);
    expect(logs.filter((line) => /crawl/.test(line))).toEqual([]);
  });

  test('synced-tombstone-crawl-cleanup-never-fails-the-pass', async () => {
    const a = device('a');
    const b = device('b');
    const projectId = (await a.store.changeIntel.createProject('Site', 1_000))!.id;
    await runSyncPass({ source: a.driver, replica: fx.replica, deviceId: 'device-a', now: NOW });
    await runSyncPass({ source: b.driver, replica: fx.replica, deviceId: 'device-b', now: NOW });
    expect(await a.store.changeIntel.tombstoneProject(projectId, 2_000)).toBe(true);
    await runSyncPass({ source: a.driver, replica: fx.replica, deviceId: 'device-a', now: NOW });
    writeFileSync(path.join(b.userData, SYNC_CONFIG_FILE_NAME), '{"enabled":true}');
    const logs: string[] = [];
    const shared = Object.assign(Object.create(fx.replica as LibsqlDriver) as LibsqlDriver, { close: async () => undefined });
    const failing = {
      projectsWithRuns: async (ids: readonly string[]) => [...ids],
      deleteProjectCrawls: async () => {
        throw new Error('disk I/O error');
      },
    };
    const sync = startSyncService({ app: { getPath: () => b.userData }, safeStorage, sessionFile: b.store.file, log: (line) => logs.push(line), platform: 'linux', openReplica: async () => shared, crawls: failing, now: NOW });
    closers.push(() => sync.dispose());
    await sync.whenStarted;
    await sync.idle();
    // The pass still counts; the failure is one line of its own.
    expect(sync.status()).toMatchObject({ state: 'running', passes: 1 });
    expect(logs.filter((line) => /crawl/.test(line))).toEqual([expect.stringMatching(/^sync: the crawls of a deleted project could not be deleted/)]);
    expect(logs.some((line) => /a pass failed/.test(line))).toBe(false);
  });
});
