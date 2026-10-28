/**
 * The Search Console performance panel (Phase 4 Task 10; acceptance `gsc-panel.feature.md`). Plain
 * values with no Zod, so the chrome renderer can use them (its strict Trusted Types CSP blocks Zod's
 * eval probe). The data comes from the read API of `gsc.spec.ts` / `gsc.schema.ts` (`gsc.performance`,
 * `gsc.topQueries`), gated on `search-console` (a `pro` feature) in main.
 *
 * Clean-room: frost's own names, words and chart.
 */
import type { GscQueryScope, GscRangeDays, GscUnavailableReason } from './gsc.spec';

/** The metrics a performance answer carries per day, in tile order. */
export const GSC_PANEL_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
export type GscPanelMetric = (typeof GSC_PANEL_METRICS)[number];

export const GSC_METRIC_LABELS: Readonly<Record<GscPanelMetric, string>> = Object.freeze({
  clicks: 'Clicks',
  impressions: 'Impressions',
  ctr: 'CTR',
  position: 'Average position',
});

/** Lower is better for these (the chart's axis is inverted: the best value is at the top). */
export const GSC_LOWER_IS_BETTER: readonly GscPanelMetric[] = Object.freeze(['position']);

export const GSC_SCOPE_LABELS: Readonly<Record<GscQueryScope, string>> = Object.freeze({ page: 'This page', property: 'Whole property' });

/** What the panel shows first: this page, 28 days, clicks. The choice holds while the chrome runs (not persisted). */
export const GSC_PANEL_DEFAULTS: Readonly<{ scope: GscQueryScope; days: GscRangeDays; metric: GscPanelMetric }> = Object.freeze({ scope: 'page', days: 28, metric: 'clicks' });

/**
 * The chart, in SVG user units (scaled to the panel's width by styles; drawn with attributes only,
 * never `style=`). The y axis has at most `maxYTicks` "nice" ticks (1, 2 or 5 × 10ⁿ apart), the x
 * axis `xTicks` dates (first, middle, last).
 */
export const GSC_CHART = Object.freeze({
  width: 320,
  height: 150,
  padTop: 10,
  padRight: 10,
  padBottom: 22,
  padLeft: 38,
  maxYTicks: 4,
  xTicks: 3,
});

/**
 * Why there is nothing to chart, as the panel says it:
 * - `loading`: main has not answered the connection yet, or a read is running;
 * - `unconfigured`: this build has no Search Console client;
 * - `signed-out`: nobody is signed in (Search Console is a Pro feature): Sign in opens Account;
 * - `needs-pro`: signed in on a plan without `search-console`: opens Account;
 * - `not-connected` / `connecting`: no Google account connected yet: Connect opens Settings' Search Console;
 * - `not-a-web-page`: the tab shows no `http(s)` page;
 * - `no-property`: none of the user's verified properties covers the page's host;
 * - `no-data`: the property answered no impressions in the range;
 * - `auth-expired`: Google refused the connection: Reconnect opens Settings' Search Console;
 * - `quota`, `network`, `invalid`: Google's quota, an unreachable Google, or an unreadable answer: Retry;
 * - `data`: totals, chart and top queries.
 */
export const GSC_PANEL_STATES = [
  'loading',
  'unconfigured',
  'signed-out',
  'needs-pro',
  'not-connected',
  'connecting',
  'not-a-web-page',
  'no-property',
  'no-data',
  'auth-expired',
  'quota',
  'network',
  'invalid',
  'data',
] as const;
export type GscPanelState = (typeof GSC_PANEL_STATES)[number];

/** What a state's button does: open Settings on Account or on Search Console, or ask again. */
export const GSC_PANEL_ACTIONS = ['open-account', 'open-gsc-settings', 'retry'] as const;
export type GscPanelAction = (typeof GSC_PANEL_ACTIONS)[number];

/** A state's notice: a title, words, and at most one button (`GSC_PANEL_ACTIONS`) with its label. */
export interface GscPanelCopy {
  readonly title: string;
  /** `{host}` and `{days}` are filled in by the chrome. */
  readonly message: string;
  readonly action: GscPanelAction | null;
  readonly actionLabel: string | null;
}

/** What each state but `loading` and `data` says (frost's own words). */
export const GSC_PANEL_COPY: Readonly<Record<Exclude<GscPanelState, 'loading' | 'data'>, GscPanelCopy>> = Object.freeze({
  unconfigured: { title: 'Search Console unavailable', message: "Search Console isn't configured in this build.", action: null, actionLabel: null },
  'signed-out': {
    title: 'Search Console is part of frost Pro',
    message: 'Sign in with a Pro account to see clicks, impressions and positions for the pages you visit.',
    action: 'open-account',
    actionLabel: 'Sign in',
  },
  'needs-pro': {
    title: 'Search Console is part of frost Pro',
    message: 'Your plan does not include Search Console. Pro adds it, with read-only access to your properties.',
    action: 'open-account',
    actionLabel: 'Account settings',
  },
  'not-connected': {
    title: 'Connect Search Console',
    message: 'Connect a Google account in Settings to see how this page performs in search. frost only asks for read-only access.',
    action: 'open-gsc-settings',
    actionLabel: 'Connect in Settings',
  },
  connecting: { title: 'Connect Search Console', message: 'Finish connecting in your browser.', action: 'open-gsc-settings', actionLabel: 'Open Settings' },
  'not-a-web-page': { title: 'No web page', message: 'Search Console has data for web pages (http and https) only.', action: null, actionLabel: null },
  'no-property': { title: 'No matching property', message: 'None of your Search Console properties covers {host}.', action: null, actionLabel: null },
  'no-data': { title: 'No data in this range', message: 'No search impressions in the last {days} days.', action: null, actionLabel: null },
  'auth-expired': {
    title: 'Reconnect Search Console',
    message: 'Google no longer accepts this connection. Reconnect in Settings.',
    action: 'open-gsc-settings',
    actionLabel: 'Reconnect in Settings',
  },
  quota: { title: 'Usage limit reached', message: "Search Console's usage limit was reached. Try again in a minute.", action: 'retry', actionLabel: 'Try again' },
  network: { title: "Couldn't reach Google", message: "frost couldn't reach Google. Check your connection and try again.", action: 'retry', actionLabel: 'Try again' },
  invalid: { title: 'Unreadable answer', message: "Search Console answered something frost couldn't read.", action: 'retry', actionLabel: 'Try again' },
});

/** The panel's other fixed words (`{start}`, `{end}` filled in by the chrome). */
export const GSC_PANEL_TEXT = Object.freeze({
  loading: 'Reading Search Console…',
  freshness: 'Search Console data lags about two days; range {start} – {end}.',
  queriesUnavailable: "Top queries couldn't be read.",
  noQueries: 'No queries in this range.',
  lowerIsBetter: 'lower is better',
} as const);

/** The states that read (or show what was read): only these show the scope and range controls. */
export const GSC_READING_STATES: readonly GscPanelState[] = Object.freeze(['loading', 'data', 'no-data', 'quota', 'network', 'invalid']);

/** Each `gsc.performance` unavailable reason as a panel state (`not-entitled` is told apart by the account). */
export const GSC_REASON_STATES: Readonly<Record<Exclude<GscUnavailableReason, 'not-entitled'>, GscPanelState>> = Object.freeze({
  unconfigured: 'unconfigured',
  'not-connected': 'not-connected',
  'no-property': 'no-property',
  'auth-expired': 'auth-expired',
  quota: 'quota',
  network: 'network',
  invalid: 'invalid',
  'not-a-web-page': 'not-a-web-page',
});
