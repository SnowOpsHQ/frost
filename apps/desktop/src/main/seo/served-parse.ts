import { defaultTreeAdapter, parse, parseFragment, type DefaultTreeAdapterMap, type TreeAdapter } from 'parse5';
import { SERVED_PARSE_LIMITS } from '@app/specs/seo-javascript.spec';
import type { ServedParseInput, ServedParseResult, ServedSnapshot } from '@app/specs/seo-javascript.schema';
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS, type SnapshotLimits } from '@app/specs/seo-limits.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The served HTML's parse (spec `seo-javascript.spec.ts`, `SERVED_PARSE_LIMITS`; acceptance
// `seo-javascript.feature.md`, Parsing; review focus `served-html-is-bounded`). Runs in the analysis
// worker only (`analysis-worker.ts`), never on main's thread: the bytes main fetched are decoded and
// parsed with `parse5` (the WHATWG algorithm, scripting enabled as in the browser that rendered the
// page) through a tree adapter that counts every node it creates and how deep it attaches it, and
// stops the parse at `maxNodes` / `maxDepth` (what was built is read, `partial`). The snapshot is
// read from the tree the way the extractor (`extract.ts`) reads the live DOM, with the same caps,
// minus everything that needs layout: no hidden-element check for headings, and only `[hidden]`
// subtrees are left out of the word count.

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];

const XHTML = 'http://www.w3.org/1999/xhtml';
/** Thrown from the tree adapter to stop the parse at a cap. */
const STOP = Symbol('served-parse-cap');
/** Values longer than this (UTF-16 code units) are measured in code units, not scanned (as the extractor). */
const SCAN = 65_536;

export interface ParseLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly prescanBytes: number;
  readonly maxNoscriptChars: number;
}

/** The node budget one parse shares (the document and its `<noscript>` fragments). */
interface Budget {
  nodes: number;
  hit: boolean;
  readonly limits: ParseLimits;
}

/** `defaultTreeAdapter`, counting the nodes it creates and refusing to go deeper than `maxDepth`: both stop the parse (`STOP`). */
function boundedAdapter(budget: Budget): TreeAdapter<DefaultTreeAdapterMap> {
  const depth = new WeakMap<object, number>();
  const count = (): void => {
    budget.nodes += 1;
    if (budget.nodes > budget.limits.maxNodes) {
      budget.hit = true;
      throw STOP;
    }
  };
  const attach = (parent: ParentNode, child: ChildNode): void => {
    const level = (depth.get(parent) ?? 0) + 1;
    if (level > budget.limits.maxDepth) {
      budget.hit = true;
      throw STOP;
    }
    depth.set(child, level);
  };
  const endsWithText = (parent: ParentNode, before?: ChildNode): boolean => {
    const nodes = parent.childNodes;
    const prev = before === undefined ? nodes[nodes.length - 1] : nodes[nodes.indexOf(before) - 1];
    return prev !== undefined && defaultTreeAdapter.isTextNode(prev);
  };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      count();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    createCommentNode(data) {
      count();
      return defaultTreeAdapter.createCommentNode(data);
    },
    appendChild(parent, node) {
      attach(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      attach(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, reference);
    },
    insertText(parent, text) {
      if (!endsWithText(parent)) count();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      if (!endsWithText(parent, reference)) count();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
  };
}

// ---- Decoding ------------------------------------------------------------------------------------

/** A decoder for `label`, or `null` when the runtime does not know it. */
function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label.trim().toLowerCase());
  } catch {
    return null;
  }
}

/** The `charset` parameter of a `Content-Type` value, if any. */
export function charsetOf(contentType: string | null): string | null {
  const match = contentType === null ? null : /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return match ? match[1]! : null;
}

/**
 * The served bytes as text (`SERVED_PARSE_LIMITS`, decoding): a byte order mark, else the
 * `Content-Type` charset, else a `<meta charset>` / `http-equiv` charset in the first `prescanBytes`,
 * else UTF-8. A UTF-16 label from a meta tag is read as UTF-8 (as the HTML standard says); an
 * unknown label is UTF-8.
 */
export function decodeServed(bytes: Uint8Array, contentType: string | null, prescanBytes: number = SERVED_PARSE_LIMITS.prescanBytes): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  const header = charsetOf(contentType);
  const fromHeader = header === null ? null : decoderFor(header);
  if (fromHeader) return fromHeader.decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, prescanBytes));
  const meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  const label = meta ? meta[1]!.toLowerCase() : null;
  const fromMeta = label === null || label.startsWith('utf-16') ? null : decoderFor(label);
  return (fromMeta ?? new TextDecoder('utf-8')).decode(bytes);
}

// ---- Reading the tree --------------------------------------------------------------------------------

const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is TextNode => node.nodeName === '#text';
const isHtml = (el: Element, name: string): boolean => el.namespaceURI === XHTML && el.tagName === name;
const attr = (el: Element, name: string): string | null => {
  for (const a of el.attrs) if (a.name === name && !a.namespace) return a.value;
  return null;
};
const has = (el: Element, name: string): boolean => attr(el, name) !== null;
const childrenOf = (node: Node): readonly ChildNode[] => ('childNodes' in node ? node.childNodes : []);

/** Every node under `root` in document order (not `root`; never into template contents), iteratively; `skip` prunes a subtree. */
function* walk(root: Node, skip?: (el: Element) => boolean): Generator<Node> {
  const stack: Node[] = [...childrenOf(root)].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node) && skip?.(node)) continue;
    yield node;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

function* elementsOf(root: Node): Generator<Element> {
  for (const node of walk(root)) if (isElement(node)) yield node;
}

/** The (HTML) `<html>`, `<head>` and `<body>` of a parsed document, if built. */
function documentParts(document: Node): { html: Element | null; head: Element | null; body: Element | null } {
  const html = childrenOf(document).find((node): node is Element => isElement(node) && isHtml(node, 'html')) ?? null;
  const part = (name: string) => (html ? (childrenOf(html).find((node): node is Element => isElement(node) && isHtml(node, name)) ?? null) : null);
  return { html, head: part('head'), body: part('body') };
}

const WORD = /[\p{L}\p{N}]+/gu;
const SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
/** Words in `text`, as the extractor counts them (`Intl.Segmenter` word-like segments; runs of letters or digits without it). */
export function countWords(text: string): number {
  if (!SEGMENTER) return (text.match(WORD) ?? []).length;
  let n = 0;
  for (const segment of SEGMENTER.segment(text)) if (segment.isWordLike) n += 1;
  return n;
}

/** Subtrees the word count leaves out (the extractor's, `PageSnapshotSchema.wordCount`). */
const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];

/** Reads the parsed `document` (from `url`) into a served snapshot. */
function readSnapshot(document: Node, url: URL, L: SnapshotLimits, budget: Budget, limits: ParseLimits): ServedSnapshot {
  const total = (n: number): number => Math.min(n, L.maxCount);
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const measure = (raw: string, fullUnits: number, max: number) => {
    if (fullUnits > SCAN) return { text: cut(squash(raw.slice(0, max * 4)), max), length: total(fullUnits) };
    const value = squash(raw);
    let points = 0;
    for (const _ of value) points += 1;
    return { text: cut(value, max), length: total(points) };
  };
  const measureAttribute = (value: string, max: number) => measure(value.length > SCAN ? value.slice(0, SCAN) : value, value.length, max);
  const attribute = (el: Element | null, name: string, max: number): string | null => {
    const value = el ? attr(el, name) : null;
    return value === null ? null : cut(squash(cut(value, max * 4)), max);
  };
  /** Up to `limit` code units of `root`'s text, visiting at most `visits` nodes; the units seen and the first `img[alt]`. */
  const textOf = (root: Node, limit: number, visits: number) => {
    let text = '';
    let units = 0;
    let seen = 0;
    let imageAlt: string | null = null;
    for (const node of walk(root)) {
      seen += 1;
      if (seen > visits) break;
      if (isText(node)) {
        units += node.value.length;
        if (text.length < limit) text += node.value.slice(0, limit - text.length);
      } else if (isElement(node) && imageAlt === null && isHtml(node, 'img')) imageAlt = attr(node, 'alt');
    }
    return { text, units, imageAlt };
  };
  const shortText = (root: Node, max: number): string => cut(squash(textOf(root, max * 4, L.maxElementTextVisits).text), max);
  const site = (host: string): string => {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
  };

  // The document's base URL: the first `<base href>` that resolves, else the URL it came from.
  let base = url.href;
  for (const el of elementsOf(document)) {
    if (!isHtml(el, 'base')) continue;
    const href = attr(el, 'href');
    if (href === null) continue;
    try {
      base = new URL(href.trim(), url.href).href;
    } catch {
      // An unusable base: the document URL stands.
    }
    break;
  }
  const resolve = (raw: string): { href: string; scheme: string; host: string } | null => {
    try {
      const target = new URL(cut(raw.trim(), L.maxUrlChars * 2), base);
      return { href: cut(target.href, L.maxUrlChars), scheme: cut(target.protocol.toLowerCase(), 32), host: target.host };
    } catch {
      return null;
    }
  };
  const pageSite = site(url.host);
  const { html, head, body } = documentParts(document);
  const isNamed = (el: Element, attrName: string, value: string): boolean => (attr(el, attrName) ?? '\u0000').toLowerCase() === value;
  const relHas = (el: Element, token: string): boolean => (attr(el, 'rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/).includes(token);

  const titles: ServedSnapshot['titles'] = [];
  let titleTotal = 0;
  const metaDescriptions: ServedSnapshot['metaDescriptions'] = [];
  let metaDescriptionTotal = 0;
  const metaRobots: ServedSnapshot['metaRobots'] = [];
  const canonicals: ServedSnapshot['canonicals'] = [];
  let canonicalTotal = 0;
  let ogUrl: string | null | undefined;
  let viewport: string | null | undefined;
  const headings: ServedSnapshot['headings'] = [];
  let headingTotal = 0;
  const links: ServedSnapshot['links'] = [];
  let linkTotal = 0;
  const images: ServedSnapshot['images'] = [];
  let imageTotal = 0;
  const jsonLd: ServedSnapshot['jsonLd'] = [];
  let jsonLdTotal = 0;
  let jsonLdChars = 0;
  const noscripts: Element[] = [];
  const robotsNames: readonly string[] = ROBOTS_META_NAMES;

  for (const el of elementsOf(document)) {
    if (el.namespaceURI !== XHTML) continue;
    switch (el.tagName) {
      case 'title':
        titleTotal += 1;
        if (titles.length < L.maxRepeated) {
          const read = textOf(el, SCAN, L.maxElementTextVisits);
          titles.push(measure(read.text, read.units, L.maxTextChars));
        }
        break;
      case 'meta': {
        const name = (attr(el, 'name') ?? '').toLowerCase();
        if (attr(el, 'name') !== null && name === 'description') {
          metaDescriptionTotal += 1;
          if (metaDescriptions.length < L.maxRepeated) metaDescriptions.push(measureAttribute(attr(el, 'content') ?? '', L.maxTextChars));
        }
        if (attr(el, 'name') !== null && robotsNames.includes(name) && metaRobots.length < L.maxRepeated) {
          metaRobots.push({ name: name.trim() as ServedSnapshot['metaRobots'][number]['name'], content: (attribute(el, 'content', L.maxAttributeChars) ?? '').toLowerCase() });
        }
        if (ogUrl === undefined && isNamed(el, 'property', 'og:url')) {
          const content = attr(el, 'content');
          ogUrl = content === null ? null : cut(content.trim(), L.maxUrlChars);
        }
        if (viewport === undefined && isNamed(el, 'name', 'viewport')) viewport = attribute(el, 'content', L.maxAttributeChars);
        break;
      }
      case 'link':
        if (relHas(el, 'canonical')) {
          canonicalTotal += 1;
          if (canonicals.length < L.maxRepeated) {
            const href = cut((attr(el, 'href') ?? '').trim(), L.maxUrlChars);
            canonicals.push({ href, resolved: resolve(href)?.href ?? null });
          }
        }
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        headingTotal += 1;
        if (headings.length < L.maxHeadings) headings.push({ level: Number(el.tagName.slice(1)), text: shortText(el, L.maxHeadingChars) });
        break;
      case 'img':
        imageTotal += 1;
        if (images.length < L.maxImages) {
          const src = attr(el, 'src');
          const alt = attr(el, 'alt');
          images.push({ src: src === null ? '' : (resolve(src)?.href ?? ''), alt: alt === null ? null : measureAttribute(alt, L.maxAltChars) });
        }
        break;
      case 'script':
        if ((attr(el, 'type') ?? '').toLowerCase() === 'application/ld+json') {
          jsonLdTotal += 1;
          if (jsonLd.length < L.maxJsonLdBlocks) {
            const room = Math.max(0, Math.min(L.maxJsonLdChars, L.maxJsonLdTotalChars - jsonLdChars));
            const read = textOf(el, room + 1, 64);
            const text = cut(read.text, room);
            jsonLdChars += text.length;
            jsonLd.push({ text, length: total(Math.max(read.units, text.length)) });
          }
        }
        break;
      case 'noscript':
        noscripts.push(el);
        break;
    }
    if ((isHtml(el, 'a') || isHtml(el, 'area')) && has(el, 'href')) {
      linkTotal += 1;
      if (links.length < L.maxLinks) {
        const target = resolve(attr(el, 'href') ?? '');
        const web = target !== null && (target.scheme === 'http:' || target.scheme === 'https:');
        const read = textOf(el, L.maxAnchorChars * 4, L.maxElementTextVisits);
        let text = cut(squash(read.text), L.maxAnchorChars);
        if (text === '') text = attribute(el, 'aria-label', L.maxAnchorChars) ?? '';
        if (text === '' && read.imageAlt !== null) text = cut(squash(cut(read.imageAlt, L.maxAnchorChars * 4)), L.maxAnchorChars);
        if (text === '') text = attribute(el, 'title', L.maxAnchorChars) ?? '';
        links.push({
          href: target ? target.href : '',
          scheme: target ? target.scheme : '',
          rel: (attribute(el, 'rel', L.maxAttributeChars) ?? '').toLowerCase(),
          text,
          kind: web ? (site(target.host) === pageSite ? 'internal' : 'external') : 'other',
          target: attribute(el, 'target', L.maxTargetChars),
        });
      }
    }
  }

  // hreflang annotations in the head.
  const hreflang: ServedSnapshot['hreflang'] = [];
  let hreflangTotal = 0;
  if (head) {
    for (const el of elementsOf(head)) {
      if (!isHtml(el, 'link') || !relHas(el, 'alternate') || !has(el, 'hreflang')) continue;
      hreflangTotal += 1;
      if (hreflang.length >= L.maxHreflang) continue;
      const href = cut((attr(el, 'href') ?? '').trim(), L.maxUrlChars);
      hreflang.push({ hreflang: cut((attr(el, 'hreflang') ?? '').trim(), L.maxHreflangChars), href, resolved: resolve(href)?.href ?? null });
    }
  }

  // The body's words, as the extractor counts them (with the same node and character budgets).
  const skipped = (el: Element): boolean => SKIP.includes(el.tagName) || has(el, 'hidden');
  let wordCount = 0;
  let textTruncated = false;
  if (body) {
    let textNodes = 0;
    let scanned = 0;
    let visited = 0;
    for (const node of walk(body, skipped)) {
      visited += 1;
      if (textNodes >= L.maxTextNodes || scanned >= L.maxTextScanChars || visited > L.maxTextNodes * 4) {
        textTruncated = true;
        break;
      }
      if (!isText(node)) continue;
      textNodes += 1;
      const take = Math.min(node.value.length, L.maxTextScanChars - scanned);
      scanned += take;
      wordCount += countWords(node.value.slice(0, take));
    }
  }

  // `<noscript>`: its text parsed as HTML (within the same node budget), its words and links counted.
  let noscriptWords = 0;
  let noscriptLinks = 0;
  for (const el of noscripts) {
    if (budget.hit) break;
    const read = textOf(el, limits.maxNoscriptChars, L.maxElementTextVisits);
    if (read.text.trim() === '') continue;
    let fragment: Node;
    try {
      fragment = parseFragment(read.text, { treeAdapter: boundedAdapter(budget) });
    } catch (error) {
      if (error !== STOP) throw error;
      break;
    }
    for (const node of walk(fragment, (child) => SKIP.includes(child.tagName))) {
      if (isText(node)) noscriptWords += countWords(node.value);
      else if (isElement(node) && (isHtml(node, 'a') || isHtml(node, 'area')) && has(node, 'href')) noscriptLinks += 1;
    }
  }

  const lang = attribute(html, 'lang', L.maxLangChars);
  return {
    url: cut(url.href, L.maxUrlChars),
    lang: lang === '' ? null : lang,
    titles,
    titleTotal: total(titleTotal),
    metaDescriptions,
    metaDescriptionTotal: total(metaDescriptionTotal),
    metaRobots,
    canonicals,
    canonicalTotal: total(canonicalTotal),
    ogUrl: ogUrl ?? null,
    viewport: viewport ?? null,
    headings,
    headingTotal: total(headingTotal),
    links,
    linkTotal: total(linkTotal),
    images,
    imageTotal: total(imageTotal),
    jsonLd,
    jsonLdTotal: total(jsonLdTotal),
    hreflang,
    hreflangTotal: total(hreflangTotal),
    wordCount: total(wordCount),
    textTruncated,
    noscript: { count: total(noscripts.length), wordCount: total(noscriptWords), linkCount: total(noscriptLinks) },
    nodes: total(budget.nodes),
    partial: budget.hit,
  };
}

/**
 * The served snapshot of `input` (bytes as fetched, their media type and the URL they came from):
 * decoded, parsed within `limits` and read. `parse-failed` when it cannot be read. Never throws.
 */
export function parseServedHtml(input: ServedParseInput, limits: ParseLimits = SERVED_PARSE_LIMITS, snapshotLimits: SnapshotLimits = SNAPSHOT_LIMITS): ServedParseResult {
  try {
    const url = parseWebUrl(input.url);
    if (!url || !(input.body instanceof Uint8Array)) return { ok: false, reason: 'parse-failed' };
    const text = decodeServed(input.body, typeof input.contentType === 'string' ? input.contentType : null, limits.prescanBytes);
    const budget: Budget = { nodes: 0, hit: false, limits };
    const adapter = boundedAdapter(budget);
    // The document is kept as soon as the parser creates it, so a parse stopped at a cap still has it.
    let document: Node | null = null;
    const keeping: TreeAdapter<DefaultTreeAdapterMap> = {
      ...adapter,
      createDocument() {
        const created = adapter.createDocument();
        document = created;
        return created;
      },
    };
    try {
      parse(text, { treeAdapter: keeping, scriptingEnabled: true });
    } catch (error) {
      if (error !== STOP) throw error;
    }
    if (document === null) return { ok: false, reason: 'parse-failed' };
    return { ok: true, snapshot: readSnapshot(document, url, snapshotLimits, budget, limits) };
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
}
