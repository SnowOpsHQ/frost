// Spec: specs/screenshot.spec.ts (SCREENSHOT_WORLD_ID, SCREENSHOT_LIMITS, SCREENSHOT_REFUSALS)
// Acceptance: specs/screenshot.feature.md (Kinds; Scenarios bitmap-of-a-captured-image, viewport-and-area-capture-the-view,
// full-page-restores-scroll, full-page-rows-at-any-ratio, deadlines-bound-every-step)
import { describe, expect, test } from 'vitest';
import { SCREENSHOT_LIMITS, SCREENSHOT_WORLD_ID } from '@app/specs/screenshot.spec';
import { bitmapOf, captureArea, captureFullPage, captureViewport, deviceScale, ScreenshotFailure } from '../capture';
import { FakeTab, rowAt, until } from './fakes';

const live = () => new AbortController().signal;
const failure = async (run: Promise<unknown>): Promise<string> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ScreenshotFailure);
  return (error as ScreenshotFailure).reason;
};

describe('capture', () => {
  test('bitmap-of-a-captured-image', () => {
    // Pixels per the image's own scale factor: a 2× representation reports its size in DIP.
    const bitmap = Buffer.alloc(20 * 10 * 4, 1);
    expect(bitmapOf({ isEmpty: () => false, getScaleFactors: () => [1, 2], getSize: () => ({ width: 10, height: 5 }), toBitmap: () => bitmap })).toEqual({ bitmap, width: 20, height: 10 });
    expect(bitmapOf({ isEmpty: () => false, getScaleFactors: () => [1], getSize: () => ({ width: 20, height: 10 }), toBitmap: () => bitmap })).toEqual({ bitmap, width: 20, height: 10 });
    // Empty, or a bitmap that does not match its size: nothing.
    expect(bitmapOf({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) })).toBeNull();
    expect(bitmapOf({ isEmpty: () => false, getSize: () => ({ width: 7, height: 3 }), toBitmap: () => bitmap })).toBeNull();
  });

  test('viewport-and-area-capture-the-view', async () => {
    const tab = new FakeTab();
    const viewport = await captureViewport(tab, { signal: live() });
    expect(viewport).toMatchObject({ segments: 1, truncated: false, rect: null, bitmap: { width: 230, height: 160 } });

    // An area: the page's rectangle (CSS px) cropped from the view at its pixels per CSS px.
    tab.scroll = { x: 0, y: 40 };
    const pending = captureArea(tab, { signal: live() });
    await until(() => tab.selection !== null);
    expect(tab.focused).toBe(1);
    tab.selection!.resolve({ x: 10, y: 5, width: 20, height: 30 });
    const area = await pending;
    expect(area).toMatchObject({ segments: 1, truncated: false, rect: { x: 10, y: 5, width: 20, height: 30 }, bitmap: { width: 40, height: 60 } });
    // Its first row is the document's row at the scroll offset plus the rect's top.
    expect(rowAt(area.bitmap.bitmap, 40, 0, 0)).toBe(80 + 10);
    expect(rowAt(area.bitmap.bitmap, 40, 39, 59)).toBe(80 + 10 + 59);
    expect(tab.scripts.every((script) => script.world === SCREENSHOT_WORLD_ID)).toBe(true);
    // A selection that ends with nothing is cancelled; an answer that is not a rectangle failed.
    const none = captureArea(tab, { signal: live() });
    await until(() => tab.selection !== null);
    tab.selection!.resolve(null);
    expect(await failure(none)).toBe('cancelled');
    const bad = captureArea(tab, { signal: live() });
    await until(() => tab.selection !== null);
    tab.selection!.resolve({ x: -5, y: 0, width: 'wide', height: 1 });
    expect(await failure(bad)).toBe('capture-failed');
  });

  test('full-page-restores-scroll', async () => {
    // 250 CSS px of document, an 80 px viewport (clientWidth 100 of innerWidth 115), 2 px per CSS px.
    const tab = new FakeTab();
    tab.scroll = { x: 0, y: 37 };
    const full = await captureFullPage(tab, { signal: live() });
    expect(full).toMatchObject({ segments: 4, truncated: false, rect: null, bitmap: { width: 200, height: 500 } });
    // Every document row once, in order; the scrollbar's columns cropped away.
    for (let y = 0; y < 500; y++) {
      expect(rowAt(full.bitmap.bitmap, 200, 0, y)).toBe(y);
      expect(rowAt(full.bitmap.bitmap, 200, 199, y)).toBe(y);
    }
    // It scrolled down the page, the last scroll to the bottom, then back where the page was.
    expect(tab.scripts.filter((s) => s.kind === 'scroll').map((s) => s.args['y'])).toEqual([0, 80, 160, 170]);
    expect(tab.scripts.at(-1)).toMatchObject({ kind: 'restore', args: { x: 0, y: 37 } });
    expect(tab.scroll).toEqual({ x: 0, y: 37 });
    expect(tab.scripts.every((script) => script.world === SCREENSHOT_WORLD_ID)).toBe(true);

    // A fractional device ratio (a 366 × 1263 CSS viewport captured at 332 × 1145 px, 0.906 25):
    // rows follow the page's devicePixelRatio, every document row exactly once.
    const fractional = new FakeTab({ innerWidth: 366, innerHeight: 1_263, clientWidth: 350, clientHeight: 1_263, scrollHeight: 3_790, scale: 0.906_25, devicePixelRatio: 0.906_25 });
    const whole = await captureFullPage(fractional, { signal: live() });
    expect(whole).toMatchObject({ truncated: false, segments: 4, bitmap: { width: 317, height: Math.round(3_790 * 0.906_25) } });
    for (let y = 0; y < whole.bitmap.height; y++) if (rowAt(whole.bitmap.bitmap, 317, 0, y) !== y) throw new Error(`row ${y} is ${rowAt(whole.bitmap.bitmap, 317, 0, y)}`);

    // A page that stops scrolling early: cut where its rows run out (truncated), never a gap.
    const stuck = new FakeTab();
    stuck.stuckAt = 100;
    const cut = await captureFullPage(stuck, { signal: live() });
    expect(cut).toMatchObject({ truncated: true, bitmap: { width: 200, height: 360 } });
    for (let y = 0; y < 360; y++) expect(rowAt(cut.bitmap.bitmap, 200, 0, y)).toBe(y);

    // A failing capture: capture-failed, and the scroll is restored.
    const failing = new FakeTab();
    failing.scroll = { x: 0, y: 12 };
    failing.beforeCapture = () => {
      if (failing.captures === 2) throw new Error('gone');
    };
    expect(await failure(captureFullPage(failing, { signal: live() }))).toBe('capture-failed');
    expect(failing.scroll).toEqual({ x: 0, y: 12 });

    // Past the deadline: capture-failed, restored.
    const slow = new FakeTab();
    slow.scroll = { x: 0, y: 5 };
    slow.beforeCapture = () => (slow.captures === 2 ? new Promise<void>(() => undefined) : undefined);
    expect(await failure(captureFullPage(slow, { signal: live(), limits: { ...SCREENSHOT_LIMITS, fullPageDeadlineMs: 50 } }))).toBe('capture-failed');
    expect(slow.scroll).toEqual({ x: 0, y: 5 });

    // Cancelled mid-run (a navigation, the tab closing): cancelled, restored.
    const cancelled = new FakeTab();
    cancelled.scroll = { x: 0, y: 9 };
    const controller = new AbortController();
    cancelled.beforeCapture = () => {
      if (cancelled.captures === 3) controller.abort('cancelled');
    };
    expect(await failure(captureFullPage(cancelled, { signal: controller.signal }))).toBe('cancelled');
    expect(cancelled.scroll).toEqual({ x: 0, y: 9 });

    // A hostile measure answer is refused before anything scrolls.
    const hostile = new FakeTab();
    hostile.override = (kind) => (kind === 'measure' ? { scrollHeight: 'tall' } : undefined);
    expect(await failure(captureFullPage(hostile, { signal: live() }))).toBe('capture-failed');
    expect(hostile.scripts.filter((s) => s.kind === 'scroll')).toEqual([]);
  });

  test('full-page-rows-at-any-ratio', async () => {
    // A tall page (10,000 CSS px) in a 653 px viewport, at whole and fractional ratios: the stitched
    // image is exactly round(10,000 × ratio) rows (or the cap), each document row once, in order.
    for (const ratio of [1, 1.25, 1.5, 0.906_25, 1.75, 2, 2.25, 0.8, 1.333_333]) {
      const tab = new FakeTab({ innerWidth: 400, innerHeight: 653, clientWidth: 385, clientHeight: 653, scrollHeight: 10_000, scale: ratio, devicePixelRatio: ratio });
      const shot = await captureFullPage(tab, { signal: live() });
      const width = Math.round(385 * ratio);
      const expected = Math.min(Math.round(10_000 * ratio), SCREENSHOT_LIMITS.maxStitchedHeightPx, Math.floor(SCREENSHOT_LIMITS.maxPixels / width));
      expect(shot.bitmap, `ratio ${ratio}`).toMatchObject({ width, height: expected });
      expect(shot.truncated, `ratio ${ratio}`).toBe(expected < Math.round(10_000 * ratio));
      for (let y = 0; y < expected; y++) if (rowAt(shot.bitmap.bitmap, width, 0, y) !== y) throw new Error(`ratio ${ratio}: row ${y} is ${rowAt(shot.bitmap.bitmap, width, 0, y)}`);
    }
    // A capture that disagrees with devicePixelRatio (device emulation): the measured ratio is used.
    expect(deviceScale(653, 980, 2)).toBeCloseTo(980 / 653);
    expect(deviceScale(653, 1_306, 2)).toBe(2);
    expect(deviceScale(1_263, 1_145, 0.906_25)).toBe(0.906_25);
  }, 30_000);

  test('deadlines-bound-every-step', async () => {
    const tight = { ...SCREENSHOT_LIMITS, fullPageDeadlineMs: 100, areaTimeoutMs: 100, segmentTimeoutMs: 100 };
    const never = () => new Promise<never>(() => undefined);
    const timed = async (run: Promise<unknown>) => {
      const started = Date.now();
      const reason = await failure(run);
      return { reason, ms: Date.now() - started };
    };
    // A full page whose capture and restore never answer: failed by the deadline, restore given up on.
    const stalled = new FakeTab();
    stalled.beforeCapture = () => (stalled.captures === 2 ? never() : undefined);
    stalled.override = (kind) => (kind === 'restore' ? never() : undefined);
    let outcome = await timed(captureFullPage(stalled, { signal: live(), limits: tight }));
    expect(outcome.reason).toBe('capture-failed');
    expect(outcome.ms).toBeLessThan(1_000);
    // A page that answers nothing at all.
    const silent = new FakeTab();
    silent.override = () => never();
    outcome = await timed(captureFullPage(silent, { signal: live(), limits: tight }));
    expect(outcome).toMatchObject({ reason: 'capture-failed' });
    expect(outcome.ms).toBeLessThan(1_000);
    // An area whose selector and cancel script never answer: cancelled at the timeout, the cancel given up on.
    outcome = await timed(captureArea(silent, { signal: live(), limits: tight }));
    expect(outcome.reason).toBe('cancelled');
    expect(outcome.ms).toBeLessThan(1_000);
    expect(silent.scripts.filter((script) => script.kind === 'cancel')).toHaveLength(1);
    // An area selected, then a page that never answers the measure: failed within the step's deadline.
    const mute = new FakeTab();
    mute.override = (kind) => (kind === 'measure' ? never() : undefined);
    const area = timed(captureArea(mute, { signal: live(), limits: tight }));
    await until(() => mute.selection !== null);
    mute.selection!.resolve({ x: 1, y: 1, width: 10, height: 10 });
    outcome = await area;
    expect(outcome.reason).toBe('capture-failed');
    expect(outcome.ms).toBeLessThan(1_000);
    // A view that never captures: the viewport fails within its deadline.
    const frozen = new FakeTab();
    frozen.beforeCapture = never;
    outcome = await timed(captureViewport(frozen, { signal: live(), limits: tight }));
    expect(outcome).toMatchObject({ reason: 'capture-failed' });
    expect(outcome.ms).toBeLessThan(1_000);
  }, 30_000);
});
