import type { GscPerformanceRow } from '@app/specs/gsc.schema';
import { GSC_CHART, GSC_LOWER_IS_BETTER, GSC_METRIC_LABELS, GSC_PANEL_TEXT, GSC_RATE_HIGHLIGHT_MIN_IMPRESSIONS, type GscPanelMetric } from '@app/specs/gsc-panel.spec';
import type { GscDateRange } from '@app/specs/gsc.spec';
import { formatCompact, formatCount, formatDay, formatMetric, lastAnsweredDay, shortDay } from './gsc-view';

// The Search Console panel's line chart as numbers (Phase 4 Task 10; acceptance `gsc-panel.feature.md`,
// Chart). Pure: a performance answer's rows become the points, line segments, dots, ticks and the
// accessible summary the panel draws as SVG attributes (never `style=`: strict CSP). Google omits a
// day without impressions, so clicks and impressions count a missing day up to the last answered day
// as 0; after it there is no data yet (the line ends there). CTR and position have no value on a
// missing day, so their line breaks. Position is "lower is better": its axis is inverted, the best
// position at the top.

export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly padTop: number;
  readonly padRight: number;
  readonly padBottom: number;
  readonly padLeft: number;
  readonly maxYTicks: number;
  readonly xTicks: number;
}

export interface ChartPoint {
  readonly date: string;
  /** `null`: no value that day (CTR or position on an unanswered day). */
  readonly value: number | null;
  readonly x: number;
  /** `null` with `value`. */
  readonly y: number | null;
}

export interface ChartTick {
  readonly value: number;
  readonly label: string;
  /** Its y (value ticks) or x (date ticks) in user units. */
  readonly pos: number;
}

export interface ChartModel {
  readonly metric: GscPanelMetric;
  readonly inverted: boolean;
  /** No answered day: nothing to draw but the axes. */
  readonly empty: boolean;
  /** The last answered day (`null`: none); the days after it have no value. */
  readonly lastDate: string | null;
  /** One per day of the range, in order. */
  readonly points: readonly ChartPoint[];
  /** `d` of each run of two or more consecutive values. */
  readonly segments: readonly string[];
  /** Values with no neighbour on either side (drawn as dots). */
  readonly dots: readonly { readonly date: string; readonly value: number; readonly x: number; readonly y: number }[];
  readonly yTicks: readonly ChartTick[];
  readonly xTicks: readonly ChartTick[];
  /** The `aria-label`: metric, range, total or average, best day. */
  readonly summary: string;
}

const DAY_MS = 86_400_000;
const NICE_STEPS = [1, 2, 5, 10] as const;

/** Every date of `range`, both ends included (`YYYY-MM-DD`, UTC). */
export function rangeDays(range: GscDateRange): string[] {
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  const days: string[] = [];
  for (let at = start; at <= end && days.length <= 366; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** `value` rounded to `step`'s decimals (no floating-point tails such as `0.30000000000000004`). */
function tidy(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(decimals));
}

/**
 * At most `maxTicks` evenly spaced "nice" ticks (1, 2 or 5 × 10ⁿ apart) from at or below `min` to at
 * or above `max`, at least `minStep` apart (`1` for counts: no half clicks). A flat range is widened
 * (`0…0` becomes `0…1`).
 */
export function niceTicks(min: number, max: number, maxTicks: number, minStep = 0): number[] {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi - lo === 0) {
    if (hi === 0) hi = 1;
    else {
      const pad = Math.abs(hi) * 0.1 || 1;
      lo -= pad;
      hi += pad;
      if (min >= 0 && lo < 0) lo = 0;
    }
  }
  const count = Math.max(2, maxTicks);
  const raw = Math.max((hi - lo) / (count - 1), minStep);
  let magnitude = 10 ** Math.floor(Math.log10(raw));
  let index = NICE_STEPS.findIndex((n) => raw / magnitude <= n + 1e-9);
  for (;;) {
    const step = NICE_STEPS[index]! * magnitude;
    const first = Math.floor(lo / step + 1e-9) * step;
    const last = Math.ceil(hi / step - 1e-9) * step;
    const n = Math.round((last - first) / step) + 1;
    if (n <= count) return Array.from({ length: n }, (_, i) => tidy(first + i * step, step));
    index++;
    if (index >= NICE_STEPS.length) {
      index = 1; // 10 × m is 1 × 10m: go on with 2 × 10m.
      magnitude *= 10;
    }
  }
}

/** A linear map from `[d0, d1]` to `[r0, r1]` (a flat domain maps to the middle). */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** How many decimals tell ticks `step` apart (`0.05` → 2, `0.5` → 1, `5` → 0). */
const decimalsFor = (step: number): number => (step > 0 ? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) : 0);

/**
 * A value tick's label, with as many decimals as ticks `step` apart need (so no two read alike):
 * compact counts, percentages for CTR (two decimals below 1%, as the tiles), positions.
 */
export function tickLabel(metric: GscPanelMetric, value: number, step: number): string {
  if (metric === 'ctr') {
    const pct = value * 100;
    const decimals = decimalsFor(step * 100);
    if (pct === 0) return '0%';
    return pct < 1 ? `${pct.toFixed(Math.max(2, decimals))}%` : `${Number(pct.toFixed(decimals))}%`;
  }
  if (metric === 'position') return String(Number(value.toFixed(decimalsFor(step))));
  return formatCompact(value);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Each day's value of `metric`: a row's value; for clicks and impressions a missing day up to `last`
 * (Google omits days without impressions) is 0; every other missing day is `null` (no data yet after
 * `last`; CTR and position have no value without impressions).
 */
function series(rows: readonly GscPerformanceRow[], metric: GscPanelMetric, days: readonly string[], last: string | null): (number | null)[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const counts = metric === 'clicks' || metric === 'impressions';
  return days.map((date) => {
    const row = byDate.get(date);
    if (row) return row[metric];
    return counts && last !== null && date <= last ? 0 : null;
  });
}

/** The range's own figure: the total (counts), clicks / impressions (CTR) or the impression-weighted position. */
function overall(rows: readonly GscPerformanceRow[], metric: GscPanelMetric): number | null {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  if (metric === 'clicks') return clicks;
  if (metric === 'impressions') return impressions;
  if (impressions === 0) return null;
  if (metric === 'ctr') return clicks / impressions;
  return rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions;
}

function summaryOf(metric: GscPanelMetric, range: GscDateRange, rows: readonly GscPerformanceRow[], last: string | null): string {
  const through = last !== null && last < range.end ? `, data through ${formatDay(last)}` : '';
  const head = `${GSC_METRIC_LABELS[metric]} per day, ${formatDay(range.start)} to ${formatDay(range.end)}${through}`;
  const answered = rows.filter((row) => row.date >= range.start && row.date <= range.end);
  if (answered.length === 0) return `${head}: no data.`;
  const lower = GSC_LOWER_IS_BETTER.includes(metric);
  const rate = metric === 'ctr' || metric === 'position';
  // A rate's best day needs enough impressions to mean something.
  const candidates = rate ? answered.filter((row) => row.impressions >= GSC_RATE_HIGHLIGHT_MIN_IMPRESSIONS) : answered;
  let best = candidates[0] ?? null;
  for (const row of candidates) if (lower ? row[metric] < best![metric] : row[metric] > best![metric]) best = row;
  const figure = overall(answered, metric);
  const total =
    metric === 'clicks' || metric === 'impressions'
      ? `${formatCount(figure ?? 0)} in total`
      : metric === 'ctr'
        ? `${formatMetric('ctr', figure)} overall`
        : `${formatMetric('position', figure)} on average (${GSC_PANEL_TEXT.lowerIsBetter})`;
  if (best === null) return `${head}: ${total}.`;
  const bestWord = metric === 'position' ? 'best' : metric === 'ctr' ? 'highest' : 'most';
  return `${head}: ${total}; ${bestWord} on ${shortDay(best.date)} (${formatMetric(metric, best[metric])}).`;
}

/** The chart of `metric` over `range` from `rows`. */
export function chartModel(rows: readonly GscPerformanceRow[], metric: GscPanelMetric, range: GscDateRange, geometry: ChartGeometry = GSC_CHART): ChartModel {
  const days = rangeDays(range);
  const lastDate = lastAnsweredDay(rows, range);
  const values = series(rows, metric, days, lastDate);
  const empty = lastDate === null;
  const inverted = GSC_LOWER_IS_BETTER.includes(metric);
  const top = geometry.padTop;
  const bottom = geometry.height - geometry.padBottom;
  const left = geometry.padLeft;
  const right = geometry.width - geometry.padRight;

  const present = values.filter((v): v is number => v !== null);
  let ticks: number[];
  if (metric === 'position') {
    const lo = present.length > 0 ? Math.max(1, Math.min(...present)) : 1;
    const hi = present.length > 0 ? Math.max(...present) : 10;
    // Position 1 is the best there is: nice ticks of `position − 1` (from 0), shifted back, are evenly
    // spaced and never above 1.
    ticks = niceTicks(lo - 1, hi - 1, geometry.maxYTicks).map((t) => t + 1);
  } else {
    ticks = niceTicks(0, present.length > 0 ? Math.max(0, ...present) : 0, geometry.maxYTicks, metric === 'ctr' ? 0 : 1);
  }
  const d0 = ticks[0]!;
  const d1 = ticks.at(-1)!;
  // Inverted: the lowest value (best position) at the top.
  const y = inverted ? linearScale(d0, d1, top, bottom) : linearScale(d0, d1, bottom, top);
  const x = days.length <= 1 ? () => (left + right) / 2 : (i: number) => left + (i / (days.length - 1)) * (right - left);

  const points: ChartPoint[] = days.map((date, i) => {
    const value = empty ? null : values[i]!;
    return { date, value, x: x(i), y: value === null ? null : y(value) };
  });

  const segments: string[] = [];
  const dots: { date: string; value: number; x: number; y: number }[] = [];
  let run: ChartPoint[] = [];
  const flush = () => {
    if (run.length >= 2) segments.push(run.map((p, i) => `${i === 0 ? 'M' : 'L'}${round1(p.x)} ${round1(p.y!)}`).join(' '));
    else if (run.length === 1) dots.push({ date: run[0]!.date, value: run[0]!.value!, x: run[0]!.x, y: run[0]!.y! });
    run = [];
  };
  for (const point of points) {
    if (point.value === null) flush();
    else run.push(point);
  }
  flush();

  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
  const yTicks = ticks.map((value) => ({ value, label: tickLabel(metric, value, step), pos: y(value) }));
  const tickCount = Math.min(geometry.xTicks, days.length);
  const xIndexes = tickCount <= 1 ? [0] : [...new Set(Array.from({ length: tickCount }, (_, i) => Math.floor((i * (days.length - 1)) / (tickCount - 1))))];
  const xTicks = days.length === 0 ? [] : xIndexes.map((i) => ({ value: i, label: shortDay(days[i]!), pos: x(i) }));

  return { metric, inverted, empty, lastDate, points, segments, dots, yTicks, xTicks, summary: summaryOf(metric, range, rows, lastDate) };
}
