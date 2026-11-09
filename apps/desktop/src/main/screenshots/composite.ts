import type { ScreenshotRect } from '@app/specs/screenshot.spec';
import { cropBitmap, type Bitmap } from './stitch';

// Compositing an edited screenshot (Phase 11 Task 7, Decision 9; spec `screenshot.spec.ts`, Editing;
// acceptance `screenshot.feature.md`, Editing). Pure: numbers and buffers in, numbers and buffers out;
// no Electron, no DOM. Bitmaps are BGRA, 4 bytes a pixel, rows packed, **premultiplied** alpha (what
// Electron's `nativeImage` `toBitmap` gives and `createFromBitmap` takes; checked in Electron 45).

/** The 8 bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's pixel size from its header (the signature, then the `IHDR` chunk of 13 bytes), read
 * without decoding anything: `null` when `png` does not start like a PNG. A decoder is only ever
 * given a PNG whose header names the expected size (no decompression bomb reaches it).
 */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(png) || png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.readUInt32BE(8) !== 13 || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Whether `rect` is whole pixels lying inside a `width` × `height` image. */
export function rectInside(rect: ScreenshotRect, width: number, height: number): boolean {
  const { x, y, width: w, height: h } = rect;
  return [x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= width && y + h <= height;
}

/** Whether `bitmap` holds the bytes its size says (`width × height × 4`). */
const whole = (bitmap: Bitmap): boolean => Number.isInteger(bitmap.width) && Number.isInteger(bitmap.height) && bitmap.width > 0 && bitmap.height > 0 && bitmap.bitmap.length === bitmap.width * bitmap.height * 4;

/** The smallest rectangle holding every pixel of `bitmap` whose alpha is not 0; `null` when it is all transparent. */
export function opaqueBounds(bitmap: Bitmap): ScreenshotRect | null {
  if (!whole(bitmap)) return null;
  const { width, height } = bitmap;
  const pixels = bitmap.bitmap;
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] !== 0) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    left = Math.min(left, first);
    right = Math.max(right, last);
  }
  return top < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Blends `overlay` over `base` in place ("source over", premultiplied: each channel becomes
 * `o + b × (255 − oα) / 255`, at most 255), only within the overlay's non-transparent bounds; the
 * rest of `base` is not touched. Both must be the same size; answers whether it blended (`false`:
 * sizes differ or a buffer is short; nothing changed).
 */
export function compositeOver(base: Bitmap, overlay: Bitmap): boolean {
  if (!whole(base) || !whole(overlay) || base.width !== overlay.width || base.height !== overlay.height) return false;
  const bounds = opaqueBounds(overlay);
  if (bounds === null) return true;
  const out = base.bitmap;
  const top = overlay.bitmap;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const i = (y * base.width + x) * 4;
      const alpha = top[i + 3]!;
      if (alpha === 0) continue;
      if (alpha === 255) {
        top.copy(out, i, i, i + 4);
        continue;
      }
      const keep = 255 - alpha;
      for (let c = 0; c < 4; c++) out[i + c] = Math.min(255, top[i + c]! + Math.round((out[i + c]! * keep) / 255));
    }
  }
  return true;
}

/**
 * The edited screenshot: `source` cropped to `crop` (`null`: all of it), with `overlay` (exactly the
 * crop's size) blended over it. `null` when the crop is not inside the source or the overlay is not
 * its size. Without a crop the source's own buffer is blended in place and answered (the caller owns
 * it, a decoded copy); with one, a new bitmap.
 */
export function compositeEdit(source: Bitmap, crop: ScreenshotRect | null, overlay: Bitmap): Bitmap | null {
  if (!whole(source)) return null;
  if (crop !== null && !rectInside(crop, source.width, source.height)) return null;
  const base = crop === null ? source : cropBitmap(source, crop);
  if (base === null || overlay.width !== base.width || overlay.height !== base.height) return null;
  return compositeOver(base, overlay) ? base : null;
}
