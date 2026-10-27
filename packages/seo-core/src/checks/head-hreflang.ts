// The lightest read of an alternate's served HTML that finds its hreflang set (spec
// `seo-checks.spec.ts`, `HREFLANG_CHECK_LIMITS`; acceptance `seo-checks.feature.md`, hreflang
// reciprocity): one forward pass over the text, tags only, stopping where a browser would leave
// `<head>` (its end tag, `<body>`, or any start tag that cannot be in the head), skipping comments
// and the raw text of `<script>`, `<style>`, `<title>`, `<textarea>`, `<noscript>` and `<template>`.
// It keeps each `<link>` whose `rel` has `alternate` and that has an `hreflang` attribute: the value
// and the `href` as written (entities decoded), at most `max`; and the `href` of the head's first
// `<base>` that has one (the document's base, whether before or after the links). Linear in the text;
// never throws. Pure: the analysis worker runs it on the first `HREFLANG_CHECK_LIMITS.maxBytes` of
// the answer.

/** Start tags a head may hold (anything else ends it, as the HTML parser's "in head" mode does). */
const HEAD_TAGS: ReadonlySet<string> = new Set(['html', 'head', 'base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'noscript', 'noframes', 'style', 'script', 'template']);
/** Elements whose content is raw text (no tags inside). */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'title', 'textarea', 'noscript', 'noframes', 'template', 'xmp']);

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** `value` with character references decoded (numeric ones and the few named ones attribute values use). */
export function decodeAttribute(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

export interface HeadHreflang {
  readonly hreflang: string;
  readonly href: string;
}

export interface AlternateHead {
  /** The `<link rel="alternate" hreflang>` annotations, at most `max`. */
  readonly links: HeadHreflang[];
  /** The first `<base>`'s `href` as written (entities decoded, trimmed), `null` for none. */
  readonly baseHref: string | null;
}

/** The `<link rel="alternate" hreflang>` annotations of `html`'s head, at most `max`. */
export function headHreflangLinks(html: string, max: number): HeadHreflang[] {
  return alternateHead(html, max).links;
}

/** The hreflang annotations of `html`'s head (at most `max`) and its base `href`. */
export function alternateHead(html: string, max: number): AlternateHead {
  const out: HeadHreflang[] = [];
  let baseHref: string | null = null;
  const n = html.length;
  let i = 0;
  // Past `max` links only while no base is known (a later `<base>` is still the document's).
  while (i < n && (out.length < max || baseHref === null)) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    if (html.startsWith('!--', i)) {
      const end = html.indexOf('-->', i + 3);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html[i] === '!' || html[i] === '?') {
      const end = html.indexOf('>', i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const closing = html[i] === '/';
    if (closing) i++;
    const nameStart = i;
    if (!/[a-z]/i.test(html[i] ?? '')) continue;
    while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
    const name = html.slice(nameStart, i).toLowerCase();
    if (closing) {
      if (name === 'head' || name === 'html') break;
      const end = html.indexOf('>', i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!HEAD_TAGS.has(name)) break;
    // Attributes up to the tag's end.
    const attributes = new Map<string, string>();
    for (;;) {
      while (i < n && (isSpace(html[i]) || html[i] === '/')) i++;
      if (i >= n || html[i] === '>') break;
      const attrStart = i;
      while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++;
      // A lone `=` (or other odd character) is skipped, never looped on.
      if (i === attrStart) i++;
      const attr = html.slice(attrStart, i).toLowerCase();
      while (i < n && isSpace(html[i])) i++;
      let value = '';
      if (html[i] === '=') {
        i++;
        while (i < n && isSpace(html[i])) i++;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          value = html.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else {
          const valueStart = i;
          while (i < n && !isSpace(html[i]) && html[i] !== '>') i++;
          value = html.slice(valueStart, i);
        }
      }
      // The first occurrence of an attribute counts, as in HTML.
      if (attr !== '' && !attributes.has(attr)) attributes.set(attr, value);
    }
    // A tag the input ends inside is dropped, as in a browser.
    if (i >= n) break;
    i++;
    if (name === 'link') {
      const rel = decodeAttribute(attributes.get('rel') ?? '')
        .toLowerCase()
        .split(/[\s]+/);
      const hreflang = attributes.get('hreflang');
      if (rel.includes('alternate') && hreflang !== undefined && out.length < max) out.push({ hreflang: decodeAttribute(hreflang).trim(), href: decodeAttribute(attributes.get('href') ?? '').trim() });
    } else if (name === 'base') {
      // The first `<base>` with an `href` is the document's; one without an `href` does not count.
      const href = attributes.get('href');
      if (baseHref === null && href !== undefined) baseHref = decodeAttribute(href).trim();
    } else if (RAW_TEXT.has(name)) {
      // Its text up to the matching end tag, case aside (`name` is one of `RAW_TEXT`'s).
      const endTag = new RegExp(`</${name}[\\s/>]`, 'ig');
      endTag.lastIndex = i;
      const end = endTag.exec(html);
      if (!end) break;
      i = end.index;
    }
  }
  return { links: out, baseHref };
}
