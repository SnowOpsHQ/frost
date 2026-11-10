import { CONTENT_LIMITS, VISIBLE_TEXT_BLOCKS } from '@app/specs/seo-content.spec';
import { HIGHLIGHT_BUDGET_MS, HIGHLIGHT_FRAME_MS, MAX_KEYPHRASE_MATCHES, MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET, MAX_TEXT_HIGHLIGHT_TARGETS, SEO_WORLD_ID, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES, KEYPHRASE_UNMATCHED_NOTE, TEXT_HIGHLIGHT_UNMATCHED_NOTE, type HighlightKind, type HighlightMode, type TextHighlightTarget } from '@app/specs/seo-sidebar.spec';
import type { ExtractTarget } from './extract';

// Highlight mode (spec `seo-sidebar.spec.ts`, `HIGHLIGHT_MODES` / `HIGHLIGHT_STYLES`,
// `seo-limits.spec.ts`, `HIGHLIGHT_BUDGET_MS`; acceptance `seo-panels.feature.md`, Highlight): an
// overlay outlining the page's links by type or its headings by level, each box with a small label.
// `broken` (Phase 2.5 Task 7, `seo-checks.feature.md`) outlines only the links whose target (its
// `#fragment` aside) is one of `targets`: the tab's link check's broken ones, handed in by main.
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
//
// Text modes (`TEXT_HIGHLIGHT_MODES`: `sentences`, Phase 8 Task 2, `seo-content.feature.md`,
// Highlight) box texts main hands in (`TextHighlightTarget`, from its own ready audit) where they are
// in the page: the overlay reads the body's text nodes once (the extractor's skipped subtrees left
// out; at most `maxTextNodes` nodes and `maxTextScanChars` characters, within `budgetMs`, `frameMs`
// per frame), `planTextHighlight` finds each text in them, and each drawing pass boxes the matches'
// `Range.getClientRects()`, one range per text node a match covers (so an inline element inside it
// is not boxed again). A `Range` only points at page nodes: creating one changes nothing in the
// page. The texts reach the script as JSON data, never as code, and are only compared, never
// inserted. Texts not found are counted and said in the overlay (`unmatchedNote`).
//
// Phase 11 Task 2 (`seo-panels.feature.md`, `seo-content.feature.md`, Keyphrase highlight): `internal`
// and `external` outline only links of that kind (a `nofollow` one still as `nofollow`),
// `lazy-images` the `loading="lazy"` images (`lazy-first-viewport` over the first viewport), and
// `all` the links, headings and lazy images at once. `keyphrase` is a text mode whose plan is
// `planTextHighlight` with its "every occurrence" option (`TextEvery`): every whole-word occurrence
// of the phrase's words, by the same `Intl.Segmenter` segmentation and normalisation as the audit's
// n-grams, never across a block boundary the walk saw (as the extractor's visible text breaks there).

/** An element to outline: its kind and its `getBoundingClientRect()` (viewport coordinates). */
export interface HighlightItem {
  readonly kind: HighlightKind;
  readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** Drawn without its label (a text's later line fragments: the first one carries it). */
  readonly unlabelled?: boolean;
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
    boxes.push({ kind: item.kind, label: item.unlabelled === true ? '' : style.label, color: style.color, x: Math.round(left + sx), y: Math.round(top + sy), width: Math.round(width), height: Math.round(height) });
  }
  return boxes;
}

/** Where a found text is: its kind, and its start and end as [text node index, offset in that node's text]. */
export interface TextSpan {
  readonly kind: HighlightKind;
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}
export interface TextPlan {
  readonly spans: TextSpan[];
  /** Texts not found (or empty). */
  readonly unmatched: number;
}
/**
 * `planTextHighlight`'s "every occurrence" option (`keyphrase`): each target's `terms` are found as
 * whole words, every occurrence, at most `maxMatches` spans in all; words are normalised as
 * `normaliseTerm` does (cut to `maxWordChars` code points). `breaks`: the indexes of the text nodes
 * that start a new block (a word or a phrase never spans one).
 */
export interface TextEvery {
  readonly maxMatches: number;
  readonly maxWordChars: number;
  readonly breaks?: readonly number[];
  /** A `performance.now()` deadline: past it the plan stops with the spans found so far. */
  readonly until?: number;
}

/**
 * Finds the first `max` of `targets` in `texts` (the page's text nodes' text, in document order,
 * joined as written). White space runs count as one space, in the page's text (across nodes too)
 * and in each target (trimmed), as the extractor collapses it; every other character, bidi and
 * zero-width ones included, must match as it is. Each target is looked for after the previous
 * target's match (targets come in page order), so equal texts take successive occurrences. Pure and
 * self-contained: it is serialised into the overlay script too.
 *
 * With `every` (`keyphrase`), each target is instead found by its words (`terms`, normalised, in the
 * language `lang`): the page's text is segmented into words with `Intl.Segmenter` (a run of letters
 * and digits without it), each word normalised as the audit's are, and every run of words equal to
 * `terms`, with only white space, a hyphen or an apostrophe between two of them (never another
 * punctuation mark or a block break), is a span, in page order, without overlaps, at most
 * `every.maxMatches` in all. Words are matched as they are segmented: it stops at `maxMatches` and
 * at the `every.until` deadline, with what it found. A target without terms, or with no occurrence,
 * is unmatched.
 */
export function planTextHighlight(texts: readonly string[], targets: readonly TextHighlightTarget[], max: number, every?: TextEvery): TextPlan {
  // The collapsed text, and where each node's part of it starts.
  const starts: number[] = [];
  /** Whether the node's leading white space joined the run before it (and so adds nothing). */
  const joined: boolean[] = [];
  const parts: string[] = [];
  let length = 0;
  let space = false;
  for (const raw of texts) {
    let piece = raw.replace(/\s+/g, ' ');
    const join = space && piece.startsWith(' ');
    if (join) piece = piece.slice(1);
    starts.push(length);
    joined.push(join);
    parts.push(piece);
    length += piece.length;
    if (piece.length > 0) space = piece.endsWith(' ');
  }
  const flat = parts.join('');
  /** The node holding collapsed position `at` (the last one starting at or before it). */
  const nodeAt = (at: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** The offset in node `index`'s own text of its `k`th collapsed character. */
  const rawOffset = (index: number, k: number): number => {
    const raw = texts[index]!;
    let seen = 0;
    let inSpace = joined[index]!;
    for (let r = 0; r < raw.length; r++) {
      const white = /\s/.test(raw[r]!);
      if (white && inSpace) continue;
      if (seen === k) return r;
      seen += 1;
      inSpace = white;
    }
    return raw.length;
  };
  const spans: TextSpan[] = [];
  let unmatched = 0;
  /** The span from collapsed position `at` to `end` (exclusive; its last character is not white space). */
  const span = (kind: HighlightKind, at: number, end: number): TextSpan => {
    const last = end - 1;
    const first = nodeAt(at);
    const lastNode = nodeAt(last);
    return { kind, start: [first, rawOffset(first, at - starts[first]!)], end: [lastNode, rawOffset(lastNode, last - starts[lastNode]!) + 1] };
  };
  if (every) {
    /** Non-word segments a phrase may run across, as the audit's word runs (`wordRuns`): white space, one hyphen or apostrophe. */
    const JOINER = /^[^\S\n]*(?:[-‐‑'’][^\S\n]*)?$/u;
    const normalise = (word: string, lang: string | null): string => {
      let folded = word.normalize('NFKC');
      try {
        folded = lang === null ? folded.toLowerCase() : folded.toLocaleLowerCase(lang);
      } catch {
        folded = folded.toLowerCase();
      }
      folded = folded.replace(/i̇/g, 'i').replace(/ß/g, 'ss').replace(/’/g, "'");
      return folded.length <= every.maxWordChars ? folded : [...folded].slice(0, every.maxWordChars).join('');
    };
    // The blocks' bounds in the collapsed text: a word never spans one.
    const bounds = [0];
    for (const index of every.breaks ?? []) {
      const at = Number.isInteger(index) && index > 0 && index < starts.length ? starts[index]! : -1;
      if (at > bounds[bounds.length - 1]!) bounds.push(at);
    }
    bounds.push(flat.length);
    const until = typeof every.until === 'number' ? every.until : Number.POSITIVE_INFINITY;
    let late = false;
    let seen = 0;
    /** Past the deadline (read every 64 segments, as reading the clock costs too). */
    const overdue = (): boolean => {
      seen += 1;
      if (!late && (seen & 63) === 0 && performance.now() > until) late = true;
      return late;
    };
    for (const target of targets.slice(0, Math.max(0, max))) {
      const terms = Array.isArray(target.terms) ? target.terms.map((term) => String(term)) : [];
      const lang = typeof target.lang === 'string' && target.lang !== '' ? target.lang : null;
      let found = 0;
      if (terms.length > 0 && terms.every((term) => term !== '')) {
        let segmenter: Intl.Segmenter | null = null;
        if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
          try {
            segmenter = new Intl.Segmenter(lang ?? undefined, { granularity: 'word' });
          } catch {
            segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
          }
        }
        // The words read since the last break (punctuation, a block), at most as many as the phrase has:
        // the phrase is found when they are its terms. Matched while segmenting, so the walk stops as soon
        // as `maxMatches` spans are found or the deadline passes.
        let window: { readonly term: string; readonly start: number; readonly end: number }[] = [];
        const word = (raw: string, start: number): boolean => {
          window.push({ term: normalise(raw, lang), start, end: start + raw.length });
          if (window.length > terms.length) window.shift();
          if (window.length === terms.length && window.every((w, j) => w.term === terms[j])) {
            spans.push(span(target.kind, window[0]!.start, window[window.length - 1]!.end));
            found += 1;
            window = [];
          }
          return spans.length >= every.maxMatches;
        };
        blocks: for (let b = 0; b + 1 < bounds.length; b++) {
          const offset = bounds[b]!;
          const block = flat.slice(offset, bounds[b + 1]!);
          window = [];
          if (segmenter) {
            for (const segment of segmenter.segment(block)) {
              if (overdue()) break blocks;
              if (segment.isWordLike) {
                if (word(segment.segment, offset + segment.index)) break blocks;
              } else if (!JOINER.test(segment.segment)) window = [];
            }
          } else {
            let previous = -1;
            for (const match of block.matchAll(/[\p{L}\p{N}]+/gu)) {
              if (overdue()) break blocks;
              const at = match.index ?? 0;
              if (previous >= 0 && !JOINER.test(block.slice(previous, at))) window = [];
              if (word(match[0], offset + at)) break blocks;
              previous = at + match[0].length;
            }
          }
        }
      }
      if (found === 0) unmatched += 1;
    }
    return { spans, unmatched };
  }
  let from = 0;
  for (const target of targets.slice(0, Math.max(0, max))) {
    const needle = String(target.text).replace(/\s+/g, ' ').trim();
    const at = needle === '' ? -1 : flat.indexOf(needle, from);
    if (at < 0) {
      unmatched += 1;
      continue;
    }
    // The needle is trimmed: its last character is one code unit of the page's text, not white space.
    spans.push(span(target.kind, at, at + needle.length));
    from = at + needle.length;
  }
  return { spans, unmatched };
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
/** A node the text walk visits: an element (`localName`, `hasAttribute`) or a text node (`data`). */
interface PageWalkNode {
  readonly nodeType: number;
  readonly localName?: string;
  hasAttribute?(name: string): boolean;
  readonly data?: string;
  readonly parentNode?: PageWalkNode | null;
}
interface PageRange {
  setStart(node: PageWalkNode, offset: number): void;
  setEnd(node: PageWalkNode, offset: number): void;
  getClientRects(): PageList<HighlightItem['rect']>;
}
type Listener = () => void;
interface ResizeEntry {
  readonly target: unknown;
  readonly contentRect: { readonly width: number; readonly height: number };
}
interface OverlayView {
  readonly scrollX: number;
  readonly scrollY: number;
  /** The first viewport (`lazy-images`): the top `innerHeight` × `innerWidth` of the document. */
  readonly innerWidth: number;
  readonly innerHeight: number;
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
  readonly images: PageList<PageTarget>;
  readonly defaultView: OverlayView | null;
  createElement(name: string): OverlayElement;
  querySelectorAll(selectors: string): PageList<PageTarget>;
  createTreeWalker(root: unknown, whatToShow: number, filter: { acceptNode(node: PageWalkNode): number }): { nextNode(): PageWalkNode | null };
  createRange(): PageRange;
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
  /** Text modes: how many texts were not found in the page. */
  readonly unmatched?: number;
}
export interface OverlayConfig {
  readonly key: string;
  readonly maxLinks: number;
  readonly maxHeadings: number;
  /** Lazy images outlined at most (`lazy-images`, `all`). */
  readonly maxImages: number;
  /** Measuring time in all, per drawing pass. */
  readonly budgetMs: number;
  /** Measuring time per animation frame. */
  readonly frameMs: number;
  readonly styles: HighlightStyles;
  /** The modes that box texts (`TEXT_HIGHLIGHT_MODES`). */
  readonly textModes: readonly HighlightMode[];
  /** Text modes: texts boxed at most, rects (line fragments) per text, and the text walk's caps. */
  readonly maxTextTargets: number;
  readonly maxRectsPerTarget: number;
  readonly maxTextNodes: number;
  readonly maxTextScanChars: number;
  /** What the overlay says when texts were not found (`{n}`: how many). */
  readonly unmatchedNote: { readonly one: string; readonly many: string };
  /** The text modes that box every whole-word occurrence (`keyphrase`), at most `maxKeyphraseMatches`, and what they say when none is left. */
  readonly everyModes: readonly HighlightMode[];
  readonly maxKeyphraseMatches: number;
  readonly maxWordChars: number;
  readonly everyUnmatchedNote: string;
  /** Elements that start a block of text (`VISIBLE_TEXT_BLOCKS`, as the extractor's visible text). */
  readonly blocks: readonly string[];
}

/** The isolated world's global property holding the overlay state. */
export const OVERLAY_KEY = '__frostSeoHighlight';

/** The modes that box texts main hands in (`TextHighlightTarget`) rather than elements. */
export const TEXT_HIGHLIGHT_MODES: readonly HighlightMode[] = ['sentences', 'keyphrase'];
/** The text modes that box every whole-word occurrence of their one target (`TextEvery`). */
export const EVERY_OCCURRENCE_MODES: readonly HighlightMode[] = ['keyphrase'];

/**
 * Removes any overlay this world drew in the page, then (unless `mode` is `off`) draws the new
 * one. Runs in the isolated world only; self-contained (`plan` is `planHighlight`, `store` the
 * world's global, `targets` the URLs `broken` outlines, `textTargets` the texts a text mode boxes and
 * `planText` `planTextHighlight`). Resolves, once the first drawing pass is done, the mode drawn and
 * how many boxes (`off` if the page removed the host before), and for a text mode how many texts it
 * did not find.
 */
export function paintHighlight(
  document: OverlayDocument,
  mode: HighlightMode,
  config: OverlayConfig,
  plan: typeof planHighlight,
  store: Record<string, unknown>,
  targets: readonly string[] = [],
  textTargets: readonly TextHighlightTarget[] = [],
  planText?: typeof planTextHighlight,
): Promise<OverlayResult> {
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
  /** A link's type, `nofollow` aside: `internal`, `external` or `other`. */
  const linkType = (el: PageTarget): HighlightKind => {
    try {
      const url = new URL((el.getAttribute('href') ?? '').trim(), document.baseURI);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other';
      return site(url.host) === pageSite ? 'internal' : 'external';
    } catch {
      return 'other';
    }
  };
  const nofollow = (el: PageTarget): boolean => (el.getAttribute('rel') ?? '').toLowerCase().split(/[\s,]+/).includes('nofollow');
  const linkKind = (el: PageTarget): HighlightKind => (nofollow(el) ? 'nofollow' : linkType(el));
  // `broken`: a link whose target, resolved and without its fragment, is one of `targets`.
  const brokenSet = new Set(targets);
  const isBroken = (el: PageTarget): boolean => {
    try {
      const url = new URL((el.getAttribute('href') ?? '').trim(), document.baseURI);
      url.hash = '';
      return brokenSet.has(url.href);
    } catch {
      return false;
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
      const key = `${b.kind} ${b.label} ${b.x} ${b.y} ${b.width} ${b.height}`;
      if (box.key === key) continue;
      box.key = key;
      css(box.outline, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, 'border-color': b.color, background: `${b.color}14` });
      // Above the box, or inside it at the very top of the page; none for a text's later lines.
      css(box.label, { top: b.y >= 15 ? '-15px' : '0px', background: b.color, display: b.label === '' ? 'none' : 'inline' });
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

  // A text mode: the texts found, each as live ranges over the page's own text nodes, one range per
  // text node (nothing is changed). One range across nodes would also give, among its client rects,
  // the border box of every element wholly inside it (an `<em>`, a link): a second box over the same words.
  const textMode = config.textModes.includes(mode);
  const everyMode = textMode && config.everyModes.includes(mode);
  const found: { readonly kind: HighlightKind; readonly ranges: readonly PageRange[] }[] = [];
  let unmatched = 0;
  const result = (boxes: number): OverlayResult => (textMode ? { mode, boxes, unmatched } : { mode, boxes });
  /** A found text's boxes: its line fragments (at most `maxRectsPerTarget`), labelled on the first shown one. */
  const measureText = (text: (typeof found)[number], items: HighlightItem[]): void => {
    let labelled = false;
    let taken = 0;
    for (const range of text.ranges) {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length && taken < config.maxRectsPerTarget; i++, taken++) {
        const r = rects[i]!;
        const shownRect = r.width >= 1 && r.height >= 1;
        items.push({ kind: text.kind, rect: { left: r.left + view.scrollX, top: r.top + view.scrollY, width: r.width, height: r.height }, unlabelled: !shownRect || labelled });
        if (shownRect) labelled = true;
      }
      if (taken >= config.maxRectsPerTarget) break;
    }
  };
  /** Says, pinned in the viewport's corner, how many texts were not found. */
  const sayUnmatched = (): void => {
    if (unmatched === 0) return;
    const note = document.createElement('div');
    css(note, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      'max-width': '320px',
      padding: '2px 8px',
      'border-radius': '4px',
      background: '#1f2937',
      color: '#ffffff',
      font: '600 11px/16px system-ui, -apple-system, "Segoe UI", sans-serif',
      'pointer-events': 'none',
    });
    note.textContent = everyMode ? config.everyUnmatchedNote : unmatched === 1 ? config.unmatchedNote.one : config.unmatchedNote.many.replace('{n}', String(unmatched));
    shadow.append(note);
  };
  /**
   * Reads the body's text nodes (the extractor's skipped subtrees and `hidden` elements left out),
   * `frameMs` per frame, until the node, character or time budget ends or the text does; then finds
   * the texts and starts the first drawing pass.
   */
  const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];
  const STOP = {};
  const texts: string[] = [];
  const nodes: PageWalkNode[] = [];
  /**
   * The text nodes that start a new block: an element of `config.blocks` came before them (a `<br>`
   * too), or (`keyphrase`) their nearest block ancestor is not the previous text node's, so leaving a
   * block breaks as well as entering one.
   */
  const breaks: number[] = [];
  let blockBreak = false;
  let lastBlock: PageWalkNode | null = null;
  /** The nearest ancestor of `node` that is a block (looked for at most 64 levels up). */
  const blockOf = (node: PageWalkNode): PageWalkNode | null => {
    let up = node.parentNode ?? null;
    for (let depth = 0; up && depth < 64; depth++, up = up.parentNode ?? null) if (up.nodeType === 1 && config.blocks.includes(up.localName ?? '')) return up;
    return null;
  };
  let scanned = 0;
  let visited = 0;
  let walkSpent = 0;
  let sliceStart = 0;
  const walker =
    textMode && document.body
      ? document.createTreeWalker(document.body, 0x1 | 0x4, {
          acceptNode(node) {
            visited += 1;
            if (visited > config.maxTextNodes * 4 || ((visited & 255) === 0 && walkSpent + (performance.now() - sliceStart) > config.budgetMs)) throw STOP;
            if (node.nodeType !== 1) return 1;
            if (SKIP.includes(node.localName ?? '') || node.hasAttribute?.('hidden') === true) return 2;
            // Block breaks matter to `keyphrase` only: `sentences` walks exactly as before (no per-element lookup).
            if (everyMode && config.blocks.includes(node.localName ?? '')) blockBreak = true;
            return 3;
          },
        })
      : null;
  const walk = (): void => {
    frame = undefined;
    if (stopped) return;
    sliceStart = performance.now();
    let done = walker === null;
    try {
      while (!done) {
        const now = performance.now();
        if (now - sliceStart > config.frameMs) break;
        if (walkSpent + (now - sliceStart) > config.budgetMs || nodes.length >= config.maxTextNodes || scanned >= config.maxTextScanChars) {
          done = true;
          break;
        }
        const node = walker!.nextNode();
        if (node === null) {
          done = true;
          break;
        }
        const data = node.data ?? '';
        const take = Math.min(data.length, config.maxTextScanChars - scanned);
        scanned += take;
        if (everyMode) {
          const owner = blockOf(node);
          if (nodes.length > 0 && owner !== lastBlock) blockBreak = true;
          lastBlock = owner;
          if (blockBreak) breaks.push(nodes.length);
          blockBreak = false;
        }
        nodes.push(node);
        texts.push(take < data.length ? data.slice(0, take) : data);
      }
    } catch (error) {
      if (error !== STOP) throw error;
      done = true;
    }
    walkSpent += performance.now() - sliceStart;
    if (!done) {
      frame = nextFrame(walk);
      return;
    }
    const most = everyMode ? 1 : config.maxTextTargets;
    // `keyphrase` plans within what is left of the budget (at least one frame's worth), then draws what it found.
    const until = performance.now() + Math.max(config.frameMs, config.budgetMs - walkSpent);
    const planned = planText
      ? planText(texts, textTargets, most, everyMode ? { maxMatches: config.maxKeyphraseMatches, maxWordChars: config.maxWordChars, breaks, until } : undefined)
      : { spans: [], unmatched: Math.min(textTargets.length, most) };
    unmatched = planned.unmatched;
    for (const span of planned.spans) {
      if (!Object.prototype.hasOwnProperty.call(config.styles, span.kind)) {
        unmatched += 1;
        continue;
      }
      try {
        const ranges: PageRange[] = [];
        for (let n = span.start[0]; n <= span.end[0]; n++) {
          const node = nodes[n]!;
          const range = document.createRange();
          range.setStart(node, n === span.start[0] ? span.start[1] : 0);
          range.setEnd(node, n === span.end[0] ? span.end[1] : (node.data ?? '').length);
          ranges.push(range);
        }
        found.push({ kind: span.kind, ranges });
      } catch {
        // The page changed that text while it was read: not found.
        unmatched += 1;
      }
    }
    // `keyphrase` says it found nothing only when no occurrence is drawn at all (one range failing is not that).
    if (everyMode) unmatched = found.length === 0 ? 1 : 0;
    texts.length = 0;
    nodes.length = 0;
    breaks.length = 0;
    sayUnmatched();
    pass();
  };

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
    // What this mode outlines: one or more lists of elements, each with its own cap and the kind
    // each element draws as (`null`: not drawn). A text mode measures its found texts instead.
    interface Source {
      readonly list: PageList<PageTarget>;
      readonly max: number;
      readonly kind: (el: PageTarget) => HighlightKind | null;
    }
    const sources: Source[] = [];
    if (mode === 'links' || mode === 'all') sources.push({ list: document.links, max: config.maxLinks, kind: linkKind });
    if (mode === 'broken') sources.push({ list: document.links, max: config.maxLinks, kind: (el) => (isBroken(el) ? 'broken' : null) });
    if (mode === 'internal' || mode === 'external') sources.push({ list: document.links, max: config.maxLinks, kind: (el) => (linkType(el) !== mode ? null : nofollow(el) ? 'nofollow' : mode) });
    if (mode === 'headings' || mode === 'all') sources.push({ list: document.querySelectorAll('h1, h2, h3, h4, h5, h6'), max: config.maxHeadings, kind: (el) => `h${Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1))}` as HighlightKind });
    if (mode === 'lazy-images' || mode === 'all') sources.push({ list: document.images, max: config.maxImages, kind: (el) => ((el.getAttribute('loading') ?? '').trim().toLowerCase() === 'lazy' ? 'lazy' : null) });
    const max = textMode ? (everyMode ? config.maxKeyphraseMatches : config.maxTextTargets) * config.maxRectsPerTarget : sources.reduce((sum, source) => sum + source.max, 0);
    const items: HighlightItem[] = [];
    let index = 0;
    let part = 0;
    let taken = 0;
    let spent = 0;
    const more = (): boolean => (textMode ? index < found.length : part < sources.length) && items.length < max;
    const step = (): void => {
      frame = undefined;
      if (stopped) return;
      const sliceStart = performance.now();
      while (more()) {
        if (spent + (performance.now() - sliceStart) > config.budgetMs) break;
        if (performance.now() - sliceStart > config.frameMs) break;
        if (textMode) {
          measureText(found[index++]!, items);
          continue;
        }
        const source = sources[part]!;
        if (index >= source.list.length || taken >= source.max) {
          part += 1;
          index = 0;
          taken = 0;
          continue;
        }
        const el = source.list[index++];
        if (!el || !shown(el)) continue;
        let kind = source.kind(el);
        if (kind === null) continue;
        // Document coordinates as of now: the scroll offset may differ by the next slice.
        const r = el.getBoundingClientRect();
        const rect = { left: r.left + view.scrollX, top: r.top + view.scrollY, width: r.width, height: r.height };
        // A lazy image over the first viewport (the top `innerHeight` × `innerWidth` of the document).
        if (kind === 'lazy' && rect.top < view.innerHeight && rect.top + rect.height > 0 && rect.left < view.innerWidth && rect.left + rect.width > 0) kind = 'lazy-first-viewport';
        // Each list keeps its own cap: an element without a box (collapsed, not laid out) is neither drawn nor counted.
        if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) continue;
        items.push({ kind, rect });
        taken += 1;
      }
      spent += performance.now() - sliceStart;
      if (more() && spent <= config.budgetMs) {
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
      settleFirst(result(drawn));
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
    // The ranges point at page nodes: let them go with the overlay.
    found.length = 0;
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
  if (textMode) walk();
  else pass();
  return first;
}

export const OVERLAY_CONFIG: OverlayConfig = {
  key: OVERLAY_KEY,
  maxLinks: SNAPSHOT_LIMITS.maxLinks,
  maxHeadings: SNAPSHOT_LIMITS.maxHeadings,
  maxImages: SNAPSHOT_LIMITS.maxImages,
  budgetMs: HIGHLIGHT_BUDGET_MS,
  frameMs: HIGHLIGHT_FRAME_MS,
  styles: HIGHLIGHT_STYLES,
  textModes: TEXT_HIGHLIGHT_MODES,
  maxTextTargets: MAX_TEXT_HIGHLIGHT_TARGETS,
  maxRectsPerTarget: MAX_TEXT_HIGHLIGHT_RECTS_PER_TARGET,
  maxTextNodes: SNAPSHOT_LIMITS.maxTextNodes,
  maxTextScanChars: SNAPSHOT_LIMITS.maxTextScanChars,
  unmatchedNote: TEXT_HIGHLIGHT_UNMATCHED_NOTE,
  everyModes: EVERY_OCCURRENCE_MODES,
  maxKeyphraseMatches: MAX_KEYPHRASE_MATCHES,
  maxWordChars: CONTENT_LIMITS.maxWordChars,
  everyUnmatchedNote: KEYPHRASE_UNMATCHED_NOTE,
  blocks: VISIBLE_TEXT_BLOCKS,
};

/**
 * The script that sets the overlay to `mode` in the isolated world (removing any before); `targets`:
 * the URLs `broken` outlines (at most `maxLinks`); `textTargets`: the texts a text mode boxes (at
 * most `MAX_TEXT_HIGHLIGHT_TARGETS`; `keyphrase`: one, with its `terms` and `lang`). All travel as
 * JSON data, and only for their modes.
 */
export function highlightScript(mode: HighlightMode, targets: readonly string[] = [], textTargets: readonly TextHighlightTarget[] = []): string {
  const outlined = mode === 'broken' ? targets.slice(0, SNAPSHOT_LIMITS.maxLinks) : [];
  const call = `(${paintHighlight.toString()})(document, ${JSON.stringify(mode)}, ${JSON.stringify(OVERLAY_CONFIG)}, ${planHighlight.toString()}, globalThis, ${JSON.stringify(outlined)}`;
  if (!TEXT_HIGHLIGHT_MODES.includes(mode)) return `${call})`;
  const every = EVERY_OCCURRENCE_MODES.includes(mode);
  const texts = textTargets
    .slice(0, every ? 1 : MAX_TEXT_HIGHLIGHT_TARGETS)
    .map((target) => (every ? { text: String(target.text), kind: target.kind, terms: (target.terms ?? []).map(String), lang: typeof target.lang === 'string' ? target.lang : null } : { text: String(target.text), kind: target.kind }));
  return `${call}, ${JSON.stringify(texts)}, ${planTextHighlight.toString()})`;
}

/** The script that settles with why the current overlay ended (`OverlayEnd`), or `none` without one. */
export function highlightEndedScript(): string {
  return `(() => { const s = globalThis[${JSON.stringify(OVERLAY_KEY)}]; return s ? s.ended : 'none'; })()`;
}

/** Sets the overlay in `contents`' SEO world; resolves the script's (untrusted) answer. */
export function runHighlight(contents: ExtractTarget, mode: HighlightMode, targets: readonly string[] = [], textTargets: readonly TextHighlightTarget[] = []): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: highlightScript(mode, targets, textTargets) }]);
}

/** Waits, in `contents`' SEO world, for the current overlay to end; resolves why (untrusted). */
export function watchHighlight(contents: ExtractTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: highlightEndedScript() }]);
}
