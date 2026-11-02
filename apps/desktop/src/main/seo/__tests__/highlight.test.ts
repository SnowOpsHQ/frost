// Spec: specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES, HIGHLIGHT_STYLES, TextHighlightTarget, TEXT_HIGHLIGHT_UNMATCHED_NOTE),
// specs/seo-limits.spec.ts (SEO_WORLD_ID, HIGHLIGHT_BUDGET_MS, MAX_TEXT_HIGHLIGHT_TARGETS, MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET)
// Acceptance: specs/seo-panels.feature.md (Highlight), specs/seo-content.feature.md (Highlight, Phase 8)
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit } from '@app/seo-core';
import { MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET, MAX_TEXT_HIGHLIGHT_TARGETS, SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES, TEXT_HIGHLIGHT_UNMATCHED_NOTE, type TextHighlightTarget } from '@app/specs/seo-sidebar.spec';
import { highlightEndedScript, highlightScript, OVERLAY_CONFIG, OVERLAY_KEY, paintHighlight, planHighlight, planTextHighlight, runHighlight, watchHighlight, type HighlightItem, type OverlayDocument, type OverlayState } from '../highlight';
import { sentenceHighlightTargets } from '../highlight-targets';

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

// ---- Text highlight (Phase 8 Task 2) -------------------------------------------------------------

const long = (text: string): TextHighlightTarget => ({ text, kind: 'long-sentence' });

describe('text highlight plan (pure)', () => {
  // Text nodes as a page splits them: mid-word, at inline elements, with runs of white space.
  const TEXTS = ['Intro. ', 'The quick br', 'own fox ', '  jumps\n over', ' the dog.', ' And again: The quick brown fox jumps over the dog.'];

  test('plan-text-highlight-finds-excerpts', () => {
    const sentence = 'The quick brown fox jumps over the dog.';
    // Across nodes, the page's white space runs (and the excerpt's) read as one space; the first occurrence.
    expect(planTextHighlight(TEXTS, [long(sentence)], 20)).toEqual({ spans: [{ kind: 'long-sentence', start: [1, 0], end: [4, 9] }], unmatched: 0 });
    expect(planTextHighlight(TEXTS, [long('  The quick\tbrown  fox jumps over\nthe dog. ')], 20).spans).toEqual([{ kind: 'long-sentence', start: [1, 0], end: [4, 9] }]);
    // A start inside a white space run that joined the previous node's: the node's first letter.
    expect(planTextHighlight(TEXTS, [{ text: 'jumps over the dog.', kind: 'complex-sentence' }], 20).spans).toEqual([{ kind: 'complex-sentence', start: [3, 2], end: [4, 9] }]);
    // A second, equal excerpt (sentences come in page order) takes the next occurrence.
    const again = TEXTS[5]!.indexOf('The quick');
    expect(planTextHighlight(TEXTS, [long(sentence), long(sentence)], 20).spans).toEqual([
      { kind: 'long-sentence', start: [1, 0], end: [4, 9] },
      { kind: 'long-sentence', start: [5, again], end: [5, TEXTS[5]!.length] },
    ]);
    // A character outside the Basic Multilingual Plane is two code units, mapped as they are.
    expect(planTextHighlight(['Go 🚀 now', ' then stop.'], [long('🚀 now then stop.')], 20).spans).toEqual([{ kind: 'long-sentence', start: [0, 3], end: [1, 11] }]);
    // The input is not touched.
    expect(TEXTS).toHaveLength(6);
  });

  test('plan-text-highlight-unmatched-counted', () => {
    // Rewritten after the audit, never on the page, or empty: counted, never matched elsewhere.
    expect(planTextHighlight(TEXTS, [long('The quick brown fox jumps over the cat.'), long('Not on the page.'), long('   ')], 20)).toEqual({ spans: [], unmatched: 3 });
    // Bidi and zero-width characters match as the audit read them, and only so.
    const hostile = 'Price\u200b list \u202eevil\u202c here.';
    const page = ['Price\u200b list ', '\u202eevil\u202c here.'];
    expect(planTextHighlight(page, [long(hostile)], 20)).toEqual({ spans: [{ kind: 'long-sentence', start: [0, 0], end: [1, 12] }], unmatched: 0 });
    expect(planTextHighlight(page, [long('Price list evil here.')], 20)).toEqual({ spans: [], unmatched: 1 });
    // No text read (an empty page, or the walk read nothing in time): every target unmatched.
    expect(planTextHighlight([], [long('Anything.')], 20)).toEqual({ spans: [], unmatched: 1 });
  });

  test('sentence-highlight-targets', () => {
    const audit = (sentences: unknown) => ({ content: { sentences } }) as unknown as SeoAudit;
    const items = [
      { text: 'A very long sentence.', words: 30, reason: 'long' },
      { text: 'A dense one.', words: 14, reason: 'complex' },
    ];
    expect(sentenceHighlightTargets(audit({ status: 'ok', difficult: { total: 2, items } }))).toEqual([
      { text: 'A very long sentence.', kind: 'long-sentence' },
      { text: 'A dense one.', kind: 'complex-sentence' },
    ]);
    const many = Array.from({ length: MAX_TEXT_HIGHLIGHT_TARGETS + 4 }, (_, i) => ({ text: `Sentence ${i}.`, words: 30, reason: 'long' }));
    const capped = sentenceHighlightTargets(audit({ status: 'ok', difficult: { total: many.length, items: many } }));
    expect(capped).toHaveLength(MAX_TEXT_HIGHLIGHT_TARGETS);
    expect(capped[0]!.text).toBe('Sentence 0.');
    expect(sentenceHighlightTargets(audit({ status: 'not-available', reason: 'no-text' }))).toEqual([]);
    expect(sentenceHighlightTargets(audit({ status: 'ok', difficult: { total: 0, items: [] } }))).toEqual([]);
  });
});

/**
 * A jsdom page that runs scripts as the isolated world does (`window.eval`), `Range.getClientRects`
 * stubbed (jsdom has no layout): each range is `lines` line fragments, the first at its start offset
 * (the overlay makes one range per text node a sentence covers: "This sentence" and its rest are two).
 */
function textPage(body: string, lines = 2) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`, { url: 'https://example.com/article', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  (dom.window.Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = function (this: Range) {
    return Array.from({ length: lines }, (_, i) => domRect(i === 0 ? 10 + this.startOffset : 10, 100 + 20 * i, 200, 16));
  };
  const store = dom.window as unknown as Record<string, unknown>;
  const state = () => store[OVERLAY_KEY] as OverlayState | undefined;
  const children = () => [...((state()?.root as unknown as ShadowRoot | undefined)?.children ?? [])] as HTMLElement[];
  const geometry = () => children().map((el) => ['left', 'top', 'width', 'height', 'border-color'].map((name) => el.style.getPropertyValue(name)).join(' ') + ` ${el.textContent}`);
  return { dom, document: dom.window.document, store, state, children, geometry };
}

const ARTICLE = '<h1>Title</h1><p>Short one. <em>This sentence</em> runs on   and on.</p><p>Another long sentence here.</p>';

describe('text highlight overlay', () => {
  test('text-highlight-capped', async () => {
    // The plan takes at most `max` targets; the script carries at most MAX_TEXT_HIGHLIGHT_TARGETS.
    const targets = Array.from({ length: MAX_TEXT_HIGHLIGHT_TARGETS + 5 }, (_, i) => long(`Sentence number ${i}.`));
    const texts = targets.map((t) => `${t.text} `);
    const plan = planTextHighlight(texts, targets, MAX_TEXT_HIGHLIGHT_TARGETS);
    expect(plan.spans).toHaveLength(MAX_TEXT_HIGHLIGHT_TARGETS);
    expect(plan.unmatched).toBe(0);
    expect(highlightScript('sentences', [], targets)).toContain(JSON.stringify(targets.slice(0, MAX_TEXT_HIGHLIGHT_TARGETS)));
    // Other modes carry no text at all.
    expect(highlightScript('links', [], targets)).not.toContain('Sentence number');
    expect(highlightScript('off', [], targets)).not.toContain('Sentence number');
    // A sentence on many lines: at most MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET boxes for it.
    const page = textPage(ARTICLE, MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET + 10);
    const answer = await paintHighlight(page.document as unknown as OverlayDocument, 'sentences', OVERLAY_CONFIG, planHighlight, page.store, [], [long('This sentence runs on and on.')], planTextHighlight);
    expect(answer).toEqual({ mode: 'sentences', boxes: MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET, unmatched: 0 });
    // The label is on the sentence's first line only.
    expect(page.children().map((el) => el.textContent)).toEqual([HIGHLIGHT_STYLES['long-sentence'].label, ...Array.from({ length: MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET - 1 }, () => '')]);
    await paintHighlight(page.document as unknown as OverlayDocument, 'off', OVERLAY_CONFIG, planHighlight, page.store);
  });

  test('text-highlight-says-what-it-did-not-find', async () => {
    const page = textPage(ARTICLE);
    const targets = [long('This sentence runs on and on.'), { text: 'Gone from the page.', kind: 'complex-sentence' as const }, long('Also gone.'), { text: 'Another long sentence here.', kind: 'complex-sentence' as const }];
    await expect(paintHighlight(page.document as unknown as OverlayDocument, 'sentences', OVERLAY_CONFIG, planHighlight, page.store, [], targets, planTextHighlight)).resolves.toEqual({ mode: 'sentences', boxes: 6, unmatched: 2 });
    const texts = page.children().map((el) => el.textContent);
    expect(texts).toContain(TEXT_HIGHLIGHT_UNMATCHED_NOTE.many.replace('{n}', '2'));
    expect(texts.filter((t) => t === 'long' || t === 'complex')).toEqual(['long', 'complex']);
    await paintHighlight(page.document as unknown as OverlayDocument, 'sentences', OVERLAY_CONFIG, planHighlight, page.store, [], [long('Gone.')], planTextHighlight);
    expect(page.children().map((el) => el.textContent)).toEqual([TEXT_HIGHLIGHT_UNMATCHED_NOTE.one]);
    await paintHighlight(page.document as unknown as OverlayDocument, 'off', OVERLAY_CONFIG, planHighlight, page.store);
    expect(page.state()).toBeUndefined();
  });

  test('text-highlight-boxes-inline-elements-once', async () => {
    // As Chromium does: a range's client rects are its text's line boxes plus the border box of every
    // element wholly inside it (here an `<em>` and a link, each the size of its own words).
    const page = textPage('<p>Short one. <em>This sentence</em> runs <a href="/x">on</a> and on.</p>');
    const textNodes: Node[] = [];
    const walk = page.document.createTreeWalker(page.document.body, 0x4);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) textNodes.push(node);
    const lineBox = (node: Node) => domRect(10 + 40 * textNodes.indexOf(node), 100, 40, 16);
    (page.dom.window.Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = function (this: Range) {
      const rects: DOMRect[] = [];
      for (const node of textNodes) if (this.intersectsNode(node)) rects.push(lineBox(node));
      for (const el of page.document.body.querySelectorAll('*')) {
        const whole = page.document.createRange();
        whole.selectNode(el);
        if (this.compareBoundaryPoints(page.dom.window.Range.START_TO_START, whole) <= 0 && this.compareBoundaryPoints(page.dom.window.Range.END_TO_END, whole) >= 0) rects.push(lineBox(el.firstChild!));
      }
      return rects;
    };
    const answer = await paintHighlight(page.document as unknown as OverlayDocument, 'sentences', OVERLAY_CONFIG, planHighlight, page.store, [], [long('This sentence runs on and on.')], planTextHighlight);
    // One box per text node the sentence covers ("This sentence", " runs ", "on", " and on."), none twice.
    expect(answer).toEqual({ mode: 'sentences', boxes: 4, unmatched: 0 });
    const geometry = page.geometry();
    expect(new Set(geometry.map((g) => g.replace(/ \S*$/, ''))).size).toBe(geometry.length);
    await paintHighlight(page.document as unknown as OverlayDocument, 'off', OVERLAY_CONFIG, planHighlight, page.store);
  });

  test('text-highlight-script-is-self-contained', async () => {
    // Hostile excerpts travel as JSON data: quotes, a closing script tag, U+2028, bidi controls, markup.
    const hostile = [long('"); globalThis.pwned = 1; ("'), long('</script><img src=x onerror="globalThis.pwned=2">'), long('Line\u2028separator \u202egnp.exe\u202c and `${globalThis.pwned = 3}`.')];
    const targets = [long('This sentence runs on and on.'), ...hostile, { text: 'Another long sentence here.', kind: 'complex-sentence' as const }];
    const script = highlightScript('sentences', [], targets);
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(`, ${JSON.stringify('sentences')}, ${JSON.stringify(OVERLAY_CONFIG)}, `);
    for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /document\.write/, /\badoptedStyleSheets\b/, /CSSStyleSheet/, /createElement\(['"]style/, /setAttribute\(['"]style/, /\.cssText\b/, /\beval\s*\(/, /\brequire\s*\(/, /\bprocess\./, /\bipcRenderer\b/]) {
      expect(script, String(forbidden)).not.toMatch(forbidden);
    }

    // Evaluated as the isolated world runs it: in a page's own context, no module scope.
    const evaluated = textPage(ARTICLE);
    const answer = await (evaluated.dom.window.eval(script) as Promise<unknown>);
    expect(answer).toEqual({ mode: 'sentences', boxes: 6, unmatched: 3 });
    expect((evaluated.dom.window as unknown as { pwned?: unknown }).pwned).toBeUndefined();
    expect(evaluated.document.querySelector('img')).toBeNull();
    // The same boxes as the imported painter and plan draw on the same page.
    const imported = textPage(ARTICLE);
    await paintHighlight(imported.document as unknown as OverlayDocument, 'sentences', OVERLAY_CONFIG, planHighlight, imported.store, [], targets.slice(0, MAX_TEXT_HIGHLIGHT_TARGETS), planTextHighlight);
    expect(evaluated.geometry()).toEqual(imported.geometry());
    expect(evaluated.geometry().length).toBeGreaterThan(0);

    // The stringified plan, built in a fresh context with nothing in scope, plans as the imported one.
    const fresh = vm.runInNewContext(`(${planTextHighlight.toString()})`) as typeof planTextHighlight;
    const texts = ['Intro. ', 'The quick br', 'own fox ', '  jumps\n over', ' the dog.', ' Price\u200b list \u202eevil\u202c here.'];
    const planned = [long('The quick brown fox jumps over the dog.'), long('Price\u200b list \u202eevil\u202c here.'), long('Missing.')];
    expect(JSON.parse(JSON.stringify(fresh(texts, planned, 20)))).toEqual(planTextHighlight(texts, planned, 20));
  });

  test('text-highlight-runs-in-seo-world', async () => {
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => ({ mode: 'sentences', boxes: 2, unmatched: 0 })) };
    const targets = [long('A sentence.')];
    await expect(runHighlight(contents, 'sentences', [], targets)).resolves.toEqual({ mode: 'sentences', boxes: 2, unmatched: 0 });
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(SEO_WORLD_ID, [{ code: highlightScript('sentences', [], targets) }]);
  });
});
