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
    metaRobots: ['index, follow'],
    canonicals: [{ href: PAGE_URL, resolved: PAGE_URL }],
    canonicalTotal: 1,
    ogUrl: PAGE_URL,
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
    links: [
      { href: 'https://example.com/guides/', scheme: 'https:', rel: '', text: 'All guides', kind: 'internal' },
      { href: 'https://developer.mozilla.org/', scheme: 'https:', rel: 'noopener', text: 'MDN', kind: 'external' },
      { href: 'mailto:hello@example.com', scheme: 'mailto:', rel: '', text: 'Email us', kind: 'other' },
    ],
    linkTotal: 3,
    images: [
      { src: 'https://example.com/img/crawler.png', alt: text('A crawler reading a page'), width: '640', height: '360', loading: 'lazy' },
      { src: 'https://example.com/img/divider.svg', alt: text(''), width: null, height: null, loading: null },
    ],
    imageTotal: 2,
  };
}

/** The clean snapshot with `changes` applied. */
export function page(changes: Partial<PageSnapshot> = {}): PageSnapshot {
  return { ...cleanSnapshot(), ...changes };
}
