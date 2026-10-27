import { DEFAULT_ZOOM, ZOOM_FACTORS } from '@app/specs/page-commands.spec';

// Zoom steps (`specs/page-commands.spec.ts`, `ZOOM_FACTORS`; `page-commands.feature.md`, Zoom).
// Pure, no Electron import.

export type ZoomDirection = 'in' | 'out' | 'reset';

/** Within this of a factor counts as that factor (Chromium hands back a float). */
const EPSILON = 1e-3;

/**
 * The zoom factor after one step from `factor`: the next `ZOOM_FACTORS` entry above (`in`) or
 * below (`out`) it, clamped to the first and last entries; `reset` (or a factor that is not a
 * finite number) is `DEFAULT_ZOOM`.
 */
export function stepZoom(factor: number, direction: ZoomDirection): number {
  if (direction === 'reset' || !Number.isFinite(factor)) return DEFAULT_ZOOM;
  const first = ZOOM_FACTORS[0];
  const last = ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;
  if (direction === 'in') return ZOOM_FACTORS.find((step) => step > factor + EPSILON) ?? Math.max(first, Math.min(last, factor));
  return [...ZOOM_FACTORS].reverse().find((step) => step < factor - EPSILON) ?? Math.max(first, Math.min(last, factor));
}
