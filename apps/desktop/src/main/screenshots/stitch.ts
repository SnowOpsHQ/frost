import type { ScreenshotLimits, ScreenshotRect } from '@app/specs/screenshot.spec';

// Stitching a full page and cropping an area (Phase 6 Task 5; spec `screenshot.spec.ts`,
// `SCREENSHOT_LIMITS`; acceptance `screenshot.feature.md`, Kinds). Pure: numbers and buffers in,
// numbers and buffers out; no Electron, no DOM.
//
// Rows are device pixels of the captured view: CSS px × `scale` (the view's pixels per CSS px, read
// from a real capture). A segment is one viewport capture at a whole CSS scroll position; it shows
// document rows `[round(scrollY × scale), round((scrollY + viewport) × scale))`, and contributes the
// part no earlier segment did. Bitmaps are BGRA, 4 bytes a pixel, rows packed (`toBitmap`).

export type StitchLimits = Pick<ScreenshotLimits, 'maxStitchedHeightPx' | 'maxPixels' | 'maxSegments'>;

export interface StitchInput {
  /** The document's height (`document.scrollingElement.scrollHeight`), CSS px. */
  readonly docHeightCss: number;
  /** The viewport's height without a horizontal scrollbar (`clientHeight`), CSS px. */
  readonly viewportHeightCss: number;
  /** The viewport's width without a vertical scrollbar (`clientWidth`), CSS px. */
  readonly viewportWidthCss: number;
  /** The view's pixels per CSS px. */
  readonly scale: number;
  readonly limits: StitchLimits;
}

/** One viewport capture of a full page. */
export interface StitchSegment {
  /** Where the page is scrolled for it (whole CSS px). */
  readonly scrollY: number;
  /** The first row of its capture that is used (device px). */
  readonly cropTop: number;
  /** How many rows of its capture are used (device px). */
  readonly cropHeight: number;
  /** Where those rows go in the stitched image (device px). */
  readonly destY: number;
}

export interface StitchPlan {
  readonly segments: readonly StitchSegment[];
  /** The stitched image's size (device px). */
  readonly width: number;
  readonly height: number;
  /** The page is taller than the caps allow: the image stops at `height`. */
  readonly truncated: boolean;
}

const EMPTY_PLAN: StitchPlan = { segments: [], width: 0, height: 0, truncated: false };
const isSize = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * The segments that cover the document's rows `0 … height - 1` exactly once, in order: one per
 * viewport height, the last one scrolled to the bottom (`docHeight - viewport`) with the rows it
 * shares with the one before cropped off. `height` is the document's, or less at a cap (the height
 * cap, the pixel cap for this width, or `maxSegments` captures): then `truncated`.
 */
export function planStitch({ docHeightCss, viewportHeightCss, viewportWidthCss, scale, limits }: StitchInput): StitchPlan {
  if (![docHeightCss, viewportHeightCss, viewportWidthCss, scale].every(isSize)) return EMPTY_PLAN;
  const docHeight = Math.ceil(docHeightCss);
  const viewport = Math.floor(viewportHeightCss);
  const width = Math.round(viewportWidthCss * scale);
  if (viewport < 1 || width < 1) return EMPTY_PLAN;
  const fullHeight = Math.round(docHeight * scale);
  const target = Math.min(fullHeight, limits.maxStitchedHeightPx, Math.floor(limits.maxPixels / width));
  const maxScroll = Math.max(0, docHeight - viewport);
  const segments: StitchSegment[] = [];
  let covered = 0;
  for (let i = 0; covered < target && segments.length < limits.maxSegments; i++) {
    const scrollY = Math.min(i * viewport, maxScroll);
    const top = Math.round(scrollY * scale);
    const end = Math.min(Math.round((scrollY + viewport) * scale), target);
    if (end <= covered) break;
    segments.push({ scrollY, cropTop: covered - top, cropHeight: end - covered, destY: covered });
    covered = end;
  }
  return { segments, width, height: covered, truncated: covered < fullHeight };
}

/** A BGRA bitmap and its size in pixels. */
export interface Bitmap {
  readonly bitmap: Buffer;
  readonly width: number;
  readonly height: number;
}

/** One captured segment and where its rows go. */
export interface ComposeSegment extends Bitmap {
  readonly cropTop: number;
  readonly cropHeight: number;
  readonly destY: number;
}

/** The width segments can be stitched at: `width`, or the narrowest segment's (its right edge cropped). */
export function stitchWidth(segments: readonly Pick<Bitmap, 'width'>[], width: number): number {
  return segments.reduce((narrowest, segment) => Math.min(narrowest, segment.width), width);
}

/**
 * Copies `segment`'s rows `cropTop … cropTop + cropHeight - 1` into `out` (a `width` × `height` BGRA
 * bitmap) at rows `destY …`. Rows outside the segment's bitmap (or past the bytes it really has) or
 * outside `out` are skipped; a segment narrower than `width` fills only its own columns. Answers how
 * many rows it copied.
 */
export function placeRows(out: Buffer, width: number, height: number, segment: ComposeSegment): number {
  const columns = Math.min(width, segment.width);
  if (![segment.width, segment.height, segment.cropTop, segment.cropHeight, segment.destY, width, height].every(Number.isInteger) || columns < 1) return 0;
  const rowBytes = columns * 4;
  let copied = 0;
  for (let r = 0; r < segment.cropHeight; r++) {
    const source = segment.cropTop + r;
    const dest = segment.destY + r;
    if (source < 0 || source >= segment.height || dest < 0 || dest >= height) continue;
    const from = source * segment.width * 4;
    const to = dest * width * 4;
    if (from + rowBytes > segment.bitmap.length || to + rowBytes > out.length) continue;
    segment.bitmap.copy(out, to, from, from + rowBytes);
    copied += 1;
  }
  return copied;
}

/**
 * One `width` × `height` BGRA bitmap with each segment's rows placed (`placeRows`). Rows nothing
 * covers stay transparent; `stitchWidth` gives the width that leaves no column missing.
 */
export function composeStitch(segments: readonly ComposeSegment[], width: number, height: number): Buffer {
  const out = Buffer.alloc(Math.max(0, width) * Math.max(0, height) * 4);
  for (const segment of segments) placeRows(out, width, height, segment);
  return out;
}

/**
 * `rect` (CSS px of the viewport) in the pixels of a `bitmapWidth` × `bitmapHeight` capture of that
 * viewport at `scale` pixels per CSS px: its edges rounded outwards, clamped to the bitmap; `null`
 * when nothing of it is left.
 */
export function pixelRect(rect: ScreenshotRect, scale: number, bitmapWidth: number, bitmapHeight: number): ScreenshotRect | null {
  if (!isSize(scale) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const left = Math.max(0, Math.floor(rect.x * scale));
  const top = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(bitmapWidth, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(bitmapHeight, Math.ceil((rect.y + rect.height) * scale));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** The pixels of `rect` (whole pixels inside the bitmap) as a bitmap of their own; `null` if the rect does not fit. */
export function cropBitmap(source: Bitmap, rect: ScreenshotRect): Bitmap | null {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > source.width || y + height > source.height) return null;
  if (source.bitmap.length < source.width * source.height * 4) return null;
  const out = Buffer.alloc(width * height * 4);
  for (let r = 0; r < height; r++) {
    const from = ((y + r) * source.width + x) * 4;
    source.bitmap.copy(out, r * width * 4, from, from + width * 4);
  }
  return { bitmap: out, width, height };
}
