// Spec: specs/retention.spec.ts (RETENTION_ENFORCE_MIN_INTERVAL_MS, PURGE_LOG_LIMIT, ORPHAN_TMP_MIN_AGE_MS,
// PURGE_NOW, COMPACT_DATABASE, formatBytes, purgeCountsText), specs/retention.schema.ts (answers),
// specs/capture-db.spec.ts (MAX_RETENTION_VERSIONS, MAX_RETENTION_DAYS, UNFILED_PROJECT_ID)
// Acceptance: specs/retention.feature.md (Scenarios); the purge rules: specs/capture-db.feature.md (Retention planning)
import { createHash } from 'node:crypto';
import { lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openSessionStore, uuidv7, type ChangeIntelRepository, type PurgePolicy } from '@app/db';
import { MAX_RETENTION_DAYS, MAX_RETENTION_VERSIONS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  COMPACT_DATABASE,
  ORPHAN_TMP_MIN_AGE_MS,
  PURGE_LOG_LIMIT,
  PURGE_NOW,
  PurgeLogAnswerSchema,
  PurgeNowAnswerSchema,
  RETENTION_ENFORCE_MIN_INTERVAL_MS,
  RetentionPreviewAnswerSchema,
  UsageAnswerSchema,
  compactDialog,
  formatBytes,
  isRetentionPolicy,
  purgeCountsText,
  purgeNowDialog,
  type PurgeCountsView,
  type RetentionPolicyInput,
} from '@app/specs/retention.schema';
import { createScreenshotFiles, type ScreenshotFiles } from '../../screenshots/store';
import { createPurgeFiles } from '../purge-files';
import { createRetentionService, type RetentionServiceDeps } from '../retention';

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const HOUR = 3_600_000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let clock = 1_800_000_000_000;
const tick = () => (clock += 1_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(deps: Partial<RetentionServiceDeps> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-retention-'));
  const opened = openSessionStore({ dir });
  const raw = new DatabaseSync(opened.file, { readOnly: true });
  cleanups.push(() => {
    raw.close();
    void opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const real = createScreenshotFiles(dir);
  const unlinked: string[] = [];
  const files: ScreenshotFiles = { ...real, unlink: vi.fn(async (hash: string) => (unlinked.push(hash), real.unlink(hash))) };
  const state = { running: null as string | null };
  const confirmPurge = vi.fn(async (_name: string, _policy: RetentionPolicyInput, _counts: PurgeCountsView, _bytes: number) => true);
  const confirmCompact = vi.fn(async () => true);
  const log = vi.fn((_message: string) => undefined);
  const store = deps.store ?? opened.changeIntel;
  const service = createRetentionService({
    store,
    files,
    purges: createPurgeFiles({ store, files, log }),
    databaseFile: opened.file,
    running: () => state.running,
    confirmPurge,
    confirmCompact,
    now: () => clock,
    log,
    ...deps,
  });
  const count = (sql: string, ...args: (string | number)[]) => Number((raw.prepare(sql).get(...args) as { n: number }).n);
  const tables = () => Object.fromEntries(['ci_versions', 'ci_captures', 'ci_diffs', 'ci_screenshots', 'ci_purges', 'ci_tombstones'].map((t) => [t, count(`SELECT count(*) AS n FROM ${t}`)]));
  return { dir, service, repo: opened.changeIntel, raw, files, real, unlinked, state, confirmPurge, confirmCompact, log, count, tables, file: opened.file };
}

async function project(repo: ChangeIntelRepository, name: string): Promise<string> {
  const made = await repo.createProject(name, tick());
  if (made === null) throw new Error('not created');
  return made.id;
}

/** A capture of `url` into the project (a diff from the lane's head when the snapshot changed). */
async function capture(repo: ChangeIntelRepository, projectId: string, url: string, snapshot: string, at = tick()) {
  const laneKey = sha(url);
  const head = await repo.latestVersion(laneKey);
  const result = await repo.appendCapture({
    captureId: uuidv7(at),
    versionId: uuidv7(at),
    projectId,
    laneKey,
    pageUrl: url,
    renderProfileJson: null,
    renderProfilePartial: false,
    searchParamsJson: null,
    source: 'manual',
    auditTakenAt: at,
    snapshotJson: JSON.stringify({ snapshot }),
    snapshotHash: sha(snapshot),
    schemaVersion: 1,
    createdAt: at,
    ...(head && head.snapshotHash !== sha(snapshot) ? { diff: { id: uuidv7(at), fromVersionId: head.id, engineVersion: 1, diffJson: '{"d":1}', summaryJson: '{}', changeCount: 1 } } : {}),
  });
  if (result?.status !== 'appended') throw new Error('not appended');
  return result;
}

/** A screenshot row whose file is really written (`png` its bytes). */
async function screenshot(repo: ChangeIntelRepository, files: ScreenshotFiles, projectId: string, url: string, png: string) {
  const at = tick();
  const written = await files.write(Buffer.from(png));
  expect(await repo.appendScreenshot({ id: uuidv7(at), projectId, pageUrl: url, captureId: null, kind: 'viewport', rectJson: null, width: 10, height: 10, bytes: written.bytes, sha256: written.sha256, segments: 1, renderProfileJson: null, searchParamsJson: null, createdAt: at })).toBe(true);
  return written.sha256;
}

const exists = (file: string) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

describe('retention service', () => {
  test('retention-spec-values', () => {
    expect(RETENTION_ENFORCE_MIN_INTERVAL_MS).toBe(24 * HOUR);
    expect(PURGE_LOG_LIMIT).toBe(20);
    expect(ORPHAN_TMP_MIN_AGE_MS).toBe(HOUR);
    expect(isRetentionPolicy('forever', null)).toBe(true);
    expect(isRetentionPolicy('versions', 1)).toBe(true);
    expect(isRetentionPolicy('versions', MAX_RETENTION_VERSIONS)).toBe(true);
    expect(isRetentionPolicy('days', MAX_RETENTION_DAYS)).toBe(true);
    for (const [mode, value] of [['forever', 1], ['versions', 0], ['versions', MAX_RETENTION_VERSIONS + 1], ['days', MAX_RETENTION_DAYS + 1], ['days', 1.5], ['days', null], ['all', null]] as const) {
      expect(isRetentionPolicy(mode, value), `${mode} ${value}`).toBe(false);
    }
    expect([formatBytes(0), formatBytes(999), formatBytes(1_500), formatBytes(2_400_000), formatBytes(1_250_000_000)]).toEqual(['0 B', '999 B', '1.5 kB', '2.4 MB', '1.3 GB']);
    expect(purgeCountsText({ captures: 1, versions: 2, diffs: 1, screenshots: 0 })).toBe('1 capture, 2 versions, 1 diff and 0 screenshots');
    const box = purgeNowDialog('Tea ‮guides', { mode: 'versions', value: 1 }, { captures: 2, versions: 2, diffs: 1, screenshots: 1 }, 12_300);
    expect(box).toMatchObject({ type: 'warning', message: PURGE_NOW.dialog.message, defaultId: 1, cancelId: 1, buttons: ['Purge Now', 'Cancel'] });
    expect(box.detail).toContain('2 captures, 2 versions, 1 diff and 1 screenshot');
    expect(box.detail).toContain('about 12.3 kB');
    expect(box.detail).toContain('“⁨Tea ‮guides⁩”');
    // The saved policy is named; a replacement pattern in a name stays text.
    expect(box.detail).toContain('as its saved retention policy says: keep the last 1 version of each page.');
    expect(purgeNowDialog('7 days', { mode: 'days', value: 30 }, { captures: 1, versions: 0, diffs: 0, screenshots: 0 }, 1).detail).toContain('keep 30 days');
    const odd = purgeNowDialog("Tea $' {bytes} $& $`", { mode: 'forever', value: null }, { captures: 1, versions: 0, diffs: 0, screenshots: 0 }, 1).detail;
    expect(odd).toContain("“⁨Tea $' {bytes} $& $`⁩”");
    expect(odd).toContain('keep everything');
    expect(PURGE_NOW.confirmIndex).not.toBe(PURGE_NOW.dialog.cancelId);
    expect(compactDialog()).toMatchObject({ message: COMPACT_DATABASE.dialog.message, defaultId: COMPACT_DATABASE.dialog.cancelId });
  });

  test('set-retention-validates', async () => {
    const { service, repo } = setup();
    const id = await project(repo, 'Guides');
    expect(await service.setRetention(id, 'versions', 3)).toEqual({ status: 'ok' });
    expect((await repo.project(id))?.retention).toEqual({ mode: 'versions', value: 3 });
    expect(await service.setRetention(id, 'days', 30)).toEqual({ status: 'ok' });
    expect(await service.setRetention(id, 'forever', null)).toEqual({ status: 'ok' });
    expect((await repo.project(id))?.retention).toEqual({ mode: 'forever', value: null });
    // Unfiled has a policy too.
    expect(await service.setRetention(UNFILED_PROJECT_ID, 'versions', 1)).toEqual({ status: 'ok' });
    expect((await repo.project(UNFILED_PROJECT_ID))?.retention).toEqual({ mode: 'versions', value: 1 });
    const bad: [unknown, unknown][] = [['versions', 0], ['versions', MAX_RETENTION_VERSIONS + 1], ['days', MAX_RETENTION_DAYS + 1], ['days', 2.5], ['forever', 3], ['versions', null], ['all', null], ['bogus', 1]];
    for (const [mode, value] of bad) {
      expect(await service.setRetention(id, mode as 'days', value as number), `${String(mode)} ${String(value)}`).toEqual({ status: 'refused', reason: 'invalid-retention' });
    }
    expect((await repo.project(id))?.retention).toEqual({ mode: 'forever', value: null });
    expect(await service.setRetention(uuidv7(tick()), 'days', 3)).toEqual({ status: 'refused', reason: 'not-found' });
    const gone = await project(repo, 'Gone');
    await repo.tombstoneProject(gone, tick());
    expect(await service.setRetention(gone, 'days', 3)).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('preview-writes-nothing', async () => {
    const { service, repo, tables, files } = setup();
    const id = await project(repo, 'Guides');
    for (const text of ['one', 'two', 'three']) await capture(repo, id, A, text);
    await screenshot(repo, files, id, A, 'png one');
    await screenshot(repo, files, id, A, 'png two');
    // Keep everything: nothing to purge.
    expect(await service.retentionPreview(id)).toEqual({ status: 'ok', policy: { mode: 'forever', value: null }, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0 }, bytes: 0 });
    await service.setRetention(id, 'versions', 1);
    const before = tables();
    const preview = RetentionPreviewAnswerSchema.parse(await service.retentionPreview(id));
    const plan = await repo.planPurge({ projectId: id, policy: { mode: 'versions', value: 1 }, now: clock });
    expect(preview).toEqual({ status: 'ok', policy: { mode: 'versions', value: 1 }, counts: plan!.counts, bytes: plan!.bytes });
    expect(plan!.counts).toEqual({ captures: 2, versions: 2, diffs: 2, screenshots: 1 });
    // A dry run: every table as it was, no purge recorded.
    expect(tables()).toEqual(before);
    expect(before['ci_purges']).toBe(0);
    expect(await service.retentionPreview(uuidv7(tick()))).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('purge-now-confirms-and-matches-its-plan', async () => {
    const { service, repo, files, real, unlinked, confirmPurge, count, raw } = setup();
    const id = await project(repo, 'Guides');
    const other = await project(repo, 'Other');
    for (const text of ['one', 'two', 'three']) await capture(repo, id, A, text);
    const gone = await screenshot(repo, files, id, A, 'png only here');
    await screenshot(repo, files, id, A, 'png newest');
    await service.setRetention(id, 'versions', 1);
    const plan = (await repo.planPurge({ projectId: id, policy: { mode: 'versions', value: 1 }, now: clock }))!;
    const preview = await service.retentionPreview(id);

    const answer = PurgeNowAnswerSchema.parse(await service.purgeNow(id));
    // Main asked first, with the plan's counts and bytes; the answer is what the record says.
    expect(confirmPurge).toHaveBeenCalledExactlyOnceWith('Guides', { mode: 'versions', value: 1 }, plan.counts, plan.bytes);
    expect(preview).toMatchObject({ counts: plan.counts, bytes: plan.bytes });
    // Every planned file went (its size is its row's): what was freed is what was planned.
    expect(answer).toEqual({ status: 'purged', counts: plan.counts, bytes: plan.bytes, files: 1 });
    const record = raw.prepare("SELECT * FROM ci_purges WHERE reason = 'purge-now'").all() as Record<string, unknown>[];
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ project_id: id, policy: '{"mode":"versions","value":1}', ...plan.counts, bytes: plan.bytes });
    // One tombstone per planned row, exactly the planned ids.
    const tombstoned = (table: string) => (raw.prepare('SELECT row_id FROM ci_tombstones WHERE purge_id = ? AND table_name = ? ORDER BY row_id').all(record[0]!['id'] as string, table) as { row_id: string }[]).map((row) => row.row_id);
    expect(tombstoned('ci_captures')).toEqual(plan.captureIds);
    expect(tombstoned('ci_versions')).toEqual(plan.versionIds);
    expect(tombstoned('ci_diffs')).toEqual(plan.diffIds);
    expect(tombstoned('ci_screenshots')).toEqual(plan.screenshotIds);
    expect(count('SELECT count(*) AS n FROM ci_versions')).toBe(1);
    // The one file no row names any more is gone; the newest stays.
    expect(unlinked).toEqual([gone]);
    expect(exists(real.fileFor(gone))).toBe(false);
    expect(readdirSync(real.dir).filter((name) => name.endsWith('.png'))).toHaveLength(1);
    // Again: nothing to purge, no dialog.
    confirmPurge.mockClear();
    expect(await service.purgeNow(id)).toEqual({ status: 'empty' });
    expect(confirmPurge).not.toHaveBeenCalled();
    expect(await service.purgeNow(other)).toEqual({ status: 'empty' });
    expect(await service.purgeNow(uuidv7(tick()))).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('purge-now-declined-removes-nothing', async () => {
    const { service, repo, files, tables, confirmPurge, unlinked, state } = setup();
    const id = await project(repo, 'Guides');
    for (const text of ['one', 'two']) await capture(repo, id, A, text);
    await screenshot(repo, files, id, A, 'png one');
    await screenshot(repo, files, id, A, 'png two');
    await service.setRetention(id, 'versions', 1);
    const before = tables();
    confirmPurge.mockResolvedValueOnce(false);
    expect(await service.purgeNow(id)).toEqual({ status: 'refused', reason: 'declined' });
    expect(tables()).toEqual(before);
    expect(unlinked).toEqual([]);
    // A run of the project under way: refused before any dialog; and if one starts while it asks.
    confirmPurge.mockClear();
    state.running = id;
    expect(await service.purgeNow(id)).toEqual({ status: 'refused', reason: 'running' });
    expect(confirmPurge).not.toHaveBeenCalled();
    state.running = null;
    confirmPurge.mockImplementationOnce(async () => ((state.running = id), true));
    expect(await service.purgeNow(id)).toEqual({ status: 'refused', reason: 'running' });
    expect(tables()).toEqual(before);
  });

  test('stale-plan-asks-again', async () => {
    const { service, repo, confirmPurge, tables } = setup();
    const id = await project(repo, 'Guides');
    for (const text of ['one', 'two']) await capture(repo, id, A, text);
    await service.setRetention(id, 'versions', 1);
    // A capture lands while the dialog is up: the plan is stale, so it is planned and asked again.
    confirmPurge.mockImplementationOnce(async () => (await capture(repo, id, A, 'three'), true));
    const answer = await service.purgeNow(id);
    expect(confirmPurge).toHaveBeenCalledTimes(2);
    expect(confirmPurge.mock.calls[0]![2]).toEqual({ captures: 1, versions: 1, diffs: 1, screenshots: 0 });
    expect(confirmPurge.mock.calls[1]![2]).toEqual({ captures: 2, versions: 2, diffs: 2, screenshots: 0 });
    expect(answer).toMatchObject({ status: 'purged', counts: { captures: 2, versions: 2, diffs: 2, screenshots: 0 } });
    // Stale twice: `changed`, nothing deleted.
    await capture(repo, id, A, 'four');
    const before = tables();
    confirmPurge.mockReset();
    confirmPurge.mockImplementation(async () => (await capture(repo, id, A, `again ${tick()}`), true));
    expect(await service.purgeNow(id)).toEqual({ status: 'changed' });
    expect(confirmPurge).toHaveBeenCalledTimes(2);
    expect(tables()['ci_purges']).toBe(before['ci_purges']);
    expect(tables()['ci_tombstones']).toBe(before['ci_tombstones']);
  });

  test('purge-now-gives-up-when-the-policy-changed', async () => {
    // The policy changes while the dialog is up: what the dialog named is not what would run.
    const { service, repo, confirmPurge, tables } = setup();
    const id = await project(repo, 'Guides');
    for (const text of ['one', 'two', 'three']) await capture(repo, id, A, text);
    await service.setRetention(id, 'versions', 2);
    const before = tables();
    confirmPurge.mockImplementationOnce(async () => (await repo.setRetention(id, 'versions', 1, tick()), true));
    expect(await service.purgeNow(id)).toEqual({ status: 'changed' });
    expect(tables()).toEqual(before);
  });

  test('enforcement-after-a-run', async () => {
    const { service, repo, confirmPurge, raw, count } = setup();
    const id = await project(repo, 'Guides');
    const other = await project(repo, 'Other');
    for (const text of ['one', 'two', 'three']) await capture(repo, id, A, text);
    for (const text of ['one b', 'two b']) await capture(repo, other, B, text);
    await service.setRetention(id, 'versions', 1);
    await service.setRetention(other, 'versions', 1);
    service.afterRun(id);
    await service.settled();
    // The project's own policy, no dialog, recorded as `retention`; the other project is untouched.
    expect(confirmPurge).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT reason, project_id AS projectId, captures, versions FROM ci_purges').all()).toEqual([{ reason: 'retention', projectId: id, captures: 2, versions: 2 }]);
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(1);
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', other)).toBe(2);
    // A run's end always enforces (no rate limit): a new version after it goes at the next run's end.
    await capture(repo, id, A, 'four');
    service.afterRun(id);
    await service.settled();
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(1);
    expect(count("SELECT count(*) AS n FROM ci_purges WHERE reason = 'retention'")).toBe(2);
    // Keep everything: nothing to do, nothing recorded.
    await service.setRetention(id, 'forever', null);
    await capture(repo, id, A, 'five');
    service.afterRun(id);
    await service.settled();
    expect(count('SELECT count(*) AS n FROM ci_purges')).toBe(2);
  });

  test('enforcement-is-rate-limited', async () => {
    const { service, repo, state, count } = setup();
    const id = await project(repo, 'Guides');
    await service.setRetention(id, 'versions', 1);
    const captures = () => count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id);
    for (const text of ['one', 'two']) await capture(repo, id, A, text);
    // The first manual capture enforces …
    service.afterCapture(id);
    await service.settled();
    expect(captures()).toBe(1);
    // … the next ones within the interval do not.
    await capture(repo, id, A, 'three');
    clock += RETENTION_ENFORCE_MIN_INTERVAL_MS - 10_000;
    service.afterCapture(id);
    await service.settled();
    expect(captures()).toBe(2);
    // Past the interval: enforced again; not while a run of the project is under way (its end will).
    clock += 20_000;
    state.running = id;
    service.afterCapture(id);
    await service.settled();
    expect(captures()).toBe(2);
    state.running = null;
    service.afterCapture(id);
    await service.settled();
    expect(captures()).toBe(1);
    // Setting the policy again lets the next capture enforce it at once.
    await capture(repo, id, A, 'four');
    await service.setRetention(id, 'versions', 1);
    service.afterCapture(id);
    await service.settled();
    expect(captures()).toBe(1);
    expect(count("SELECT count(*) AS n FROM ci_purges WHERE reason = 'retention'")).toBe(3);
  });

  test('startup-enforcement-uses-the-purge-log', async () => {
    const { service, repo, count, confirmPurge } = setup();
    const recent = await project(repo, 'Recent');
    const old = await project(repo, 'Old');
    const never = await project(repo, 'Never');
    const keepAll = await project(repo, 'Keep all');
    const policy: PurgePolicy = { mode: 'versions', value: 1 };
    for (const id of [recent, old, never, keepAll]) {
      for (const text of ['one', 'two']) await capture(repo, id, `${A}/${id}`, `${id} ${text}`);
      if (id !== keepAll) await repo.setRetention(id, 'versions', 1, tick());
    }
    // `recent` was enforced an hour ago, `old` a day and an hour ago (recorded `retention` purges).
    for (const [id, ago] of [[recent, HOUR], [old, RETENTION_ENFORCE_MIN_INTERVAL_MS + HOUR]] as const) {
      const at = clock - ago;
      const plan = await repo.planPurge({ projectId: id, policy, now: at });
      expect(await repo.executePurge(plan!, 'retention', at)).toMatchObject({ status: 'purged' });
      await capture(repo, id, `${A}/${id}`, `${id} three`);
    }
    const captures = (id: string) => count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id);
    expect([captures(recent), captures(old), captures(never)]).toEqual([2, 2, 2]);
    await service.startup();
    // Due: `old` and `never`; `recent` keeps its new capture until its interval is over; keep-all is left.
    expect([captures(recent), captures(old), captures(never), captures(keepAll)]).toEqual([2, 1, 1, 2]);
    expect(confirmPurge).not.toHaveBeenCalled();
    // Seeded: a manual capture into `recent` does not enforce within its interval, one into `old` neither (just enforced).
    service.afterCapture(recent);
    service.afterCapture(old);
    await service.settled();
    expect([captures(recent), captures(old)]).toEqual([2, 1]);
    clock += HOUR * 23 + 1;
    service.afterCapture(recent);
    await service.settled();
    expect(captures(recent)).toBe(1);
  });

  test('files-removed-only-when-unreferenced', async () => {
    const first = setup();
    const id = await project(first.repo, 'Guides');
    const other = await project(first.repo, 'Other');
    // Two screenshots of one page and kind: keep 1 purges the older. Its file is also another project's: it stays.
    const shared = await screenshot(first.repo, first.files, id, A, 'png shared');
    await screenshot(first.repo, first.files, other, B, 'png shared');
    const own = await screenshot(first.repo, first.files, id, B, 'png own');
    await screenshot(first.repo, first.files, id, A, 'png newest a');
    await screenshot(first.repo, first.files, id, B, 'png newest b');
    await first.service.setRetention(id, 'versions', 1);
    expect(await first.service.purgeNow(id)).toMatchObject({ status: 'purged', counts: { screenshots: 2 }, files: 1 });
    expect(first.unlinked).toEqual([own]);
    expect(exists(first.real.fileFor(shared))).toBe(true);
    expect(exists(first.real.fileFor(own))).toBe(false);

    // A row naming the file again between the purge and the unlink keeps it (each hash is checked again).
    const second = setup();
    const raced = await project(second.repo, 'Raced');
    const kept = await screenshot(second.repo, second.files, raced, A, 'png raced');
    await screenshot(second.repo, second.files, raced, A, 'png newer');
    const store = Object.assign(Object.create(second.repo) as ChangeIntelRepository, { isHashReferenced: vi.fn(async () => true) });
    const planned = (await second.repo.planPurge({ projectId: raced, policy: { mode: 'versions', value: 1 }, now: clock }))!;
    const service = createRetentionService({
      store,
      files: second.files,
      purges: createPurgeFiles({ store, files: second.files }),
      databaseFile: second.file,
      running: () => null,
      confirmPurge: async () => true,
      confirmCompact: async () => true,
      now: () => clock,
    });
    await service.setRetention(raced, 'versions', 1);
    // The file stayed: the bytes freed are the rows' only (the record keeps the planned figure).
    expect(planned.fileBytes).toBeGreaterThan(0);
    expect(await service.purgeNow(raced)).toEqual({ status: 'purged', counts: { captures: 0, versions: 0, diffs: 0, screenshots: 1 }, bytes: planned.bytes - planned.fileBytes, files: 0 });
    expect(Number((second.raw.prepare("SELECT bytes AS n FROM ci_purges WHERE reason = 'purge-now'").get() as { n: number }).n)).toBe(planned.bytes);
    expect(second.unlinked).toEqual([]);
    expect(exists(second.real.fileFor(kept))).toBe(true);
  });

  test('purge-waits-for-a-screenshot-reusing-its-file', async () => {
    // A screenshot reuses a file the purge is about to free: it holds the hash's lock from its write to
    // its row (screenshots/service.ts), so the purge's unlink waits, then finds the row and keeps it.
    const { service, repo, files, real, unlinked } = setup();
    const id = await project(repo, 'Guides');
    const other = await project(repo, 'Other');
    const reused = await screenshot(repo, files, id, A, 'png reused');
    await screenshot(repo, files, id, A, 'png newer');
    await service.setRetention(id, 'versions', 1);
    const release = await real.lock(reused);
    const purging = service.purgeNow(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The rows went; the file waits for the lock.
    expect(exists(real.fileFor(reused))).toBe(true);
    expect(unlinked).toEqual([]);
    const at = tick();
    expect(await repo.appendScreenshot({ id: uuidv7(at), projectId: other, pageUrl: B, captureId: null, kind: 'viewport', rectJson: null, width: 10, height: 10, bytes: 10, sha256: reused, segments: 1, renderProfileJson: null, searchParamsJson: null, createdAt: at })).toBe(true);
    release();
    expect(await purging).toMatchObject({ status: 'purged', counts: { screenshots: 1 }, files: 0 });
    expect(unlinked).toEqual([]);
    expect(exists(real.fileFor(reused))).toBe(true);
  });

  test('sweep-waits-for-a-screenshot-reusing-its-file', async () => {
    // An old orphan file a screenshot is reusing right now: the sweep waits for the hash's lock, then
    // finds the new row and keeps the file.
    clock = Date.now();
    const { service, repo, files, real, unlinked } = setup();
    const id = await project(repo, 'Guides');
    // A row (another file's): the database is not a fresh one, so the sweep runs.
    await screenshot(repo, files, id, B, 'png kept');
    unlinked.length = 0;
    const { sha256: hash } = await real.write(Buffer.from('png orphan'));
    utimesSync(real.fileFor(hash), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    const release = await real.lock(hash);
    const sweeping = service.sweepOrphans();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exists(real.fileFor(hash))).toBe(true);
    const at = tick();
    expect(await repo.appendScreenshot({ id: uuidv7(at), projectId: id, pageUrl: A, captureId: null, kind: 'viewport', rectJson: null, width: 10, height: 10, bytes: 10, sha256: hash, segments: 1, renderProfileJson: null, searchParamsJson: null, createdAt: at })).toBe(true);
    release();
    expect(await sweeping).toEqual({ removed: 0, temporary: 0 });
    expect(unlinked).toEqual([]);
    expect(exists(real.fileFor(hash))).toBe(true);
  });

  test('orphan-sweep-deletes-only-hash-named-files', async () => {
    // File times are the wall clock's: the service's clock is set to it here.
    clock = Date.now();
    const { service, repo, files, real, log, dir } = setup();
    const id = await project(repo, 'Guides');
    const referenced = await screenshot(repo, files, id, A, 'png kept');
    const at = (name: string) => path.join(real.dir, name);
    const old = (name: string) => utimesSync(at(name), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    const h = (text: string) => sha(text);
    // Old and new orphans, crash leftovers, and everything that must stay.
    writeFileSync(at(`${h('old orphan')}.png`), 'x');
    old(`${h('old orphan')}.png`);
    writeFileSync(at(`${h('fresh orphan')}.png`), 'x');
    writeFileSync(at(`${h('old tmp')}.png.tmp-0123456789abcdef`), 'x');
    old(`${h('old tmp')}.png.tmp-0123456789abcdef`);
    writeFileSync(at(`${h('fresh tmp')}.png.tmp-fedcba9876543210`), 'x');
    old(`${referenced}.png`);
    const outside = path.join(dir, 'outside.png');
    writeFileSync(outside, 'keep me');
    symlinkSync(outside, at(`${h('link')}.png`));
    mkdirSync(at(`${h('directory')}.png`));
    const odd = ['notes.txt', `${h('upper')}.PNG`, `${h('backup')}.png.bak`, `${h('short tmp')}.png.tmp-abc`, `${h('x').toUpperCase()}.png`, `${h('long tmp')}.png.tmp-0123456789abcdef0`];
    for (const name of odd) {
      writeFileSync(at(name), 'x');
      old(name);
    }
    // An old link to an old file: never followed, never removed.
    utimesSync(outside, new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    lutimesSync(at(`${h('link')}.png`), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    utimesSync(at(`${h('directory')}.png`), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    const before = readdirSync(real.dir).sort();

    expect(await service.sweepOrphans()).toEqual({ removed: 1, temporary: 1 });
    const after = readdirSync(real.dir).sort();
    expect(before.filter((name) => !after.includes(name)).sort()).toEqual([`${h('old orphan')}.png`, `${h('old tmp')}.png.tmp-0123456789abcdef`].sort());
    expect(after).toContain(`${referenced}.png`);
    expect(after).toContain(`${h('fresh orphan')}.png`);
    expect(after).toContain(`${h('fresh tmp')}.png.tmp-fedcba9876543210`);
    expect(lstatSync(at(`${h('link')}.png`)).isSymbolicLink()).toBe(true);
    expect(statSync(at(`${h('directory')}.png`)).isDirectory()).toBe(true);
    expect(exists(outside)).toBe(true);
    for (const name of odd) expect(after).toContain(name);
    // One log line, counts only.
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.includes('sweep'))).toEqual(['retention: the orphan sweep removed 1 file and 1 temporary file']);

    // A screenshot directory that is a symlink is refused: nothing behind it is touched.
    const elsewhere = path.join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, `${h('behind')}.png`), 'x');
    utimesSync(path.join(elsewhere, `${h('behind')}.png`), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    rmSync(real.dir, { recursive: true, force: true });
    symlinkSync(elsewhere, real.dir);
    expect(await service.sweepOrphans()).toEqual({ removed: 0, temporary: 0 });
    expect(exists(path.join(elsewhere, `${h('behind')}.png`))).toBe(true);
    // No directory yet: nothing to do.
    unlinkSync(real.dir);
    expect(await service.sweepOrphans()).toEqual({ removed: 0, temporary: 0 });
  });

  test('sweep-skips-an-in-memory-database', async () => {
    // The session database fell back to `:memory:`: the rows naming the files are in the file on disk.
    clock = Date.now();
    const { service, real, unlinked, log } = setup({ databaseFile: ':memory:' });
    const orphan = (await real.write(Buffer.from('png on disk'))).sha256;
    utimesSync(real.fileFor(orphan), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    const tmp = path.join(real.dir, `${sha('tmp')}.png.tmp-0123456789abcdef`);
    writeFileSync(tmp, 'x');
    utimesSync(tmp, new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));

    expect(await service.sweepOrphans()).toEqual({ removed: 0, temporary: 0 });
    expect(unlinked).toEqual([]);
    expect(exists(real.fileFor(orphan))).toBe(true);
    expect(exists(tmp)).toBe(true);
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.includes('sweep'))).toEqual(['retention: the orphan sweep was skipped (an in-memory database): 2 files left']);
  });

  test('sweep-skips-a-fresh-database', async () => {
    // Moved aside as corrupt and recreated: no row here names the files, but the aside copy does.
    clock = Date.now();
    const { service, repo, files, real, unlinked, log } = setup();
    const id = await project(repo, 'Guides');
    const hashes = [];
    for (const png of ['png one', 'png two']) {
      const { sha256: hash } = await real.write(Buffer.from(png));
      utimesSync(real.fileFor(hash), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
      hashes.push(hash);
    }

    expect(await service.sweepOrphans()).toEqual({ removed: 0, temporary: 0 });
    // `startup` sweeps the same way.
    await service.startup();
    expect(unlinked).toEqual([]);
    for (const hash of hashes) expect(exists(real.fileFor(hash))).toBe(true);
    const lines = log.mock.calls.map(([line]) => line).filter((line) => line.includes('sweep'));
    expect(lines).toEqual(['retention: the orphan sweep was skipped (a fresh database): 2 files left', 'retention: the orphan sweep was skipped (a fresh database): 2 files left']);

    // Once a row exists, the sweep runs again: the unnamed old files go.
    const kept = await screenshot(repo, files, id, A, 'png kept');
    utimesSync(real.fileFor(kept), new Date(clock - 2 * HOUR), new Date(clock - 2 * HOUR));
    expect(await service.sweepOrphans()).toEqual({ removed: 2, temporary: 0 });
    expect(exists(real.fileFor(kept))).toBe(true);
  });

  test('usage-counts-measured-bytes', async () => {
    const { service, repo, files, real, file } = setup();
    const id = await project(repo, 'Guides');
    const other = await project(repo, 'Other');
    await capture(repo, id, A, 'one');
    await capture(repo, id, A, 'two');
    await capture(repo, other, B, 'three');
    await screenshot(repo, files, id, A, 'a'.repeat(1_000));
    const missing = await screenshot(repo, files, id, A, 'b'.repeat(2_000));
    await screenshot(repo, files, id, B, 'a'.repeat(1_000));
    await screenshot(repo, files, other, B, 'c'.repeat(500));
    // Another project names the first file too: it is labelled shared in both.
    await screenshot(repo, files, other, A, 'a'.repeat(1_000));
    // Removed by hand: counted as missing, not as bytes.
    unlinkSync(real.fileFor(missing));
    const dbBytes = statSync(file).size;

    const mine = UsageAnswerSchema.parse(await service.usage(id));
    const stored = (await repo.usage(id))!;
    expect(mine).toEqual({
      status: 'ok',
      usage: {
        projectId: id,
        captures: stored.captures,
        versions: stored.versions,
        sharedVersions: stored.sharedVersions,
        snapshotBytes: stored.snapshotBytes,
        diffBytes: stored.diffBytes,
        screenshots: 3,
        files: { count: 1, bytes: 1_000, missing: 1, shared: 1 },
        database: { bytes: dbBytes, walBytes: 0 },
      },
    });
    expect(mine.status === 'ok' && mine.usage.captures).toBe(2);
    // Totals: every row's files, each once.
    const all = await service.usage(null);
    expect(all).toMatchObject({ status: 'ok', usage: { projectId: null, captures: 3, screenshots: 5, files: { count: 2, bytes: 1_500, missing: 1, shared: 1 } } });
    expect(await service.usage(uuidv7(tick()))).toEqual({ status: 'refused', reason: 'not-found' });
    // In memory: no file to measure.
    const memory = createRetentionService({ store: repo, files, purges: createPurgeFiles({ store: repo, files }), databaseFile: ':memory:', running: () => null, confirmPurge: async () => true, confirmCompact: async () => true });
    expect(await memory.usage(null)).toMatchObject({ status: 'ok', usage: { database: null } });
  });

  test('compact-shrinks-and-refuses-during-a-run', async () => {
    const { service, repo, state, confirmCompact, file } = setup();
    const id = await project(repo, 'Big');
    for (let i = 0; i < 12; i++) await capture(repo, id, A, `${i} ${'x'.repeat(200_000)}`);
    await service.setRetention(id, 'versions', 1);
    expect(await service.purgeNow(id)).toMatchObject({ status: 'purged' });
    // A run under way: refused, no dialog.
    state.running = id;
    expect(await service.compact()).toEqual({ status: 'refused', reason: 'running' });
    expect(confirmCompact).not.toHaveBeenCalled();
    state.running = null;
    confirmCompact.mockResolvedValueOnce(false);
    expect(await service.compact()).toEqual({ status: 'refused', reason: 'declined' });
    const before = statSync(file).size;
    const answer = await service.compact();
    expect(answer).toMatchObject({ status: 'compacted', before });
    const after = statSync(file).size;
    expect(answer).toEqual({ status: 'compacted', before, after });
    expect(after).toBeLessThan(before / 2);
    // What is kept is still there.
    expect((await repo.usage(id))?.captures).toBe(1);
    // VACUUM failing (a full disk, a busy database): its own refusal, the file as it was.
    const failing = setup({ store: Object.assign(Object.create(repo) as ChangeIntelRepository, { compact: vi.fn(async () => Promise.reject(Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR' }))) }), databaseFile: file });
    expect(await failing.service.compact()).toEqual({ status: 'refused', reason: 'compact-failed' });
    expect(failing.log.mock.calls.map(([line]) => line)).toContain('retention: compacting failed (ERR_SQLITE_ERROR)');
    const memory = createRetentionService({ store: repo, files: createScreenshotFiles(path.dirname(file)), databaseFile: ':memory:', running: () => null, confirmPurge: async () => true, confirmCompact });
    confirmCompact.mockClear();
    expect(await memory.compact()).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(confirmCompact).not.toHaveBeenCalled();
  });

  test('purge-log-lists-the-newest', async () => {
    const { service, repo } = setup();
    const id = await project(repo, 'Guides');
    await service.setRetention(id, 'versions', 1);
    for (let i = 0; i < PURGE_LOG_LIMIT + 2; i++) {
      await capture(repo, id, A, `v${i}`);
      if (i > 0) await service.purgeNow(id);
    }
    const log = PurgeLogAnswerSchema.parse(await service.purgeLog(id));
    expect(log.entries).toHaveLength(PURGE_LOG_LIMIT);
    expect(log.entries[0]).toMatchObject({ reason: 'purge-now', projectId: id, policy: { mode: 'versions', value: 1 }, counts: { captures: 1, versions: 1, diffs: 1, screenshots: 0 } });
    expect(log.entries[0]!.createdAt).toBeGreaterThanOrEqual(log.entries[1]!.createdAt);
    expect((await service.purgeLog(null)).entries).toHaveLength(PURGE_LOG_LIMIT);
    expect(await service.purgeLog(uuidv7(tick()))).toEqual({ entries: [] });
  });
});
