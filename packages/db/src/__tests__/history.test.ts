// Spec: specs/browser-polish.spec.ts (HISTORY_PAGE_SIZE, HISTORY_QUERY_MAX_CHARS, JUMP_BACK_IN_*,
// SEARCH_ENGINE_SETTING_KEY, DEFAULT_SEARCH_ENGINE)
// Acceptance: specs/browser-polish.feature.md (History view, New-tab page, Search engines)
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SEARCH_ENGINE, HISTORY_PAGE_SIZE, JUMP_BACK_IN_MOST_VISITED, JUMP_BACK_IN_RECENT, SEARCH_ENGINE_SETTING_KEY } from '@app/specs/browser-polish.spec';
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
});
