import { REGION_EXTRACT_LIMITS } from '@app/specs/changes.spec';
import { INSPECTOR_LIMITS, INSPECTOR_WORLD_ID, type InspectorLimits, type NodePath } from '@app/specs/inspector.spec';

// The inspector's page scripts (Phase 6 Task 8; spec `inspector.spec.ts`; acceptance
// `inspector.feature.md`, Page scripts). `inspectPage` is one self-contained function: it is
// serialised with its request and limits into a script and run in the tab's isolated world
// `INSPECTOR_WORLD_ID` (`executeJavaScriptInIsolatedWorld`), so nothing the page defines reaches it,
// and it keeps its state (the document's token, the outline overlay, a pick under way) on that
// world's own global, which page scripts cannot reach.
//
// - `token`: the document's token (made once per document: a new document has a new world).
// - `children`: the node at a path and a capped page of its element children.
// - `node`: a node's details: tag, capped attributes, box, a few computed styles, its landmark region
//   (the rules of `changes/regions.ts`, inlined: a function cannot be shared across serialisation;
//   a test checks the two agree) and its SEO facts.
// - `pick`: hover outline, trusted click picks; Esc, the timeout, the page moving on or the overlay's
//   host being removed end it with nothing (`null`). The selection outline stays afterwards.
// - `highlight` / `clear` / `cancelPick`: a tree row's outline, everything off, the pick ended.
//
// Read-only: no page element's attributes, styles or text are ever written. The outlines are drawn
// with the Phase 2 highlight's technique (`seo/highlight.ts`): one host element of the inspector's own
// appended to `<html>`, a **closed** shadow root, inline styles through the CSSOM only
// (`style.setProperty`), removed as soon as nothing is outlined; a host the page appends again is
// inert (empty and hidden, no listener left). Every answer is page data to main: `service.ts`
// validates it with `inspector.schema.ts` before it is used.

/** The part of a WebContents a script runs in. */
export interface InspectorScriptTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

// The parts of the DOM the script uses (structural, so main needs no DOM lib).
interface PageList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface PageNode {
  readonly nodeType: number;
  readonly nextSibling: PageNode | null;
}
interface PageText extends PageNode {
  readonly length: number;
  substringData(offset: number, count: number): string;
}
interface PageStyle {
  setProperty(name: string, value: string, priority?: string): void;
}
interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
type Listener = (event: PageEvent) => void;
interface PageEvent {
  readonly isTrusted: boolean;
  readonly key?: string;
  readonly target?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation?(): void;
}
interface PageElement extends PageNode {
  readonly localName: string;
  readonly parentElement: PageElement | null;
  readonly previousElementSibling: PageElement | null;
  readonly children: PageList<PageElement>;
  readonly childElementCount: number;
  readonly firstChild: PageNode | null;
  readonly attributes: PageList<{ readonly name: string; readonly value: string }>;
  readonly classList?: { readonly length: number; item(index: number): string | null };
  readonly shadowRoot?: unknown;
  readonly isConnected?: boolean;
  readonly style: PageStyle;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): PageRect;
  attachShadow(init: { mode: 'closed' }): { append(...nodes: PageElement[]): void };
  append(...nodes: PageElement[]): void;
  appendChild(node: PageElement): unknown;
  remove(): void;
  // `img`'s
  readonly currentSrc?: string;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
}
interface PageView {
  readonly scrollX: number;
  readonly scrollY: number;
  getComputedStyle?(el: PageElement): { getPropertyValue(name: string): string };
  requestAnimationFrame?(callback: () => void): number;
  readonly MutationObserver?: new (callback: () => void) => { observe(target: unknown, options: { childList: boolean }): void; disconnect(): void };
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void;
}
/** The parts of `document` the script uses. */
export interface InspectorDocument {
  readonly baseURI: string;
  readonly documentElement: PageElement | null;
  readonly defaultView: PageView | null;
  createElement(name: string): PageElement;
  querySelectorAll(selectors: string): PageList<PageElement>;
}

/** One call into the page (`op`), with its arguments. `token` `null`: whichever document is shown. */
export type InspectorRequest =
  | { readonly op: 'token' }
  | { readonly op: 'children'; readonly path: NodePath; readonly token: string | null; readonly offset: number }
  | { readonly op: 'node'; readonly path: NodePath; readonly token: string | null }
  | { readonly op: 'pick'; readonly token: string | null }
  | { readonly op: 'highlight'; readonly path: NodePath | null; readonly token: string | null }
  | { readonly op: 'clear' }
  | { readonly op: 'cancelPick' };

/** The limits the script takes: the spec's, plus the landmark scan's cap (`REGION_EXTRACT_LIMITS.maxMainScan`). */
export type InspectorScriptLimits = InspectorLimits & { readonly maxMainScan: number };

export const INSPECTOR_SCRIPT_LIMITS: InspectorScriptLimits = { ...INSPECTOR_LIMITS, maxMainScan: REGION_EXTRACT_LIMITS.maxMainScan };

/** The isolated world's global property holding the inspector's state. */
export const INSPECTOR_STATE_KEY = '__frostInspector';

/** The state the script keeps on its world's global (`store[key]`); tests read it to reach inside the closed root. */
export interface InspectorState {
  readonly token: string;
  /** The overlay's host and its two outlines, while anything is outlined. */
  overlay: { readonly host: PageElement; readonly hover: PageElement; readonly selected: PageElement; redraw(): void; drop(): void } | null;
  /** Ends the pick under way with nothing picked. */
  pick: { cancel(): void } | null;
  /** The element the hover outline follows (the pointer while picking, or a tree row's node). */
  hover: PageElement | null;
  /** The element the selection outline follows (the last one picked). */
  selected: PageElement | null;
}

/**
 * Runs one inspector request on `document` (self-contained: it must not reference anything outside
 * this function; `store` is the isolated world's global, `key` its state's property). Answers plain
 * data, or a promise of it for `pick`; `{ status: 'stale' }` when `request.token` is not the
 * document's, `{ status: 'not-found' }` when no element is at the path.
 */
export function inspectPage(document: InspectorDocument, store: Record<string, unknown>, key: string, request: InspectorRequest, L: InspectorScriptLimits): unknown {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const view = document.defaultView;
  // ---- State and token ----
  let state = store[key] as InspectorState | undefined;
  if (!state || typeof state.token !== 'string') {
    const bytes = new Uint8Array(16);
    const random = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto;
    if (random && typeof random.getRandomValues === 'function') random.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let token = '';
    for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
    state = { token, overlay: null, pick: null, hover: null, selected: null };
    store[key] = state;
  }
  const S = state;
  if (request.op === 'token') return { docToken: S.token };
  if ('token' in request && request.token !== null && request.token !== S.token) return request.op === 'pick' ? Promise.resolve({ status: 'stale' }) : { status: 'stale' };

  // ---- Text helpers ----
  /** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const clean = (s: string): string => s.replace(LONE, '�');
  /** Whitespace runs collapsed to one space, trimmed, cut. */
  const squash = (s: string, max: number): string => cut(clean(cut(s, max * 4)).replace(/\s+/g, ' ').trim(), max);
  const attr = (el: PageElement, name: string): string | null => {
    const value = el.getAttribute(name);
    return value === null ? null : String(value);
  };
  const resolveUrl = (raw: string): string => {
    try {
      return cut(new URL(cut(raw.trim(), L.maxUrlChars * 2), document.baseURI).href, L.maxUrlChars);
    } catch {
      return cut(raw.trim(), L.maxUrlChars);
    }
  };

  // ---- Paths (our own host is never a child) ----
  const ownHost = (): PageElement | null => (S.overlay ? S.overlay.host : null);
  const isElement = (value: unknown): value is PageElement => typeof value === 'object' && value !== null && (value as PageNode).nodeType === ELEMENT_NODE;
  /** `el`'s `i`-th element child, our host left out. */
  const childAt = (el: PageElement, i: number): PageElement | null => {
    const host = ownHost();
    const kids = el.children;
    if (!host || host.parentElement !== el) return kids[i] ?? null;
    for (let j = 0, k = 0; j < kids.length; j++) {
      const kid = kids[j]!;
      if (kid === host) continue;
      if (k === i) return kid;
      k += 1;
    }
    return null;
  };
  const childCount = (el: PageElement): number => {
    const host = ownHost();
    return el.childElementCount - (host && host.parentElement === el ? 1 : 0);
  };
  const resolve = (path: NodePath): PageElement | null => {
    let el = document.documentElement;
    if (path.length > L.maxPathDepth) return null;
    for (const i of path) {
      if (!el) return null;
      el = childAt(el, i);
    }
    return el;
  };
  /** The path of `target` (or of its ancestor at `maxPathDepth`), `null` if it is not under `<html>` or is our host. */
  const pathOf = (target: PageElement): NodePath | null => {
    const root = document.documentElement;
    const host = ownHost();
    const chain: PageElement[] = [];
    let el: PageElement | null = target;
    while (el !== null && el !== root) {
      if (el === host) return null;
      chain.push(el);
      el = el.parentElement;
    }
    if (el === null) return null;
    chain.reverse();
    const path: NodePath = [];
    for (const step of chain.slice(0, L.maxPathDepth)) {
      let i = 0;
      for (let sibling = step.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) if (sibling !== host) i += 1;
      path.push(i);
    }
    return path;
  };

  // ---- Rows ----
  const tagOf = (el: PageElement): string => cut(String(el.localName).toLowerCase(), L.maxNameChars) || '?';
  /** `el`'s own text (its child text nodes, at most 256 looked at), collapsed and cut. */
  const ownText = (el: PageElement): string => {
    let text = '';
    let seen = 0;
    const budget = L.maxTextPreviewChars * 4;
    for (let node = el.firstChild; node !== null && seen < 256 && text.length < budget; node = node.nextSibling, seen++) {
      if (node.nodeType !== TEXT_NODE) continue;
      const data = node as PageText;
      text += `${data.substringData(0, Math.min(data.length, budget - text.length))} `;
    }
    return squash(text, L.maxTextPreviewChars);
  };
  const row = (el: PageElement, index: number) => {
    const classes: string[] = [];
    const list = el.classList;
    if (list) {
      for (let i = 0; i < list.length && classes.length < L.maxClassNames; i++) {
        const name = cut(clean(String(list.item(i) ?? '')), L.maxNameChars);
        if (name !== '') classes.push(name);
      }
    }
    return {
      index,
      tag: tagOf(el),
      id: cut(clean(attr(el, 'id') ?? ''), L.maxNameChars),
      classes,
      childElementCount: childCount(el),
      textPreview: ownText(el),
      shadow: el.shadowRoot !== null && el.shadowRoot !== undefined,
    };
  };

  // ---- Regions: the rules of `changes/regions.ts` (`changes-diff.feature.md`, Regions) ----
  const SECTIONING = ['article', 'aside', 'main', 'nav', 'section'];
  const SECTIONING_ROLES = ['article', 'complementary', 'main', 'navigation', 'region'];
  const roleOf = (el: PageElement): string => (attr(el, 'role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const landmarkOf = (el: PageElement, sectioned: boolean): string | null => {
    const role = roleOf(el);
    if (role !== '') return role === 'main' ? 'main' : role === 'navigation' ? 'nav' : role === 'complementary' ? 'aside' : role === 'banner' ? 'header' : role === 'contentinfo' ? 'footer' : null;
    const tag = el.localName;
    if (tag === 'main' || tag === 'nav' || tag === 'aside') return tag;
    if ((tag === 'header' || tag === 'footer') && !sectioned) return tag;
    return null;
  };
  const regionOf = (target: PageElement): string => {
    const chain: PageElement[] = [];
    for (let el: PageElement | null = target; el !== null; el = el.parentElement) chain.push(el);
    let region: string | null = null;
    let sectioned = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const el = chain[i]!;
      region = landmarkOf(el, sectioned) ?? region;
      sectioned = sectioned || SECTIONING.includes(el.localName) || SECTIONING_ROLES.includes(roleOf(el));
    }
    if (region !== null) return region;
    let hasMain = false;
    for (const selector of ['main', '[role~="main" i]']) {
      const mains = document.querySelectorAll(selector);
      for (let i = 0, n = Math.min(mains.length, L.maxMainScan); i < n && !hasMain; i++) {
        const el = mains[i];
        if (el && landmarkOf(el, false) === 'main') hasMain = true;
      }
    }
    return hasMain ? 'other' : 'main';
  };

  // ---- Details ----
  const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(-1e9, Math.min(1e9, n)) : 0);
  const details = (el: PageElement) => {
    const attributes: { name: string; value: string; truncated: boolean }[] = [];
    const all = el.attributes;
    for (let i = 0; i < all.length && attributes.length < L.maxAttributes; i++) {
      const a = all[i]!;
      const value = String(a.value);
      attributes.push({ name: cut(clean(String(a.name)), L.maxAttributeNameChars) || '?', value: cut(clean(value), L.maxAttributeValueChars), truncated: value.length > L.maxAttributeValueChars });
    }
    const rect = el.getBoundingClientRect();
    const box = { x: finite(rect.x), y: finite(rect.y), width: Math.max(0, finite(rect.width)), height: Math.max(0, finite(rect.height)) };
    const computed = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    const styles = L.computedStyleProps.map((name) => ({ name, value: cut(clean(computed ? String(computed.getPropertyValue(name)) : ''), L.maxValueChars) }));
    const tag = String(el.localName).toLowerCase();
    const value = (s: string | null): string => cut(clean(s ?? ''), L.maxValueChars);
    const href = attr(el, 'href');
    const name = attr(el, 'name') ?? attr(el, 'property');
    const rel = attr(el, 'rel');
    let lang: string | null = null;
    for (let at: PageElement | null = el; at !== null && lang === null; at = at.parentElement) lang = attr(at, 'lang');
    const seo = {
      headingLevel: /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : null,
      link: (tag === 'a' || tag === 'area') && href !== null ? { href: resolveUrl(href), rel: value(rel), target: value(attr(el, 'target')) } : null,
      image:
        tag === 'img'
          ? {
              src: el.currentSrc ? cut(String(el.currentSrc), L.maxUrlChars) : resolveUrl(attr(el, 'src') ?? ''),
              alt: attr(el, 'alt') === null ? null : value(attr(el, 'alt')),
              naturalWidth: Math.max(0, Math.floor(finite(el.naturalWidth))),
              naturalHeight: Math.max(0, Math.floor(finite(el.naturalHeight))),
            }
          : null,
      meta: tag === 'meta' && name !== null ? { name: value(name), content: value(attr(el, 'content')) } : null,
      linkRel: tag === 'link' && rel !== null ? { rel: value(rel), href: resolveUrl(href ?? '') } : null,
      lang: lang === null ? null : value(lang),
    };
    return {
      tag: tagOf(el),
      attributes,
      attributesMore: all.length > attributes.length,
      box,
      offset: { x: finite(box.x + (view ? view.scrollX : 0)), y: finite(box.y + (view ? view.scrollY : 0)) },
      styles,
      region: regionOf(el),
      seo,
      childElementCount: childCount(el),
    };
  };

  // ---- The overlay ----
  const css = (el: PageElement, props: Record<string, string>): void => {
    for (const prop of Object.keys(props)) el.style.setProperty(prop, props[prop]!, 'important');
  };
  const labelOf = (el: PageElement): string => {
    const r = row(el, 0);
    return `${r.tag}${r.id ? `#${r.id}` : ''}${r.classes.length > 0 ? `.${r.classes[0]}` : ''}`;
  };
  const place = (box: PageElement, el: PageElement | null, label: PageElement | null): void => {
    if (el === null || el.isConnected === false) {
      css(box, { display: 'none' });
      return;
    }
    const r = el.getBoundingClientRect();
    css(box, { display: 'block', left: `${finite(r.x)}px`, top: `${finite(r.y)}px`, width: `${Math.max(0, finite(r.width))}px`, height: `${Math.max(0, finite(r.height))}px` });
    if (label) {
      label.textContent = cut(labelOf(el), 80);
      css(label, r.y >= 22 ? { top: '-22px', bottom: 'auto' } : { top: 'auto', bottom: '-22px' });
    }
  };
  const overlay = (): NonNullable<InspectorState['overlay']> => {
    if (S.overlay) return S.overlay;
    const root = document.documentElement!;
    const host = document.createElement('div');
    css(host, { all: 'initial', display: 'block', position: 'fixed', top: '0px', left: '0px', right: '0px', bottom: '0px', margin: '0px', padding: '0px', overflow: 'hidden', 'z-index': '2147483647', 'pointer-events': 'none' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const layer = document.createElement('div');
    css(layer, { position: 'absolute', top: '0px', left: '0px', right: '0px', bottom: '0px', 'pointer-events': 'none' });
    const outline = (colour: string, fill: string): PageElement => {
      const box = document.createElement('div');
      css(box, { position: 'absolute', display: 'none', 'box-sizing': 'border-box', border: `2px solid ${colour}`, background: fill, 'pointer-events': 'none' });
      return box;
    };
    const selected = outline('#f97316', 'rgba(249, 115, 22, 0.10)');
    const hover = outline('#2563eb', 'rgba(37, 99, 235, 0.14)');
    const label = document.createElement('span');
    css(label, { position: 'absolute', left: '-2px', padding: '2px 6px', 'border-radius': '4px', background: '#1e3a8a', color: '#ffffff', font: '600 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace', 'white-space': 'nowrap', 'pointer-events': 'none' });
    hover.append(label);
    layer.append(selected, hover);
    shadow.append(layer);
    let frame = false;
    const redraw = (): void => {
      frame = false;
      place(selected, S.selected, null);
      place(hover, S.hover, label);
    };
    const onScroll: Listener = () => {
      if (frame) return;
      frame = true;
      if (view && typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(redraw);
      else redraw();
    };
    const Observer = view ? view.MutationObserver : undefined;
    const observer =
      typeof Observer === 'function'
        ? new Observer(() => {
            if (host.isConnected === false) {
              // The page took the host out: the pick ends, and nothing is outlined any more.
              S.hover = null;
              S.selected = null;
              S.pick?.cancel();
              current.drop();
            }
          })
        : null;
    const current: NonNullable<InspectorState['overlay']> = {
      host,
      hover,
      selected,
      redraw,
      drop: (): void => {
        if (S.overlay !== current) return;
        S.overlay = null;
        observer?.disconnect();
        view?.removeEventListener('scroll', onScroll, true);
        view?.removeEventListener('resize', onScroll);
        host.remove();
        // Inert from now on: a page that appends the host again gets an empty, hidden element.
        layer.remove();
        css(host, { display: 'none' });
      },
    };
    S.overlay = current;
    view?.addEventListener('scroll', onScroll, { capture: true, passive: true });
    view?.addEventListener('resize', onScroll);
    root.appendChild(host);
    observer?.observe(root, { childList: true });
    observer?.observe(document, { childList: true });
    return current;
  };
  /** Draws both outlines; the host goes once nothing is outlined and no pick is under way. */
  const refresh = (): void => {
    const nothing = (S.hover === null || S.hover.isConnected === false) && (S.selected === null || S.selected.isConnected === false);
    if (nothing && S.pick === null) {
      S.overlay?.drop();
      return;
    }
    overlay().redraw();
  };

  // ---- Requests ----
  if (request.op === 'clear') {
    S.pick?.cancel();
    S.hover = null;
    S.selected = null;
    refresh();
    return { status: 'ok' };
  }
  if (request.op === 'cancelPick') {
    if (S.pick === null) return false;
    S.pick.cancel();
    return true;
  }
  if (request.op === 'children') {
    const el = resolve(request.path);
    if (!el) return { status: 'not-found' };
    const host = ownHost();
    const kids = el.children;
    const children: ReturnType<typeof row>[] = [];
    let more = false;
    const skip = host !== null && host.parentElement === el;
    for (let j = skip ? 0 : request.offset, k = j; j < kids.length; j++) {
      const kid = kids[j]!;
      if (kid === host) continue;
      if (k >= request.offset) {
        if (children.length >= L.maxChildren) {
          more = true;
          break;
        }
        children.push(row(kid, k));
      }
      k += 1;
    }
    const index = request.path.length === 0 ? 0 : request.path[request.path.length - 1]!;
    return { status: 'ok', docToken: S.token, path: request.path, node: row(el, index), offset: request.offset, children, more };
  }
  if (request.op === 'node') {
    const el = resolve(request.path);
    if (!el) return { status: 'not-found' };
    return { status: 'ok', docToken: S.token, path: request.path, node: details(el) };
  }
  if (request.op === 'highlight') {
    if (request.path === null) {
      S.hover = null;
      refresh();
      return { status: 'ok' };
    }
    const el = resolve(request.path);
    if (!el) return { status: 'not-found' };
    S.hover = el;
    refresh();
    return { status: 'ok' };
  }

  // ---- Pick ----
  S.pick?.cancel();
  if (!view || !document.documentElement) return Promise.resolve(null);
  S.selected = null;
  S.hover = null;
  return new Promise((resolvePick) => {
    let done = false;
    const pick = { cancel: () => finish(null) };
    S.pick = pick;
    const host = overlay().host;
    const swallow = (event: PageEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    const onMove: Listener = (event) => {
      if (!event.isTrusted || !isElement(event.target) || event.target === host) return;
      if (S.hover === event.target) return;
      S.hover = event.target;
      refresh();
    };
    // The press and release are stopped too: the page's later listeners never hear them, nothing is
    // focused or selected, and no default action runs. Only a trusted click picks.
    const onPress: Listener = (event) => {
      if (event.isTrusted) swallow(event);
    };
    const onClick: Listener = (event) => {
      if (!event.isTrusted) return;
      swallow(event);
      if (!isElement(event.target)) return;
      const path = pathOf(event.target);
      if (path === null) return;
      const picked = resolve(path);
      finish(picked ? { status: 'picked', docToken: S.token, path } : null, picked);
    };
    const onKey: Listener = (event) => {
      if (!event.isTrusted || event.key !== 'Escape') return;
      swallow(event);
      finish(null);
    };
    const onLeave: Listener = () => finish(null);
    const listeners: [string, Listener][] = [
      ['pointermove', onMove],
      ['pointerdown', onPress],
      ['mousedown', onPress],
      ['pointerup', onPress],
      ['mouseup', onPress],
      ['auxclick', onPress],
      ['dblclick', onPress],
      ['click', onClick],
      ['keydown', onKey],
    ];
    const timer = setTimeout(() => finish(null), L.pickTimeoutMs);
    function finish(result: { status: 'picked'; docToken: string; path: NodePath } | null, picked: PageElement | null = null): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const [type, listener] of listeners) view!.removeEventListener(type, listener, true);
      view!.removeEventListener('pagehide', onLeave);
      if (S.pick === pick) S.pick = null;
      S.hover = null;
      S.selected = picked;
      refresh();
      resolvePick(result);
    }
    for (const [type, listener] of listeners) view.addEventListener(type, listener, true);
    view.addEventListener('pagehide', onLeave);
  });
}

const call = (request: InspectorRequest, limits: InspectorScriptLimits = INSPECTOR_SCRIPT_LIMITS): string =>
  `(${inspectPage.toString()})(document, globalThis, ${JSON.stringify(INSPECTOR_STATE_KEY)}, ${JSON.stringify(request)}, ${JSON.stringify(limits)})`;

/** The script for `request`, run in `INSPECTOR_WORLD_ID`. */
export const inspectorScript = call;

/** Runs `request` in the tab's inspector world; resolves its (untrusted, unvalidated) answer. */
export function runInspector(target: InspectorScriptTarget, request: InspectorRequest, limits?: InspectorScriptLimits): Promise<unknown> {
  return target.executeJavaScriptInIsolatedWorld(INSPECTOR_WORLD_ID, [{ code: call(request, limits) }]);
}
