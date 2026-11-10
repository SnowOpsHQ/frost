import { createHash } from 'node:crypto';
import { canonicalJson } from '@app/change-intel';
import type { ChangeIntelRepository } from '@app/db';
import { MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES } from '@app/specs/capture-db.spec';
import {
  SCREENSHOT_EDIT_LIMITS,
  SCREENSHOT_OVERLAY_PREFIX,
  type SaveScreenshotEditAnswer,
  type SaveScreenshotEditInput,
  type ScreenshotLimits,
} from '@app/specs/screenshot.spec';
import { compositeEdit, pngSize, rectInside } from './composite';
import type { Bitmap, ScreenshotImaging } from './imaging';
import type { ScreenshotFiles } from './store';

// Saving an edited copy of a screenshot (Phase 11 Task 7, Decision 9; spec `screenshot.spec.ts`,
// Editing; acceptance `screenshot.feature.md`, Editing). The one input of bytes from the chrome is
// the overlay: its base64 is size-capped, its PNG header must name the crop's size before anything
// decodes it, it is decoded and composited over the source in main, and the result is encoded again:
// the overlay is never stored as sent. The source's file and row are only read. Never rejects: each
// failure is an outcome and one log line in frost's own words (never a path, a hash or user text).

export interface ScreenshotEditDeps {
  readonly store: ChangeIntelRepository;
  readonly files: ScreenshotFiles;
  readonly imaging: ScreenshotImaging;
  readonly limits: Pick<ScreenshotLimits, 'maxPngBytes'>;
  readonly editLimits?: Pick<typeof SCREENSHOT_EDIT_LIMITS, 'maxOverlayBytes'>;
  readonly now: () => number;
  readonly uuid: (now?: number) => string;
  readonly log: (message: string) => void;
  /** Keeps the new screenshot's thumbnail (made from the bitmap in hand). */
  readonly thumbnail: (sha256: string, bitmap: Bitmap) => void;
  /** Told of the new screenshot's project (retention). */
  readonly saved: (projectId: string) => void;
}

const refused = (status: Exclude<SaveScreenshotEditAnswer['status'], 'saved' | 'busy'>): SaveScreenshotEditAnswer => ({ status });
/** An error's code or name: never its message (it may hold a path or SQL parameters). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

/**
 * The overlay's PNG bytes from its `data:` URL: `too-large` past `maxOverlayBytes` (measured from
 * the base64's length before it is decoded, then on the bytes), `invalid` when it is not one.
 */
export function overlayBytes(dataUrl: string, maxBytes: number): Buffer | 'too-large' | 'invalid' {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(SCREENSHOT_OVERLAY_PREFIX)) return 'invalid';
  const base64 = dataUrl.slice(SCREENSHOT_OVERLAY_PREFIX.length);
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return 'invalid';
  if (Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) > maxBytes) return 'too-large';
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length > maxBytes ? 'too-large' : bytes;
}

export async function saveScreenshotEdit(deps: ScreenshotEditDeps, input: SaveScreenshotEditInput): Promise<SaveScreenshotEditAnswer> {
  const { store, files, imaging } = deps;
  const log = (message: string): void => deps.log(`edit refused: ${message}`);
  const maxOverlayBytes = deps.editLimits?.maxOverlayBytes ?? SCREENSHOT_EDIT_LIMITS.maxOverlayBytes;

  const source = await store.screenshot(input.sourceId);
  if (source === null) return refused('no-source');
  const { crop } = input;
  if (crop !== null && !rectInside(crop, source.width, source.height)) {
    log('the crop is not inside the screenshot');
    return refused('invalid');
  }
  const size = crop === null ? { width: source.width, height: source.height } : { width: crop.width, height: crop.height };

  // The overlay: capped, a PNG whose header names exactly the crop's size, before it is decoded.
  // The large buffers are `let`s, dropped as soon as they are used (nothing big is held across the
  // file lock or the database write).
  let overlayPng: Buffer | null;
  {
    const bytes = overlayBytes(input.overlay, maxOverlayBytes);
    if (bytes === 'too-large') {
      log('the overlay is over its cap');
      return refused('too-large');
    }
    if (bytes === 'invalid') {
      log('the overlay is not a PNG data URL');
      return refused('invalid');
    }
    overlayPng = bytes;
  }
  const header = pngSize(overlayPng);
  if (header === null || header.width !== size.width || header.height !== size.height) {
    log('the overlay is not a PNG of the crop\'s size');
    return refused('invalid');
  }
  const opsJson = canonicalJson(input.ops);
  if (Buffer.byteLength(opsJson, 'utf8') > MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES) {
    log('its ops are over their cap');
    return refused('invalid');
  }

  // The source as stored: its file must still match its hash and decode to its recorded size.
  let png: Buffer | null = await files.read(source.sha256);
  if (png === null) {
    log('the source file is missing or changed');
    return refused('no-source');
  }
  let sourceBitmap: Bitmap | null = imaging.decode(png, { width: source.width, height: source.height });
  png = null;
  if (sourceBitmap === null) {
    log('the source file does not decode to its size');
    return refused('no-source');
  }
  let overlay: Bitmap | null = imaging.decode(overlayPng, size);
  overlayPng = null;
  if (overlay === null) {
    log('the overlay does not decode to its size');
    return refused('invalid');
  }
  let edited: Bitmap | null = compositeEdit(sourceBitmap, crop, overlay);
  sourceBitmap = null;
  overlay = null;
  if (edited === null) {
    log('the overlay could not be composited');
    return refused('invalid');
  }
  const { width, height } = edited;

  let out: Buffer | null;
  try {
    out = imaging.encodePng(edited);
  } catch (error) {
    log(`the image could not be encoded (${codeOf(error)})`);
    return refused('store-failed');
  }
  if (out.length > deps.limits.maxPngBytes) {
    log(`its PNG is ${out.length} bytes`);
    return refused('too-large');
  }
  const sha256 = createHash('sha256').update(out).digest('hex');
  // Its thumbnail, from the bitmap in hand, before the bitmap is dropped (keyed by the file's hash: a
  // file that is then not written leaves only a cache entry no row names).
  try {
    deps.thumbnail(sha256, edited);
  } catch (error) {
    deps.log(`edit: the thumbnail could not be made (${codeOf(error)})`);
  }
  edited = null;

  // As `take` does: the hash's lock is held from the write until the row names the file.
  const release = await files.lock(sha256);
  let file: { sha256: string; bytes: number };
  try {
    file = await files.write(out);
  } catch (error) {
    release();
    log(`the file could not be written (${codeOf(error)})`);
    return refused('store-failed');
  } finally {
    out = null;
  }
  const at = deps.now();
  const id = deps.uuid(at);
  let stored = false;
  try {
    stored = await store.appendScreenshotEdit({
      id,
      projectId: source.projectId,
      pageUrl: source.pageUrl,
      captureId: null,
      kind: source.kind,
      rectJson: source.rectJson,
      width,
      height,
      bytes: file.bytes,
      sha256: file.sha256,
      segments: source.segments,
      renderProfileJson: source.renderProfileJson,
      searchParamsJson: source.searchParamsJson,
      createdAt: at,
      sourceId: source.id,
      cropJson: crop === null ? null : canonicalJson(crop),
      opsJson,
    });
  } catch (error) {
    log(`the rows could not be written (${codeOf(error)})`);
  } finally {
    release();
  }
  // Not written: the source (or its project) went meanwhile, or the store refused. The file stays for
  // the orphan sweep (another row may name it), as with `take`.
  if (!stored) {
    const gone = await Promise.all([store.screenshot(source.id), store.project(source.projectId)]).then(
      ([still, project]) => still === null || project === null,
      () => false,
    );
    if (gone) return refused('no-source');
    log('the store refused the rows');
    return refused('store-failed');
  }
  deps.saved(source.projectId);
  return { status: 'saved', id, width, height, bytes: file.bytes };
}
