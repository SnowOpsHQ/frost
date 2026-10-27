// Spec: specs/devtools.spec.ts (DEVTOOLS_HEIGHT, DEVTOOLS_TABS, DEVTOOLS_DEFAULT_OPEN, NETWORK_SEARCH_MAX_CHARS, ISSUE_SORT_KEYS,
// ISSUE_FALLBACK_PANEL), specs/seo-sidebar.spec.ts (SEO_PANELS)
// Acceptance: specs/devtools.feature.md (Chrome helpers)
import { describe, expect, test } from 'vitest';
import { DEFAULT_DEVTOOLS_TAB, DEVTOOLS_DEFAULT_OPEN, DEVTOOLS_HEIGHT, ISSUE_FALLBACK_PANEL, NETWORK_SEARCH_MAX_CHARS, type NetworkEntry } from '@app/specs/devtools.spec';
import { SEO_CATEGORIES } from '@app/specs/seo-rules.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import {
  clampHeight,
  filterNetwork,
  formatBytes,
  formatDuration,
  formatExpiry,
  heightAfterKey,
  heightFromStorage,
  isFailed,
  NO_NETWORK_FILTER,
  openFromStorage,
  panelForCategory,
  shortName,
  sortIssues,
  statusLabel,
  tabFromStorage,
  waterfall,
  WATERFALL_MIN_WIDTH,
  WATERFALL_WIDTH,
} from '../devtools-view';

type Row = Pick<NetworkEntry, 'key' | 'type' | 'thirdParty' | 'state' | 'status' | 'url' | 'method' | 'startedAt' | 'durationMs'>;
const row = (over: Partial<Row>): Row => ({ key: 1, type: 'script', thirdParty: false, state: 'done', status: 200, url: 'https://www.example.com/app.js', method: 'GET', startedAt: 0, durationMs: 10, ...over });

describe('devtools drawer helpers', () => {
  test('drawer-height-clamped', () => {
    expect(heightFromStorage(null)).toBe(DEVTOOLS_HEIGHT.default);
    expect(heightFromStorage('abc')).toBe(DEVTOOLS_HEIGHT.default);
    expect(heightFromStorage('-5')).toBe(DEVTOOLS_HEIGHT.default);
    expect(heightFromStorage('12.5')).toBe(DEVTOOLS_HEIGHT.default);
    expect(heightFromStorage('10')).toBe(DEVTOOLS_HEIGHT.min);
    expect(heightFromStorage('333')).toBe(333);
    const column = 800;
    const max = column - DEVTOOLS_HEIGHT.pageMinVisible;
    expect(clampHeight(5000, column)).toBe(max);
    expect(clampHeight(10, column)).toBe(DEVTOOLS_HEIGHT.min);
    expect(clampHeight(300.4, column)).toBe(300);
    expect(clampHeight(Number.NaN, column)).toBe(DEVTOOLS_HEIGHT.default);
    // Not laid out yet: only the floor applies; a tiny column never goes below the floor.
    expect(clampHeight(5000, 0)).toBe(5000);
    expect(clampHeight(500, 200)).toBe(DEVTOOLS_HEIGHT.min);
    // Keys on the resize edge.
    expect(heightAfterKey(300, 'ArrowUp', column)).toBe(300 + DEVTOOLS_HEIGHT.keyboardStep);
    expect(heightAfterKey(300, 'ArrowDown', column)).toBe(300 - DEVTOOLS_HEIGHT.keyboardStep);
    expect(heightAfterKey(300, 'PageUp', column)).toBe(300 + 4 * DEVTOOLS_HEIGHT.keyboardStep);
    expect(heightAfterKey(300, 'PageDown', column)).toBe(300 - 4 * DEVTOOLS_HEIGHT.keyboardStep);
    expect(heightAfterKey(300, 'Home', column)).toBe(DEVTOOLS_HEIGHT.min);
    expect(heightAfterKey(300, 'End', column)).toBe(max);
    expect(heightAfterKey(DEVTOOLS_HEIGHT.min, 'ArrowDown', column)).toBe(DEVTOOLS_HEIGHT.min);
    expect(heightAfterKey(300, 'a', column)).toBeNull();
  });

  test('drawer-state-from-storage', () => {
    expect(openFromStorage('1')).toBe(true);
    expect(openFromStorage('0')).toBe(false);
    expect(openFromStorage(null)).toBe(DEVTOOLS_DEFAULT_OPEN);
    expect(openFromStorage('yes')).toBe(DEVTOOLS_DEFAULT_OPEN);
    expect(tabFromStorage('console')).toBe('console');
    expect(tabFromStorage('elements')).toBe(DEFAULT_DEVTOOLS_TAB);
    expect(tabFromStorage(null)).toBe(DEFAULT_DEVTOOLS_TAB);
  });

  test('network-filters', () => {
    const rows = [
      row({ key: 1, type: 'document', url: 'https://www.example.com/' }),
      row({ key: 2, type: 'script', thirdParty: true, url: 'https://cdn.other.net/Lib.js' }),
      row({ key: 3, type: 'image', status: 404, url: 'https://www.example.com/missing.png' }),
      row({ key: 4, type: 'fetch', state: 'failed', status: null, url: 'https://api.other.net/x', method: 'POST' }),
      row({ key: 5, type: 'stylesheet', status: 304, url: 'https://www.example.com/site.css' }),
    ];
    const keys = (filter: Partial<typeof NO_NETWORK_FILTER>) => filterNetwork(rows, { ...NO_NETWORK_FILTER, ...filter }).map((r) => r.key);
    expect(keys({})).toEqual([1, 2, 3, 4, 5]);
    expect(keys({ type: 'script' })).toEqual([2]);
    expect(keys({ type: 'font' })).toEqual([]);
    expect(keys({ thirdParty: true })).toEqual([2]);
    expect(keys({ failed: true })).toEqual([3, 4]);
    expect(keys({ search: 'LIB' })).toEqual([2]);
    expect(keys({ search: ' post ' })).toEqual([4]);
    expect(keys({ search: 'other', failed: true })).toEqual([4]);
    expect(keys({ search: `${'x'.repeat(NETWORK_SEARCH_MAX_CHARS)}lib` })).toEqual([]);
    expect([isFailed({ state: 'done', status: 399 }), isFailed({ state: 'done', status: 400 }), isFailed({ state: 'failed', status: null })]).toEqual([false, true, true]);
    expect([statusLabel({ state: 'pending', status: null, error: null }), statusLabel({ state: 'failed', status: null, error: 'x' }), statusLabel({ state: 'done', status: 301, error: null })]).toEqual(['Pending', 'Failed', '301']);
    expect([formatBytes(null), formatBytes(512), formatBytes(2_500), formatBytes(3_200_000)]).toEqual(['—', '512 B', '2.5 kB', '3.2 MB']);
    expect([formatDuration(null), formatDuration(12.4), formatDuration(1_234)]).toEqual(['—', '12 ms', '1.23 s']);
    expect([shortName('https://a.test/x/app.js?v=1'), shortName('https://a.test/'), shortName('not a url')]).toEqual(['app.js?v=1', 'a.test', 'not a url']);
    expect([formatExpiry(null), formatExpiry(Date.UTC(2030, 0, 2, 3, 4))]).toEqual(['Session', '2030-01-02 03:04 UTC']);
  });

  test('waterfall-geometry', () => {
    expect(waterfall([]).size).toBe(0);
    const bars = waterfall([
      { key: 1, startedAt: 1_000, durationMs: 100 },
      { key: 2, startedAt: 1_100, durationMs: 100 },
      { key: 3, startedAt: 1_150, durationMs: 0 },
      { key: 4, startedAt: 1_190, durationMs: null },
    ]);
    expect(bars.get(1)).toEqual({ x: 0, width: WATERFALL_WIDTH / 2 });
    expect(bars.get(2)).toEqual({ x: WATERFALL_WIDTH / 2, width: WATERFALL_WIDTH / 2 });
    // No time: still visible.
    expect(bars.get(3)).toEqual({ x: 750, width: WATERFALL_MIN_WIDTH });
    // Pending: runs to the end.
    expect(bars.get(4)).toEqual({ x: 950, width: 50 });
    for (const bar of bars.values()) expect(bar.x + bar.width).toBeLessThanOrEqual(WATERFALL_WIDTH);
    // One instant request fills the space from its start.
    expect(waterfall([{ key: 9, startedAt: 5, durationMs: 0 }]).get(9)).toEqual({ x: 0, width: WATERFALL_MIN_WIDTH });
  });

  test('issues-sorted', () => {
    const findings = [
      { ruleId: 'b-rule', category: 'links', severity: 'info' },
      { ruleId: 'a-rule', category: 'title', severity: 'warning' },
      { ruleId: 'c-rule', category: 'images', severity: 'error' },
      { ruleId: 'd-rule', category: 'images', severity: 'warning' },
    ] as const;
    const ids = (key: 'severity' | 'rule' | 'category', ascending: boolean) => sortIssues(findings, key, ascending).map((f) => f.ruleId);
    expect(ids('severity', true)).toEqual(['c-rule', 'a-rule', 'd-rule', 'b-rule']);
    expect(ids('severity', false)).toEqual(['b-rule', 'a-rule', 'd-rule', 'c-rule']);
    expect(ids('rule', true)).toEqual(['a-rule', 'b-rule', 'c-rule', 'd-rule']);
    expect(ids('category', true)).toEqual(['c-rule', 'd-rule', 'b-rule', 'a-rule']);
    expect(ids('category', false)).toEqual(['a-rule', 'b-rule', 'c-rule', 'd-rule']);
  });

  test('issue-jumps-to-panel', () => {
    expect(panelForCategory('links')).toBe('links');
    expect(panelForCategory('schema')).toBe('schema');
    expect(panelForCategory('performance')).toBe('speed');
    expect(panelForCategory('security')).toBe('compliance');
    expect(panelForCategory('hreflang')).toBe('indexability');
    // The most specific panel: title rules are Content's (On-Page covers them too).
    expect(panelForCategory('title')).toBe('content');
    expect(panelForCategory('headings')).toBe('on-page');
    expect(panelForCategory('no-such-category')).toBe(ISSUE_FALLBACK_PANEL);
    // Every category lands on a panel that covers it (never Overview).
    for (const category of SEO_CATEGORIES) {
      const panel = SEO_PANELS.find((p) => p.id === panelForCategory(category))!;
      expect(panel.id, category).not.toBe('overview');
      expect(panel.categories as readonly string[], category).toContain(category);
    }
  });
});
