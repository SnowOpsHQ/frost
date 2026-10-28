// Spec: specs/capture-db.spec.ts (PURGE_REASONS, RETENTION_MODES, CAPTURED_TABLES, MAX_HISTORY_PAGE)
// Acceptance: specs/capture-db.feature.md (Retention planning, Usage)
import { beforeEach, describe, expect, test } from 'vitest';
import { CAPTURED_TABLES } from '@app/specs/capture-db.spec';
import { uuidv7 } from '../ids';
import type { PurgePlan } from '../repository';
import { appended, capture, count, counts, DAY, ids, openTestDb, screenshotInput, sha256, utf8, type TestDb } from './fixtures';

const PAGE = 'https://example.com/a';
const OTHER = 'https://example.com/b';
const PHONE = '{"device":"phone"}';
const days = (n: number) => Math.round(n * DAY);
let t: TestDb;
let p: string;
let q: string;

beforeEach(async () => {
  t = openTestDb();
  p = (await t.repo.createProject('P', 1))!.id;
  q = (await t.repo.createProject('Q', 1))!.id;
});

const snap = (n: number | string) => `{"v":${JSON.stringify(n)}}`;
/** The capture ids pointing at `versionId`. */
const capturesOf = (versionId: string) => ids(t.raw, 'ci_captures', 'version_id = ?', versionId);
const diffIds = (where: string, ...params: string[]) => ids(t.raw, 'ci_diffs', where, ...params);

async function plan(projectId: string, policy: PurgePlan['policy'], now = days(10)): Promise<PurgePlan> {
  const planned = await t.repo.planPurge({ projectId, policy, now });
  if (planned === null) throw new Error('no plan');
  return planned;
}

describe('retention', () => {
  test('forever-plans-nothing', async () => {
    await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p });
    const forever = await plan(p, { mode: 'forever' });
    expect(forever).toMatchObject({ projectId: p, captureIds: [], versionIds: [], diffIds: [], screenshotIds: [], unreferencedHashes: [], bytes: 0, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0 } });
    expect(await t.repo.executePurge(forever, 'retention', 2_000)).toEqual({ status: 'empty' });
    expect(count(t.raw, 'ci_purges')).toBe(0);
    // Invalid policies and projects plan nothing.
    for (const policy of [{ mode: 'versions', value: 0 }, { mode: 'days', value: 3_651 }, { mode: 'versions', value: 1.5 }, { mode: 'sometimes' }]) {
      expect(await t.repo.planPurge({ projectId: p, policy: policy as never, now: 1 }), JSON.stringify(policy)).toBeNull();
    }
    expect(await t.repo.planPurge({ projectId: 'nope', policy: { mode: 'all' }, now: 1 })).toBeNull();
  });

  test('keep-n-versions-per-lane', async () => {
    const a1 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p })).versionId;
    appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_500, projectId: p }));
    const a2 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(2), at: 2_000, projectId: p })).versionId;
    const a3 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(3), at: 3_000, projectId: p })).versionId;
    const a4 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(4), at: 4_000, projectId: p })).versionId;
    appended(await capture(t.repo, { url: PAGE, snapshot: snap(4), at: 4_500, projectId: p }));
    // Another lane: two versions in P, then two in Q (not P's to rank).
    const [b1, b2, b3, b4] = [
      appended(await capture(t.repo, { url: PAGE, profile: PHONE, snapshot: snap(1), at: 1_100, projectId: p })).versionId,
      appended(await capture(t.repo, { url: PAGE, profile: PHONE, snapshot: snap(2), at: 2_100, projectId: p })).versionId,
      appended(await capture(t.repo, { url: PAGE, profile: PHONE, snapshot: snap(3), at: 3_100, projectId: q })).versionId,
      appended(await capture(t.repo, { url: PAGE, profile: PHONE, snapshot: snap(4), at: 4_100, projectId: q })).versionId,
    ];
    const keep2 = await plan(p, { mode: 'versions', value: 2 });
    expect(keep2.captureIds).toEqual([...capturesOf(a1), ...capturesOf(a2)].sort());
    expect(keep2.versionIds).toEqual([a1, a2].sort());
    expect(keep2.diffIds).toEqual(diffIds('to_version_id IN (?, ?)', a2, a3));
    expect(keep2.counts).toEqual({ captures: 3, versions: 2, diffs: 2, screenshots: 0 });
    expect((await t.repo.executePurge(keep2, 'retention', days(11)))?.status).toBe('purged');
    expect(ids(t.raw, 'ci_versions').sort()).toEqual([a3, a4, b1, b2, b3, b4].sort());
    expect(capturesOf(a4)).toHaveLength(2);

    // Ranked by P's own captures: with N = 1, P keeps b2 (its newest in that lane), though Q's b4 is newer.
    const keep1 = await plan(p, { mode: 'versions', value: 1 });
    expect(keep1.versionIds).toEqual([a3, b1].sort());
    expect(keep1.captureIds).toEqual([...capturesOf(a3), ...capturesOf(b1)].sort());
  });

  test('keep-n-days-keeps-latest', async () => {
    const a1 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: days(1), projectId: p })).versionId;
    const a2 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(2), at: days(2), projectId: p })).versionId;
    appended(await capture(t.repo, { url: PAGE, snapshot: snap(2), at: days(9.5), projectId: p }));
    const b1 = appended(await capture(t.repo, { url: OTHER, snapshot: snap(1), at: days(1), projectId: p })).versionId;
    const b2 = appended(await capture(t.repo, { url: OTHER, snapshot: snap(2), at: days(3), projectId: p })).versionId;
    const c1 = appended(await capture(t.repo, { url: PAGE, profile: PHONE, snapshot: snap(1), at: days(9.2), projectId: p })).versionId;
    // Q's old captures are not P's to purge.
    appended(await capture(t.repo, { url: 'https://example.org/', snapshot: snap(1), at: days(1), projectId: q }));

    const days1 = await plan(p, { mode: 'days', value: 1 }, days(10));
    expect(days1.captureIds).toEqual([...capturesOf(a1), ...capturesOf(b1)].sort());
    expect(days1.versionIds).toEqual([a1, b1].sort());
    expect(days1.diffIds).toEqual(diffIds('from_version_id IN (?, ?)', a1, b1));
    expect((await t.repo.executePurge(days1, 'retention', days(10)))?.status).toBe('purged');
    // b2's capture is three days old but is its lane's newest; a2 keeps its old capture too.
    expect(capturesOf(b2)).toHaveLength(1);
    expect(capturesOf(a2)).toHaveLength(2);
    expect(capturesOf(c1)).toHaveLength(1);
    expect(count(t.raw, 'ci_captures', 'project_id = ?', q)).toBe(1);
    // Far in the future only each lane's newest version's captures are left.
    const later = await plan(p, { mode: 'days', value: 1 }, days(100));
    expect(later.captureIds).toEqual([]);
  });

  test('screenshots-follow-the-retention-window', async () => {
    const shot = async (pageUrl: string, kind: 'viewport' | 'full', at: number, projectId = p) => {
      const input = screenshotInput({ pageUrl, kind, createdAt: at, projectId });
      expect(await t.repo.appendScreenshot(input)).toBe(true);
      return input.id;
    };
    const [vp1, vp2, vp3] = [await shot(PAGE, 'viewport', days(1)), await shot(PAGE, 'viewport', days(2)), await shot(PAGE, 'viewport', days(3))];
    const full1 = await shot(PAGE, 'full', days(1));
    const [o2, o95, o96] = [await shot(OTHER, 'viewport', days(2)), await shot(OTHER, 'viewport', days(9.5)), await shot(OTHER, 'viewport', days(9.6))];
    await shot(PAGE, 'viewport', days(1), q);
    expect((await plan(p, { mode: 'versions', value: 1 })).screenshotIds).toEqual([vp1, vp2, o2, o95].sort());
    expect((await plan(p, { mode: 'versions', value: 2 })).screenshotIds).toEqual([vp1, o2].sort());
    const days1 = await plan(p, { mode: 'days', value: 1 }, days(10));
    expect(days1.screenshotIds).toEqual([vp1, vp2, o2].sort());
    expect(days1.counts.screenshots).toBe(3);
    expect((await t.repo.executePurge(days1, 'retention', days(10)))?.status).toBe('purged');
    expect(ids(t.raw, 'ci_screenshots', 'project_id = ?', p)).toEqual([vp3, full1, o95, o96].sort());
    expect(count(t.raw, 'ci_screenshots', 'project_id = ?', q)).toBe(1);
  });

  test('orphaned-versions-are-purged-with-their-diffs', async () => {
    const [a1, a2, a3] = [
      appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p })).versionId,
      appended(await capture(t.repo, { url: PAGE, snapshot: snap(2), at: 2_000, projectId: p })).versionId,
      appended(await capture(t.repo, { url: PAGE, snapshot: snap(3), at: 3_000, projectId: p })).versionId,
    ];
    const keep2 = await plan(p, { mode: 'versions', value: 2 });
    expect(keep2.versionIds).toEqual([a1]);
    expect(keep2.diffIds).toEqual(diffIds('from_version_id = ?', a1));
    await t.repo.executePurge(keep2, 'purge-now', 4_000);
    // The kept pair's diff stays.
    expect(await t.repo.diffFor(a2, a3)).not.toBeNull();
    expect(await t.repo.version(a1)).toBeNull();
    // a2's parent is gone: it says so, and its history entry has no diff.
    expect((await t.repo.version(a2))?.parentVersionId).toBe(a1);
    const keep1 = await plan(p, { mode: 'versions', value: 1 });
    expect(keep1.diffIds).toEqual(diffIds('to_version_id = ?', a3));
    await t.repo.executePurge(keep1, 'purge-now', 5_000);
    expect(count(t.raw, 'ci_diffs')).toBe(0);
    const history = await t.repo.history({ pageUrl: PAGE, limit: 10 });
    expect(history.entries.map((e) => [e.id, e.parentVersionId, e.diff])).toEqual([[a3, a2, null]]);
  });

  test('shared-versions-survive-another-projects-purge', async () => {
    const v1 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p })).versionId;
    const reused = appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 2_000, projectId: q }));
    expect(reused.versionId).toBe(v1);
    expect((await t.repo.usage(p))?.sharedVersions).toBe(1);
    const all = await plan(p, { mode: 'all' });
    expect(all.captureIds).toHaveLength(1);
    expect(all.versionIds).toEqual([]);
    await t.repo.executePurge(all, 'project-deleted', 3_000);
    expect(await t.repo.version(v1)).not.toBeNull();
    expect(capturesOf(v1)).toEqual([reused.captureId]);
    expect((await t.repo.usage(q))?.sharedVersions).toBe(0);
  });

  test('purge-matches-its-plan', async () => {
    const a1 = appended(await capture(t.repo, { url: PAGE, snapshot: snap('thé'), at: 1_000, projectId: p })).versionId;
    appended(await capture(t.repo, { url: PAGE, snapshot: snap(2), at: 2_000, projectId: p }));
    const stale = await plan(p, { mode: 'versions', value: 1 });
    // A capture after planning changes what the policy would purge: the old plan is refused.
    appended(await capture(t.repo, { url: PAGE, snapshot: snap(3), at: 3_000, projectId: p }));
    const before = counts(t.raw);
    expect(await t.repo.executePurge(stale, 'purge-now', 4_000)).toEqual({ status: 'stale' });
    expect(counts(t.raw)).toEqual(before);
    // Screenshots too.
    for (const at of [1_000, 2_000]) await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: at, projectId: p, bytes: 700 }));

    const fresh = await plan(p, { mode: 'versions', value: 1 }, 5_000);
    const snapshotBytes = utf8(snap('thé')) + utf8(snap(2));
    const diffBytes = Number(t.raw.prepare(`SELECT sum(length(CAST(diff AS BLOB))) AS n FROM ci_diffs WHERE id IN (${fresh.diffIds.map(() => '?').join(', ')})`).get(...fresh.diffIds)!['n']);
    expect(fresh.counts).toEqual({ captures: 2, versions: 2, diffs: 2, screenshots: 1 });
    expect(fresh.bytes).toBe(snapshotBytes + diffBytes + 700);
    expect(fresh.unreferencedHashes).toHaveLength(1);
    expect(fresh.now).toBe(5_000);

    const result = await t.repo.executePurge(fresh, 'purge-now', 6_000);
    if (result?.status !== 'purged') throw new Error(JSON.stringify(result));
    expect(result.plan).toEqual(fresh);
    // Exactly the plan's rows are gone.
    expect(ids(t.raw, 'ci_captures', 'id IN (' + fresh.captureIds.map(() => '?').join(', ') + ')', ...fresh.captureIds)).toEqual([]);
    expect(await t.repo.version(a1)).toBeNull();
    expect(counts(t.raw)).toMatchObject({ ci_captures: before.ci_captures! - 2, ci_versions: before.ci_versions! - 2, ci_diffs: before.ci_diffs! - 2, ci_screenshots: 1, ci_purges: 1, ci_tombstones: 7 });
    // The record matches the plan, one tombstone per deleted row.
    expect({ ...t.raw.prepare('SELECT * FROM ci_purges').get() }).toEqual({
      id: result.purgeId,
      reason: 'purge-now',
      project_id: p,
      policy: '{"mode":"versions","value":1}',
      captures: 2,
      versions: 2,
      diffs: 2,
      screenshots: 1,
      bytes: fresh.bytes,
      created_at: 6_000,
    });
    const tombstones = t.raw.prepare('SELECT table_name, row_id, purge_id FROM ci_tombstones ORDER BY table_name, row_id').all();
    const expected = [
      ...fresh.captureIds.map((id) => ['ci_captures', id]),
      ...fresh.diffIds.map((id) => ['ci_diffs', id]),
      ...fresh.screenshotIds.map((id) => ['ci_screenshots', id]),
      ...fresh.versionIds.map((id) => ['ci_versions', id]),
    ];
    expect(tombstones.map((row) => [row['table_name'], row['row_id']])).toEqual(expected);
    expect(new Set(tombstones.map((row) => row['purge_id']))).toEqual(new Set([result.purgeId]));
    expect(CAPTURED_TABLES.every((table) => expected.some(([name]) => name === table))).toBe(true);

    // The purge log.
    const log = await t.repo.purges({ projectId: p, limit: 20 });
    expect(log).toEqual([{ id: result.purgeId, reason: 'purge-now', projectId: p, policyJson: '{"mode":"versions","value":1}', counts: fresh.counts, bytes: fresh.bytes, createdAt: 6_000 }]);
    expect(await t.repo.purges({ projectId: q, limit: 20 })).toEqual([]);
    expect(await t.repo.purges({ limit: 20 })).toHaveLength(1);
    // A bad reason or a forged plan is refused.
    expect(await t.repo.executePurge(fresh, 'because' as never, 7_000)).toBeNull();
    expect(await t.repo.executePurge({ ...fresh, projectId: 'nope' }, 'purge-now', 7_000)).toBeNull();
  });

  test('purge-raced-by-a-capture-is-stale', async () => {
    const v1 = appended(await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p })).versionId;
    const all = await plan(p, { mode: 'all' });
    expect(all.versionIds).toEqual([v1]);
    // A capture reusing v1 commits after executePurge's re-plan, just before its transaction begins.
    const begin = t.raw.exec.bind(t.raw);
    let armed = true;
    t.raw.exec = (statement: string) => {
      if (armed && statement === 'BEGIN IMMEDIATE') {
        armed = false;
        t.raw
          .prepare("INSERT INTO ci_captures (id, project_id, version_id, lane_key, page_url, render_profile, render_profile_partial, search_params, source, audit_taken_at, created_at) SELECT ?, ?, id, lane_key, page_url, NULL, 0, NULL, 'manual', 2000, 2000 FROM ci_versions WHERE id = ?")
          .run(uuidv7(), q, v1);
      }
      begin(statement);
    };
    const before = counts(t.raw);
    expect(await t.repo.executePurge(all, 'project-deleted', 3_000)).toEqual({ status: 'stale' });
    expect(counts(t.raw)).toEqual({ ...before, ci_captures: before.ci_captures! + 1 });
    // Planned again, v1 is kept for the other project's capture.
    const again = await plan(p, { mode: 'all' });
    expect(again.versionIds).toEqual([]);
    expect((await t.repo.executePurge(again, 'project-deleted', 3_000))?.status).toBe('purged');
    expect(await t.repo.version(v1)).not.toBeNull();
  });

  test('execute-purge-is-one-transaction', async () => {
    await capture(t.repo, { url: PAGE, snapshot: snap(1), at: 1_000, projectId: p });
    await capture(t.repo, { url: PAGE, snapshot: snap(2), at: 2_000, projectId: p });
    await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 1_000, projectId: p }));
    const all = await plan(p, { mode: 'all' });
    expect(all.counts).toEqual({ captures: 2, versions: 2, diffs: 1, screenshots: 1 });
    const before = counts(t.raw);
    // The last delete (versions) fails.
    t.raw.exec("CREATE TEMP TRIGGER fail_version_delete BEFORE DELETE ON ci_versions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await expect(t.repo.executePurge(all, 'project-deleted', 3_000)).rejects.toThrow(/injected failure/);
    expect(counts(t.raw)).toEqual(before);
    expect(count(t.raw, 'ci_purges')).toBe(0);
    expect(count(t.raw, 'ci_tombstones')).toBe(0);
    t.raw.exec('DROP TRIGGER fail_version_delete');
    expect((await t.repo.executePurge(all, 'project-deleted', 3_000))?.status).toBe('purged');
    expect(counts(t.raw)).toMatchObject({ ci_captures: 0, ci_versions: 0, ci_diffs: 0, ci_screenshots: 0, ci_purges: 1, ci_tombstones: 6 });
  });

  test('unreferenced-hashes-only', async () => {
    const [h1, h2, h3, h4, h5] = ['1', '2', '3', '4', '5'].map((n) => sha256(`png ${n}`)) as [string, string, string, string, string];
    const shot = async (pageUrl: string, kind: 'viewport' | 'full', at: number, hash: string, bytes: number, projectId = p) => {
      const input = screenshotInput({ pageUrl, kind, createdAt: at, sha256: hash, bytes, projectId });
      expect(await t.repo.appendScreenshot(input)).toBe(true);
      return input.id;
    };
    const s1 = await shot(PAGE, 'viewport', 1, h1, 100);
    await shot(PAGE, 'viewport', 2, h1, 100);
    const s3 = await shot(OTHER, 'viewport', 1, h2, 200);
    const s4 = await shot(OTHER, 'viewport', 2, h2, 200);
    await shot(OTHER, 'viewport', 3, h3, 300);
    const s6 = await shot(PAGE, 'full', 1, h4, 400);
    await shot(PAGE, 'full', 2, h5, 500);
    await shot(PAGE, 'full', 1, h4, 400, q);
    const keep1 = await plan(p, { mode: 'versions', value: 1 });
    expect(keep1.screenshotIds).toEqual([s1, s3, s4, s6].sort());
    // h1 is still another kept row's, h4 another project's: only h2's file is freed, counted once.
    expect(keep1.unreferencedHashes).toEqual([h2]);
    expect(keep1.bytes).toBe(200);
    await t.repo.executePurge(keep1, 'retention', 10);
    expect(await t.repo.isHashReferenced(h2)).toBe(false);
    expect(await t.repo.isHashReferenced(h1)).toBe(true);
    expect(await t.repo.isHashReferenced(h4)).toBe(true);
  });

  test('usage-counts-stored-bytes', async () => {
    const s1 = '{"t":"thé — 茶"}';
    const s2 = '{"t":"tea"}';
    const s3 = '{"o":1}';
    const v1 = appended(await capture(t.repo, { url: PAGE, snapshot: s1, at: 1_000, projectId: p })).versionId;
    const v2 = appended(await capture(t.repo, { url: PAGE, snapshot: s2, at: 2_000, projectId: p })).versionId;
    appended(await capture(t.repo, { url: PAGE, snapshot: s2, at: 3_000, projectId: q }));
    appended(await capture(t.repo, { url: OTHER, snapshot: s3, at: 4_000, projectId: q }));
    const diff = (await t.repo.diffFor(v1, v2))!.diffJson;
    for (const [hash, bytes, projectId] of [['a', 100, p], ['a', 100, p], ['b', 50, p], ['c', 70, q]] as const) {
      await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 5_000, sha256: sha256(hash), bytes, projectId }));
    }
    expect(await t.repo.usage(p)).toEqual({ captures: 2, versions: 2, sharedVersions: 1, snapshotBytes: utf8(s1) + utf8(s2), diffBytes: utf8(diff), screenshots: 3, screenshotBytes: 150 });
    expect(await t.repo.usage(q)).toEqual({ captures: 2, versions: 2, sharedVersions: 1, snapshotBytes: utf8(s2) + utf8(s3), diffBytes: utf8(diff), screenshots: 1, screenshotBytes: 70 });
    expect(await t.repo.usage()).toEqual({ captures: 4, versions: 3, sharedVersions: 1, snapshotBytes: utf8(s1) + utf8(s2) + utf8(s3), diffBytes: utf8(diff), screenshots: 4, screenshotBytes: 220 });
    expect(await t.repo.usage('nope')).toBeNull();
  });
});
