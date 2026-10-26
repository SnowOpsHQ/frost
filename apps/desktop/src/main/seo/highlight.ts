import { HIGHLIGHT_BUDGET_MS, SEO_WORLD_ID, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES, type HighlightKind, type HighlightMode } from '@app/specs/seo-sidebar.spec';
import type { ExtractTarget } from './extract';

// Highlight mode (spec `seo-sidebar.spec.ts`, `HIGHLIGHT_MODES` / `HIGHLIGHT_STYLES`,
// `seo-limits.spec.ts`, `HIGHLIGHT_BUDGET_MS`; acceptance `seo-panels.feature.md`, Highlight): an
// overlay outlining the page's links by type or its headings by level, each box with a small label.
//
// `paintHighlight` runs in the tab's isolated SEO world (`SEO_WORLD_ID`), like the extractor. It is
// self-contained (serialised with its arguments into a script) and uses DOM APIs only: no
// `innerHTML`, no markup, no stylesheet, no `<style>` element, no `adoptedStyleSheets`, and no
// attribute or style change on any page element. Everything it draws lives in a **closed** shadow
// root on one host element of its own, appended to `<html>`; its styles are inline styles set
// through the CSSOM (`style.setProperty`), which a page's CSP `style-src` does not govern (it covers
// `<style>`, stylesheets and `style` attributes parsed from markup or set with `setAttribute`), so
// the overlay looks the same under the strictest CSP. Its state (the host, its listeners) is kept
// on the isolated world's own global, which page scripts cannot reach; switching modes replaces the
// overlay, and `off` removes the host and every listener, leaving the page's DOM as it was.
//
// `planHighlight` is the pure part: which boxes to draw, where, in what colour, with what label.

/** An element to outline: its kind and its `getBoundingClientRect()` (viewport coordinates). */
export interface HighlightItem {
  readonly kind: HighlightKind;
  readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

/** A box to draw, in document coordinates (CSS px, rounded). */
export interface HighlightBox {
  readonly kind: HighlightKind;
  readonly label: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type HighlightStyles = Readonly<Record<HighlightKind, { readonly color: string; readonly label: string }>>;

/**
 * The boxes for `items` (at most `max`): each rect moved by the scroll offset into document
 * coordinates and rounded; items without a finite, non-empty rect (hidden, collapsed) are skipped.
 * Pure and self-contained: it is serialised into the overlay script too.
 */
export function planHighlight(items: readonly HighlightItem[], scroll: { readonly x: number; readonly y: number }, styles: HighlightStyles, max: number): HighlightBox[] {
  const boxes: HighlightBox[] = [];
  const sx = Number.isFinite(scroll.x) ? scroll.x : 0;
  const sy = Number.isFinite(scroll.y) ? scroll.y : 0;
  for (const item of items) {
    if (boxes.length >= max) break;
    const { left, top, width, height } = item.rect;
    if (![left, top, width, height].every(Number.isFinite) || width < 1 || height < 1) continue;
    const style = styles[item.kind];
    boxes.push({ kind: item.kind, label: style.label, color: style.color, x: Math.round(left + sx), y: Math.round(top + sy), width: Math.round(width), height: Math.round(height) });
  }
  return boxes;
}

/** What the overlay script reads and writes (structural, so main needs no DOM lib). */
interface OverlayStyle {
  setProperty(name: string, value: string, priority?: string): void;
}
interface OverlayElement {
  readonly style: OverlayStyle;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  attachShadow(init: { mode: 'closed' }): OverlayRoot;
  append(...nodes: OverlayElement[]): void;
  remove(): void;
}
interface OverlayRoot {
  replaceChildren(...nodes: OverlayElement[]): void;
  readonly childElementCount: number;
}
interface PageTarget {
  readonly localName: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): HighlightItem['rect'];
  checkVisibility?(options?: { visibilityProperty?: boolean; opacityProperty?: boolean }): boolean;
}
interface PageList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface OverlayView {
  readonly scrollX: number;
  readonly scrollY: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
  readonly ResizeObserver?: new (callback: () => void) => { observe(target: unknown): void; disconnect(): void };
}
/** The parts of `document` the overlay script uses. */
export interface OverlayDocument {
  readonly URL: string;
  readonly baseURI: string;
  readonly documentElement: (OverlayElement & { appendChild(node: OverlayElement): unknown }) | null;
  readonly body: unknown;
  readonly links: PageList<PageTarget>;
  readonly defaultView: OverlayView | null;
  createElement(name: string): OverlayElement;
  querySelectorAll(selectors: string): PageList<PageTarget>;
}
/** The overlay's state on the isolated world's global (`store[OVERLAY_KEY]`). */
export interface OverlayState {
  readonly mode: HighlightMode;
  /** The closed shadow root it draws in (reachable from this isolated world only, never from the page). */
  readonly root: OverlayRoot;
  /** How many boxes it draws now. */
  boxes(): number;
  /** Removes the host and every listener. */
  stop(): void;
}
export interface OverlayResult {
  readonly mode: HighlightMode;
  readonly boxes: number;
}
export interface OverlayConfig {
  readonly key: string;
  readonly maxLinks: number;
  readonly maxHeadings: number;
  readonly budgetMs: number;
  readonly styles: HighlightStyles;
}

/** The isolated world's global property holding the overlay state. */
export const OVERLAY_KEY = '__frostSeoHighlight';

/**
 * Removes any overlay this world drew in the page, then (unless `mode` is `off`) draws the new
 * one. Runs in the isolated world only; self-contained (`plan` is `planHighlight`, `store` the
 * world's global). Answers the mode drawn and how many boxes.
 */
export function paintHighlight(document: OverlayDocument, mode: HighlightMode, config: OverlayConfig, plan: typeof planHighlight, store: Record<string, unknown>): OverlayResult {
  const previous = store[config.key] as OverlayState | undefined;
  if (previous) {
    store[config.key] = undefined;
    previous.stop();
  }
  const root = document.documentElement;
  const view = document.defaultView;
  if (mode === 'off' || !root || !view) return { mode: 'off', boxes: 0 };

  const css = (el: OverlayElement, props: Record<string, string>): void => {
    for (const name of Object.keys(props)) el.style.setProperty(name, props[name]!, 'important');
  };
  const site = (host: string): string => {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
  };
  let pageSite = '';
  try {
    pageSite = site(new URL(document.URL).hostname);
  } catch {
    // No site: every web link is external.
  }
  const linkKind = (el: PageTarget): HighlightKind => {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/[\s,]+/);
    if (rel.includes('nofollow')) return 'nofollow';
    try {
      const url = new URL((el.getAttribute('href') ?? '').trim(), document.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other';
      return site(url.hostname) === pageSite ? 'internal' : 'external';
    } catch {
      return 'other';
    }
  };
  // Outlines only what can be seen: not inside `display: none`, `visibility: hidden` or `opacity: 0`.
  const shown = (el: PageTarget): boolean => typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true, opacityProperty: true });

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  css(host, { all: 'initial', display: 'block', position: 'absolute', top: '0px', left: '0px', width: '0px', height: '0px', margin: '0px', padding: '0px', overflow: 'visible', 'z-index': '2147483647', 'pointer-events': 'none' });
  const shadow = host.attachShadow({ mode: 'closed' });

  const box = (b: HighlightBox): OverlayElement => {
    const outline = document.createElement('div');
    css(outline, {
      position: 'absolute',
      left: `${b.x}px`,
      top: `${b.y}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
      'box-sizing': 'border-box',
      border: `2px solid ${b.color}`,
      'border-radius': '3px',
      background: `${b.color}14`,
      'pointer-events': 'none',
    });
    const label = document.createElement('span');
    label.textContent = b.label;
    css(label, {
      position: 'absolute',
      left: '-2px',
      // Above the box, or inside it at the very top of the page.
      top: b.y >= 15 ? '-15px' : '0px',
      padding: '0px 4px',
      'border-radius': '3px',
      background: b.color,
      color: '#ffffff',
      font: '600 10px/14px system-ui, -apple-system, "Segoe UI", sans-serif',
      'letter-spacing': '0.02em',
      'white-space': 'nowrap',
      'pointer-events': 'none',
    });
    outline.append(label);
    return outline;
  };

  let drawn = 0;
  const draw = (): void => {
    const deadline = performance.now() + config.budgetMs;
    const items: HighlightItem[] = [];
    const list = mode === 'links' ? document.links : document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const max = mode === 'links' ? config.maxLinks : config.maxHeadings;
    for (let i = 0; i < list.length && items.length < max; i++) {
      if ((i & 31) === 0 && performance.now() > deadline) break;
      const el = list[i];
      if (!el || !shown(el)) continue;
      const kind: HighlightKind = mode === 'links' ? linkKind(el) : (`h${Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1))}` as HighlightKind);
      items.push({ kind, rect: el.getBoundingClientRect() });
    }
    const boxes = plan(items, { x: view.scrollX, y: view.scrollY }, config.styles, max);
    shadow.replaceChildren(...boxes.map(box));
    drawn = boxes.length;
  };

  // Layout changes (fonts, images, a resized window) move the boxes: redrawn once per frame at most.
  let frame: number | undefined;
  let stopped = false;
  const later = (): void => {
    if (stopped || frame !== undefined) return;
    const run = (): void => {
      frame = undefined;
      if (!stopped) draw();
    };
    frame = typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  };
  const Observer = view.ResizeObserver;
  const observer = typeof Observer === 'function' ? new Observer(later) : null;
  if (observer) {
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  }
  view.addEventListener('resize', later);

  draw();
  root.appendChild(host);
  const state: OverlayState = {
    mode,
    root: shadow,
    boxes: () => drawn,
    stop() {
      stopped = true;
      observer?.disconnect();
      view.removeEventListener('resize', later);
      if (frame !== undefined) {
        if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
        else clearTimeout(frame);
      }
      frame = undefined;
      host.remove();
    },
  };
  store[config.key] = state;
  return { mode, boxes: drawn };
}

export const OVERLAY_CONFIG: OverlayConfig = {
  key: OVERLAY_KEY,
  maxLinks: SNAPSHOT_LIMITS.maxLinks,
  maxHeadings: SNAPSHOT_LIMITS.maxHeadings,
  budgetMs: HIGHLIGHT_BUDGET_MS,
  styles: HIGHLIGHT_STYLES,
};

/** The script that sets the overlay to `mode` in the isolated world (removing any before). */
export function highlightScript(mode: HighlightMode): string {
  return `(${paintHighlight.toString()})(document, ${JSON.stringify(mode)}, ${JSON.stringify(OVERLAY_CONFIG)}, ${planHighlight.toString()}, globalThis)`;
}

/** Sets the overlay in `contents`' SEO world; resolves the script's (untrusted) answer. */
export function runHighlight(contents: ExtractTarget, mode: HighlightMode): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: highlightScript(mode) }]);
}
