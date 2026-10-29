// Spec: specs/gsc-panel.spec.ts (GSC_PANEL_COPY, GSC_PANEL_TEXT, GSC_READING_STATES, GSC_REASON_STATES, GSC_PANEL_DEFAULTS,
// GSC_SCOPE_LABELS), specs/gsc.spec.ts (gscDateRange, GSC_UNAVAILABLE_REASONS), specs/seo-sidebar.spec.ts (SEO_PANELS)
// Acceptance: specs/gsc-panel.feature.md (View model)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { AccountStatus } from '@app/specs/account-state.schema';
import type { EntitlementStatus } from '@app/specs/entitlements-snapshot.spec';
import type { GscPerformanceAnswer, GscQueriesAnswer } from '@app/specs/gsc.schema';
import { GSC_PANEL_COPY, GSC_PANEL_DEFAULTS, GSC_READING_STATES, GSC_PANEL_STATES } from '@app/specs/gsc-panel.spec';
import { GSC_UNAVAILABLE_REASONS, gscDateRange, type GscStatus } from '@app/specs/gsc.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import {
  createGscPrefsStore,
  formatCount,
  formatDay,
  formatMetric,
  freshnessNote,
  gscPanelView,
  gscReadRequest,
  requestKey,
  shownAnswers,
  type GscAccount,
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

const account = (status: AccountStatus, entitlement: EntitlementStatus = status === 'signed-in' ? 'active' : 'none'): GscAccount => ({ status, entitlement });

function input(changes: Partial<GscViewInput> = {}): GscViewInput {
  return { gsc: status(), account: account('signed-in'), url: URL_A, prefs: GSC_PANEL_DEFAULTS, answers: null, pending: false, now: NOW, ...changes };
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
      // Until both watches answered.
      [{ gsc: null }, 'loading', null],
      [{ account: null }, 'loading', null],
      [{ gsc: status({ entitled: false, connected: false }), account: null }, 'loading', null],
      [{ gsc: status({ configured: false, entitled: false, connected: false }) }, 'unconfigured', null],
      // No account configuration in this build: nobody can sign in, so no "Sign in".
      [{ gsc: status({ entitled: false, connected: false }), account: account('unconfigured') }, 'unconfigured', null],
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-out') }, 'signed-out', 'open-account'],
      [{ gsc: status({ entitled: false, connected: false }), account: account('awaiting-browser') }, 'signed-out', 'open-account'],
      [{ gsc: status({ entitled: false, connected: false }), account: account('confirming') }, 'signed-out', 'open-account'],
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-in') }, 'needs-pro', 'open-account'],
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-in', 'grace') }, 'needs-pro', 'open-account'],
      // Signed in, the plan still being checked.
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-in', 'none') }, 'loading', null],
      // A Pro snapshot that expired or failed verification (main fell back to free).
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-in', 'expired') }, 'plan-expired', 'open-account'],
      [{ gsc: status({ entitled: false, connected: false }), account: account('signed-in', 'invalid') }, 'plan-unconfirmed', 'open-account'],
      // A connection kept from before the plan changed is not read with.
      [{ gsc: status({ entitled: false, connected: true }), account: account('signed-in') }, 'needs-pro', 'open-account'],
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
    // Signed out and free both say Search Console is part of frost Pro.
    const notEntitled = status({ entitled: false, connected: false });
    for (const who of [account('signed-out'), account('signed-in'), account('signed-in', 'expired'), account('signed-in', 'invalid')]) {
      expect(gscPanelView(input({ gsc: notEntitled, account: who })).notice?.title).toBe('Search Console is part of frost Pro');
    }
    expect(gscPanelView(input({ gsc: notEntitled, account: account('signed-out') })).notice?.actionLabel).toBe('Sign in');
    expect(gscPanelView(input({ gsc: notEntitled, account: account('signed-in', 'expired') })).notice?.message).toMatch(/expired/);
    expect(gscPanelView(input({ gsc: notEntitled, account: account('signed-in', 'invalid') })).notice?.message).toMatch(/could not be confirmed/);
    expect(gscPanelView(input({ gsc: status({ connected: false, error: 'auth-expired' }) })).notice?.actionLabel).toBe('Reconnect in Settings');
    // Configured, entitled, connected, a web page: a read (fragment dropped), loading until answered.
    expect(gscReadRequest(input({ url: `${URL_A}#top` }))).toEqual({ url: URL_A, scope: 'page', days: 28, connection: 3 });
    expect(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, scope: 'property', days: 90 } }))).toEqual({ url: URL_A, scope: 'property', days: 90, connection: 3 });
    const loading = gscPanelView(input());
    expect(loading.state).toBe('loading');
    expect(loading.notice).toBeNull();
    expect(loading.freshness).toBe(freshnessNote(gscDateRange(28, NOW)));
  });

  test('answer-states', () => {
    const view = (answers: GscAnswers, who: AccountStatus = 'signed-in') => gscPanelView(input({ answers, account: account(who) }));
    for (const reason of GSC_UNAVAILABLE_REASONS) {
      const result = view({ performance: unavailable(reason), queries: unavailable(reason) });
      expect(GSC_PANEL_STATES).toContain(result.state);
      expect(result.notice, reason).not.toBeNull();
      expect(result.tiles, reason).toBeNull();
    }
    expect(view({ performance: unavailable('not-entitled'), queries: unavailable('not-entitled') }).state).toBe('needs-pro');
    expect(view({ performance: unavailable('not-entitled'), queries: unavailable('not-entitled') }, 'signed-out').state).toBe('signed-out');
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
    expect(requestKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, days: 7 } }))!)).not.toBe(requestKey(base));
    expect(requestKey(gscReadRequest(input({ gsc: status({ version: 4 }) }))!)).not.toBe(requestKey(base));
    // The chart's metric is not part of the read.
    expect(requestKey(gscReadRequest(input({ prefs: { ...GSC_PANEL_DEFAULTS, metric: 'position' } }))!)).toBe(requestKey(base));
  });

  test('stale-answer-ignored', () => {
    const answers: GscAnswers = { performance: performance(60, 600), queries: queries() };
    const request: GscRequest = { url: URL_A, scope: 'page', days: 28, connection: 3 };
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
    const prefs = { ...GSC_PANEL_DEFAULTS, days: 7 as const, metric: 'impressions' as const };
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
    store.set({ days: 90, metric: 'position' });
    expect(store.get()).toEqual({ scope: 'property', days: 90, metric: 'position' });
    unsubscribe();
    store.set({ days: 7 });
    expect(listener).toHaveBeenCalledTimes(2);
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
