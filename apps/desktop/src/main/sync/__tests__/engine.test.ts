// Spec: specs/sync.spec.ts (Sync tables) · Acceptance: specs/sync-engine.feature.md (Engine)
// The session side is `node:sqlite` on a file per device; the replica is one libSQL `file:` database
// that every device pushes to and pulls from, standing in for the primary.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SqlDriver } from '@app/db/driver-types';
import {
  SYNC_LOG_TABLE,
  SYNC_PURGE_DELETE_ORDER,
  SYNC_STATE_TABLE,
  SYNC_TABLES,
  type SyncTableName,
} from '@app/specs/sync.spec';
import { ensureSyncState, pullPass, pushPass, quoteIdentifier, runSyncPass, type SyncDirectionReport } from '../engine';
import {
  capture,
  diff,
  insert,
  openFixture,
  page,
  project,
  purge,
  query,
  rowsOf,
  screenshot,
  tableNames,
  tableSql,
  tombstone,
  triggerSql,
  uuid7,
  version,
  type Fixture,
} from './fixtures';

const NOW = () => 10 ** 13;
const P = uuid7(1);

let fx: Fixture;
beforeEach(async () => {
  fx = await openFixture();
  await ensureSyncState(fx.replica);
});
afterEach(async () => {
  await fx.close();
});

const pass = (source: SqlDriver, deviceId: string) => runSyncPass({ source, replica: fx.replica, deviceId, now: NOW });
const push = (source: SqlDriver, deviceId: string) => pushPass({ source, replica: fx.replica, deviceId, now: NOW });
const pull = (source: SqlDriver, deviceId: string) => pullPass({ source, replica: fx.replica, deviceId, now: NOW });
const written = (report: SyncDirectionReport) => report.tables.reduce((sum, t) => sum + t.written, 0);
const tableReport = (report: SyncDirectionReport, table: SyncTableName) => report.tables.find((t) => t.table === table)!;
const logCount = async () => ((await fx.replica.execute(`SELECT count(*) FROM ${SYNC_LOG_TABLE}`, [], 'get')).rows as [number])[0];

/** One row in every fixture table on `driver`. */
async function seedEverything(driver: SqlDriver): Promise<void> {
  await insert(driver, 'ci_projects', project(P, 'Site', 1_000));
  await insert(driver, 'ci_project_pages', page(uuid7(2), P, 'https://example.com/', 1_000));
  await insert(driver, 'ci_project_queries', query(uuid7(3), P, 'frost', 1_000));
  await insert(driver, 'ci_versions', version(uuid7(10), 1_000));
  await insert(driver, 'ci_versions', version(uuid7(11), 1_001, uuid7(10)));
  await insert(driver, 'ci_captures', capture(uuid7(20), P, uuid7(10), 1_000));
  await insert(driver, 'ci_captures', capture(uuid7(21), P, uuid7(11), 1_001));
  await insert(driver, 'ci_diffs', diff(uuid7(30), uuid7(10), uuid7(11), 1_001));
  await insert(driver, 'ci_screenshots', screenshot(uuid7(40), P, uuid7(21), 1_001));
}

/** Phase 6's purge path on `driver`: the purge, its tombstones, then children-first deletes, in one batch. */
async function purgeOn(driver: SqlDriver, purgeId: string, rows: readonly [SyncTableName, string][], at: number): Promise<void> {
  const ordered = [...rows].sort(([a], [b]) => SYNC_PURGE_DELETE_ORDER.indexOf(a as never) - SYNC_PURGE_DELETE_ORDER.indexOf(b as never));
  const spec = (name: SyncTableName) => SYNC_TABLES.find((t) => t.name === name)!.columns;
  const ins = (name: SyncTableName, values: unknown[]) => ({ sql: `INSERT INTO ${name} (${spec(name).join(', ')}) VALUES (${values.map(() => '?').join(', ')})`, params: values, method: 'run' as const });
  await driver.batch([
    ins('ci_purges', purge(purgeId, at)),
    ...ordered.map(([table, id], i) => ins('ci_tombstones', tombstone(uuid7(at, i + 1), purgeId, table, id, at))),
    ...ordered.map(([table, id]) => ({ sql: `DELETE FROM ${table} WHERE id = ?`, params: [id], method: 'run' as const })),
  ]);
}

async function expectSameRows(a: SqlDriver, b: SqlDriver): Promise<void> {
  for (const { name } of SYNC_TABLES) expect(await rowsOf(b, name), name).toEqual(await rowsOf(a, name));
}

describe('sync engine', () => {
  test('engine-pushes-new-rows', async () => {
    const a = await fx.device('a');
    await seedEverything(a);
    await insert(a, 'ci_purges', purge(uuid7(50), 1_002));
    await insert(a, 'ci_tombstones', tombstone(uuid7(51), uuid7(50), 'ci_versions', uuid7(99), 1_002));

    const report = await push(a, 'device-a');
    expect(report.direction).toBe('push');
    for (const { name } of SYNC_TABLES) expect(tableReport(report, name)).toMatchObject({ status: 'synced' });
    expect(written(report)).toBe(11);
    await expectSameRows(a, fx.replica);
    expect(await logCount()).toBe(11);
    const marks = (await fx.replica.execute(`SELECT device_id, direction, table_name FROM ${SYNC_STATE_TABLE} ORDER BY table_name`, [], 'all')).rows;
    expect(marks).toEqual(
      SYNC_TABLES.map((t) => t.name)
        .sort()
        .map((name) => ['device-a', 'push', name]),
    );
  });

  test('engine-pulls-new-rows', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    await seedEverything(a);
    await push(a, 'device-a');

    const report = await pull(b, 'device-b');
    expect(report.direction).toBe('pull');
    expect(written(report)).toBe(9);
    await expectSameRows(a, b);
    // A's own rows come back to it unchanged.
    expect(written(await pull(a, 'device-a'))).toBe(0);
  });

  test('engine-late-rows-still-pulled', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    const c = await fx.device('c');
    await insert(a, 'ci_versions', version(uuid7(500), 5_000));
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    // C's clock is far behind (or C was offline): its row is older than everything B has pulled.
    await insert(c, 'ci_versions', version(uuid7(5), 10));
    await pass(c, 'device-c');
    await pass(b, 'device-b');
    expect((await rowsOf(b, 'ci_versions')).map((row) => row[0])).toEqual([uuid7(5), uuid7(500)]);
  });

  test('engine-lww', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    await insert(a, 'ci_projects', project(P, 'Site', 1_000));
    await pass(a, 'device-a');
    await pass(b, 'device-b');

    // A newer rename wins.
    await a.execute('UPDATE ci_projects SET name = ?, updated_at = ? WHERE id = ?', ['Renamed', 2_000, P], 'run');
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    expect((await rowsOf(b, 'ci_projects'))[0]).toEqual(project(P, 'Renamed', 2_000));

    // A tombstone (`deleted_at`) is a value like any other, and a newer one wins.
    await b.execute('UPDATE ci_projects SET deleted_at = ?, updated_at = ? WHERE id = ?', [3_000, 3_000, P], 'run');
    await pass(b, 'device-b');
    await pass(a, 'device-a');
    expect((await rowsOf(a, 'ci_projects'))[0]).toEqual(project(P, 'Renamed', 3_000, 3_000));

    // An older edit (A's clock is behind) loses, in the replica and back on A.
    await a.execute('UPDATE ci_projects SET name = ?, deleted_at = NULL, updated_at = ? WHERE id = ?', ['Stale', 2_500, P], 'run');
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    for (const driver of [a, b, fx.replica]) expect((await rowsOf(driver, 'ci_projects'))[0]).toEqual(project(P, 'Renamed', 3_000, 3_000));

    // An identical row writes nothing.
    expect(written((await pass(a, 'device-a')).push)).toBe(0);
  });

  test.each([
    ['the second pusher larger', 'Alpha', 'Zulu'],
    ['the second pusher smaller', 'Zulu', 'Alpha'],
  ])('engine-lww: a tie on updated_at converges (%s)', async (_, first, second) => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    const id = uuid7(7);
    await insert(a, 'ci_projects', project(id, first, 4_000));
    await insert(b, 'ci_projects', project(id, second, 4_000));
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    await pass(a, 'device-a');
    // The version whose values sort larger: 'Zulu' > 'Alpha'.
    for (const driver of [a, b, fx.replica]) expect((await rowsOf(driver, 'ci_projects'))[0]).toEqual(project(id, 'Zulu', 4_000));
  });

  test('engine-applies-tombstones', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    const c = await fx.device('c');
    await seedEverything(a);
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    await pass(c, 'device-c');
    // C purges the diff on its own first (its own purge and tombstone), but pushes last.
    await purgeOn(c, uuid7(70), [['ci_diffs', uuid7(30)]], 1_900);

    // A purges the first version, its capture and the diff touching it (Phase 6's own path).
    const purged: [SyncTableName, string][] = [
      ['ci_versions', uuid7(10)],
      ['ci_captures', uuid7(20)],
      ['ci_diffs', uuid7(30)],
    ];
    await purgeOn(a, uuid7(60), purged, 2_000);
    const pushed = await pass(a, 'device-a');
    expect(pushed.push.tables.reduce((sum, t) => sum + t.deleted, 0)).toBe(3);

    // B deletes them too, children first (its `_purge_only` and `unreferenced_only` triggers pass).
    const pulled = await pass(b, 'device-b');
    expect(pulled.pull.tables.reduce((sum, t) => sum + t.deleted, 0)).toBe(3);
    await expectSameRows(a, b);
    await expectSameRows(a, fx.replica);
    expect((await rowsOf(b, 'ci_versions')).map((row) => row[0])).toEqual([uuid7(11)]);
    expect(await rowsOf(b, 'ci_tombstones')).toHaveLength(3);

    // C's purge row arrives; its tombstone for the same diff does not (one per row), nor A's on C.
    const report = await pass(c, 'device-c');
    expect(tableReport(report.push, 'ci_purges').written).toBe(1);
    expect(tableReport(report.push, 'ci_tombstones').written).toBe(0);
    expect(tableReport(report.pull, 'ci_tombstones').written).toBe(2);
    expect((await rowsOf(fx.replica, 'ci_tombstones')).map((row) => row[0])).toEqual([uuid7(2_000, 1), uuid7(2_000, 2), uuid7(2_000, 3)]);
    expect((await rowsOf(c, 'ci_tombstones')).map((row) => row[0])).toEqual([uuid7(1_900, 1), uuid7(2_000, 2), uuid7(2_000, 3)]);
    for (const name of SYNC_PURGE_DELETE_ORDER) expect(await rowsOf(c, name), name).toEqual(await rowsOf(a, name));
  });

  test('engine-never-resurrects', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    const d = await fx.device('d');
    await insert(a, 'ci_versions', version(uuid7(10), 1_000));
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    await purgeOn(a, uuid7(60), [['ci_versions', uuid7(10)]], 2_000);
    await pass(a, 'device-a');
    expect(await rowsOf(fx.replica, 'ci_versions')).toEqual([]);

    // B still has the row and pushes before it pulls: it is not put back, then B deletes it.
    const report = await pass(b, 'device-b');
    expect(tableReport(report.push, 'ci_versions').written).toBe(0);
    expect(await rowsOf(fx.replica, 'ci_versions')).toEqual([]);
    expect(await rowsOf(b, 'ci_versions')).toEqual([]);

    // A device that never had it: the log still names it, but it is never inserted.
    await pass(d, 'device-d');
    expect(await rowsOf(d, 'ci_versions')).toEqual([]);
    expect(await rowsOf(d, 'ci_tombstones')).toHaveLength(1);

    // A row with a tombstone in the replica is never pulled, even if the replica still holds it.
    await fx.replica.exec("DROP TRIGGER ci_versions_no_resurrect; INSERT INTO ci_versions (id, lane_key, page_url, render_profile, search_params, snapshot, snapshot_hash, snapshot_bytes, schema_version, parent_version_id, created_at) VALUES ('" + uuid7(10) + "', 'lane', 'https://example.com/', NULL, NULL, '{}', 'x', 1, 1, NULL, 1000)");
    await fx.replica.execute(`INSERT INTO ${SYNC_LOG_TABLE} (table_name, row_id) VALUES (?, ?)`, ['ci_versions', uuid7(10)], 'run');
    await pass(d, 'device-d');
    expect(await rowsOf(d, 'ci_versions')).toEqual([]);
  });

  test('engine-skips-missing-tables', async () => {
    // Today: no `ci_*` table anywhere.
    const bare = await openFixture({ replicaTables: false });
    try {
      await ensureSyncState(bare.replica);
      const today = await bare.device('today', { tables: false });
      const before = await tableNames(today);
      const report = await runSyncPass({ source: today, replica: bare.replica, deviceId: 'device-t', now: NOW });
      for (const direction of [report.push, report.pull]) {
        expect(direction.tables).toEqual(SYNC_TABLES.map((t) => ({ table: t.name, status: 'skipped', reason: 'missing-in-source', written: 0, deleted: 0 })));
      }
      expect(await tableNames(today)).toEqual(before);
      expect(await tableNames(bare.replica)).toEqual([SYNC_LOG_TABLE, SYNC_STATE_TABLE].sort());
      expect(await bare.replica.execute(`SELECT count(*) FROM ${SYNC_STATE_TABLE}`, [], 'get')).toEqual({ rows: [0] });

      // Only in the session database.
      const local = await bare.device('local');
      const onlyLocal = await pushPass({ source: local, replica: bare.replica, deviceId: 'device-l', now: NOW });
      expect(onlyLocal.tables.every((t) => t.status === 'skipped' && t.reason === 'missing-in-replica')).toBe(true);
    } finally {
      await bare.close();
    }

    // A column missing on one side; no tombstone table on either.
    const partial = await openFixture({ replicaTables: false });
    try {
      await ensureSyncState(partial.replica);
      const tables = SYNC_TABLES.filter((t) => t.name !== 'ci_tombstones').map((t) => t.name);
      await partial.replica.exec(tables.map((name) => tableSql(name, name === 'ci_projects' ? { without: 'retention_value' } : {})).join('\n'));
      const device = await partial.device('p', { tables: false });
      await device.exec(tables.map((name) => tableSql(name)).join('\n'));
      const report = await pushPass({ source: device, replica: partial.replica, deviceId: 'device-p', now: NOW });
      expect(tableReport(report, 'ci_projects')).toMatchObject({ status: 'skipped', reason: 'columns-missing' });
      expect(tableReport(report, 'ci_project_pages')).toMatchObject({ status: 'synced' });
      expect(tableReport(report, 'ci_purges')).toMatchObject({ status: 'synced' });
      expect(tableReport(report, 'ci_tombstones')).toMatchObject({ status: 'skipped', reason: 'missing-in-source' });
      for (const name of SYNC_PURGE_DELETE_ORDER) expect(tableReport(report, name)).toMatchObject({ status: 'skipped', reason: 'needs-tombstones' });
    } finally {
      await partial.close();
    }
  });

  test('engine-is-idempotent', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    await seedEverything(a);
    for (let n = 0; n < 7; n += 1) await insert(a, 'ci_versions', version(uuid7(100 + n), 1_100 + n));
    // Pages of 2 rows add up to every row.
    const first = await runSyncPass({ source: a, replica: fx.replica, deviceId: 'device-a', now: NOW, pageRows: 2 });
    expect(first.push.pages).toBeGreaterThan(1);
    expect(first.push.more).toBe(false);
    await runSyncPass({ source: b, replica: fx.replica, deviceId: 'device-b', now: NOW, pageRows: 2 });
    await expectSameRows(a, b);
    const entries = await logCount();

    for (const [driver, id] of [
      [a, 'device-a'],
      [b, 'device-b'],
    ] as const) {
      const again = await pass(driver, id);
      expect(written(again.push) + written(again.pull)).toBe(0);
    }
    expect(await logCount()).toBe(entries);
    await expectSameRows(a, b);
  });

  test('engine-pull-rolls-back', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    await seedEverything(a);
    await push(a, 'device-a');
    fx.raw('b').exec("CREATE TRIGGER refuse BEFORE INSERT ON ci_captures WHEN NEW.id = '" + uuid7(21) + "' BEGIN SELECT RAISE(ABORT, 'refused'); END");

    await expect(pull(b, 'device-b')).rejects.toThrow(/refused/);
    for (const { name } of SYNC_TABLES) expect(await rowsOf(b, name), name).toEqual([]);
    expect(await fx.replica.execute(`SELECT count(*) FROM ${SYNC_STATE_TABLE} WHERE device_id = ?`, ['device-b'], 'get')).toEqual({ rows: [0] });

    fx.raw('b').exec('DROP TRIGGER refuse');
    expect(written(await pull(b, 'device-b'))).toBe(9);
    await expectSameRows(a, b);
  });

  test('engine-state-in-replica-only', async () => {
    const a = await fx.device('a');
    const b = await fx.device('b');
    await seedEverything(a);
    const before = { a: await tableNames(a), b: await tableNames(b) };
    await pass(a, 'device-a');
    await pass(b, 'device-b');
    await pass(a, 'device-a');
    expect(await tableNames(a)).toEqual(before.a);
    expect(await tableNames(b)).toEqual(before.b);
    expect(await tableNames(fx.replica)).toEqual(expect.arrayContaining([SYNC_STATE_TABLE, SYNC_LOG_TABLE]));
    expect(before.a.some((name) => name.startsWith('frost_sync'))).toBe(false);
  });

  test('engine-quotes-spec-identifiers', async () => {
    const statements: string[] = [];
    const recording = (driver: SqlDriver): SqlDriver => ({
      kind: driver.kind,
      get isOpen() {
        return driver.isOpen;
      },
      execute: (sql, params, method) => (statements.push(sql), driver.execute(sql, params, method)),
      batch: (items) => {
        for (const item of items) statements.push('script' in item ? item.script : item.sql);
        return driver.batch(items);
      },
      exec: (script) => (statements.push(script), driver.exec(script)),
      close: () => driver.close(),
    });
    const a = await fx.device('a');
    const b = await fx.device('b');
    await seedEverything(a);
    await insert(a, 'ci_purges', purge(uuid7(80), 3_000));
    await insert(a, 'ci_tombstones', tombstone(uuid7(81), uuid7(80), 'history', uuid7(1), 3_000));
    await insert(a, 'ci_tombstones', tombstone(uuid7(82), uuid7(80), 'ci_projects"; DROP TABLE ci_projects; --', P, 3_000));
    await runSyncPass({ source: recording(a), replica: recording(fx.replica), deviceId: 'device-a', now: NOW });
    await runSyncPass({ source: recording(b), replica: recording(fx.replica), deviceId: 'device-b', now: NOW });

    const allowed = new Set<string>([
      ...SYNC_TABLES.flatMap((t) => [t.name, ...t.columns]),
      SYNC_STATE_TABLE,
      SYNC_LOG_TABLE,
      'device_id',
      'direction',
      'mark_time',
      'mark_id',
      'mark_seq',
      'seq',
    ]);
    const quoted = statements.flatMap((sql) => [...sql.matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.filter((name) => !allowed.has(name))).toEqual([]);
    expect(statements.some((sql) => /history|DROP/i.test(sql))).toBe(false);
    // The odd tombstones are rows, and deleted nothing.
    expect(await rowsOf(b, 'ci_tombstones')).toHaveLength(2);
    expect(await rowsOf(b, 'ci_projects')).toHaveLength(1);
    expect(() => quoteIdentifier('history')).toThrow();
    expect(() => quoteIdentifier('ci_projects"; --')).toThrow();
    expect(quoteIdentifier('ci_projects')).toBe('"ci_projects"');
    expect(triggerSql()).toContain('ci_versions_no_resurrect');
  });
});
