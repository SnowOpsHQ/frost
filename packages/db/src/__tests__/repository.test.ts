// Spec: specs/browser-session-db.spec.ts (MAX_RESTORED_TABS, MAX_RECENT_VISITS, MAX_STORED_URL_LENGTH,
// MAX_STORED_TITLE_LENGTH), specs/permissions.spec.ts (SITE_PERMISSIONS, PERSISTED_DECISIONS),
// specs/capture-db.spec.ts (SCREENSHOT_EDIT_TABLES, MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES), specs/sync.spec.ts (SYNC_TABLES)
// Acceptance: specs/browser-session-db.feature.md (Repository), specs/screenshot.feature.md (Editing)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_RECENT_VISITS, MAX_RESTORED_TABS, MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository, type StoredDecision } from '../repository';
import { MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES, SCREENSHOT_EDIT_TABLES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { SYNC_TABLES } from '@app/specs/sync.spec';
import { MIGRATIONS } from '../migrations';
import { PHASE11_MIGRATIONS } from '../phase11-migrations';
import { uuidv7 } from '../change-intel/ids';
import { openTestDb, screenshotInput, sha256 } from '../change-intel/__tests__/fixtures';

let raw: DatabaseSync;
let repo: SessionRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createSessionRepository(createDrizzle(raw));
});

/** Plants rows straight into `browser_tabs`, as something other than frost could. */
function plantTabs(rows: { url: unknown; title?: string; active?: boolean }[]): void {
  raw.exec('DELETE FROM browser_tabs');
  const insert = raw.prepare('INSERT INTO browser_tabs (position, url, title, active) VALUES (?, ?, ?, ?)');
  rows.forEach((row, position) => insert.run(position, row.url as string, row.title ?? '', row.active ? 1 : 0));
}

const longUrl = (length: number) => `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`;

describe('session', () => {
  test('session-round-trip', async () => {
    const session = {
      tabs: [
        { url: 'https://a.example/', title: 'A' },
        { url: 'http://127.0.0.1:8080/b?q=1#frag', title: 'B' },
        { url: 'https://c.example/c', title: '' },
      ],
      activeIndex: 1,
    };
    await repo.saveSession(session);
    expect(await repo.loadSession()).toEqual(session);
    // Saving again replaces the previous strip.
    await repo.saveSession({ tabs: [{ url: 'https://d.example/', title: 'D' }], activeIndex: 0 });
    expect(await repo.loadSession()).toEqual({ tabs: [{ url: 'https://d.example/', title: 'D' }], activeIndex: 0 });
  });

  test('empty-tabs-restore-empty', async () => {
    const session = {
      tabs: [
        { url: '', title: '' },
        { url: 'https://a.example/', title: 'A' },
        { url: '', title: '' },
      ],
      activeIndex: 2,
    };
    await repo.saveSession(session);
    expect(await repo.loadSession()).toEqual(session);
  });

  test('save-stores-only-browsable-urls', async () => {
    const title = 'x'.repeat(MAX_STORED_TITLE_LENGTH) + 'overflow';
    await repo.saveSession({
      tabs: [
        { url: 'file:///etc/passwd', title: 'file' },
        { url: 'app://app/', title: 'app' },
        { url: 'https://user:secret@a.example/path', title },
        { url: longUrl(MAX_STORED_URL_LENGTH + 1), title: 'long' },
        { url: longUrl(MAX_STORED_URL_LENGTH), title: 'just fits' },
      ],
      activeIndex: 2,
    });
    const stored = raw.prepare('SELECT url, title, active FROM browser_tabs ORDER BY position').all();
    expect(stored.map((row) => row['url'])).toEqual(['', '', 'https://a.example/path', '', longUrl(MAX_STORED_URL_LENGTH)]);
    expect(stored[2]).toMatchObject({ title: 'x'.repeat(MAX_STORED_TITLE_LENGTH), active: 1 });
    expect(JSON.stringify(stored)).not.toContain('secret');

    const many = Array.from({ length: MAX_RESTORED_TABS + 5 }, (_, i) => ({ url: `https://t${i}.example/`, title: '' }));
    await repo.saveSession({ tabs: many, activeIndex: MAX_RESTORED_TABS + 4 });
    const saved = await repo.loadSession();
    expect(saved.tabs).toHaveLength(MAX_RESTORED_TABS);
    expect(saved.activeIndex).toBe(MAX_RESTORED_TABS - 1);
  });

  test('restore-skips-non-browsable-urls', async () => {
    plantTabs([
      { url: 'https://a.example/', title: 'A' },
      { url: 'file:///etc/passwd', title: 'passwd' },
      { url: 'app://app/', title: 'chrome' },
      { url: 'javascript:alert(1)', title: 'js', active: true },
      { url: 'data:text/html,x' },
      { url: 'not a url' },
      { url: 42 },
      { url: 'https://b.example/', title: 'B' },
    ]);
    // The skipped active tab hands active to its next valid right neighbour.
    expect(await repo.loadSession()).toEqual({
      tabs: [
        { url: 'https://a.example/', title: 'A' },
        { url: 'https://b.example/', title: 'B' },
      ],
      activeIndex: 1,
    });
    // ... else the last valid tab.
    plantTabs([{ url: 'https://a.example/' }, { url: 'https://b.example/' }, { url: 'file:///x', active: true }]);
    expect((await repo.loadSession()).activeIndex).toBe(1);
    // Userinfo planted in a row never comes back.
    plantTabs([{ url: 'https://user:pw@a.example/', active: true }]);
    expect((await repo.loadSession()).tabs).toEqual([{ url: 'https://a.example/', title: '' }]);
  });

  test('all-invalid-session-yields-one-empty-tab', async () => {
    const empty = { tabs: [{ url: '', title: '' }], activeIndex: 0 };
    expect(await repo.loadSession()).toEqual(empty);
    plantTabs([{ url: 'file:///etc/passwd', active: true }, { url: 'app://app/' }, { url: 'javascript:alert(1)' }, { url: 'garbage' }]);
    expect(await repo.loadSession()).toEqual(empty);
  });

  test('oversized-tampered-rows-skipped', async () => {
    // A planted 40 MB URL and title, then 300k rows: only `MAX_RESTORED_TABS` rows are read, and
    // values are cut in SQL (never read whole). The URL is skipped, the title capped.
    raw.exec('DELETE FROM browser_tabs');
    raw.exec(`INSERT INTO browser_tabs (position, url, title, active) VALUES
      (0, 'https://a.example/' || replace(hex(zeroblob(20000000)), '00', 'ab'), 'A', 0),
      (1, 'https://b.example/', replace(hex(zeroblob(20000000)), '00', 'tt'), 1)`);
    raw.exec(`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 300001)
      INSERT INTO browser_tabs (position, url, title, active) SELECT i, 'https://t' || i || '.example/', '', 0 FROM n`);
    // Watch what SQLite hands back rather than timing it (wall-clock bounds flake on loaded CI
    // runners): the read must return at most `MAX_RESTORED_TABS` rows, each value already cut in SQL.
    const seen = { rows: 0, longest: 0 };
    const watched = watchReads(raw, seen);
    const session = await createSessionRepository(createDrizzle(watched)).loadSession();
    expect(seen.rows).toBeLessThanOrEqual(MAX_RESTORED_TABS);
    expect(seen.longest).toBeLessThanOrEqual(Math.max(MAX_STORED_URL_LENGTH + 1, MAX_STORED_TITLE_LENGTH * 2));
    expect(session.tabs).toHaveLength(MAX_RESTORED_TABS - 1);
    expect(session.tabs[0]).toEqual({ url: 'https://b.example/', title: 't'.repeat(MAX_STORED_TITLE_LENGTH) });
    expect(session.activeIndex).toBe(0);
    // Planting 40 MB of values and 300k rows dominates the run; slow CI runners need more than the default 5 s.
  }, 30_000);

  test('restore-is-capped', async () => {
    plantTabs(Array.from({ length: MAX_RESTORED_TABS + 3 }, (_, i) => ({ url: `https://t${i}.example/` })));
    const session = await repo.loadSession();
    expect(session.tabs).toHaveLength(MAX_RESTORED_TABS);
    expect(session.tabs.at(-1)?.url).toBe(`https://t${MAX_RESTORED_TABS - 1}.example/`);
  });
});

describe('visits', () => {
  test('visits-recorded', async () => {
    await repo.recordVisit('https://a.example/', 1_000);
    await repo.recordVisit('https://a.example/', 2_000);
    await repo.updateVisitTitle('https://a.example/', 'Page A');
    await repo.recordVisit('https://b.example/', 1_500, 'Page B');
    expect(await repo.recentVisits()).toEqual([
      { url: 'https://a.example/', title: 'Page A', visitCount: 2, lastVisitAt: 2_000 },
      { url: 'https://b.example/', title: 'Page B', visitCount: 1, lastVisitAt: 1_500 },
    ]);
    // A visit without a title keeps the known one; an out-of-order batch never moves time back.
    await repo.write({ visits: [{ url: 'https://a.example/', visits: 3, lastVisitAt: 500, title: '' }] });
    expect((await repo.recentVisits())[0]).toEqual({ url: 'https://a.example/', title: 'Page A', visitCount: 5, lastVisitAt: 2_000 });
  });

  test('visits-only-browsable', async () => {
    for (const url of ['file:///etc/passwd', 'app://app/', 'javascript:alert(1)', 'about:blank', 'garbage', longUrl(MAX_STORED_URL_LENGTH + 1)]) {
      await repo.recordVisit(url, 1);
    }
    await repo.updateVisitTitle('https://never.example/', 'Never visited');
    expect(await repo.recentVisits()).toEqual([]);
    await repo.recordVisit('https://user:secret@a.example/x', 1, 't'.repeat(MAX_STORED_TITLE_LENGTH + 10));
    const [visit] = await repo.recentVisits();
    expect(visit).toEqual({ url: 'https://a.example/x', title: 't'.repeat(MAX_STORED_TITLE_LENGTH), visitCount: 1, lastVisitAt: 1 });
    expect(JSON.stringify(raw.prepare('SELECT * FROM recent_visits').all())).not.toContain('secret');
  });

  test('visits-pruned-to-max', async () => {
    const visits = Array.from({ length: MAX_RECENT_VISITS + 10 }, (_, i) => ({ url: `https://v${i}.example/`, visits: 1, lastVisitAt: i, title: '' }));
    await repo.write({ visits });
    const kept = await repo.recentVisits(MAX_RECENT_VISITS + 100);
    expect(kept).toHaveLength(MAX_RECENT_VISITS);
    // The ten oldest went.
    expect(kept.at(-1)?.lastVisitAt).toBe(10);
    expect(kept[0]?.lastVisitAt).toBe(MAX_RECENT_VISITS + 9);
  });
});

describe('permission decisions', () => {
  const block: StoredDecision = { origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'notifications', decision: 'block' };
  const embedded: StoredDecision = { origin: 'https://widget.example', topLevelOrigin: 'http://127.0.0.1:8080', permission: 'camera', decision: 'block' };
  const countRows = () => raw.prepare('SELECT COUNT(*) AS n FROM site_permissions').get();

  test('permission-decisions-round-trip', async () => {
    await repo.savePermissionDecision(block, 1);
    await repo.savePermissionDecision(embedded, 2);
    expect(await repo.loadPermissionDecisions()).toEqual(expect.arrayContaining([block, embedded]));
    expect(await repo.loadPermissionDecisions()).toHaveLength(2);
    // The same key saved again stays one row.
    await repo.savePermissionDecision(block, 3);
    expect(await repo.loadPermissionDecisions()).toHaveLength(2);
    // Keys never mix: the same origin under another top-level site is its own entry.
    await repo.savePermissionDecision({ ...block, topLevelOrigin: 'https://b.example' }, 4);
    expect(await repo.loadPermissionDecisions()).toHaveLength(3);
  });

  test('only-blocks-are-stored', async () => {
    // An Allow is never written, and does not replace a stored Block.
    await repo.savePermissionDecision({ ...block, decision: 'allow' } as unknown as StoredDecision, 1);
    expect(countRows()).toEqual({ n: 0 });
    await repo.savePermissionDecision(block, 2);
    await repo.savePermissionDecision({ ...block, decision: 'allow' } as unknown as StoredDecision, 3);
    expect(await repo.loadPermissionDecisions()).toEqual([block]);
    // An Allow row in the file (an earlier build's, or planted) is not loaded.
    raw.prepare("INSERT INTO site_permissions (origin, top_level_origin, permission, decision, updated_at) VALUES ('https://c.example', 'https://c.example', 'geolocation', 'allow', 1)").run();
    expect(await repo.loadPermissionDecisions()).toEqual([block]);
  });

  test('clear-browsing-data-in-repository', async () => {
    const session = { tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }], activeIndex: 1 };
    await repo.write({ session, visits: [{ url: 'https://a.example/', visits: 2, lastVisitAt: 5, title: 'A' }] });
    await repo.savePermissionDecision(block, 1);
    await repo.savePermissionDecision(embedded, 2);
    await repo.clearBrowsingData();
    expect(await repo.recentVisits()).toEqual([]);
    expect(await repo.loadPermissionDecisions()).toEqual([]);
    expect(countRows()).toEqual({ n: 0 });
    // The tab strip is kept.
    expect(await repo.loadSession()).toEqual(session);
  });

  test('tampered-permission-rows-skipped', async () => {
    await repo.savePermissionDecision(block, 1);
    const insert = raw.prepare('INSERT INTO site_permissions (origin, top_level_origin, permission, decision, updated_at) VALUES (?, ?, ?, ?, 1)');
    insert.run('file://', 'https://a.example', 'geolocation', 'allow');
    insert.run('https://a.example/path', 'https://a.example', 'geolocation', 'allow');
    insert.run('https://a.example', 'app://app', 'geolocation', 'allow');
    insert.run('https://a.example', 'https://a.example', 'midi', 'allow');
    insert.run('https://a.example', 'https://a.example', 'camera', 'dismiss');
    expect(await repo.loadPermissionDecisions()).toEqual([block]);
    // Invalid keys are not written either.
    await repo.savePermissionDecision({ ...block, origin: 'javascript:alert(1)' }, 2);
    await repo.savePermissionDecision({ ...block, permission: 'midi' as never }, 2);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM site_permissions').get()).toEqual({ n: 6 });
  });
});

/** `db`, recording how many rows its statements return and the longest string value in them. */
function watchReads(db: DatabaseSync, seen: { rows: number; longest: number }): DatabaseSync {
  const record = (result: unknown): void => {
    const rows = Array.isArray(result) ? result : result && typeof result === 'object' ? [result] : [];
    seen.rows += rows.length;
    for (const row of rows) {
      for (const value of Object.values(row as object)) if (typeof value === 'string') seen.longest = Math.max(seen.longest, value.length);
    }
  };
  const watchStatement = (statement: object): object =>
    new Proxy(statement, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result: unknown = value.apply(target, args);
          if (key === 'all' || key === 'get') record(result);
          return result;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === 'prepare' && typeof value === 'function') return (sql: string) => watchStatement(value.call(target, sql) as object);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('screenshot edits (Phase 11 Task 7)', () => {
  const PAGE = 'https://example.com/a';
  /** A source screenshot and an edited copy of it, appended through the repository. */
  async function sourceAndCopy(t: ReturnType<typeof openTestDb>, projectId: string = UNFILED_PROJECT_ID, at = 1_000) {
    const source = screenshotInput({ pageUrl: PAGE, createdAt: at, projectId });
    expect(await t.repo.appendScreenshot(source)).toBe(true);
    const copy = { ...screenshotInput({ pageUrl: PAGE, createdAt: at + 500, projectId, sha256: sha256(`copy:${at}`), width: 300, height: 200 }), sourceId: source.id, cropJson: '{"height":200,"width":300,"x":10,"y":20}', opsJson: '[]' };
    expect(await t.repo.appendScreenshotEdit(copy)).toBe(true);
    return { source, copy };
  }
  const editRows = (t: ReturnType<typeof openTestDb>) => t.raw.prepare('SELECT screenshot_id, source_id, crop, ops, created_at FROM screenshot_edits ORDER BY screenshot_id').all().map((row) => ({ ...row }));

  test('migration-0231', async () => {
    // The table, its index and its trigger; local-only (not synced), last in MIGRATIONS.
    // Phase 11's ids are in MIGRATIONS in order, after every id below 0230 (a later block may follow them).
    const ids = MIGRATIONS.map((m) => m.id);
    const phase11 = PHASE11_MIGRATIONS.map((m) => m.id);
    expect(phase11).toContain('0231_screenshot_edits');
    const positions = phase11.map((id) => ids.indexOf(id));
    expect(positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1]!))).toBe(true);
    expect(ids.filter((id) => id < '0230').every((id) => ids.indexOf(id) < positions[0]!)).toBe(true);
    expect(SYNC_TABLES.map((table) => table.name)).not.toContain(SCREENSHOT_EDIT_TABLES[0]);
    const names = (type: string) => raw.prepare("SELECT name FROM sqlite_master WHERE type = ? AND tbl_name IN ('screenshot_edits', 'ci_screenshots') ORDER BY name").all(type).map((row) => String(row['name']));
    expect(names('table')).toEqual(['ci_screenshots', 'screenshot_edits']);
    expect(names('index')).toContain('screenshot_edits_source_id');
    expect(names('trigger')).toContain('screenshot_edits_follow_screenshots');
    // Its checks: ids are 36 characters and differ, ops are bounded, times are whole and not negative.
    const insert = raw.prepare('INSERT INTO screenshot_edits (screenshot_id, source_id, crop, ops, created_at) VALUES (?, ?, ?, ?, ?)');
    const a = uuidv7(1);
    const b = uuidv7(2);
    expect(() => insert.run('short', b, null, '[]', 1)).toThrow();
    expect(() => insert.run(a, a, null, '[]', 1)).toThrow();
    expect(() => insert.run(a, b, null, 'x'.repeat(MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES + 1), 1)).toThrow();
    expect(() => insert.run(a, b, null, '[]', -1)).toThrow();
    insert.run(a, b, null, '[]', 1);
    expect(raw.prepare('SELECT count(*) AS n FROM screenshot_edits').get()!['n']).toBe(1);

    // Through the repository: the copy and its link in one go, read back with `editedFrom`.
    const t = openTestDb();
    const { source, copy } = await sourceAndCopy(t);
    expect(editRows(t)).toEqual([{ screenshot_id: copy.id, source_id: source.id, crop: copy.cropJson, ops: '[]', created_at: copy.createdAt }]);
    expect(await t.repo.screenshot(copy.id)).toMatchObject({ id: copy.id, editedFrom: source.id, width: 300, height: 200 });
    expect(await t.repo.screenshot(source.id)).toMatchObject({ id: source.id, editedFrom: null });
    expect((await t.repo.screenshots({ pageUrl: PAGE })).screenshots.map((shot) => [shot.id, shot.editedFrom])).toEqual([
      [copy.id, source.id],
      [source.id, null],
    ]);
    // Refused: no such source, a source in a deleted project, its own id, empty or oversized JSON (the
    // repository never parses it), an id taken.
    const orphan = { ...screenshotInput({ pageUrl: PAGE, createdAt: 9_000 }), sourceId: uuidv7(8_000), cropJson: null, opsJson: '[]' };
    expect(await t.repo.appendScreenshotEdit(orphan)).toBe(false);
    expect(await t.repo.appendScreenshotEdit({ ...orphan, sourceId: orphan.id })).toBe(false);
    expect(await t.repo.appendScreenshotEdit({ ...orphan, sourceId: source.id, opsJson: '' })).toBe(false);
    expect(await t.repo.appendScreenshotEdit({ ...orphan, sourceId: source.id, opsJson: 'x'.repeat(MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES + 1) })).toBe(false);
    expect(await t.repo.appendScreenshotEdit({ ...orphan, sourceId: source.id, cropJson: 'x'.repeat(300) })).toBe(false);
    expect(await t.repo.appendScreenshotEdit({ ...copy })).toBe(false);
    const project = (await t.repo.createProject('Gone', 1))!;
    const elsewhere = screenshotInput({ pageUrl: PAGE, createdAt: 10_000, projectId: project.id });
    expect(await t.repo.appendScreenshot(elsewhere)).toBe(true);
    expect(await t.repo.tombstoneProject(project.id, 11_000)).toBe(true);
    expect(await t.repo.appendScreenshotEdit({ ...screenshotInput({ pageUrl: PAGE, createdAt: 12_000, projectId: project.id }), sourceId: elsewhere.id, cropJson: null, opsJson: '[]' })).toBe(false);
    expect(t.raw.prepare('SELECT count(*) AS n FROM ci_screenshots').get()!['n']).toBe(3);
    expect(editRows(t)).toHaveLength(1);
  });

  test('purge-removes-edit-rows', async () => {
    const t = openTestDb();
    const p = (await t.repo.createProject('P', 1))!.id;
    // Two sources, each with a copy; the second source also has a second copy.
    const first = await sourceAndCopy(t, p, 1_000);
    const second = await sourceAndCopy(t, p, 5_000);
    const another = { ...screenshotInput({ pageUrl: PAGE, createdAt: 7_000, projectId: p, sha256: sha256('copy:again') }), sourceId: second.source.id, cropJson: null, opsJson: '[]' };
    expect(await t.repo.appendScreenshotEdit(another)).toBe(true);
    expect(editRows(t)).toHaveLength(3);

    // Keep the newest of each lane (copies are a lane of their own): the older source and the older
    // copies go, with their links; the newest copy keeps its link to the newest source.
    const plan = await t.repo.planPurge({ projectId: p, policy: { mode: 'versions', value: 1 }, now: 10_000 });
    expect(plan?.screenshotIds).toEqual([first.source.id, first.copy.id, second.copy.id].sort());
    expect((await t.repo.executePurge(plan!, 'retention', 10_000))?.status).toBe('purged');
    expect(editRows(t)).toEqual([{ screenshot_id: another.id, source_id: second.source.id, crop: null, ops: '[]', created_at: another.createdAt }]);
    expect(await t.repo.screenshot(another.id)).toMatchObject({ id: another.id, editedFrom: second.source.id });

    // A deleted project's purge takes the rest; a copy whose source stays loses only its own link.
    const third = await sourceAndCopy(t, UNFILED_PROJECT_ID, 20_000);
    expect(editRows(t)).toHaveLength(2);
    expect(await t.repo.tombstoneProject(p, 30_000)).toBe(true);
    const all = await t.repo.planPurge({ projectId: p, policy: { mode: 'all' }, now: 30_000 });
    expect((await t.repo.executePurge(all!, 'project-deleted', 30_000))?.status).toBe('purged');
    expect(editRows(t)).toEqual([{ screenshot_id: third.copy.id, source_id: third.source.id, crop: third.copy.cropJson, ops: '[]', created_at: third.copy.createdAt }]);
    // Only a copy purged: its link goes, its source stays.
    t.raw.exec(`INSERT INTO ci_purges (id, reason, project_id, policy, captures, versions, diffs, screenshots, bytes, created_at) VALUES ('${uuidv7(40_000)}', 'purge-now', NULL, NULL, 0, 0, 0, 1, 0, 40000)`);
    const purgeId = String(t.raw.prepare('SELECT id FROM ci_purges ORDER BY created_at DESC LIMIT 1').get()!['id']);
    t.raw.prepare("INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, ?, 'ci_screenshots', ?, 40000)").run(uuidv7(40_001), purgeId, third.copy.id);
    t.raw.prepare('DELETE FROM ci_screenshots WHERE id = ?').run(third.copy.id);
    expect(editRows(t)).toEqual([]);
    expect(await t.repo.screenshot(third.source.id)).not.toBeNull();
  });
});
