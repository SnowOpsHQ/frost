import { CAPTURE_LIMITS, CAPTURE_WORLD_ID } from '@app/specs/capture.spec';
import { CAPTURE_BLOCK_ELEMENTS, REGION_EXTRACT_LIMITS, RegionAnswerSchema, type RegionAnswer } from '@app/specs/changes.schema';

// The region extraction (Phase 6 Task 3; spec `capture.spec.ts`, `changes.spec.ts`; acceptance
// `changes-capture.feature.md`, The region extraction). `extractRegions` is one self-contained
// function, serialised with its limits into `REGIONS_SCRIPT` and run in the tab's isolated world
// `CAPTURE_WORLD_ID`, as the Phase 2 extractor (`seo/extract.ts`) is: nothing the page defines
// reaches it, and it only reads the DOM.
//
// It tags each heading, link and text block with the page region (ARIA landmark) it sits in. Each
// element's landmark, sectioning and `hidden` state are worked out once from its parent's (a memo
// filled in document order), so a 10 000-deep tree costs one step per element. Every list stops at
// its cap while it is read, text is read with `substringData` within a character budget, and
// everything stops at one deadline: a hostile page gives a `partial` answer. Main still validates
// the answer (`parseRegionAnswer`) and hashes each region's text: it is page data.

/** The parts of a DOM node the extraction reads (structural, so main needs no DOM lib). */
interface RegionNode {
  readonly nodeType: number;
}
interface RegionTextNode extends RegionNode {
  readonly length: number;
  readonly parentElement: RegionElement | null;
  substringData(offset: number, count: number): string;
}
interface RegionElement extends RegionNode {
  readonly localName: string;
  readonly parentElement: RegionElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  /** Chromium has it; some test DOMs do not (then only `[hidden]` hides). */
  checkVisibility?(): boolean;
}
interface RegionList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
/** The parts of `document` the extraction reads. */
export interface RegionDocument {
  readonly URL: string;
  readonly baseURI: string;
  readonly body: RegionElement | null;
  readonly links: RegionList<RegionElement>;
  readonly defaultView: { getComputedStyle?(el: RegionElement): { getPropertyValue(name: string): string } } | null;
  querySelectorAll(selectors: string): RegionList<RegionElement>;
  createTreeWalker(root: RegionNode, whatToShow: number, filter?: { acceptNode(node: RegionNode): number } | null): { nextNode(): RegionNode | null };
}

/** The limits the extraction takes (the spec's, or tighter ones in tests). */
export type CaptureLimits = { readonly [K in keyof typeof CAPTURE_LIMITS]: number };
export type RegionExtractLimits = { readonly [K in keyof typeof REGION_EXTRACT_LIMITS]: number };

/**
 * Reads the page's regions (`RegionAnswer`'s shape). Runs in the isolated world only.
 * Self-contained: it must not reference anything outside this function. Everything stops at one
 * deadline, `L.extractBudgetMs` after it starts (`partial`).
 */
export function extractRegions(document: RegionDocument, L: CaptureLimits, X: RegionExtractLimits, blockNames: readonly string[]): unknown {
  const deadline = performance.now() + L.extractBudgetMs;
  const REGIONS = ['main', 'nav', 'header', 'aside', 'footer', 'other'] as const;
  type Region = (typeof REGIONS)[number];
  const SHOW_ELEMENT = 0x1;
  const SHOW_TEXT = 0x4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const FILTER_SKIP = 3;
  const ELEMENT_NODE = 1;
  /** Thrown from a walker's filter to stop it (a cap or the deadline). */
  const STOP = {};
  const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];
  /** Elements whose `header` / `footer` heads them, not the page. */
  const SECTIONING = ['article', 'aside', 'main', 'nav', 'section'];
  let partial = false;
  const late = (): boolean => {
    if (performance.now() <= deadline) return false;
    partial = true;
    return true;
  };
  /** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  /** NFC, whitespace runs collapsed to one space, trimmed (`changes-diff.feature.md`). */
  const normal = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();
  const segmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  /** Words (`isWordLike` segments, Phase 2's count); without a segmenter, runs of letters or digits. */
  const countWords = (text: string): number => {
    if (!segmenter) return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    let n = 0;
    let seen = 0;
    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike) n += 1;
      if ((++seen & 4095) === 0 && late()) break;
    }
    return n;
  };
  const view = document.defaultView;
  const display = (el: RegionElement): string => (view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el).getPropertyValue('display') : '');
  /** No box (`checkVisibility()` false, where it exists), unless it is a `display: contents` wrapper. */
  const unshown = (el: RegionElement): boolean => typeof el.checkVisibility === 'function' && !el.checkVisibility() && display(el) !== 'contents';

  // ---- Landmarks (`changes-diff.feature.md`, Regions) ----
  /** What an element passes to its children: its region (`null`: no landmark yet), whether it is in sectioning content, under `[hidden]`, and its text block. */
  type Info = { region: Region | null; sectioned: boolean; hidden: boolean; block: RegionElement | null };
  const ROOT: Info = { region: null, sectioned: false, hidden: false, block: null };
  const infos = new Map<RegionElement, Info>();
  /** The landmark `el` itself is: an explicit, non-empty `role` decides by its first token; else its element (a header or footer only outside sectioning content). */
  const landmarkOf = (el: RegionElement, sectioned: boolean): Region | null => {
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (role !== '') return role === 'main' ? 'main' : role === 'navigation' ? 'nav' : role === 'complementary' ? 'aside' : role === 'banner' ? 'header' : role === 'contentinfo' ? 'footer' : null;
    const tag = el.localName;
    if (tag === 'main' || tag === 'nav' || tag === 'aside') return tag;
    if ((tag === 'header' || tag === 'footer') && !sectioned) return tag;
    return null;
  };
  /** `el`'s info, from its nearest memoised ancestor down (no recursion: a deep tree is a loop). */
  const infoOf = (el: RegionElement): Info => {
    const known = infos.get(el);
    if (known) return known;
    const chain: RegionElement[] = [];
    let node: RegionElement | null = el;
    let base = ROOT;
    while (node !== null) {
      const memo = infos.get(node);
      if (memo) {
        base = memo;
        break;
      }
      chain.push(node);
      node = node.parentElement;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const e = chain[i]!;
      const info: Info = {
        region: landmarkOf(e, base.sectioned) ?? base.region,
        sectioned: base.sectioned || SECTIONING.includes(e.localName),
        hidden: base.hidden || e.hasAttribute('hidden'),
        block: blockNames.includes(e.localName) ? e : base.block,
      };
      infos.set(e, info);
      base = info;
    }
    return base;
  };
  // A page with a main landmark files unlandmarked content as `other`; without one, as `main`.
  let hasMain = false;
  const mains = document.querySelectorAll('main, [role]');
  for (let i = 0, n = Math.min(mains.length, X.maxMainScan); i < n && !hasMain; i++) {
    const el = mains[i];
    if (el && landmarkOf(el, false) === 'main') hasMain = true;
  }
  const regionOf = (el: RegionElement | null): Region => (el ? infoOf(el).region : null) ?? (hasMain ? 'other' : 'main');
  const isHidden = (el: RegionElement): boolean => infoOf(el).hidden || unshown(el);

  /** Up to `limit` code units of `root`'s text, read node by node (at most `visits` nodes), stopping at the deadline. */
  const textOf = (root: RegionNode, limit: number, visits: number): string => {
    let text = '';
    let seen = 0;
    const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        seen += 1;
        if (seen > visits || text.length >= limit || ((seen & 63) === 0 && late())) throw STOP;
        if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
        return SKIP.includes((node as RegionElement).localName) ? FILTER_REJECT : FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const data = node as RegionTextNode;
        text += data.substringData(0, Math.min(data.length, limit - text.length));
      }
    } catch (error) {
      if (error !== STOP) throw error;
    }
    return text;
  };
  const shortText = (root: RegionNode, max: number): string => cut(normal(textOf(root, max * 4, 1_024)), max);
  const attribute = (el: RegionElement, name: string, max: number): string => cut(normal(cut(el.getAttribute(name) ?? '', max * 4)), max);

  // ---- Headings ----
  const headings: { level: number; text: string; region: Region }[] = [];
  const headingList = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (let i = 0, n = headingList.length; i < n && headings.length < L.maxHeadings; i++) {
    if ((i & 15) === 0 && late()) break;
    const el = headingList[i];
    if (!el || isHidden(el)) continue;
    headings.push({ level: Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1)), text: shortText(el, L.maxHeadingChars), region: regionOf(el) });
  }

  // ---- Links (`document.links`: `a[href]` and `area[href]`) ----
  const site = (host: string): string => {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
  };
  const resolve = (raw: string): URL | null => {
    try {
      return new URL(cut(raw.trim(), L.maxUrlChars * 2), document.baseURI);
    } catch {
      return null;
    }
  };
  const page = resolve(document.URL);
  const pageSite = page ? site(page.host) : '';
  const allLinks = document.links;
  const linkTotal = allLinks.length;
  const list: { href: string; text: string; rel: string; region: Region }[] = [];
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  for (let i = 0, n = Math.min(linkTotal, X.maxLinkScan); i < n; i++) {
    if ((i & 63) === 0 && late()) break;
    const el = allLinks[i];
    if (!el) continue;
    const raw = el.getAttribute('href') ?? '';
    const target = resolve(raw);
    if (target && (target.protocol === 'http:' || target.protocol === 'https:')) {
      if (site(target.host) === pageSite) internal += 1;
      else external += 1;
    }
    const rel = attribute(el, 'rel', L.maxAnchorChars).toLowerCase();
    if (rel.split(' ').includes('nofollow')) nofollow += 1;
    if (list.length >= L.maxLinks) continue;
    let text = shortText(el, L.maxAnchorChars);
    if (text === '') text = attribute(el, 'aria-label', L.maxAnchorChars);
    if (text === '' && el.localName === 'area') text = attribute(el, 'alt', L.maxAnchorChars);
    if (text === '') {
      const images = (el as unknown as { getElementsByTagName?(name: string): RegionList<RegionElement> }).getElementsByTagName?.('img');
      const image = images && images.length > 0 ? images[0] : undefined;
      if (image) text = attribute(image, 'alt', L.maxAnchorChars);
    }
    if (text === '') text = attribute(el, 'title', L.maxAnchorChars);
    list.push({ href: cut(target ? target.href : raw.trim(), L.maxUrlChars), text, rel, region: regionOf(el) });
  }
  if (linkTotal > X.maxLinkScan) partial = true;

  // ---- Text blocks ----
  /**
   * One region's text: the words of every block reached, the blocks kept, H (every block reached,
   * joined with `\n`, up to `maxHashedRegionChars`), and whether the kept blocks stop short of it.
   */
  type RegionText = { words: number; blocks: string[]; chars: number; full: boolean; truncated: boolean; text: string; started: boolean };
  const texts = {} as Record<Region, RegionText>;
  for (const region of REGIONS) texts[region] = { words: 0, blocks: [], chars: 0, full: false, truncated: false, text: '', started: false };
  const addBlock = (raw: string, region: Region): void => {
    const block = normal(raw);
    if (block === '') return;
    const t = texts[region];
    t.words += countWords(block);
    // H: every block reached, uncut, joined with `\n`, up to its cap.
    if (t.text.length >= L.maxHashedRegionChars) t.truncated = true;
    else {
      const joined = t.text + (t.started ? '\n' : '') + block;
      if (joined.length > L.maxHashedRegionChars) t.truncated = true;
      t.text = cut(joined, L.maxHashedRegionChars);
    }
    t.started = true;
    const kept = cut(block, L.maxBlockChars);
    if (kept.length < block.length) t.truncated = true;
    if (t.full || t.blocks.length >= L.maxBlocksPerRegion || t.chars + kept.length > L.maxRegionChars) {
      t.full = true;
      t.truncated = true;
      return;
    }
    t.blocks.push(kept);
    t.chars += kept.length;
  };
  // The run of text being read: its block and region, and its text so far.
  let run = '';
  let runBlock: RegionElement | null | undefined;
  let runRegion: Region = 'main';
  const flush = (): void => {
    if (run !== '') addBlock(run, runRegion);
    run = '';
    runBlock = undefined;
  };
  let walked = false;
  if (document.body) {
    let visited = 0;
    let scanned = 0;
    const walker = document.createTreeWalker(document.body, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        visited += 1;
        if (visited > L.maxNodeVisits || scanned >= X.maxScanChars || ((visited & 63) === 0 && late())) throw STOP;
        if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
        const el = node as RegionElement;
        // A hidden or non-text subtree is pruned; a layout wrapper's (`display: contents`) is walked.
        if (SKIP.includes(el.localName) || infoOf(el).hidden || unshown(el)) return FILTER_REJECT;
        if (el.localName === 'br' || el.localName === 'hr') flush();
        return FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const data = node as RegionTextNode;
        const parent = data.parentElement;
        const info = parent ? infoOf(parent) : ROOT;
        const region = info.region ?? (hasMain ? 'other' : 'main');
        if (runBlock !== undefined && (info.block !== runBlock || region !== runRegion)) flush();
        runBlock = info.block;
        runRegion = region;
        const take = Math.min(data.length, X.maxScanChars - scanned);
        scanned += take;
        run += data.substringData(0, take);
        if (take < data.length) throw STOP;
      }
      walked = true;
    } catch (error) {
      if (error !== STOP) throw error;
    }
    flush();
  } else {
    walked = true;
  }
  if (!walked) partial = true;

  const regions = {} as Record<Region, { words: number; blocks: string[]; truncated: boolean; text: string }>;
  for (const region of REGIONS) {
    const t = texts[region];
    // A final lone high surrogate is dropped (the `textHash` rule).
    const last = t.text.charCodeAt(t.text.length - 1);
    const text = last >= 0xd800 && last <= 0xdbff ? t.text.slice(0, -1) : t.text;
    regions[region] = { words: t.words, blocks: t.blocks, truncated: t.truncated || partial, text };
  }
  return {
    url: cut(document.URL, L.maxUrlChars),
    partial,
    headings,
    links: { total: linkTotal, internal, external, nofollow, list },
    regions,
  };
}

/** The script run in the capture world: `extractRegions` on its `document` with the spec's limits and block elements. */
export const REGIONS_SCRIPT = `(${extractRegions.toString()})(document, ${JSON.stringify(CAPTURE_LIMITS)}, ${JSON.stringify(REGION_EXTRACT_LIMITS)}, ${JSON.stringify(CAPTURE_BLOCK_ELEMENTS)})`;

/** The part of a tab's WebContents a capture needs. */
export interface RegionTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
  getURL(): string;
}

/** Runs the extraction in `contents`' capture world; resolves its (untrusted, unvalidated) answer. */
export function runRegions(contents: RegionTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(CAPTURE_WORLD_ID, [{ code: REGIONS_SCRIPT }]);
}

/** `raw` as a region answer if it parses with `RegionAnswerSchema` (strict, capped), else `null`; never throws. */
export function parseRegionAnswer(raw: unknown): RegionAnswer | null {
  try {
    const parsed = RegionAnswerSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    // A getter that throws, or anything else Zod could not walk.
    return null;
  }
}
