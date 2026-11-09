import type { ClipboardItem, NativeImage, nativeImage as NativeImageModule } from 'electron';
import { SCREENSHOT_LIMITS, type ScreenshotImageSize, type ScreenshotLimits, type ScreenshotRect } from '@app/specs/screenshot.spec';
import { pngSize } from './composite';
import type { Bitmap } from './stitch';

// Encoding and resizing screenshots (Phase 6 Task 5; spec `screenshot.spec.ts`, `SCREENSHOT_LIMITS`;
// acceptance `screenshot.feature.md`, Images). The sizes are pure (`thumbnailPlan`, `previewSize`);
// the pixels go through Electron's `nativeImage` (`electronImaging`), injected into the service so
// it can be tested without Electron.

export type { Bitmap } from './stitch';

/** What the service does with pixels. */
export interface ScreenshotImaging {
  /** A PNG of a BGRA bitmap (its pixel size, scale factor 1). */
  encodePng(bitmap: Bitmap): Buffer;
  /** A thumbnail (PNG, `thumbnailPlan`) of a screenshot's bitmap: made once, when it is taken. */
  thumbnail(bitmap: Bitmap): Buffer;
  /**
   * A stored PNG as a thumbnail (PNG) or preview (JPEG) of at most `maxBytes` (a preview over it is
   * encoded again at a lower quality, then smaller); `null` if it does not decode or cannot fit.
   */
  render(png: Buffer, size: ScreenshotImageSize, maxBytes: number): { readonly type: 'image/png' | 'image/jpeg'; readonly data: Buffer } | null;
  /** Writes a stored PNG to the system clipboard as an image; `false` if it does not decode. */
  copy(png: Buffer): Promise<boolean>;
  /**
   * Phase 11 Task 7: a PNG's premultiplied BGRA bitmap, only if its header names exactly `expected`
   * (checked before anything is decoded) and it decodes to that size; else `null`.
   */
  decode(png: Buffer, expected: { readonly width: number; readonly height: number }): Bitmap | null;
}

/**
 * A thumbnail of a `width` × `height` shot: `thumbWidth` wide (never upscaled); a shot taller than
 * `thumbMaxHeight` at that width shows its top, cropped before it is scaled (`crop`).
 */
export function thumbnailPlan(width: number, height: number, limits: Pick<ScreenshotLimits, 'thumbWidth' | 'thumbMaxHeight'> = SCREENSHOT_LIMITS): { crop: ScreenshotRect | null; width: number; height: number } {
  const scale = Math.min(1, limits.thumbWidth / width);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  if (outHeight <= limits.thumbMaxHeight) return { crop: null, width: outWidth, height: outHeight };
  return { crop: { x: 0, y: 0, width, height: Math.min(height, Math.max(1, Math.round(limits.thumbMaxHeight / scale))) }, width: outWidth, height: limits.thumbMaxHeight };
}

/** A preview of a `width` × `height` shot: within `previewMaxWidth` × `previewMaxHeight`, its aspect kept, never upscaled. */
export function previewSize(width: number, height: number, limits: Pick<ScreenshotLimits, 'previewMaxWidth' | 'previewMaxHeight'> = SCREENSHOT_LIMITS): { width: number; height: number } {
  const scale = Math.min(1, limits.previewMaxWidth / width, limits.previewMaxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** `ScreenshotImaging` over Electron's `nativeImage` and its (async, `ClipboardItem`) `clipboard` (main only). */
export function electronImaging(
  electron: { readonly nativeImage: typeof NativeImageModule; readonly clipboard: { write(items: ClipboardItem[]): Promise<void> }; readonly ClipboardItem: typeof ClipboardItem },
  limits: ScreenshotLimits = SCREENSHOT_LIMITS,
): ScreenshotImaging {
  const decode = (png: Buffer): NativeImage | null => {
    const image = electron.nativeImage.createFromBuffer(png);
    return image.isEmpty() ? null : image;
  };
  const thumbOf = (image: NativeImage): Buffer => {
    const { width, height } = image.getSize();
    const plan = thumbnailPlan(width, height, limits);
    const source = plan.crop ? image.crop(plan.crop) : image;
    return source.resize({ width: plan.width, height: plan.height, quality: 'good' }).toPNG();
  };
  return {
    encodePng: ({ bitmap, width, height }) => electron.nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG(),
    thumbnail: ({ bitmap, width, height }) => thumbOf(electron.nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })),
    render(png, size, maxBytes) {
      const image = decode(png);
      if (!image) return null;
      if (size === 'thumb') {
        const data = thumbOf(image);
        return data.length <= maxBytes ? { type: 'image/png', data } : null;
      }
      const { width, height } = image.getSize();
      let fit = previewSize(width, height, limits);
      let quality = limits.previewJpegQuality;
      // A preview over the cap: a lower quality first, then smaller, a few times at most.
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = image.resize({ ...fit, quality: 'good' }).toJPEG(quality);
        if (data.length <= maxBytes) return { type: 'image/jpeg', data };
        if (quality > 50) quality = 50;
        else fit = { width: Math.max(1, Math.round(fit.width * 0.7)), height: Math.max(1, Math.round(fit.height * 0.7)) };
      }
      return null;
    },
    decode(png, expected) {
      const header = pngSize(png);
      if (header === null || header.width !== expected.width || header.height !== expected.height) return null;
      const image = decode(png);
      if (!image) return null;
      const { width, height } = image.getSize();
      if (width !== expected.width || height !== expected.height) return null;
      const bitmap = image.toBitmap();
      return bitmap.length === width * height * 4 ? { bitmap, width, height } : null;
    },
    async copy(png) {
      // Only an image that decodes is offered, as the PNG it is.
      if (!decode(png)) return false;
      await electron.clipboard.write([new electron.ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
      return true;
    },
  };
}
