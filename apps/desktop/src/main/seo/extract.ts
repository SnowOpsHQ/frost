import { MAX_BLOCKING_SCRIPTS } from '@app/specs/seo-speed.spec';
import { VISIBLE_TEXT_BLOCKS, VISIBLE_TEXT_LIMITS } from '@app/specs/seo-content.spec';
import { SECURITY_LIMITS } from '@app/specs/seo-compliance.spec';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SEO_WORLD_ID, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS, type SnapshotLimits } from '@app/specs/seo-limits.spec';
import { securityCall } from './security-extract';

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
  readonly parentElement: PageElement | null;
  substringData(offset: number, count: number): string;
}
interface PageElement extends PageNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly parentElement: PageElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selectors: string): PageElement | null;
  /** Chromium has it; some test DOMs do not (then only `[hidden]` hides). */
  checkVisibility?(): boolean;
}
interface PageRect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}
interface PageStyle {
  getPropertyValue(name: string): string;
}
interface PageImageElement extends PageElement {
  readonly currentSrc: string;
  readonly src: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly style?: PageStyle;
  readonly parentElement: (PageElement & { getElementsByTagName(name: string): PageList<PageElement> }) | null;
  getBoundingClientRect(): PageRect;
  matches(selectors: string): boolean;
}
/** The parts of the page's window the extractor reads (the first viewport's size and the scroll offset). */
interface PageView {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  getComputedStyle?(el: PageElement): PageStyle;
}
/** A stylesheet rule as the CSSOM exposes it (style rules have a selector and a style; grouping rules nested rules). */
interface PageRule {
  readonly selectorText?: string;
  readonly style?: PageStyle;
  readonly cssRules?: PageList<PageRule>;
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
  readonly defaultView: PageView | null;
  /** Its stylesheets (a cross-origin sheet's `cssRules` throws: skipped). */
  readonly styleSheets?: PageList<{ readonly cssRules: PageList<PageRule> }>;
  getElementsByTagName(name: string): PageList<PageElement>;
  querySelectorAll(selectors: string): PageList<PageElement>;
  createTreeWalker(root: PageNode, whatToShow: number, filter?: { acceptNode(node: PageNode): number } | null): PageTreeWalker;
}

/**
 * Reads the page into a snapshot (`PageSnapshotSchema`'s shape). Runs in the isolated world only.
 * Self-contained: it must not reference anything outside this function. Everything stops at one
 * deadline, `budgetMs` after it starts (`partial`).
 */
export function extractPage(
  document: PageDocument,
  L: SnapshotLimits,
  budgetMs: number,
  robotsNames: readonly string[],
  socialTags: readonly string[],
  socialUrlTags: readonly string[],
  maxBlockingScripts = 20,
  maxVisibleText = 0,
  blocks: readonly string[] = [],
): unknown {
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
  /** Most nested `display: contents` wrappers looked through for one element (`boxlessShown`). */
  const WRAPPER_SCAN = 256;
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
  const view = document.defaultView;
  /** `el`'s computed value of `name` (`''` where the DOM has no `getComputedStyle`). */
  const computed = (el: PageElement, name: string): string => (view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el).getPropertyValue(name) : '');
  /** `boxlessShown`'s answers (every wrapper of a chain shares its answer). */
  const boxless = new Map<PageElement, boolean>();
  /**
   * Whether `el`, which has no box (`checkVisibility()` false), still shows its content: it is a
   * layout wrapper (`display: contents`, nested ones too), and the nearest ancestor that is not one
   * has a box and does not skip its content (`content-visibility: hidden`, or a closed `<details>`
   * the wrapper is not the summary of). Style is read only for boxless elements, once each. Past
   * `WRAPPER_SCAN` wrappers, or the deadline, it is not shown and the snapshot is partial.
   */
  const boxlessShown = (el: PageElement): boolean => {
    const chain: PageElement[] = [];
    let node: PageElement | null = el;
    let shown = boxless.get(el);
    while (shown === undefined && node !== null && computed(node, 'display') === 'contents') {
      if (chain.length >= WRAPPER_SCAN || late()) {
        partial = true;
        shown = false;
        break;
      }
      chain.push(node);
      node = node.parentElement;
      if (node !== null) shown = boxless.get(node);
    }
    if (shown === undefined) {
      const top = chain[chain.length - 1];
      shown =
        node !== null &&
        top !== undefined &&
        (typeof node.checkVisibility !== 'function' || node.checkVisibility()) &&
        computed(node, 'content-visibility') !== 'hidden' &&
        !(node.localName === 'details' && !node.hasAttribute('open') && top.localName !== 'summary');
    }
    for (const wrapper of chain) boxless.set(wrapper, shown);
    return shown;
  };
  /** No box and not a wrapper whose content is shown (`checkVisibility()` false, where it exists). */
  const unshown = (el: PageElement): boolean => typeof el.checkVisibility === 'function' && !el.checkVisibility() && !boxlessShown(el);
  /** Hidden: the `hidden` attribute on it or an ancestor, or not shown (`unshown`). */
  const isHidden = (el: PageElement): boolean => el.closest('[hidden]') !== null || unshown(el);
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
      // `host`: the port counts (`LinkSchema.kind`).
      return { href: cut(url.href, L.maxUrlChars), scheme: cut(url.protocol.toLowerCase(), 32), host: url.host };
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
  // hreflang annotations in the head (Task 4): the value and the href as written, and resolved.
  const [hreflang, hreflangTotal] = firstOf(document.querySelectorAll('head link[rel~="alternate" i][hreflang]'), L.maxHreflang, (el) => {
    const href = cut((el.getAttribute('href') ?? '').trim(), L.maxUrlChars);
    return { hreflang: cut((el.getAttribute('hreflang') ?? '').trim(), L.maxHreflangChars), href, resolved: resolve(href)?.href ?? null };
  });
  // Render-blocking scripts in the head (Task 5, `BlockingScriptsSchema`): classic, not async (the
  // property: a script-inserted one is async by default), not defer, not nomodule.
  const blockingUrls: string[] = [];
  let blockingTotal = 0;
  const headScripts = document.querySelectorAll('head script[src]');
  for (let i = 0, n = headScripts.length; i < n && !late(); i++) {
    const el = headScripts[i];
    if (!el) continue;
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
    const classic = type === '' || /^(text|application)\/(x-)?(java|ecma|j)script$/.test(type);
    if (!classic || (el as { async?: unknown }).async === true || el.hasAttribute('async') || el.hasAttribute('defer') || el.hasAttribute('nomodule')) continue;
    blockingTotal += 1;
    if (blockingUrls.length < maxBlockingScripts) {
      const src = cut((el.getAttribute('src') ?? '').trim(), L.maxUrlChars);
      blockingUrls.push(resolve(src)?.href ?? src);
    }
  }
  const ogElement = document.querySelectorAll('meta[property="og:url" i]')[0];
  const ogContent = ogElement ? ogElement.getAttribute('content') : null;
  const ogUrl = ogContent === null ? null : cut(ogContent.trim(), L.maxUrlChars);
  const viewport = attribute(document.querySelectorAll('meta[name="viewport" i]')[0], 'content', L.maxAttributeChars);
  // Social tags: the first meta whose `property` or `name` is the tag. URLs as written (trimmed, cut).
  const social: Record<string, string | null> = {};
  for (const tag of socialTags) {
    const el = document.querySelectorAll(`meta[property="${tag}" i], meta[name="${tag}" i]`)[0];
    const content = el ? el.getAttribute('content') : null;
    social[tag] = content === null ? null : socialUrlTags.includes(tag) ? cut(content.trim(), L.maxUrlChars) : cut(squash(cut(content, L.maxSocialChars * 4)), L.maxSocialChars);
  }

  // Headings that are shown (hidden ones are counted in the total, and the first few kept apart for
  // the served-HTML comparison, which cannot tell them apart: Phase 2.5 Task 2 review).
  const headingOf = (el: PageElement) => ({
    level: Math.min(6, Math.max(1, Number(el.localName.slice(1)) || 1)),
    text: shortText(el, L.maxHeadingChars),
  });
  const hiddenHeadings: { level: number; text: string }[] = [];
  const [headings, headingTotal] = firstOf(document.querySelectorAll('h1, h2, h3, h4, h5, h6'), L.maxHeadings, headingOf, (el) => {
    if (!isHidden(el)) return true;
    if (hiddenHeadings.length < L.maxHiddenHeadings) hiddenHeadings.push(headingOf(el));
    return false;
  });

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
      target: attribute(el, 'target', L.maxTargetChars),
    };
  });

  // Images, with their rendered and natural sizes. The first viewport is the top
  // `innerHeight` × `innerWidth` of the document, wherever it is scrolled to now.
  const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
  const viewWidth = view ? finite(view.innerWidth) : 0;
  const viewHeight = view ? finite(view.innerHeight) : 0;
  const scrollX = view ? finite(view.scrollX) : 0;
  const scrollY = view ? finite(view.scrollY) : 0;
  const px = (n: number): number => Math.min(L.maxImagePixels, Math.max(0, Math.round(finite(n))));

  // `srcset` candidates (`url descriptors`, comma-separated; a URL may itself hold commas, as in
  // `data:` URLs), read from at most `maxSrcsetChars` characters, at most `maxSrcsetCandidates`.
  const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  const candidates = (value: string): { url: string; descriptor: string }[] => {
    const text = cut(value, L.maxSrcsetChars);
    const out: { url: string; descriptor: string }[] = [];
    let pos = 0;
    while (pos < text.length && out.length < L.maxSrcsetCandidates) {
      while (pos < text.length && (isSpace(text.charCodeAt(pos)) || text.charCodeAt(pos) === 44)) pos += 1;
      if (pos >= text.length) break;
      const start = pos;
      while (pos < text.length && !isSpace(text.charCodeAt(pos))) pos += 1;
      let url = text.slice(start, pos);
      let descriptor = '';
      if (url.endsWith(',')) url = url.replace(/,+$/, '');
      else {
        const from = pos;
        let depth = 0;
        for (; pos < text.length; pos++) {
          const c = text.charCodeAt(pos);
          if (c === 40) depth += 1;
          else if (c === 41) depth = Math.max(0, depth - 1);
          else if (c === 44 && depth === 0) break;
        }
        descriptor = text.slice(from, pos).trim().toLowerCase();
        pos += 1;
      }
      out.push({ url, descriptor });
    }
    return out;
  };
  /**
   * The size of the file the image shows. `naturalWidth` / `naturalHeight` are divided by the
   * density the browser picked from a `srcset` (its own or a `<picture><source>`'s), so the
   * candidate `currentSrc` came from corrects them: `Nw` is the file's width (its height from the
   * natural aspect), `Nx` multiplies; anything else is the natural size.
   */
  const fileSize = (img: PageImageElement, natural: { width: number; height: number }) => {
    const current = img.currentSrc;
    if (!current) return natural;
    const lists: string[] = [];
    const own = img.getAttribute('srcset');
    if (own) lists.push(own);
    const parent = img.parentElement;
    if (parent && parent.localName === 'picture') {
      const sources = parent.getElementsByTagName('source');
      for (let i = 0; i < sources.length && i < L.maxPictureSources; i++) {
        const value = sources[i]?.getAttribute('srcset');
        if (value) lists.push(value);
      }
    }
    for (const list of lists) {
      for (const candidate of candidates(list)) {
        let href = '';
        try {
          href = new URL(candidate.url, document.baseURI).href;
        } catch {
          continue;
        }
        if (href !== current) continue;
        for (const token of candidate.descriptor.split(/\s+/)) {
          const match = /^(\d+(?:\.\d+)?)([wx])$/.exec(token);
          const n = match ? Number(match[1]) : 0;
          if (!match || !(n > 0)) continue;
          if (match[2] === 'w') return { width: px(n), height: px((n * natural.height) / natural.width) };
          return { width: px(natural.width * n), height: px(natural.height * n) };
        }
        return natural;
      }
    }
    return natural;
  };

  // Selectors of same-origin stylesheet rules that declare both `width` and `height` (not `auto`):
  // read once, at most `maxSizingRules` rules and `maxSizingSelectors` selectors, before the deadline.
  let sizingSelectors: string[] | null = null;
  const declared = (style: PageStyle | undefined, name: string): boolean => {
    const value = style ? style.getPropertyValue(name).trim().toLowerCase() : '';
    return value !== '' && value !== 'auto';
  };
  const readSizingSelectors = (): string[] => {
    const out: string[] = [];
    let seen = 0;
    const visit = (rules: PageList<PageRule>, depth: number): void => {
      for (let i = 0; i < rules.length; i++) {
        if (seen >= L.maxSizingRules || out.length >= L.maxSizingSelectors || ((seen & 255) === 0 && late())) return;
        seen += 1;
        const rule = rules[i];
        if (!rule) continue;
        if (rule.selectorText && declared(rule.style, 'width') && declared(rule.style, 'height')) out.push(cut(rule.selectorText, 1_024));
        else if (rule.cssRules && depth < 4) visit(rule.cssRules, depth + 1);
      }
    };
    const sheets = document.styleSheets;
    for (let i = 0; sheets && i < sheets.length && i < 256; i++) {
      try {
        const rules = sheets[i]?.cssRules;
        if (rules) visit(rules, 0);
      } catch {
        // A cross-origin sheet: its rules cannot be read.
      }
    }
    return out;
  };
  /** CSS fixes the image's box: a computed `aspect-ratio` with a ratio, or `width` and `height` declared together (inline or a matching rule). */
  const cssSized = (img: PageImageElement): boolean => {
    const ratio = computed(img, 'aspect-ratio');
    if (/\d/.test(ratio)) return true;
    if (declared(img.style, 'width') && declared(img.style, 'height')) return true;
    sizingSelectors ??= readSizingSelectors();
    return sizingSelectors.some((selector) => {
      try {
        return img.matches(selector);
      } catch {
        return false;
      }
    });
  };

  const [images, imageTotal] = firstOf(document.images, L.maxImages, (img) => {
    const box = isHidden(img) ? null : img.getBoundingClientRect();
    const rendered = box && px(box.width) > 0 && px(box.height) > 0 ? { width: px(box.width), height: px(box.height) } : null;
    const inFirstViewport =
      box !== null && rendered !== null && finite(box.top) + scrollY < viewHeight && finite(box.bottom) + scrollY > 0 && finite(box.left) + scrollX < viewWidth && finite(box.right) + scrollX > 0;
    const intrinsic = px(img.naturalWidth) > 0 && px(img.naturalHeight) > 0 ? { width: px(img.naturalWidth), height: px(img.naturalHeight) } : null;
    const natural = intrinsic && fileSize(img, intrinsic);
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
      rendered,
      natural,
      inFirstViewport,
      cssSized: rendered !== null && (small('width') === null || small('width') === '' || small('height') === null || small('height') === '') && cssSized(img),
    };
  });

  // Structured data (Task 3). JSON-LD: each block's text as written, read with bounded
  // `substringData` (a 5 MB block costs no more than its cap), never parsed here. Microdata and RDFa
  // Lite: flat item lists, a nested item being a property that holds its (later) index.
  let jsonLdChars = 0;
  const [jsonLd, jsonLdTotal] = firstOf(document.querySelectorAll('script[type="application/ld+json" i]'), L.maxJsonLdBlocks, (el) => {
    const room = Math.max(0, Math.min(L.maxJsonLdChars, L.maxJsonLdTotalChars - jsonLdChars));
    const read = textOf(el, room + 1, 64);
    const text = cut(read.text, room);
    jsonLdChars += text.length;
    return { text, length: total(Math.max(read.units, text.length)) };
  });
  const names = (value: string | null): string[] => {
    const out: string[] = [];
    if (value === null) return out;
    for (const token of cut(value, L.maxSchemaNameChars * L.maxItemTypes).split(/\s+/)) {
      if (token !== '' && out.length < L.maxItemTypes) out.push(cut(token, L.maxSchemaNameChars));
    }
    return out;
  };
  const valueText = (el: PageElement): string => shortText(el, L.maxSchemaValueChars);
  const urlValue = (raw: string | null): string => {
    const resolved = raw === null ? null : resolve(raw);
    return cut(resolved ? resolved.href : (raw ?? '').trim(), L.maxSchemaValueChars);
  };
  const attributeValue = (el: PageElement, name: string): string => cut(squash(cut(el.getAttribute(name) ?? '', L.maxSchemaValueChars * 4)), L.maxSchemaValueChars);
  const SRC = ['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video'];
  const HREF = ['a', 'area', 'link'];
  /** A microdata property's value (`MarkupItemSchema`). */
  const microdataValue = (el: PageElement): string => {
    const tag = el.localName;
    if (el.hasAttribute('content')) return attributeValue(el, 'content');
    if (SRC.includes(tag)) return urlValue(el.getAttribute('src'));
    if (HREF.includes(tag)) return urlValue(el.getAttribute('href'));
    if (tag === 'object') return urlValue(el.getAttribute('data'));
    if ((tag === 'data' || tag === 'meter') && el.hasAttribute('value')) return attributeValue(el, 'value');
    if (tag === 'time' && el.hasAttribute('datetime')) return attributeValue(el, 'datetime');
    return valueText(el);
  };
  /** An RDFa property's value. */
  const rdfaValue = (el: PageElement): string => {
    if (el.hasAttribute('content')) return attributeValue(el, 'content');
    for (const name of ['resource', 'href', 'src']) if (el.hasAttribute(name)) return urlValue(el.getAttribute(name));
    if (el.localName === 'time' && el.hasAttribute('datetime')) return attributeValue(el, 'datetime');
    return valueText(el);
  };
  /** Characters of markup values kept so far, microdata and RDFa together (`maxMarkupTotalChars`). */
  let markupChars = 0;
  type MarkupProperty = { name: string; value: string } | { name: string; item: number };
  type MarkupItem = { types: string[]; id: string | null; vocab: string | null; properties: MarkupProperty[] };
  /**
   * Items (elements with `scope`) and their properties (elements with `prop`), in document order:
   * at most `maxMarkupElements` looked at, `maxMarkupItems` kept, `maxMarkupDepth` deep. An
   * element's owner is the nearest item above it; an item with a property name is its owner's value.
   */
  const readMarkup = (rdfa: boolean): [MarkupItem[], number] => {
    const scope = rdfa ? 'typeof' : 'itemscope';
    const prop = rdfa ? 'property' : 'itemprop';
    const items: MarkupItem[] = [];
    const depthOf: number[] = [];
    const indexOf = new Map<PageElement, number>();
    let count = 0;
    const list = document.querySelectorAll(`[${scope}], [${prop}]`);
    const n = Math.min(list.length, L.maxMarkupElements);
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0 && late()) break;
      const el = list[i];
      if (!el) continue;
      const isItem = el.hasAttribute(scope);
      if (isItem) count += 1;
      const props = names(el.getAttribute(prop));
      const ownerEl = el.parentElement ? el.parentElement.closest(`[${scope}]`) : null;
      const owner = ownerEl ? indexOf.get(ownerEl) : undefined;
      if (isItem) {
        const nested = props.length > 0 && ownerEl !== null;
        const holder = owner === undefined ? undefined : items[owner];
        // Held by an item that was not kept, or that cannot hold another property (over a cap): dropped.
        if (nested && (holder === undefined || holder.properties.length >= L.maxItemProperties)) continue;
        const depth = nested && owner !== undefined ? (depthOf[owner] ?? 0) + 1 : 0;
        if (depth > L.maxMarkupDepth || items.length >= L.maxMarkupItems) continue;
        const index = items.length;
        const id = rdfa ? (el.getAttribute('resource') ?? el.getAttribute('about')) : el.getAttribute('itemid');
        const vocabEl = rdfa ? el.closest('[vocab]') : null;
        items.push({
          types: names(el.getAttribute(rdfa ? 'typeof' : 'itemtype')),
          id: id === null || id.trim() === '' ? null : cut(id.trim(), L.maxSchemaValueChars),
          vocab: vocabEl ? cut((vocabEl.getAttribute('vocab') ?? '').trim(), L.maxSchemaNameChars) || null : null,
          properties: [],
        });
        depthOf.push(depth);
        indexOf.set(el, index);
        if (nested && holder) holder.properties.push({ name: props[0]!, item: index });
      } else if (owner !== undefined) {
        const holder = items[owner]!;
        if (holder.properties.length >= L.maxItemProperties) continue;
        const value = rdfa ? rdfaValue(el) : microdataValue(el);
        for (const name of props) {
          if (holder.properties.length >= L.maxItemProperties) break;
          const kept = cut(value, Math.max(0, L.maxMarkupTotalChars - markupChars));
          markupChars += kept.length;
          holder.properties.push({ name, value: kept });
        }
      }
    }
    // Every item the page has, also past the elements looked at (or the deadline).
    return [items, total(Math.max(count, document.querySelectorAll(`[${scope}]`).length))];
  };
  const [microdata, microdataTotal] = readMarkup(false);
  const [rdfa, rdfaTotal] = readMarkup(true);

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
  // The same walk keeps the visible text for the content analysis (Phase 2.5 Task 3,
  // `seo-content.spec.ts`): each node's white space collapsed, a `\n` at a block boundary (a `<br>`,
  // entering a block element, or a text whose nearest block ancestor is another than the previous
  // text's: `closest` of the block elements, so `<div><p><span>a</span></p>b</div>` is `a\nb`), the
  // first `maxVisibleText` code units.
  const keptText: string[] = [];
  let kept = 0;
  let keptCut = false;
  let blockBreak = false;
  const blockSelector = blocks.filter((name) => name !== 'br' && name !== 'hr').join(',');
  let lastBlock: PageElement | null | undefined;
  const keep = (raw: string, node: PageText): void => {
    const text = raw.replace(/\s+/g, ' ');
    if (text === '') return;
    if (text !== ' ' && blockSelector !== '') {
      const block = node.parentElement ? node.parentElement.closest(blockSelector) : null;
      if (lastBlock !== undefined && block !== lastBlock) blockBreak = true;
      lastBlock = block;
    }
    if (kept >= maxVisibleText) {
      keptCut = true;
      return;
    }
    // White space alone separates words (unless a block boundary already does).
    if (text === ' ' && (kept === 0 || blockBreak)) return;
    const piece = (blockBreak && kept > 0 && text !== ' ' ? '\n' : '') + text;
    if (text !== ' ') blockBreak = false;
    const room = maxVisibleText - kept;
    const part = cut(piece, room);
    if (part.length < piece.length) keptCut = true;
    keptText.push(part);
    kept += part.length;
  };
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
        // A hidden subtree is pruned; a layout wrapper's (`display: contents`) is walked.
        if (SKIP.includes(el.localName) || el.hasAttribute('hidden') || unshown(el)) return FILTER_REJECT;
        if (blocks.includes(el.localName)) blockBreak = true;
        return FILTER_SKIP;
      },
    });
    try {
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        textNodes += 1;
        const data = node as PageText;
        const take = Math.min(data.length, L.maxTextScanChars - scanned);
        scanned += take;
        const chunk = data.substringData(0, take);
        wordCount += countWords(chunk);
        if (maxVisibleText > 0) keep(chunk, data);
      }
    } catch (error) {
      if (error !== STOP) throw error;
      textTruncated = true;
    }
  }
  const visibleText = { text: keptText.join('').replace(/ *\n */g, '\n').trim(), truncated: keptCut || textTruncated };

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
    social,
    viewport,
    headings,
    headingTotal,
    hiddenHeadings,
    wordCount: total(wordCount),
    textTruncated,
    partial,
    links,
    linkTotal,
    images,
    imageTotal,
    jsonLd,
    jsonLdTotal,
    microdata,
    microdataTotal,
    rdfa,
    rdfaTotal,
    hreflang,
    hreflangTotal,
    blockingScripts: { urls: blockingUrls, total: total(blockingTotal) },
    ...(maxVisibleText > 0 ? { visibleText } : {}),
  };
}

/**
 * The script run in the isolated world: `extractPage` called on its `document` with the spec's
 * limits, deadline, robots meta names, social tags and the visible-text cap and blocks (Phase 2.5
 * Task 3), then the security read (`extractSecurity`,
 * Task 6) as its `security`.
 */
export const EXTRACTOR_SCRIPT = `Object.assign((${extractPage.toString()})(document, ${JSON.stringify(SNAPSHOT_LIMITS)}, ${EXTRACT_BUDGET_MS}, ${JSON.stringify(ROBOTS_META_NAMES)}, ${JSON.stringify(SOCIAL_TAGS)}, ${JSON.stringify(SOCIAL_URL_TAGS)}, ${MAX_BLOCKING_SCRIPTS}, ${VISIBLE_TEXT_LIMITS.maxVisibleTextChars}, ${JSON.stringify(VISIBLE_TEXT_BLOCKS)}), { security: ${securityCall(SECURITY_LIMITS)} })`;

/** The part of a tab's WebContents the extractor needs. */
export interface ExtractTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the extractor in `contents`' SEO world; resolves its (untrusted, unvalidated) answer. */
export function runExtractor(contents: ExtractTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SEO_WORLD_ID, [{ code: EXTRACTOR_SCRIPT }]);
}
