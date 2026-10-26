import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SEO_WORLD_ID, SNAPSHOT_LIMITS, type SnapshotLimits } from '@app/specs/seo-limits.spec';

// The SEO extractor (spec `seo-snapshot.spec.ts`, `seo-limits.spec.ts`; acceptance
// `seo-sidebar.feature.md`, Extraction). `extractPage` is one self-contained function: it is
// serialised with its limits into `EXTRACTOR_SCRIPT` and run in the tab's isolated world
// `SEO_WORLD_ID` (`executeJavaScriptInIsolatedWorld`), so the page's scripts, globals, prototype
// changes and CSP never touch it, and it never touches them: it only reads the DOM.
//
// It references nothing outside its own body (no imports, no module scope): `document` and the
// limits are its arguments. Every list stops at its cap while it is read, strings are cut before
// they are normalised, element text is read node by node with `substringData` and at most
// `maxElementTextVisits` node visits (never `innerText` or `textContent` of an unbounded subtree),
// the word count walks text nodes with a node and character budget, and everything stops at one
// deadline (`EXTRACT_BUDGET_MS`): a huge DOM gives a `partial` snapshot, not a timeout. Main still
// validates the answer (`snapshot.ts`): it is page data.

/** The parts of a DOM node the extractor reads (structural, so main needs no DOM lib). */
interface PageNode {
  readonly nodeType: number;
}
interface PageText extends PageNode {
  readonly length: number;
  substringData(offset: number, count: number): string;
}
interface PageElement extends PageNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selectors: string): PageElement | null;
  /** Chromium has it; some test DOMs do not (then only `[hidden]` hides). */
  checkVisibility?(): boolean;
}
interface PageImageElement extends PageElement {
  readonly currentSrc: string;
  readonly src: string;
}
interface PageList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface PageTreeWalker {
  nextNode(): PageNode | null;
}
/** The parts of `document` the extractor reads. */
export interface PageDocument {
  readonly URL: string;
  readonly baseURI: string;
  readonly documentElement: PageElement | null;
  readonly body: PageElement | null;
  readonly links: PageList<PageElement>;
  readonly images: PageList<PageImageElement>;
  getElementsByTagName(name: string): PageList<PageElement>;
  querySelectorAll(selectors: string): PageList<PageElement>;
  createTreeWalker(root: PageNode, whatToShow: number, filter?: { acceptNode(node: PageNode): number } | null): PageTreeWalker;
}

/**
 * Reads the page into a snapshot (`PageSnapshotSchema`'s shape). Runs in the isolated world only.
 * Self-contained: it must not reference anything outside this function. Everything stops at one
 * deadline, `budgetMs` after it starts (`partial`).
 */
export function extractPage(document: PageDocument, L: SnapshotLimits, budgetMs: number, robotsNames: readonly string[]): unknown {
  const started = performance.now();
  const deadline = started + budgetMs;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  // NodeFilter values (the isolated world has `NodeFilter`, but literals keep this self-contained).
  const SHOW_ELEMENT = 0x1;
  const SHOW_TEXT = 0x4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const FILTER_SKIP = 3;
  const ELEMENT_NODE = 1;
  /** Values longer than this (UTF-16 code units) are measured in code units, not scanned. */
  const SCAN = 65_536;
  /** Most `<title>` elements looked at (SVG titles included) when counting HTML ones. */
  const TITLE_SCAN = 10_000;
  /** Thrown from a walker's filter to stop it (a cap or the deadline). */
  const STOP = {};
  /** Set once anything stopped at the deadline. */
  let partial = false;
  const late = (): boolean => {
    if (performance.now() <= deadline) return false;
    partial = true;
    return true;
  };

  const total = (n: number): number => Math.min(n, L.maxCount);
  /** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
  /** A measured text: the normalised value cut to `max`, and the full value's length in code points (code units past `SCAN`). */
  const measure = (raw: string, fullUnits: number, max: number) => {
    if (fullUnits > SCAN) return { text: cut(squash(raw.slice(0, max * 4)), max), length: total(fullUnits) };
    const value = squash(raw);
    let points = 0;
    for (const _ of value) points += 1;
    return { text: cut(value, max), length: total(points) };
  };
  const measureAttribute = (value: string, max: number) => measure(value.length > SCAN ? value.slice(0, SCAN) : value, value.length, max);
  /** An attribute normalised and cut (`null` when absent). */
  const attribute = (el: PageElement | null | undefined, name: string, max: number): string | null => {
    const value = el ? el.getAttribute(name) : null;
    return value === null ? null : cut(squash(cut(value, max * 4)), max);
  };
  /** Hidden: the `hidden` attribute on it or an ancestor, or no box (`checkVisibility()` false, where it exists). */
  const isHidden = (el: PageElement): boolean => el.closest('[hidden]') !== null || (typeof el.checkVisibility === 'function' && !el.checkVisibility());
  /**
   * Up to `limit` code units of `root`'s text, read node by node, visiting at most `visits` nodes
   * (elements too) and stopping at the deadline; the code units seen, and the first `img[alt]`.
   */
  const textOf = (root: PageNode, limit: number, visits: number) => {
    let text = '';
    let units = 0;
    let seen = 0;
    let imageAlt: string | null = null;
    const walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        seen += 1;
        if (seen > visits || ((seen & 63) === 0 && late())) throw STOP;
        if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
        const el = node as PageElement;
        if (imageAlt === null && el.localName === 'img') imageAlt = el.getAttribute('alt');
        return FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const data = node as PageText;
        units += data.length;
        if (text.length < limit) text += data.substringData(0, Math.min(data.length, limit - text.length));
      }
    } catch (error) {
      if (error !== STOP) throw error;
    }
    return { text, units, imageAlt: imageAlt as string | null };
  };
  const shortText = (root: PageNode, max: number): string => cut(squash(textOf(root, max * 4, L.maxElementTextVisits).text), max);
  /** A site's host: lowercased, one leading `www.` dropped. */
  const site = (host: string): string => {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
  };
  const resolve = (raw: string): { href: string; scheme: string; host: string } | null => {
    try {
      const url = new URL(cut(raw.trim(), L.maxUrlChars * 2), document.baseURI);
      return { href: cut(url.href, L.maxUrlChars), scheme: cut(url.protocol.toLowerCase(), 32), host: url.hostname };
    } catch {
      return null;
    }
  };
  /** The first `max` elements of `list` that `keep` (default: all), mapped, until the deadline; and the list's length. */
  const firstOf = <T, R>(list: PageList<T>, max: number, map: (item: T) => R, keep: (item: T) => boolean = () => true): [R[], number] => {
    const length = list.length;
    const out: R[] = [];
    for (let i = 0; i < length && out.length < max; i++) {
      if (late()) break;
      const item = list[i];
      if (item !== undefined && keep(item)) out.push(map(item));
    }
    return [out, total(length)];
  };

  const pageUrl = resolve(document.URL);
  const pageSite = pageUrl ? site(pageUrl.host) : '';

  // Head.
  const lang = attribute(document.documentElement, 'lang', L.maxLangChars);
  const titleElements = document.getElementsByTagName('title');
  const titles: { text: string; length: number }[] = [];
  let titleTotal = 0;
  for (let i = 0, n = Math.min(titleElements.length, TITLE_SCAN); i < n; i++) {
    const el = titleElements[i];
    if (!el || el.namespaceURI !== XHTML) continue;
    titleTotal += 1;
    if (titles.length < L.maxRepeated && !late()) {
      const read = textOf(el, SCAN, L.maxElementTextVisits);
      titles.push(measure(read.text, read.units, L.maxTextChars));
    }
  }
  const [metaDescriptions, metaDescriptionTotal] = firstOf(document.querySelectorAll('meta[name="description" i]'), L.maxRepeated, (el) =>
    measureAttribute(el.getAttribute('content') ?? '', L.maxTextChars),
  );
  // Generic and crawler-specific robots metas, in document order, with their (lowercased) names.
  const robotsSelector = robotsNames.map((name) => `meta[name="${name}" i]`).join(', ');
  const [metaRobots] = firstOf(document.querySelectorAll(robotsSelector), L.maxRepeated, (el) => ({
    name: (el.getAttribute('name') ?? '').trim().toLowerCase(),
    content: (attribute(el, 'content', L.maxAttributeChars) ?? '').toLowerCase(),
  }));
  const [canonicals, canonicalTotal] = firstOf(document.querySelectorAll('link[rel~="canonical" i]'), L.maxRepeated, (el) => {
    const href = cut((el.getAttribute('href') ?? '').trim(), L.maxUrlChars);
    return { href, resolved: resolve(href)?.href ?? null };
  });
  const ogElement = document.querySelectorAll('meta[property="og:url" i]')[0];
  const ogContent = ogElement ? ogElement.getAttribute('content') : null;
  const ogUrl = ogContent === null ? null : cut(ogContent.trim(), L.maxUrlChars);
  const viewport = attribute(document.querySelectorAll('meta[name="viewport" i]')[0], 'content', L.maxAttributeChars);

  // Headings that are shown (hidden ones are counted in the total only).
  const [headings, headingTotal] = firstOf(
    document.querySelectorAll('h1, h2, h3, h4, h5, h6'),
    L.maxHeadings,
    (el) => ({
      level: Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1)),
      text: shortText(el, L.maxHeadingChars),
    }),
    (el) => !isHidden(el),
  );

  // Links.
  const [links, linkTotal] = firstOf(document.links, L.maxLinks, (el) => {
    const target = resolve(el.getAttribute('href') ?? '');
    const web = target !== null && (target.scheme === 'http:' || target.scheme === 'https:');
    const read = textOf(el, L.maxAnchorChars * 4, L.maxElementTextVisits);
    let text = cut(squash(read.text), L.maxAnchorChars);
    if (text === '') text = attribute(el, 'aria-label', L.maxAnchorChars) ?? '';
    if (text === '' && read.imageAlt !== null) text = cut(squash(cut(read.imageAlt, L.maxAnchorChars * 4)), L.maxAnchorChars);
    if (text === '') text = attribute(el, 'title', L.maxAnchorChars) ?? '';
    return {
      href: target ? target.href : '',
      scheme: target ? target.scheme : '',
      rel: (attribute(el, 'rel', L.maxAttributeChars) ?? '').toLowerCase(),
      text,
      kind: web ? (site(target.host) === pageSite ? 'internal' : 'external') : 'other',
    };
  });

  // Images.
  const [images, imageTotal] = firstOf(document.images, L.maxImages, (img) => {
    const alt = img.getAttribute('alt');
    const small = (name: string) => {
      const value = img.getAttribute(name);
      return value === null ? null : cut(value.trim(), L.maxImageAttributeChars);
    };
    return {
      src: cut(img.currentSrc || img.src || '', L.maxUrlChars),
      alt: alt === null ? null : measureAttribute(alt, L.maxAltChars),
      width: small('width'),
      height: small('height'),
      loading: small('loading'),
    };
  });

  // Words in the body's shown text (script, style, template, SVG … subtrees and hidden elements
  // skipped), within the node and character budgets and the deadline. `Intl.Segmenter` finds words
  // in scripts written without spaces (Chinese, Japanese, Thai); without it, runs of letters or digits.
  const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];
  const WORD = /[\p{L}\p{N}]+/gu;
  const segmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  const countWords = (text: string): number => {
    if (!segmenter) return (text.match(WORD) ?? []).length;
    let n = 0;
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) n += 1;
    return n;
  };
  let wordCount = 0;
  let textTruncated = false;
  if (document.body) {
    let visited = 0;
    let textNodes = 0;
    let scanned = 0;
    const walker = document.createTreeWalker(document.body, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        visited += 1;
        if (textNodes >= L.maxTextNodes || scanned >= L.maxTextScanChars || visited > L.maxTextNodes * 4 || ((visited & 255) === 1 && late())) throw STOP;
        if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
        const el = node as PageElement;
        return SKIP.includes(el.localName) || el.hasAttribute('hidden') || (typeof el.checkVisibility === 'function' && !el.checkVisibility()) ? FILTER_REJECT : FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        textNodes += 1;
        const data = node as PageText;
        const take = Math.min(data.length, L.maxTextScanChars - scanned);
        scanned += take;
        wordCount += countWords(data.substringData(0, take));
      }
    } catch (error) {
      if (error !== STOP) throw error;
      textTruncated = true;
    }
  }

  return {
    url: cut(document.URL, L.maxUrlChars),
    extractedAt: Date.now(),
    durationMs: Math.max(0, performance.now() - started),
    lang: lang === '' ? null : lang,
    titles,
    titleTotal: total(titleTotal),
    metaDescriptions,
    metaDescriptionTotal,
    metaRobots,
    canonicals,
    canonicalTotal,
    ogUrl,
    viewport,
    headings,
    headingTotal,
    wordCount: total(wordCount),
    textTruncated,
    partial,
    links,
    linkTotal,
    images,
    imageTotal,
  };
}

/**
 * The script run in the isolated world: `extractPage` called on its `document` with the spec's
 * limits, deadline and robots meta names.
 */
export const EXTRACTOR_SCRIPT = `(${extractPage.toString()})(document, ${JSON.stringify(SNAPSHOT_LIMITS)}, ${EXTRACT_BUDGET_MS}, ${JSON.stringify(ROBOTS_META_NAMES)})`;

/** The part of a tab's WebContents the extractor needs. */
export interface ExtractTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the extractor in `contents`' SEO world; resolves its (untrusted, unvalidated) answer. */
export function runExtractor(contents: ExtractTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: EXTRACTOR_SCRIPT }]);
}
