import type { CappedText, PageSnapshot, ResponseMeta, RobotsFetch } from '../types';

// Snapshot fixtures for the rule tests (`seo-rules.feature.md`): a clean page that passes every
// rule, and `page(...)` to change it the way a scenario says.

/** A measured text as the extractor reports it: the text and its length in code points. */
export function text(value: string, length = [...value].length): CappedText {
  return { text: value, length };
}

/** `n` characters of `x`. */
export function chars(n: number, fill = 'x'): string {
  return fill.repeat(n);
}

export const PAGE_URL = 'https://example.com/guides/seo-basics';

export function cleanSnapshot(): PageSnapshot {
  return {
    url: PAGE_URL,
    extractedAt: 1_760_000_000_000,
    durationMs: 12,
    lang: 'en',
    titles: [text('SEO basics: a practical guide for beginners')],
    titleTotal: 1,
    metaDescriptions: [text('Learn how search engines read your pages, and the handful of on-page fixes that make the biggest difference.')],
    metaDescriptionTotal: 1,
    metaRobots: [{ name: 'robots', content: 'index, follow' }],
    canonicals: [{ href: PAGE_URL, resolved: PAGE_URL }],
    canonicalTotal: 1,
    ogUrl: PAGE_URL,
    social: socialTags(),
    viewport: 'width=device-width, initial-scale=1',
    headings: [
      { level: 1, text: 'SEO basics' },
      { level: 2, text: 'How crawlers read a page' },
      { level: 3, text: 'Titles and descriptions' },
      { level: 3, text: 'Headings' },
      { level: 2, text: 'Next steps' },
    ],
    headingTotal: 5,
    wordCount: 850,
    textTruncated: false,
    partial: false,
    links: [
      { href: 'https://example.com/guides/', scheme: 'https:', rel: '', text: 'All guides', kind: 'internal', target: null },
      { href: 'https://developer.mozilla.org/', scheme: 'https:', rel: 'noopener', text: 'MDN', kind: 'external', target: '_blank' },
      { href: 'mailto:hello@example.com', scheme: 'mailto:', rel: '', text: 'Email us', kind: 'other', target: null },
    ],
    linkTotal: 3,
    images: [
      {
        src: 'https://example.com/img/crawler.png',
        alt: text('A crawler reading a page'),
        width: '640',
        height: '360',
        loading: 'lazy',
        rendered: { width: 640, height: 360 },
        natural: { width: 1280, height: 720 },
        inFirstViewport: false,
        cssSized: false,
      },
      // Not rendered (no box): it needs no width and height.
      { src: 'https://example.com/img/divider.svg', alt: text(''), width: null, height: null, loading: null, rendered: null, natural: { width: 4000, height: 10 }, inFirstViewport: false, cssSized: false },
    ],
    imageTotal: 2,
    jsonLd: [jsonLd(CLEAN_GRAPH)],
    jsonLdTotal: 1,
    microdata: [],
    microdataTotal: 0,
    rdfa: [],
    rdfaTotal: 0,
    hreflang: [],
    hreflangTotal: 0,
    response: okResponse(),
    robots: okRobots(),
  };
}

/** The page's response as main records it from the network: 200, a couple of headers, no redirects (`changes` override). */
export function okResponse(changes: Partial<ResponseMeta> = {}): ResponseMeta {
  return {
    url: PAGE_URL,
    source: 'network',
    status: 200,
    headersAvailable: true,
    headers: [
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'cache-control', value: 'max-age=600' },
    ],
    redirects: [],
    redirectTotal: 0,
    ...changes,
  };
}

/** The clean site's robots.txt: one group for every crawler, a private area and a sitemap. */
export const CLEAN_ROBOTS_TXT = 'User-agent: *\nDisallow: /private/\n\nSitemap: https://example.com/sitemap.xml\n';

/** A robots.txt fetch that answered `text` with 200 (`changes` override). */
export function okRobots(text = CLEAN_ROBOTS_TXT, changes: Partial<RobotsFetch> = {}): RobotsFetch {
  return { url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, text, bytes: text.length, truncated: false, ...changes };
}

/** A response header kept by main. */
export function header(name: ResponseMeta['headers'][number]['name'], value: string): ResponseMeta['headers'][number] {
  return { name, value };
}

/** A JSON-LD block as the extractor keeps it: `value` serialised (or a string as written), whole. */
export function jsonLd(value: unknown, length?: number): PageSnapshot['jsonLd'][number] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text, length: length ?? text.length };
}

/** The clean page's structured data: an organisation, its website and the article, with every recommended property. */
export const CLEAN_GRAPH = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', '@id': 'https://example.com/#org', name: 'Example Guides', url: 'https://example.com/', logo: 'https://example.com/logo.png', sameAs: ['https://social.example/example-guides'] },
    { '@type': 'WebSite', '@id': 'https://example.com/#site', name: 'Example Guides', url: 'https://example.com/', publisher: { '@id': 'https://example.com/#org' } },
    {
      '@type': 'Article',
      headline: 'SEO basics: a practical guide',
      image: 'https://example.com/img/share.png',
      author: { '@type': 'Person', name: 'Ada Example' },
      datePublished: '2025-01-05',
      dateModified: '2025-02-01T10:00:00Z',
      publisher: { '@id': 'https://example.com/#org' },
    },
  ],
};

/** The clean page with only these JSON-LD blocks (and no markup) as its structured data. */
export function withJsonLd(...blocks: unknown[]): PageSnapshot {
  return page({ jsonLd: blocks.map((block) => jsonLd(block)), jsonLdTotal: blocks.length });
}

/** A markup item (`MarkupItemSchema`). */
export function item(types: string[], properties: PageSnapshot['microdata'][number]['properties'], changes: Partial<PageSnapshot['microdata'][number]> = {}): PageSnapshot['microdata'][number] {
  return { types, id: null, vocab: null, properties, ...changes };
}

/** Every social tag set, as a well-shared page has them (`changes` override). */
export function socialTags(changes: Partial<PageSnapshot['social']> = {}): PageSnapshot['social'] {
  return {
    'og:title': 'SEO basics: a practical guide',
    'og:description': 'The handful of on-page fixes that make the biggest difference.',
    'og:image': 'https://example.com/img/share.png',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:type': 'article',
    'og:site_name': 'Example Guides',
    'twitter:card': 'summary_large_image',
    'twitter:title': null,
    'twitter:description': null,
    'twitter:image': null,
    'twitter:site': '@example',
    ...changes,
  };
}

/** Robots metas: `robots('noindex')` is the generic tag, `robots('noindex', 'googlebot')` a crawler's. */
export function robots(content: string, name: PageSnapshot['metaRobots'][number]['name'] = 'robots'): PageSnapshot['metaRobots'][number] {
  return { name, content };
}

/** The clean snapshot with `changes` applied. */
export function page(changes: Partial<PageSnapshot> = {}): PageSnapshot {
  return { ...cleanSnapshot(), ...changes };
}
