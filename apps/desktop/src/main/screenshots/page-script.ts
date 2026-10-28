import { AREA_SELECT_HINT, SCREENSHOT_LIMITS, SCREENSHOT_WORLD_ID, type ScreenshotRect } from '@app/specs/screenshot.spec';

// The screenshot scripts (Phase 6 Task 5; spec `screenshot.spec.ts`; acceptance
// `screenshot.feature.md`, Kinds). Each function here is self-contained: it is serialised with its
// arguments into a script and run in the tab's isolated world `SCREENSHOT_WORLD_ID`
// (`executeJavaScriptInIsolatedWorld`), so nothing the page defines reaches it.
//
// - `measurePage` reads the page's size, viewport and scroll position.
// - `scrollAndSettle` scrolls (instantly, whatever the page's `scroll-behavior`) and waits for a few
//   animation frames, so the next capture shows the new position; `restoreScroll` puts it back.
// - `selectArea` is the area selector, drawn with the Phase 2 highlight's technique
//   (`seo/highlight.ts`): one host element of its own appended to `<html>`, a **closed** shadow root,
//   inline styles set through the CSSOM only (`style.setProperty`, which a page's CSP `style-src`
//   does not govern), and no attribute, style or text of any page element touched. Only trusted
//   input (`event.isTrusted`) drags, ends or cancels it. Its state is kept on the isolated world's
//   own global, which page scripts cannot reach; `cancelAreaScript` ends it from main. When it ends,
//   for whatever reason, the host and every listener are removed.
//
// Scrolling is the one thing the page can observe, and the UI says so (`FULL_PAGE_SCROLL_NOTE`).
// Everything a script answers is page data to main: `parseMeasure`, `parsePosition` and `parseArea`
// check it before it is used.

/** The part of a WebContents a script runs in. */
export interface ScriptTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

// The parts of the DOM the scripts use (structural, so main needs no DOM lib).
interface ScriptStyle {
  setProperty(name: string, value: string, priority?: string): void;
}
type Listener = (event: ScriptEvent) => void;
interface ScriptEvent {
  readonly isTrusted: boolean;
  readonly key?: string;
  readonly button?: number;
  readonly pointerId?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  preventDefault(): void;
  stopPropagation(): void;
}
interface ScriptElement {
  readonly style: ScriptStyle;
  readonly isConnected?: boolean;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  attachShadow(init: { mode: 'closed' }): { append(...nodes: ScriptElement[]): void };
  append(...nodes: ScriptElement[]): void;
  remove(): void;
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void;
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void;
  setPointerCapture?(pointerId: number): void;
}
interface ScriptBox {
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}
interface ScriptView {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
  scrollTo(options: { left: number; top: number; behavior: 'instant' }): void;
  requestAnimationFrame?(callback: () => void): number;
  readonly MutationObserver?: new (callback: () => void) => { observe(target: unknown, options: { childList: boolean }): void; disconnect(): void };
  addEventListener(type: string, listener: Listener, options?: boolean): void;
  removeEventListener(type: string, listener: Listener, options?: boolean): void;
}
/** The parts of `document` the scripts use. */
export interface ScriptDocument {
  readonly URL: string;
  readonly documentElement: (ScriptElement & ScriptBox & { appendChild(node: ScriptElement): unknown }) | null;
  readonly scrollingElement?: ScriptBox | null;
  readonly defaultView: ScriptView | null;
  createElement(name: string): ScriptElement;
}

/** What `measurePage` answers (CSS px). `clientWidth` / `clientHeight` are the viewport without scrollbars. */
export interface PageMeasure {
  readonly url: string;
  readonly scrollHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
}

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/** The page's scrolling element (`document.scrollingElement`: the root, or `<body>` in quirks mode), its viewport and scroll position. */
export function measurePage(document: ScriptDocument): PageMeasure {
  const view = document.defaultView;
  const box = document.scrollingElement ?? document.documentElement;
  const innerWidth = view ? view.innerWidth : 0;
  const innerHeight = view ? view.innerHeight : 0;
  return {
    url: document.URL,
    scrollHeight: box ? box.scrollHeight : 0,
    innerWidth,
    innerHeight,
    // A scrolling element without layout (a frameset) reports 0: the whole viewport, then.
    clientWidth: box && box.clientWidth > 0 ? box.clientWidth : innerWidth,
    clientHeight: box && box.clientHeight > 0 ? box.clientHeight : innerHeight,
    scrollX: view ? view.scrollX : 0,
    scrollY: view ? view.scrollY : 0,
    devicePixelRatio: view ? view.devicePixelRatio : 0,
  };
}

/** Scrolls to `(x, y)` instantly, waits `frames` animation frames (at most `timeoutMs`), and answers where the page actually is. */
export function scrollAndSettle(document: ScriptDocument, args: { x: number; y: number; frames: number; timeoutMs: number }): Promise<ScrollPosition | null> {
  const view = document.defaultView;
  if (!view) return Promise.resolve(null);
  view.scrollTo({ left: args.x, top: args.y, behavior: 'instant' });
  return new Promise((resolve) => {
    let done = false;
    let left = args.frames;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ x: view.scrollX, y: view.scrollY });
    };
    const timer = setTimeout(finish, args.timeoutMs);
    const tick = (): void => {
      left -= 1;
      if (left <= 0) finish();
      else if (!done) view.requestAnimationFrame!(tick);
    };
    if (left <= 0 || typeof view.requestAnimationFrame !== 'function') finish();
    else view.requestAnimationFrame(tick);
  });
}

/** Scrolls back to `(x, y)` instantly; answers where the page is. */
export function restoreScroll(document: ScriptDocument, args: { x: number; y: number }): ScrollPosition | null {
  const view = document.defaultView;
  if (!view) return null;
  view.scrollTo({ left: args.x, top: args.y, behavior: 'instant' });
  return { x: view.scrollX, y: view.scrollY };
}

export interface AreaConfig {
  /** The isolated world's global property holding the pending selection (`AREA_STATE_KEY`). */
  readonly key: string;
  readonly minAreaCssPx: number;
  readonly timeoutMs: number;
  /** Frames to wait once the overlay is gone, so main's capture does not show it. */
  readonly settleFrames: number;
  /** The line shown on the page while it selects (`AREA_SELECT_HINT`). */
  readonly hint: string;
}

/** A pending selection, on the isolated world's global (`store[key]`). */
export interface AreaState {
  /** Ends it with no area. */
  cancel(): void;
  /** The element that takes the drag (in the closed root: reachable from this world only). */
  readonly surface: ScriptElement;
}

/**
 * The area selector: resolves the rectangle the user drags (CSS viewport px, edges rounded
 * outwards, clamped to the viewport), or `null` (a trusted Esc, the cancel script, the timeout, the
 * page being left, or another selection starting). Self-contained (`store`: the world's global).
 */
export function selectArea(document: ScriptDocument, config: AreaConfig, store: Record<string, unknown>): Promise<ScreenshotRect | null> {
  const previous = store[config.key] as AreaState | undefined;
  if (previous && typeof previous.cancel === 'function') previous.cancel();
  const root = document.documentElement;
  const view = document.defaultView;
  if (!root || !view) return Promise.resolve(null);
  const css = (el: ScriptElement, props: Record<string, string>): void => {
    for (const name of Object.keys(props)) el.style.setProperty(name, props[name]!, 'important');
  };
  const SHADE = 'rgba(15, 23, 42, 0.38)';
  const host = document.createElement('div');
  css(host, {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    top: '0px',
    left: '0px',
    right: '0px',
    bottom: '0px',
    margin: '0px',
    padding: '0px',
    overflow: 'hidden',
    'z-index': '2147483647',
    cursor: 'crosshair',
    'pointer-events': 'auto',
    'user-select': 'none',
    'touch-action': 'none',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  const surface = document.createElement('div');
  css(surface, { position: 'absolute', top: '0px', left: '0px', right: '0px', bottom: '0px', cursor: 'crosshair', background: SHADE });
  const box = document.createElement('div');
  css(box, { position: 'absolute', display: 'none', 'box-sizing': 'border-box', border: '1px solid #ffffff', outline: '1px solid rgba(15, 23, 42, 0.7)', 'box-shadow': `0 0 0 100vmax ${SHADE}`, 'pointer-events': 'none' });
  const size = document.createElement('span');
  css(size, { position: 'absolute', right: '0px', bottom: '-22px', padding: '2px 6px', 'border-radius': '4px', background: 'rgba(15, 23, 42, 0.85)', color: '#ffffff', font: '600 11px/14px system-ui, -apple-system, "Segoe UI", sans-serif', 'white-space': 'nowrap', 'pointer-events': 'none' });
  box.append(size);
  const tip = document.createElement('div');
  tip.textContent = config.hint;
  css(tip, { position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)', padding: '6px 12px', 'border-radius': '6px', background: 'rgba(15, 23, 42, 0.85)', color: '#ffffff', font: '500 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif', 'white-space': 'nowrap', 'pointer-events': 'none' });
  surface.append(box, tip);
  shadow.append(surface);

  return new Promise((resolve) => {
    let done = false;
    let start: { x: number; y: number; id: number | undefined } | null = null;
    const clamp = (value: number | undefined, max: number): number => Math.max(0, Math.min(max, Number.isFinite(value) ? (value as number) : 0));
    const pointAt = (event: ScriptEvent) => ({ x: clamp(event.clientX, view.innerWidth), y: clamp(event.clientY, view.innerHeight) });
    const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }): ScreenshotRect => {
      const left = Math.floor(Math.min(a.x, b.x));
      const top = Math.floor(Math.min(a.y, b.y));
      return { x: left, y: top, width: Math.ceil(Math.max(a.x, b.x)) - left, height: Math.ceil(Math.max(a.y, b.y)) - top };
    };
    const draw = (rect: ScreenshotRect | null): void => {
      if (rect === null) {
        css(surface, { background: SHADE });
        css(box, { display: 'none' });
        return;
      }
      css(surface, { background: 'transparent' });
      css(box, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      css(size, { bottom: rect.y + rect.height + 26 > view.innerHeight ? '2px' : '-22px' });
      size.textContent = `${rect.width} × ${rect.height}`;
    };
    // The drag stops at the overlay: the page's bubbling listeners never get it, and nothing under
    // the overlay is clicked. The page still sees the pointer events in their capture phase
    // (retargeted to the host), before the overlay; it cannot see inside the closed root, and its own
    // events select nothing (`isTrusted`).
    const swallow = (event: ScriptEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onDown: Listener = (event) => {
      swallow(event);
      if (!event.isTrusted || (event.button ?? 0) !== 0) return;
      start = { ...pointAt(event), id: event.pointerId };
      try {
        if (event.pointerId !== undefined) surface.setPointerCapture?.(event.pointerId);
      } catch {
        // No capture: moves outside the window are not followed.
      }
      draw(rectOf(start, start));
    };
    const onMove: Listener = (event) => {
      swallow(event);
      if (!event.isTrusted || start === null || event.pointerId !== start.id) return;
      draw(rectOf(start, pointAt(event)));
    };
    const onUp: Listener = (event) => {
      swallow(event);
      if (!event.isTrusted || start === null || event.pointerId !== start.id) return;
      const rect = rectOf(start, pointAt(event));
      start = null;
      // A click, or a sliver: nothing selected yet.
      if (rect.width < config.minAreaCssPx || rect.height < config.minAreaCssPx) draw(null);
      else finish(rect);
    };
    const onPointerCancel: Listener = (event) => {
      if (!event.isTrusted) return;
      start = null;
      draw(null);
    };
    const onKey: Listener = (event) => {
      if (!event.isTrusted || event.key !== 'Escape') return;
      swallow(event);
      finish(null);
    };
    const onLeave: Listener = () => finish(null);
    const pointerListeners: [string, Listener][] = [
      ['pointerdown', onDown],
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onPointerCancel],
      ['click', swallow],
      ['contextmenu', swallow],
    ];
    const timer = setTimeout(() => finish(null), config.timeoutMs);
    // The page taking the host out of the document ends the selection (with no area).
    const Observer = view.MutationObserver;
    const observer =
      typeof Observer === 'function'
        ? new Observer(() => {
            if (host.isConnected === false) finish(null);
          })
        : null;

    function finish(result: ScreenshotRect | null): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer?.disconnect();
      for (const [type, listener] of pointerListeners) surface.removeEventListener(type, listener);
      view!.removeEventListener('keydown', onKey, true);
      view!.removeEventListener('pagehide', onLeave);
      host.remove();
      // Inert from now on: a page that appends the host again gets an empty, hidden element (its
      // shadow root holds nothing, and no listener is left).
      surface.remove();
      css(host, { display: 'none', 'pointer-events': 'none' });
      if (store[config.key] === state) store[config.key] = undefined;
      // The page paints without the overlay before main captures it.
      let frames = config.settleFrames;
      const settle = setTimeout(() => resolve(result), 500);
      const tick = (): void => {
        frames -= 1;
        if (frames > 0 && typeof view!.requestAnimationFrame === 'function') view!.requestAnimationFrame(tick);
        else {
          clearTimeout(settle);
          resolve(result);
        }
      };
      if (frames > 0 && typeof view!.requestAnimationFrame === 'function') view!.requestAnimationFrame(tick);
      else {
        clearTimeout(settle);
        resolve(result);
      }
    }

    const state: AreaState = { cancel: () => finish(null), surface };
    store[config.key] = state;
    for (const [type, listener] of pointerListeners) surface.addEventListener(type, listener);
    view.addEventListener('keydown', onKey, true);
    view.addEventListener('pagehide', onLeave);
    root.appendChild(host);
    observer?.observe(root, { childList: true });
  });
}

/** The isolated world's global property holding a pending area selection. */
export const AREA_STATE_KEY = '__frostScreenshotArea';

export const AREA_CONFIG: AreaConfig = {
  key: AREA_STATE_KEY,
  minAreaCssPx: SCREENSHOT_LIMITS.minAreaCssPx,
  timeoutMs: SCREENSHOT_LIMITS.areaTimeoutMs,
  settleFrames: SCREENSHOT_LIMITS.segmentSettleFrames,
  hint: AREA_SELECT_HINT,
};

export const measureScript = (): string => `(${measurePage.toString()})(document)`;
export const scrollScript = (x: number, y: number): string =>
  `(${scrollAndSettle.toString()})(document, ${JSON.stringify({ x, y, frames: SCREENSHOT_LIMITS.segmentSettleFrames, timeoutMs: SCREENSHOT_LIMITS.segmentTimeoutMs })})`;
export const restoreScript = (x: number, y: number): string => `(${restoreScroll.toString()})(document, ${JSON.stringify({ x, y })})`;
export const selectAreaScript = (): string => `(${selectArea.toString()})(document, ${JSON.stringify(AREA_CONFIG)}, globalThis)`;
/** Ends the pending selection in this world (it resolves `null`); answers whether there was one. */
export const cancelAreaScript = (): string =>
  `((store, key) => { const s = store[key]; if (s && typeof s.cancel === 'function') { s.cancel(); return true; } return false; })(globalThis, ${JSON.stringify(AREA_STATE_KEY)})`;

// ---- Main's side: run a script, check its answer -------------------------------------------------

const MAX_CSS_PX = 10_000_000;
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumberIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/**
 * A measure answer, if every value is a sane number (and the URL a string); else `null`. A page
 * taller than `MAX_CSS_PX` is taken as that tall (the stitch is cut at its caps anyway: `truncated`).
 */
export function parseMeasure(raw: unknown): PageMeasure | null {
  if (!isPlainObject(raw) || typeof raw['url'] !== 'string') return null;
  const { url, innerWidth, innerHeight, clientWidth, clientHeight, scrollX, scrollY, devicePixelRatio } = raw;
  const scrollHeight = isNumberIn(raw['scrollHeight'], 0, Number.MAX_VALUE) ? Math.min(raw['scrollHeight'], MAX_CSS_PX) : null;
  if (scrollHeight === null || !isNumberIn(innerWidth, 1, MAX_CSS_PX) || !isNumberIn(innerHeight, 1, MAX_CSS_PX)) return null;
  if (!isNumberIn(clientWidth, 0, MAX_CSS_PX) || !isNumberIn(clientHeight, 0, MAX_CSS_PX) || !isNumberIn(scrollX, -MAX_CSS_PX, MAX_CSS_PX) || !isNumberIn(scrollY, -MAX_CSS_PX, MAX_CSS_PX)) return null;
  if (!isNumberIn(devicePixelRatio, 0.01, 100)) return null;
  return { url: url as string, scrollHeight, innerWidth, innerHeight, clientWidth, clientHeight, scrollX, scrollY, devicePixelRatio };
}

/** A scroll position answer, else `null`. */
export function parsePosition(raw: unknown): ScrollPosition | null {
  if (!isPlainObject(raw) || !isNumberIn(raw['x'], -MAX_CSS_PX, MAX_CSS_PX) || !isNumberIn(raw['y'], -MAX_CSS_PX, MAX_CSS_PX)) return null;
  return { x: raw['x'], y: raw['y'] };
}

/** An area answer: `null` (nothing selected), a whole, positive rectangle, or `'invalid'` for anything else. */
export function parseArea(raw: unknown): ScreenshotRect | null | 'invalid' {
  if (raw === null) return null;
  if (!isPlainObject(raw) || Object.keys(raw).sort().join() !== 'height,width,x,y') return 'invalid';
  const { x, y, width, height } = raw;
  const whole = (value: unknown, min: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= MAX_CSS_PX;
  return whole(x, 0) && whole(y, 0) && whole(width, 1) && whole(height, 1) ? { x, y, width, height } : 'invalid';
}

const run = (target: ScriptTarget, code: string): Promise<unknown> => target.executeJavaScriptInIsolatedWorld(SCREENSHOT_WORLD_ID, [{ code }]);

export const runMeasure = async (target: ScriptTarget): Promise<PageMeasure | null> => parseMeasure(await run(target, measureScript()));
export const runScroll = async (target: ScriptTarget, x: number, y: number): Promise<ScrollPosition | null> => parsePosition(await run(target, scrollScript(x, y)));
export const runRestore = async (target: ScriptTarget, x: number, y: number): Promise<ScrollPosition | null> => parsePosition(await run(target, restoreScript(x, y)));
/** Runs the selector; resolves when it ends (`null`: no area; `'invalid'`: an answer that is not a rectangle). */
export const runSelectArea = async (target: ScriptTarget): Promise<ScreenshotRect | null | 'invalid'> => parseArea(await run(target, selectAreaScript()));
/** Ends a pending selection in the tab's screenshot world; whether one was pending. */
export const runCancelArea = async (target: ScriptTarget): Promise<boolean> => (await run(target, cancelAreaScript())) === true;
