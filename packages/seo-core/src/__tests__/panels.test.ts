// Spec: specs/seo-sidebar.spec.ts (LINK_TYPE_FILTERS, LINK_REL_FILTERS, LINKS_CSV_COLUMNS, CSV_FORMULA_PREFIXES,
// IMAGE_FILTERS, SOCIAL_REMOTE_IMAGES), specs/seo-rules.spec.ts (IMAGE_OVERSIZE_FACTOR)
// Acceptance: specs/seo-panels.feature.md (Links, Images and Social helpers)
import { describe, expect, test } from 'vitest';
import { CSV_FORMULA_PREFIXES, LINKS_CSV_COLUMNS } from '@app/specs/seo-sidebar.spec';
import { altState, csvCell, filterImages, filterLinks, imageCounts, linkCounts, linksCsv, NO_LINK_FILTER, pageFacts, pageUrls, relFlags, socialPreview, type PageImage, type PageLink } from '../index';
import { page, socialTags, text } from './fixtures';

const link = (changes: Partial<PageLink> = {}): PageLink => ({ href: 'https://example.com/a', scheme: 'https:', rel: '', text: 'A page', kind: 'internal', target: null, ...changes });
const image = (changes: Partial<PageImage> = {}): PageImage => ({
  src: 'https://example.com/a.png',
  alt: text('An image'),
  width: '100',
  height: '50',
  loading: null,
  rendered: { width: 100, height: 50 },
  natural: { width: 100, height: 50 },
  inFirstViewport: false,
  cssSized: false,
  ...changes,
});

const LINKS = [
  link({ href: 'https://example.com/guides/', text: 'All guides' }),
  link({ href: 'https://other.org/Coffee', text: 'Coffee science', kind: 'external', rel: 'noopener NoFollow', target: '_blank' }),
  link({ href: 'https://ads.example.net/', text: 'Sponsor', kind: 'external', rel: 'sponsored' }),
  link({ href: 'https://example.com/forum/1', text: 'A reply', rel: 'ugc nofollow' }),
  link({ href: 'mailto:hello@example.com', scheme: 'mailto:', text: 'Email', kind: 'other' }),
];

describe('links', () => {
  test('link-rel-flags', () => {
    expect(relFlags(link({ rel: 'noopener NoFollow' }))).toEqual({ nofollow: true, sponsored: false, ugc: false });
    expect(relFlags(link({ rel: 'ugc  sponsored' }))).toEqual({ nofollow: false, sponsored: true, ugc: true });
    // Tokens, not substrings.
    expect(relFlags(link({ rel: 'nofollowed ugc-ish' }))).toEqual({ nofollow: false, sponsored: false, ugc: false });
  });

  test('link-filter-by-type-rel-and-query', () => {
    expect(filterLinks(LINKS, NO_LINK_FILTER)).toEqual(LINKS);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, type: 'external' }).map((l) => l.text)).toEqual(['Coffee science', 'Sponsor']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, type: 'other' }).map((l) => l.text)).toEqual(['Email']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, rel: 'nofollow' }).map((l) => l.text)).toEqual(['Coffee science', 'A reply']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, rel: 'sponsored' }).map((l) => l.text)).toEqual(['Sponsor']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, rel: 'ugc' }).map((l) => l.text)).toEqual(['A reply']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, rel: 'followed' }).map((l) => l.text)).toEqual(['All guides', 'Email']);
    // The query matches the href or the anchor text, ignoring case and surrounding spaces.
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, query: ' COFFEE ' }).map((l) => l.text)).toEqual(['Coffee science']);
    expect(filterLinks(LINKS, { ...NO_LINK_FILTER, query: 'example.com' }).map((l) => l.text)).toEqual(['All guides', 'A reply', 'Email']);
    expect(filterLinks(LINKS, { type: 'internal', rel: 'nofollow', query: 'forum' }).map((l) => l.text)).toEqual(['A reply']);
    expect(filterLinks(LINKS, { type: 'internal', rel: 'sponsored', query: '' })).toEqual([]);
  });

  test('link-counts', () => {
    expect(linkCounts(LINKS)).toEqual({ all: 5, internal: 2, external: 2, other: 1, nofollow: 2, sponsored: 1, ugc: 1, followed: 2 });
    expect(linkCounts([])).toEqual({ all: 0, internal: 0, external: 0, other: 0, nofollow: 0, sponsored: 0, ugc: 0, followed: 0 });
  });

  test('csv-header-and-columns', () => {
    const csv = linksCsv([LINKS[1]!, LINKS[0]!]);
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines).toEqual([LINKS_CSV_COLUMNS.join(','), 'https://other.org/Coffee,Coffee science,external,noopener NoFollow,yes,no,no,_blank', 'https://example.com/guides/,All guides,internal,,no,no,no,', '']);
    expect(linksCsv([])).toBe(`${LINKS_CSV_COLUMNS.join(',')}\r\n`);
  });

  test('csv-escapes-quotes-commas-newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
    expect(csvCell('')).toBe('');
    const row = linksCsv([link({ text: 'Hello, "world"\nagain' })]).split('\r\n')[1];
    expect(row).toBe('https://example.com/a,"Hello, ""world""\nagain",internal,,no,no,no,');
  });

  test('csv-guards-formulas', () => {
    for (const prefix of ['=', '+', '-', '@']) expect(CSV_FORMULA_PREFIXES).toContain(prefix);
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    // Only a leading character counts.
    expect(csvCell('a=b')).toBe('a=b');
    const row = linksCsv([link({ text: '=cmd|" /C calc"!A0', target: '@top' })]).split('\r\n')[1];
    expect(row).toBe(`https://example.com/a,"'=cmd|"" /C calc""!A0",internal,,no,no,no,'@top`);
  });
});

describe('images', () => {
  test('image-alt-state', () => {
    expect(altState(image({ alt: null }))).toBe('missing');
    expect(altState(image({ alt: text('') }))).toBe('decorative');
    expect(altState(image())).toBe('present');
  });

  test('image-filters', () => {
    const images = [
      image({ src: 'ok' }),
      image({ src: 'no-alt', alt: null }),
      image({ src: 'no-size', width: null }),
      image({ src: 'big', natural: { width: 1_000, height: 50 } }),
      image({ src: 'lazy-top', loading: 'lazy', inFirstViewport: true }),
      image({ src: 'lazy-below', loading: 'lazy' }),
    ];
    expect(filterImages(images, 'all').map((i) => i.src)).toEqual(images.map((i) => i.src));
    expect(filterImages(images, 'missing-alt').map((i) => i.src)).toEqual(['no-alt']);
    expect(filterImages(images, 'no-dimensions').map((i) => i.src)).toEqual(['no-size']);
    expect(filterImages(images, 'oversized').map((i) => i.src)).toEqual(['big']);
    expect(filterImages(images, 'lazy-first-viewport').map((i) => i.src)).toEqual(['lazy-top']);
    expect(imageCounts(images)).toEqual({ all: 6, 'missing-alt': 1, 'no-dimensions': 1, oversized: 1, 'lazy-first-viewport': 1 });
  });
});

describe('social', () => {
  test('social-preview-falls-back', () => {
    const full = socialPreview(pageFacts(page()));
    expect(full).toMatchObject({
      large: {
        title: { value: 'SEO basics: a practical guide', source: 'og' },
        description: { value: 'The handful of on-page fixes that make the biggest difference.', source: 'og' },
        image: { raw: 'https://example.com/img/share.png', resolved: 'https://example.com/img/share.png', source: 'og' },
      },
      // No twitter:title or twitter:image in the fixture: the summary card falls back to Open Graph.
      summary: { title: { value: 'SEO basics: a practical guide', source: 'og' }, image: { raw: 'https://example.com/img/share.png', source: 'og' } },
      imageSize: '1200 × 630',
      domain: 'example.com',
      siteName: 'Example Guides',
      card: 'summary_large_image',
    });
    // Each card has its own chain: the large card never reads Twitter tags.
    const both = socialPreview(
      pageFacts(page({ social: socialTags({ 'og:title': 'OG title', 'twitter:title': 'Twitter title', 'twitter:description': 'Twitter description', 'og:image': null, 'twitter:image': '/t.png', 'og:image:width': null }) })),
    );
    expect(both.large.title).toEqual({ value: 'OG title', source: 'og' });
    expect(both.large.description).toEqual({ value: 'The handful of on-page fixes that make the biggest difference.', source: 'og' });
    expect(both.large.image).toBeNull();
    expect(both.summary.title).toEqual({ value: 'Twitter title', source: 'twitter' });
    expect(both.summary.description).toEqual({ value: 'Twitter description', source: 'twitter' });
    expect(both.summary.image).toEqual({ raw: '/t.png', resolved: 'https://example.com/t.png', source: 'twitter' });
    expect(both.imageSize).toBeNull();
    // Without Open Graph either, both cards use the page.
    const pageOnly = socialPreview(pageFacts(page({ social: socialTags({ 'og:title': null, 'og:description': null }) })));
    expect(pageOnly.large.title).toEqual({ value: 'SEO basics: a practical guide for beginners', source: 'page' });
    expect(pageOnly.summary.title.source).toBe('page');
    expect(pageOnly.large.description.source).toBe('page');
    const bare = socialPreview(
      pageFacts(page({ titles: [], titleTotal: 0, metaDescriptions: [], metaDescriptionTotal: 0, ogUrl: null, url: 'https://www.example.org/x', social: socialTags(Object.fromEntries(Object.keys(socialTags()).map((k) => [k, null]))) })),
    );
    expect(bare).toMatchObject({ large: { title: { value: '', source: 'none' }, description: { source: 'none' }, image: null }, summary: { image: null }, domain: 'example.org', siteName: null, card: null });
  });

  test('page-urls-are-parsed-hrefs', () => {
    const facts = pageFacts(page({ social: socialTags({ 'og:image': ' /img/share.png ', 'twitter:image': 'HTTPS://Example.com/T.png' }) }));
    const urls = pageUrls(facts);
    // Social images are allowed only as their parsed href, never as written.
    expect(urls.has('https://example.com/img/share.png')).toBe(true);
    expect(urls.has(' /img/share.png ')).toBe(false);
    expect(urls.has('/img/share.png')).toBe(false);
    expect(urls.has('https://example.com/T.png')).toBe(true);
    expect(urls.has('HTTPS://Example.com/T.png')).toBe(false);
    // The page, its links and images.
    for (const url of ['https://example.com/guides/seo-basics', 'https://example.com/guides/', 'mailto:hello@example.com', 'https://example.com/img/crawler.png']) expect(urls.has(url), url).toBe(true);
    for (const url of urls) expect(new URL(url).href).toBe(url);
  });
});
