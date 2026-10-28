import { SERP_OUTLINE_KEY, SERP_OUTLINE_LIMITS, SERP_OUTLINE_STYLES } from '@app/specs/serp-service.spec';
import type { SerpResultType } from '@app/specs/serp-selector-pack.spec';
import type { EngineLayout } from '@app/specs/serp-selector-pack.schema';
import { SERP_READ_LIMITS, SERP_WORLD_ID, type SerpReadLimits } from '@app/specs/serp.spec';
import { layoutArgument, readSerp, type SerpReadTarget } from './read-script';

// SERP outlines (spec `serp-service.spec.ts`, Outlines, `SERP_OUTLINE_STYLES`, `SERP_OUTLINE_LIMITS`;
// acceptance `serp-overlay.feature.md`, Outlines): each read result's box (its block's `box`
// element, else the item; `SerpReadSchema`'s `rect`) with its type's label, drawn over the result
// page.
//
// `paintOutlines` runs in the tab's isolated SERP world (`SERP_WORLD_ID`), beside the reader, and
// takes the approach of Phase 2's highlight overlay (`../seo/highlight.ts`), duplicated here rather
// than shared so neither changes the other: it is self-contained (serialised with its arguments into
// a script), it uses DOM APIs only (no `innerHTML`, no markup, no stylesheet, no `<style>`, no
// `adoptedStyleSheets`, no attribute or style change on any page element), and everything it draws
// lives in a **closed** shadow root on one host element of its own, appended to `<html>`, styled
// with inline styles set through the CSSOM (`style.setProperty`), which a page's CSP does not
// govern. Its state is kept on the isolated world's own global (`SERP_OUTLINE_KEY`), which page
// scripts cannot reach, apart from the highlight's (another world, another key, another host).
//
// The boxes come from the reader itself: each pass runs the same fixed reader (`readSerp`, its
// source passed in as `plan` is) with the pack's layout and `SERP_READ_LIMITS`, so they follow the
// page as it scrolls, reflows or updates. Scrolling (the capture phase hears inner scrollers),
// window resizes and size changes of `<html>` and `<body>` request a pass, coalesced to one per
// animation frame and no sooner than `minIntervalMs` (or four times the last pass's cost) after the
// last. A pass whose read fails clears the boxes (nothing is guessed). Labels are spec constants and
// positions, never page text. `off` removes the host and every listener; when the page removes the
// host it stops (`removed`), and when the page is left (`pagehide`) too (`gone`); `ended` says why.
//
// `planOutlines` is the pure part: which boxes, where, in what colour, with what label.

/** A box to draw, in document coordinates (CSS px, rounded). */
export interface OutlineBox {
  readonly type: SerpResultType;
  readonly label: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type OutlineStyles = Readonly<Record<SerpResultType, { readonly color: string; readonly label: string }>>;

/**
 * The boxes for the reader's blocks (at most `max`), moved by `scroll`: an organic result or an ad
 * is one box each, labelled with its type and its place in its own count (`Organic 3`, `Ad 1`,
 * counted over every result of the type, boxed or not, as `position`); a feature block is one box
 * (its block's), labelled with its type. The blocks are page data: an unknown type, a box that is not
 * finite numbers, empty or beyond 1,000,000 px (`SERP_READ_LIMITS.maxCoordinate`) is skipped, and
 * nothing of the page's text is used. Pure and self-contained: it is serialised into the overlay
 * script too.
 */
export function planOutlines(blocks: readonly unknown[], scroll: { readonly x: number; readonly y: number }, styles: OutlineStyles, max: number): OutlineBox[] {
  const LIMIT = 1_000_000;
  const boxes: OutlineBox[] = [];
  if (!Array.isArray(blocks)) return boxes;
  const sx = Number.isFinite(scroll.x) ? scroll.x : 0;
  const sy = Number.isFinite(scroll.y) ? scroll.y : 0;
  const counts: Record<string, number> = { organic: 0, ad: 0 };
  const boxOf = (value: unknown): { x: number; y: number; width: number; height: number } | null => {
    if (typeof value !== 'object' || value === null) return null;
    const { x, y, width, height } = value as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null;
    if (![x, y, width, height].every((v) => Number.isFinite(v) && Math.abs(v) <= LIMIT) || width < 1 || height < 1) return null;
    return { x, y, width, height };
  };
  const push = (type: SerpResultType, label: string, color: string, r: { x: number; y: number; width: number; height: number }): void => {
    boxes.push({ type, label, color, x: Math.round(r.x + sx), y: Math.round(r.y + sy), width: Math.round(r.width), height: Math.round(r.height) });
  };
  for (const block of blocks) {
    if (boxes.length >= max) break;
    if (typeof block !== 'object' || block === null) continue;
    const { type, items, rect } = block as { type?: unknown; items?: unknown; rect?: unknown };
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(styles, type)) continue;
    const kind = type as SerpResultType;
    const style = styles[kind];
    if (kind === 'organic' || kind === 'ad') {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        counts[kind] = (counts[kind] ?? 0) + 1;
        if (boxes.length >= max) break;
        const r = boxOf(typeof item === 'object' && item !== null ? (item as { rect?: unknown }).rect : null);
        if (r) push(kind, `${style.label} ${counts[kind]}`, style.color, r);
      }
    } else {
      const r = boxOf(rect);
      if (r) push(kind, style.label, style.color, r);
    }
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
}
type Listener = () => void;
interface ResizeEntry {
  readonly target: unknown;
  readonly contentRect: { readonly width: number; readonly height: number };
}
interface OverlayView {
  addEventListener(type: 'resize' | 'pagehide', listener: Listener): void;
  removeEventListener(type: 'resize' | 'pagehide', listener: Listener): void;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
  readonly ResizeObserver?: new (callback: (entries: readonly ResizeEntry[]) => void) => { observe(target: unknown): void; disconnect(): void };
}
/** The parts of `document` the overlay script uses (the reader is handed the whole document). */
export interface OutlineDocument {
  readonly documentElement: (OverlayElement & { appendChild(node: OverlayElement): unknown }) | null;
  readonly body: unknown;
  readonly defaultView: OverlayView | null;
  createElement(name: string): OverlayElement;
  addEventListener(type: 'scroll', listener: Listener, options: { capture: boolean; passive: boolean }): void;
  removeEventListener(type: 'scroll', listener: Listener, options: { capture: boolean }): void;
}

/**
 * Why an outline ended: `off` (turned off), `replaced` (drawn again), `removed` (the page took its
 * host out of the document), `gone` (the page is being left: `pagehide`).
 */
export type OutlineEnd = 'off' | 'replaced' | 'removed' | 'gone';
/** The outline's state on the isolated world's global (`store[config.key]`). */
export interface OutlineState {
  /** The closed shadow root it draws in (reachable from this isolated world only). */
  readonly root: OverlayRoot;
  /** How many boxes it draws now. */
  boxes(): number;
  /** How many reading passes it completed. */
  draws(): number;
  /** Settles with why it ended (`outlineEndedScript` hands it to main). */
  readonly ended: Promise<OutlineEnd>;
  /** Removes the host and every listener. */
  stop(reason: OutlineEnd): void;
}
/** What drawing answers once its first pass is done: on, and how many boxes (`on: false` when turned off, or the page removed it first). */
export interface OutlineResult {
  readonly on: boolean;
  readonly boxes: number;
}
export interface OutlineConfig {
  readonly key: string;
  readonly styles: OutlineStyles;
  readonly maxBoxes: number;
  /** The least time between two passes after the first (ms). */
  readonly minIntervalMs: number;
  /** The reader's limits (`SERP_READ_LIMITS`). */
  readonly limits: SerpReadLimits;
}
/** The reader as the overlay calls it (`readSerp`). */
export type OutlineReader = typeof readSerp;

/**
 * Removes any outline this world drew, then (unless `layout` is `null`, off) draws a new one with
 * the pack's `layout`. Runs in the SERP world only; self-contained (`plan` is `planOutlines`, `read`
 * is `readSerp`, `store` the world's global). Resolves once the first pass is done.
 */
export function paintOutlines(document: OutlineDocument, layout: EngineLayout | null, config: OutlineConfig, plan: typeof planOutlines, read: OutlineReader, store: Record<string, unknown>): Promise<OutlineResult> {
  const previous = store[config.key] as OutlineState | undefined;
  if (previous) previous.stop(layout === null ? 'off' : 'replaced');
  const root = document.documentElement;
  const view = document.defaultView;
  if (layout === null || !root || !view) return Promise.resolve({ on: false, boxes: 0 });

  const css = (el: OverlayElement, props: Record<string, string>): void => {
    for (const name of Object.keys(props)) el.style.setProperty(name, props[name]!, 'important');
  };
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  css(host, { all: 'initial', display: 'block', position: 'absolute', top: '0px', left: '0px', width: '0px', height: '0px', margin: '0px', padding: '0px', overflow: 'visible', 'z-index': '2147483647', 'pointer-events': 'none' });
  const shadow = host.attachShadow({ mode: 'closed' });

  // Box elements are kept and reused: a pass writes only what changed.
  interface Box {
    readonly outline: OverlayElement;
    readonly label: OverlayElement;
    key: string;
  }
  const kept: Box[] = [];
  const make = (): Box => {
    const outline = document.createElement('div');
    css(outline, { position: 'absolute', 'box-sizing': 'border-box', 'border-width': '2px', 'border-style': 'solid', 'border-radius': '4px', 'pointer-events': 'none' });
    const label = document.createElement('span');
    css(label, {
      position: 'absolute',
      left: '-2px',
      padding: '0px 5px',
      'border-radius': '3px',
      color: '#ffffff',
      font: '600 11px/15px system-ui, -apple-system, "Segoe UI", sans-serif',
      'letter-spacing': '0.02em',
      'white-space': 'nowrap',
      'pointer-events': 'none',
    });
    outline.append(label);
    shadow.append(outline);
    return { outline, label, key: '' };
  };
  const apply = (boxes: readonly OutlineBox[]): void => {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const box = kept[i] ?? (kept[i] = make());
      const key = `${b.type} ${b.label} ${b.x} ${b.y} ${b.width} ${b.height}`;
      if (box.key === key) continue;
      box.key = key;
      css(box.outline, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, 'border-color': b.color, background: `${b.color}12` });
      // Above the box, or inside it at the very top of the page.
      css(box.label, { top: b.y >= 16 ? '-16px' : '0px', background: b.color });
      if (box.label.textContent !== b.label) box.label.textContent = b.label;
    }
    while (kept.length > boxes.length) kept.pop()!.outline.remove();
  };

  let stopped = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drawn = 0;
  let passes = 0;
  let lastStart = 0;
  let cost = 0;
  let finish: (end: OutlineEnd) => void = () => undefined;
  const ended = new Promise<OutlineEnd>((resolve) => (finish = resolve));
  let firstDone: ((result: OutlineResult) => void) | null = null;
  const first = new Promise<OutlineResult>((resolve) => (firstDone = resolve));
  const settleFirst = (result: OutlineResult): void => {
    const done = firstDone;
    firstDone = null;
    done?.(result);
  };
  const nextFrame = (run: () => void): number => (typeof view.requestAnimationFrame === 'function' ? view.requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number));

  /** One pass: read the page with the layout, then write the boxes (none when the read fails). */
  const pass = (): void => {
    frame = undefined;
    if (stopped) return;
    if (!host.isConnected) {
      stop('removed');
      return;
    }
    const started = performance.now();
    lastStart = started;
    let answer: unknown = null;
    try {
      answer = read(document, layout, config.limits);
    } catch {
      answer = null;
    }
    if (stopped) return;
    if (!host.isConnected) {
      stop('removed');
      return;
    }
    const ok = typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true;
    const blocks = ok ? (answer as { blocks?: unknown }).blocks : null;
    const boxes = Array.isArray(blocks) ? plan(blocks, { x: 0, y: 0 }, config.styles, config.maxBoxes) : [];
    apply(boxes);
    drawn = boxes.length;
    passes += 1;
    cost = performance.now() - started;
    settleFirst({ on: true, boxes: drawn });
  };
  /** The page scrolled or changed size: one more pass, at most one per frame, no sooner than the interval after the last. */
  const request = (): void => {
    if (stopped || timer !== undefined || frame !== undefined) return;
    const interval = Math.max(config.minIntervalMs, cost * 4);
    const wait = Math.max(0, lastStart + interval - performance.now());
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) frame = nextFrame(pass);
    }, wait);
  };
  // A target's first observation is its initial size, not a change: recorded, not read again for.
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

  function stop(reason: OutlineEnd): void {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    view!.removeEventListener('resize', request);
    view!.removeEventListener('pagehide', gone);
    document.removeEventListener('scroll', request, { capture: true });
    if (timer !== undefined) clearTimeout(timer);
    if (frame !== undefined) {
      if (typeof view!.cancelAnimationFrame === 'function') view!.cancelAnimationFrame(frame);
      else clearTimeout(frame);
    }
    timer = undefined;
    frame = undefined;
    host.remove();
    if (store[config.key] === state) store[config.key] = undefined;
    settleFirst({ on: false, boxes: 0 });
    finish(reason);
  }

  const state: OutlineState = { root: shadow, boxes: () => drawn, draws: () => passes, ended, stop };
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

export const OUTLINE_CONFIG: OutlineConfig = {
  key: SERP_OUTLINE_KEY,
  styles: SERP_OUTLINE_STYLES,
  maxBoxes: SERP_OUTLINE_LIMITS.maxBoxes,
  minIntervalMs: SERP_OUTLINE_LIMITS.minIntervalMs,
  limits: SERP_READ_LIMITS,
};

/**
 * The script that draws the outlines with `layout` in the SERP world (removing any before), or
 * removes them (`null`). The layout (only the fields the reader uses) and the config are JSON, never
 * code; the planner and the reader are frost's own functions' source.
 */
export function outlineScript(layout: EngineLayout | null): string {
  const argument = layout === null ? null : layoutArgument(layout);
  return `(${paintOutlines.toString()})(document, ${JSON.stringify(argument)}, ${JSON.stringify(OUTLINE_CONFIG)}, ${planOutlines.toString()}, ${readSerp.toString()}, globalThis)`;
}

/** The script that settles with why the current outline ended (`OutlineEnd`), or `none` without one. */
export function outlineEndedScript(): string {
  return `(() => { const s = globalThis[${JSON.stringify(SERP_OUTLINE_KEY)}]; return s ? s.ended : 'none'; })()`;
}

/** Draws (or with `null` removes) the outlines in `contents`' SERP world; resolves the script's (untrusted) answer. */
export function runOutline(contents: SerpReadTarget, layout: EngineLayout | null): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SERP_WORLD_ID, [{ code: outlineScript(layout) }]);
}

/** Waits, in `contents`' SERP world, for the current outline to end; resolves why (untrusted). */
export function watchOutline(contents: SerpReadTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SERP_WORLD_ID, [{ code: outlineEndedScript() }]);
}
