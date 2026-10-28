// Spec: specs/capture-db.spec.ts (CAPTURED_TABLES, AUDIT_TABLES, UNFILED_PROJECT_ID)
// Acceptance: specs/capture-db.feature.md (Immutability)
import { beforeEach, describe, expect, test } from 'vitest';
import { AUDIT_TABLES, CAPTURED_TABLES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { uuidv7 } from '../ids';
import { appended, capture, count, counts, openTestDb, screenshotInput, type TestDb } from './fixtures';

const PAGE = 'https://example.com/a';
let t: TestDb;
/** One row id per captured table. */
let rows: Record<(typeof CAPTURED_TABLES)[number], string>;

beforeEach(async () => {
  t = openTestDb();
  const first = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
  const second = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":2}', at: 2_000 }));
  const shot = screenshotInput({ pageUrl: PAGE, createdAt: 3_000, captureId: second.captureId });
  expect(await t.repo.appendScreenshot(shot)).toBe(true);
  const diff = t.raw.prepare('SELECT id FROM ci_diffs').get()!;
  rows = { ci_versions: first.versionId, ci_captures: first.captureId, ci_diffs: String(diff['id']), ci_screenshots: shot.id };
});

const recordPurge = (id = uuidv7(), at = 5_000) =>
  t.raw.prepare("INSERT INTO ci_purges (id, reason, project_id, policy, captures, versions, diffs, screenshots, bytes, created_at) VALUES (?, 'purge-now', NULL, NULL, 0, 0, 0, 0, 0, ?)").run(id, at);
const recordTombstone = (purgeId: string, table: string, rowId: string, id = uuidv7()) =>
  t.raw.prepare('INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, ?, ?, ?, 5000)').run(id, purgeId, table, rowId);

describe('change-intelligence guards', () => {
  test('captured-rows-are-immutable', () => {
    const before = counts(t.raw);
    for (const table of CAPTURED_TABLES) {
      expect(() => t.raw.prepare(`UPDATE ${table} SET created_at = 1 WHERE id = ?`).run(rows[table]), table).toThrow(/append-only/);
      expect(() => t.raw.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(uuidv7(), rows[table]), table).toThrow(/append-only/);
      // (A version with captures is also held by `ci_versions_unreferenced_only`; either guard may fire first.)
      expect(() => t.raw.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rows[table]), table).toThrow(/recorded purge|still has captures/);
      expect(() => t.raw.exec(`DELETE FROM ${table}`), table).toThrow(/recorded purge|still has captures/);
    }
    const purgeId = uuidv7();
    recordPurge(purgeId);
    recordTombstone(purgeId, 'ci_screenshots', rows.ci_screenshots);
    for (const table of AUDIT_TABLES) {
      expect(() => t.raw.exec(`UPDATE ${table} SET created_at = 1`), table).toThrow(/append-only/);
      expect(() => t.raw.exec(`DELETE FROM ${table}`), table).toThrow(/append-only/);
    }
    expect(counts(t.raw)).toEqual({ ...before, ci_purges: 1, ci_tombstones: 1 });
  });

  test('purge-needs-a-tombstone', () => {
    const purgeId = uuidv7();
    // A tombstone naming a purge that was never recorded unlocks nothing.
    recordTombstone(purgeId, 'ci_screenshots', rows.ci_screenshots);
    expect(() => t.raw.prepare('DELETE FROM ci_screenshots WHERE id = ?').run(rows.ci_screenshots)).toThrow(/recorded purge/);
    // A tombstone for another table unlocks nothing either.
    recordPurge(purgeId);
    recordTombstone(purgeId, 'ci_captures', rows.ci_screenshots);
    expect(() => t.raw.prepare('DELETE FROM ci_captures WHERE id = ?').run(rows.ci_captures)).toThrow(/recorded purge/);
    // With the purge recorded, the tombstoned row goes, and only it.
    t.raw.prepare('DELETE FROM ci_screenshots WHERE id = ?').run(rows.ci_screenshots);
    expect(count(t.raw, 'ci_screenshots')).toBe(0);
    expect(count(t.raw, 'ci_captures')).toBe(2);
  });

  test('versions-with-captures-stay', () => {
    // Even with a recorded purge's tombstone, a version some capture still points at is not deleted.
    const purgeId = uuidv7();
    recordPurge(purgeId);
    recordTombstone(purgeId, 'ci_versions', rows.ci_versions);
    expect(() => t.raw.prepare('DELETE FROM ci_versions WHERE id = ?').run(rows.ci_versions)).toThrow(/still has captures/);
    recordTombstone(purgeId, 'ci_captures', rows.ci_captures);
    t.raw.exec('BEGIN');
    t.raw.prepare('DELETE FROM ci_captures WHERE id = ?').run(rows.ci_captures);
    t.raw.prepare('DELETE FROM ci_versions WHERE id = ?').run(rows.ci_versions);
    t.raw.exec('COMMIT');
    expect(count(t.raw, 'ci_versions', 'id = ?', rows.ci_versions)).toBe(0);
  });

  test('tombstoned-ids-never-return', async () => {
    const purgeId = uuidv7();
    recordPurge(purgeId);
    recordTombstone(purgeId, 'ci_screenshots', rows.ci_screenshots);
    const row = { ...t.raw.prepare('SELECT * FROM ci_screenshots WHERE id = ?').get(rows.ci_screenshots)! };
    t.raw.prepare('DELETE FROM ci_screenshots WHERE id = ?').run(rows.ci_screenshots);
    const columns = Object.keys(row);
    const insert = t.raw.prepare(`INSERT INTO ci_screenshots (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    expect(() => insert.run(...(Object.values(row) as (string | number | null)[]))).toThrow(/was purged/);
    // The repository refuses the id too.
    expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 6_000, id: rows.ci_screenshots }))).toBe(false);
    expect(count(t.raw, 'ci_screenshots')).toBe(0);
    // Every captured table refuses a tombstoned id.
    for (const table of CAPTURED_TABLES) {
      const id = uuidv7();
      recordTombstone(purgeId, table, id);
      expect(() => t.raw.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(id), table).toThrow(/was purged/);
    }
  });

  test('purges-and-tombstones-are-immutable', async () => {
    const plan = await t.repo.planPurge({ projectId: UNFILED_PROJECT_ID, policy: { mode: 'all' }, now: 10_000 });
    const result = await t.repo.executePurge(plan!, 'project-deleted', 10_000);
    expect(result?.status).toBe('purged');
    expect(count(t.raw, 'ci_purges')).toBe(1);
    const tombstones = count(t.raw, 'ci_tombstones');
    expect(tombstones).toBeGreaterThan(0);
    for (const table of AUDIT_TABLES) {
      expect(() => t.raw.exec(`UPDATE ${table} SET created_at = 0`), table).toThrow(/append-only/);
      expect(() => t.raw.exec(`DELETE FROM ${table}`), table).toThrow(/append-only/);
      expect(() => t.raw.exec(`UPDATE ${table} SET id = '0190a000-0000-7000-8000-000000000009'`), table).toThrow(/append-only/);
    }
    // Not inside a transaction either.
    t.raw.exec('BEGIN');
    expect(() => t.raw.exec('DELETE FROM ci_tombstones')).toThrow(/append-only/);
    t.raw.exec('ROLLBACK');
    expect(count(t.raw, 'ci_purges')).toBe(1);
    expect(count(t.raw, 'ci_tombstones')).toBe(tombstones);
  });

  test('unfiled-project-cannot-be-deleted', async () => {
    expect(await t.repo.tombstoneProject(UNFILED_PROJECT_ID, 9_000)).toBe(false);
    expect(() => t.raw.prepare('UPDATE ci_projects SET deleted_at = 1 WHERE id = ?').run(UNFILED_PROJECT_ID)).toThrow(/Unfiled/);
    expect(() => t.raw.prepare("UPDATE ci_projects SET id = '0190a000-0000-7000-8000-000000000001' WHERE id = ?").run(UNFILED_PROJECT_ID)).toThrow(/Unfiled/);
    // Its other fields may change (a render profile, a retention policy).
    t.raw.prepare("UPDATE ci_projects SET retention_mode = 'days', retention_value = 3, updated_at = 2 WHERE id = ?").run(UNFILED_PROJECT_ID);
    expect((await t.repo.project(UNFILED_PROJECT_ID))?.retention).toEqual({ mode: 'days', value: 3 });

    // No mutable row is ever deleted: they are tombstoned.
    const project = await t.repo.createProject('Site', 9_000);
    expect(await t.repo.addPage(project!.id, PAGE, 9_000)).not.toBeNull();
    expect(await t.repo.addQuery(project!.id, 'green tea', '{"engine":"x"}', 9_000)).not.toBeNull();
    for (const table of ['ci_projects', 'ci_project_pages', 'ci_project_queries']) {
      expect(() => t.raw.exec(`DELETE FROM ${table}`), table).toThrow(/tombstone/);
    }
    expect(count(t.raw, 'ci_projects')).toBe(2);
    expect(count(t.raw, 'ci_project_pages')).toBe(1);
    expect(count(t.raw, 'ci_project_queries')).toBe(1);
  });
});
