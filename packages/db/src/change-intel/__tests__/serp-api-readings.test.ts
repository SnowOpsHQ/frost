// Spec: specs/workspace-db.spec.ts (SERP_API_READINGS_TABLES, SERP_API_READINGS_MIGRATION_IDS, SERP_READING_SOURCES,
// SEARCH_KEY_VERSION), specs/retention.spec.ts (PurgeCountsView.readings)
// Acceptance: specs/workspace-db.feature.md (API readings (Phase 12); Scenarios), specs/retention.feature.md
// (api-only-purge-counts-show-readings) · plan docs/plans/phase-12-big-bets.md, Decision 7 and Task 4
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { SEARCH_KEY_VERSION, SERP_API_READINGS_MIGRATION_IDS, SERP_API_READINGS_TABLES } from '@app/specs/workspace-db.spec';
import { DATA_USAGE_MIGRATIONS } from '../../data-usage-migrations';
import { MIGRATIONS, runMigrations } from '../../migrations';
import { uuidv7 } from '../ids';
import type { AppendApiReadingInput, PurgePolicy } from '../repository';
import { SERP_API_READINGS_MIGRATIONS } from '../serp-api-migrations';
import { appended, capture, captureInput, count, DAY, openTestDb, sha256, utf8, type TestDb } from './fixtures';

const SERP = 'https://www.google.com/search?q=green+tea';
const PARAMS = '{"engine":"google","query":"green tea"}';
const VENDOR_URL = 'https://serpapi.com/search.json';
const KEY_A = sha256('green tea');
const KEY_B = sha256('black tea');
let t: TestDb;

beforeEach(() => {
  t = openTestDb();
});

/** An API reading as main hands it in (`appendApiReading`). */
function apiReading(projectId: string, at: number, overrides: Partial<AppendApiReadingInput> = {}): AppendApiReadingInput {
  return {
    id: uuidv7(at),
    projectId,
    searchKey: KEY_A,
    searchKeyVersion: SEARCH_KEY_VERSION,
    searchParamsJson: PARAMS,
    filtersJson: '{}',
    status: 'ready',
    packVersion: 3,
    readingJson: JSON.stringify({ status: 'ready', at }),
    pageUrl: VENDOR_URL,
    observedAt: at,
    createdAt: at,
    ...overrides,
  };
}

async function stored(input: AppendApiReadingInput): Promise<string> {
  expect(await t.repo.appendApiReading(input), JSON.stringify(input).slice(0, 120)).toBe(true);
  return input.id;
}

/** Plants a reading with raw SQL (a `serp-api` one by default). */
function plant(raw: DatabaseSync, row: Partial<Record<string, SQLInputValue>> = {}): string {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const full: Record<string, SQLInputValue> = {
    id,
    project_id: UNFILED_PROJECT_ID,
    capture_id: null,
    source: 'serp-api',
    search_key: KEY_A,
    search_key_version: 1,
    search_params: PARAMS,
    filters: '{}',
    page_url: null,
    status: 'ready',
    pack_version: 3,
    reading: '{"status":"ready"}',
    reading_bytes: 18,
    observed_at: 5_000,
    created_at: 5_000,
    ...row,
  };
  const columns = Object.keys(full);
  raw.prepare(`INSERT INTO ci_serp_readings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(full));
  return id;
}

const record = (raw: DatabaseSync, readingId: string, at = 9_000) =>
  raw.prepare("INSERT INTO ci_serp_api_purges (reading_id, purge_id, reason, project_id, purged_at) VALUES (?, ?, 'retention', ?, ?)").run(readingId, uuidv7(at), UNFILED_PROJECT_ID, at);
const readingIds = (projectId: string) => t.raw.prepare('SELECT id FROM ci_serp_readings WHERE project_id = ? ORDER BY id').all(projectId).map((row) => String(row['id']));
const recorded = () => t.raw.prepare('SELECT reading_id FROM ci_serp_api_purges ORDER BY reading_id').all().map((row) => String(row['reading_id']));

/** Plans `policy` for the project at `now` and executes it (`project-deleted` for `all`). */
async function purge(projectId: string, policy: PurgePolicy, now: number) {
  const plan = (await t.repo.planPurge({ projectId, policy, now }))!;
  expect(plan).not.toBeNull();
  return { plan, done: await t.repo.executePurge(plan, policy.mode === 'all' ? 'project-deleted' : 'retention', now) };
}

describe('API readings (Phase 12)', () => {
  test('serp-api-readings-migration', () => {
    expect(SERP_API_READINGS_MIGRATIONS.map((m) => m.id)).toEqual([...SERP_API_READINGS_MIGRATION_IDS]);
    const ids = MIGRATIONS.map((m) => m.id);
    const start = MIGRATIONS.indexOf(SERP_API_READINGS_MIGRATIONS[0]!);
    // In id order, after Phase 12's data usage (0243); later ids follow, none of them below 0245.
    expect(start).toBeGreaterThan(MIGRATIONS.indexOf(DATA_USAGE_MIGRATIONS[DATA_USAGE_MIGRATIONS.length - 1]!));
    expect(ids.slice(start + 1).every((id) => id > '0245')).toBe(true);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);
    // A database at the migration before it takes exactly 0245.
    const db = new DatabaseSync(':memory:');
    runMigrations(db, MIGRATIONS.slice(0, start));
    expect(runMigrations(db, MIGRATIONS.slice(0, start + 1))).toEqual([...SERP_API_READINGS_MIGRATION_IDS]);
    for (const table of SERP_API_READINGS_TABLES) expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)!['n']).toBe(1);
    const forbidden = [/\bPRAGMA\b/i, /\bATTACH\b/i, /\bVIRTUAL\b/i, /\bjson\w*\s*\(/i, /->/, /\bGENERATED\b|\bAS\s*\(/i, /\bSTRICT\b/i, /\bWITHOUT\s+ROWID\b/i, /\bAUTOINCREMENT\b/i];
    for (const migration of SERP_API_READINGS_MIGRATIONS) for (const pattern of forbidden) expect(pattern.test(migration.sql), `${migration.id}: ${pattern}`).toBe(false);
  });

  test('serp-api-reading-only-through-appendApiReading', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const plain = appended(await capture(t.repo, { url: SERP, snapshot: '{"p":1}', at: 1_000, projectId: site.id, params: PARAMS }));
    const api = apiReading(site.id, 2_000);
    // Phase 10's public path and the capture path still refuse `serp-api`.
    const asPublic = { ...api, captureId: null, source: 'serp-api' as const };
    expect(await t.repo.appendReading(asPublic)).toBe(false);
    expect(await t.repo.appendReading({ ...asPublic, captureId: plain.captureId })).toBe(false);
    // `appendCapture` files any reading it is handed as its capture's (`source = 'capture'`), never `serp-api`.
    const viaCapture = captureInput({ url: `${SERP}&start=10`, snapshot: '{"p":2}', at: 1_500, projectId: site.id, params: PARAMS, reading: { ...api, id: uuidv7(1_500) } });
    const second = appended(await t.repo.appendCapture(viaCapture));
    expect((await t.repo.reading(viaCapture.reading!.id))).toMatchObject({ source: 'capture', captureId: second.captureId });
    expect(count(t.raw, 'ci_serp_readings', "source = 'serp-api'")).toBe(0);

    // `appendApiReading` writes it: no capture, its own page URL, the reading's own fields.
    expect(await stored(api)).toBe(api.id);
    const row = (await t.repo.reading(api.id))!;
    expect(row).toEqual({ ...api, captureId: null, source: 'serp-api', readingBytes: utf8(api.readingJson) });
    expect(await t.repo.appendApiReading(apiReading(site.id, 2_100, { pageUrl: null }))).toBe(true);

    // Refused, nothing written: a bad reading, a project that is not live, a taken id, a recorded one.
    const before = count(t.raw, 'ci_serp_readings');
    const gone = (await t.repo.createProject('Gone', 500))!;
    expect(await t.repo.tombstoneProject(gone.id, 600)).toBe(true);
    const recordedId = uuidv7(2_300);
    record(t.raw, recordedId);
    for (const bad of [
      apiReading(site.id, 2_200, { id: 'nope' }),
      apiReading(site.id, 2_200, { searchKey: 'KEY' }),
      apiReading(site.id, 2_200, { searchKeyVersion: 0 }),
      apiReading(site.id, 2_200, { status: 'pending' as never }),
      apiReading(site.id, 2_200, { packVersion: 0 }),
      apiReading(site.id, 2_200, { readingJson: '' }),
      apiReading(site.id, 2_200, { pageUrl: 'not a url' }),
      apiReading(site.id, 2_200, { observedAt: -1 }),
      apiReading('nope', 2_200),
      apiReading(uuidv7(), 2_200),
      apiReading(gone.id, 2_200),
      apiReading(site.id, 2_200, { id: api.id }),
      apiReading(site.id, 2_300, { id: recordedId }),
      { ...apiReading(site.id, 2_200), source: 'capture', captureId: plain.captureId } as AppendApiReadingInput,
    ]) {
      expect(await t.repo.appendApiReading(bad), JSON.stringify(bad).slice(0, 120)).toBe(false);
    }
    expect(count(t.raw, 'ci_serp_readings')).toBe(before);
    expect(count(t.raw, 'ci_serp_readings', "source = 'serp-api' AND capture_id IS NULL")).toBe(2);
  });

  test('serp-api-reading-deleted-only-by-a-recorded-purge', async () => {
    const api = plant(t.raw);
    expect(() => t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(api)).toThrow(/recorded purge|capture is gone/);
    expect(count(t.raw, 'ci_serp_readings')).toBe(1);
    record(t.raw, api);
    t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(api);
    expect(count(t.raw, 'ci_serp_readings')).toBe(0);
    // The record is append-only: never updated, never deleted.
    expect(() => t.raw.prepare('UPDATE ci_serp_api_purges SET reading_id = ? WHERE reading_id = ?').run(uuidv7(), api)).toThrow(/append-only/);
    expect(() => t.raw.prepare('DELETE FROM ci_serp_api_purges').run()).toThrow(/append-only/);
    expect(() => record(t.raw, 'short')).toThrow();
    expect(() => t.raw.prepare("INSERT INTO ci_serp_api_purges (reading_id, purge_id, reason, project_id, purged_at) VALUES (?, ?, 'sometimes', ?, 1)").run(uuidv7(), uuidv7(), UNFILED_PROJECT_ID)).toThrow();
    expect(recorded()).toEqual([api]);
  });

  test('serp-api-reading-never-resurrected', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const id = await stored(apiReading(site.id, 1_000));
    // A newer one of the same search: `days 1` removes the older (each key's newest stays).
    await stored(apiReading(site.id, 1_500));
    const { done } = await purge(site.id, { mode: 'days', value: 1 }, 1_000 + 2 * DAY);
    expect(done).toMatchObject({ status: 'purged' });
    expect(recorded()).toEqual([id]);
    // Neither raw (any verb) nor through the repository.
    for (const verb of ['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE', 'REPLACE']) {
      expect(() => t.raw.prepare(`${verb} INTO ci_serp_readings (id, project_id, capture_id, source, search_key, search_key_version, search_params, filters, page_url, status, pack_version, reading, reading_bytes, observed_at, created_at) VALUES (?, ?, NULL, 'serp-api', ?, 1, ?, '{}', NULL, 'ready', 3, '{}', 2, 1, 1)`).run(id, site.id, KEY_A, PARAMS), verb).toThrow(/was purged/);
    }
    expect(await t.repo.appendApiReading(apiReading(site.id, 1_000, { id }))).toBe(false);
    expect(count(t.raw, 'ci_serp_readings', 'id = ?', id)).toBe(0);
  });

  test('capture-reading-guard-unchanged', async () => {
    const reading = { id: uuidv7(1_000), searchKey: KEY_A, searchKeyVersion: 1, searchParamsJson: PARAMS, filtersJson: '{}', status: 'ready' as const, packVersion: 3, readingJson: '{"status":"ready"}' };
    const first = appended(await t.repo.appendCapture(captureInput({ url: SERP, snapshot: '{"v":1}', at: 1_000, params: PARAMS, reading })));
    // Its capture is there: never deleted, even with its id recorded as an API purge.
    expect(() => t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(reading.id)).toThrow(/capture is gone/);
    record(t.raw, reading.id);
    expect(() => t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(reading.id)).toThrow(/capture is gone/);
    // Once its capture is gone (a pulled purge), it can be.
    const purgeId = uuidv7(9_000);
    t.raw.prepare("INSERT INTO ci_purges (id, reason, project_id, policy, captures, versions, diffs, screenshots, bytes, created_at) VALUES (?, 'purge-now', NULL, NULL, 1, 0, 0, 0, 0, 9000)").run(purgeId);
    t.raw.prepare("INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, ?, 'ci_captures', ?, 9000)").run(uuidv7(9_000), purgeId, first.captureId);
    t.raw.prepare('DELETE FROM ci_captures WHERE id = ?').run(first.captureId);
    t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(reading.id);
    expect(count(t.raw, 'ci_serp_readings')).toBe(0);
    // A capture reading of a live capture is still refused when some other API id is recorded.
    const second = { ...reading, id: uuidv7(2_000) };
    appended(await t.repo.appendCapture(captureInput({ url: SERP, snapshot: '{"v":1}', at: 2_000, params: PARAMS, reading: second })));
    expect(() => t.raw.exec('DELETE FROM ci_serp_readings')).toThrow(/capture is gone/);
    // The CHECK still holds: a capture reading names its capture.
    expect(() => plant(t.raw, { source: 'capture', capture_id: null })).toThrow();
  });

  test('orphan-sweep-skips-api-readings', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const api = await stored(apiReading(site.id, 1_000));
    const other = await stored(apiReading(UNFILED_PROJECT_ID, 1_100));
    expect(await t.repo.deleteOrphanReadings(site.id)).toBe(0);
    expect(await t.repo.deleteOrphanReadings()).toBe(0);
    expect(readingIds(site.id)).toEqual([api]);
    expect((await t.repo.readings({ projectId: site.id, limit: 10 })).map((r) => r.id)).toEqual([api]);
    expect((await t.repo.reading(other))?.source).toBe('serp-api');
    expect(await t.repo.countReadings({ projectId: site.id })).toBe(1);
    expect((await t.repo.readingSearches(site.id)).map((s) => s.searchKey)).toEqual([KEY_A]);
  });

  test('purge-applies-retention-to-api-readings', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const elsewhere = (await t.repo.createProject('Other', 500))!;
    // Two search keys: A observed at days 1, 2, 3; B at day 1.
    const a1 = await stored(apiReading(site.id, 1 * DAY));
    const a2 = await stored(apiReading(site.id, 2 * DAY));
    const a3 = await stored(apiReading(site.id, 3 * DAY));
    const b1 = await stored(apiReading(site.id, 1 * DAY + 1, { searchKey: KEY_B }));
    const theirs = await stored(apiReading(elsewhere.id, 1 * DAY + 2));

    // forever: nothing.
    expect((await t.repo.planPurge({ projectId: site.id, policy: { mode: 'forever' }, now: 10 * DAY }))!.apiReadingIds).toEqual([]);
    // versions 1: per key, the newest stays (A's day 3, B's only one).
    const versions = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'versions', value: 1 }, now: 10 * DAY }))!;
    expect(versions.apiReadingIds).toEqual([a1, a2].sort());
    expect(versions.counts.readings).toBe(2);
    // versions 2 keeps two of A.
    expect((await t.repo.planPurge({ projectId: site.id, policy: { mode: 'versions', value: 2 }, now: 10 * DAY }))!.apiReadingIds).toEqual([a1]);
    // days 2 at day 3.5: observed before day 1.5 go (A's day 1), but each key's newest stays (B's only
    // one, day 1: lead ruling, as Phase 6's "the newest always stays").
    const days = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'days', value: 2 }, now: 3.5 * DAY }))!;
    expect(days.apiReadingIds).toEqual([a1]);
    // Their stored bytes count in `bytes`.
    expect(days.bytes).toBe(utf8(JSON.stringify({ status: 'ready', at: 1 * DAY })));
    // Long after: still each key's newest (A's day 3, B's day 1).
    expect((await t.repo.planPurge({ projectId: site.id, policy: { mode: 'days', value: 1 }, now: 100 * DAY }))!.apiReadingIds).toEqual([a1, a2].sort());

    expect(await t.repo.setRetention(site.id, 'versions', 1, 5 * DAY)).toBe(true);
    const { done } = await purge(site.id, { mode: 'versions', value: 1 }, 10 * DAY);
    expect(done).toMatchObject({ status: 'purged' });
    expect(readingIds(site.id)).toEqual([a3, b1].sort());
    expect(recorded()).toEqual([a1, a2].sort());
    // Each record names its purge, reason and project; an API-only purge writes no `ci_purges` row.
    const records = t.raw.prepare('SELECT purge_id AS purgeId, reason, project_id AS projectId, purged_at AS purgedAt FROM ci_serp_api_purges').all().map((row) => ({ ...row }));
    expect(records).toEqual([a1, a2].map(() => ({ purgeId: (done as { purgeId: string }).purgeId, reason: 'retention', projectId: site.id, purgedAt: 10 * DAY })));
    expect(count(t.raw, 'ci_purges')).toBe(0);

    // The project deleted: every one goes; another project's stay.
    expect(await t.repo.tombstoneProject(site.id, 11 * DAY)).toBe(true);
    const all = await purge(site.id, { mode: 'all' }, 11 * DAY);
    expect(all.done).toMatchObject({ status: 'purged' });
    expect(all.plan.apiReadingIds).toEqual([a3, b1].sort());
    expect(readingIds(site.id)).toEqual([]);
    expect(recorded()).toEqual([a1, a2, a3, b1].sort());
    expect(count(t.raw, 'ci_serp_api_purges', "reason = 'project-deleted' AND project_id = ?", site.id)).toBe(2);
    expect(count(t.raw, 'ci_purges')).toBe(0);
    expect(readingIds(elsewhere.id)).toEqual([theirs]);
  });

  test('api-only-project-obeys-retention', async () => {
    const site = (await t.repo.createProject('API only', 500))!;
    const old = await stored(apiReading(site.id, 1 * DAY));
    const recent = await stored(apiReading(site.id, 5 * DAY));
    expect(count(t.raw, 'ci_captures', 'project_id = ?', site.id)).toBe(0);
    expect(await t.repo.setRetention(site.id, 'days', 2, 5 * DAY)).toBe(true);
    // A plan with only API readings: not empty.
    const plan = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'days', value: 2 }, now: 6 * DAY }))!;
    expect(plan.counts).toEqual({ captures: 0, versions: 0, diffs: 0, screenshots: 0, readings: 1 });
    // Stale: an API reading written after the plan, which the policy also selects, changes the set.
    const late = await stored(apiReading(site.id, 1 * DAY + 5));
    expect(await t.repo.executePurge(plan, 'retention', 6 * DAY)).toEqual({ status: 'stale' });
    expect(readingIds(site.id)).toEqual([old, recent, late].sort());
    // Planned again: purged, never `empty`.
    const { done } = await purge(site.id, { mode: 'days', value: 2 }, 6 * DAY);
    expect(done).toMatchObject({ status: 'purged' });
    expect(readingIds(site.id)).toEqual([recent]);
    // An API-only retention purge writes no `ci_purges` row (its log is `ci_serp_api_purges`).
    expect(count(t.raw, 'ci_purges')).toBe(0);
    expect(count(t.raw, 'ci_serp_api_purges', "reason = 'retention'")).toBe(2);
    // Nothing left to purge: `empty`.
    const again = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'days', value: 2 }, now: 6 * DAY }))!;
    expect(again.counts).toEqual({ captures: 0, versions: 0, diffs: 0, screenshots: 0 });
    expect(await t.repo.executePurge(again, 'retention', 6 * DAY)).toEqual({ status: 'empty' });
  });

  test('api-only-purge-counts-show-readings', async () => {
    const site = (await t.repo.createProject('Mixed', 500))!;
    // A capture-only plan has no `readings` key at all (Phase 10's exact counts stay valid).
    appended(await capture(t.repo, { url: 'https://example.com/', snapshot: 'a', at: 1_000, projectId: site.id }));
    appended(await capture(t.repo, { url: 'https://example.com/', snapshot: 'b', at: 2_000, projectId: site.id }));
    const capturesOnly = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'versions', value: 1 }, now: 3_000 }))!;
    expect(Object.keys(capturesOnly.counts).sort()).toEqual(['captures', 'diffs', 'screenshots', 'versions']);
    // With API readings: `readings` counts them; the purge record does not.
    await stored(apiReading(site.id, 1_500));
    await stored(apiReading(site.id, 2_500));
    expect(await t.repo.setRetention(site.id, 'versions', 1, 2_600)).toBe(true);
    const { plan, done } = await purge(site.id, { mode: 'versions', value: 1 }, 3_000);
    expect(plan.counts).toMatchObject({ captures: 1, readings: 1 });
    expect(done).toMatchObject({ status: 'purged' });
    expect(Object.keys(t.raw.prepare('SELECT * FROM ci_purges').get()!).sort()).toEqual(['bytes', 'captures', 'created_at', 'diffs', 'id', 'policy', 'project_id', 'reason', 'screenshots', 'versions']);
    const [entry] = await t.repo.purges({ projectId: site.id });
    expect(entry!.counts).toEqual({ captures: 1, versions: 1, diffs: 1, screenshots: 0 });
    // A purge of captured rows and API readings: the record names that `ci_purges` row.
    expect(t.raw.prepare('SELECT purge_id AS id FROM ci_serp_api_purges').all().map((row) => row['id'])).toEqual([entry!.id]);
  });

  test('api-only-project-delete-retried-after-restart', async () => {
    const site = (await t.repo.createProject('API only', 500))!;
    const live = (await t.repo.createProject('Live', 500))!;
    await stored(apiReading(site.id, 1_000));
    await stored(apiReading(live.id, 1_000 + 1));
    expect(await t.repo.deletedProjectsWithRows()).toEqual([]);
    // Deleted, its purge not run (a crash): listed until it is.
    expect(await t.repo.tombstoneProject(site.id, 2_000)).toBe(true);
    expect(await t.repo.deletedProjectsWithRows()).toEqual([site.id]);
    // A capture-reading-free, capture-free project: the `all` plan is its readings alone.
    const { plan, done } = await purge(site.id, { mode: 'all' }, 3_000);
    expect(plan.counts).toEqual({ captures: 0, versions: 0, diffs: 0, screenshots: 0, readings: 1 });
    expect(done).toMatchObject({ status: 'purged' });
    // An API-only project-delete purge writes no `ci_purges` row either.
    expect(count(t.raw, 'ci_purges')).toBe(0);
    expect(count(t.raw, 'ci_serp_api_purges', "reason = 'project-deleted'")).toBe(1);
    expect(await t.repo.deletedProjectsWithRows()).toEqual([]);
    expect(readingIds(site.id)).toEqual([]);
    expect(readingIds(live.id)).toHaveLength(1);
  });
});
