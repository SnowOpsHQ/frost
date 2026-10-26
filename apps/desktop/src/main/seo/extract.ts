import { EXTRACT_TEXT_BUDGET_MS, SEO_WORLD_ID, SNAPSHOT_LIMITS, type SnapshotLimits } from '@app/specs/seo-limits.spec';

// The SEO extractor (spec `seo-snapshot.spec.ts`, `seo-limits.spec.ts`; acceptance
// `seo-sidebar.feature.md`, Extraction). `extractPage` is one self-contained function: it is
// serialised with its limits into `EXTRACTOR_SCRIPT` and run in the tab's isolated world
// `SEO_WORLD_ID` (`executeJavaScriptInIsolatedWorld`), so the page's scripts, globals, prototype
// changes and CSP never touch it, and it never touches them: it only reads the DOM.
//
// It references nothing outside its own body (no imports, no module scope): `document` and the
// limits are its arguments. Every list stops at its cap while it is read, strings are cut before
// they are normalised, element text is read node by node with `substringData` (never `innerText`
// or `textContent` of an unbounded subtree), and the word count walks text nodes with a node,
// character and time budget. Main still validates the answer (`snapshot.ts`): it is page data.

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
  querySelector(selectors: string): PageElement | null;
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
 * Self-contained: it must not reference anything outside this function.
 */
export function extractPage(document: PageDocument, L: SnapshotLimits, textBudgetMs: number): unknown {
  const started = performance.now();
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
  /** Up to `limit` code units of `root`'s text, read node by node (at most `nodeLimit` text nodes), and the code units seen. */
  const textOf = (root: PageNode, limit: number, nodeLimit: number) => {
    const walker = document.createTreeWalker(root, SHOW_TEXT);
    let text = '';
    let units = 0;
    let nodes = 0;
    for (let node = walker.nextNode(); node !== null && nodes < nodeLimit; node = walker.nextNode()) {
      nodes += 1;
      const data = node as PageText;
      units += data.length;
      if (text.length < limit) text += data.substringData(0, Math.min(data.length, limit - text.length));
    }
    return { text, units };
  };
  const shortText = (root: PageNode, max: number): string => cut(squash(textOf(root, max * 4, 500).text), max);
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
  /** The first `max` elements of `list` mapped, and the list's length. */
  const firstOf = <T, R>(list: PageList<T>, max: number, map: (item: T) => R): [R[], number] => {
    const length = list.length;
    const out: R[] = [];
    for (let i = 0; i < length && out.length < max; i++) {
      const item = list[i];
      if (item !== undefined) out.push(map(item));
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
    if (titles.length < L.maxRepeated) {
      const read = textOf(el, SCAN, 1_000);
      titles.push(measure(read.text, read.units, L.maxTextChars));
    }
  }
  const [metaDescriptions, metaDescriptionTotal] = firstOf(document.querySelectorAll('meta[name="description" i]'), L.maxRepeated, (el) =>
    measureAttribute(el.getAttribute('content') ?? '', L.maxTextChars),
  );
  const [metaRobots] = firstOf(document.querySelectorAll('meta[name="robots" i]'), L.maxRepeated, (el) => (attribute(el, 'content', L.maxAttributeChars) ?? '').toLowerCase());
  const [canonicals, canonicalTotal] = firstOf(document.querySelectorAll('link[rel~="canonical" i]'), L.maxRepeated, (el) => {
    const href = cut((el.getAttribute('href') ?? '').trim(), L.maxUrlChars);
    return { href, resolved: resolve(href)?.href ?? null };
  });
  const ogElement = document.querySelectorAll('meta[property="og:url" i]')[0];
  const ogContent = ogElement ? ogElement.getAttribute('content') : null;
  const ogUrl = ogContent === null ? null : cut(ogContent.trim(), L.maxUrlChars);
  const viewport = attribute(document.querySelectorAll('meta[name="viewport" i]')[0], 'content', L.maxAttributeChars);

  // Headings.
  const [headings, headingTotal] = firstOf(document.querySelectorAll('h1, h2, h3, h4, h5, h6'), L.maxHeadings, (el) => ({
    level: Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1)),
    text: shortText(el, L.maxHeadingChars),
  }));

  // Links.
  const [links, linkTotal] = firstOf(document.links, L.maxLinks, (el) => {
    const target = resolve(el.getAttribute('href') ?? '');
    const web = target !== null && (target.scheme === 'http:' || target.scheme === 'https:');
    let text = shortText(el, L.maxAnchorChars);
    if (text === '') text = attribute(el, 'aria-label', L.maxAnchorChars) ?? '';
    if (text === '') text = attribute(el.querySelector('img[alt]'), 'alt', L.maxAnchorChars) ?? '';
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

  // Words in the body's rendered text (script, style, template, SVG and [hidden] subtrees skipped),
  // within the node, character and time budget.
  const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];
  const WORD = /[\p{L}\p{N}]+/gu;
  const STOP = {};
  let wordCount = 0;
  let textTruncated = false;
  if (document.body) {
    let visited = 0;
    let textNodes = 0;
    let scanned = 0;
    const walker = document.createTreeWalker(document.body, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode(node) {
        visited += 1;
        if (textNodes >= L.maxTextNodes || scanned >= L.maxTextScanChars || visited > L.maxTextNodes * 4 || ((visited & 255) === 0 && performance.now() - started > textBudgetMs)) throw STOP;
        if (node.nodeType !== ELEMENT_NODE) return FILTER_ACCEPT;
        const el = node as PageElement;
        return SKIP.includes(el.localName) || el.hasAttribute('hidden') ? FILTER_REJECT : FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        textNodes += 1;
        const data = node as PageText;
        const take = Math.min(data.length, L.maxTextScanChars - scanned);
        scanned += take;
        const words = data.substringData(0, take).match(WORD);
        if (words) wordCount += words.length;
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
    links,
    linkTotal,
    images,
    imageTotal,
  };
}

/** The script run in the isolated world: `extractPage` called on its `document` with the spec's limits. */
export const EXTRACTOR_SCRIPT = `(${extractPage.toString()})(document, ${JSON.stringify(SNAPSHOT_LIMITS)}, ${EXTRACT_TEXT_BUDGET_MS})`;

/** The part of a tab's WebContents the extractor needs. */
export interface ExtractTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the extractor in `contents`' SEO world; resolves its (untrusted, unvalidated) answer. */
export function runExtractor(contents: ExtractTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: EXTRACTOR_SCRIPT }]);
}
