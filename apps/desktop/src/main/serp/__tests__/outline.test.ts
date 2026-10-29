// Spec: specs/serp-service.spec.ts (SERP_OUTLINE_STYLES, SERP_OUTLINE_LIMITS, SERP_OUTLINE_KEY), specs/serp.spec.ts
// (SERP_WORLD_ID, SERP_READ_LIMITS), specs/serp-snapshot.schema.ts (SerpReadSchema: block and item boxes)
// Acceptance: specs/serp-overlay.feature.md (Outlines)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import type { EngineLayout } from '@app/specs/serp-selector-pack.schema';
import { SERP_RESULT_TYPES } from '@app/specs/serp-selector-pack.spec';
import { SERP_OUTLINE_KEY, SERP_OUTLINE_LIMITS, SERP_OUTLINE_STYLES } from '@app/specs/serp-service.spec';
import { SERP_READ_LIMITS, SERP_WORLD_ID } from '@app/specs/serp.spec';
import { OVERLAY_KEY } from '../../seo/highlight';
import { BUNDLED_PACK } from '../bundled';
import { outlineEndedScript, outlineScript, OUTLINE_CONFIG, paintOutlines, planOutlines, runOutline, watchOutline, type OutlineDocument, type OutlineState } from '../outline';
import { verifyPack } from '../pack-verify';
import { readSerp } from '../read-script';
import { SERP_PACK_PUBLIC_KEYS } from '@app/specs/serp-selector-pack.spec';

const rect = (x: number, y: number, width = 600, height = 80) => ({ x, y, width, height });

describe('outline plan (pure)', () => {
  test('serp-outline-plan-per-type', () => {
    const blocks = [
      { type: 'ad', items: [{ title: 'A1', url: 'https://ads.example/', rect: rect(10, 0) }], rect: rect(10, 0) },
      { type: 'featured-snippet', items: [{ title: 'F', url: 'https://f.example/', rect: rect(10, 100, 600, 40) }], rect: rect(10, 100, 600, 200) },
      {
        type: 'organic',
        items: [
          { title: 'O1', url: 'https://one.example/', rect: rect(10, 320.4, 600.6, 80) },
          // No box (hidden): skipped, but it still counts as organic result 2.
          { title: 'O2', url: 'https://two.example/' },
          { title: 'O3', url: 'https://three.example/', rect: rect(10, 500) },
        ],
        rect: rect(10, 320, 600, 260),
      },
      { type: 'people-also-ask', items: [{ title: 'Q?', url: null }], rect: rect(10, 600, 600, 150) },
      { type: 'organic', items: [{ title: 'O4', url: 'https://four.example/', rect: rect(10, 800) }] },
      { type: 'ad', items: [{ title: 'A2', url: 'https://ads.example/2', rect: rect(10, 900) }] },
    ];
    const boxes = planOutlines(blocks, { x: 0, y: 0 }, SERP_OUTLINE_STYLES, 50);
    expect(boxes.map((b) => b.label)).toEqual(['Ad 1', 'Featured snippet', 'Organic 1', 'Organic 3', 'Related questions', 'Organic 4', 'Ad 2']);
    expect(boxes[0]).toEqual({ type: 'ad', label: 'Ad 1', color: SERP_OUTLINE_STYLES.ad.color, x: 10, y: 0, width: 600, height: 80 });
    // A feature is one box: its block's (the union of its items').
    expect(boxes[1]).toMatchObject({ type: 'featured-snippet', y: 100, height: 200 });
    expect(boxes[2]).toMatchObject({ type: 'organic', x: 10, y: 320, width: 601, height: 80 });
    // Every type has its own colour and a label.
    expect(new Set(SERP_RESULT_TYPES.map((type) => SERP_OUTLINE_STYLES[type].color)).size).toBe(SERP_RESULT_TYPES.length);
    for (const type of SERP_RESULT_TYPES) expect(SERP_OUTLINE_STYLES[type].label.length).toBeGreaterThan(0);
    // The scroll offset moves every box.
    expect(planOutlines(blocks, { x: 5, y: 1_000 }, SERP_OUTLINE_STYLES, 50)[0]).toMatchObject({ x: 15, y: 1_000 });
    expect(planOutlines(blocks, { x: Number.NaN, y: Number.POSITIVE_INFINITY }, SERP_OUTLINE_STYLES, 50)[0]).toMatchObject({ x: 10, y: 0 });
  });

  test('serp-outline-plan-is-defensive', () => {
    // The reader's answer is page data: anything malformed is no box, never a throw or a page string.
    const hostile = [
      null,
      7,
      'organic',
      { type: 'organic' },
      { type: 'organic', items: 'x' },
      { type: '__proto__', items: [{ rect: rect(0, 0) }], rect: rect(0, 0) },
      { type: 'toString', items: [{ rect: rect(0, 0) }], rect: rect(0, 0) },
      { type: 'not-a-type', items: [{ rect: rect(0, 0) }], rect: rect(0, 0) },
      { type: 'video', items: [], rect: { x: '1', y: 0, width: 10, height: 10 } },
      { type: 'video', items: [], rect: { x: 0, y: 0, width: 0, height: 10 } },
      { type: 'video', items: [], rect: { x: 2_000_000, y: 0, width: 10, height: 10 } },
      { type: 'organic', items: [null, { rect: null }, { rect: { x: Number.NaN, y: 0, width: 5, height: 5 } }, { rect: rect(1, 2, 3, 4), title: '<img onerror=x>' }] },
    ];
    const boxes = planOutlines(hostile, { x: 0, y: 0 }, SERP_OUTLINE_STYLES, 50);
    expect(boxes).toEqual([{ type: 'organic', label: 'Organic 4', color: SERP_OUTLINE_STYLES.organic.color, x: 1, y: 2, width: 3, height: 4 }]);
    expect(planOutlines('nope' as unknown as unknown[], { x: 0, y: 0 }, SERP_OUTLINE_STYLES, 50)).toEqual([]);
  });

  test('serp-outlines-capped', () => {
    const many = [{ type: 'organic', items: Array.from({ length: 500 }, (_, i) => ({ title: `r${i}`, url: `https://r${i}.example/`, rect: rect(0, i * 90) })) }];
    expect(planOutlines(many, { x: 0, y: 0 }, SERP_OUTLINE_STYLES, SERP_OUTLINE_LIMITS.maxBoxes)).toHaveLength(SERP_OUTLINE_LIMITS.maxBoxes);
    expect(planOutlines(many, { x: 0, y: 0 }, SERP_OUTLINE_STYLES, 3).map((b) => b.label)).toEqual(['Organic 1', 'Organic 2', 'Organic 3']);
    expect(OUTLINE_CONFIG.maxBoxes).toBe(SERP_OUTLINE_LIMITS.maxBoxes);
    expect(OUTLINE_CONFIG.limits).toEqual(SERP_READ_LIMITS);
  });
});

const LAYOUT: EngineLayout = { results: '#results', blocks: [{ type: 'organic', container: '#results', item: '.r', link: 'a', title: 'h3', required: true }] };

/** Lets the overlay's timers and animation frames run. */
const frames = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Waits until `check` holds (or 3 s pass). The overlay waits at least four times its last pass's
 * cost before the next, so on a loaded runner a fixed wait can end before a pass that is coming.
 */
async function settled(check: () => boolean): Promise<void> {
  const end = Date.now() + 3_000;
  while (!check() && Date.now() < end) await frames(20);
}

/** A jsdom page, a scripted reader (`answers` in turn, the last one repeated) and a ResizeObserver stub. */
function pageWith(answers: unknown[], body = '<div id="results"></div>') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`, { url: 'https://www.google.com/search?q=x', pretendToBeVisual: true });
  const { document } = dom.window;
  const observers: { fire(width: number, height: number): void }[] = [];
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private readonly targets: unknown[] = [];
    private live = true;
    constructor(private readonly callback: (entries: { target: unknown; contentRect: { width: number; height: number } }[]) => void) {
      observers.push({ fire: (width, height) => this.live && this.callback(this.targets.map((target) => ({ target, contentRect: { width, height } }))) });
    }
    observe(target: unknown) {
      this.targets.push(target);
      queueMicrotask(() => this.live && this.callback([{ target, contentRect: { width: 1024, height: 768 } }]));
    }
    disconnect() {
      this.live = false;
    }
  };
  let call = 0;
  const read = vi.fn((_document: unknown, _layout: EngineLayout, _limits: unknown) => answers[Math.min(call++, answers.length - 1)]);
  const store: Record<string, unknown> = {};
  const config = { ...OUTLINE_CONFIG, minIntervalMs: 10 };
  const paint = (layout: EngineLayout | null = LAYOUT, overrides = {}) => paintOutlines(document as unknown as OutlineDocument, layout, { ...config, ...overrides }, planOutlines, read as unknown as typeof readSerp, store);
  const state = () => store[SERP_OUTLINE_KEY] as OutlineState | undefined;
  const boxes = () => [...((state()?.root as unknown as ShadowRoot | undefined)?.children ?? [])] as HTMLElement[];
  return { dom, document, before: document.documentElement.outerHTML, read, paint, state, boxes, observers };
}

const answer = (...ys: number[]) => ({ ok: true, blocks: [{ type: 'organic', items: ys.map((y, i) => ({ title: `r${i}`, url: `https://r${i}.example/`, rect: rect(10, y) })) }], stats: { nodes: 1, elapsedMs: 0, truncated: false, organicCut: false } });

describe('outline overlay (jsdom)', () => {
  test('serp-outline-draws-in-closed-shadow-root', async () => {
    const { document, read, paint, state, boxes } = pageWith([answer(0, 100, 200)]);
    const bodyBefore = document.body.outerHTML;
    await expect(paint()).resolves.toEqual({ on: true, boxes: 3 });
    // One host element of its own, last in <html>, closed to the page; nothing else touched.
    const host = document.documentElement.lastElementChild as HTMLElement;
    expect(document.documentElement.children).toHaveLength(3);
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(document.body.outerHTML).toBe(bodyBefore);
    expect(document.querySelectorAll('style, link[rel=stylesheet]')).toHaveLength(0);
    // The page is read with the pack's layout and the reader's limits.
    expect(read).toHaveBeenCalledWith(document, LAYOUT, SERP_READ_LIMITS);
    expect(boxes().map((b) => b.textContent)).toEqual(['Organic 1', 'Organic 2', 'Organic 3']);
    expect(boxes()[1]!.style.getPropertyValue('top')).toBe('100px');
    expect(boxes()[1]!.style.getPropertyValue('border-color')).not.toBe('');
    // Labels are text nodes, never markup.
    expect(boxes()[0]!.querySelector('span')!.childNodes[0]!.nodeType).toBe(3);
    expect(state()!.boxes()).toBe(3);
    await paint(null);
  });

  test('serp-outline-follows-the-page', async () => {
    const { dom, document, paint, state, boxes, observers, read } = pageWith([answer(0, 100), answer(40, 140)]);
    await paint();
    await frames();
    // The ResizeObserver's first observations are not changes: one pass.
    expect(state()!.draws()).toBe(1);
    const kept = boxes();
    // A burst of scrolling and resizing: one more pass (coalesced), on the same box elements.
    document.dispatchEvent(new dom.window.Event('scroll'));
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    observers[0]!.fire(800, 600);
    document.dispatchEvent(new dom.window.Event('scroll'));
    await settled(() => state()!.draws() >= 2);
    await frames();
    expect(state()!.draws()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(boxes()).toEqual(kept);
    expect(boxes()[0]!.style.getPropertyValue('top')).toBe('40px');
    // An inner scroller's `scroll` (it does not bubble) is heard in the capture phase.
    document.getElementById('results')!.dispatchEvent(new dom.window.Event('scroll'));
    await settled(() => state()!.draws() >= 3);
    expect(state()!.draws()).toBe(3);
    await paint(null);
  });

  test('serp-outline-unreadable-draws-nothing', async () => {
    const { paint, boxes, dom, document, state } = pageWith([answer(0), { ok: false, reason: 'no-container', stats: { nodes: 0, elapsedMs: 0, truncated: false, organicCut: false } }]);
    await expect(paint()).resolves.toEqual({ on: true, boxes: 1 });
    // The page changed under the overlay and can no longer be read: stale boxes go.
    document.dispatchEvent(new dom.window.Event('scroll'));
    await settled(() => state()!.draws() >= 2);
    expect(boxes()).toHaveLength(0);
    expect(state()!.boxes()).toBe(0);
    // A reader that throws draws nothing either.
    const throwing = pageWith([]);
    throwing.read.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(throwing.paint()).resolves.toEqual({ on: true, boxes: 0 });
    await throwing.paint(null);
    await paint(null);
  });

  test('serp-outline-off-removes-everything', async () => {
    const { dom, document, before, paint, state } = pageWith([answer(0, 100)]);
    const view = dom.window as unknown as Window;
    // The overlay calls EventTarget's own methods on the window and the document (never theirs by name).
    const proto = dom.window.EventTarget.prototype;
    const added = vi.spyOn(proto, 'addEventListener');
    const removed = vi.spyOn(proto, 'removeEventListener');
    await paint();
    const first = state()!;
    await paint();
    await expect(first.ended).resolves.toBe('replaced');
    const second = state()!;
    await expect(paint(null)).resolves.toEqual({ on: false, boxes: 0 });
    await expect(second.ended).resolves.toBe('off');
    expect(document.documentElement.outerHTML).toBe(before);
    expect(state()).toBeUndefined();
    const ours = (spy: typeof added) => spy.mock.calls.map((call, i) => [spy.mock.contexts[i], call] as const).filter(([target]) => target === view || target === document);
    const pairs = ours(added);
    expect(pairs.map(([, [type]]) => type).sort()).toEqual(['pagehide', 'pagehide', 'resize', 'resize', 'scroll', 'scroll']);
    for (const [target, [type, listener, options]] of pairs) {
      const calls = ours(removed);
      expect(calls.some(([t, [ty, l, o]]) => t === target && ty === type && l === listener && (o as { capture?: boolean } | undefined)?.capture === (options as { capture?: boolean } | undefined)?.capture), String(type)).toBe(true);
    }
    // Off with nothing drawn is a no-op; stopped, scrolling reads nothing.
    await expect(paint(null)).resolves.toEqual({ on: false, boxes: 0 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('serp-outline-resists-clobbering', async () => {
    // Named elements shadow `document`'s methods and getters in every world: the overlay still
    // draws, and off still removes everything, so main's "off" is never a lie. (The window's
    // listeners go through the same EventTarget methods, taken from the document's chain.)
    const names = ['addEventListener', 'removeEventListener', 'createElement', 'documentElement', 'defaultView', 'body', 'URL'];
    const { dom, document, before, paint, state, boxes } = pageWith([answer(0, 100)], `<div id="results"></div>${names.map((name) => `<img name="${name}">`).join('')}<form name="querySelector"></form>`);
    // The page's names really do shadow them here.
    for (const name of names) expect((document as unknown as Record<string, unknown>)[name], name).toBeInstanceOf(dom.window.HTMLImageElement);
    await expect(paint()).resolves.toEqual({ on: true, boxes: 2 });
    expect(boxes()).toHaveLength(2);
    const drawn = state()!;
    await expect(paint(null)).resolves.toEqual({ on: false, boxes: 0 });
    await expect(drawn.ended).resolves.toBe('off');
    expect(state()).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
    // Even if the page breaks a cleanup step, stop still removes the host and reports the end.
    await paint();
    const again = state()!;
    const disconnect = vi.spyOn(dom.window.EventTarget.prototype, 'removeEventListener').mockImplementation(() => {
      throw new Error('hostile');
    });
    await paint(null);
    disconnect.mockRestore();
    await expect(again.ended).resolves.toBe('off');
    expect(state()).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('serp-outline-only-on-the-expected-document', async () => {
    const { document, before, paint, state } = pageWith([answer(0)]);
    const config = { ...OUTLINE_CONFIG, minIntervalMs: 10 };
    const at = (url: string) => paintOutlines(document as unknown as OutlineDocument, LAYOUT, config, planOutlines, (() => answer(0)) as unknown as typeof readSerp, {}, url);
    // A paint meant for another document (it crossed a navigation) installs nothing.
    await expect(at('https://www.google.com/search?q=other')).resolves.toEqual({ on: false, boxes: 0 });
    expect(document.documentElement.outerHTML).toBe(before);
    // The fragment aside, the same document draws.
    const store: Record<string, unknown> = {};
    await expect(paintOutlines(document as unknown as OutlineDocument, LAYOUT, config, planOutlines, (() => answer(0)) as unknown as typeof readSerp, store, 'https://www.google.com/search?q=x#top')).resolves.toEqual({ on: true, boxes: 1 });
    await paintOutlines(document as unknown as OutlineDocument, null, config, planOutlines, (() => answer(0)) as unknown as typeof readSerp, store);
    expect(state()).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('serp-outline-ends-when-page-removes-host', async () => {
    const { dom, document, before, paint, state } = pageWith([answer(0)]);
    await paint();
    const drawn = state()!;
    document.documentElement.lastElementChild!.remove();
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await expect(drawn.ended).resolves.toBe('removed');
    expect(state()).toBeUndefined();
    expect(document.documentElement.outerHTML).toBe(before);
    // Left (`pagehide`): `gone`.
    const other = pageWith([answer(0)]);
    await other.paint();
    const shown = other.state()!;
    other.dom.window.dispatchEvent(new other.dom.window.Event('pagehide'));
    await expect(shown.ended).resolves.toBe('gone');
  });

  test('serp-outline-with-the-real-reader', async () => {
    // The bundled pack's Google layout and the real reader on frost's synthetic fixture, layout stubbed.
    const verified = verifyPack(BUNDLED_PACK.bytes, BUNDLED_PACK.signature, SERP_PACK_PUBLIC_KEYS);
    if (!verified.ok) throw new Error('bundled pack');
    const google = verified.pack.engines.find((engine) => engine.id === 'google')!;
    const html = readFileSync(path.join(__dirname, 'fixtures', 'google.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'https://www.google.com/search?q=running+shoes', pretendToBeVisual: true });
    let y = 0;
    dom.window.Element.prototype.getBoundingClientRect = function () {
      y += 50;
      return { left: 10, top: y, width: 500, height: 40, right: 510, bottom: y + 40, x: 10, y, toJSON: () => ({}) } as DOMRect;
    };
    const store: Record<string, unknown> = {};
    // The reader's time budget is the spec's 150 ms; a cold jsdom read on a loaded CI runner can pass
    // it and read nothing. This test checks what is outlined, not how fast (read-script.test.ts does).
    const reader: typeof readSerp = (doc, layout, limits) => readSerp(doc, layout, { ...limits, budgetMs: 10_000 });
    const result = await paintOutlines(dom.window.document as unknown as OutlineDocument, google.layout, OUTLINE_CONFIG, planOutlines, reader, store);
    expect(result.on).toBe(true);
    expect(result.boxes).toBeGreaterThan(3);
    const labels = [...((store[SERP_OUTLINE_KEY] as OutlineState).root as unknown as ShadowRoot).children].map((b) => b.textContent);
    expect(labels).toContain('Organic 1');
    expect(labels).toContain('Ad 1');
    await paintOutlines(dom.window.document as unknown as OutlineDocument, null, OUTLINE_CONFIG, planOutlines, reader, store);
  });
});

describe('outline script', () => {
  test('serp-outline-script-is-self-contained', () => {
    for (const layout of [LAYOUT, null]) {
      const script = outlineScript(layout, 'https://www.google.com/search?q=x');
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain(`(document, ${JSON.stringify(layout)}, ${JSON.stringify(OUTLINE_CONFIG)}, `);
      // The expected document's URL is JSON too (none for off: off removes whatever this world drew).
      expect(script.endsWith(`, globalThis, ${JSON.stringify(layout === null ? null : 'https://www.google.com/search?q=x')})`)).toBe(true);
      for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/, /\badoptedStyleSheets\b/, /CSSStyleSheet/, /createElement\(['"]style/, /setAttribute\(['"]style/, /\.cssText\b/, /\beval\s*\(/, /\brequire\s*\(/, /\bprocess\./, /\bipcRenderer\b/, /__vite/]) {
        expect(script, String(forbidden)).not.toMatch(forbidden);
      }
    }
    // A hostile selector stays a JSON string.
    const hostile: EngineLayout = { results: '"); alert(1); ("', blocks: [{ type: 'organic', container: '</script><script>x()</script>' }] };
    expect(outlineScript(hostile)).toContain(JSON.stringify(hostile.results));
    // Its own state, apart from Phase 2's highlight (another world, another key and host).
    expect(SERP_OUTLINE_KEY).not.toBe(OVERLAY_KEY);
    expect(SERP_WORLD_ID).not.toBe(SEO_WORLD_ID);
  });

  test('serp-outline-runs-in-serp-world', async () => {
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => ({ on: true, boxes: 2 })) };
    await expect(runOutline(contents, LAYOUT, 'https://www.google.com/search?q=x')).resolves.toEqual({ on: true, boxes: 2 });
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(SERP_WORLD_ID, [{ code: outlineScript(LAYOUT, 'https://www.google.com/search?q=x') }]);
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('removed' as never);
    await expect(watchOutline(contents)).resolves.toBe('removed');
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenLastCalledWith(SERP_WORLD_ID, [{ code: outlineEndedScript() }]);
    expect(() => new Function(outlineEndedScript())).not.toThrow();
  });
});
