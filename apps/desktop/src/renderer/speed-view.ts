import { rankFindings, type Finding, type NavigationPhase, type NavigationReport, type SeoAudit, type SpeedReport, type SpeedResponse, type SpeedSummary, type VitalReading } from '@app/seo-core';
import { INP_HINT, SNAPSHOT_PERFORMANCE_RULES, VITAL_THRESHOLDS, type VitalMetric } from '@app/specs/seo-speed.spec';
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
export function missingVitalText(reading: VitalReading, summary: Pick<SpeedSummary, 'loadedHidden'>): string | null {
  if (reading.value !== null) return null;
  if (reading.metric === 'inp') return INP_HINT;
  if (summary.loadedHidden && (reading.metric === 'lcp' || reading.metric === 'fcp' || reading.metric === 'cls')) return 'Loaded in a background tab: re-measure to see it';
  return 'Not reported yet';
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
 * before it, the last milestone or phase), at least 0.8 wide so a 1 ms phase still shows; and the
 * DOMContentLoaded and load markers.
 */
export function waterfall(nav: NavigationReport): { readonly end: number; readonly bars: readonly WaterfallBar[]; readonly markers: readonly WaterfallMarker[] } {
  const end = Math.max(nav.load ?? 0, nav.domContentLoaded ?? 0, ...nav.spans.map((s) => s.end), 1);
  const bars = nav.spans.map((s) => {
    const x = Math.min(99.2, pct(s.start, end));
    return { phase: s.phase, x, width: Math.min(100 - x, Math.max(0.8, pct(s.end - s.start, end))) };
  });
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
