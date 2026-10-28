// Spec: specs/screenshot.spec.ts (SCREENSHOT_WORLD_ID, SCREENSHOT_LIMITS, SCREENSHOT_REFUSALS)
// Acceptance: specs/screenshot.feature.md (Kinds; Scenarios full-page-restores-scroll, area-selection-cancels)
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { SCREENSHOT_LIMITS, SCREENSHOT_WORLD_ID } from '@app/specs/screenshot.spec';
import { fakeEvent } from '../../../test/electron-fake';
import { bitmapOf, captureArea, captureFullPage, captureViewport, ScreenshotFailure } from '../capture';
import { FakeTab, rowAt, serviceSetup, until, type ServiceSetup } from './fakes';

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

    // A fractional device ratio (a 366 × 1263 CSS viewport captured at 332 × 1145 px): rows follow
    // the capture's height, so a row of rounding never cuts the page short.
    const fractional = new FakeTab({ innerWidth: 366, innerHeight: 1_263, clientWidth: 350, clientHeight: 1_263, scrollHeight: 3_790, scale: 0.906_25, devicePixelRatio: 0.906_25 });
    const whole = await captureFullPage(fractional, { signal: live() });
    expect(whole).toMatchObject({ truncated: false, segments: 4, bitmap: { width: 317, height: Math.round((3_790 * 1_145) / 1_263) } });
    for (let y = 0; y < whole.bitmap.height; y++) expect(Math.abs(rowAt(whole.bitmap.bitmap, 317, 0, y) - y), `row ${y}`).toBeLessThanOrEqual(1);

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
});

describe('area selection through the service', () => {
  const setups: ServiceSetup[] = [];
  afterEach(() => {
    for (const setup of setups.splice(0)) setup.cleanup();
  });

  test('area-selection-cancels', async () => {
    const setup = serviceSetup();
    setups.push(setup);
    const { service, tabs, state, raw, files } = setup;
    const tab = tabs.get(1)!;
    const cancels = () => tab.scripts.filter((s) => s.kind === 'cancel').length;
    /** Starts an area screenshot and waits for its selector to be up; answers the screenshot's (pending) answer. */
    const start = async (on = service, page = tab) => {
      page.selection = null;
      const answer = on.take(1, { kind: 'area' });
      await until(() => page.selection !== null);
      return { answer };
    };

    // A main-frame navigation (not an in-page one).
    let pending = (await start()).answer;
    tab.emit('did-start-navigation', fakeEvent({ url: 'https://example.com/page#top', isMainFrame: true, isSameDocument: true }));
    tab.emit('did-start-navigation', fakeEvent({ url: 'https://ads.example/frame', isMainFrame: false, isSameDocument: false }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tab.selection).not.toBeNull();
    tab.emit('did-start-navigation', fakeEvent({ url: 'https://example.com/next', isMainFrame: true, isSameDocument: false }));
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'cancelled' });
    expect(cancels()).toBe(1);

    // cancelArea (the chrome's Cancel); another tab's, or a tab without one, cancels nothing.
    pending = (await start()).answer;
    await expect(service.cancelArea(2)).resolves.toBe(false);
    await expect(service.cancelArea(1)).resolves.toBe(true);
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'cancelled' });
    await expect(service.cancelArea(1)).resolves.toBe(false);
    expect(cancels()).toBe(2);

    // Another tab brought to the front.
    pending = (await start()).answer;
    state.active = 2;
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'cancelled' });
    state.active = 1;

    // The timeout (a service of its own, with a short one).
    const short = serviceSetup({ limits: { ...SCREENSHOT_LIMITS, areaTimeoutMs: 50 } });
    setups.push(short);
    const shortTab = short.tabs.get(1)!;
    await expect((await start(short.service, shortTab)).answer).resolves.toEqual({ status: 'refused', reason: 'cancelled' });
    expect(shortTab.scripts.filter((s) => s.kind === 'cancel')).toHaveLength(1);

    // The tab closing (its WebContents destroyed).
    pending = (await start()).answer;
    tab.destroyed = true;
    tab.emit('destroyed');
    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'cancelled' });

    // Nothing was written, and no listener was left on the tab.
    expect(raw.prepare('SELECT count(*) AS n FROM ci_screenshots').get()).toEqual({ n: 0 });
    expect(() => readdirSync(files.dir)).toThrow();
    expect(tab.listenerCount('did-start-navigation')).toBe(0);
    expect(tab.listenerCount('destroyed')).toBe(0);
  });
});
