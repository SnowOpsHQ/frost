// Spec: specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES, HIGHLIGHT_STYLES), specs/seo-limits.spec.ts (SEO_WORLD_ID, HIGHLIGHT_BUDGET_MS)
// Acceptance: specs/seo-panels.feature.md (Highlight)
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES } from '@app/specs/seo-sidebar.spec';
import { highlightScript, OVERLAY_CONFIG, OVERLAY_KEY, paintHighlight, planHighlight, runHighlight, type HighlightItem, type OverlayDocument, type OverlayState } from '../highlight';

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

/** A jsdom page with layout stubbed: every `a` and heading gets a box at its index. */
function pageWith(body: string, url = 'https://www.example.com/page') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`, { url, pretendToBeVisual: true });
  const { document } = dom.window;
  document.querySelectorAll('a, h1, h2, h3, h4, h5, h6').forEach((el, i) => {
    if (!el.hasAttribute('data-nobox')) el.getBoundingClientRect = () => ({ left: 10, top: 30 * i, width: 120, height: 20, right: 130, bottom: 30 * i + 20, x: 10, y: 30 * i, toJSON: () => ({}) }) as DOMRect;
  });
  const before = document.documentElement.outerHTML;
  const store: Record<string, unknown> = {};
  const paint = (mode: 'off' | 'links' | 'headings') => paintHighlight(document as unknown as OverlayDocument, mode, OVERLAY_CONFIG, planHighlight, store);
  const state = () => store[OVERLAY_KEY] as OverlayState | undefined;
  return { dom, document, before, store, paint, state };
}

const PAGE = `<h1>Title</h1><p><a href="/a">Internal</a> <a href="https://example.com/b">Same site</a> <a href="https://other.org/">External</a>
  <a href="/c" rel="NoFollow">Nofollow</a> <a href="mailto:x@example.com">Mail</a> <a href="/hidden" data-nobox>Hidden</a></p><h2>Sub</h2><h3>Deeper</h3>`;

describe('highlight overlay (jsdom)', () => {
  test('highlight-draws-in-closed-shadow-root', () => {
    const { document, before, paint, state } = pageWith(PAGE);
    const bodyBefore = document.body.outerHTML;
    const sheets = document.styleSheets.length;
    expect(paint('links')).toEqual({ mode: 'links', boxes: 5 });
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
  });

  test('highlight-kinds-and-labels', () => {
    const { document, paint } = pageWith(PAGE);
    // Reaching into the closed root the way the overlay does: through attachShadow's answer.
    const roots: ShadowRoot[] = [];
    const attach = document.defaultView!.HTMLElement.prototype.attachShadow;
    document.defaultView!.HTMLElement.prototype.attachShadow = function (init) {
      const root = attach.call(this, init);
      roots.push(root);
      return root;
    };
    paint('links');
    const boxes = [...roots[0]!.children] as HTMLElement[];
    expect(boxes.map((b) => b.textContent)).toEqual(['int', 'int', 'ext', 'nofollow', 'other']);
    expect(boxes[2]!.style.getPropertyValue('border')).toContain('solid');
    expect(boxes.every((b) => b.style.getPropertyValue('position') === 'absolute')).toBe(true);
    paint('headings');
    const headings = [...roots[1]!.children].map((b) => b.textContent);
    expect(headings).toEqual(['H1', 'H2', 'H3']);
    // No markup parsing anywhere: labels are text nodes.
    expect(roots[1]!.querySelectorAll('span')[0]!.childNodes[0]!.nodeType).toBe(3);
  });

  test('highlight-switch-replaces-overlay', () => {
    const { document, paint, state } = pageWith(PAGE);
    paint('links');
    expect(paint('headings')).toEqual({ mode: 'headings', boxes: 3 });
    expect(document.documentElement.children).toHaveLength(3);
    expect(state()!.mode).toBe('headings');
  });

  test('highlight-off-removes-everything', () => {
    const { dom, document, before, paint, state } = pageWith(PAGE);
    const view = dom.window as unknown as Window;
    const added = vi.spyOn(view, 'addEventListener');
    const removed = vi.spyOn(view, 'removeEventListener');
    paint('links');
    paint('links');
    expect(paint('off')).toEqual({ mode: 'off', boxes: 0 });
    expect(document.documentElement.outerHTML).toBe(before);
    expect(state()).toBeUndefined();
    // Every listener it added is removed again.
    const resize = added.mock.calls.filter(([type]) => type === 'resize');
    expect(resize).toHaveLength(2);
    for (const [, listener] of resize) expect(removed.mock.calls.some(([type, l]) => type === 'resize' && l === listener)).toBe(true);
    // Off when nothing is drawn is a no-op.
    expect(paint('off')).toEqual({ mode: 'off', boxes: 0 });
    expect(document.documentElement.outerHTML).toBe(before);
  });

  test('highlight-is-bounded', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/l${i}">l</a>`).join('');
    const { document, store } = pageWith(links);
    const result = paintHighlight(document as unknown as OverlayDocument, 'links', { ...OVERLAY_CONFIG, maxLinks: 7 }, planHighlight, store);
    expect(result.boxes).toBe(7);
    // Past its budget it draws what it measured so far.
    const late = paintHighlight(document as unknown as OverlayDocument, 'links', { ...OVERLAY_CONFIG, budgetMs: -1 }, planHighlight, store);
    expect(late.boxes).toBe(0);
  });

  test('highlight-follows-layout', async () => {
    const { dom, document, paint, state } = pageWith(PAGE);
    paint('headings');
    const h1 = document.querySelector('h1')!;
    h1.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state()!.boxes()).toBe(2);
    paint('off');
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

  test('highlight-runs-in-seo-world', async () => {
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => ({ mode: 'links', boxes: 3 })) };
    await expect(runHighlight(contents, 'links')).resolves.toEqual({ mode: 'links', boxes: 3 });
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(SEO_WORLD_ID, [{ code: highlightScript('links') }]);
  });
});
