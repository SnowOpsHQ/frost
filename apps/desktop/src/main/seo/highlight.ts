import { HIGHLIGHT_BUDGET_MS, HIGHLIGHT_FRAME_MS, SEO_WORLD_ID, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
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
// overlay, and `off` removes the host and every listener, leaving the page's DOM as it was. It
// follows layout and scrolling (`HIGHLIGHT_FRAME_MS` per frame), reusing its box elements; when the
// page removes its host it stops and `ended` says so (main turns the tab's mode off).
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
  readonly isConnected: boolean;
  setAttribute(name: string, value: string): void;
  attachShadow(init: { mode: 'closed' }): OverlayRoot;
  append(...nodes: OverlayElement[]): void;
  remove(): void;
}
interface OverlayRoot {
  append(...nodes: OverlayElement[]): void;
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
type Listener = () => void;
interface ResizeEntry {
  readonly target: unknown;
  readonly contentRect: { readonly width: number; readonly height: number };
}
interface OverlayView {
  readonly scrollX: number;
  readonly scrollY: number;
  addEventListener(type: 'resize' | 'pagehide', listener: Listener): void;
  removeEventListener(type: 'resize' | 'pagehide', listener: Listener): void;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
  readonly ResizeObserver?: new (callback: (entries: readonly ResizeEntry[]) => void) => { observe(target: unknown): void; disconnect(): void };
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
  addEventListener(type: 'scroll', listener: Listener, options: { capture: boolean; passive: boolean }): void;
  removeEventListener(type: 'scroll', listener: Listener, options: { capture: boolean }): void;
}
/**
 * Why an overlay ended: `off` (turned off), `replaced` (another mode drawn), `removed` (the page
 * took its host out of the document), `gone` (the page is being left: `pagehide`).
 */
export type OverlayEnd = 'off' | 'replaced' | 'removed' | 'gone';
/** The overlay's state on the isolated world's global (`store[OVERLAY_KEY]`). */
export interface OverlayState {
  readonly mode: HighlightMode;
  /** The closed shadow root it draws in (reachable from this isolated world only, never from the page). */
  readonly root: OverlayRoot;
  /** How many boxes it draws now. */
  boxes(): number;
  /** How many drawing passes it completed (one per toggle on a still page). */
  draws(): number;
  /** Settles with why it ended (`highlightEndedScript` hands it to main). */
  readonly ended: Promise<OverlayEnd>;
  /** Removes the host and every listener. */
  stop(reason: OverlayEnd): void;
}
export interface OverlayResult {
  readonly mode: HighlightMode;
  readonly boxes: number;
}
export interface OverlayConfig {
  readonly key: string;
  readonly maxLinks: number;
  readonly maxHeadings: number;
  /** Measuring time in all, per drawing pass. */
  readonly budgetMs: number;
  /** Measuring time per animation frame. */
  readonly frameMs: number;
  readonly styles: HighlightStyles;
}

/** The isolated world's global property holding the overlay state. */
export const OVERLAY_KEY = '__frostSeoHighlight';

/**
 * Removes any overlay this world drew in the page, then (unless `mode` is `off`) draws the new
 * one. Runs in the isolated world only; self-contained (`plan` is `planHighlight`, `store` the
 * world's global). Resolves, once the first drawing pass is done, the mode drawn and how many boxes
 * (`off` if the page removed the host before).
 */
export function paintHighlight(document: OverlayDocument, mode: HighlightMode, config: OverlayConfig, plan: typeof planHighlight, store: Record<string, unknown>): Promise<OverlayResult> {
  const previous = store[config.key] as OverlayState | undefined;
  if (previous) previous.stop(mode === 'off' ? 'off' : 'replaced');
  const root = document.documentElement;
  const view = document.defaultView;
  if (mode === 'off' || !root || !view) return Promise.resolve({ mode: 'off', boxes: 0 });

  const css = (el: OverlayElement, props: Record<string, string>): void => {
    for (const name of Object.keys(props)) el.style.setProperty(name, props[name]!, 'important');
  };
  // A site is `URL.host` (the port counts), one leading `www.` dropped: as the extractor's link kinds.
  const site = (host: string): string => {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
  };
  let pageSite = '';
  try {
    pageSite = site(new URL(document.URL).host);
  } catch {
    // No site: every web link is external.
  }
  const linkKind = (el: PageTarget): HighlightKind => {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/[\s,]+/);
    if (rel.includes('nofollow')) return 'nofollow';
    try {
      const url = new URL((el.getAttribute('href') ?? '').trim(), document.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other';
      return site(url.host) === pageSite ? 'internal' : 'external';
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

  // Box elements are kept and reused: a redraw writes only what changed.
  interface Box {
    readonly outline: OverlayElement;
    readonly label: OverlayElement;
    key: string;
  }
  const kept: Box[] = [];
  const make = (): Box => {
    const outline = document.createElement('div');
    css(outline, { position: 'absolute', 'box-sizing': 'border-box', 'border-width': '2px', 'border-style': 'solid', 'border-radius': '3px', 'pointer-events': 'none' });
    const label = document.createElement('span');
    css(label, {
      position: 'absolute',
      left: '-2px',
      padding: '0px 4px',
      'border-radius': '3px',
      color: '#ffffff',
      font: '600 10px/14px system-ui, -apple-system, "Segoe UI", sans-serif',
      'letter-spacing': '0.02em',
      'white-space': 'nowrap',
      'pointer-events': 'none',
    });
    outline.append(label);
    shadow.append(outline);
    return { outline, label, key: '' };
  };
  const apply = (boxes: readonly HighlightBox[]): void => {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const box = kept[i] ?? (kept[i] = make());
      const key = `${b.kind} ${b.x} ${b.y} ${b.width} ${b.height}`;
      if (box.key === key) continue;
      box.key = key;
      css(box.outline, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, 'border-color': b.color, background: `${b.color}14` });
      // Above the box, or inside it at the very top of the page.
      css(box.label, { top: b.y >= 15 ? '-15px' : '0px', background: b.color });
      if (box.label.textContent !== b.label) box.label.textContent = b.label;
    }
    while (kept.length > boxes.length) kept.pop()!.outline.remove();
  };

  let stopped = false;
  let frame: number | undefined;
  let measuring = false;
  let dirty = false;
  let drawn = 0;
  let passes = 0;
  let finish: (end: OverlayEnd) => void = () => undefined;
  const ended = new Promise<OverlayEnd>((resolve) => (finish = resolve));
  let firstDone: ((result: OverlayResult) => void) | null = null;
  const first = new Promise<OverlayResult>((resolve) => (firstDone = resolve));
  const settleFirst = (result: OverlayResult): void => {
    const done = firstDone;
    firstDone = null;
    done?.(result);
  };
  const nextFrame = (run: () => void): number => (typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number));

  /**
   * One drawing pass: measures the elements at most `frameMs` per frame (and `budgetMs` in all),
   * then writes the boxes. A request while a pass runs makes one more pass after it.
   */
  const pass = (): void => {
    if (stopped) return;
    if (!host.isConnected) {
      stop('removed');
      return;
    }
    measuring = true;
    dirty = false;
    const list = mode === 'links' ? document.links : document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const max = mode === 'links' ? config.maxLinks : config.maxHeadings;
    const items: HighlightItem[] = [];
    let index = 0;
    let spent = 0;
    const step = (): void => {
      frame = undefined;
      if (stopped) return;
      const sliceStart = performance.now();
      while (index < list.length && items.length < max) {
        if (spent + (performance.now() - sliceStart) > config.budgetMs) break;
        if (performance.now() - sliceStart > config.frameMs) break;
        const el = list[index++];
        if (!el || !shown(el)) continue;
        const kind: HighlightKind = mode === 'links' ? linkKind(el) : (`h${Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1))}` as HighlightKind);
        // Document coordinates as of now: the scroll offset may differ by the next slice.
        const r = el.getBoundingClientRect();
        items.push({ kind, rect: { left: r.left + view.scrollX, top: r.top + view.scrollY, width: r.width, height: r.height } });
      }
      spent += performance.now() - sliceStart;
      if (index < list.length && items.length < max && spent <= config.budgetMs) {
        frame = nextFrame(step);
        return;
      }
      if (!host.isConnected) {
        stop('removed');
        return;
      }
      const boxes = plan(items, { x: 0, y: 0 }, config.styles, max);
      apply(boxes);
      drawn = boxes.length;
      passes += 1;
      measuring = false;
      settleFirst({ mode, boxes: drawn });
      if (dirty) request();
    };
    step();
  };
  /** Layout or scrolling changed: one more pass, at most one per frame. */
  const request = (): void => {
    if (stopped) return;
    if (measuring) {
      dirty = true;
      return;
    }
    if (frame !== undefined) return;
    frame = nextFrame(() => {
      frame = undefined;
      pass();
    });
  };
  // A target's first observation is its initial size, not a change: recorded, not redrawn for.
  const sizes = new Map<unknown, string>();
  const onResize = (entries: readonly ResizeEntry[]): void => {
    let changed = false;
    for (const entry of entries) {
      const size = `${entry.contentRect.width}x${entry.contentRect.height}`;
      const before = sizes.get(entry.target);
      sizes.set(entry.target, size);
      if (before !== undefined && before !== size) changed = true;
    }
    if (changed) request();
  };
  const Observer = view.ResizeObserver;
  const observer = typeof Observer === 'function' ? new Observer(onResize) : null;
  const gone = (): void => stop('gone');

  function stop(reason: OverlayEnd): void {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    view!.removeEventListener('resize', request);
    view!.removeEventListener('pagehide', gone);
    document.removeEventListener('scroll', request, { capture: true });
    if (frame !== undefined) {
      if (typeof view!.cancelAnimationFrame === 'function') view!.cancelAnimationFrame(frame);
      else clearTimeout(frame);
    }
    frame = undefined;
    host.remove();
    if (store[config.key] === state) store[config.key] = undefined;
    settleFirst({ mode: 'off', boxes: 0 });
    finish(reason);
  }

  const state: OverlayState = { mode, root: shadow, boxes: () => drawn, draws: () => passes, ended, stop };
  store[config.key] = state;
  root.appendChild(host);
  if (observer) {
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  }
  view.addEventListener('resize', request);
  view.addEventListener('pagehide', gone);
  // Inner scroll containers' `scroll` events do not bubble: heard in the capture phase.
  document.addEventListener('scroll', request, { capture: true, passive: true });
  pass();
  return first;
}

export const OVERLAY_CONFIG: OverlayConfig = {
  key: OVERLAY_KEY,
  maxLinks: SNAPSHOT_LIMITS.maxLinks,
  maxHeadings: SNAPSHOT_LIMITS.maxHeadings,
  budgetMs: HIGHLIGHT_BUDGET_MS,
  frameMs: HIGHLIGHT_FRAME_MS,
  styles: HIGHLIGHT_STYLES,
};

/** The script that sets the overlay to `mode` in the isolated world (removing any before). */
export function highlightScript(mode: HighlightMode): string {
  return `(${paintHighlight.toString()})(document, ${JSON.stringify(mode)}, ${JSON.stringify(OVERLAY_CONFIG)}, ${planHighlight.toString()}, globalThis)`;
}

/** The script that settles with why the current overlay ended (`OverlayEnd`), or `none` without one. */
export function highlightEndedScript(): string {
  return `(() => { const s = globalThis[${JSON.stringify(OVERLAY_KEY)}]; return s ? s.ended : 'none'; })()`;
}

/** Sets the overlay in `contents`' SEO world; resolves the script's (untrusted) answer. */
export function runHighlight(contents: ExtractTarget, mode: HighlightMode): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: highlightScript(mode) }]);
}

/** Waits, in `contents`' SEO world, for the current overlay to end; resolves why (untrusted). */
export function watchHighlight(contents: ExtractTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: highlightEndedScript() }]);
}
