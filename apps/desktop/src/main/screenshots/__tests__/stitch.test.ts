// Spec: specs/screenshot.spec.ts (SCREENSHOT_LIMITS)
// Acceptance: specs/screenshot.feature.md (Kinds; Scenarios plan-stitch-covers-page-once,
// plan-stitch-respects-caps, compose-stitch-places-rows, crop-area-maps-css-to-pixels)
import { describe, expect, test } from 'vitest';
import { SCREENSHOT_LIMITS } from '@app/specs/screenshot.spec';
import { composeStitch, cropBitmap, pixelRect, planStitch, stitchWidth, type StitchPlan } from '../stitch';

const LIMITS = { maxStitchedHeightPx: SCREENSHOT_LIMITS.maxStitchedHeightPx, maxPixels: SCREENSHOT_LIMITS.maxPixels, maxSegments: SCREENSHOT_LIMITS.maxSegments };

/** Every planned row, in order: each segment's `[destY, destY + cropHeight)`. */
function coverage(plan: StitchPlan): number[] {
  const rows: number[] = [];
  for (const segment of plan.segments) for (let r = 0; r < segment.cropHeight; r++) rows.push(segment.destY + r);
  return rows;
}

/** Which document row each output row shows: the segment's scroll offset (device rows) plus its crop. */
function sourceRows(plan: StitchPlan, scale: number): number[] {
  const rows: number[] = [];
  for (const segment of plan.segments) for (let r = 0; r < segment.cropHeight; r++) rows.push(Math.round(segment.scrollY * scale) + segment.cropTop + r);
  return rows;
}

describe('planStitch', () => {
  test('plan-stitch-covers-page-once', () => {
    const cases = [
      { docHeightCss: 2_400, viewportHeightCss: 800, viewportWidthCss: 1_280, scale: 1 }, // an exact multiple
      { docHeightCss: 2_500, viewportHeightCss: 800, viewportWidthCss: 1_280, scale: 1 },
      { docHeightCss: 2_401, viewportHeightCss: 800, viewportWidthCss: 1_280, scale: 2 },
      { docHeightCss: 3_333, viewportHeightCss: 701, viewportWidthCss: 1_003, scale: 1.25 },
      { docHeightCss: 5_000, viewportHeightCss: 597, viewportWidthCss: 351, scale: 1.5 },
      { docHeightCss: 801, viewportHeightCss: 800, viewportWidthCss: 1_000, scale: 1 },
      { docHeightCss: 300, viewportHeightCss: 800, viewportWidthCss: 1_000, scale: 2 }, // shorter than the viewport
    ];
    for (const input of cases) {
      const plan = planStitch({ ...input, limits: LIMITS });
      const height = Math.round(input.docHeightCss * input.scale);
      expect(plan.truncated, JSON.stringify(input)).toBe(false);
      expect(plan.width).toBe(Math.round(input.viewportWidthCss * input.scale));
      expect(plan.height).toBe(height);
      // Every row 0 … height - 1 exactly once, in order, each from the document row of the same index.
      const rows = coverage(plan);
      expect(rows, JSON.stringify(input)).toEqual(Array.from({ length: height }, (_, i) => i));
      expect(sourceRows(plan, input.scale)).toEqual(rows);
      // No crop reaches past a viewport's rows.
      const viewportRows = Math.round(input.viewportHeightCss * input.scale);
      for (const segment of plan.segments) {
        expect(segment.cropTop).toBeGreaterThanOrEqual(0);
        expect(segment.cropTop + segment.cropHeight).toBeLessThanOrEqual(viewportRows + 1);
        expect(Number.isInteger(segment.scrollY)).toBe(true);
      }
      // The last segment scrolls to the bottom (never past it), and only it can overlap.
      const maxScroll = Math.max(0, input.docHeightCss - input.viewportHeightCss);
      const last = plan.segments.at(-1)!;
      expect(last.scrollY).toBe(Math.min(maxScroll, (plan.segments.length - 1) * input.viewportHeightCss));
      for (const segment of plan.segments.slice(0, -1)) expect(segment.cropTop).toBe(0);
    }
    // An exact multiple: three segments, no overlap.
    const exact = planStitch({ docHeightCss: 2_400, viewportHeightCss: 800, viewportWidthCss: 1_280, scale: 1, limits: LIMITS });
    expect(exact.segments).toEqual([
      { scrollY: 0, cropTop: 0, cropHeight: 800, destY: 0 },
      { scrollY: 800, cropTop: 0, cropHeight: 800, destY: 800 },
      { scrollY: 1_600, cropTop: 0, cropHeight: 800, destY: 1_600 },
    ]);
    // The last one scrolled to the bottom crops its overlap.
    const overlap = planStitch({ docHeightCss: 2_500, viewportHeightCss: 800, viewportWidthCss: 1_280, scale: 1, limits: LIMITS });
    expect(overlap.segments.at(-1)).toEqual({ scrollY: 1_700, cropTop: 700, cropHeight: 100, destY: 2_400 });
    // Shorter than the viewport: one segment, cropped to the document.
    const short = planStitch({ docHeightCss: 300, viewportHeightCss: 800, viewportWidthCss: 1_000, scale: 2, limits: LIMITS });
    expect(short.segments).toEqual([{ scrollY: 0, cropTop: 0, cropHeight: 600, destY: 0 }]);
    // Nothing to plan from nonsense.
    for (const bad of [{ docHeightCss: 0 }, { viewportHeightCss: 0 }, { viewportWidthCss: 0 }, { scale: 0 }, { scale: Number.NaN }, { docHeightCss: Number.POSITIVE_INFINITY }]) {
      const plan = planStitch({ docHeightCss: 1_000, viewportHeightCss: 500, viewportWidthCss: 500, scale: 1, limits: LIMITS, ...bad });
      expect(plan.segments, JSON.stringify(bad)).toEqual([]);
    }
  });

  test('plan-stitch-respects-caps', () => {
    // Height: a page far taller than maxStitchedHeightPx is cut there.
    const tall = planStitch({ docHeightCss: 100_000, viewportHeightCss: 1_000, viewportWidthCss: 800, scale: 1, limits: LIMITS });
    expect(tall.truncated).toBe(true);
    expect(tall.height).toBe(LIMITS.maxStitchedHeightPx);
    expect(coverage(tall)).toEqual(Array.from({ length: tall.height }, (_, i) => i));
    expect(tall.segments.length).toBeLessThanOrEqual(LIMITS.maxSegments);
    // Pixels: a wide page is cut so width × height stays within maxPixels.
    const wide = planStitch({ docHeightCss: 10_000, viewportHeightCss: 1_000, viewportWidthCss: 5_000, scale: 2, limits: LIMITS });
    expect(wide.truncated).toBe(true);
    expect(wide.width * wide.height).toBeLessThanOrEqual(LIMITS.maxPixels);
    expect(wide.height).toBe(Math.floor(LIMITS.maxPixels / wide.width));
    // Segments: a short viewport needs more captures than allowed; cut after maxSegments.
    const many = planStitch({ docHeightCss: 10_000, viewportHeightCss: 100, viewportWidthCss: 800, scale: 1, limits: LIMITS });
    expect(many.truncated).toBe(true);
    expect(many.segments).toHaveLength(LIMITS.maxSegments);
    expect(many.height).toBe(LIMITS.maxSegments * 100);
    expect(coverage(many)).toEqual(Array.from({ length: many.height }, (_, i) => i));
    // A tight custom cap behaves the same way.
    const custom = planStitch({ docHeightCss: 1_000, viewportHeightCss: 300, viewportWidthCss: 100, scale: 1, limits: { maxStitchedHeightPx: 450, maxPixels: 1_000_000, maxSegments: 10 } });
    expect(custom).toMatchObject({ height: 450, truncated: true });
    expect(custom.segments).toEqual([
      { scrollY: 0, cropTop: 0, cropHeight: 300, destY: 0 },
      { scrollY: 300, cropTop: 0, cropHeight: 150, destY: 300 },
    ]);
  });
});

/** A BGRA bitmap whose every pixel of row r is (r & 255, r >> 8, tag, 255). */
function rowsBitmap(width: number, height: number, tag: number, offset = 0): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let r = 0; r < height; r++) {
    const row = r + offset;
    for (let c = 0; c < width; c++) out.set([row & 255, row >> 8, tag, 255], (r * width + c) * 4);
  }
  return out;
}
const pixel = (bitmap: Buffer, width: number, x: number, y: number) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('composeStitch', () => {
  test('compose-stitch-places-rows', () => {
    // Two viewports of 4 rows over a 6-row document: the second scrolled to row 2, its top 2 rows cropped.
    const first = { bitmap: rowsBitmap(3, 4, 1, 0), width: 3, height: 4, cropTop: 0, cropHeight: 4, destY: 0 };
    const second = { bitmap: rowsBitmap(3, 4, 2, 2), width: 3, height: 4, cropTop: 2, cropHeight: 2, destY: 4 };
    const out = composeStitch([first, second], 3, 6);
    expect(out).toHaveLength(3 * 6 * 4);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 3; x++) expect(pixel(out, 3, x, y), `${x},${y}`).toEqual([y, 0, y < 4 ? 1 : 2, 255]);
    // The right edge is cropped to the narrowest segment (a scrollbar, a resize mid-run).
    const narrow = { ...second, bitmap: rowsBitmap(2, 4, 2, 2), width: 2 };
    expect(stitchWidth([first, narrow], 3)).toBe(2);
    expect(stitchWidth([first, second], 3)).toBe(3);
    const cropped = composeStitch([first, narrow], 2, 6);
    expect(pixel(cropped, 2, 1, 5)).toEqual([5, 0, 2, 255]);
    expect(pixel(cropped, 2, 1, 0)).toEqual([0, 0, 1, 255]);
    // Out-of-range crops and destinations are clipped, never read or written past a buffer.
    const wild = [
      { bitmap: rowsBitmap(3, 4, 3), width: 3, height: 4, cropTop: 3, cropHeight: 5, destY: 4 }, // past its bitmap
      { bitmap: rowsBitmap(3, 4, 4), width: 3, height: 4, cropTop: 0, cropHeight: 4, destY: 5 }, // past the output
      { bitmap: rowsBitmap(3, 4, 5), width: 3, height: 4, cropTop: -2, cropHeight: 2, destY: 0 }, // before its bitmap
      { bitmap: Buffer.alloc(8), width: 3, height: 4, cropTop: 0, cropHeight: 4, destY: 0 }, // a bitmap shorter than it claims
    ];
    const clipped = composeStitch(wild, 3, 6);
    expect(clipped).toHaveLength(3 * 6 * 4);
    expect(pixel(clipped, 3, 0, 4)).toEqual([3, 0, 3, 255]);
    expect(pixel(clipped, 3, 0, 5)).toEqual([0, 0, 4, 255]);
    expect(pixel(clipped, 3, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test('crop-area-maps-css-to-pixels', () => {
    // A 200×100 CSS viewport captured at 2 px per CSS px.
    const bitmap = { bitmap: rowsBitmap(400, 200, 7), width: 400, height: 200 };
    expect(pixelRect({ x: 10, y: 20, width: 30, height: 40 }, 2, 400, 200)).toEqual({ x: 20, y: 40, width: 60, height: 80 });
    // Clamped to the bitmap; nothing left is null.
    expect(pixelRect({ x: 190, y: 90, width: 30, height: 40 }, 2, 400, 200)).toEqual({ x: 380, y: 180, width: 20, height: 20 });
    expect(pixelRect({ x: 300, y: 0, width: 10, height: 10 }, 2, 400, 200)).toBeNull();
    expect(pixelRect({ x: 0, y: 0, width: 10, height: 10 }, Number.NaN, 400, 200)).toBeNull();
    const area = cropBitmap(bitmap, { x: 20, y: 40, width: 60, height: 80 })!;
    expect(area).toMatchObject({ width: 60, height: 80 });
    expect(area.bitmap).toHaveLength(60 * 80 * 4);
    expect(pixel(area.bitmap, 60, 0, 0)).toEqual([40, 0, 7, 255]);
    expect(pixel(area.bitmap, 60, 59, 79)).toEqual([119, 0, 7, 255]);
    expect(cropBitmap(bitmap, { x: 390, y: 0, width: 20, height: 10 })).toBeNull();
  });
});
