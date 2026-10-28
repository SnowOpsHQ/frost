// Spec: specs/gsc-panel.spec.ts (GSC_CHART, GSC_LOWER_IS_BETTER, GSC_METRIC_LABELS), specs/gsc.spec.ts (gscDateRange)
// Acceptance: specs/gsc-panel.feature.md (Chart)
import { describe, expect, test } from 'vitest';
import type { GscPerformanceRow } from '@app/specs/gsc.schema';
import { GSC_CHART } from '@app/specs/gsc-panel.spec';
import { gscDateRange } from '@app/specs/gsc.spec';
import { chartModel, niceTicks, rangeDays } from '../gsc-chart';

const NOW = Date.parse('2026-10-28T15:00:00Z');
const RANGE_7 = gscDateRange(7, NOW); // 2026-10-20 … 2026-10-26
const plotTop = GSC_CHART.padTop;
const plotBottom = GSC_CHART.height - GSC_CHART.padBottom;
const plotLeft = GSC_CHART.padLeft;
const plotRight = GSC_CHART.width - GSC_CHART.padRight;

const row = (date: string, clicks: number, impressions: number, position: number): GscPerformanceRow => ({ date, clicks, impressions, ctr: impressions === 0 ? 0 : clicks / impressions, position });

/** Whether `ticks` are evenly `step` apart. */
const evenly = (ticks: readonly number[]) => {
  const step = ticks[1]! - ticks[0]!;
  return ticks.every((t, i) => i === 0 || Math.abs(t - ticks[i - 1]! - step) < 1e-9);
};
const isNiceStep = (step: number) => {
  const mag = 10 ** Math.floor(Math.log10(step));
  return [1, 2, 5, 10].some((n) => Math.abs(step / mag - n) < 1e-9);
};

describe('chart scales, ticks and paths', () => {
  test('chart-nice-ticks', () => {
    for (const [min, max] of [
      [0, 31],
      [0, 30],
      [7, 13],
      [0, 0.137],
      [0, 987_654],
      [2, 3.4],
      [1, 9],
    ] as const) {
      const ticks = niceTicks(min, max, GSC_CHART.maxYTicks);
      expect(ticks.length, `${min}…${max}`).toBeGreaterThanOrEqual(2);
      expect(ticks.length, `${min}…${max}`).toBeLessThanOrEqual(GSC_CHART.maxYTicks);
      expect(ticks[0]!, `${min}…${max}`).toBeLessThanOrEqual(min);
      expect(ticks.at(-1)!, `${min}…${max}`).toBeGreaterThanOrEqual(max);
      expect(evenly(ticks)).toBe(true);
      expect(isNiceStep(ticks[1]! - ticks[0]!), `${min}…${max}: ${ticks.join(',')}`).toBe(true);
    }
    expect(niceTicks(0, 30, 4)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(0, 0.137, 4)).toEqual([0, 0.05, 0.1, 0.15]);
    // A flat zero series still gets an axis; counts never get fractional ticks.
    expect(niceTicks(0, 0, 4, 1)).toEqual([0, 1]);
    expect(niceTicks(0, 3, 4, 1)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0, 2, 4, 1)).toEqual([0, 1, 2]);
    expect(chartModel([row('2026-10-21', 1, 2, 3)], 'clicks', RANGE_7).yTicks.every((t) => Number.isInteger(t.value))).toBe(true);
    // Counts start at zero.
    const clicks = chartModel([row('2026-10-21', 40, 400, 3), row('2026-10-22', 55, 500, 4)], 'clicks', RANGE_7);
    expect(clicks.yTicks[0]!.value).toBe(0);
  });

  test('chart-empty-range', () => {
    const model = chartModel([], 'clicks', RANGE_7);
    expect(model.empty).toBe(true);
    expect(model.segments).toEqual([]);
    expect(model.dots).toEqual([]);
    expect(model.yTicks.map((t) => t.value)).toContain(0);
    expect(model.summary).toMatch(/no data/i);
  });

  test('chart-single-point', () => {
    const model = chartModel([row('2026-10-23', 5, 50, 2)], 'ctr', RANGE_7);
    expect(model.segments).toEqual([]);
    expect(model.dots).toHaveLength(1);
    const days = rangeDays(RANGE_7);
    expect(days).toHaveLength(7);
    const step = (plotRight - plotLeft) / (days.length - 1);
    expect(model.dots[0]!.x).toBeCloseTo(plotLeft + 3 * step, 1);
    expect(model.dots[0]!.date).toBe('2026-10-23');
    expect(model.dots[0]!.y).toBeGreaterThanOrEqual(plotTop);
    expect(model.dots[0]!.y).toBeLessThanOrEqual(plotBottom);
  });

  test('chart-days-filled-and-gaps', () => {
    const rows = [row('2026-10-20', 10, 100, 2), row('2026-10-21', 20, 200, 3), row('2026-10-23', 30, 300, 4), row('2026-10-24', 10, 100, 5)];
    const clicks = chartModel(rows, 'clicks', RANGE_7);
    // One line over all seven days: unanswered days count as no clicks.
    expect(clicks.segments).toHaveLength(1);
    expect(clicks.segments[0]!.match(/[ML]/g)).toHaveLength(7);
    expect(clicks.points.map((p) => p.value)).toEqual([10, 20, 0, 30, 10, 0, 0]);
    // CTR has no value on an unanswered day: the line breaks there.
    const ctr = chartModel(rows, 'ctr', RANGE_7);
    expect(ctr.points.map((p) => p.value)).toEqual([0.1, 0.1, null, 0.1, 0.1, null, null]);
    expect(ctr.segments).toHaveLength(2);
    expect(ctr.dots).toEqual([]);
  });

  test('chart-position-inverted', () => {
    const rows = [row('2026-10-20', 10, 100, 1.5), row('2026-10-21', 10, 100, 8.2), row('2026-10-22', 10, 100, 4)];
    const model = chartModel(rows, 'position', RANGE_7);
    expect(model.inverted).toBe(true);
    const [best, worst] = [model.points[0]!, model.points[1]!];
    // The best (lowest) position is drawn higher up (a smaller y).
    expect(best.y!).toBeLessThan(worst.y!);
    // Ticks run top to bottom from the best position; none is below position 1.
    expect(model.yTicks.every((t) => t.value >= 1)).toBe(true);
    const top = model.yTicks.reduce((a, b) => (a.pos < b.pos ? a : b));
    const bottom = model.yTicks.reduce((a, b) => (a.pos > b.pos ? a : b));
    expect(top.value).toBeLessThan(bottom.value);
    expect(top.pos).toBeCloseTo(plotTop, 5);
    // Clicks are not inverted.
    const clicks = chartModel(rows, 'clicks', RANGE_7);
    expect(clicks.inverted).toBe(false);
    expect(clicks.yTicks.find((t) => t.value === 0)!.pos).toBeCloseTo(plotBottom, 5);
  });

  test('chart-large-numbers', () => {
    const rows = [row('2026-10-20', 1_200_000, 40_000_000, 3), row('2026-10-21', 2_750_000, 55_000_000, 3)];
    const model = chartModel(rows, 'impressions', RANGE_7);
    expect(model.yTicks.map((t) => t.label)).toEqual(expect.arrayContaining(['0']));
    expect(model.yTicks.some((t) => /^\d+(\.\d)?M$/.test(t.label))).toBe(true);
    for (const point of model.points) {
      expect(point.y!).toBeGreaterThanOrEqual(plotTop - 1e-9);
      expect(point.y!).toBeLessThanOrEqual(plotBottom + 1e-9);
      expect(point.x).toBeGreaterThanOrEqual(plotLeft);
      expect(point.x).toBeLessThanOrEqual(plotRight);
    }
    // Thousands are compact too.
    expect(chartModel([row('2026-10-20', 1_500, 30_000, 3)], 'clicks', RANGE_7).yTicks.some((t) => /K$/.test(t.label))).toBe(true);
  });

  test('chart-ctr-percent-ticks', () => {
    const model = chartModel([row('2026-10-20', 10, 100, 2), row('2026-10-21', 3, 100, 2)], 'ctr', RANGE_7);
    expect(model.yTicks.every((t) => t.label.endsWith('%'))).toBe(true);
    expect(model.yTicks.map((t) => t.label)).toContain('0%');
  });

  test('chart-x-ticks', () => {
    const model = chartModel([row('2026-10-20', 1, 10, 2)], 'clicks', gscDateRange(28, NOW));
    expect(model.xTicks).toHaveLength(GSC_CHART.xTicks);
    expect(model.xTicks.map((t) => t.label)).toEqual(['Sep 29', 'Oct 12', 'Oct 26']);
    expect(model.xTicks[0]!.pos).toBeCloseTo(plotLeft, 5);
    expect(model.xTicks.at(-1)!.pos).toBeCloseTo(plotRight, 5);
  });

  test('chart-summary', () => {
    const rows = [row('2026-10-20', 10, 100, 2), row('2026-10-21', 30, 200, 3), row('2026-10-22', 20, 300, 4)];
    const clicks = chartModel(rows, 'clicks', RANGE_7).summary;
    expect(clicks).toContain('Clicks');
    expect(clicks).toContain('Oct 20, 2026');
    expect(clicks).toContain('Oct 26, 2026');
    expect(clicks).toContain('60 in total');
    expect(clicks).toContain('Oct 21 (30)');
    const position = chartModel(rows, 'position', RANGE_7).summary;
    expect(position).toContain('Average position');
    // Impression-weighted: (2·100 + 3·200 + 4·300) / 600.
    expect(position).toContain('3.3 on average');
    expect(position).toMatch(/lower is better/);
    expect(position).toContain('Oct 20 (2.0)');
    const ctr = chartModel(rows, 'ctr', RANGE_7).summary;
    expect(ctr).toContain('10.0% overall');
    expect(ctr).toContain('Oct 21 (15.0%)');
  });
});
