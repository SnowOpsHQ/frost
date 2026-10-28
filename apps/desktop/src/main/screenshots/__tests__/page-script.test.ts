// Spec: specs/screenshot.spec.ts (SCREENSHOT_WORLD_ID, SCREENSHOT_LIMITS, AREA_SELECT_HINT)
// Acceptance: specs/screenshot.feature.md (Kinds: Area; Scenarios area-select-needs-trusted-events,
// area-select-leaves-page-dom-unchanged, page-scripts-are-self-contained)
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { SCREENSHOT_WORLD_ID } from '@app/specs/screenshot.spec';
import {
  AREA_CONFIG,
  AREA_STATE_KEY,
  cancelAreaScript,
  measurePage,
  measureScript,
  parseArea,
  parseMeasure,
  restoreScript,
  runCancelArea,
  runMeasure,
  runRestore,
  runScroll,
  runSelectArea,
  scrollAndSettle,
  scrollScript,
  selectArea,
  selectAreaScript,
  type AreaConfig,
  type ScriptDocument,
} from '../page-script';

// jsdom marks every `dispatchEvent` untrusted, as browsers do. A trusted event (the user's own
// input) is delivered through jsdom's internal dispatch, here in the test only.
const require = createRequire(import.meta.url);
const { implForWrapper } = require('jsdom/lib/generated/idl/utils.js') as { implForWrapper(wrapper: unknown): { isTrusted: boolean; _dispatch(event: unknown): boolean } };

function page(body = '<header>Fixed</header><main><h1>Title</h1><p>Text of the page.</p></main>') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`, { url: 'https://example.com/page', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  const before = document.documentElement.outerHTML;
  const store: Record<string, unknown> = {};
  const host = () => (document.documentElement.childElementCount > 2 ? (document.documentElement.lastElementChild as HTMLElement) : null);
  /** The element a pointer at the viewport hits: the overlay's surface while it is up (jsdom has no hit testing). */
  let surface: Element | null = null;
  const trusted = <E extends Event>(target: EventTarget, event: E): E => {
    implForWrapper(event).isTrusted = true;
    implForWrapper(target)._dispatch(implForWrapper(event));
    return event;
  };
  const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) => new window.PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, composed: true, cancelable: true, ...init });
  const drag = (from: [number, number], to: [number, number], target = surface!) => {
    trusted(target, pointer('pointerdown', ...from));
    trusted(target, pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    trusted(target, pointer('pointermove', ...to));
    trusted(target, pointer('pointerup', ...to));
  };
  const esc = () => trusted(document.body, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const config: AreaConfig = { ...AREA_CONFIG, timeoutMs: 5_000, settleFrames: 1 };
  /** Starts a selection; `surface` is found through the closed root's state the selector keeps in this world. */
  const start = (overrides: Partial<AreaConfig> = {}) => {
    const result = selectArea(document as unknown as ScriptDocument, { ...config, ...overrides }, store);
    const state = store[AREA_STATE_KEY] as { surface?: Element } | undefined;
    surface = state?.surface ?? null;
    return result;
  };
  return { dom, window, document, before, store, host, start, drag, esc, pointer, trusted, surface: () => surface };
}

describe('measure, scroll and restore', () => {
  test('page-measure-reads-the-viewport', async () => {
    const { document, window } = page();
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3_000, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1_009, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 760, configurable: true });
    const measure = measurePage(document as unknown as ScriptDocument);
    expect(measure).toEqual({ url: 'https://example.com/page', scrollHeight: 3_000, innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: 1_009, clientHeight: 760, scrollX: 0, scrollY: 0, devicePixelRatio: 1 });
    expect(parseMeasure(measure)).toEqual(measure);
    // A page taller than anything sane is taken as MAX tall (the stitch is cut and marked truncated), not refused.
    expect(parseMeasure({ ...measure, scrollHeight: 1e12 })).toMatchObject({ scrollHeight: 10_000_000 });
    // Untrusted answers: anything not a finite, sane number is refused.
    for (const bad of [null, 'x', { ...measure, scrollHeight: -1 }, { ...measure, scrollHeight: Number.POSITIVE_INFINITY }, { ...measure, innerWidth: Number.NaN }, { ...measure, innerWidth: 0 }, { ...measure, url: 5 }, { ...measure, devicePixelRatio: 0 }]) expect(parseMeasure(bad), JSON.stringify(bad)).toBeNull();

    const scrolls: unknown[] = [];
    window.scrollTo = ((options: ScrollToOptions) => {
      scrolls.push(options);
      Object.defineProperty(window, 'scrollY', { value: options.top, configurable: true });
      Object.defineProperty(window, 'scrollX', { value: options.left, configurable: true });
    }) as typeof window.scrollTo;
    await expect(scrollAndSettle(document as unknown as ScriptDocument, { x: 0, y: 1_200, frames: 2, timeoutMs: 1_000 })).resolves.toEqual({ x: 0, y: 1_200 });
    // Instant, whatever the page's `scroll-behavior` says.
    expect(scrolls).toEqual([{ left: 0, top: 1_200, behavior: 'instant' }]);
    // The animation frames never come (a hidden page): the timeout answers.
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
    await expect(scrollAndSettle(document as unknown as ScriptDocument, { x: 0, y: 40, frames: 2, timeoutMs: 30 })).resolves.toEqual({ x: 0, y: 40 });
  });

  test('page-scripts-are-self-contained', async () => {
    // Each script runs on its own: no module scope, only its document and the world's global.
    for (const script of [measureScript(), scrollScript(0, 10), restoreScript(3, 4), selectAreaScript(), cancelAreaScript()]) {
      expect(() => new vm.Script(script)).not.toThrow();
      expect(script).not.toMatch(/\bimport\b|\brequire\(/);
    }
    const { dom, document, before } = page();
    const context = dom.getInternalVMContext();
    expect(vm.runInContext(measureScript(), context)).toMatchObject({ url: 'https://example.com/page' });
    expect(vm.runInContext(cancelAreaScript(), context)).toBe(false);
    const pending = vm.runInContext(selectAreaScript(), context) as Promise<unknown>;
    expect(document.documentElement.childElementCount).toBe(3);
    expect(vm.runInContext(cancelAreaScript(), context)).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(document.documentElement.outerHTML).toBe(before);

    // Only in the screenshot world; answers are untrusted and parsed.
    const calls: [number, string][] = [];
    const answers: unknown[] = [{ url: 'https://example.com/', scrollHeight: 10, innerWidth: 5, innerHeight: 5, clientWidth: 5, clientHeight: 5, scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, { x: 0, y: 7 }, { x: 0, y: 0 }, { x: 1, y: 2, width: 30, height: 40 }, true];
    const target = { executeJavaScriptInIsolatedWorld: vi.fn(async (world: number, scripts: { code: string }[]) => (calls.push([world, scripts[0]!.code]), answers.shift())) };
    await expect(runMeasure(target)).resolves.toMatchObject({ scrollHeight: 10 });
    await expect(runScroll(target, 0, 7)).resolves.toEqual({ x: 0, y: 7 });
    await expect(runRestore(target, 0, 0)).resolves.toEqual({ x: 0, y: 0 });
    await expect(runSelectArea(target)).resolves.toEqual({ x: 1, y: 2, width: 30, height: 40 });
    await expect(runCancelArea(target)).resolves.toBe(true);
    expect(calls.every(([world]) => world === SCREENSHOT_WORLD_ID)).toBe(true);
    expect(calls).toHaveLength(5);
    // An area answer that is not a whole, positive rectangle (or `null`) is refused.
    expect(parseArea(null)).toBeNull();
    for (const bad of [{ x: -1, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 5 }, { x: 0.5, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 5 }, 'x', { x: 0, y: 0, width: 5, height: 5, extra: 1 }]) expect(parseArea(bad), JSON.stringify(bad)).toBe('invalid');
  });
});

describe('area selector (jsdom)', () => {
  test('area-select-needs-trusted-events', async () => {
    const { document, before, host, start, drag, pointer, surface, window, store } = page();
    const bodyBefore = document.body.outerHTML;
    const result = start();
    let settled: unknown = 'pending';
    void result.then((value) => (settled = value));
    // One host of its own, last in <html>, behind a closed shadow root, styled through the CSSOM only.
    const overlay = host()!;
    expect(overlay).not.toBeNull();
    expect(overlay.shadowRoot).toBeNull();
    expect(overlay.getAttribute('style')).toContain('crosshair');
    expect(overlay.style.getPropertyPriority('position')).toBe('important');
    expect(document.querySelectorAll('style, link[rel=stylesheet]')).toHaveLength(0);
    expect(document.body.outerHTML).toBe(bodyBefore);

    // The page's own events select nothing: on the host, on the page, even on the overlay's surface.
    for (const target of [overlay, document.body, document.documentElement, surface()!]) {
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) target.dispatchEvent(pointer(type, type === 'pointerdown' ? 10 : 200, type === 'pointerdown' ? 10 : 150));
    }
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe('pending');
    expect(host()).toBe(overlay);

    // A click-sized drag selects nothing; the selection goes on.
    drag([50, 50], [52, 51]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe('pending');

    // The user's drag, either way round, resolves its rectangle (whole CSS px), once the overlay is gone.
    drag([210.6, 160.2], [20.4, 30.7]);
    await expect(result).resolves.toEqual({ x: 20, y: 30, width: 191, height: 131 });
    expect(host()).toBeNull();
    expect(store[AREA_STATE_KEY]).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('area-select-leaves-page-dom-unchanged', async () => {
    // A trusted Esc.
    const esc = page();
    const viaEsc = esc.start();
    expect(esc.host()).not.toBeNull();
    esc.esc();
    await expect(viaEsc).resolves.toBeNull();
    expect(esc.host()).toBeNull();
    expect(esc.document.documentElement.outerHTML).toBe(esc.before);

    // The cancel script (main's cancelArea, a navigation, the tab closing).
    const cancelled = page();
    const viaCancel = cancelled.start();
    expect(vm.runInContext(cancelAreaScript(), cancelled.dom.getInternalVMContext())).toBe(false); // another world's global: not this selection
    const pending = cancelled.store[AREA_STATE_KEY] as { cancel(): void };
    pending.cancel();
    await expect(viaCancel).resolves.toBeNull();
    expect(cancelled.document.documentElement.outerHTML).toBe(cancelled.before);

    // The timeout.
    const late = page();
    const viaTimeout = late.start({ timeoutMs: 40 });
    await expect(viaTimeout).resolves.toBeNull();
    expect(late.document.documentElement.outerHTML).toBe(late.before);

    // A second selection replaces the first (which resolves null), and every listener goes with it.
    const twice = page();
    const add = vi.spyOn(twice.window, 'addEventListener');
    const remove = vi.spyOn(twice.window, 'removeEventListener');
    const first = twice.start();
    const second = twice.start();
    await expect(first).resolves.toBeNull();
    expect(twice.document.documentElement.childElementCount).toBe(3);
    twice.esc();
    await expect(second).resolves.toBeNull();
    expect(twice.document.documentElement.outerHTML).toBe(twice.before);
    const added = add.mock.calls.map(([type]) => type).sort();
    const removed = remove.mock.calls.map(([type]) => type).sort();
    expect(added.length).toBeGreaterThan(0);
    expect(removed).toEqual(added);

    // The page taking the host out ends it too (no Esc, no cancel), and every listener goes.
    const removedHost = page();
    const viaRemoval = removedHost.start();
    const host = removedHost.host()!;
    const { surface } = removedHost.store[AREA_STATE_KEY] as { surface: Element };
    host.remove();
    await expect(viaRemoval).resolves.toBeNull();
    expect(removedHost.store[AREA_STATE_KEY]).toBeUndefined();
    expect(removedHost.document.documentElement.outerHTML).toBe(removedHost.before);
    // Appended again by the page, the old host is inert: hidden, its shadow root empty, deaf to input.
    removedHost.document.documentElement.append(host);
    expect(host.style.getPropertyValue('display')).toBe('none');
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(surface.isConnected).toBe(false);
    removedHost.drag([10, 10], [200, 200], surface);
    removedHost.esc();
    expect(removedHost.store[AREA_STATE_KEY]).toBeUndefined();
  });
});
