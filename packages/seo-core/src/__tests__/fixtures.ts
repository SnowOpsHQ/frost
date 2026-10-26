import type { CappedText, PageSnapshot } from '../types';

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
      },
      // Not rendered (no box): it needs no width and height.
      { src: 'https://example.com/img/divider.svg', alt: text(''), width: null, height: null, loading: null, rendered: null, natural: { width: 4000, height: 10 }, inFirstViewport: false },
    ],
    imageTotal: 2,
  };
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
