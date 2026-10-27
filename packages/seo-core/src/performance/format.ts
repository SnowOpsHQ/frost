import type { VitalMetric } from '@app/specs/seo-speed.spec';

// How speed values are written (findings' facts and the Speed panel use the same words).

/** Milliseconds: `840 ms` below a second, else seconds with one decimal (`2.6 s`). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (Math.round(ms) < 1_000) return `${Math.round(ms).toLocaleString('en-US')} ms`;
  return `${(Math.round(ms / 100) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** A layout-shift score, always with three decimals, so values near the 0.1 and 0.25 thresholds read right (`0.100`, `0.104`). */
export function formatCls(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '–';
  return value.toFixed(3);
}

/** Bytes in SI units: `512 B`, `12.3 kB`, `3.4 MB`, `1.2 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB'] as const;
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const digits = value < 100 ? 1 : 0;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

/** A metric's value in its unit (`formatCls` for CLS, `formatMs` for the others). */
export function formatVital(metric: VitalMetric, value: number): string {
  return metric === 'cls' ? formatCls(value) : formatMs(value);
}
