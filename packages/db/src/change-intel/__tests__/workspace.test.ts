// Spec: specs/workspace-db.spec.ts (WORKSPACE_TABLES, WORKSPACE_MIGRATION_IDS, SERP_READING_SOURCES, SERP_READING_STATUSES,
// ENTRY_KINDS, CAPTURE_CADENCES, SEARCH_KEY_VERSION, MAX_SERP_READING_JSON_BYTES, MAX_SERP_FILTERS_JSON_BYTES,
// MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, MAX_PROJECT_TAGS, TAG_MAX_CHARS, DOMAIN_MAX_CHARS)
// Acceptance: specs/workspace-db.feature.md (Scenarios)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  CAPTURE_CADENCES,
  DOMAIN_MAX_CHARS,
  MAX_READING_BYTES_PER_READ,
  MAX_READINGS_PER_READ,
  MAX_PROJECT_COMPETITORS,
  MAX_PROJECT_TAGS,
  MAX_SERP_FILTERS_JSON_BYTES,
  MAX_SERP_READING_JSON_BYTES,
  MAX_TAGS_PER_ENTRY,
  SEARCH_KEY_VERSION,
  TAG_MAX_CHARS,
  WORKSPACE_MIGRATION_IDS,
  WORKSPACE_TABLES,
} from '@app/specs/workspace-db.spec';
import { AI_CHECKS_MIGRATIONS } from '../../ai-checks-migrations';
import { createDrizzle } from '../../client';
import { createDrizzleOver } from '../../driver-drizzle';
import { libsqlFileUrl, openLibsqlDriver } from '../../driver-libsql';
import { runMigrationsOver } from '../../driver-migrations';
import { createNodeSqliteDriver } from '../../driver-node-sqlite';
import type { SqlDriver } from '../../driver-types';
import { MIGRATIONS, runMigrations } from '../../migrations';
import { uuidv7 } from '../ids';
import { CHANGE_INTEL_MIGRATIONS } from '../migrations';
import type { AppendReadingInput, CaptureReadingInput } from '../readings';
import { createChangeIntelRepository } from '../repository';
import { WORKSPACE_MIGRATIONS } from '../workspace-migrations';
import { appended, capture, captureInput, count, laneOf, openTestDb, sha256, utf8, type TestDb } from './fixtures';

// Real SQLite files on both drivers (the libSQL case): Windows runners are slow at file I/O.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SERP = 'https://www.google.com/search?q=green+tea';
const PARAMS = '{"engine":"google","query":"green tea"}';
const KEY = sha256('green tea key');
let t: TestDb;

beforeEach(() => {
  t = openTestDb();
});

/** A reading as main hands it in with a capture (`AppendCaptureInput.reading`). */
function readingOf(at: number, overrides: Partial<CaptureReadingInput> = {}): CaptureReadingInput {
  return {
    id: uuidv7(at),
    searchKey: KEY,
    searchKeyVersion: SEARCH_KEY_VERSION,
    searchParamsJson: PARAMS,
    filtersJson: '{}',
    status: 'ready',
    packVersion: 3,
    readingJson: JSON.stringify({ status: 'ready', at }),
    ...overrides,
  };
}

/** Captures `snapshot` of the result page with a reading (a diff from the lane's head when it changed). */
async function captureWithReading(at: number, snapshot: string, options: { projectId?: string; reading?: CaptureReadingInput; source?: 'manual' | 'project' } = {}) {
  const projectId = options.projectId ?? UNFILED_PROJECT_ID;
  const laneKey = laneOf(SERP, null, PARAMS);
  const latest = await t.repo.latestVersion(laneKey);
  const diff =
    latest && latest.snapshotHash !== sha256(snapshot)
      ? { id: uuidv7(at), fromVersionId: latest.id, engineVersion: 1, diffJson: '{"d":1}', summaryJson: '{"main":1}', changeCount: 1 }
      : undefined;
  const reading = options.reading ?? readingOf(at);
  const result = await t.repo.appendCapture(captureInput({ url: SERP, snapshot, at, projectId, params: PARAMS, reading, source: options.source ?? 'manual', ...(diff ? { diff } : {}) }));
  return { result, reading };
}

/** Plants a reading with raw SQL (as another source, or a tampered row, would be). */
function plant(raw: DatabaseSync, row: Partial<Record<string, SQLInputValue>> = {}): string {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const full: Record<string, SQLInputValue> = {
    id,
    project_id: UNFILED_PROJECT_ID,
    capture_id: null,
    source: 'serp-api',
    search_key: KEY,
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

/** Deletes a capture the way a pulled tombstone does on this device: a recorded purge and its tombstone, then the delete. */
function deleteCaptureAsSyncDoes(raw: DatabaseSync, captureId: string, at = 9_000): void {
  const purgeId = uuidv7(at);
  raw.prepare("INSERT INTO ci_purges (id, reason, project_id, policy, captures, versions, diffs, screenshots, bytes, created_at) VALUES (?, 'purge-now', NULL, NULL, 1, 0, 0, 0, 0, ?)").run(purgeId, at);
  raw.prepare("INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, ?, 'ci_captures', ?, ?)").run(uuidv7(at), purgeId, captureId, at);
  raw.prepare('DELETE FROM ci_captures WHERE id = ?').run(captureId);
}

const named = (raw: DatabaseSync, type: string): string[] =>
  raw
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((row) => String(row['name']));

const projectRow = (id: string) => ({ ...t.raw.prepare('SELECT * FROM ci_projects WHERE id = ?').get(id) });

describe('workspace storage', () => {
  test('workspace-migrations-apply-in-order', () => {
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toEqual([...WORKSPACE_MIGRATION_IDS]);
    const ids = MIGRATIONS.map((m) => m.id);
    const start = MIGRATIONS.indexOf(WORKSPACE_MIGRATIONS[0]!);
    // Spread last, together, after Phase 6's 0041 and Phase 9's 0210.
    expect(MIGRATIONS.slice(start)).toEqual(WORKSPACE_MIGRATIONS);
    expect(start).toBeGreaterThan(MIGRATIONS.indexOf(CHANGE_INTEL_MIGRATIONS[1]!));
    expect(start).toBeGreaterThan(MIGRATIONS.indexOf(AI_CHECKS_MIGRATIONS[AI_CHECKS_MIGRATIONS.length - 1]!));
    expect(ids.indexOf('0210_seo_ai_checks')).toBe(start - 1);
    expect(WORKSPACE_MIGRATION_IDS.every((id) => id >= '0220' && id < '0230')).toBe(true);
    // Strictly increasing ids still (`migrations-are-forward-only`).
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);

    // A database at 0210 (every earlier migration) takes exactly 0220–0223, in order.
    const db = new DatabaseSync(':memory:');
    expect(runMigrations(db, MIGRATIONS.slice(0, start))).toHaveLength(start);
    expect(runMigrations(db)).toEqual([...WORKSPACE_MIGRATION_IDS]);
    for (const table of WORKSPACE_TABLES) expect(named(db, 'table'), table).toContain(table);

    // Plain SQL both drivers run (Phase 6's portability rule).
    const forbidden = [/\bPRAGMA\b/i, /\bATTACH\b/i, /\bVIRTUAL\b/i, /\bjson\w*\s*\(/i, /->/, /\bGENERATED\b|\bAS\s*\(/i, /\bSTRICT\b/i, /\bWITHOUT\s+ROWID\b/i, /\bAUTOINCREMENT\b/i];
    for (const migration of WORKSPACE_MIGRATIONS) for (const pattern of forbidden) expect(pattern.test(migration.sql), `${migration.id}: ${pattern}`).toBe(false);
  });

  test('serp-readings-triggers-named', () => {
    const triggers = named(t.raw, 'trigger');
    expect(triggers).toEqual(expect.arrayContaining(['ci_serp_readings_no_update', 'ci_serp_readings_no_replace', 'ci_serp_readings_capture_gone_only']));
    expect(triggers.filter((name) => name.startsWith('ci_serp_readings'))).toHaveLength(3);
    for (const table of ['ci_project_competitors', 'ci_entry_tags']) {
      expect(triggers.filter((name) => name.startsWith(`${table}_`)).sort(), table).toEqual([`${table}_id_stays`, `${table}_live_key_unique`, `${table}_no_delete`, `${table}_no_replace`]);
    }
  });

  test('serp-readings-are-append-only', async () => {
    const { result, reading } = await captureWithReading(1_000, '{"v":1}');
    appended(result);
    const before = t.raw.prepare('SELECT * FROM ci_serp_readings').all();
    expect(before).toHaveLength(1);
    expect(() => t.raw.prepare('UPDATE ci_serp_readings SET status = ? WHERE id = ?').run('unreadable', reading.id)).toThrow(/append-only/);
    expect(() => t.raw.prepare('UPDATE OR REPLACE ci_serp_readings SET id = ? WHERE id = ?').run(uuidv7(), reading.id)).toThrow(/append-only/);
    const row = t.raw.prepare('SELECT * FROM ci_serp_readings WHERE id = ?').get(reading.id)!;
    const columns = Object.keys(row);
    const again = (verb: string, changes: Record<string, SQLInputValue>) => () =>
      t.raw.prepare(`${verb} INTO ci_serp_readings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...(Object.values({ ...row, ...changes }) as SQLInputValue[]));
    for (const verb of ['REPLACE', 'INSERT OR REPLACE', 'INSERT', 'INSERT OR IGNORE']) {
      expect(again(verb, { status: 'unreadable' }), verb).toThrow(/never replaced/);
      // Over the id with another capture id: refused by the id alone.
      expect(again(verb, { capture_id: uuidv7() }), verb).toThrow(/never replaced/);
      // A new id over the taken capture id: refused by the capture id.
      expect(again(verb, { id: uuidv7() }), verb).toThrow(/never replaced/);
    }
    // Upserts, over the id and over the capture id.
    const upsert = (changes: Record<string, SQLInputValue>, target: string) => () =>
      t.raw
        .prepare(`INSERT INTO ci_serp_readings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT ${target} DO UPDATE SET status = 'unreadable'`)
        .run(...(Object.values({ ...row, ...changes }) as SQLInputValue[]));
    expect(upsert({}, '(id)')).toThrow(/never replaced/);
    expect(upsert({ id: uuidv7() }, '(capture_id) WHERE capture_id IS NOT NULL')).toThrow(/never replaced/);
    expect(upsert({ id: uuidv7() }, '')).toThrow(/never replaced/);
    expect(() => t.raw.prepare('INSERT INTO ci_serp_readings SELECT * FROM ci_serp_readings WHERE true ON CONFLICT DO NOTHING').run()).toThrow(/never replaced/);
    expect(t.raw.prepare('SELECT * FROM ci_serp_readings').all()).toEqual(before);
  });

  test('serp-reading-deleted-only-without-its-capture', async () => {
    const first = appended((await captureWithReading(1_000, '{"v":1}')).result);
    const kept = (await captureWithReading(2_000, '{"v":2}')).reading;
    const apiRow = plant(t.raw);
    expect(() => t.raw.exec('DELETE FROM ci_serp_readings')).toThrow(/capture is gone/);
    expect(count(t.raw, 'ci_serp_readings')).toBe(3);
    // Its capture gone: that reading (only) can be deleted.
    deleteCaptureAsSyncDoes(t.raw, first.captureId);
    expect(() => t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(apiRow)).toThrow(/capture is gone/);
    expect(() => t.raw.prepare('DELETE FROM ci_serp_readings WHERE id = ?').run(kept.id)).toThrow(/capture is gone/);
    t.raw.prepare('DELETE FROM ci_serp_readings WHERE capture_id = ?').run(first.captureId);
    expect(count(t.raw, 'ci_serp_readings')).toBe(2);
    // The CHECKs: a capture reading names its capture; enums.
    expect(() => plant(t.raw, { source: 'capture', capture_id: null })).toThrow();
    expect(() => plant(t.raw, { source: 'scraper' })).toThrow();
    expect(() => plant(t.raw, { status: 'pending' })).toThrow();
    expect(() => plant(t.raw, { id: 'short' })).toThrow();
  });

  test('serp-api-reading-refused-in-phase-10', async () => {
    const { result } = await captureWithReading(1_000, '{"v":1}', { reading: undefined });
    const { captureId } = appended(result);
    expect(count(t.raw, 'ci_serp_readings')).toBe(1);
    const api: AppendReadingInput = { ...readingOf(2_000), projectId: UNFILED_PROJECT_ID, captureId: null, source: 'serp-api', pageUrl: null, observedAt: 2_000, createdAt: 2_000 };
    expect(await t.repo.appendReading(api)).toBe(false);
    expect(await t.repo.appendReading({ ...api, captureId })).toBe(false);
    expect(count(t.raw, 'ci_serp_readings')).toBe(1);

    // A capture reading through the public path: only for a capture of its project with no reading yet.
    const plain = appended(await capture(t.repo, { url: 'https://example.com/', snapshot: '{"p":1}', at: 3_000 }));
    const own: AppendReadingInput = { ...readingOf(3_000), projectId: UNFILED_PROJECT_ID, captureId: plain.captureId, source: 'capture', pageUrl: 'https://example.com/', observedAt: 3_000, createdAt: 3_000 };
    expect(await t.repo.appendReading({ ...own, captureId: uuidv7() })).toBe(false);
    const other = (await t.repo.createProject('Other', 3_000))!;
    expect(await t.repo.appendReading({ ...own, projectId: other.id })).toBe(false);
    expect(await t.repo.appendReading({ ...own, captureId })).toBe(false);
    expect(await t.repo.appendReading(own)).toBe(true);
    expect(await t.repo.appendReading({ ...own, id: uuidv7(3_001) })).toBe(false);
    expect(count(t.raw, 'ci_serp_readings')).toBe(2);
  });

  test('reading-goes-in-with-its-capture', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    // A new version, then the same hash again (the unchanged-head branch): each with its reading.
    const one = await captureWithReading(1_000, '{"v":1}', { projectId: site.id });
    const two = await captureWithReading(2_000, '{"v":1}', { projectId: site.id, reading: readingOf(2_000, { status: 'unreadable', packVersion: null, filtersJson: '{"tbs":"qdr:w"}', searchKey: sha256('other') }) });
    expect(appended(one.result).newVersion).toBe(true);
    expect(appended(two.result).newVersion).toBe(false);
    const stored = await t.repo.reading(one.reading.id);
    expect(stored).toEqual({
      ...one.reading,
      projectId: site.id,
      captureId: appended(one.result).captureId,
      source: 'capture',
      pageUrl: SERP,
      readingBytes: utf8(one.reading.readingJson),
      observedAt: 1_000,
      createdAt: 1_000,
    });
    expect((await t.repo.reading(two.reading.id))?.captureId).toBe(appended(two.result).captureId);

    // An invalid reading makes the append invalid: nothing is written.
    const captures = count(t.raw, 'ci_captures');
    for (const bad of [
      readingOf(3_000, { id: 'nope' }),
      readingOf(3_000, { searchKey: 'KEY' }),
      readingOf(3_000, { searchKeyVersion: 0 }),
      readingOf(3_000, { status: 'pending' as never }),
      readingOf(3_000, { packVersion: 0 }),
      readingOf(3_000, { searchParamsJson: '' }),
      readingOf(3_000, { filtersJson: 'x'.repeat(MAX_SERP_FILTERS_JSON_BYTES + 1) }),
      readingOf(3_000, { readingJson: 'x'.repeat(MAX_SERP_READING_JSON_BYTES + 1) }),
      readingOf(3_000, { readingJson: '' }),
      readingOf(3_000, { id: one.reading.id }),
    ]) {
      expect(await t.repo.appendCapture(captureInput({ url: SERP, snapshot: '{"v":1}', at: 3_000, projectId: site.id, params: PARAMS, reading: bad })), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    expect(count(t.raw, 'ci_captures')).toBe(captures);

    // A stale append writes no reading: a diff from a version that is not the head (refused before
    // the batch), and captures racing into the lane (refused inside it), from either branch.
    const head = (await t.repo.latestVersion(laneOf(SERP, null, PARAMS)))!;
    const stale = readingOf(3_100);
    const notHead = { id: uuidv7(3_100), fromVersionId: uuidv7(1), engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 1 };
    expect(await t.repo.appendCapture(captureInput({ url: SERP, snapshot: '{"v":3}', at: 3_100, projectId: site.id, params: PARAMS, reading: stale, diff: notHead }))).toEqual({ status: 'stale' });
    expect(await t.repo.reading(stale.id)).toBeNull();
    let latest = head;
    for (const [n, kind] of [
      [0, 'same-hash branch'],
      [1, 'new-version branch'],
    ] as const) {
      const at = 3_200 + n * 100;
      // Both read the same head (they await in lockstep: the same-hash one carries a diff too, ignored,
      // so neither waits less); the first writes a new version, so the second is refused in its batch.
      const diff = { id: uuidv7(at), fromVersionId: latest.id, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 1 };
      const second = kind === 'same-hash branch' ? (await t.repo.version(latest.id))!.snapshotJson : `{"race":${n},"second":true}`;
      const racers = [`{"race":${n}}`, second].map((snapshot, i) => {
        const reading = readingOf(at + i);
        return { reading, input: captureInput({ url: SERP, snapshot, at: at + i, projectId: site.id, params: PARAMS, reading, diff: { ...diff, id: uuidv7(at + i) } }) };
      });
      const results = await Promise.all(racers.map((racer) => t.repo.appendCapture(racer.input)));
      expect(results.map((r) => r?.status), kind).toEqual(['appended', 'stale']);
      expect(await t.repo.reading(racers[0]!.reading.id), kind).not.toBeNull();
      expect(await t.repo.reading(racers[1]!.reading.id), kind).toBeNull();
      latest = (await t.repo.latestVersion(laneOf(SERP, null, PARAMS)))!;
    }
    expect(count(t.raw, 'ci_serp_readings')).toBe(4);

    // A capture without a reading stores none (Phase 6's path, unchanged).
    appended(await capture(t.repo, { url: 'https://example.com/', snapshot: '{"p":1}', at: 5_000, projectId: site.id }));
    expect(count(t.raw, 'ci_serp_readings')).toBe(4);

    // The reads (the racers' two readings are of KEY, at 3 200 and 3 300).
    const all = await t.repo.readings({ projectId: site.id, limit: 10 });
    expect(all.map((r) => r.observedAt)).toEqual([...all.map((r) => r.observedAt)].sort((a, b) => b - a));
    expect(all.slice(2).map((r) => r.id)).toEqual([two.reading.id, one.reading.id]);
    expect((await t.repo.readings({ projectId: site.id, searchKey: sha256('other'), limit: 10 })).map((r) => r.id)).toEqual([two.reading.id]);
    expect((await t.repo.readings({ projectId: site.id, from: 1_500, to: 2_500, limit: 10 })).map((r) => r.id)).toEqual([two.reading.id]);
    expect((await t.repo.readings({ projectId: site.id, to: 1_500, limit: 10 })).map((r) => r.id)).toEqual([one.reading.id]);
    expect((await t.repo.readings({ projectId: site.id, limit: 1 })).map((r) => r.id)).toEqual([all[0]!.id]);
    expect(await t.repo.readings({ projectId: UNFILED_PROJECT_ID, limit: 10 })).toEqual([]);
    expect(await t.repo.readings({ projectId: 'nope', limit: 10 })).toEqual([]);
    expect(await t.repo.readingSearches(site.id)).toEqual([
      { searchKey: KEY, searchKeyVersion: 1, searchParamsJson: PARAMS, filtersJson: '{}', readings: 3, lastObservedAt: all[0]!.observedAt },
      { searchKey: sha256('other'), searchKeyVersion: 1, searchParamsJson: PARAMS, filtersJson: '{"tbs":"qdr:w"}', readings: 1, lastObservedAt: 2_000 },
    ]);
    // A tampered row is skipped.
    plant(t.raw, { project_id: site.id, search_key: 'not-a-hash', observed_at: 6_000 });
    plant(t.raw, { project_id: site.id, reading: 'x'.repeat(MAX_SERP_READING_JSON_BYTES + 1), observed_at: 6_000 });
    expect((await t.repo.readings({ projectId: site.id, limit: 10 })).map((r) => r.id)).toEqual(all.map((r) => r.id));
  });

  test('purge-deletes-readings-of-purged-captures', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const old = await captureWithReading(1_000, '{"v":1}', { projectId: site.id });
    const kept = await captureWithReading(2_000, '{"v":2}', { projectId: site.id });
    expect(await t.repo.setRetention(site.id, 'versions', 1, 2_500)).toBe(true);
    const plan = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'versions', value: 1 }, now: 3_000 }))!;
    expect(plan.captureIds).toEqual([appended(old.result).captureId]);
    expect(await t.repo.executePurge(plan, 'retention', 3_000)).toMatchObject({ status: 'purged' });
    expect(await t.repo.reading(old.reading.id)).toBeNull();
    expect(count(t.raw, 'ci_serp_readings', 'id = ?', old.reading.id)).toBe(0);
    expect((await t.repo.reading(kept.reading.id))?.id).toBe(kept.reading.id);

    // The project deleted: its everything purge takes the rest of its readings; another project's stay.
    const other = (await t.repo.createProject('Other', 500))!;
    const theirs = await captureWithReading(4_000, '{"v":4}', { projectId: other.id });
    expect(await t.repo.tombstoneProject(site.id, 5_000)).toBe(true);
    const all = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'all' }, now: 5_000 }))!;
    expect(await t.repo.executePurge(all, 'project-deleted', 5_000)).toMatchObject({ status: 'purged' });
    expect(count(t.raw, 'ci_serp_readings', 'project_id = ?', site.id)).toBe(0);
    expect((await t.repo.reading(theirs.reading.id))?.id).toBe(theirs.reading.id);
  });

  test('purge-plan-counts-reading-bytes', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const big = readingOf(1_000, { readingJson: JSON.stringify({ status: 'ready', title: 'é'.repeat(500) }) });
    await captureWithReading(1_000, '{"v":1}', { projectId: site.id, reading: big });
    await captureWithReading(2_000, '{"v":2}', { projectId: site.id });
    const plan = (await t.repo.planPurge({ projectId: site.id, policy: { mode: 'versions', value: 1 }, now: 3_000 }))!;
    const version = (await t.repo.version(plan.versionIds[0]!))!;
    const diffBytes = Number(t.raw.prepare('SELECT coalesce(sum(length(CAST(diff AS BLOB))), 0) AS n FROM ci_diffs WHERE from_version_id = ? OR to_version_id = ?').get(version.id, version.id)!['n']);
    expect(plan.bytes).toBe(utf8(version.snapshotJson) + diffBytes + utf8(big.readingJson));
    expect(await t.repo.setRetention(site.id, 'versions', 1, 2_500)).toBe(true);
    const done = await t.repo.executePurge(plan, 'retention', 3_000);
    expect(done).toMatchObject({ status: 'purged' });
    expect(Number(t.raw.prepare('SELECT bytes FROM ci_purges').get()!['bytes'])).toBe(plan.bytes);
    // The ci_purges columns are Phase 6's, unchanged.
    expect(Object.keys(t.raw.prepare('SELECT * FROM ci_purges').get()!).sort()).toEqual(['bytes', 'captures', 'created_at', 'diffs', 'id', 'policy', 'project_id', 'reason', 'screenshots', 'versions']);
  });

  test('orphan-readings-swept', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const gone = await captureWithReading(1_000, '{"v":1}', { projectId: site.id });
    const stays = await captureWithReading(2_000, '{"v":2}', { projectId: site.id });
    const elsewhere = await captureWithReading(2_500, '{"v":3}');
    const api = plant(t.raw, { project_id: site.id, observed_at: 2_200 });
    deleteCaptureAsSyncDoes(t.raw, appended(gone.result).captureId);
    deleteCaptureAsSyncDoes(t.raw, appended(elsewhere.result).captureId, 9_001);
    // The reads skip the capture-sourced orphan, never the capture-less API reading.
    expect((await t.repo.readings({ projectId: site.id, limit: 10 })).map((r) => r.id)).toEqual([api, stays.reading.id]);
    expect(await t.repo.reading(gone.reading.id)).toBeNull();
    expect((await t.repo.reading(api))?.source).toBe('serp-api');
    expect((await t.repo.readingSearches(site.id)).map((s) => s.readings)).toEqual([2]);
    // One project's sweep, then everything's.
    expect(await t.repo.deleteOrphanReadings(site.id)).toBe(1);
    expect(count(t.raw, 'ci_serp_readings')).toBe(3);
    expect(await t.repo.deleteOrphanReadings()).toBe(1);
    expect(await t.repo.deleteOrphanReadings()).toBe(0);
    expect(count(t.raw, 'ci_serp_readings')).toBe(2);
    expect(t.raw.prepare('SELECT id FROM ci_serp_readings ORDER BY id').all().map((row) => row['id'])).toEqual([stays.reading.id, api].sort());
    expect(await t.repo.deleteOrphanReadings('nope')).toBe(0);
  });

  test('competitors-and-tags-are-tombstoned', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    // Competitors: one live row per domain, capped, never on Unfiled, validated.
    const rival = (await t.repo.addCompetitor(site.id, 'rival.com', 1_000))!;
    expect(rival).toEqual({ id: expect.any(String), projectId: site.id, domain: 'rival.com', createdAt: 1_000, updatedAt: 1_000 });
    expect(await t.repo.addCompetitor(site.id, 'rival.com', 1_100)).toEqual(rival);
    for (const bad of ['', 'Rival.com', ' rival.com', 'a'.repeat(DOMAIN_MAX_CHARS + 1), 'rival.com/path', 'http://rival.com']) expect(await t.repo.addCompetitor(site.id, bad, 1_200), bad).toBeNull();
    expect(await t.repo.addCompetitor(UNFILED_PROJECT_ID, 'rival.com', 1_200)).toBeNull();
    for (let i = 1; i < MAX_PROJECT_COMPETITORS; i++) expect(await t.repo.addCompetitor(site.id, `c${i}.example.org`, 1_300 + i)).not.toBeNull();
    expect(await t.repo.addCompetitor(site.id, 'one-too-many.org', 1_400)).toBeNull();
    expect(await t.repo.competitors(site.id)).toHaveLength(MAX_PROJECT_COMPETITORS);
    expect(await t.repo.removeCompetitor(site.id, rival.id, 1_500)).toBe(true);
    expect(await t.repo.removeCompetitor(site.id, rival.id, 1_600)).toBe(false);
    expect(t.raw.prepare('SELECT deleted_at, updated_at FROM ci_project_competitors WHERE id = ?').get(rival.id)).toEqual({ deleted_at: 1_500, updated_at: 1_500 });
    expect((await t.repo.addCompetitor(site.id, 'rival.com', 1_700))?.id).not.toBe(rival.id);
    expect(() => t.raw.exec('DELETE FROM ci_project_competitors')).toThrow(/never deleted/);
    // A project that is not live answers nothing, not even its existing live row.
    const gone = (await t.repo.createProject('Gone', 1_800))!;
    expect(await t.repo.addCompetitor(gone.id, 'rival.com', 1_800)).not.toBeNull();
    t.raw.prepare('UPDATE ci_projects SET deleted_at = 1900, updated_at = 1900 WHERE id = ?').run(gone.id);
    expect(await t.repo.addCompetitor(gone.id, 'rival.com', 1_950)).toBeNull();
    expect(await t.repo.addCompetitor(gone.id, 'other.com', 1_950)).toBeNull();
    expect(await t.repo.addCompetitor(uuidv7(), 'rival.com', 1_950)).toBeNull();
    expect(() => t.raw.prepare('INSERT INTO ci_project_competitors (id, project_id, domain, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 1, 1, NULL)').run(uuidv7(), site.id, 'rival.com')).toThrow(/never replaced/);

    // Tags on a page and a saved search.
    const page = (await t.repo.addPage(site.id, 'https://example.com/tea', 2_000))!;
    const search = (await t.repo.addQuery(site.id, 'green tea', PARAMS, 2_000))!;
    const tagsOf = async (kind: 'page' | 'search', id: string) => (await t.repo.projectTags(site.id)).filter((tag) => tag.entryKind === kind && tag.entryId === id).map((tag) => tag.tag).sort();
    expect((await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: page.id, tags: ['brand', 'tea'], now: 2_100 }))?.map((tag) => tag.tag).sort()).toEqual(['brand', 'tea']);
    const brand = String(t.raw.prepare("SELECT id FROM ci_entry_tags WHERE tag = 'brand'").get()!['id']);
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: page.id, tags: ['tea', 'green'], now: 2_200 })).not.toBeNull();
    expect(await tagsOf('page', page.id)).toEqual(['green', 'tea']);
    expect(t.raw.prepare('SELECT deleted_at FROM ci_entry_tags WHERE id = ?').get(brand)).toEqual({ deleted_at: 2_200 });
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'search', entryId: search.id, tags: ['tea'], now: 2_300 })).not.toBeNull();
    // Refused, nothing written: a bad tag, too many, an entry of another project or kind, a tombstoned project.
    const rows = count(t.raw, 'ci_entry_tags');
    for (const tags of [[' tea'], [''], ['x'.repeat(TAG_MAX_CHARS + 1)], Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, i) => `t${i}`)]) {
      expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: page.id, tags, now: 2_400 }), JSON.stringify(tags)).toBeNull();
    }
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'search', entryId: page.id, tags: ['x'], now: 2_400 })).toBeNull();
    expect(await t.repo.setEntryTags({ projectId: UNFILED_PROJECT_ID, entryKind: 'page', entryId: page.id, tags: ['x'], now: 2_400 })).toBeNull();
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: uuidv7(), tags: ['x'], now: 2_400 })).toBeNull();
    expect(count(t.raw, 'ci_entry_tags')).toBe(rows);
    expect(await tagsOf('page', page.id)).toEqual(['green', 'tea']);
    // The project's distinct tags are capped.
    // 'green' and 'tea', then six pages of eight new tags each: exactly MAX_PROJECT_TAGS.
    expect(2 + 6 * MAX_TAGS_PER_ENTRY).toBe(MAX_PROJECT_TAGS);
    const pages = [];
    for (let i = 0; i < 7; i++) pages.push((await t.repo.addPage(site.id, `https://example.com/p${i}`, 2_500))!);
    for (const [i, p] of pages.slice(0, 6).entries()) expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: p.id, tags: Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, j) => `p${i}-${j}`), now: 2_600 })).not.toBeNull();
    expect(new Set((await t.repo.projectTags(site.id)).map((tag) => tag.tag)).size).toBe(MAX_PROJECT_TAGS);
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: pages[6]!.id, tags: ['one-more'], now: 2_650 })).toBeNull();
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'search', entryId: search.id, tags: ['tea', 'new-one'], now: 2_700 })).toBeNull();
    // Freeing a tag makes room: page p0 drops 'p0-0', and the search may take a new one.
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'page', entryId: pages[0]!.id, tags: Array.from({ length: MAX_TAGS_PER_ENTRY - 1 }, (_, j) => `p0-${j + 1}`), now: 2_680 })).not.toBeNull();
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'search', entryId: search.id, tags: ['tea', 'new-one'], now: 2_690 })).not.toBeNull();
    // A tag the project already has always fits.
    expect(await t.repo.setEntryTags({ projectId: site.id, entryKind: 'search', entryId: search.id, tags: ['tea', 'new-one', 'green'], now: 2_700 })).not.toBeNull();
    expect(() => t.raw.exec('DELETE FROM ci_entry_tags')).toThrow(/never deleted/);
    expect(() =>
      t.raw.prepare("INSERT INTO ci_entry_tags (id, project_id, entry_kind, entry_id, tag, created_at, updated_at, deleted_at) VALUES (?, ?, 'page', ?, 'tea', 1, 1, NULL)").run(uuidv7(), site.id, page.id),
    ).toThrow(/never replaced/);
    expect(() =>
      t.raw.prepare("INSERT INTO ci_entry_tags (id, project_id, entry_kind, entry_id, tag, created_at, updated_at, deleted_at) VALUES (?, ?, 'post', ?, 'x', 1, 1, NULL)").run(uuidv7(), site.id, page.id),
    ).toThrow();

    // Removing the page or the search tombstones its tags, in its batch.
    const total = count(t.raw, 'ci_entry_tags');
    expect(await t.repo.removePage(site.id, page.id, 3_000)).toBe(true);
    expect(await tagsOf('page', page.id)).toEqual([]);
    expect(count(t.raw, 'ci_entry_tags', 'entry_id = ? AND deleted_at = 3000', page.id)).toBe(2);
    expect(await t.repo.removeQuery(site.id, search.id, 3_100)).toBe(true);
    expect(await tagsOf('search', search.id)).toEqual([]);
    expect(count(t.raw, 'ci_entry_tags')).toBe(total);

    // Deleting the project tombstones its competitors and tags with its pages and searches.
    expect(await t.repo.tombstoneProject(site.id, 4_000)).toBe(true);
    expect(count(t.raw, 'ci_project_competitors', 'project_id = ? AND deleted_at IS NULL', site.id)).toBe(0);
    expect(count(t.raw, 'ci_entry_tags', 'project_id = ? AND deleted_at IS NULL', site.id)).toBe(0);
    expect(count(t.raw, 'ci_project_competitors', 'project_id = ? AND deleted_at = 4000', site.id)).toBe(MAX_PROJECT_COMPETITORS);
    expect(count(t.raw, 'ci_entry_tags')).toBe(total);
    expect(await t.repo.competitors(site.id)).toEqual([]);

    // A project deleted through sync (its row's deleted_at, no tombstoneProject here): the sweep.
    const synced = (await t.repo.createProject('Synced', 5_000))!;
    await t.repo.addCompetitor(synced.id, 'rival.com', 5_000);
    const syncedPage = (await t.repo.addPage(synced.id, 'https://example.com/s', 5_000))!;
    await t.repo.setEntryTags({ projectId: synced.id, entryKind: 'page', entryId: syncedPage.id, tags: ['a', 'b'], now: 5_000 });
    // And a live project whose page was removed through sync: that page's tags are orphans too.
    const live = (await t.repo.createProject('Live', 5_000))!;
    const livePage = (await t.repo.addPage(live.id, 'https://example.com/l', 5_000))!;
    await t.repo.setEntryTags({ projectId: live.id, entryKind: 'page', entryId: livePage.id, tags: ['kept-page-gone'], now: 5_000 });
    await t.repo.addCompetitor(live.id, 'stays.com', 5_000);
    t.raw.prepare('UPDATE ci_projects SET deleted_at = 6000, updated_at = 6000 WHERE id = ?').run(synced.id);
    t.raw.prepare('UPDATE ci_project_pages SET deleted_at = 6000, updated_at = 6000 WHERE id = ?').run(livePage.id);
    const before = count(t.raw, 'ci_entry_tags') + count(t.raw, 'ci_project_competitors');
    // Synced's competitor and two tags, Live's removed page's tag, and Gone's competitor (deleted above).
    expect(await t.repo.tombstoneOrphanWorkspaceRows(7_000)).toBe(5);
    expect(await t.repo.tombstoneOrphanWorkspaceRows(7_100)).toBe(0);
    expect(count(t.raw, 'ci_entry_tags') + count(t.raw, 'ci_project_competitors')).toBe(before);
    expect(count(t.raw, 'ci_entry_tags', 'deleted_at IS NULL AND project_id IN (?, ?)', synced.id, live.id)).toBe(0);
    expect(count(t.raw, 'ci_project_competitors', 'deleted_at IS NULL AND project_id = ?', live.id)).toBe(1);
  });

  test('project-flags-default-on-old-rows', async () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.id < '0220'),
    );
    // A project written by an earlier build, before 0220.
    const id = uuidv7(1_000);
    db.prepare("INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at) VALUES (?, 'Old', NULL, 'forever', NULL, 1000, 1000, NULL)").run(id);
    runMigrations(db);
    const repo = createChangeIntelRepository(createDrizzle(db));
    const defaults = { favorite: false, siteDomain: null, siteSubdomains: true, cadence: 'off', autoCapture: false };
    expect(await repo.projectWorkspace(id)).toEqual({ projectId: id, ...defaults });
    expect(await repo.projectWorkspace(UNFILED_PROJECT_ID)).toEqual({ projectId: UNFILED_PROJECT_ID, ...defaults });
    expect(await repo.projectWorkspaces()).toEqual([
      { projectId: UNFILED_PROJECT_ID, ...defaults },
      { projectId: id, ...defaults },
    ]);
    expect({ ...db.prepare('SELECT favorite, site_domain, site_subdomains, capture_cadence, auto_capture FROM ci_projects WHERE id = ?').get(UNFILED_PROJECT_ID) }).toEqual({
      favorite: 0,
      site_domain: null,
      site_subdomains: 1,
      capture_cadence: 'off',
      auto_capture: 0,
    });
    // CHECKs on the new columns.
    expect(() => db.prepare("UPDATE ci_projects SET capture_cadence = 'hourly' WHERE id = ?").run(id)).toThrow();
    expect(() => db.prepare('UPDATE ci_projects SET favorite = 2 WHERE id = ?').run(id)).toThrow();
    expect(() => db.prepare('UPDATE ci_projects SET auto_capture = 2 WHERE id = ?').run(id)).toThrow();
    expect(() => db.prepare('UPDATE ci_projects SET site_subdomains = -1 WHERE id = ?').run(id)).toThrow();
    expect(() => db.prepare('UPDATE ci_projects SET site_domain = ? WHERE id = ?').run('a'.repeat(DOMAIN_MAX_CHARS + 1), id)).toThrow();
    expect(CAPTURE_CADENCES[0]).toBe('off');
  });

  test('workspace-updates-leave-updated-at', async () => {
    const site = (await t.repo.createProject('Tea', 1_000))!;
    const updatedAt = () => projectRow(site.id)['updated_at'];
    expect(await t.repo.setProjectFavorite(site.id, true)).toBe(true);
    expect(await t.repo.setProjectSite(site.id, 'example.com', false)).toBe(true);
    expect(await t.repo.setProjectCadence(site.id, 'weekly')).toBe(true);
    expect(await t.repo.setProjectAutoCapture(site.id, true)).toBe(true);
    expect(updatedAt()).toBe(1_000);
    expect(await t.repo.projectWorkspace(site.id)).toEqual({ projectId: site.id, favorite: true, siteDomain: 'example.com', siteSubdomains: false, cadence: 'weekly', autoCapture: true });
    expect(await t.repo.setProjectSite(site.id, null, true)).toBe(true);
    expect(await t.repo.projectWorkspace(site.id)).toMatchObject({ siteDomain: null, siteSubdomains: true });
    // Refused: bad values, Unfiled's site, a project that is not live.
    expect(await t.repo.setProjectSite(site.id, 'Example.COM', true)).toBe(false);
    expect(await t.repo.setProjectSite(site.id, 'https://example.com/', true)).toBe(false);
    expect(await t.repo.setProjectSite(UNFILED_PROJECT_ID, 'example.com', true)).toBe(false);
    expect(await t.repo.setProjectCadence(site.id, 'hourly' as never)).toBe(false);
    expect(await t.repo.setProjectFavorite('nope', true)).toBe(false);
    expect(await t.repo.setProjectFavorite(UNFILED_PROJECT_ID, true)).toBe(true);
    expect(projectRow(UNFILED_PROJECT_ID)['updated_at']).toBe(0);
    expect(updatedAt()).toBe(1_000);
    // Phase 6's own updates still set it.
    expect(await t.repo.renameProject(site.id, 'Green tea', 2_000)).toBe(true);
    expect(updatedAt()).toBe(2_000);
    expect(await t.repo.projectWorkspace(site.id)).toMatchObject({ favorite: true, cadence: 'weekly' });
    expect(await t.repo.tombstoneProject(site.id, 3_000)).toBe(true);
    expect(await t.repo.setProjectFavorite(site.id, false)).toBe(false);
    expect(await t.repo.projectWorkspace(site.id)).toBeNull();
  });

  test('usage-counts-reading-bytes', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const mine = await captureWithReading(1_000, '{"v":1}', { projectId: site.id, reading: readingOf(1_000, { readingJson: JSON.stringify({ title: 'ü'.repeat(100) }) }) });
    const theirs = await captureWithReading(2_000, '{"v":2}');
    expect((await t.repo.usage(site.id))?.readingBytes).toBe(utf8(mine.reading.readingJson));
    expect((await t.repo.usage(UNFILED_PROJECT_ID))?.readingBytes).toBe(utf8(theirs.reading.readingJson));
    expect((await t.repo.usage())?.readingBytes).toBe(utf8(mine.reading.readingJson) + utf8(theirs.reading.readingJson));
    const empty = (await t.repo.createProject('Empty', 500))!;
    expect((await t.repo.usage(empty.id))?.readingBytes).toBe(0);
  });

  test('readings-read-is-bounded', async () => {
    // The count cap: `limit` is clamped to MAX_READINGS_PER_READ.
    const small = (n: number) => plant(t.raw, { id: uuidv7(10_000 + n), observed_at: 10_000 + n, reading: '{}', reading_bytes: 2 });
    for (let n = 0; n < MAX_READINGS_PER_READ + 5; n++) small(n);
    const capped = await t.repo.readings({ projectId: UNFILED_PROJECT_ID, limit: MAX_READINGS_PER_READ + 5 });
    expect(capped).toHaveLength(MAX_READINGS_PER_READ);
    expect(capped[0]!.observedAt).toBe(10_000 + MAX_READINGS_PER_READ + 4);
    expect(await t.repo.readings({ projectId: UNFILED_PROJECT_ID, limit: 0 })).toHaveLength(1);

    // The byte budget: readings of the cap's size, newest first, while their total fits (exactly 64 here).
    const site = (await t.repo.createProject('Big', 500))!;
    const big = `"${'x'.repeat(MAX_SERP_READING_JSON_BYTES - 2)}"`;
    expect(utf8(big)).toBe(MAX_SERP_READING_JSON_BYTES);
    const fits = MAX_READING_BYTES_PER_READ / MAX_SERP_READING_JSON_BYTES;
    expect(fits).toBe(64);
    for (let n = 0; n < fits + 3; n++) plant(t.raw, { id: uuidv7(20_000 + n), project_id: site.id, observed_at: 20_000 + n, reading: big, reading_bytes: MAX_SERP_READING_JSON_BYTES });
    const read = await t.repo.readings({ projectId: site.id, limit: MAX_READINGS_PER_READ });
    expect(read).toHaveLength(fits);
    expect(read.map((r) => r.observedAt)).toEqual(Array.from({ length: fits }, (_, i) => 20_000 + fits + 2 - i));
    expect(read.reduce((sum, r) => sum + r.readingBytes, 0)).toBe(MAX_READING_BYTES_PER_READ);
    // A smaller limit still answers its newest rows.
    expect((await t.repo.readings({ projectId: site.id, limit: 2 })).map((r) => r.observedAt)).toEqual([20_000 + fits + 2, 20_000 + fits + 1]);
  });

  // spec: specs/workspace-db.feature.md — Repository: `readings`' `maxBytes`, `countReadings`, `readingDates` (Phase 10 Task 5).
  test('reading-dates-count-and-byte-budget', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const other = (await t.repo.createProject('Other', 500))!;
    const OTHER_KEY = sha256('black tea key');
    const ids = [1_000, 2_000, 3_000].map((at) => plant(t.raw, { id: uuidv7(at), project_id: site.id, observed_at: at, reading: '"abcd"', reading_bytes: 6 }));
    plant(t.raw, { id: uuidv7(2_500), project_id: site.id, observed_at: 2_500, search_key: OTHER_KEY });
    plant(t.raw, { id: uuidv7(2_600), project_id: other.id, observed_at: 2_600 });
    const gone = await captureWithReading(3_500, '{"v":1}', { projectId: site.id, reading: readingOf(3_500) });
    deleteCaptureAsSyncDoes(t.raw, appended(gone.result).captureId);

    // Dates: newest first, the project's and the key's only, orphans skipped, no JSON.
    expect(await t.repo.readingDates({ projectId: site.id, searchKey: KEY, limit: 10 })).toEqual([
      { id: ids[2], observedAt: 3_000, status: 'ready' },
      { id: ids[1], observedAt: 2_000, status: 'ready' },
      { id: ids[0], observedAt: 1_000, status: 'ready' },
    ]);
    expect((await t.repo.readingDates({ projectId: site.id, searchKey: KEY, limit: 2 })).map((d) => d.id)).toEqual([ids[2], ids[1]]);
    expect((await t.repo.readingDates({ projectId: site.id, searchKey: KEY, limit: 0 })).map((d) => d.id)).toEqual([ids[2]]);
    expect((await t.repo.readingDates({ projectId: site.id, searchKey: OTHER_KEY, limit: 10 })).map((d) => d.observedAt)).toEqual([2_500]);
    expect((await t.repo.readingDates({ projectId: other.id, searchKey: KEY, limit: 10 })).map((d) => d.observedAt)).toEqual([2_600]);
    for (const bad of [{ projectId: 'nope', searchKey: KEY, limit: 5 }, { projectId: site.id, searchKey: 'KEY', limit: 5 }, null]) expect(await t.repo.readingDates(bad as never)).toEqual([]);

    // Counts: as `readings` filters, without its bounds.
    expect(await t.repo.countReadings({ projectId: site.id })).toBe(4);
    expect(await t.repo.countReadings({ projectId: site.id, searchKey: KEY })).toBe(3);
    expect(await t.repo.countReadings({ projectId: site.id, searchKey: KEY, from: 2_000 })).toBe(2);
    expect(await t.repo.countReadings({ projectId: site.id, searchKey: KEY, from: 1_500, to: 2_500 })).toBe(1);
    expect(await t.repo.countReadings({ projectId: 'nope' })).toBe(0);

    // A caller's own byte budget: the newest prefix within it (never above the repository's cap).
    expect((await t.repo.readings({ projectId: site.id, searchKey: KEY, limit: 10, maxBytes: 12 })).map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect((await t.repo.readings({ projectId: site.id, searchKey: KEY, limit: 10, maxBytes: 5 }))).toEqual([]);
    expect((await t.repo.readings({ projectId: site.id, searchKey: KEY, limit: 10, maxBytes: 0 }))).toEqual([]);
    expect(await t.repo.readings({ projectId: site.id, searchKey: KEY, limit: 10, maxBytes: Number.MAX_SAFE_INTEGER })).toHaveLength(3);
  });

  test('last-project-run-at', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const other = (await t.repo.createProject('Other', 500))!;
    expect(await t.repo.lastProjectRunAt(site.id)).toBeNull();
    await captureWithReading(1_000, '{"v":1}', { projectId: site.id, source: 'project' });
    await captureWithReading(3_000, '{"v":2}', { projectId: site.id, source: 'manual' });
    await captureWithReading(4_000, '{"v":3}', { projectId: other.id, source: 'project' });
    appended(await t.repo.appendCapture(captureInput({ url: 'https://example.com/', snapshot: '{"p":1}', at: 2_000, projectId: site.id, source: 'project' })));
    expect(await t.repo.lastProjectRunAt(site.id)).toBe(2_000);
    expect(await t.repo.lastProjectRunAt(other.id)).toBe(4_000);
    expect(await t.repo.lastProjectRunAt('nope')).toBeNull();
  });

  // spec: specs/workspace-db.feature.md — Repository: `projectsLastCapturedAt` (every source, one grouped read, live projects only).
  test('last-captured-at-per-project', async () => {
    const site = (await t.repo.createProject('Tea', 500))!;
    const other = (await t.repo.createProject('Other', 500))!;
    const empty = (await t.repo.createProject('Empty', 500))!;
    const gone = (await t.repo.createProject('Gone', 500))!;
    expect(await t.repo.projectsLastCapturedAt()).toEqual(new Map());
    await captureWithReading(1_000, '{"v":1}', { projectId: site.id, source: 'project' });
    // A manual capture counts as much as a run's.
    await captureWithReading(3_000, '{"v":2}', { projectId: site.id, source: 'manual' });
    appended(await t.repo.appendCapture(captureInput({ url: 'https://example.com/', snapshot: '{"p":1}', at: 2_000, projectId: site.id, source: 'project' })));
    appended(await t.repo.appendCapture(captureInput({ url: 'https://example.com/o', snapshot: '{"p":2}', at: 4_000, projectId: other.id, source: 'project' })));
    appended(await t.repo.appendCapture(captureInput({ url: 'https://example.com/g', snapshot: '{"p":3}', at: 5_000, projectId: gone.id, source: 'manual' })));
    expect(await t.repo.tombstoneProject(gone.id, 6_000)).toBe(true);
    const last = await t.repo.projectsLastCapturedAt();
    expect(last).toEqual(new Map([[site.id, 3_000], [other.id, 4_000]]));
    expect(last.has(empty.id)).toBe(false);
    expect(last.has(gone.id)).toBe(false);
  });
});

// ---- On both drivers ---------------------------------------------------------------------------

interface DriverCase {
  readonly kind: 'node-sqlite' | 'libsql';
  open(file: string): Promise<SqlDriver>;
}
const DRIVERS: readonly DriverCase[] = [
  { kind: 'node-sqlite', open: async (file) => createNodeSqliteDriver(new DatabaseSync(file)) },
  { kind: 'libsql', open: (file) => openLibsqlDriver({ url: libsqlFileUrl(file) }) },
];

describe.each(DRIVERS)('serp-reading-replace-over-capture-id-refused ($kind)', (driverCase) => {
  let dir: string;
  let driver: SqlDriver | null = null;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'frost-readings-'));
  });
  afterEach(async () => {
    await driver?.close();
    driver = null;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
    }
  });

  test('serp-reading-replace-over-capture-id-refused', async () => {
    driver = await driverCase.open(path.join(dir, 'readings.db'));
    await runMigrationsOver(driver);
    const repo = createChangeIntelRepository(createDrizzleOver(driver));
    const reading = readingOf(1_000);
    const { captureId } = appended(await repo.appendCapture(captureInput({ url: SERP, snapshot: '{"v":1}', at: 1_000, params: PARAMS, reading })));
    const rows = async () => (await driver!.execute('SELECT id, capture_id, status FROM ci_serp_readings ORDER BY id', [], 'all')).rows;
    expect(await rows()).toEqual([[reading.id, captureId, 'ready']]);
    // A fresh reading id over the taken capture id: REPLACE would delete the original through the
    // unique capture_id index with no DELETE trigger firing; the no-replace guard refuses first.
    const columns = 'id, project_id, capture_id, source, search_key, search_key_version, search_params, filters, page_url, status, pack_version, reading, reading_bytes, observed_at, created_at';
    const values = [uuidv7(2_000), UNFILED_PROJECT_ID, captureId, 'capture', KEY, 1, PARAMS, '{}', SERP, 'unreadable', null, '{"status":"unreadable"}', 23, 2_000, 2_000];
    for (const verb of ['INSERT OR REPLACE', 'REPLACE', 'INSERT']) {
      await expect(driver.execute(`${verb} INTO ci_serp_readings (${columns}) VALUES (${values.map(() => '?').join(', ')})`, values, 'run'), verb).rejects.toThrow(/never replaced/);
      expect(await rows(), verb).toEqual([[reading.id, captureId, 'ready']]);
    }
    // The repository refuses it too (nothing thrown, nothing written).
    expect(await repo.appendReading({ ...readingOf(2_000), projectId: UNFILED_PROJECT_ID, captureId, source: 'capture', pageUrl: SERP, observedAt: 2_000, createdAt: 2_000 })).toBe(false);
    expect(await rows()).toEqual([[reading.id, captureId, 'ready']]);
    expect((await repo.reading(reading.id))?.captureId).toBe(captureId);
  });
});
