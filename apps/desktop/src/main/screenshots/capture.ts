import { SCREENSHOT_LIMITS, SCREENSHOT_REFUSALS, type ScreenshotLimits, type ScreenshotRect, type ScreenshotRefusal } from '@app/specs/screenshot.spec';
import { runCancelArea, runMeasure, runRestore, runScroll, runSelectArea, type ScriptTarget, type ScrollPosition } from './page-script';
import { composeStitch, cropBitmap, pixelRect, planStitch, stitchWidth, type Bitmap } from './stitch';

// Driving a tab's WebContents for a screenshot (Phase 6 Task 5; spec `screenshot.spec.ts`;
// acceptance `screenshot.feature.md`, Kinds). Each kind answers a BGRA bitmap in the view's pixels,
// or throws a `ScreenshotFailure` naming its refusal. Nothing here creates a WebContents or a
// window: it only captures the tab's own view (`capturePage`) and runs the scripts of
// `page-script.ts` in `SCREENSHOT_WORLD_ID`. Every step stops as soon as `signal` aborts (the
// service aborts it for a navigation, the tab closing or leaving the front, or Cancel).

/** What `capturePage` resolves (Electron's `NativeImage`, structurally). */
export interface CapturedImage {
  isEmpty(): boolean;
  /** The size of the representation closest to `scaleFactor`, in DIP (its pixels over its scale). */
  getSize(scaleFactor?: number): { width: number; height: number };
  getScaleFactors?(): number[];
  toBitmap(options?: { scaleFactor?: number }): Buffer;
}

/** The part of a tab's WebContents a screenshot uses. */
export interface ScreenshotTarget extends ScriptTarget {
  capturePage(): Promise<CapturedImage>;
  /** Gives the page keyboard focus, so the user's Esc reaches the area selector. */
  focus?(): void;
}

/** Why a screenshot stopped (`reason`), and a line for the log in frost's own words (never page text). */
export class ScreenshotFailure extends Error {
  constructor(
    readonly reason: ScreenshotRefusal,
    why: string,
  ) {
    super(why);
    this.name = 'ScreenshotFailure';
  }
}

export interface CaptureOptions {
  /** Aborted to stop the screenshot; its reason is the refusal (default `cancelled`). */
  readonly signal: AbortSignal;
  readonly limits?: ScreenshotLimits;
}

/** A captured screenshot: its pixels, how many viewport captures made it, whether a cap cut it, an area's rect. */
export interface Captured {
  readonly bitmap: Bitmap;
  readonly segments: number;
  readonly truncated: boolean;
  readonly rect: ScreenshotRect | null;
}

const isRefusal = (value: unknown): value is ScreenshotRefusal => (SCREENSHOT_REFUSALS as readonly unknown[]).includes(value);
const stopped = (signal: AbortSignal): ScreenshotFailure =>
  new ScreenshotFailure(isRefusal(signal.reason) ? signal.reason : 'cancelled', signal.reason === 'capture-failed' ? 'the capture ran past its deadline' : 'the screenshot was cancelled');

/** A signal that aborts with `signal`, or with `reason` once `ms` pass; `release()` drops the timer and the link. */
function bounded(signal: AbortSignal, ms: number, reason: ScreenshotRefusal): { readonly signal: AbortSignal; release(): void } {
  const run = new AbortController();
  const forward = (): void => run.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => run.abort(reason), ms);
  return {
    signal: run.signal,
    release: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    },
  };
}

/** `run`'s answer, or `fallback` if it rejects or `ms` pass first (a page that never answers a clean-up script). */
function settleWithin<T>(run: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve()
      .then(run)
      .catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The view's device pixels per CSS px: the page's `devicePixelRatio` when the capture's size agrees
 * with it (`round(cssSize × ratio)` within 1 px), else the ratio measured from the capture (device
 * emulation scales the view; a fractionally scaled display rounds sizes).
 */
export function deviceScale(cssSize: number, capturedSize: number, devicePixelRatio: number): number {
  return Math.abs(Math.round(cssSize * devicePixelRatio) - capturedSize) <= 1 ? devicePixelRatio : capturedSize / cssSize;
}

/** `promise`'s answer, or the signal's failure as soon as it aborts (the promise is left to settle on its own). */
function unless<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(stopped(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stopped(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** One page step: its answer, `capture-failed` (with `why`) if it rejects or answers nothing, the signal's failure if it aborts. */
async function step<T>(run: () => Promise<T | null>, signal: AbortSignal, why: string): Promise<T> {
  const answer = await unless(
    Promise.resolve()
      .then(run)
      .catch(() => null),
    signal,
  );
  if (answer === null) throw new ScreenshotFailure('capture-failed', why);
  return answer;
}

/**
 * The image's pixels: the representation at its highest scale factor, as BGRA rows. Its width is
 * its DIP width × that factor (Electron reports sizes in DIP), checked against the bitmap's length;
 * `null` for an empty image or one whose bitmap does not match its size.
 */
export function bitmapOf(image: CapturedImage): Bitmap | null {
  if (image.isEmpty()) return null;
  const factors = (image.getScaleFactors?.() ?? []).filter((factor) => Number.isFinite(factor) && factor > 0);
  const scaleFactor = factors.length > 0 ? Math.max(...factors) : 1;
  const bitmap = image.toBitmap({ scaleFactor });
  const size = image.getSize(scaleFactor);
  if (!(size.width > 0 && size.height > 0)) return null;
  for (const width of new Set([Math.round(size.width * scaleFactor), size.width])) {
    if (!Number.isInteger(width) || width < 1 || bitmap.length % (width * 4) !== 0) continue;
    const height = bitmap.length / (width * 4);
    if (Math.abs(height - (size.height * width) / size.width) <= 1) return { bitmap, width, height };
  }
  return null;
}

/** The view as it is now, in pixels. */
async function captureView(target: ScreenshotTarget, signal: AbortSignal): Promise<Bitmap> {
  return step(async () => bitmapOf(await target.capturePage()), signal, 'the view could not be captured');
}

/** The visible viewport (`capturePage()`), scrollbar and all; within `segmentTimeoutMs`. */
export async function captureViewport(target: ScreenshotTarget, { signal, limits = SCREENSHOT_LIMITS }: CaptureOptions): Promise<Captured> {
  const run = bounded(signal, limits.segmentTimeoutMs, 'capture-failed');
  try {
    return { bitmap: await captureView(target, run.signal), segments: 1, truncated: false, rect: null };
  } finally {
    run.release();
  }
}

/**
 * The whole page, stitched (`planStitch`): measured, captured at the top (whose bitmap gives the
 * view's pixels per CSS px, `deviceScale`), then scrolled segment by segment, each one's rows placed
 * as captured (cropped by where the page really scrolled to: a page that stops short is cut there,
 * `truncated`). Bounded by `fullPageDeadlineMs`; the scroll position is restored whatever happens
 * (within `segmentTimeoutMs`: a page that never answers does not hold the screenshot).
 */
export async function captureFullPage(target: ScreenshotTarget, { signal, limits = SCREENSHOT_LIMITS }: CaptureOptions): Promise<Captured> {
  const run = bounded(signal, limits.fullPageDeadlineMs, 'capture-failed');
  let origin: ScrollPosition | null = null;
  try {
    const measure = await step(() => runMeasure(target), run.signal, 'its size could not be read');
    origin = { x: measure.scrollX, y: measure.scrollY };
    const at = origin;
    const top = await step(() => runScroll(target, at.x, 0), run.signal, 'it could not be scrolled');
    const first = await captureView(target, run.signal);
    const scale = deviceScale(measure.innerHeight, first.height, measure.devicePixelRatio);
    const plan = planStitch({ docHeightCss: measure.scrollHeight, viewportHeightCss: measure.clientHeight, viewportWidthCss: measure.clientWidth, scale, limits });
    if (plan.segments.length === 0) throw new ScreenshotFailure('capture-failed', 'its size cannot be stitched');
    const width = stitchWidth([first], plan.width);
    const out = Buffer.alloc(width * plan.height * 4);
    // Each segment is scrolled to where the rows placed so far end (never past them, so no row is
    // missed however the page snaps its scroll position), and its rows are placed from there on.
    // `planStitch` sets the size and the caps; at most `maxSegments` captures are taken.
    const maxScroll = Math.max(0, measure.scrollHeight - measure.clientHeight);
    let height = 0;
    let segments = 0;
    while (height < plan.height && segments < limits.maxSegments) {
      const want = Math.min(maxScroll, Math.floor(height / scale));
      const position = segments === 0 ? top : await step(() => runScroll(target, at.x, want), run.signal, 'it could not be scrolled');
      const shot = segments === 0 ? first : await captureView(target, run.signal);
      const cropTop = height - Math.round(position.y * scale);
      const rows = Math.min(plan.height - height, shot.height - cropTop);
      // The page did not scroll as far as asked (or scrolled past what is placed): its rows stop here.
      if (cropTop < 0 || rows <= 0) break;
      composeStitch(out, width, plan.height, { ...shot, cropTop, cropHeight: rows, destY: height });
      height += rows;
      segments += 1;
    }
    const truncated = plan.truncated || height < plan.height;
    return { bitmap: { bitmap: height === plan.height ? out : out.subarray(0, width * height * 4), width, height }, segments, truncated, rect: null };
  } finally {
    run.release();
    const at = origin;
    if (at) await settleWithin(() => runRestore(target, at.x, at.y), limits.segmentTimeoutMs, null);
  }
}

/**
 * An area the user drags on the page (`selectArea`, trusted input only): the page gets focus (so
 * the user's Esc reaches it), the selection ends by the drag, Esc, `signal` or `areaTimeoutMs`
 * (then the selector is ended in the page too), and the view is captured once the overlay is gone
 * and cropped to the rectangle at the view's pixels per CSS px (captured width over `innerWidth`).
 */
export async function captureArea(target: ScreenshotTarget, { signal, limits = SCREENSHOT_LIMITS }: CaptureOptions): Promise<Captured> {
  const run = bounded(signal, limits.areaTimeoutMs, 'cancelled');
  let selection: Awaited<ReturnType<typeof runSelectArea>>;
  try {
    try {
      target.focus?.();
    } catch {
      // Focus is a convenience: Cancel in the chrome still ends it.
    }
    selection = await unless(runSelectArea(target), run.signal);
  } catch (error) {
    // Cancelled, timed out, or the script failed: make sure no overlay is left in the page (a page
    // that never answers gets `segmentTimeoutMs`).
    await settleWithin(() => runCancelArea(target), limits.segmentTimeoutMs, false);
    if (error instanceof ScreenshotFailure) throw error;
    throw new ScreenshotFailure('capture-failed', 'the area selector failed');
  } finally {
    run.release();
  }
  if (selection === null) throw new ScreenshotFailure('cancelled', 'no area was selected');
  if (selection === 'invalid') throw new ScreenshotFailure('capture-failed', 'the area selector answered something else than an area');
  const rect = selection;
  // The capture itself, within `segmentTimeoutMs`.
  const capture = bounded(signal, limits.segmentTimeoutMs, 'capture-failed');
  try {
    const measure = await step(() => runMeasure(target), capture.signal, 'the viewport could not be read');
    const view = await captureView(target, capture.signal);
    const pixels = pixelRect(rect, deviceScale(measure.innerWidth, view.width, measure.devicePixelRatio), view.width, view.height);
    const bitmap = pixels === null ? null : cropBitmap(view, pixels);
    if (bitmap === null) throw new ScreenshotFailure('capture-failed', 'the area is outside the view');
    return { bitmap, segments: 1, truncated: false, rect };
  } finally {
    capture.release();
  }
}
