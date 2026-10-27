// Spec: specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES, HIGHLIGHT_STYLES), specs/seo-limits.spec.ts (SEO_WORLD_ID, HIGHLIGHT_BUDGET_MS)
// Acceptance: specs/seo-panels.feature.md (Highlight)
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES } from '@app/specs/seo-sidebar.spec';
import { highlightEndedScript, highlightScript, OVERLAY_CONFIG, OVERLAY_KEY, paintHighlight, planHighlight, runHighlight, watchHighlight, type HighlightItem, type OverlayDocument, type OverlayState } from '../highlight';

const rect = (left: number, top: number, width: number, height: number): HighlightItem['rect'] => ({ left, top, width, height });

describe('highlight plan (pure)', () => {
  test('highlight-plan-is-pure', () => {
    const items: HighlightItem[] = [
      { kind: 'internal', rect: rect(10.4, 20.6, 100.2, 18) },
      { kind: 'nofollow', rect: rect(0, -50, 40, 10) },
      // Hidden or collapsed: skipped.
      { kind: 'external', rect: rect(0, 0, 0, 0) },
      { kind: 'external', rect: rect(5, 5, 30, 0.5) },
      { kind: 'other', rect: rect(Number.NaN, 0, 10, 10) },
      { kind: 'h2', rect: rect(1, 2, 3, 4) },
    ];
    const boxes = planHighlight(items, { x: 0, y: 1_000 }, HIGHLIGHT_STYLES, 10);
    expect(boxes).toEqual([
      { kind: 'internal', label: 'int', color: HIGHLIGHT_STYLES.internal.color, x: 10, y: 1_021, width: 100, height: 18 },
      { kind: 'nofollow', label: 'nofollow', color: HIGHLIGHT_STYLES.nofollow.color, x: 0, y: 950, width: 40, height: 10 },
      { kind: 'h2', label: 'H2', color: HIGHLIGHT_STYLES.h2.color, x: 1, y: 1_002, width: 3, height: 4 },
    ]);
    // Capped; the input is not touched.
    expect(planHighlight(items, { x: 0, y: 0 }, HIGHLIGHT_STYLES, 1)).toHaveLength(1);
    expect(items).toHaveLength(6);
    // Every kind has its own colour and a label.
    expect(new Set(Object.values(HIGHLIGHT_STYLES).map((s) => s.color)).size).toBe(Object.keys(HIGHLIGHT_STYLES).length);
  });
});

/** A rect at document-free viewport position. */
const domRect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** Lets the overlay's animation frames run (jsdom's `pretendToBeVisual` frames are about 16 ms apart). */
const frames = (n = 3) => new Promise((resolve) => setTimeout(resolve, 20 * n));

/** A jsdom page with layout stubbed: every `a` and heading gets a box at its index; a `ResizeObserver` that answers at once on `observe`, as Chromium's does. */
function pageWith(body: string, url = 'https://www.example.com/page') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`, { url, pretendToBeVisual: true });
  const { document } = dom.window;
  document.querySelectorAll('a, h1, h2, h3, h4, h5, h6').forEach((el, i) => {
    if (!el.hasAttribute('data-nobox')) el.getBoundingClientRect = () => domRect(10, 30 * i, 120, 20);
  });
  const observers: { fire(width: number, height: number): void; disconnected: boolean }[] = [];
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private readonly entry: { fire(width: number, height: number): void; disconnected: boolean };
    private readonly targets: unknown[] = [];
    constructor(callback: (entries: { target: unknown; contentRect: { width: number; height: number } }[]) => void) {
      this.entry = {
        // Every observed target, at `width` × `height`.
        fire: (width, height) => callback(this.targets.map((target) => ({ target, contentRect: { width, height } }))),
        disconnected: false,
      };
      observers.push(this.entry);
    }
    observe(target: unknown) {
      // Each target's initial observation, delivered separately (the overlay must not count either as a change).
      this.targets.push(target);
      queueMicrotask(() => {
        if (!this.entry.disconnected) this.entry.fire(1024, 768);
      });
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  };
  const before = document.documentElement.outerHTML;
  const store: Record<string, unknown> = {};
  const paint = (mode: 'off' | 'links' | 'headings', config = OVERLAY_CONFIG) => paintHighlight(document as unknown as OverlayDocument, mode, config, planHighlight, store);
  const state = () => store[OVERLAY_KEY] as OverlayState | undefined;
  /** The overlay's box elements, through the closed root it keeps in this world. */
  const boxes = () => [...((state()?.root as unknown as ShadowRoot | undefined)?.children ?? [])] as HTMLElement[];
  return { dom, document, before, store, paint, state, boxes, observers };
}

const PAGE = `<h1>Title</h1><p><a href="/a">Internal</a> <a href="https://example.com/b">Same site</a> <a href="https://other.org/">External</a>
  <a href="/c" rel="NoFollow">Nofollow</a> <a href="mailto:x@example.com">Mail</a> <a href="/hidden" data-nobox>Hidden</a></p><h2>Sub</h2><h3>Deeper</h3>`;

describe('highlight overlay (jsdom)', () => {
  test('highlight-draws-in-closed-shadow-root', async () => {
    const { document, before, paint, state } = pageWith(PAGE);
    const bodyBefore = document.body.outerHTML;
    const sheets = document.styleSheets.length;
    await expect(paint('links')).resolves.toEqual({ mode: 'links', boxes: 5 });
    // One host element of its own, last in <html>; its shadow root is closed (invisible from outside).
    const host = document.documentElement.lastElementChild as HTMLElement;
    expect(document.documentElement.children).toHaveLength(3);
    expect(host.localName).toBe('div');
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    // The page's own elements, stylesheets and markup are untouched.
    expect(document.body.outerHTML).toBe(bodyBefore);
    expect(document.styleSheets.length).toBe(sheets);
    expect(document.querySelectorAll('style, link[rel=stylesheet]')).toHaveLength(0);
    expect(state()!.mode).toBe('links');
    expect(state()!.boxes()).toBe(5);
    expect(document.documentElement.outerHTML).not.toBe(before);
    await paint('off');
  });

  test('highlight-kinds-and-labels', async () => {
    const { paint, boxes } = pageWith(PAGE);
    await paint('links');
    expect(boxes().map((b) => b.textContent)).toEqual(['int', 'int', 'ext', 'nofollow', 'other']);
    expect(boxes()[2]!.style.getPropertyValue('border-style')).toBe('solid');
    expect(boxes().every((b) => b.style.getPropertyValue('position') === 'absolute')).toBe(true);
    await paint('headings');
    expect(boxes().map((b) => b.textContent)).toEqual(['H1', 'H2', 'H3']);
    // No markup parsing anywhere: labels are text nodes.
    expect(boxes()[0]!.querySelector('span')!.childNodes[0]!.nodeType).toBe(3);
    await paint('off');
  });

  test('highlight-link-kind-counts-the-port', async () => {
    // Same host name, another port: another host, as the extractor says (`LinkSchema.kind`).
    const { paint, boxes } = pageWith('<a href="https://example.com:8443/x">Port</a><a href="https://example.com:443/y">Default</a><a href="/z">Here</a>', 'https://example.com/page');
    await paint('links');
    expect(boxes().map((b) => b.textContent)).toEqual(['ext', 'int', 'int']);
    await paint('off');
  });

  test('highlight-switch-replaces-overlay', async () => {
    const { document, paint, state } = pageWith(PAGE);
    await paint('links');
    await expect(paint('headings')).resolves.toEqual({ mode: 'headings', boxes: 3 });
    expect(document.documentElement.children).toHaveLength(3);
    expect(state()!.mode).toBe('headings');
    await paint('off');
  });

  test('highlight-off-removes-everything', async () => {
    const { dom, document, before, paint, state } = pageWith(PAGE);
    const view = dom.window as unknown as Window;
    const added = vi.spyOn(view, 'addEventListener');
    const removed = vi.spyOn(view, 'removeEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');
    await paint('links');
    const first = state()!;
    await paint('links');
    await expect(first.ended).resolves.toBe('replaced');
    const second = state()!;
    await expect(paint('off')).resolves.toEqual({ mode: 'off', boxes: 0 });
    await expect(second.ended).resolves.toBe('off');
    expect(document.documentElement.outerHTML).toBe(before);
    expect(state()).toBeUndefined();
    // Every listener it added (window resize and pagehide, the document's capture-phase scroll) is removed again.
    const pairs = [...added.mock.calls.map((call) => [view, call] as const), ...docAdded.mock.calls.map((call) => [document, call] as const)];
    expect(pairs.map(([, [type]]) => type).sort()).toEqual(['pagehide', 'pagehide', 'resize', 'resize', 'scroll', 'scroll']);
    for (const [target, [type, listener, options]] of pairs) {
      const calls = (target === view ? removed : docRemoved).mock.calls;
      expect(calls.some(([t, l, o]) => t === type && l === listener && (o as { capture?: boolean } | undefined)?.capture === (options as { capture?: boolean } | undefined)?.capture), String(type)).toBe(true);
    }
    expect(docAdded.mock.calls.find(([type]) => type === 'scroll')![2]).toEqual({ capture: true, passive: true });
    // Off when nothing is drawn is a no-op.
    await expect(paint('off')).resolves.toEqual({ mode: 'off', boxes: 0 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('highlight-is-bounded', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/l${i}">l</a>`).join('');
    const { paint } = pageWith(links);
    await expect(paint('links', { ...OVERLAY_CONFIG, maxLinks: 7 })).resolves.toMatchObject({ boxes: 7 });
    // Past its budget it draws what it measured so far.
    await expect(paint('links', { ...OVERLAY_CONFIG, budgetMs: -1 })).resolves.toMatchObject({ boxes: 0 });
    await paint('off');
  });

  test('highlight-measures-across-frames', async () => {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/l${i}">l</a>`).join('');
    const { document, paint } = pageWith(links);
    // Each rect read costs 1 ms: with an 8 ms slice the 40 reads take several frames, and all land.
    for (const a of document.links) {
      const rect = a.getBoundingClientRect;
      a.getBoundingClientRect = () => {
        const end = performance.now() + 1;
        while (performance.now() < end) {
          // Busy, like a slow layout read.
        }
        return rect.call(a);
      };
    }
    const frameSpy = vi.spyOn(document.defaultView!, 'requestAnimationFrame');
    await expect(paint('links')).resolves.toMatchObject({ boxes: 40 });
    expect(frameSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    await paint('off');
  });

  test('highlight-draws-once-per-toggle', async () => {
    const { paint, state, observers } = pageWith(PAGE);
    await paint('links');
    await frames();
    // The ResizeObserver's initial observations are skipped: one toggle, one drawing pass.
    expect(observers).toHaveLength(1);
    expect(state()!.draws()).toBe(1);
    await paint('off');
  });

  test('highlight-reuses-boxes', async () => {
    const { dom, document, paint, state, boxes, observers } = pageWith(PAGE);
    await paint('links');
    await frames();
    const before = boxes();
    const h1 = document.querySelector('a')!;
    h1.getBoundingClientRect = () => domRect(40, 300, 60, 20);
    // A burst of layout events: one more pass, on the same elements, the moved box rewritten.
    observers[0]!.fire(1024, 900);
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await frames();
    expect(state()!.draws()).toBe(2);
    const after = boxes();
    expect(after).toHaveLength(before.length);
    after.forEach((box, i) => expect(box).toBe(before[i]));
    expect(after[0]!.style.getPropertyValue('top')).toBe('300px');
    expect(after[0]!.style.getPropertyValue('left')).toBe('40px');
    await paint('off');
  });

  test('highlight-follows-scrolling', async () => {
    const { dom, document, paint, state, boxes } = pageWith('<div id="pane"><a href="/in-pane">In a pane</a></div><a id="fixed" href="/fixed">Fixed</a>');
    const inPane = document.querySelector('#pane a')!;
    const fixed = document.getElementById('fixed')!;
    inPane.getBoundingClientRect = () => domRect(10, 100, 80, 20);
    fixed.getBoundingClientRect = () => domRect(10, 10, 80, 20);
    await paint('links');
    expect(boxes().map((b) => b.style.getPropertyValue('top'))).toEqual(['100px', '10px']);
    // An inner scroll container scrolls (its `scroll` event does not bubble; the capture listener hears it).
    inPane.getBoundingClientRect = () => domRect(10, 40, 80, 20);
    document.getElementById('pane')!.dispatchEvent(new dom.window.Event('scroll'));
    await frames();
    expect(boxes()[0]!.style.getPropertyValue('top')).toBe('40px');
    // The page scrolls 500 px: a fixed element stays in the viewport, so its box moves down the document.
    Object.defineProperty(dom.window, 'scrollY', { value: 500, configurable: true });
    document.dispatchEvent(new dom.window.Event('scroll'));
    await frames();
    expect(boxes()[1]!.style.getPropertyValue('top')).toBe('510px');
    const draws = state()!.draws();
    await paint('off');
    // Stopped: scrolling draws nothing.
    document.dispatchEvent(new dom.window.Event('scroll'));
    await frames();
    expect(draws).toBe(3);
  });

  test('highlight-stops-when-page-removes-host', async () => {
    const { dom, document, before, paint, state } = pageWith(PAGE);
    await paint('links');
    const drawn = state()!;
    // The page takes the host out; the next redraw notices, stops and reports it.
    document.documentElement.lastElementChild!.remove();
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await expect(drawn.ended).resolves.toBe('removed');
    expect(state()).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('highlight-ends-with-the-page', async () => {
    const { dom, paint, state } = pageWith(PAGE);
    await paint('links');
    const drawn = state()!;
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await expect(drawn.ended).resolves.toBe('gone');
    expect(state()).toBeUndefined();
  });
});

describe('highlight script', () => {
  test('highlight-script-is-self-contained', () => {
    for (const mode of ['off', 'links', 'headings'] as const) {
      const script = highlightScript(mode);
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain(`, ${JSON.stringify(mode)}, ${JSON.stringify(OVERLAY_CONFIG)}, `);
      // DOM APIs only: no markup, no stylesheets, no Node or Electron.
      for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/, /\badoptedStyleSheets\b/, /CSSStyleSheet/, /createElement\(['"]style/, /setAttribute\(['"]style/, /\.cssText\b/, /\beval\s*\(/, /\brequire\s*\(/, /\bprocess\./, /\bipcRenderer\b/]) {
        expect(script, String(forbidden)).not.toMatch(forbidden);
      }
    }
  });

  test('highlight-ended-script-answers-the-reason', async () => {
    expect(() => new Function(highlightEndedScript())).not.toThrow();
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => 'removed') };
    await expect(watchHighlight(contents)).resolves.toBe('removed');
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(SEO_WORLD_ID, [{ code: highlightEndedScript() }]);
  });

  test('highlight-runs-in-seo-world', async () => {
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => ({ mode: 'links', boxes: 3 })) };
    await expect(runHighlight(contents, 'links')).resolves.toEqual({ mode: 'links', boxes: 3 });
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(SEO_WORLD_ID, [{ code: highlightScript('links') }]);
  });
});
