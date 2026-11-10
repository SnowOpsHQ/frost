// Spec: specs/browser-polish.spec.ts (HISTORY_PAGE_SIZE, HISTORY_QUERY_MAX_CHARS, JUMP_BACK_IN_*,
// SEARCH_ENGINE_SETTING_KEY, DEFAULT_SEARCH_ENGINE; Phase 11: HISTORY_RETENTIONS, HISTORY_RETENTION_SETTING_KEY,
// HISTORY_KEEP_PROJECT_PAGES_KEY, historyRetentionCutoff, historyClearSince), specs/projects.spec.ts
// (RANK_RUN_DISCLOSURE_SETTING_KEY, Phase 10 Task 8)
// Acceptance: specs/browser-polish.feature.md (History view, New-tab page, Search engines; History retention, ranges and projects),
// specs/projects.feature.md (Searches in a run: the disclosure is remembered once per install)
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_HISTORY_KEEP_PROJECT_PAGES,
  DEFAULT_HISTORY_RETENTION,
  DEFAULT_SEARCH_ENGINE,
  HISTORY_CLEAR_RANGES,
  HISTORY_KEEP_PROJECT_PAGES_KEY,
  HISTORY_PAGE_SIZE,
  HISTORY_RETENTION_SETTING_KEY,
  historyClearSince,
  historyRetentionCutoff,
  JUMP_BACK_IN_MOST_VISITED,
  JUMP_BACK_IN_RECENT,
  SEARCH_ENGINE_SETTING_KEY,
} from '@app/specs/browser-polish.spec';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { RANK_RUN_DISCLOSURE_SETTING_KEY } from '@app/specs/projects.spec';
import { createDrizzle } from '../client';
import { createHistoryRepository, likePattern, type HistoryRepository, type HistoryVisit } from '../history';
import { MIGRATIONS, runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository } from '../repository';
import { createSettingsRepository } from '../settings';
import { createSessionWriter } from '../writer';

let raw: DatabaseSync;
let history: HistoryRepository;
let repo: SessionRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  const db = createDrizzle(raw);
  history = createHistoryRepository(db);
  repo = createSessionRepository(db);
});

afterEach(() => {
  vi.useRealTimers();
});

const insert = (url: string, title: string, visitCount: number, lastVisitAt: number) =>
  raw.prepare('INSERT INTO recent_visits (url, title, visit_count, last_visit_at) VALUES (?, ?, ?, ?)').run(url, title, visitCount, lastVisitAt);
const urls = (visits: readonly HistoryVisit[]) => visits.map((v) => v.url);
const count = () => Number(raw.prepare('SELECT count(*) AS n FROM recent_visits').get()!['n']);

describe('history repository', () => {
  test('history-list-newest-first-paginates', async () => {
    // 250 visits (more than two pages), some sharing a time (ordered by URL then).
    for (let i = 0; i < 250; i++) insert(`https://site.example/p${String(i).padStart(3, '0')}`, `Page ${i}`, 1, 1_000 + Math.floor(i / 2));
    const first = await history.list({ query: '', after: null });
    expect(first.visits).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.visits[0]!.url).toBe('https://site.example/p249');
    expect(first.visits[1]!.url).toBe('https://site.example/p248');
    const seen = [...urls(first.visits)];
    let next = first.next;
    while (next) {
      const page = await history.list({ query: '', after: next });
      seen.push(...urls(page.visits));
      next = page.next;
    }
    // Every visit exactly once, newest first: a keyset never skips or repeats a row with the same time.
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    const times = seen.map((u) => Number(u.slice(-3)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // A smaller page, and a limit never above the cap.
    expect((await history.list({ query: '', after: null, limit: 3 })).visits).toHaveLength(3);
    expect((await history.list({ query: '', after: null, limit: 10_000 })).visits).toHaveLength(HISTORY_PAGE_SIZE);
    // The last page says so.
    expect((await history.list({ query: 'p000', after: null })).next).toBeNull();
  });

  test('history-search-escapes-like', async () => {
    insert('https://tea.example/green', 'Green Tea Guide', 1, 3);
    insert('https://shop.example/100%25', '100% cotton', 1, 2);
    insert('https://shop.example/a_b', 'Under_score', 1, 1);
    insert('https://other.example/', 'Coffee', 1, 4);
    // Title or URL, case-insensitive (ASCII), trimmed.
    expect(urls((await history.list({ query: '  green tea ', after: null })).visits)).toEqual(['https://tea.example/green']);
    expect(urls((await history.list({ query: 'TEA.EXAMPLE', after: null })).visits)).toEqual(['https://tea.example/green']);
    // `%` and `_` are literal, never wildcards.
    expect(urls((await history.list({ query: '%', after: null })).visits)).toEqual(['https://shop.example/100%25']);
    expect(urls((await history.list({ query: '_', after: null })).visits)).toEqual(['https://shop.example/a_b']);
    expect(urls((await history.list({ query: '\\', after: null })).visits)).toEqual([]);
    expect(likePattern('a%b_c\\')).toBe('%a\\%b\\_c\\\\%');
  });

  test('history-skips-tampered-rows', async () => {
    insert('https://ok.example/', 'Fine', 2, 10);
    insert('javascript:alert(1)', 'Bad scheme', 1, 9);
    insert('https://neg.example/', 'Bad count', 0, 8);
    insert('https://time.example/', 'Bad time', 1, -5);
    raw.prepare('INSERT INTO recent_visits (url, title, visit_count, last_visit_at) VALUES (?, ?, ?, ?)').run('https://big.example/', 'x'.repeat(5_000), 1, 7);
    const page = await history.list({ query: '', after: null });
    expect(urls(page.visits)).toEqual(['https://ok.example/', 'https://big.example/']);
    // A stored title is never longer than the cap.
    expect(page.visits[1]!.title.length).toBeLessThanOrEqual(512);
    expect(urls((await history.jumpBackIn()).mostVisited)).not.toContain('javascript:alert(1)');
  });

  test('jump-back-in-dedupes', async () => {
    expect(await history.jumpBackIn()).toEqual({ mostVisited: [], recent: [] });
    for (let i = 0; i < 12; i++) insert(`https://s${i}.example/`, `S${i}`, i + 1, 100 - i);
    const { mostVisited, recent } = await history.jumpBackIn();
    expect(urls(mostVisited)).toEqual(['https://s11.example/', 'https://s10.example/', 'https://s9.example/', 'https://s8.example/']);
    expect(mostVisited).toHaveLength(JUMP_BACK_IN_MOST_VISITED);
    // The most recent pages not already listed.
    expect(urls(recent)).toEqual(['https://s0.example/', 'https://s1.example/', 'https://s2.example/', 'https://s3.example/']);
    expect(recent).toHaveLength(JUMP_BACK_IN_RECENT);
  });

  test('history-delete-drops-pending', async () => {
    vi.useFakeTimers();
    insert('https://keep.example/', 'Keep', 1, 1);
    insert('https://gone.example/', 'Gone', 1, 2);
    const writer = createSessionWriter(repo, { now: () => 50 });
    // A visit still pending in the writer is dropped too, so it can't come back after the delete.
    writer.recordVisit('https://gone.example/');
    expect(await writer.deleteVisit('https://gone.example/')).toBe(true);
    await writer.flush();
    expect(urls((await history.list({ query: '', after: null })).visits)).toEqual(['https://keep.example/']);
    expect(await writer.deleteVisit('javascript:alert(1)')).toBe(false);
    expect(count()).toBe(1);
  });

  test('history-clear-all-is-the-history-part', async () => {
    vi.useFakeTimers();
    insert('https://a.example/', 'A', 1, 1);
    raw.prepare("INSERT INTO site_permissions (origin, top_level_origin, permission, decision, updated_at) VALUES ('https://a.example', '', 'notifications', 'block', 1)").run();
    const writer = createSessionWriter(repo, { now: () => 50 });
    writer.recordVisit('https://b.example/');
    await writer.clearHistory();
    await writer.flush();
    // Every visit (stored and pending), nothing else.
    expect(count()).toBe(0);
    expect(Number(raw.prepare('SELECT count(*) AS n FROM site_permissions').get()!['n'])).toBe(1);
  });
});

describe('settings repository', () => {
  test('settings-store-search-engine', async () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0005_app_settings');
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await settings.searchEngine()).toBe(DEFAULT_SEARCH_ENGINE);
    expect(await settings.setSearchEngine('duckduckgo', 5)).toBe(true);
    expect(await settings.searchEngine()).toBe('duckduckgo');
    expect(await settings.setSearchEngine('bing', 6)).toBe(true);
    expect(await settings.searchEngine()).toBe('bing');
    // Anything else is refused, and a tampered row reads as the default.
    expect(await settings.setSearchEngine('evil' as never, 7)).toBe(false);
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('https://evil.example/?q=', SEARCH_ENGINE_SETTING_KEY);
    expect(await settings.searchEngine()).toBe(DEFAULT_SEARCH_ENGINE);
    // Clear Browsing Data keeps the preference.
    await settings.setSearchEngine('bing', 8);
    await repo.clearBrowsingData();
    expect(await settings.searchEngine()).toBe('bing');
  });

  test('settings-store-rank-run-disclosure', async () => {
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await settings.rankRunDisclosureAccepted()).toBe(false);
    expect(await settings.setRankRunDisclosureAccepted(Number.NaN)).toBe(false);
    expect(await settings.rankRunDisclosureAccepted()).toBe(false);
    expect(await settings.setRankRunDisclosureAccepted(9)).toBe(true);
    expect(await settings.rankRunDisclosureAccepted()).toBe(true);
    expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(RANK_RUN_DISCLOSURE_SETTING_KEY)).toEqual({ value: 'accepted' });
    // Kept through Clear Browsing Data; any other stored value reads as not accepted.
    await repo.clearBrowsingData();
    expect(await settings.rankRunDisclosureAccepted()).toBe(true);
    for (const tampered of ['yes', 'true', '1', 'accepted ']) {
      raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(tampered, RANK_RUN_DISCLOSURE_SETTING_KEY);
      expect(await settings.rankRunDisclosureAccepted(), tampered).toBe(false);
    }
    expect(await settings.searchEngine()).toBe(DEFAULT_SEARCH_ENGINE);
  });
});

// ---- Phase 11 Task 10: retention, clear by range, project filter, change counts -----------------

const DAY = 24 * 60 * 60 * 1_000;
let ids = 0;
/** A UUIDv7-shaped id (the tables check the shape only through the repository, not SQL). */
const newId = () => `0190${String(++ids).padStart(4, '0')}-0000-7000-8000-000000000000`;
const project = (deletedAt: number | null = null) => {
  const id = newId();
  raw.prepare("INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, 'forever', NULL, 1, 1, ?)").run(id, `P${id}`, deletedAt);
  return id;
};
const projectPage = (projectId: string, url: string, deletedAt: number | null = null) =>
  raw.prepare('INSERT INTO ci_project_pages (id, project_id, url, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 1, 1, ?)').run(newId(), projectId, url, deletedAt);
const version = (pageUrl: string, laneKey: string, at: number) =>
  raw
    .prepare('INSERT INTO ci_versions (id, lane_key, page_url, render_profile, search_params, snapshot, snapshot_hash, snapshot_bytes, schema_version, parent_version_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, 1, 1, NULL, ?)')
    .run(newId(), laneKey, pageUrl, '{}', 'a'.repeat(64), at);
const stored = () => (raw.prepare('SELECT url FROM recent_visits ORDER BY url').all() as { url: string }[]).map((row) => row.url);

describe('history retention and projects', () => {
  test('prune-keeps-project-pages', async () => {
    const now = 100 * DAY;
    const live = project();
    const gone = project(5);
    projectPage(live, 'https://site.example/kept');
    projectPage(live, 'https://site.example/dropped-page', 7);
    projectPage(gone, 'https://site.example/in-deleted-project');
    insert('https://site.example/old', 'Old', 1, now - 40 * DAY);
    insert('https://site.example/kept#section', 'Kept (fragment)', 1, now - 40 * DAY);
    insert('https://site.example/dropped-page', 'Dropped page', 1, now - 40 * DAY);
    insert('https://site.example/in-deleted-project', 'Deleted project', 1, now - 40 * DAY);
    insert('https://site.example/recent', 'Recent', 1, now - DAY);
    // `forever` has no cut-off; 30 days cuts at now - 30 days.
    expect(historyRetentionCutoff('forever', now)).toBeNull();
    const cutoff = historyRetentionCutoff('30d', now)!;
    expect(cutoff).toBe(now - 30 * DAY);
    // Keeping project pages: only the live project's live page stays among the old visits.
    expect(await history.prune(cutoff, true)).toBe(3);
    expect(stored()).toEqual(['https://site.example/kept#section', 'https://site.example/recent']);
    // Not keeping them: it goes too; a visit at exactly the cut-off stays.
    insert('https://site.example/edge', 'Edge', 1, cutoff);
    expect(await history.prune(cutoff, false)).toBe(1);
    expect(stored()).toEqual(['https://site.example/edge', 'https://site.example/recent']);
    // A nonsense cut-off deletes nothing.
    expect(await history.prune(Number.NaN, false)).toBe(0);
    expect(stored()).toHaveLength(2);
  });

  test('clear-range-on-last-visit', async () => {
    const now = 50 * DAY;
    // One row per URL: `/both` was visited long ago and again within the hour.
    insert('https://site.example/both', 'Both', 5, now - 10 * 60 * 1_000);
    insert('https://site.example/two-hours', 'Two hours', 1, now - 2 * 60 * 60 * 1_000);
    insert('https://site.example/old', 'Old', 1, now - 20 * DAY);
    const hour = historyClearSince('hour', now);
    expect(hour).toBe(now - HISTORY_CLEAR_RANGES.find((r) => r.id === 'hour')!.ms);
    expect(await history.clearSince(hour)).toBe(1);
    // Its earlier visits went with it (one row per URL); older rows stay.
    expect(stored()).toEqual(['https://site.example/old', 'https://site.example/two-hours']);
    expect(await history.clearSince(historyClearSince('day', now))).toBe(1);
    expect(stored()).toEqual(['https://site.example/old']);
    // A visit at exactly the range's start is in it; the month reaches 30 days back, not 31.
    expect(historyClearSince('month', now)).toBe(now - 30 * DAY);
    insert('https://site.example/edge', 'Edge', 1, historyClearSince('week', now));
    expect(await history.clearSince(historyClearSince('week', now))).toBe(1);
    expect(stored()).toEqual(['https://site.example/old']);
    expect(await history.clearSince(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('project-filter', async () => {
    const a = project();
    const b = project();
    const deleted = project(9);
    projectPage(a, 'https://site.example/a1');
    projectPage(a, 'https://site.example/a2');
    projectPage(a, 'https://site.example/a-gone', 3);
    projectPage(b, 'https://site.example/b1');
    projectPage(deleted, 'https://site.example/a1-elsewhere');
    insert('https://site.example/a1#top', 'A1', 1, 10);
    insert('https://site.example/a2', 'A2', 1, 30);
    insert('https://site.example/a2?x=1', 'A2 query', 1, 40);
    insert('https://site.example/a-gone', 'Gone', 1, 50);
    insert('https://site.example/b1', 'B1', 1, 20);
    insert('https://site.example/a1-elsewhere', 'Elsewhere', 1, 60);
    // Only a's live pages, fragment ignored, newest first; a query string is another page.
    expect(urls((await history.list({ query: '', after: null, projectId: a })).visits)).toEqual(['https://site.example/a2', 'https://site.example/a1#top']);
    expect(urls((await history.list({ query: '', after: null, projectId: b })).visits)).toEqual(['https://site.example/b1']);
    // A deleted project, or an unknown one, lists nothing.
    expect((await history.list({ query: '', after: null, projectId: deleted })).visits).toEqual([]);
    expect((await history.list({ query: '', after: null, projectId: newId() })).visits).toEqual([]);
    // With the search box and the keyset too.
    expect(urls((await history.list({ query: 'A1', after: null, projectId: a })).visits)).toEqual(['https://site.example/a1#top']);
    const first = await history.list({ query: '', after: null, projectId: a, limit: 1 });
    expect(urls(first.visits)).toEqual(['https://site.example/a2']);
    expect(urls((await history.list({ query: '', after: first.next, projectId: a, limit: 1 })).visits)).toEqual(['https://site.example/a1#top']);
    // Without a project: every visit.
    expect((await history.list({ query: '', after: null })).visits).toHaveLength(6);
    // Unfiled holds pages too.
    projectPage(UNFILED_PROJECT_ID, 'https://site.example/b1');
    expect(urls((await history.list({ query: '', after: null, projectId: UNFILED_PROJECT_ID })).visits)).toEqual(['https://site.example/b1']);
  });

  test('change-count-from-versions', async () => {
    insert('https://site.example/changed#frag', 'Changed', 1, 30);
    insert('https://site.example/once', 'Once', 1, 20);
    insert('https://site.example/never', 'Never', 1, 10);
    // Three versions in one lane (two changes), two in another (one change): three.
    for (const at of [1, 2, 3]) version('https://site.example/changed', 'lane-a', at);
    for (const at of [4, 5]) version('https://site.example/changed', 'lane-b', at);
    version('https://site.example/once', 'lane-c', 1);
    const { visits } = await history.list({ query: '', after: null });
    expect(visits.map((v) => [v.url, v.changeCount])).toEqual([
      ['https://site.example/changed#frag', 3],
      ['https://site.example/once', 0],
      ['https://site.example/never', 0],
    ]);
    // The new-tab page's tiles carry none.
    expect((await history.jumpBackIn()).mostVisited.every((v) => v.changeCount === undefined)).toBe(true);

    // The two settings: defaults, a round trip, refusals, tampered rows as the defaults.
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await settings.historySettings()).toEqual({ retention: DEFAULT_HISTORY_RETENTION, keepProjectPages: DEFAULT_HISTORY_KEEP_PROJECT_PAGES });
    expect(DEFAULT_HISTORY_RETENTION).toBe('forever');
    expect(DEFAULT_HISTORY_KEEP_PROJECT_PAGES).toBe(true);
    expect(await settings.setHistorySettings({ retention: '7d', keepProjectPages: false }, 5)).toBe(true);
    expect(await settings.historySettings()).toEqual({ retention: '7d', keepProjectPages: false });
    expect(await settings.setHistorySettings({ retention: '1d' as never, keepProjectPages: true }, 6)).toBe(false);
    expect(await settings.setHistorySettings({ retention: '30d', keepProjectPages: 'yes' as never }, 6)).toBe(false);
    expect(await settings.historySettings()).toEqual({ retention: '7d', keepProjectPages: false });
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('365d', HISTORY_RETENTION_SETTING_KEY);
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('true', HISTORY_KEEP_PROJECT_PAGES_KEY);
    expect(await settings.historySettings()).toEqual({ retention: DEFAULT_HISTORY_RETENTION, keepProjectPages: DEFAULT_HISTORY_KEEP_PROJECT_PAGES });
    // Clear Browsing Data keeps the preferences.
    await settings.setHistorySettings({ retention: '90d', keepProjectPages: true }, 7);
    await repo.clearBrowsingData();
    expect(await settings.historySettings()).toEqual({ retention: '90d', keepProjectPages: true });
  });
});
