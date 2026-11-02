/**
 * The Search Console performance panel (Phase 4 Task 10, Phase 9 Task 3; acceptance
 * `gsc-panel.feature.md`). Plain values with no Zod, so the chrome renderer can use them (its strict
 * Trusted Types CSP blocks Zod's eval probe). The data comes from the read API of `gsc.spec.ts` /
 * `gsc.schema.ts` (`gsc.performance`, `gsc.topQueries`, `gsc.countries`). Search Console is not gated
 * (`UNGATED_FEATURES`): no frost account or plan needed.
 *
 * Clean-room: frost's own names, words, chart and calendar.
 */
import {
  GSC_DEVICES,
  GSC_RANGE_DAYS,
  addUtcMonths,
  gscDateRange,
  gscRetentionStart,
  type GscDateRange,
  type GscDevice,
  type GscQueryScope,
  type GscUnavailableReason,
} from './gsc.spec';

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

// ---- Ranges (Phase 9 Task 3; Decision 5) ---------------------------------------------------------

/** The months of the month presets. */
export const GSC_RANGE_MONTHS = Object.freeze({ '3m': 3, '6m': 6, '12m': 12, '16m': 16 } as const);
export type GscMonthPreset = keyof typeof GSC_RANGE_MONTHS;

/**
 * The panel's range choices: the day presets (`GSC_RANGE_DAYS`, read as `days`, as before), the month
 * presets (read as a `range`, see `gscPresetRange`) and `custom` (a range picked on the calendar).
 */
export const GSC_RANGE_PRESETS = [...GSC_RANGE_DAYS, '3m', '6m', '12m', '16m', 'custom'] as const;
export type GscRangePreset = (typeof GSC_RANGE_PRESETS)[number];

/** Each preset's words (the day presets' buttons say "7 days"; the others are offered in a select). */
export const GSC_RANGE_PRESET_LABELS: Readonly<Record<GscRangePreset, string>> = Object.freeze({
  7: '7 days',
  28: '28 days',
  90: '90 days',
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
  '16m': 'Last 16 months',
  custom: 'Custom range',
});

/**
 * A month preset's range: it ends on the lag day (`gscDateRange(1, nowMs).end`) and starts on the
 * same day of the month that many calendar months before it (that month's last day when it is
 * shorter: from May 31, three months back is Feb 28 or 29), both inclusive. `16m` starts at
 * `gscRetentionStart(nowMs)` instead (the first day Search Console still holds, counted from today),
 * so it always fits `GSC_MAX_RANGE_DAYS`.
 */
export function gscPresetRange(preset: GscMonthPreset, nowMs: number): GscDateRange {
  const end = gscDateRange(1, nowMs).end;
  return { start: preset === '16m' ? gscRetentionStart(nowMs) : addUtcMonths(end, -GSC_RANGE_MONTHS[preset]), end };
}

/**
 * What the panel shows first: this page, 28 days, clicks, no filters. The choices (scope, range,
 * custom dates, metric, country, device) hold while the chrome runs and are shared by every tab (not
 * persisted). `custom` is the picked range, set only while `range` is `custom`.
 */
export const GSC_PANEL_DEFAULTS: Readonly<{
  scope: GscQueryScope;
  range: GscRangePreset;
  custom: GscDateRange | null;
  metric: GscPanelMetric;
  country: string | null;
  device: GscDevice | null;
}> = Object.freeze({ scope: 'page', range: 28, custom: null, metric: 'clicks', country: null, device: null });

/** How a range reads in a sentence (`{n}`, `{start}`, `{end}` filled in by the chrome). */
export const GSC_RANGE_TEXT = Object.freeze({
  lastDays: 'in the last {n} days',
  lastMonths: 'in the last {n} months',
  custom: 'from {start} to {end}',
} as const);

// ---- Filters (Phase 9 Task 3; Decision 5) ---------------------------------------------------------

/**
 * The country and device filters' words. The country select lists only the countries a
 * `gsc.countries` read answered for the page (or property), range and device, named with
 * `Intl.DisplayNames` through `GSC_COUNTRY_ALPHA3`; a code without a name there is shown as is, in
 * capitals (inert text). "Clear filters" shows only while a filter is set and resets both (not the
 * scope or range).
 */
export const GSC_FILTER_TEXT = Object.freeze({
  rangeLabel: 'More date ranges',
  rangeMore: 'More ranges…',
  /** The button that opens the calendar (never a select option: arrowing through a select must not open a dialog). */
  customOption: 'Custom range…',
  /** That button's name once a custom range is set (it then shows the dates). */
  customButton: 'Change dates',
  countryLabel: 'Country',
  deviceLabel: 'Device',
  allCountries: 'All countries',
  allDevices: 'All devices',
  clear: 'Clear filters',
  /** The `no-data` notice while a filter is set (`{range}` from `GSC_RANGE_TEXT`). */
  noDataFiltered: 'No search impressions {range} with these filters.',
} as const);

export const GSC_DEVICE_LABELS: Readonly<Record<GscDevice, string>> = Object.freeze({ DESKTOP: 'Desktop', MOBILE: 'Mobile', TABLET: 'Tablet' });
/** The device select's order. */
export const GSC_DEVICE_ORDER: readonly GscDevice[] = Object.freeze([...GSC_DEVICES]);

// ---- Calendar (Phase 9 Task 3) --------------------------------------------------------------------

/**
 * The custom range's calendar: a dialog popover (WAI-ARIA date picker dialog) with one month's grid.
 * - **Week start** from the locale (`Intl.Locale` week info, `1` Monday … `7` Sunday), else
 *   `fallbackWeekStart` (Monday, ISO 8601).
 * - **Days that can be picked** are `gscRetentionStart(now)` to the lag day (`gscDateRange(1, now).end`);
 *   every other day is shown `aria-disabled` and cannot be picked, and focus stays within them.
 * - **Month navigation**: the previous and next month buttons (disabled past either end), PageUp /
 *   PageDown (a month), Shift+PageUp / Shift+PageDown (a year).
 * - **Keys in the grid** (roving tabindex: one day is tabbable): arrows move a day or a week, Home /
 *   End to the week's first or last day, Enter or Space picks. The first pick is the start, the second
 *   the end (picked before the start: the two swap), which applies the range and closes. Escape
 *   closes without a change. Closing returns focus to what opened it.
 * - Picked days are `aria-selected`.
 */
export const GSC_CALENDAR = Object.freeze({
  fallbackWeekStart: 1,
  /** Weeks a month's grid can need (a 31-day month starting on the week's last day). */
  maxWeeks: 6,
  text: {
    dialogLabel: 'Choose a date range',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    pickStart: 'Choose the first day.',
    pickEnd: 'Choose the last day.',
    cancel: 'Cancel',
  },
} as const);

/**
 * The chart, in SVG user units (scaled to the panel's width by styles; drawn with attributes only,
 * never `style=`). The y axis has at most `maxYTicks` evenly spaced "nice" ticks (1, 2 or 5 × 10ⁿ
 * apart; positions from 1 up), labelled with as many decimals as their step needs (never two alike);
 * the x axis `xTicks` dates (first, middle, last; up to `GSC_MAX_RANGE_DAYS` days, every point inside
 * the plot), labelled by day (`Sep 29`), or by month (`Jul 2025`) for a range over `monthTicksAfterDays`.
 *
 * Which days have a value: Google omits a day without impressions, so for clicks and impressions a
 * day **up to the last answered day** without a row is 0. Days **after** the last answered day have
 * no data yet (Google's final data can lag more than `GSC_DATA_LAG_DAYS`): no value, the line ends
 * there, and the panel says "data through <last day>". CTR and position have no value on any day
 * without a row (their line breaks).
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
  /** A range longer than this many days labels its x ticks with the month (`Jul 2025`), not the day. */
  monthTicksAfterDays: 90,
});

/**
 * The chart's summary names a best day for CTR and position only among days with at least this many
 * impressions (a day with 1 impression and 1 click is not a "100% CTR day"); without one it names none.
 */
export const GSC_RATE_HIGHLIGHT_MIN_IMPRESSIONS = 10;

/**
 * The read waits this long after the URL, scope, range or a filter last changed before it is sent (a page that
 * changes its URL with `pushState` while it loads reads once). Retry is sent at once.
 */
export const GSC_READ_DEBOUNCE_MS = 300;

/**
 * Why there is nothing to chart, as the panel says it:
 * - `loading`: main has not answered the connection yet, or a read is running (a scope or range
 *   change keeps the last data shown, dimmed);
 * - `unconfigured`: this build has no Search Console client (also shown for a `not-entitled` answer,
 *   which main never sends: Search Console is free and needs no frost account, 2026-10-29);
 * - `not-connected` / `connecting`: no Google account connected yet: Connect opens Settings' Search Console;
 * - `not-a-web-page`: the tab shows no `http(s)` page;
 * - `no-property`: none of the user's verified properties covers the page's host;
 * - `no-data`: the property answered no impressions in the range;
 * - `auth-expired`: Google refused the connection (a read answered so, or main ended the connection with
 *   the `auth-expired` error): Reconnect opens Settings' Search Console;
 * - `quota`, `network`, `invalid`: Google's quota, an unreachable Google, or an unreadable answer: Retry;
 * - `data`: totals, chart and top queries.
 */
export const GSC_PANEL_STATES = [
  'loading',
  'unconfigured',
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

/** What a state's button does: open Settings on Search Console, or ask again. */
export const GSC_PANEL_ACTIONS = ['open-gsc-settings', 'retry'] as const;
export type GscPanelAction = (typeof GSC_PANEL_ACTIONS)[number];

/** A state's notice: a title, words, and at most one button (`GSC_PANEL_ACTIONS`) with its label. */
export interface GscPanelCopy {
  readonly title: string;
  /** `{host}` and `{range}` (`GSC_RANGE_TEXT`) are filled in by the chrome. */
  readonly message: string;
  readonly action: GscPanelAction | null;
  readonly actionLabel: string | null;
}

/** What each state but `loading` and `data` says (frost's own words). */
export const GSC_PANEL_COPY: Readonly<Record<Exclude<GscPanelState, 'loading' | 'data'>, GscPanelCopy>> = Object.freeze({
  unconfigured: { title: 'Search Console unavailable', message: "Search Console isn't configured in this build.", action: null, actionLabel: null },
  'not-connected': {
    title: 'Connect Search Console',
    message: 'Connect a Google account in Settings to see how this page performs in search. frost only asks for read-only access.',
    action: 'open-gsc-settings',
    actionLabel: 'Connect in Settings',
  },
  connecting: { title: 'Connect Search Console', message: 'Finish connecting in your browser.', action: 'open-gsc-settings', actionLabel: 'Open Settings' },
  'not-a-web-page': { title: 'No web page', message: 'Search Console has data for web pages (http and https) only.', action: null, actionLabel: null },
  'no-property': { title: 'No matching property', message: 'None of your Search Console properties covers {host}.', action: null, actionLabel: null },
  'no-data': { title: 'No data in this range', message: 'No search impressions {range}.', action: null, actionLabel: null },
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

/** The panel's other fixed words (`{start}`, `{end}`, `{last}` filled in by the chrome). */
export const GSC_PANEL_TEXT = Object.freeze({
  loading: 'Reading Search Console…',
  freshness: 'Search Console data lags about two days; range {start} – {end}.',
  /** When the last answered day is before the range's end. */
  freshnessThrough: 'Search Console data lags about two days; range {start} – {end}, data through {last}.',
  /** Above the totals, when the last answered day is before the range's end. */
  through: 'Through {last}',
  queriesUnavailable: "Top queries couldn't be read.",
  noQueries: 'No queries in this range.',
  lowerIsBetter: 'lower is better',
} as const);

/** The states that read (or show what was read): only these show the scope, range and filter controls. */
export const GSC_READING_STATES: readonly GscPanelState[] = Object.freeze(['loading', 'data', 'no-data', 'quota', 'network', 'invalid']);

/** Each `gsc.performance` unavailable reason as a panel state (`not-entitled`, never sent by main: unconfigured). */
export const GSC_REASON_STATES: Readonly<Record<GscUnavailableReason, GscPanelState>> = Object.freeze({
  unconfigured: 'unconfigured',
  'not-entitled': 'unconfigured',
  'not-connected': 'not-connected',
  'no-property': 'no-property',
  'auth-expired': 'auth-expired',
  quota: 'quota',
  network: 'network',
  invalid: 'invalid',
  'not-a-web-page': 'not-a-web-page',
});
