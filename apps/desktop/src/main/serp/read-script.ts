import { SERP_READ_LIMITS, SERP_WORLD_ID, type SerpReadLimits } from '@app/specs/serp.spec';
import type { EngineLayout } from '@app/specs/serp-selector-pack.schema';

// The SERP reader (spec `serp.spec.ts`, "How a page is read"; `serp-snapshot.schema.ts`,
// `SerpReadSchema`; acceptance `serp-overlay.feature.md`, Reading; review focus
// `serp-reader-is-bounded`). `readSerp` is one self-contained function, serialised with the engine's
// layout and the spec's limits as JSON arguments (`serpReadScript`) and run in the tab's isolated
// SERP world (`SERP_WORLD_ID`, `runSerpRead`), like the SEO extractor. It references nothing outside
// its own body; `document`, the layout and the limits are its arguments.
//
// It treats every selector as untrusted input to `querySelectorAll`: all of them are checked on a
// detached fragment first (an invalid one is `bad-selector`, before any page element is read), then
// the layout's `results` anchor (`no-container`), then each block's containers across the whole
// document and their items. It reads text nodes (never `innerText`, never markup) and the resolved
// `href` of HTML links, nothing else. Every DOM method and getter it calls is taken once, at its
// start, from the prototypes of its own world (walking from `document` and from elements it
// creates, never reading a property of a page object by name) and called with `.call`, so DOM
// clobbering (`<form name="querySelector">` shadows `document.querySelector` in every world, an
// `<input name="closest">` a form's `closest`) cannot stand in for one.
//
// Precedence, per item: it is skipped when its closest match of another block's container lies
// inside this block's container (the most specific block wins), when its closest match of the
// block's `notInside` lies inside the container (a feature the pack does not read), and when it is,
// or is inside, an item already taken (pack order, then document order: nested matches count once).
// A block that names a `title` takes no item without one. Each block takes at most
// `maxItemsPerBlock`; everything taken is then sorted by document order and cut to `maxResults`, so
// the bottom of the page goes first. Consecutive items of one block and container make one answered
// block. Every count, string, node visit and the time are capped while it reads
// (`SERP_READ_LIMITS`); every per-item DOM read is inside `try`/`catch`. Its answer is still page
// data: the SERP worker validates it (`SerpReadSchema`).

/** The objects the reader touches (structural, so main needs no DOM lib); it calls their prototypes' methods, never their own properties. */
type SerpObject = object;
/** The page's document, as the reader is given it. */
export type SerpDocument = SerpObject;

/**
 * Reads a result page with `layout` (`SerpReadSchema`'s shape). Runs in the SERP world only.
 * Self-contained: it must not reference anything outside this function. Never throws.
 */
export function readSerp(document: SerpDocument, layout: EngineLayout, L: SerpReadLimits): unknown {
  const started = performance.now();
  const deadline = started + L.budgetMs;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const SHOW_TEXT = 0x4;
  const FOLLOWING = 0x4;
  /** Thrown to stop at the node or time budget, on a selector the page's engine refuses, and when a DOM method cannot be found. */
  const OVER = { stop: 'over' };
  const BAD = { stop: 'bad' };
  const ENV = { stop: 'env' };
  let nodes = 0;
  let truncated = false;
  let organicCut = false;

  const stats = () => ({ nodes: Math.min(nodes, L.maxNodesVisited), elapsedMs: Math.max(0, Math.round((performance.now() - started) * 1000) / 1000), truncated, organicCut });

  // 0. The DOM's own methods and getters, from the prototype chain (never an own, clobberable property).
  type Fn = (...args: unknown[]) => unknown;
  const describe = (object: SerpObject, name: string): PropertyDescriptor | undefined => {
    for (let proto = Object.getPrototypeOf(object) as object | null; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor) return descriptor;
    }
    return undefined;
  };
  const method = (object: SerpObject, name: string): Fn => {
    const fn = describe(object, name)?.value as unknown;
    if (typeof fn !== 'function') throw ENV;
    return fn as Fn;
  };
  const getter = (object: SerpObject, name: string): Fn => {
    const fn = describe(object, name)?.get;
    if (typeof fn !== 'function') throw ENV;
    return fn as Fn;
  };
  const call = <T>(fn: Fn, self: unknown, ...args: unknown[]): T => Reflect.apply(fn, self, args) as T;

  let dom: {
    qs: Fn; qsa: Fn; createElement: Fn; createTreeWalker: Fn; view: Fn;
    elQs: Fn; elQsa: Fn; closest: Fn; rect: Fn; localName: Fn; namespace: Fn; contains: Fn; compare: Fn; parent: Fn; append: Fn;
    href: Fn; fragQs: Fn; substring: Fn; next: Fn; fragment: SerpObject;
  };
  try {
    const createElement = method(document, 'createElement');
    const createTreeWalker = method(document, 'createTreeWalker');
    const div = call<SerpObject>(createElement, document, 'div');
    const fragment = call<SerpObject>(method(document, 'createDocumentFragment'), document);
    const text = call<SerpObject>(method(document, 'createTextNode'), document, '');
    dom = {
      qs: method(document, 'querySelector'),
      qsa: method(document, 'querySelectorAll'),
      createElement,
      createTreeWalker,
      view: getter(document, 'defaultView'),
      elQs: method(div, 'querySelector'),
      elQsa: method(div, 'querySelectorAll'),
      closest: method(div, 'closest'),
      rect: method(div, 'getBoundingClientRect'),
      localName: getter(div, 'localName'),
      namespace: getter(div, 'namespaceURI'),
      contains: method(div, 'contains'),
      compare: method(div, 'compareDocumentPosition'),
      parent: getter(div, 'parentElement'),
      append: method(div, 'appendChild'),
      href: getter(call<SerpObject>(createElement, document, 'a'), 'href'),
      fragQs: method(fragment, 'querySelector'),
      substring: method(text, 'substringData'),
      next: method(call<SerpObject>(createTreeWalker, document, fragment, SHOW_TEXT), 'nextNode'),
      fragment,
    };
  } catch {
    // Not a DOM this reader knows: nothing can be read.
    return { ok: false, reason: 'no-results', stats: stats() };
  }

  /** Counts `n` node visits; past the node or time budget the read stops. */
  const visit = (n: number): void => {
    nodes += n;
    if (nodes > L.maxNodesVisited || performance.now() >= deadline) throw OVER;
  };
  type List = { readonly length: number; readonly [index: number]: SerpObject };
  const all = (root: SerpObject, selectors: string): List => {
    try {
      return call<List>(root === document ? dom.qsa : dom.elQsa, root, selectors);
    } catch {
      throw BAD;
    }
  };
  const first = (root: SerpObject, selectors: string): SerpObject | null => {
    try {
      return call<SerpObject | null>(root === document ? dom.qs : dom.elQs, root, selectors);
    } catch {
      throw BAD;
    }
  };
  const closest = (el: SerpObject, selectors: string): SerpObject | null => {
    try {
      return call<SerpObject | null>(dom.closest, el, selectors);
    } catch {
      throw BAD;
    }
  };
  const contains = (outer: SerpObject, inner: SerpObject): boolean => call<boolean>(dom.contains, outer, inner);
  /** Whether `match` lies inside `container` (not the container itself). */
  const within = (match: SerpObject | null, container: SerpObject): boolean => match !== null && match !== container && contains(container, match);

  // 1. Every selector, on the detached fragment holding one empty element (some engines only reject
  //    an unknown pseudo-class when there is an element to match): an invalid one reads nothing
  //    from the page.
  const blocks = Array.isArray(layout?.blocks) ? layout.blocks : [];
  const selectors: unknown[] = [layout?.results];
  for (const block of blocks) {
    selectors.push(block?.container);
    for (const optional of [block?.item, block?.link, block?.title, block?.notInside, block?.box]) if (optional !== undefined) selectors.push(optional);
  }
  try {
    call(dom.append, dom.fragment, call(dom.createElement, document, 'div'));
    for (const selector of selectors) {
      if (typeof selector !== 'string' || selector.trim() === '') throw BAD;
      call(dom.fragQs, dom.fragment, selector);
    }
    if (blocks.length === 0) throw BAD;
  } catch {
    return { ok: false, reason: 'bad-selector', stats: stats() };
  }

  /** Scroll offset, to put boxes in document coordinates. */
  let scrollX = 0;
  let scrollY = 0;
  try {
    const view = call<{ scrollX?: unknown; scrollY?: unknown } | null>(dom.view, document);
    scrollX = Number.isFinite(view?.scrollX) ? Number(view?.scrollX) : 0;
    scrollY = Number.isFinite(view?.scrollY) ? Number(view?.scrollY) : 0;
  } catch {
    // No view: viewport coordinates.
  }
  type Rect = { x: number; y: number; width: number; height: number };
  const rectOf = (el: SerpObject): Rect | undefined => {
    try {
      const r = call<{ left: number; top: number; width: number; height: number }>(dom.rect, el);
      const box = { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
      const values = [box.x, box.y, box.width, box.height];
      if (!values.every((v) => Number.isFinite(v) && Math.abs(v) <= L.maxCoordinate) || box.width < 1 || box.height < 1) return undefined;
      return box;
    } catch {
      return undefined;
    }
  };
  const union = (rects: readonly (Rect | undefined)[]): Rect | undefined => {
    let box: { left: number; top: number; right: number; bottom: number } | undefined;
    for (const r of rects) {
      if (!r) continue;
      box = box
        ? { left: Math.min(box.left, r.x), top: Math.min(box.top, r.y), right: Math.max(box.right, r.x + r.width), bottom: Math.max(box.bottom, r.y + r.height) }
        : { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
    }
    if (!box || box.right - box.left > L.maxCoordinate || box.bottom - box.top > L.maxCoordinate) return undefined;
    return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
  };

  /** An element's text: its text nodes (not script, style or noscript), read up to `maxTextReadChars`, whitespace collapsed, capped. */
  const textOf = (el: SerpObject): string => {
    let raw = '';
    const walker = call<SerpObject>(dom.createTreeWalker, document, el, SHOW_TEXT);
    for (let node = call<SerpObject | null>(dom.next, walker); node !== null && raw.length < L.maxTextReadChars; node = call<SerpObject | null>(dom.next, walker)) {
      visit(1);
      const parent = call<SerpObject | null>(dom.parent, node);
      const name = parent === null ? '' : call<string>(dom.localName, parent);
      if (name === 'script' || name === 'style' || name === 'noscript') continue;
      raw += call<string>(dom.substring, node, 0, L.maxTextReadChars - raw.length);
    }
    let text = raw
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > L.maxTitleChars) {
      text = text.slice(0, L.maxTitleChars);
      if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    }
    return text;
  };
  const isLink = (el: SerpObject): boolean => call<string | null>(dom.namespace, el) === XHTML && call<string>(dom.localName, el) === 'a';
  /** A link's resolved `href`, if it is an HTML `a` to an `http:` / `https:` URL within `maxUrlChars`. */
  const hrefOf = (el: SerpObject | null): string | null => {
    if (el === null) return null;
    let href: unknown;
    try {
      if (!isLink(el)) return null;
      href = call(dom.href, el);
    } catch {
      return null;
    }
    if (typeof href !== 'string' || href.length > L.maxUrlChars || !/^https?:\/\/[^\u0000- \u007f]+$/.test(href)) return null;
    return href;
  };

  type Block = EngineLayout['blocks'][number];
  type Taken = { el: SerpObject; block: number; container: number; title: string; url: string | null; rect: Rect | undefined };
  const taken: Taken[] = [];

  /** An item's title and link by the block's rules, or `null` when it is not a result (organic results and ads need a link; a named title must be there). */
  const readItem = (el: SerpObject, block: Block): { title: string; url: string | null } | null => {
    const link = block.link !== undefined ? first(el, block.link) : isLink(el) ? el : first(el, 'a[href]');
    const url = hrefOf(link);
    if (url === null && (block.type === 'organic' || block.type === 'ad')) return null;
    let title: string;
    if (block.title !== undefined) {
      const titleEl = first(el, block.title);
      if (titleEl === null) return null;
      title = textOf(titleEl);
    } else {
      title = textOf(link ?? el);
    }
    return url === null && title === '' ? null : { title, url };
  };

  /** The items taken, in document order, cut to `maxResults` and grouped into runs of one block and container (at most `maxBlocks`). */
  const answered = () => {
    const ordered = taken.slice().sort((a, b) => {
      if (a.el === b.el) return 0;
      try {
        return call<number>(dom.compare, a.el, b.el) & FOLLOWING ? -1 : 1;
      } catch {
        return 0;
      }
    });
    const cutFrom = (kept: number) => {
      truncated = true;
      if (ordered.slice(kept).some((item) => blocks[item.block]!.type === 'organic')) organicCut = true;
      ordered.length = kept;
    };
    if (ordered.length > L.maxResults) cutFrom(L.maxResults);
    const runs: { type: Block['type']; items: { title: string; url: string | null; rect?: Rect }[]; rect?: Rect }[] = [];
    const rects: (Rect | undefined)[][] = [];
    let last: Taken | undefined;
    for (let index = 0; index < ordered.length; index++) {
      const item = ordered[index]!;
      if (!last || last.block !== item.block || last.container !== item.container) {
        if (runs.length >= L.maxBlocks) {
          cutFrom(index);
          break;
        }
        runs.push({ type: blocks[item.block]!.type, items: [] });
        rects.push([]);
      }
      runs[runs.length - 1]!.items.push(item.rect ? { title: item.title, url: item.url, rect: item.rect } : { title: item.title, url: item.url });
      rects[rects.length - 1]!.push(item.rect);
      last = item;
    }
    runs.forEach((run, index) => {
      const box = union(rects[index]!);
      if (box) run.rect = box;
    });
    return runs;
  };

  try {
    // 2. The results anchor: the page is read only when it is there.
    if (first(document, layout.results) === null) return { ok: false, reason: 'no-container', stats: stats() };

    // 3. Each block's containers, across the whole document.
    const containers: SerpObject[][] = [];
    for (const block of blocks) {
      const list = all(document, block.container);
      const count = Math.min(list.length, L.maxContainersPerBlock);
      if (list.length > count) {
        truncated = true;
        if (block.type === 'organic') organicCut = true;
      }
      const found: SerpObject[] = [];
      for (let i = 0; i < count; i++) {
        visit(1);
        found.push(list[i]!);
      }
      containers.push(found);
    }

    // 4. Items, block by block in pack order, at most `maxItemsPerBlock` each.
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      let count = 0;
      blockItems: for (let c = 0; c < containers[b]!.length; c++) {
        const container = containers[b]![c]!;
        const items: List = block.item !== undefined ? all(container, block.item) : [container];
        for (let i = 0; i < items.length; i++) {
          visit(1);
          if (count >= L.maxItemsPerBlock) {
            truncated = true;
            if (block.type === 'organic') organicCut = true;
            break blockItems;
          }
          const el = items[i]!;
          try {
            let skip = false;
            // Inside a tighter block's container, or a wrapper this block excludes.
            for (let o = 0; o < blocks.length && !skip; o++) {
              if (o === b) continue;
              visit(1);
              skip = within(closest(el, blocks[o]!.container), container);
            }
            if (!skip && block.notInside !== undefined) {
              visit(1);
              skip = within(closest(el, block.notInside), container);
            }
            // Already taken, or inside an item taken.
            for (let t = 0; t < taken.length && !skip; t++) {
              visit(1);
              const prior = taken[t]!.el;
              skip = prior === el || contains(prior, el);
            }
            if (skip) continue;
            const result = readItem(el, block);
            if (result === null) continue;
            let boxEl = el;
            if (block.box !== undefined) {
              const box = closest(el, block.box);
              if (box !== null && (box === container || contains(container, box))) boxEl = box;
            }
            taken.push({ el, block: b, container: c, title: result.title, url: result.url, rect: rectOf(boxEl) });
            count += 1;
          } catch (error) {
            if (error === OVER || error === BAD) throw error;
            // A hostile item (a getter that throws): skipped.
          }
        }
      }
    }

    // 5. Never guess: a required block that took nothing, or nothing taken at all.
    if (taken.length === 0 || blocks.some((block, b) => block.required === true && !taken.some((item) => item.block === b))) {
      return { ok: false, reason: 'no-results', stats: stats() };
    }
    const runs = answered();
    return { ok: true, blocks: runs, stats: stats() };
  } catch (error) {
    if (error === BAD) return { ok: false, reason: 'bad-selector', stats: stats() };
    if (error === OVER) {
      const runs = answered();
      return { ok: false, reason: 'timeout', stats: stats(), blocks: runs };
    }
    return { ok: false, reason: 'no-results', stats: stats() };
  }
}

/** Only the fields the reader uses, so nothing else in a layout object reaches the page's world (the reader's script and the outlines'). */
export function layoutArgument(layout: EngineLayout): EngineLayout {
  return {
    results: layout.results,
    blocks: layout.blocks.map((block) => ({
      type: block.type,
      container: block.container,
      ...(block.item !== undefined ? { item: block.item } : {}),
      ...(block.link !== undefined ? { link: block.link } : {}),
      ...(block.title !== undefined ? { title: block.title } : {}),
      ...(block.notInside !== undefined ? { notInside: block.notInside } : {}),
      ...(block.box !== undefined ? { box: block.box } : {}),
      ...(block.required !== undefined ? { required: block.required } : {}),
    })),
  };
}

/**
 * The script run in the SERP world: `readSerp` called on its `document` with `layout` and the
 * limits, both as JSON (a selector is always a string literal, never code).
 */
export function serpReadScript(layout: EngineLayout, limits: SerpReadLimits = SERP_READ_LIMITS): string {
  return `(${readSerp.toString()})(document, ${JSON.stringify(layoutArgument(layout))}, ${JSON.stringify(limits)})`;
}

/** The part of a tab's WebContents the reader needs. */
export interface SerpReadTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the reader in `contents`' SERP world; resolves its (untrusted, unvalidated) answer. */
export function runSerpRead(contents: SerpReadTarget, layout: EngineLayout): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SERP_WORLD_ID, [{ code: serpReadScript(layout) }]);
}
