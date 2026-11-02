// Spec: specs/gsc-panel.spec.ts (GSC_PANEL_COPY, GSC_PANEL_TEXT, GSC_READING_STATES, GSC_REASON_STATES, GSC_PANEL_DEFAULTS,
// GSC_SCOPE_LABELS, GSC_RANGE_PRESETS, gscPresetRange, GSC_FILTER_TEXT, GSC_RANGE_TEXT), specs/gsc.spec.ts (gscDateRange,
// gscRetentionStart, gscCustomRange, GSC_COUNTRY_ALPHA3, GSC_UNAVAILABLE_REASONS), specs/seo-sidebar.spec.ts (SEO_PANELS)
// specs/entitlements-snapshot.spec.ts (UNGATED_FEATURES: no account or plan states, 2026-10-29)
// Acceptance: specs/gsc-panel.feature.md (View model)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { GscCountriesAnswer, GscPerformanceAnswer, GscQueriesAnswer } from '@app/specs/gsc.schema';
import {
  GSC_FILTER_TEXT,
  GSC_PANEL_ACTIONS,
  GSC_PANEL_COPY,
  GSC_PANEL_DEFAULTS,
  GSC_RANGE_MONTHS,
  GSC_RANGE_PRESETS,
  GSC_READING_STATES,
  GSC_PANEL_STATES,
  gscPresetRange,
  type GscMonthPreset,
} from '@app/specs/gsc-panel.spec';
import { GSC_MAX_RANGE_DAYS, GSC_UNAVAILABLE_REASONS, gscCustomRange, gscDateRange, gscRangeDays, gscRetentionStart, type GscStatus } from '@app/specs/gsc.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import {
  countriesKey,
  countryName,
  countryOptions,
  createGscPrefsStore,
  formatCount,
  formatDay,
  formatMetric,
  freshnessNote,
  gscCalendarBounds,
  gscCountriesQuery,
  gscPanelView,
  gscQuery,
  gscReadRequest,
  orderedRange,
  requestKey,
  shownAnswers,
  type GscAnswers,
  type GscRequest,
  type GscViewInput,
} from '../gsc-view';
import { railStatuses } from '../seo-view';

const NOW = Date.parse('2026-10-28T15:00:00Z');
const URL_A = 'https://www.example.com/blog/post';
const PROPERTY = { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' } as const;

const status = (changes: Partial<GscStatus> = {}): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 3, ...changes });

function performance(clicks: number, impressions: number, scope: 'page' | 'property' = 'page', days = 28): GscPerformanceAnswer {
  const range = gscDateRange(days, NOW);
  const rows = impressions === 0 ? [] : [{ date: range.start, clicks, impressions, ctr: clicks / impressions, position: 3.25 }];
  return { status: 'ok', property: PROPERTY, scope, range, rows, totals: { clicks, impressions, ctr: impressions === 0 ? 0 : clicks / impressions, position: impressions === 0 ? null : 3.25 } };
}
const queries = (count = 2): GscQueriesAnswer => ({
  status: 'ok',
  property: PROPERTY,
  scope: 'page',
  range: gscDateRange(28, NOW),
  rows: Array.from({ length: count }, (_, i) => ({ query: `query ${i + 1}`, clicks: 10 - i, impressions: 100, ctr: (10 - i) / 100, position: 1 + i })),
});
const unavailable = (reason: (typeof GSC_UNAVAILABLE_REASONS)[number]) => ({ status: 'unavailable', reason }) as const;

function input(changes: Partial<GscViewInput> = {}): GscViewInput {
  return { gsc: status(), url: URL_A, prefs: GSC_PANEL_DEFAULTS, answers: null, pending: false, now: NOW, ...changes };
}

describe('Search Console panel view model', () => {
  test('format-metrics', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatCount(999_999)).toBe('999,999');
    expect(formatCount(1_250_000)).toBe('1.3M');
    expect(formatCount(3_000_000_000)).toBe('3B');
    expect(formatMetric('clicks', 1_234)).toBe('1,234');
    expect(formatMetric('impressions', 0)).toBe('0');
    expect(formatMetric('ctr', 0.1)).toBe('10.0%');
    expect(formatMetric('ctr', 0.0345)).toBe('3.5%');
    // Below 1%: two decimals.
    expect(formatMetric('ctr', 0.0034)).toBe('0.34%');
    expect(formatMetric('ctr', 0.0099)).toBe('0.99%');
    expect(formatMetric('ctr', 0)).toBe('0%');
    expect(formatMetric('position', 3.256)).toBe('3.3');
    expect(formatMetric('position', 1)).toBe('1.0');
    expect(formatMetric('position', null)).toBe('—');
  });

  test('format-freshness', () => {
    expect(formatDay('2026-09-29')).toBe('Sep 29, 2026');
    expect(formatDay('2027-01-01')).toBe('Jan 1, 2027');
    const range = gscDateRange(28, NOW);
    expect(freshnessNote(range)).toBe('Search Console data lags about two days; range Sep 29, 2026 – Oct 26, 2026.');
    expect(freshnessNote(range, range.end)).toBe('Search Console data lags about two days; range Sep 29, 2026 – Oct 26, 2026.');
    expect(freshnessNote(range, '2026-10-24')).toBe('Search Console data lags about two days; range Sep 29, 2026 – Oct 26, 2026, data through Oct 24, 2026.');
  });

  test('gate-before-reading', () => {
    const cases: [Partial<GscViewInput>, string, string | null][] = [
      // Until the watch answered.
      [{ gsc: null }, 'loading', null],
      [{ gsc: status({ configured: false, entitled: false, connected: false }) }, 'unconfigured', null],
      [{ gsc: status({ configured: false, connected: false }) }, 'unconfigured', null],
      // No account or plan state: not connected is the connect prompt, whatever `entitled` says.
      [{ gsc: status({ entitled: false, connected: false }) }, 'not-connected', 'open-gsc-settings'],
      [{ gsc: status({ connected: false }) }, 'not-connected', 'open-gsc-settings'],
      [{ gsc: status({ connected: false, connecting: true }) }, 'connecting', 'open-gsc-settings'],
      // Main ended the connection because Google refused it: Reconnect.
      [{ gsc: status({ connected: false, error: 'auth-expired' }) }, 'auth-expired', 'open-gsc-settings'],
      [{ gsc: status({ connected: false, connecting: true, error: 'auth-expired' }) }, 'connecting', 'open-gsc-settings'],
      [{ gsc: status({ connected: false, error: 'cancelled' }) }, 'not-connected', 'open-gsc-settings'],
      [{ url: 'about:blank' }, 'not-a-web-page', null],
      [{ url: '' }, 'not-a-web-page', null],
      [{ url: 'app://app/' }, 'not-a-web-page', null],
    ];
    for (const [changes, state, action] of cases) {
      const view = gscPanelView(input(changes));
      expect(view.state, JSON.stringify(changes)).toBe(state);
      if (state !== 'loading') {
        const copy = GSC_PANEL_COPY[state as keyof typeof GSC_PANEL_COPY];
        expect(view.notice).toEqual(copy);
      }
      expect(view.notice?.action ?? null).toBe(action);
      expect(gscReadRequest(input(changes)), JSON.stringify(changes)).toBeNull();
    }
    // Search Console is free and needs no frost account: no state, word or button is about one.
    expect(GSC_PANEL_STATES).not.toContain('signed-out');
    expect(GSC_PANEL_ACTIONS).toEqual(['open-gsc-settings', 'retry']);
    for (const copy of Object.values(GSC_PANEL_COPY)) expect(`${copy.title} ${copy.message} ${copy.actionLabel ?? ''}`).not.toMatch(/\bPro\b|plan|sign in|account settings/i);
    // `entitled` (always true from main) is not read: connected, it reads.
    expect(gscReadRequest(input({ gsc: status({ entitled: false }) }))).toEqual({ url: URL_A, scope: 'page', days: 28, country: null, device: null, connection: 3 });
    expect(gscPanelView(input({ gsc: status({ connected: false, error: 'auth-expired' }) })).notice?.actionLabel).toBe('Reconnect in Settings');
    // Configured, entitled, connected, a web page: a read (fragment dropped), loading until answered.
    expect(gscReadRequest(input({ url: `${URL_A}#top` }))).toEqual({ url: URL_A, scope: 'page', days: 28, country: null, device: null, connection: 3 });
    expect(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, scope: 'property', range: 90 } }))).toEqual({ url: URL_A, scope: 'property', days: 90, country: null, device: null, connection: 3 });
    const loading = gscPanelView(input());
    expect(loading.state).toBe('loading');
    expect(loading.notice).toBeNull();
    expect(loading.freshness).toBe(freshnessNote(gscDateRange(28, NOW)));
  });

  test('answer-states', () => {
    const view = (answers: GscAnswers) => gscPanelView(input({ answers }));
    for (const reason of GSC_UNAVAILABLE_REASONS) {
      const result = view({ performance: unavailable(reason), queries: unavailable(reason) });
      expect(GSC_PANEL_STATES).toContain(result.state);
      expect(result.notice, reason).not.toBeNull();
      expect(result.tiles, reason).toBeNull();
    }
    // Never sent by main (not gated); if it were: the unconfigured words.
    expect(view({ performance: unavailable('not-entitled'), queries: unavailable('not-entitled') }).state).toBe('unconfigured');
    expect(view({ performance: unavailable('not-connected'), queries: unavailable('not-connected') }).state).toBe('not-connected');
    const noProperty = view({ performance: unavailable('no-property'), queries: unavailable('no-property') });
    expect(noProperty.state).toBe('no-property');
    expect(noProperty.notice?.message).toBe('None of your Search Console properties covers www.example.com.');
    const expired = view({ performance: unavailable('auth-expired'), queries: unavailable('auth-expired') });
    expect(expired).toMatchObject({ state: 'auth-expired', notice: { action: 'open-gsc-settings', actionLabel: 'Reconnect in Settings' } });
    for (const reason of ['quota', 'network', 'invalid'] as const) expect(view({ performance: unavailable(reason), queries: unavailable(reason) }).notice?.action, reason).toBe('retry');

    const empty = view({ performance: performance(0, 0), queries: queries(0) });
    expect(empty.state).toBe('no-data');
    expect(empty.notice?.message).toBe('No search impressions in the last 28 days.');
    expect(empty.tiles).toBeNull();

    const data = view({ performance: performance(60, 600), queries: queries(2) });
    expect(data.state).toBe('data');
    expect(data.notice).toBeNull();
    expect(data.tiles!.map((t) => [t.metric, t.label, t.value])).toEqual([
      ['clicks', 'Clicks', '60'],
      ['impressions', 'Impressions', '600'],
      ['ctr', 'CTR', '10.0%'],
      ['position', 'Average position', '3.3'],
    ]);
    expect(data.tiles!.find((t) => t.metric === 'position')!.hint).toBe('lower is better');
    expect(data.tiles!.find((t) => t.metric === 'clicks')!.selected).toBe(true);
    expect(data.rows).toEqual((performance(60, 600) as Extract<GscPerformanceAnswer, { status: 'ok' }>).rows);
    expect(empty.rows).toBeNull();
    expect(data.queries).toEqual({ status: 'ok', rows: (queries(2) as Extract<GscQueriesAnswer, { status: 'ok' }>).rows });
    // Performance answered but its top queries did not: the data, and a note for the queries.
    const partly = view({ performance: performance(60, 600), queries: unavailable('quota') });
    expect(partly.state).toBe('data');
    expect(partly.queries).toEqual({ status: 'unavailable', message: "Top queries couldn't be read." });
  });

  test('controls-only-when-reading', () => {
    expect([...GSC_READING_STATES].sort()).toEqual(['data', 'invalid', 'loading', 'network', 'no-data', 'quota']);
    const reading = [
      gscPanelView(input()),
      gscPanelView(input({ answers: { performance: performance(60, 600), queries: queries() } })),
      gscPanelView(input({ answers: { performance: performance(0, 0), queries: queries(0) } })),
      gscPanelView(input({ answers: { performance: unavailable('network'), queries: unavailable('network') } })),
    ];
    for (const view of reading) expect(view.controls, view.state).toBe(true);
    const notReading = [
      gscPanelView(input({ gsc: status({ connected: false }) })),
      gscPanelView(input({ url: 'about:blank' })),
      gscPanelView(input({ answers: { performance: unavailable('no-property'), queries: unavailable('no-property') } })),
      gscPanelView(input({ answers: { performance: unavailable('auth-expired'), queries: unavailable('auth-expired') } })),
    ];
    for (const view of notReading) expect(view.controls, view.state).toBe(false);
  });

  test('property-scope-names-site', () => {
    const prefs = { ...GSC_PANEL_DEFAULTS, scope: 'property' as const };
    const view = gscPanelView(input({ prefs, answers: { performance: performance(600, 6000, 'property'), queries: queries() } }));
    expect(view.property).toEqual(PROPERTY);
    expect(view.tiles![0]!.value).toBe('600');
    // Before an answer, no property is named.
    expect(gscPanelView(input({ prefs })).property).toBeNull();
  });

  test('request-key', () => {
    const base = gscReadRequest(input())!;
    expect(requestKey(gscReadRequest(input({ url: `${URL_A}#section` }))!)).toBe(requestKey(base));
    expect(requestKey(gscReadRequest(input({ url: `${URL_A}?page=2` }))!)).not.toBe(requestKey(base));
    expect(requestKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, scope: 'property' } }))!)).not.toBe(requestKey(base));
    expect(requestKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, range: 7 } }))!)).not.toBe(requestKey(base));
    expect(requestKey(gscReadRequest(input({ gsc: status({ version: 4 }) }))!)).not.toBe(requestKey(base));
    // The chart's metric is not part of the read.
    expect(requestKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, metric: 'position' } }))!)).toBe(requestKey(base));
  });

  test('stale-answer-ignored', () => {
    const answers: GscAnswers = { performance: performance(60, 600), queries: queries() };
    const request: GscRequest = { url: URL_A, scope: 'page', days: 28, country: null, device: null, connection: 3 };
    const held = { request, attempt: 0, answers };
    const none = { answers: null, pending: false };
    expect(shownAnswers(held, request, 0)).toEqual({ answers, pending: false });
    expect(shownAnswers(held, { ...request, url: `${URL_A}#top` }, 0)).toEqual({ answers, pending: false });
    // The URL or the connection changed: the old answer is not shown.
    expect(shownAnswers(held, { ...request, url: 'https://www.example.com/other' }, 0)).toEqual(none);
    expect(shownAnswers(held, { ...request, connection: 4 }, 0)).toEqual(none);
    // Another scope or range of the same page: the last data stays, as pending.
    expect(shownAnswers(held, { ...request, scope: 'property' }, 0)).toEqual({ answers, pending: true });
    expect(shownAnswers(held, { ...request, days: 7 }, 0)).toEqual({ answers, pending: true });
    // … but never an earlier failure.
    const failed = { request, attempt: 0, answers: { performance: unavailable('quota'), queries: unavailable('quota') } };
    expect(shownAnswers(failed, { ...request, days: 7 }, 0)).toEqual(none);
    expect(shownAnswers(failed, request, 1)).toEqual(none);
    expect(shownAnswers(null, request, 0)).toEqual(none);
    expect(shownAnswers(held, null, 0)).toEqual(none);
  });

  test('pending-keeps-data', () => {
    // Rows that end before the range does (Google's data lags more than two days).
    const range = gscDateRange(28, NOW);
    const early: GscPerformanceAnswer = { ...(performance(60, 600) as Extract<GscPerformanceAnswer, { status: 'ok' }>), rows: [{ date: '2026-10-20', clicks: 60, impressions: 600, ctr: 0.1, position: 3.25 }] };
    const prefs = { ...GSC_PANEL_DEFAULTS, range: 7 as const, metric: 'impressions' as const };
    const view = gscPanelView(input({ prefs, answers: { performance: early, queries: queries() }, pending: true }));
    expect(view).toMatchObject({ state: 'data', pending: true, controls: true, range });
    expect(view.tiles!.find((t) => t.selected)!.metric).toBe('impressions');
    expect(view.through).toBe('Through Oct 20, 2026');
    expect(view.freshness).toBe(freshnessNote(range, '2026-10-20'));
    // Rows to the range's end: no "through".
    const full = gscPanelView(input({ answers: { performance: performance(60, 600), queries: queries() } }));
    expect(full.pending).toBe(false);
    const fullRange = gscDateRange(28, NOW);
    const toEnd: GscPerformanceAnswer = { ...(performance(60, 600) as Extract<GscPerformanceAnswer, { status: 'ok' }>), rows: [{ date: fullRange.end, clicks: 60, impressions: 600, ctr: 0.1, position: 3.25 }] };
    expect(gscPanelView(input({ answers: { performance: toEnd, queries: queries() } })).through).toBeNull();
    expect(full.through).toBe('Through Sep 29, 2026');
  });

  test('prefs-store', () => {
    const store = createGscPrefsStore();
    expect(store.get()).toEqual(GSC_PANEL_DEFAULTS);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.get();
    store.set({ scope: 'property' });
    expect(store.get()).toEqual({ ...GSC_PANEL_DEFAULTS, scope: 'property' });
    expect(store.get()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    // Setting the same value again changes nothing.
    const same = store.get();
    store.set({ scope: 'property' });
    expect(store.get()).toBe(same);
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ range: 90, metric: 'position' });
    expect(store.get()).toEqual({ ...GSC_PANEL_DEFAULTS, scope: 'property', range: 90, metric: 'position' });
    // A custom range is kept only while the range is custom.
    store.set({ range: 'custom', custom: { start: '2026-08-01', end: '2026-08-31' } });
    expect(store.get()).toMatchObject({ range: 'custom', custom: { start: '2026-08-01', end: '2026-08-31' } });
    expect(listener).toHaveBeenCalledTimes(3);
    store.set({ range: 'custom', custom: { start: '2026-08-01', end: '2026-08-31' } });
    expect(listener).toHaveBeenCalledTimes(3);
    store.set({ range: '3m' });
    expect(store.get()).toMatchObject({ range: '3m', custom: null });
    // `custom` without its dates is not a choice.
    store.set({ range: 'custom' });
    expect(store.get().range).toBe('3m');
    unsubscribe();
    store.set({ range: 7 });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  test('presets-to-ranges', () => {
    expect(GSC_RANGE_PRESETS).toEqual([7, 28, 90, '3m', '6m', '12m', '16m', 'custom']);
    const read = (range: (typeof GSC_RANGE_PRESETS)[number], now = NOW) => gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, range }, now }))!;
    // The day presets read as `days`, as before (main computes the dates).
    for (const days of [7, 28, 90] as const) {
      expect(read(days)).toEqual({ url: URL_A, scope: 'page', days, country: null, device: null, connection: 3 });
      expect(gscQuery(read(days))).toEqual({ url: URL_A, scope: 'page', days });
    }
    // Month presets: calendar months back from the lag day (Oct 26, 2026).
    expect(gscPresetRange('3m', NOW)).toEqual({ start: '2026-07-26', end: '2026-10-26' });
    expect(gscPresetRange('6m', NOW)).toEqual({ start: '2026-04-26', end: '2026-10-26' });
    expect(gscPresetRange('12m', NOW)).toEqual({ start: '2025-10-26', end: '2026-10-26' });
    // 16 months starts where Search Console's data starts (counted from today, Oct 28).
    expect(gscPresetRange('16m', NOW)).toEqual({ start: gscRetentionStart(NOW), end: '2026-10-26' });
    expect(gscRetentionStart(NOW)).toBe('2025-06-28');
    // A shorter month: from May 31, three months back is the last day of February.
    expect(gscPresetRange('3m', Date.parse('2028-06-02T08:00:00Z'))).toEqual({ start: '2028-02-29', end: '2028-05-31' });
    expect(gscPresetRange('3m', Date.parse('2027-06-02T08:00:00Z'))).toEqual({ start: '2027-02-28', end: '2027-05-31' });
    expect(read('3m')).toEqual({ url: URL_A, scope: 'page', range: gscPresetRange('3m', NOW), country: null, device: null, connection: 3 });
    expect(gscQuery(read('16m'))).toEqual({ url: URL_A, scope: 'page', range: gscPresetRange('16m', NOW) });
    // Every month preset is a range main accepts, on every day across two years (2028 is a leap year).
    for (let day = 0; day < 2 * 366; day++) {
      const now = Date.parse('2027-01-01T12:00:00Z') + day * 86_400_000;
      for (const preset of Object.keys(GSC_RANGE_MONTHS) as GscMonthPreset[]) {
        const range = gscPresetRange(preset, now);
        expect(gscCustomRange(range.start, range.end, now), `${preset} ${new Date(now).toISOString()}`).toEqual(range);
        expect(gscRangeDays(range)).toBeLessThanOrEqual(GSC_MAX_RANGE_DAYS);
        expect(gscRangeDays(range)).toBeGreaterThan(GSC_RANGE_MONTHS[preset] * 28);
      }
    }
    // The no-data words name the range.
    const none = { performance: performance(0, 0), queries: queries(0) };
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, range: '6m' }, answers: none })).notice?.message).toBe('No search impressions in the last 6 months.');
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, range: 7 }, answers: none })).notice?.message).toBe('No search impressions in the last 7 days.');
    // Before an answer the range shown is the one a read would cover.
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, range: '12m' } })).range).toEqual(gscPresetRange('12m', NOW));
  });

  test('custom-range-bounds', () => {
    // The calendar offers Search Console's retention to the lag day.
    expect(gscCalendarBounds(NOW)).toEqual({ min: '2025-06-28', max: '2026-10-26' });
    expect(gscCalendarBounds(NOW)).toEqual({ min: gscRetentionStart(NOW), max: gscDateRange(1, NOW).end });
    // Picked backwards: the two swap.
    expect(orderedRange('2026-09-10', '2026-09-01')).toEqual({ start: '2026-09-01', end: '2026-09-10' });
    expect(orderedRange('2026-09-01', '2026-09-01')).toEqual({ start: '2026-09-01', end: '2026-09-01' });
    const custom = { start: '2026-08-01', end: '2026-09-15' };
    const prefs = { ...GSC_PANEL_DEFAULTS, range: 'custom' as const, custom };
    expect(gscReadRequest(input({ prefs }))).toEqual({ url: URL_A, scope: 'page', range: custom, country: null, device: null, connection: 3 });
    // The chrome stayed open for months: the stored range is clamped into what Search Console still holds.
    const later = Date.parse('2027-12-20T10:00:00Z');
    const old = gscReadRequest(input({ prefs: { ...prefs, custom: { start: '2026-07-01', end: '2026-09-15' } }, now: later }))!;
    expect('range' in old && old.range).toEqual({ start: gscRetentionStart(later), end: '2026-09-15' });
    // Wholly before it: each end clamped into the bounds (the first day still held).
    const gone = gscReadRequest(input({ prefs: { ...prefs, custom: { start: '2025-01-01', end: '2025-02-01' } }, now: later }))!;
    expect('range' in gone && gone.range).toEqual({ start: gscRetentionStart(later), end: gscRetentionStart(later) });
    for (const request of [old, gone]) {
      const range = (request as { range: { start: string; end: string } }).range;
      expect(gscCustomRange(range.start, range.end, later)).toEqual(range);
    }
    // The no-data words name the custom range.
    const none = { performance: performance(0, 0), queries: queries(0) };
    expect(gscPanelView(input({ prefs, answers: none })).notice?.message).toBe('No search impressions from Aug 1, 2026 to Sep 15, 2026.');
    expect(gscPanelView(input({ prefs })).range).toEqual(custom);
  });

  test('filters-in-request-key', () => {
    const base = gscReadRequest(input())!;
    const country = gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, country: 'gbr' } }))!;
    const device = gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, device: 'MOBILE' } }))!;
    const both = gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, country: 'gbr', device: 'MOBILE' } }))!;
    expect(new Set([base, country, device, both].map(requestKey)).size).toBe(4);
    expect(gscQuery(base)).toEqual({ url: URL_A, scope: 'page', days: 28 });
    expect('country' in gscQuery(base) || 'device' in gscQuery(base)).toBe(false);
    expect(gscQuery(both)).toEqual({ url: URL_A, scope: 'page', days: 28, country: 'gbr', device: 'MOBILE' });
    // The countries read: same page, scope, range and device, never the country (main ignores it).
    expect(gscCountriesQuery(both)).toEqual({ url: URL_A, scope: 'page', days: 28, device: 'MOBILE' });
    expect(gscCountriesQuery(country)).toEqual({ url: URL_A, scope: 'page', days: 28 });
    expect(countriesKey(country)).toBe(countriesKey(base));
    expect(countriesKey(device)).not.toBe(countriesKey(base));
    expect(countriesKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, range: 7 } }))!)).not.toBe(countriesKey(base));
    // A filter change of the same page keeps the last data shown, as pending.
    const held = { request: base, attempt: 0, answers: { performance: performance(60, 600), queries: queries() } };
    expect(shownAnswers(held, both, 0)).toMatchObject({ pending: true });
    // The store keeps them.
    const store = createGscPrefsStore();
    store.set({ country: 'deu', device: 'TABLET' });
    expect(store.get()).toMatchObject({ country: 'deu', device: 'TABLET' });
  });

  test('clear-filters', () => {
    const store = createGscPrefsStore();
    store.set({ scope: 'property', range: '6m', metric: 'ctr', country: 'fra', device: 'DESKTOP' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearFilters();
    expect(store.get()).toEqual({ ...GSC_PANEL_DEFAULTS, scope: 'property', range: '6m', metric: 'ctr' });
    expect(listener).toHaveBeenCalledTimes(1);
    // Nothing to clear: no change.
    store.clearFilters();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(GSC_FILTER_TEXT).toMatchObject({ clear: 'Clear filters', allCountries: 'All countries', allDevices: 'All devices' });
    // The view says whether a filter is set (the Clear button shows only then).
    expect(gscPanelView(input()).filtered).toBe(false);
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, device: 'MOBILE' } })).filtered).toBe(true);
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, country: 'usa' } })).filtered).toBe(true);
    // With a filter, no data says so.
    const none = { performance: performance(0, 0), queries: queries(0) };
    expect(gscPanelView(input({ prefs: { ...GSC_PANEL_DEFAULTS, country: 'usa' }, answers: none })).notice?.message).toBe('No search impressions in the last 28 days with these filters.');
  });

  test('country-names-from-alpha3', () => {
    expect(countryName('usa')).toBe('United States');
    expect(countryName('gbr')).toBe('United Kingdom');
    expect(countryName('deu')).toBe('Germany');
    // Google answers codes outside ISO 3166-1 (no alpha-2 here): shown as is, in capitals.
    expect(countryName('zzz')).toBe('ZZZ');
    expect(countryName('xkk')).toBe('XKK');
    // No `Intl.DisplayNames` name (or it fails): the code.
    expect(countryName('usa', () => undefined)).toBe('USA');
    expect(
      countryName('usa', () => {
        throw new RangeError('no data');
      }),
    ).toBe('USA');
    // A display name that echoes the code back is no name.
    expect(countryName('usa', (alpha2) => alpha2)).toBe('USA');
    const answer: GscCountriesAnswer = {
      status: 'ok',
      property: PROPERTY,
      range: gscDateRange(28, NOW),
      countries: [
        { country: 'usa', clicks: 40, impressions: 400 },
        { country: 'zzz', clicks: 30, impressions: 300 },
        { country: 'deu', clicks: 20, impressions: 200 },
        { country: 'usa', clicks: 1, impressions: 2 },
      ],
    };
    // Sorted by name, each once.
    expect(countryOptions(answer, null)).toEqual([
      { value: 'deu', label: 'Germany' },
      { value: 'usa', label: 'United States' },
      { value: 'zzz', label: 'ZZZ' },
    ]);
    // The chosen country stays listed when the list lacks it (or is not there).
    expect(countryOptions(answer, 'fra').map((o) => o.value)).toEqual(['fra', 'deu', 'usa', 'zzz']);
    expect(countryOptions(null, 'fra')).toEqual([{ value: 'fra', label: 'France' }]);
    expect(countryOptions({ status: 'unavailable', reason: 'quota' }, null)).toEqual([]);
    // The view carries the options.
    expect(gscPanelView(input({ countries: answer })).countryOptions).toEqual(countryOptions(answer, null));
  });

  test('rail-has-no-dot-without-rules', () => {
    const panel = SEO_PANELS.find((p) => p.id === 'search-console');
    expect(panel).toMatchObject({ label: 'Search Console', available: true });
    expect(panel!.categories).toEqual([]);
    const audit = { url: URL_A, takenAt: 1, findings: [{ category: 'title', severity: 'error' }, { category: 'links', severity: 'warning' }] } as unknown as SeoAudit;
    const response: SeoAuditResponse = { status: 'ready', url: URL_A, audit };
    const statuses = railStatuses(response);
    expect(statuses.overview).toBe('error');
    expect(statuses['search-console']).toBeUndefined();
    expect('search-console' in statuses).toBe(false);
  });
});
