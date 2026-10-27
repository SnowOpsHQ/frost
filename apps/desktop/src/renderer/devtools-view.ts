import {
  DEFAULT_DEVTOOLS_TAB,
  DEVTOOLS_DEFAULT_OPEN,
  DEVTOOLS_HEIGHT,
  DEVTOOLS_TABS,
  ISSUE_FALLBACK_PANEL,
  NETWORK_SEARCH_MAX_CHARS,
  type DevtoolsTabId,
  type IssueSortKey,
  type NetworkEntry,
  type NetworkTypeFilter,
  type RobotsVerdict,
} from '@app/specs/devtools.spec';
import { SEO_PANELS, type SeoPanelId } from '@app/specs/seo-sidebar.spec';

// Pure helpers behind the SEO devtools drawer (spec `devtools.spec.ts`; acceptance
// `devtools.feature.md`, Chrome helpers): the stored state, the height clamp, the Network tab's
// filters and waterfall (SVG user units, never `style=`), the Issues tab's order and panel jumps,
// and formatting. No React, no IPC.

// ---- Stored state and size ---------------------------------------------------------------------

export function openFromStorage(value: string | null): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  return DEVTOOLS_DEFAULT_OPEN;
}

/** The stored height (whole CSS px, at least `DEVTOOLS_HEIGHT.min`), else the default. */
export function heightFromStorage(value: string | null): number {
  if (value === null || !/^\d{1,5}$/.test(value)) return DEVTOOLS_HEIGHT.default;
  return Math.max(DEVTOOLS_HEIGHT.min, Number(value));
}

export function tabFromStorage(value: string | null): DevtoolsTabId {
  return DEVTOOLS_TABS.find((t) => t.id === value)?.id ?? DEFAULT_DEVTOOLS_TAB;
}

/**
 * `height` clamped to `[min, column − pageMinVisible]` (never below `min`), rounded; a `column` of
 * 0 or less (not laid out yet) clamps only from below.
 */
export function clampHeight(height: number, column: number): number {
  const max = column > 0 ? Math.floor(column - DEVTOOLS_HEIGHT.pageMinVisible) : Number.POSITIVE_INFINITY;
  const wanted = Number.isNaN(height) || (height === Number.POSITIVE_INFINITY && max === Number.POSITIVE_INFINITY) ? DEVTOOLS_HEIGHT.default : Math.round(height);
  return Math.max(DEVTOOLS_HEIGHT.min, Math.min(wanted, max));
}

/** The height after a key on the resize edge (Arrow Up grows it), or `null` for any other key. */
export function heightAfterKey(height: number, key: string, column: number): number | null {
  const step = DEVTOOLS_HEIGHT.keyboardStep;
  switch (key) {
    case 'ArrowUp':
      return clampHeight(height + step, column);
    case 'ArrowDown':
      return clampHeight(height - step, column);
    case 'PageUp':
      return clampHeight(height + 4 * step, column);
    case 'PageDown':
      return clampHeight(height - 4 * step, column);
    case 'Home':
      return clampHeight(DEVTOOLS_HEIGHT.min, column);
    case 'End':
      return clampHeight(Number.POSITIVE_INFINITY, column);
    default:
      return null;
  }
}

// ---- Network -----------------------------------------------------------------------------------

export interface NetworkFilter {
  readonly type: NetworkTypeFilter;
  readonly thirdParty: boolean;
  readonly failed: boolean;
  readonly search: string;
}
export const NO_NETWORK_FILTER: NetworkFilter = { type: 'all', thirdParty: false, failed: false, search: '' };

/** A request that failed: a network error, or an answer from 400 up. */
export function isFailed(entry: Pick<NetworkEntry, 'state' | 'status'>): boolean {
  return entry.state === 'failed' || (entry.status !== null && entry.status >= 400);
}

/** The entries `filter` keeps: its type, third-party only, failed only, and the text (in the URL or method, any case), combined. */
export function filterNetwork<T extends Pick<NetworkEntry, 'type' | 'thirdParty' | 'state' | 'status' | 'url' | 'method'>>(entries: readonly T[], filter: NetworkFilter): T[] {
  const needle = filter.search.slice(0, NETWORK_SEARCH_MAX_CHARS).trim().toLowerCase();
  return entries.filter(
    (e) =>
      (filter.type === 'all' || e.type === filter.type) &&
      (!filter.thirdParty || e.thirdParty) &&
      (!filter.failed || isFailed(e)) &&
      (needle === '' || e.url.toLowerCase().includes(needle) || e.method.toLowerCase().includes(needle)),
  );
}

/** The waterfall's SVG user space: `0 … WATERFALL_WIDTH` across. */
export const WATERFALL_WIDTH = 1_000;
/** The narrowest bar drawn (a request that took no time is still seen). */
export const WATERFALL_MIN_WIDTH = 4;

/**
 * Each entry's bar in the waterfall (by key): `x` where it started and `width` how long it took, in
 * proportion to the log's time range (first start to last end). A request still pending runs to the
 * end of the range.
 */
export function waterfall(entries: readonly Pick<NetworkEntry, 'key' | 'startedAt' | 'durationMs'>[]): Map<number, { readonly x: number; readonly width: number }> {
  const bars = new Map<number, { x: number; width: number }>();
  if (entries.length === 0) return bars;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    start = Math.min(start, e.startedAt);
    end = Math.max(end, e.startedAt + (e.durationMs ?? 0));
  }
  const span = Math.max(1, end - start);
  for (const e of entries) {
    const at = (time: number) => Math.round(((time - start) / span) * WATERFALL_WIDTH * 10) / 10;
    const x = Math.min(at(e.startedAt), WATERFALL_WIDTH - WATERFALL_MIN_WIDTH);
    const until = e.durationMs === null ? WATERFALL_WIDTH : at(e.startedAt + e.durationMs);
    bars.set(e.key, { x, width: Math.min(Math.max(WATERFALL_MIN_WIDTH, until - x), WATERFALL_WIDTH - x) });
  }
  return bars;
}

/** A size in bytes as text (`—` unknown). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A duration as text (`—` still pending). */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

/** The status column's text. */
export function statusLabel(entry: Pick<NetworkEntry, 'state' | 'status' | 'error'>): string {
  if (entry.state === 'failed') return entry.status === null ? 'Failed' : String(entry.status);
  if (entry.status === null) return 'Pending';
  return String(entry.status);
}

export const ROBOTS_VERDICT_LABELS: Readonly<Record<RobotsVerdict, string>> = {
  allowed: 'Allowed',
  blocked: 'Blocked',
  unknown: 'Unknown',
  pending: '…',
  'not-checked': '—',
};

/** The last path segment (or host) of a URL, for the Name column; the whole text when it does not parse. */
export function shortName(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((s) => s !== '');
    const last = segments.at(-1);
    return `${last ?? parsed.host}${parsed.search}`;
  } catch {
    return url;
  }
}

// ---- Storage -----------------------------------------------------------------------------------

/** A cookie's expiry as text: `Session`, or the date and time in ISO form (UTC). */
export function formatExpiry(expires: number | null): string {
  if (expires === null) return 'Session';
  const date = new Date(expires);
  return Number.isNaN(date.getTime()) ? '—' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// ---- Issues ------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 0, warning: 1, info: 2 };

/** The findings sorted by `key` (`ascending`: errors first, A to Z), stable; ties keep the audit's order. */
export function sortIssues<T extends { readonly severity: string; readonly ruleId: string; readonly category: string }>(findings: readonly T[], key: IssueSortKey, ascending: boolean): T[] {
  const value = (f: T): number | string => (key === 'severity' ? (SEVERITY_RANK[f.severity] ?? 3) : key === 'rule' ? f.ruleId : f.category);
  const indexed = findings.map((finding, index) => ({ finding, index }));
  indexed.sort((a, b) => {
    const x = value(a.finding);
    const y = value(b.finding);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return (ascending ? order : -order) || a.index - b.index;
  });
  return indexed.map((i) => i.finding);
}

/**
 * The panel an issue opens: the most specific one after Overview that covers its category (the
 * fewest categories; the first in rail order on a tie), else `ISSUE_FALLBACK_PANEL`.
 */
export function panelForCategory(category: string): SeoPanelId {
  let best: (typeof SEO_PANELS)[number] | undefined;
  for (const panel of SEO_PANELS) {
    if (panel.id === 'overview' || !(panel.categories as readonly string[]).includes(category)) continue;
    if (!best || panel.categories.length < best.categories.length) best = panel;
  }
  return best?.id ?? ISSUE_FALLBACK_PANEL;
}
