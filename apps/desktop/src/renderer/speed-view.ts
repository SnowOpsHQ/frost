import { rankFindings, type Finding, type NavigationPhase, type NavigationReport, type SeoAudit, type SpeedReport, type SpeedResponse, type SpeedSummary, type VitalReading } from '@app/seo-core';
import {
  BUFFER_FULL_NOTE,
  IFRAME_NOTE,
  INP_HINT,
  LOADED_HIDDEN_HINT,
  LOW_RESOURCES_NOTE,
  NAVIGATION_PHASE_MIN_WIDTH,
  SNAPSHOT_PERFORMANCE_RULES,
  SOFT_NAVIGATION_NOTE,
  VITAL_THRESHOLDS,
  WAYLAND_HINT,
  WAYLAND_PAINT_NOTE,
  type VitalMetric,
} from '@app/specs/seo-speed.spec';
import { isWebUrl } from '@app/specs/web-url.spec';

// Pure helpers behind the Speed panel (spec `seo-speed.spec.ts`; acceptance `seo-speed.feature.md`,
// Renderer helpers). Every geometry is in a 0…100 SVG user space: the panel draws bars as SVG
// `<rect>` attributes (never `style=`, which the chrome's CSP forbids).

/** One decimal, at least `min` for a non-zero value (so a tiny value is still visible), at most 100. */
function pct(value: number, scale: number, min = 0): number {
  if (!(scale > 0) || !(value > 0)) return 0;
  return Math.max(min, Math.min(100, Math.round((value / scale) * 1000) / 10));
}

/**
 * A metric card's threshold bar: the scale runs from 0 to 1.5 × the `poor` threshold; the
 * good / needs-improvement / poor zones end at `good` and `poor`; the marker is the value (clamped).
 */
export function meterGeometry(metric: VitalMetric, value: number | null): { readonly good: number; readonly poor: number; readonly marker: number | null } {
  const { good, poor } = VITAL_THRESHOLDS[metric];
  const scale = poor * 1.5;
  return { good: pct(good, scale), poor: pct(poor, scale), marker: value === null ? null : Math.min(100, pct(value, scale)) };
}

/** Why a metric has no value (`null` when it has one). */
export function missingVitalText(reading: VitalReading, summary: Pick<SpeedSummary, 'loadedHidden' | 'paintUnavailable'>): string | null {
  if (reading.value !== null) return null;
  if (reading.metric === 'inp') return INP_HINT;
  const paintMetric = reading.metric === 'lcp' || reading.metric === 'fcp' || reading.metric === 'cls';
  if (summary.loadedHidden && paintMetric) return LOADED_HIDDEN_HINT;
  if (summary.paintUnavailable && paintMetric) return WAYLAND_HINT;
  return 'Not reported yet';
}

export interface SpeedNote {
  readonly id: 'wayland' | 'soft-navigation' | 'low-resources' | 'buffer-full' | 'iframes';
  readonly text: string;
}

/** The panel's notes about the measurement, most important first. */
export function speedNotes(summary: Pick<SpeedSummary, 'softNavigation' | 'paintUnavailable' | 'resourcesLow' | 'bufferFull'>): SpeedNote[] {
  const notes: SpeedNote[] = [];
  if (summary.paintUnavailable) notes.push({ id: 'wayland', text: WAYLAND_PAINT_NOTE });
  if (summary.softNavigation) notes.push({ id: 'soft-navigation', text: SOFT_NAVIGATION_NOTE });
  if (summary.resourcesLow) notes.push({ id: 'low-resources', text: LOW_RESOURCES_NOTE });
  if (summary.bufferFull) notes.push({ id: 'buffer-full', text: BUFFER_FULL_NOTE });
  notes.push({ id: 'iframes', text: IFRAME_NOTE });
  return notes;
}

export const PHASE_LABELS: Readonly<Record<NavigationPhase, string>> = {
  redirect: 'Redirect',
  dns: 'DNS',
  connect: 'Connect',
  tls: 'TLS',
  request: 'Waiting (TTFB)',
  response: 'Download',
};

export interface WaterfallBar {
  readonly phase: NavigationPhase;
  readonly x: number;
  readonly width: number;
}
export interface WaterfallMarker {
  readonly id: 'dcl' | 'load';
  readonly label: string;
  readonly x: number;
  readonly ms: number;
}

/**
 * The navigation timing row: each phase as a bar on one 0…100 axis that ends at the load event (or,
 * before it, the last milestone or phase), and the DOMContentLoaded and load markers. A phase is at least
 * `NAVIGATION_PHASE_MIN_WIDTH` wide, so every phase with a duration shows; the next one starts at its real
 * start or where the one before it is drawn to end, whichever is later (it used to start at its real start
 * and cover a widened phase), and ends at its real end unless it is itself under the minimum. A row pushed
 * past the axis's end is pulled back from there: the last phase ends at 100, each one before it where the
 * next starts.
 */
export function waterfall(nav: NavigationReport): { readonly end: number; readonly bars: readonly WaterfallBar[]; readonly markers: readonly WaterfallMarker[] } {
  const end = Math.max(nav.load ?? 0, nav.domContentLoaded ?? 0, ...nav.spans.map((s) => s.end), 1);
  const min = NAVIGATION_PHASE_MIN_WIDTH;
  const drawn: { phase: NavigationPhase; x: number; right: number }[] = [];
  let cursor = 0;
  for (const s of nav.spans) {
    const x = Math.max(pct(s.start, end), cursor);
    const right = Math.max(pct(s.end, end), x + min);
    drawn.push({ phase: s.phase, x, right });
    cursor = right;
  }
  let limit = 100;
  for (let i = drawn.length - 1; i >= 0; i--) {
    const bar = drawn[i]!;
    bar.right = Math.min(bar.right, limit);
    bar.x = Math.min(bar.x, bar.right - min);
    limit = bar.x;
  }
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const bars = drawn.map((bar) => ({ phase: bar.phase, x: tenth(bar.x), width: tenth(bar.right - bar.x) }));
  const markers: WaterfallMarker[] = [];
  if (nav.domContentLoaded !== null) markers.push({ id: 'dcl', label: 'DOMContentLoaded', x: pct(nav.domContentLoaded, end), ms: nav.domContentLoaded });
  if (nav.load !== null) markers.push({ id: 'load', label: 'Load', x: pct(nav.load, end), ms: nav.load });
  return { end, bars, markers };
}

/** A bar's width (0…100) for `value` of `max`: at least 1 for a non-zero value. */
export function barWidth(value: number, max: number): number {
  return pct(value, max, 1);
}

/** `part` of `whole` as a whole percentage (`0%` for an empty whole; `<1%` for a small non-zero share). */
export function shareText(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return '0%';
  const value = (part / whole) * 100;
  return value < 1 ? '<1%' : `${Math.round(value)}%`;
}

/** What the panel shows: the live report for the tab's current URL, else the audit's (taken with it), else none. */
export function shownSpeed(tabUrl: string, live: SpeedResponse | null, audit: SeoAudit): { readonly report: SpeedReport | null; readonly source: 'live' | 'audit' | null } {
  if (live?.status === 'ready' && live.url === tabUrl) return { report: live.report, source: 'live' };
  if (audit.performance) return { report: audit.performance, source: 'audit' };
  return { report: null, source: null };
}

/**
 * The panel's issues: the report's measured findings and the audit's snapshot ones
 * (`SNAPSHOT_PERFORMANCE_RULES`: render-blocking scripts), ranked like every panel's.
 */
export function speedIssues(report: Pick<SpeedReport, 'findings'> | null, audit: Pick<SeoAudit, 'findings'>): Finding[] {
  const fromSnapshot = audit.findings.filter((f) => (SNAPSHOT_PERFORMANCE_RULES as readonly string[]).includes(f.ruleId));
  return rankFindings([...(report?.findings ?? []), ...fromSnapshot]);
}

/** Whether a resource URL may be offered as "Open in new tab": `http(s)` and not cut (a cut URL is another address). */
export function openableResource(url: string, urlCut: boolean): boolean {
  return !urlCut && isWebUrl(url);
}

/** How long ago `at` was, for the live line (`just now`, `5 s ago`, `2 min ago`). */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}
