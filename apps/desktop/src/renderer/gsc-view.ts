// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AccountStatus } from '@app/specs/account-state.schema';
import type { GscPerformanceAnswer, GscPerformanceRow, GscProperty, GscQueriesAnswer, GscQueryRow } from '@app/specs/gsc.schema';
import {
  GSC_LOWER_IS_BETTER,
  GSC_METRIC_LABELS,
  GSC_PANEL_COPY,
  GSC_PANEL_DEFAULTS,
  GSC_PANEL_METRICS,
  GSC_PANEL_TEXT,
  GSC_READING_STATES,
  GSC_REASON_STATES,
  type GscPanelCopy,
  type GscPanelMetric,
  type GscPanelState,
} from '@app/specs/gsc-panel.spec';
import { gscDateRange, type GscDateRange, type GscQueryScope, type GscRangeDays, type GscStatus } from '@app/specs/gsc.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { hostOf } from './security';

// The Search Console panel as a view model (Phase 4 Task 10; spec `gsc-panel.spec.ts`; acceptance
// `gsc-panel.feature.md`, View model). Pure: main's connection (`gsc.watch`), the account's status
// (`account.watch`), the tab's URL, the panel's choices and the answers become what the panel shows,
// and whether (and what) it reads. Nothing is read unless the build is configured, the plan includes
// `search-console`, a Google account is connected and the tab shows a web page.

// ---- Formatting ---------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `n` to one decimal, without a trailing `.0` (`1.5`, `20`). */
const oneDecimal = (n: number): string => String(Number(n.toFixed(1)));

/** A compact count for axis labels: `950`, `1.5K`, `20K`, `1.2M`, `3B`. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${oneDecimal(n / 1e9)}B`;
  if (abs >= 1e6) return `${oneDecimal(n / 1e6)}M`;
  if (abs >= 1e3) return `${oneDecimal(n / 1e3)}K`;
  return oneDecimal(n);
}

/** A total: thousands separators below a million, compact from there (`12,345`, `1.3M`). */
export function formatCount(n: number): string {
  return Math.abs(n) >= 1e6 ? formatCompact(n) : Math.round(n).toLocaleString('en-US');
}

/** A metric's value as the tiles and tables show it (`—` for no position). */
export function formatMetric(metric: GscPanelMetric, value: number | null): string {
  if (value === null) return '—';
  switch (metric) {
    case 'ctr':
      return `${(value * 100).toFixed(1)}%`;
    case 'position':
      return value.toFixed(1);
    default:
      return formatCount(value);
  }
}

const parts = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
};

/** `2026-09-29` → `Sep 29, 2026`. */
export function formatDay(iso: string): string {
  const [y, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** `2026-09-29` → `Sep 29`. */
export function shortDay(iso: string): string {
  const [, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "Search Console data lags about two days; range <start> – <end>." */
export function freshnessNote(range: GscDateRange): string {
  return GSC_PANEL_TEXT.freshness.replace('{start}', formatDay(range.start)).replace('{end}', formatDay(range.end));
}

// ---- The panel's choices ------------------------------------------------------------------------

export interface GscPrefs {
  readonly scope: GscQueryScope;
  readonly days: GscRangeDays;
  readonly metric: GscPanelMetric;
}

export interface GscPrefsStore {
  get(): GscPrefs;
  set(changes: Partial<GscPrefs>): void;
  subscribe(listener: () => void): () => void;
}

/** The panel's scope, range and metric (shared by every tab, held while the chrome runs). */
export function createGscPrefsStore(initial: GscPrefs = GSC_PANEL_DEFAULTS): GscPrefsStore {
  let prefs: GscPrefs = { ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => prefs,
    set(changes) {
      const next = { ...prefs, ...changes };
      if (next.scope === prefs.scope && next.days === prefs.days && next.metric === prefs.metric) return;
      prefs = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The chrome's one store (the panel and the palette's scope actions share it). */
export const gscPrefs = createGscPrefsStore();

// ---- Reading ------------------------------------------------------------------------------------

/** One read: `gsc.performance` and `gsc.topQueries` for `url` (no fragment), `scope` and `days`; `connection` is `gsc.watch`'s version. */
export interface GscRequest {
  readonly url: string;
  readonly scope: GscQueryScope;
  readonly days: GscRangeDays;
  readonly connection: number;
}

export interface GscAnswers {
  readonly performance: GscPerformanceAnswer;
  readonly queries: GscQueriesAnswer;
}

/** `url` without its fragment (main drops it too: the same page). */
export function withoutFragment(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

/** What identifies a read: a new key reads again (the metric is only how it is drawn). */
export function requestKey(request: GscRequest): string {
  return JSON.stringify([withoutFragment(request.url), request.scope, request.days, request.connection]);
}

/** The answers held for `held.key` / `held.attempt`, if they answer the current read; anything older is dropped. */
export function shownAnswers(held: { readonly key: string; readonly attempt: number; readonly answers: GscAnswers } | null, key: string | null, attempt: number): GscAnswers | null {
  return held !== null && key !== null && held.key === key && held.attempt === attempt ? held.answers : null;
}

// ---- States -------------------------------------------------------------------------------------

export interface GscViewInput {
  /** `gsc.watch` (`null` until main answers). */
  readonly gsc: GscStatus | null;
  /** `account.watch`'s status (`null` until main answers). */
  readonly account: AccountStatus | null;
  /** The active tab's URL (`''`: none). */
  readonly url: string;
  readonly prefs: GscPrefs;
  /** The answers to the current read (`null`: none yet, or not reading). */
  readonly answers: GscAnswers | null;
  readonly now: number;
}

export interface GscTile {
  readonly metric: GscPanelMetric;
  readonly label: string;
  readonly value: string;
  /** "lower is better" for position. */
  readonly hint: string | null;
  /** The chart shows this metric. */
  readonly selected: boolean;
}

export type GscQueriesView = { readonly status: 'ok'; readonly rows: readonly GscQueryRow[] } | { readonly status: 'unavailable'; readonly message: string };

export interface GscPanelView {
  readonly state: GscPanelState;
  /** The state's title, words and button (`null` for `loading` and `data`). */
  readonly notice: GscPanelCopy | null;
  /** Whether the scope and range controls show (`GSC_READING_STATES`). */
  readonly controls: boolean;
  /** The property the answer matched (`null` before one). */
  readonly property: GscProperty | null;
  /** The answer's range, else the range a read would cover now. */
  readonly range: GscDateRange;
  /** The freshness note (reading states only). */
  readonly freshness: string | null;
  /** The totals (`data` only). */
  readonly tiles: readonly GscTile[] | null;
  /** The answered days, for the chart (`data` only). */
  readonly rows: readonly GscPerformanceRow[] | null;
  /** The top queries (`data` only). */
  readonly queries: GscQueriesView | null;
}

type GateState = Exclude<GscPanelState, 'no-property' | 'no-data' | 'auth-expired' | 'quota' | 'network' | 'invalid' | 'data'>;

/** The state before anything is read, or `null` when a read can be sent. */
function gate(input: GscViewInput): GateState | null {
  const { gsc } = input;
  if (gsc === null) return 'loading';
  if (!gsc.configured) return 'unconfigured';
  if (!gsc.entitled) return input.account === 'signed-in' ? 'needs-pro' : 'signed-out';
  if (!gsc.connected) return gsc.connecting ? 'connecting' : 'not-connected';
  if (!isWebUrl(input.url)) return 'not-a-web-page';
  return null;
}

/** The read the panel sends now, or `null` (not configured, not entitled, not connected, not a web page). */
export function gscReadRequest(input: GscViewInput): GscRequest | null {
  if (gate(input) !== null || input.gsc === null) return null;
  return { url: withoutFragment(input.url), scope: input.prefs.scope, days: input.prefs.days, connection: input.gsc.version };
}

function copyFor(state: Exclude<GscPanelState, 'loading' | 'data'>, input: GscViewInput): GscPanelCopy {
  const copy = GSC_PANEL_COPY[state];
  const message = copy.message.replace('{host}', hostOf(input.url) || input.url).replace('{days}', String(input.prefs.days));
  return message === copy.message ? copy : { ...copy, message };
}

/** What the panel shows for `input`. */
export function gscPanelView(input: GscViewInput): GscPanelView {
  const blocked = gate(input);
  const answers = blocked === null ? input.answers : null;
  const performance = answers?.performance ?? null;
  let state: GscPanelState;
  if (blocked !== null) state = blocked;
  else if (performance === null) state = 'loading';
  else if (performance.status === 'unavailable') {
    state = performance.reason === 'not-entitled' ? (input.account === 'signed-in' ? 'needs-pro' : 'signed-out') : GSC_REASON_STATES[performance.reason];
  } else state = performance.totals.impressions === 0 ? 'no-data' : 'data';

  const ok = performance?.status === 'ok' ? performance : null;
  const range = ok?.range ?? gscDateRange(input.prefs.days, input.now);
  const controls = GSC_READING_STATES.includes(state);
  let tiles: GscTile[] | null = null;
  let queries: GscQueriesView | null = null;
  if (state === 'data' && ok) {
    tiles = GSC_PANEL_METRICS.map((metric) => ({
      metric,
      label: GSC_METRIC_LABELS[metric],
      value: formatMetric(metric, ok.totals[metric]),
      hint: GSC_LOWER_IS_BETTER.includes(metric) ? GSC_PANEL_TEXT.lowerIsBetter : null,
      selected: metric === input.prefs.metric,
    }));
    const answered = answers!.queries;
    queries = answered.status === 'ok' ? { status: 'ok', rows: answered.rows } : { status: 'unavailable', message: GSC_PANEL_TEXT.queriesUnavailable };
  }
  return {
    state,
    notice: state === 'loading' || state === 'data' ? null : copyFor(state, input),
    controls,
    property: ok?.property ?? null,
    range,
    freshness: controls ? freshnessNote(range) : null,
    tiles,
    rows: state === 'data' && ok ? ok.rows : null,
    queries,
  };
}
