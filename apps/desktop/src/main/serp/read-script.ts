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
// detached fragment first (an invalid one is `bad-selector`, before any page element
// is read), then the layout's `results` anchor (`no-container`), then each block's containers across
// the whole document and their items. It reads text nodes (never `innerText`, never markup) and the
// resolved `href` of HTML links, nothing else. Precedence: an item inside a container of another
// block that is itself inside this block's container belongs to that block (the most specific wins);
// an item that is, or is inside, an item already taken is skipped (pack order, then document order:
// nested matches count once). The items taken are sorted by document order, and consecutive items of
// one block and container make one answered block. Every count, string, node visit and the time are
// capped while it reads (`SERP_READ_LIMITS`); every per-item DOM read is inside `try`/`catch`. Its
// answer is still page data: the SERP worker validates it (`SerpReadSchema`).

/** The parts of a DOM node the reader uses (structural, so main needs no DOM lib). */
interface SerpNode {
  readonly nodeType: number;
  readonly parentElement?: SerpElement | null;
}
interface SerpTextNode extends SerpNode {
  readonly length: number;
  substringData(offset: number, count: number): string;
}
interface SerpList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface SerpElement extends SerpNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly href?: unknown;
  querySelector(selectors: string): SerpElement | null;
  querySelectorAll(selectors: string): SerpList<SerpElement>;
  contains(other: SerpElement): boolean;
  compareDocumentPosition(other: SerpElement): number;
  getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}
interface SerpTreeWalker {
  nextNode(): SerpNode | null;
}
/** The parts of `document` the reader uses. */
export interface SerpDocument {
  readonly defaultView: { readonly scrollX: number; readonly scrollY: number } | null;
  querySelector(selectors: string): SerpElement | null;
  querySelectorAll(selectors: string): SerpList<SerpElement>;
  createDocumentFragment(): { querySelector(selectors: string): unknown; appendChild(node: unknown): unknown };
  createElement(name: 'div'): unknown;
  createTreeWalker(root: SerpNode, whatToShow: number): SerpTreeWalker;
}

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
  /** Thrown to stop at the node or time budget, and on a selector the page's engine refuses. */
  const OVER = { stop: 'over' };
  const BAD = { stop: 'bad' };
  let nodes = 0;
  let truncated = false;

  const stats = () => ({ nodes: Math.min(nodes, L.maxNodesVisited), elapsedMs: Math.max(0, Math.round((performance.now() - started) * 1000) / 1000), truncated });
  /** Counts `n` node visits; past the node or time budget the read stops. */
  const visit = (n: number): void => {
    nodes += n;
    if (nodes > L.maxNodesVisited || performance.now() >= deadline) throw OVER;
  };
  const all = (root: SerpDocument | SerpElement, selectors: string): SerpList<SerpElement> => {
    try {
      return root.querySelectorAll(selectors);
    } catch {
      throw BAD;
    }
  };
  const first = (root: SerpElement, selectors: string): SerpElement | null => {
    try {
      return root.querySelector(selectors);
    } catch {
      throw BAD;
    }
  };

  // 1. Every selector, on a detached fragment of this world's own holding one empty element (some
  //    engines only reject an unknown pseudo-class when there is an element to match): an invalid
  //    one reads nothing from the page.
  const blocks = Array.isArray(layout?.blocks) ? layout.blocks : [];
  const selectors: unknown[] = [layout?.results];
  for (const block of blocks) {
    selectors.push(block?.container);
    for (const optional of [block?.item, block?.link, block?.title]) if (optional !== undefined) selectors.push(optional);
  }
  try {
    const probe = document.createDocumentFragment();
    probe.appendChild(document.createElement('div'));
    for (const selector of selectors) {
      if (typeof selector !== 'string' || selector.trim() === '') throw BAD;
      probe.querySelector(selector);
    }
    if (blocks.length === 0) throw BAD;
  } catch {
    return { ok: false, reason: 'bad-selector', stats: stats() };
  }

  /** Scroll offset, to put boxes in document coordinates. */
  let scrollX = 0;
  let scrollY = 0;
  try {
    const view = document.defaultView;
    scrollX = Number.isFinite(view?.scrollX) ? Number(view?.scrollX) : 0;
    scrollY = Number.isFinite(view?.scrollY) ? Number(view?.scrollY) : 0;
  } catch {
    // No view: viewport coordinates.
  }
  type Rect = { x: number; y: number; width: number; height: number };
  const rectOf = (el: SerpElement): Rect | undefined => {
    try {
      const r = el.getBoundingClientRect();
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
  const textOf = (el: SerpElement): string => {
    let raw = '';
    const walker = document.createTreeWalker(el, SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null && raw.length < L.maxTextReadChars; node = walker.nextNode()) {
      visit(1);
      const parent = node.parentElement?.localName;
      if (parent === 'script' || parent === 'style' || parent === 'noscript') continue;
      raw += (node as SerpTextNode).substringData(0, L.maxTextReadChars - raw.length);
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
  /** A link's resolved `href`, if it is an HTML link to an `http:` / `https:` URL within `maxUrlChars`. */
  const hrefOf = (el: SerpElement | null): string | null => {
    if (el === null || el.namespaceURI !== XHTML || (el.localName !== 'a' && el.localName !== 'area')) return null;
    const href = el.href;
    if (typeof href !== 'string' || href.length > L.maxUrlChars || !/^https?:\/\/[^\u0000- \u007f]+$/.test(href)) return null;
    return href;
  };
  const isLink = (el: SerpElement): boolean => el.namespaceURI === XHTML && el.localName === 'a';

  type Block = EngineLayout['blocks'][number];
  type Taken = { el: SerpElement; block: number; container: number; title: string; url: string | null; rect: Rect | undefined };
  const taken: Taken[] = [];
  let reachedCap = false;

  /** An item's title and link by the block's rules, or `null` when it has neither (organic results and ads need a link). */
  const readItem = (el: SerpElement, block: Block): { title: string; url: string | null } | null => {
    const link = block.link !== undefined ? first(el, block.link) : isLink(el) ? el : first(el, 'a[href]');
    const url = hrefOf(link);
    if (url === null && (block.type === 'organic' || block.type === 'ad')) return null;
    const titleEl = block.title !== undefined ? first(el, block.title) : (link ?? el);
    const title = titleEl === null ? '' : textOf(titleEl);
    return url === null && title === '' ? null : { title, url };
  };

  /** Groups the items taken, in document order, into runs of one block and container. */
  const answered = () => {
    const ordered = taken.slice().sort((a, b) => {
      if (a.el === b.el) return 0;
      try {
        return a.el.compareDocumentPosition(b.el) & FOLLOWING ? -1 : 1;
      } catch {
        return 0;
      }
    });
    const runs: { type: Block['type']; items: { title: string; url: string | null; rect?: Rect }[]; rect?: Rect }[] = [];
    let last: Taken | undefined;
    const rects: (Rect | undefined)[][] = [];
    for (const item of ordered) {
      if (!last || last.block !== item.block || last.container !== item.container) {
        if (runs.length >= L.maxBlocks) {
          truncated = true;
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
    let anchor: SerpElement | null;
    try {
      anchor = document.querySelector(layout.results);
    } catch {
      throw BAD;
    }
    if (anchor === null) return { ok: false, reason: 'no-container', stats: stats() };

    // 3. Each block's containers, across the whole document.
    const containers: SerpElement[][] = [];
    for (const block of blocks) {
      const list = all(document, block.container);
      const count = Math.min(list.length, L.maxContainersPerBlock);
      if (list.length > count) truncated = true;
      const found: SerpElement[] = [];
      for (let i = 0; i < count; i++) {
        visit(1);
        found.push(list[i]!);
      }
      containers.push(found);
    }
    // Per container, the other blocks' containers strictly inside it (their items are theirs).
    const nested = containers.map((found, b) =>
      found.map((container) => {
        const inside: SerpElement[] = [];
        containers.forEach((others, o) => {
          if (o === b) return;
          for (const other of others) {
            visit(1);
            try {
              if (other !== container && container.contains(other)) inside.push(other);
            } catch {
              // Unreadable: not nested.
            }
          }
        });
        return inside;
      }),
    );

    // 4. Items, block by block in pack order.
    reading: for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b]!;
      for (let c = 0; c < containers[b]!.length; c++) {
        const container = containers[b]![c]!;
        const items: SerpList<SerpElement> = block.item !== undefined ? all(container, block.item) : [container];
        for (let i = 0; i < items.length; i++) {
          visit(1);
          if (taken.length >= L.maxResults) {
            reachedCap = true;
            break reading;
          }
          const el = items[i]!;
          try {
            let skip = false;
            for (const other of nested[b]![c]!) {
              visit(1);
              if (other === el || other.contains(el)) {
                skip = true;
                break;
              }
            }
            if (!skip) {
              for (const prior of taken) {
                visit(1);
                if (prior.el === el || prior.el.contains(el)) {
                  skip = true;
                  break;
                }
              }
            }
            if (skip) continue;
            const result = readItem(el, block);
            if (result !== null) taken.push({ el, block: b, container: c, title: result.title, url: result.url, rect: rectOf(el) });
          } catch (error) {
            if (error === OVER || error === BAD) throw error;
            // A hostile item (a getter that throws): skipped.
          }
        }
      }
    }
    if (reachedCap) truncated = true;

    // 5. Never guess: a required block that took nothing, or nothing taken at all.
    if (taken.length === 0 || blocks.some((block, b) => block.required === true && !taken.some((item) => item.block === b))) {
      return { ok: false, reason: 'no-results', stats: stats() };
    }
    return { ok: true, blocks: answered(), stats: stats() };
  } catch (error) {
    if (error === BAD) return { ok: false, reason: 'bad-selector', stats: stats() };
    if (error === OVER) return { ok: false, reason: 'timeout', stats: stats(), blocks: answered() };
    return { ok: false, reason: 'no-results', stats: stats() };
  }
}

/** Only the fields the reader uses, so nothing else in a layout object reaches the page's world. */
function layoutArgument(layout: EngineLayout): EngineLayout {
  return {
    results: layout.results,
    blocks: layout.blocks.map((block) => ({
      type: block.type,
      container: block.container,
      ...(block.item !== undefined ? { item: block.item } : {}),
      ...(block.link !== undefined ? { link: block.link } : {}),
      ...(block.title !== undefined ? { title: block.title } : {}),
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
