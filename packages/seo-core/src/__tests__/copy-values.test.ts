// Spec: specs/command-palette.spec.ts (COPY_VALUE_KEYS: what each key writes; COPY_VALUE_MAX_CHARS),
// specs/devtools.spec.ts (SECRET_HEADERS, MASKED_VALUE)
// Acceptance: specs/command-palette.feature.md (Copy values)
import { describe, expect, test } from 'vitest';
import { COPY_VALUE_KEYS, COPY_VALUE_MAX_CHARS, type CopyValueKey } from '@app/specs/command-palette.spec';
import { MASKED_VALUE } from '@app/specs/devtools.spec';
import { copyValueOf, escapeHtml, formatJson, runAudit } from '../index';
import type { ResponseMeta, SeoAudit } from '../types';
import { header, jsonLd, okResponse, okRobots, page, PAGE_URL, socialTags, text } from './fixtures';

/** The seven keys Phase 2.5 shipped (Phase 11 appends the rest). */
const FIRST_KEYS = COPY_VALUE_KEYS.slice(0, 7);
/** The keys Phase 11 Task 1 appended (Decision 2). */
const APPENDED: readonly CopyValueKey[] = [
  'clean-url',
  'origin',
  'root-domain',
  'title-with-url',
  'h1-with-url',
  'headings-outline',
  'og-tags',
  'twitter-tags',
  'word-count',
  'canonical-html',
  'hreflang-html',
  'x-robots-tag',
  'response-headers',
  'sitemaps',
  'all-schema-json',
  'internal-urls',
  'external-urls',
];

const clean = (): SeoAudit => runAudit(page());

describe('copy values', () => {
  test('copy-value-of-each-key', () => {
    const audit = runAudit(page({ metaRobots: [{ name: 'robots', content: 'index, follow' }, { name: 'googlebot', content: 'noarchive' }] }));
    const values = Object.fromEntries(FIRST_KEYS.map((key) => [key, copyValueOf(audit, key)]));
    expect(values).toEqual({
      url: PAGE_URL,
      title: 'SEO basics: a practical guide for beginners',
      'meta-description': 'Learn how search engines read your pages, and the handful of on-page fixes that make the biggest difference.',
      canonical: PAGE_URL,
      h1: 'SEO basics',
      'robots-meta': 'robots: index, follow · googlebot: noarchive',
      'status-code': '200',
    });
    // The first H1 that has text, wherever it is in the outline.
    const later = runAudit(page({ headings: [{ level: 2, text: 'Intro' }, { level: 1, text: '' }, { level: 1, text: 'The real one' }], headingTotal: 3 }));
    expect(copyValueOf(later, 'h1')).toBe('The real one');
    // Phase 11 appended exactly the seventeen keys of Decision 2, after the first seven.
    expect(COPY_VALUE_KEYS.slice(7)).toEqual(APPENDED);
  });

  test('copy-value-missing-is-null', () => {
    const bare = runAudit(
      page({
        titles: [],
        titleTotal: 0,
        metaDescriptions: [text('')],
        metaDescriptionTotal: 1,
        metaRobots: [],
        headings: [{ level: 2, text: 'Only a section' }],
        headingTotal: 1,
        canonicals: [],
        canonicalTotal: 0,
        response: null,
      }),
    );
    for (const key of ['title', 'meta-description', 'h1', 'robots-meta', 'status-code', 'canonical'] as const) expect(copyValueOf(bare, key), key).toBeNull();
    expect(copyValueOf(bare, 'url')).toBe(PAGE_URL);
    // No status recorded (an in-page navigation): nothing.
    expect(copyValueOf(runAudit(page({ response: okResponse({ status: null, source: 'in-page', headersAvailable: false, headers: [] }) })), 'status-code')).toBeNull();
    // The HTTP Link canonical when the HTML has none (resolved against the page).
    const fromHeader = runAudit(page({ canonicals: [], canonicalTotal: 0, response: okResponse({ headers: [header('link', '</guides/seo>; rel="canonical"')] }) }));
    expect(copyValueOf(fromHeader, 'canonical')).toBe('https://example.com/guides/seo');
  });

  // ---- Phase 11 Task 1: one test per appended key (Decision 2) -------------------------------

  test('copy-value-clean-url', () => {
    const audit = runAudit(page({ url: 'https://user:secret@example.com/guides/seo?ref=nav&utm_source=x#top' }));
    expect(copyValueOf(audit, 'clean-url')).toBe('https://example.com/guides/seo');
    expect(copyValueOf(clean(), 'clean-url')).toBe(PAGE_URL);
  });

  test('copy-value-origin', () => {
    expect(copyValueOf(clean(), 'origin')).toBe('https://example.com');
    expect(copyValueOf(runAudit(page({ url: 'http://shop.example.com:8080/a?b' })), 'origin')).toBe('http://shop.example.com:8080');
  });

  test('copy-value-root-domain', () => {
    expect(copyValueOf(clean(), 'root-domain')).toBe('example.com');
    expect(copyValueOf(runAudit(page({ url: 'https://www.shop.example.co.uk/a' })), 'root-domain')).toBe('example.co.uk');
    expect(copyValueOf(runAudit(page({ url: 'http://93.184.216.34/a' })), 'root-domain')).toBe('93.184.216.34');
  });

  test('copy-value-title-with-url', () => {
    expect(copyValueOf(clean(), 'title-with-url')).toBe(`SEO basics: a practical guide for beginners\n${PAGE_URL}`);
  });

  test('copy-value-h1-with-url', () => {
    expect(copyValueOf(clean(), 'h1-with-url')).toBe(`SEO basics\n${PAGE_URL}`);
  });

  test('copy-value-headings-outline', () => {
    // Indented two spaces per level below 1, one heading per line, in document order.
    expect(copyValueOf(clean(), 'headings-outline')).toBe(['H1: SEO basics', '  H2: How crawlers read a page', '    H3: Titles and descriptions', '    H3: Headings', '  H2: Next steps'].join('\n'));
    const deep = runAudit(page({ headings: [{ level: 6, text: 'Deep' }, { level: 2, text: '' }], headingTotal: 2 }));
    expect(copyValueOf(deep, 'headings-outline')).toBe(`${' '.repeat(10)}H6: Deep\n  H2: `);
  });

  test('copy-value-og-tags', () => {
    expect(copyValueOf(clean(), 'og-tags')).toBe(
      [
        'og:title: SEO basics: a practical guide',
        'og:description: The handful of on-page fixes that make the biggest difference.',
        'og:image: https://example.com/img/share.png',
        'og:image:width: 1200',
        'og:image:height: 630',
        'og:type: article',
        'og:site_name: Example Guides',
        `og:url: ${PAGE_URL}`,
      ].join('\n'),
    );
  });

  test('copy-value-twitter-tags', () => {
    expect(copyValueOf(clean(), 'twitter-tags')).toBe('twitter:card: summary_large_image\ntwitter:site: @example');
    const all = runAudit(page({ social: socialTags({ 'twitter:title': 'T', 'twitter:description': 'D', 'twitter:image': 'https://example.com/t.png' }) }));
    expect(copyValueOf(all, 'twitter-tags')).toBe('twitter:card: summary_large_image\ntwitter:title: T\ntwitter:description: D\ntwitter:image: https://example.com/t.png\ntwitter:site: @example');
  });

  test('copy-value-word-count', () => {
    expect(copyValueOf(clean(), 'word-count')).toBe('850');
    expect(copyValueOf(runAudit(page({ wordCount: 0 })), 'word-count')).toBe('0');
  });

  test('copy-value-canonical-html', () => {
    expect(copyValueOf(clean(), 'canonical-html')).toBe(`<link rel="canonical" href="${PAGE_URL}">`);
    // The canonical search engines read: the header's when the HTML has none.
    const fromHeader = runAudit(page({ canonicals: [], canonicalTotal: 0, response: okResponse({ headers: [header('link', '</guides/seo>; rel="canonical"')] }) }));
    expect(copyValueOf(fromHeader, 'canonical-html')).toBe('<link rel="canonical" href="https://example.com/guides/seo">');
  });

  test('copy-value-hreflang-html', () => {
    const audit = runAudit(
      page({
        hreflang: [
          { hreflang: 'en', href: '/guides/seo-basics', resolved: PAGE_URL },
          { hreflang: 'x-default', href: 'https://example.com/', resolved: 'https://example.com/' },
        ],
        hreflangTotal: 2,
      }),
    );
    expect(copyValueOf(audit, 'hreflang-html')).toBe(
      [`<link rel="alternate" hreflang="en" href="${PAGE_URL}">`, '<link rel="alternate" hreflang="x-default" href="https://example.com/">'].join('\n'),
    );
  });

  test('copy-value-x-robots-tag', () => {
    const audit = runAudit(page({ response: okResponse({ headers: [header('x-robots-tag', 'noarchive'), header('x-robots-tag', 'googlebot: nosnippet')] }) }));
    expect(copyValueOf(audit, 'x-robots-tag')).toBe('noarchive\ngooglebot: nosnippet');
  });

  test('copy-value-response-headers', () => {
    const headers = okResponse().headers;
    expect(copyValueOf(clean(), 'response-headers')).toBe(headers.map((h) => `${h.name}: ${h.value}`).join('\n'));
  });

  test('copy-value-sitemaps', () => {
    expect(copyValueOf(clean(), 'sitemaps')).toBe('https://example.com/sitemap.xml');
    const two = runAudit(page({ robots: okRobots('User-agent: *\nDisallow:\nSitemap: /a.xml\nSitemap: https://cdn.example.net/b.xml\n') }));
    expect(copyValueOf(two, 'sitemaps')).toBe('https://example.com/a.xml\nhttps://cdn.example.net/b.xml');
  });

  test('copy-value-all-schema-json', () => {
    const audit = clean();
    const only = audit.schema.blocks[0]!;
    expect(copyValueOf(audit, 'all-schema-json')).toBe(formatJson(only.text).text);
    // Each block with text: pretty when it parsed, as kept otherwise; a blank line between.
    const broken = '{"@type": "Thing",';
    const two = runAudit(page({ jsonLd: [jsonLd({ '@context': 'https://schema.org', '@type': 'Thing', name: 'A' }), jsonLd(broken)], jsonLdTotal: 2 }));
    expect(copyValueOf(two, 'all-schema-json')).toBe(`${formatJson(two.schema.blocks[0]!.text).text}\n\n${broken}`);
  });

  test('copy-value-internal-urls', () => {
    const links = [
      { href: 'https://example.com/a', scheme: 'https:', rel: '', text: 'A', kind: 'internal', target: null },
      { href: 'https://example.com/b', scheme: 'https:', rel: 'nofollow', text: 'B', kind: 'internal', target: null },
      { href: 'https://example.com/a', scheme: 'https:', rel: '', text: 'A again', kind: 'internal', target: null },
      { href: 'https://other.example.net/', scheme: 'https:', rel: '', text: 'O', kind: 'external', target: null },
    ] as const;
    const audit = runAudit(page({ links: [...links], linkTotal: links.length }));
    // Distinct, in document order.
    expect(copyValueOf(audit, 'internal-urls')).toBe('https://example.com/a\nhttps://example.com/b');
    expect(copyValueOf(clean(), 'internal-urls')).toBe('https://example.com/guides/');
  });

  test('copy-value-external-urls', () => {
    expect(copyValueOf(clean(), 'external-urls')).toBe('https://developer.mozilla.org/');
  });

  test('copy-value-absent-is-null', () => {
    const bare = runAudit(
      page({
        titles: [],
        titleTotal: 0,
        headings: [],
        headingTotal: 0,
        canonicals: [],
        canonicalTotal: 0,
        ogUrl: null,
        social: socialTags({ 'og:title': null, 'og:description': null, 'og:image': null, 'og:image:width': null, 'og:image:height': null, 'og:type': null, 'og:site_name': null, 'twitter:card': null, 'twitter:site': null }),
        hreflang: [],
        hreflangTotal: 0,
        response: null,
        robots: null,
        jsonLd: [],
        jsonLdTotal: 0,
        links: [{ href: 'mailto:a@example.com', scheme: 'mailto:', rel: '', text: 'Mail', kind: 'other', target: null }],
        linkTotal: 1,
      }),
    );
    for (const key of ['title-with-url', 'h1-with-url', 'headings-outline', 'og-tags', 'twitter-tags', 'canonical-html', 'hreflang-html', 'x-robots-tag', 'response-headers', 'sitemaps', 'all-schema-json', 'internal-urls', 'external-urls'] as const) {
      expect(copyValueOf(bare, key), key).toBeNull();
    }
    // The URL's parts are always there.
    for (const key of ['clean-url', 'origin', 'root-domain', 'word-count'] as const) expect(copyValueOf(bare, key), key).not.toBeNull();
    // A response with no headers, a robots.txt with no Sitemap line, an empty JSON-LD block: nothing.
    const empty = runAudit(page({ response: okResponse({ headers: [] }), robots: okRobots('User-agent: *\nDisallow:\n'), jsonLd: [jsonLd('', 0)], jsonLdTotal: 1 }));
    for (const key of ['x-robots-tag', 'response-headers', 'sitemaps', 'all-schema-json'] as const) expect(copyValueOf(empty, key), key).toBeNull();
  });

  test('canonical-html-escaped', () => {
    const hostile = 'https://example.com/a?b="c"&d=<e>\u202E\'';
    const audit = runAudit(page({ canonicals: [{ href: hostile, resolved: hostile }], canonicalTotal: 1 }));
    const value = copyValueOf(audit, 'canonical-html')!;
    expect(value).toBe(`<link rel="canonical" href="${escapeHtml(audit.indexability.canonical.effective!)}">`);
    expect(value).not.toContain('\u202E');
    // Only the tag's own markup is bare: the value has no raw quote, angle bracket or bidi control.
    const inner = value.slice('<link rel="canonical" href="'.length, -'">'.length);
    expect(inner).not.toMatch(/[<>"'\u202E]/);
    expect(inner).toContain('&amp;');
    const hreflang = runAudit(page({ hreflang: [{ hreflang: 'en"><script>', href: hostile, resolved: hostile }], hreflangTotal: 1 }));
    const tag = copyValueOf(hreflang, 'hreflang-html')!;
    const entry = hreflang.indexability.hreflang.entries[0]!;
    expect(tag).toBe(`<link rel="alternate" hreflang="${escapeHtml('en"><script>')}" href="${escapeHtml(entry.resolved ?? entry.href)}">`);
    expect(tag).not.toContain('<script>');
  });

  test('response-headers-masked', () => {
    // Main keeps an allowlist that never holds a secret header; masked anyway, should one ever be kept.
    const headers = [header('content-type', 'text/html'), { name: 'set-cookie', value: 'session=abc123' }, { name: 'authorization', value: 'Bearer xyz' }] as unknown as ResponseMeta['headers'];
    const audit = runAudit(page({ response: okResponse({ headers }) }));
    const value = copyValueOf(audit, 'response-headers')!;
    expect(value).toBe(`content-type: text/html\nset-cookie: ${MASKED_VALUE}\nauthorization: ${MASKED_VALUE}`);
    expect(value).not.toContain('abc123');
    expect(value).not.toContain('xyz');
    // A value past COPY_VALUE_MAX_CHARS is cut to it, never inside a surrogate pair: 626 code units
    // per line (a 25-unit prefix, 300 emoji, a line end), so the cap falls inside an emoji.
    const many = Array.from({ length: 1_700 }, (_, i) => ({ href: `https://example.com/${String(i).padStart(4, '0')}/${'😀'.repeat(300)}`, scheme: 'https:', rel: '', text: '', kind: 'internal' as const, target: null }));
    const big = runAudit(page({ links: many, linkTotal: many.length }));
    const urls = copyValueOf(big, 'internal-urls')!;
    expect(urls.length).toBe(COPY_VALUE_MAX_CHARS - 1);
    expect(urls.at(-1)).not.toMatch(/[\uD800-\uDBFF]/);
    expect(urls.startsWith(many[0]!.href)).toBe(true);
  });
});
