// Spec: specs/browser-session-db.spec.ts (MAX_RESTORED_TABS, MAX_RECENT_VISITS, MAX_STORED_URL_LENGTH,
// MAX_STORED_TITLE_LENGTH), specs/permissions.spec.ts (SITE_PERMISSIONS, REMEMBERED_DECISIONS)
// Acceptance: specs/browser-session-db.feature.md (Repository)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_RECENT_VISITS, MAX_RESTORED_TABS, MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository, type StoredDecision } from '../repository';

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
    const started = performance.now();
    const session = await repo.loadSession();
    expect(performance.now() - started).toBeLessThan(100);
    expect(session.tabs).toHaveLength(MAX_RESTORED_TABS - 1);
    expect(session.tabs[0]).toEqual({ url: 'https://b.example/', title: 't'.repeat(MAX_STORED_TITLE_LENGTH) });
    expect(session.activeIndex).toBe(0);
  });

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
  const allow: StoredDecision = { origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'notifications', decision: 'allow' };
  const embedded: StoredDecision = { origin: 'https://widget.example', topLevelOrigin: 'http://127.0.0.1:8080', permission: 'camera', decision: 'block' };

  test('permission-decisions-round-trip', async () => {
    await repo.savePermissionDecision(allow, 1);
    await repo.savePermissionDecision(embedded, 2);
    expect(await repo.loadPermissionDecisions()).toEqual(expect.arrayContaining([allow, embedded]));
    expect(await repo.loadPermissionDecisions()).toHaveLength(2);
    // A later decision for the same key replaces the earlier one.
    await repo.savePermissionDecision({ ...allow, decision: 'block' }, 3);
    const loaded = await repo.loadPermissionDecisions();
    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual({ ...allow, decision: 'block' });
    // Keys never mix: the same origin under another top-level site is its own entry.
    await repo.savePermissionDecision({ ...allow, topLevelOrigin: 'https://b.example' }, 4);
    expect(await repo.loadPermissionDecisions()).toHaveLength(3);
  });

  test('tampered-permission-rows-skipped', async () => {
    await repo.savePermissionDecision(allow, 1);
    const insert = raw.prepare('INSERT INTO site_permissions (origin, top_level_origin, permission, decision, updated_at) VALUES (?, ?, ?, ?, 1)');
    insert.run('file://', 'https://a.example', 'geolocation', 'allow');
    insert.run('https://a.example/path', 'https://a.example', 'geolocation', 'allow');
    insert.run('https://a.example', 'app://app', 'geolocation', 'allow');
    insert.run('https://a.example', 'https://a.example', 'midi', 'allow');
    insert.run('https://a.example', 'https://a.example', 'camera', 'dismiss');
    expect(await repo.loadPermissionDecisions()).toEqual([allow]);
    // Invalid keys are not written either.
    await repo.savePermissionDecision({ ...allow, origin: 'javascript:alert(1)' }, 2);
    await repo.savePermissionDecision({ ...allow, permission: 'midi' as never }, 2);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM site_permissions').get()).toEqual({ n: 6 });
  });
});
