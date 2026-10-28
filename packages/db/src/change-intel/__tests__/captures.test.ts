// Spec: specs/capture-db.spec.ts (UUIDV7_PATTERN, SHA256_HEX_PATTERN, CAPTURE_SOURCES, SCREENSHOT_KINDS, MAX_SNAPSHOT_JSON_BYTES,
// MAX_DIFF_JSON_BYTES, MAX_PROFILE_JSON_BYTES, MAX_SEARCH_PARAMS_JSON_BYTES, MAX_RECT_JSON_BYTES, MAX_HISTORY_PAGE, UNFILED_PROJECT_ID)
// Acceptance: specs/capture-db.feature.md (Captures)
import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_HISTORY_PAGE, MAX_PROFILE_JSON_BYTES, MAX_SNAPSHOT_JSON_BYTES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { createUuidv7, uuidv7 } from '../ids';
import type { AppendCaptureInput } from '../repository';
import { appended, capture, captureInput, count, counts, laneOf, openTestDb, screenshotInput, sha256, utf8, type TestDb } from './fixtures';

const PAGE = 'https://example.com/guides/tea';
const OTHER = 'https://example.com/other';
const PHONE = '{"device":"phone"}';
let t: TestDb;

beforeEach(() => {
  t = openTestDb();
});

describe('captures', () => {
  test('same-hash-reuses-the-lane-version', async () => {
    const one = appended(await capture(t.repo, { url: PAGE, snapshot: '{"a":1}', at: 1_000 }));
    const two = appended(await capture(t.repo, { url: PAGE, snapshot: '{"a":1}', at: 2_000 }));
    expect(one.newVersion).toBe(true);
    expect(two).toEqual({ status: 'appended', captureId: two.captureId, versionId: one.versionId, newVersion: false });
    expect(count(t.raw, 'ci_versions')).toBe(1);
    expect(count(t.raw, 'ci_captures', 'version_id = ?', one.versionId)).toBe(2);
    expect(count(t.raw, 'ci_diffs')).toBe(0);

    // Another lane (same URL, a phone profile) has a version of its own.
    const phone = appended(await capture(t.repo, { url: PAGE, snapshot: '{"a":1}', at: 3_000, profile: PHONE }));
    expect(phone.newVersion).toBe(true);
    expect(phone.versionId).not.toBe(one.versionId);
    expect((await t.repo.latestVersion(laneOf(PAGE, PHONE)))?.id).toBe(phone.versionId);
    expect((await t.repo.latestVersion(laneOf(PAGE)))?.id).toBe(one.versionId);

    // A → B → A: three versions, the last one's parent B.
    const b = appended(await capture(t.repo, { url: PAGE, snapshot: '{"a":2}', at: 4_000 }));
    const a = appended(await capture(t.repo, { url: PAGE, snapshot: '{"a":1}', at: 5_000 }));
    expect([b.newVersion, a.newVersion]).toEqual([true, true]);
    expect((await t.repo.version(a.versionId))?.parentVersionId).toBe(b.versionId);
    expect(count(t.raw, 'ci_versions', 'lane_key = ?', laneOf(PAGE))).toBe(3);
  });

  test('new-version-stores-its-diff', async () => {
    const first = appended(await capture(t.repo, { url: PAGE, snapshot: '{"title":"Tea"}', at: 1_000 }));
    const latest = await t.repo.latestVersion(laneOf(PAGE));
    expect(latest).toEqual({
      id: first.versionId,
      laneKey: laneOf(PAGE),
      pageUrl: PAGE,
      renderProfileJson: null,
      searchParamsJson: null,
      snapshotHash: sha256('{"title":"Tea"}'),
      snapshotBytes: utf8('{"title":"Tea"}'),
      schemaVersion: 1,
      parentVersionId: null,
      createdAt: 1_000,
    });
    const snapshot = '{"title":"Thé — green"}';
    const diff = { id: uuidv7(), fromVersionId: first.versionId, engineVersion: 3, diffJson: '{"changes":[1]}', summaryJson: '{"head":1}', changeCount: 1 };
    const second = appended(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot, at: 2_000, diff })));
    expect(second.newVersion).toBe(true);
    const version = await t.repo.version(second.versionId);
    expect(version).toMatchObject({ id: second.versionId, parentVersionId: first.versionId, snapshotJson: snapshot, snapshotBytes: utf8(snapshot), snapshotHash: sha256(snapshot), createdAt: 2_000 });
    expect(await t.repo.diffFor(first.versionId, second.versionId)).toEqual({
      id: diff.id,
      laneKey: laneOf(PAGE),
      fromVersionId: first.versionId,
      toVersionId: second.versionId,
      engineVersion: 3,
      diffJson: diff.diffJson,
      summaryJson: diff.summaryJson,
      changeCount: 1,
      createdAt: 2_000,
    });
    expect(await t.repo.diffFor(second.versionId, first.versionId)).toBeNull();
    // A capture row records what it was given.
    const row = { ...t.raw.prepare('SELECT * FROM ci_captures WHERE id = ?').get(second.captureId) };
    expect(row).toMatchObject({ project_id: UNFILED_PROJECT_ID, version_id: second.versionId, lane_key: laneOf(PAGE), page_url: PAGE, render_profile_partial: 0, source: 'manual', audit_taken_at: 2_000, created_at: 2_000 });
  });

  test('new-version-sorts-after-its-parent', async () => {
    const parent = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 2_000 }));
    const diffFrom = (from: string) => ({ id: uuidv7(), fromVersionId: from, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 0 });
    // The same time and an id that sorts lower (made by another device's earlier clock): parent's time + 1.
    const lowId = createUuidv7()(1);
    expect(lowId < parent.versionId).toBe(true);
    const same = appended(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":2}', at: 2_000, versionId: lowId, diff: diffFrom(parent.versionId) })));
    expect((await t.repo.version(same.versionId))?.createdAt).toBe(2_001);
    expect((await t.repo.latestVersion(laneOf(PAGE)))?.id).toBe(lowId);
    expect((await t.repo.diffFor(parent.versionId, lowId))?.createdAt).toBe(2_001);
    // A clock gone back: the same.
    const back = appended(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":3}', at: 1_500, diff: diffFrom(lowId) })));
    expect((await t.repo.version(back.versionId))?.createdAt).toBe(2_002);
    // The capture keeps the time it was given.
    expect(Number(t.raw.prepare('SELECT created_at FROM ci_captures WHERE id = ?').get(back.captureId)!['created_at'])).toBe(1_500);
    // An equal time with a higher id stays as given.
    const later = appended(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":4}', at: 2_002, diff: diffFrom(back.versionId) })));
    expect((await t.repo.version(later.versionId))?.createdAt).toBe(2_002);
    expect((await t.repo.latestVersion(laneOf(PAGE)))?.id).toBe(later.versionId);
  });

  test('tampered-lane-head-does-not-block', async () => {
    const real = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    const insertVersion = t.raw.prepare(
      'INSERT INTO ci_versions (id, lane_key, page_url, render_profile, search_params, snapshot, snapshot_hash, snapshot_bytes, schema_version, parent_version_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, 1, 1, NULL, ?)',
    );
    // Later rows with a malformed id, hash or time are never the lane's head.
    insertVersion.run('X'.repeat(36), laneOf(PAGE), PAGE, '{}', sha256('a'), 5_000);
    insertVersion.run(uuidv7(), laneOf(PAGE), PAGE, '{}', 'not-a-hash', 5_000);
    insertVersion.run(uuidv7(), laneOf(PAGE), PAGE, '{}', sha256('c'), 'soon');
    expect((await t.repo.latestVersion(laneOf(PAGE)))?.id).toBe(real.versionId);
    const next = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":2}', at: 2_000 }));
    expect((await t.repo.version(next.versionId))?.parentVersionId).toBe(real.versionId);

    // A well-formed head with a tampered URL reads as no version: main hands no diff, and the new
    // version still goes in after it (with no stored diff), so the lane moves on.
    const bad = uuidv7();
    insertVersion.run(bad, laneOf(PAGE), 'javascript:alert(1)', '{}', sha256('d'), 6_000);
    expect(await t.repo.latestVersion(laneOf(PAGE))).toBeNull();
    const after = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":3}', at: 7_000 }));
    expect((await t.repo.version(after.versionId))?.parentVersionId).toBe(bad);
    expect(await t.repo.diffFor(bad, after.versionId)).toBeNull();
    expect((await t.repo.latestVersion(laneOf(PAGE)))?.id).toBe(after.versionId);
    // A diff from the unreadable head is refused: main could not have read it.
    const diff = { id: uuidv7(), fromVersionId: bad, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 0 };
    expect(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":4}', at: 8_000, diff }))).toEqual({ status: 'stale' });
  });

  test('omitted-limit-is-a-full-page', async () => {
    for (let i = 0; i < 3; i++) {
      await capture(t.repo, { url: PAGE, snapshot: `{"v":${i}}`, at: 1_000 + i });
      await capture(t.repo, { url: `https://example.com/p${i}`, snapshot: '{}', at: 1_000 + i });
      expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 1_000 + i }))).toBe(true);
    }
    expect((await t.repo.history({ pageUrl: PAGE })).entries).toHaveLength(3);
    expect(await t.repo.pages({})).toHaveLength(4);
    expect((await t.repo.screenshots({ pageUrl: PAGE })).screenshots).toHaveLength(3);
    const project = (await t.repo.createProject('P', 1))!;
    for (const at of [2_000, 3_000]) {
      await capture(t.repo, { url: PAGE, snapshot: `{"p":${at}}`, at, projectId: project.id });
      await capture(t.repo, { url: PAGE, snapshot: `{"q":${at}}`, at: at + 1, projectId: project.id });
      const plan = await t.repo.planPurge({ projectId: project.id, policy: { mode: 'versions', value: 1 }, now: at + 2 });
      expect((await t.repo.executePurge(plan!, 'purge-now', at + 2))?.status).toBe('purged');
    }
    expect(await t.repo.purges({})).toHaveLength(2);
    // An explicit limit still caps it.
    expect((await t.repo.history({ pageUrl: PAGE, limit: 1 })).entries).toHaveLength(1);
  });

  test('stale-diff-parent-is-refused', async () => {
    // A diff when the lane has no version yet.
    const orphanDiff = { id: uuidv7(), fromVersionId: uuidv7(), engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 0 };
    expect(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":1}', at: 1_000, diff: orphanDiff }))).toEqual({ status: 'stale' });
    expect(count(t.raw, 'ci_captures')).toBe(0);

    const first = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    const second = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":2}', at: 2_000 }));
    const before = counts(t.raw);
    // A diff from a version that is no longer the latest.
    const staleDiff = { id: uuidv7(), fromVersionId: first.versionId, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 0 };
    expect(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":3}', at: 3_000, diff: staleDiff }))).toEqual({ status: 'stale' });
    // No diff although the lane has a latest version.
    expect(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":3}', at: 3_000 }))).toEqual({ status: 'stale' });
    expect(counts(t.raw)).toEqual(before);
    // From the latest it goes in.
    const fresh = { ...staleDiff, id: uuidv7(), fromVersionId: second.versionId };
    const third = appended(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":3}', at: 3_000, diff: fresh })));

    // Two captures racing into the lane, both diffed against the same latest version (they await in
    // lockstep, so both read it before either writes): one wins, the other is refused inside its
    // transaction and writes nothing.
    const race = (snapshot: string) => t.repo.appendCapture(captureInput({ url: PAGE, snapshot, at: 4_000, diff: { ...fresh, id: uuidv7(), fromVersionId: third.versionId } }));
    const results = await Promise.all([race('{"v":4}'), race('{"v":5}')]);
    expect(results.map((r) => r?.status).sort()).toEqual(['appended', 'stale']);
    expect(count(t.raw, 'ci_versions', 'parent_version_id = ?', third.versionId)).toBe(1);
    expect(count(t.raw, 'ci_diffs', 'from_version_id = ?', third.versionId)).toBe(1);
  });

  test('history-pages-newest-first', async () => {
    const project = (await t.repo.createProject('Site', 1))!;
    const v1 = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_500 }));
    const v2 = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":2}', at: 2_000, projectId: project.id }));
    const phone = appended(await capture(t.repo, { url: `${PAGE}#section`, snapshot: '{"v":1}', at: 3_000, profile: PHONE }));
    const v3 = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":3}', at: 4_000 }));
    appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":3}', at: 4_500, projectId: project.id }));
    appended(await capture(t.repo, { url: OTHER, snapshot: '{"v":1}', at: 5_000 }));

    const page = await t.repo.history({ pageUrl: `${PAGE}#anything`, limit: 2 });
    expect(page.entries.map((e) => e.id)).toEqual([v3.versionId, phone.versionId]);
    expect(page.entries[0]).toMatchObject({ laneKey: laneOf(PAGE), parentVersionId: v2.versionId, captureCount: 2, lastCapturedAt: 4_500, snapshotHash: sha256('{"v":3}') });
    expect(page.entries[0]!.diff).toMatchObject({ fromVersionId: v2.versionId, summaryJson: '{"main":1}', changeCount: 1, engineVersion: 1 });
    expect(page.entries[1]).toMatchObject({ renderProfileJson: PHONE, parentVersionId: null, diff: null, captureCount: 1 });
    expect(page.next).not.toBeNull();
    const rest = await t.repo.history({ pageUrl: PAGE, cursor: page.next!, limit: 2 });
    expect(rest.entries.map((e) => e.id)).toEqual([v2.versionId, v1.versionId]);
    expect(rest.entries[1]).toMatchObject({ captureCount: 2, lastCapturedAt: 1_500, diff: null });
    expect(rest.next).toBeNull();

    // Restricted to a project: only its versions, counted in it.
    const inProject = await t.repo.history({ pageUrl: PAGE, projectId: project.id, limit: MAX_HISTORY_PAGE });
    expect(inProject.entries.map((e) => [e.id, e.captureCount, e.lastCapturedAt])).toEqual([
      [v3.versionId, 1, 4_500],
      [v2.versionId, 1, 2_000],
    ]);
    // The page size is capped; an invalid URL or project answers nothing.
    expect((await t.repo.history({ pageUrl: PAGE, limit: 10_000 })).entries).toHaveLength(4);
    expect(await t.repo.history({ pageUrl: 'javascript:alert(1)', limit: 10 })).toEqual({ entries: [], next: null });
    expect(await t.repo.history({ pageUrl: PAGE, projectId: 'nope', limit: 10 })).toEqual({ entries: [], next: null });
  });

  test('screenshots-round-trip', async () => {
    const shot = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    const first = screenshotInput({ pageUrl: PAGE, createdAt: 1_000, captureId: shot.captureId, renderProfileJson: PHONE });
    const area = screenshotInput({ pageUrl: `${PAGE}#x`, createdAt: 2_000, kind: 'area', rectJson: '{"h":10,"w":20,"x":1,"y":2}' });
    const full = screenshotInput({ pageUrl: OTHER, createdAt: 3_000, kind: 'full', segments: 4, height: 9_000, sha256: first.sha256 });
    for (const input of [first, area, full]) expect(await t.repo.appendScreenshot(input)).toBe(true);
    expect(await t.repo.screenshot(area.id)).toEqual({ ...area, pageUrl: PAGE });
    const page = await t.repo.screenshots({ pageUrl: PAGE, limit: 1 });
    expect(page.screenshots.map((s) => s.id)).toEqual([area.id]);
    expect((await t.repo.screenshots({ pageUrl: PAGE, cursor: page.next!, limit: 1 })).screenshots.map((s) => s.id)).toEqual([first.id]);
    expect((await t.repo.screenshots({ projectId: UNFILED_PROJECT_ID, limit: 10 })).screenshots.map((s) => s.id)).toEqual([full.id, area.id, first.id]);
    expect(await t.repo.isHashReferenced(first.sha256)).toBe(true);
    expect(await t.repo.isHashReferenced(sha256('none'))).toBe(false);
    expect((await t.repo.screenshotHashes()).sort()).toEqual([first.sha256, area.sha256].sort());
    // An area needs its rect; the other kinds have none; a capture id must name a capture.
    expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 4_000, kind: 'area' }))).toBe(false);
    expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 4_000, rectJson: '{}' }))).toBe(false);
    expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 4_000, captureId: uuidv7() }))).toBe(false);
    expect(count(t.raw, 'ci_screenshots')).toBe(3);
  });

  test('pages-list-captured-urls', async () => {
    const project = (await t.repo.createProject('Site', 1))!;
    await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 });
    await capture(t.repo, { url: OTHER, snapshot: '{"v":1}', at: 2_000, projectId: project.id });
    await capture(t.repo, { url: PAGE, snapshot: '{"v":2}', at: 3_000, profile: PHONE });
    expect(await t.repo.pages({ limit: 10 })).toEqual([
      { pageUrl: PAGE, captureCount: 2, lastCapturedAt: 3_000 },
      { pageUrl: OTHER, captureCount: 1, lastCapturedAt: 2_000 },
    ]);
    expect(await t.repo.pages({ projectId: project.id, limit: 10 })).toEqual([{ pageUrl: OTHER, captureCount: 1, lastCapturedAt: 2_000 }]);
    expect(await t.repo.pages({ limit: 1 })).toHaveLength(1);
  });

  test('invalid-input-writes-nothing', async () => {
    const gone = (await t.repo.createProject('Gone', 1))!;
    expect(await t.repo.tombstoneProject(gone.id, 2)).toBe(true);
    const existing = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    const before = counts(t.raw);
    const base = (over: Partial<AppendCaptureInput>) => captureInput({ url: OTHER, snapshot: '{"v":9}', at: 5_000, ...over });
    const bad: Partial<AppendCaptureInput>[] = [
      { captureId: 'not-an-id' },
      { versionId: '0190A000-0000-7000-8000-000000000001' },
      { captureId: existing.captureId },
      { versionId: existing.versionId },
      { projectId: uuidv7() },
      { projectId: gone.id },
      { laneKey: 'abc' },
      { snapshotHash: sha256('x').toUpperCase() },
      { pageUrl: 'file:///etc/passwd' },
      { pageUrl: 'javascript:alert(1)' },
      { source: 'robot' as never },
      { createdAt: -1 },
      { createdAt: Number.NaN },
      { auditTakenAt: 1.5 },
      { schemaVersion: 0 },
      { renderProfileJson: 'x'.repeat(MAX_PROFILE_JSON_BYTES + 1) },
      { snapshotJson: 'é'.repeat(MAX_SNAPSHOT_JSON_BYTES / 2 + 1) },
      { snapshotJson: 7 as never },
      { renderProfilePartial: 'yes' as never },
    ];
    for (const over of bad) expect(await t.repo.appendCapture(base(over)), JSON.stringify(over).slice(0, 80)).toBeNull();
    const latest = await t.repo.latestVersion(laneOf(PAGE));
    const badDiffs = [{ diffJson: 'x'.repeat(600_000) }, { changeCount: -1 }, { id: 'nope' }, { engineVersion: 1.5 }];
    for (const over of badDiffs) {
      const diff = { id: uuidv7(), fromVersionId: latest!.id, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: 0, ...over };
      expect(await t.repo.appendCapture(captureInput({ url: PAGE, snapshot: '{"v":2}', at: 5_000, diff })), JSON.stringify(over).slice(0, 80)).toBeNull();
    }
    const badShots = [{ kind: 'thumbnail' as never }, { width: 0 }, { sha256: 'zz' }, { pageUrl: 'data:text/html,x' }, { projectId: gone.id }, { bytes: -5 }, { segments: 1.5 }, { rectJson: 'x' }];
    for (const over of badShots) expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 5_000, ...over })), JSON.stringify(over)).toBe(false);
    expect(counts(t.raw)).toEqual(before);
  });

  test('tampered-rows-are-skipped', async () => {
    const good = appended(await capture(t.repo, { url: PAGE, snapshot: '{"v":1}', at: 1_000 }));
    const insertVersion = t.raw.prepare(
      'INSERT INTO ci_versions (id, lane_key, page_url, render_profile, search_params, snapshot, snapshot_hash, snapshot_bytes, schema_version, parent_version_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, 1, 1, NULL, ?)',
    );
    const lane = laneOf(PAGE);
    const tampered = [
      [uuidv7(), lane, PAGE, '{}', 'bad-hash', 2_000],
      [uuidv7(), lane, 'javascript:alert(1)', '{}', sha256('a'), 2_000],
      [uuidv7(), lane, PAGE, '{}', sha256('c'), -4],
    ] as const;
    for (const row of tampered) insertVersion.run(...row);
    // The id CHECK keeps a short id out; a 36-character non-UUID gets in and is skipped.
    insertVersion.run('x'.repeat(36), lane, PAGE, '{}', sha256('d'), 2_000);
    const history = await t.repo.history({ pageUrl: PAGE, limit: 10 });
    expect(history.entries.map((e) => e.id)).toEqual([good.versionId]);
    for (const [id] of tampered) expect(await t.repo.version(id)).toBeNull();
    // An over-cap snapshot: the history (which never reads snapshots) lists the version, reading it is refused.
    const huge = uuidv7();
    insertVersion.run(huge, laneOf(OTHER), OTHER, 'x'.repeat(MAX_SNAPSHOT_JSON_BYTES + 1), sha256('b'), 2_000);
    expect(await t.repo.version(huge)).toBeNull();
    expect(await t.repo.version('x'.repeat(36))).toBeNull();

    t.raw
      .prepare(
        "INSERT INTO ci_screenshots (id, project_id, page_url, capture_id, kind, rect, width, height, bytes, sha256, segments, render_profile, search_params, created_at) VALUES (?, ?, ?, NULL, ?, NULL, 10, 10, 10, ?, 1, NULL, NULL, 5)",
      )
      .run(uuidv7(), UNFILED_PROJECT_ID, PAGE, 'viewport', '../../etc/passwd'.padEnd(64, 'a'));
    expect((await t.repo.screenshots({ pageUrl: PAGE, limit: 10 })).screenshots).toEqual([]);
    expect(await t.repo.screenshotHashes()).toEqual([]);

    t.raw.prepare("INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, 'versions', NULL, 1, 1, NULL)").run(uuidv7(), 'No value');
    t.raw.prepare("INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, 'forever', NULL, 1, 1, NULL)").run(uuidv7(), 'x'.repeat(500));
    expect((await t.repo.projects()).map((p) => p.id)).toEqual([UNFILED_PROJECT_ID]);
  });
});
