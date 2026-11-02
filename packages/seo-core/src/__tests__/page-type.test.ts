// Spec: specs/page-type.spec.ts (PAGE_TYPES, PAGE_TYPE_SIGNALS, PAGE_TYPE_SCHEMA_MAP, PAGE_TYPE_OG_MAP, PAGE_TYPE_PATH_HINTS,
// PAGE_TYPE_STRUCTURE, PAGE_TYPE_CONFIDENCE), specs/seo-rules.spec.ts (SEO_RULE_SPECS)
// Acceptance: specs/page-type.feature.md (Heuristic)
import { describe, expect, test } from 'vitest';
import { PAGE_TYPE_SIGNALS, PAGE_TYPE_STRUCTURE, PAGE_TYPES } from '@app/specs/page-type.spec';
import { SEO_RULE_SPECS } from '@app/specs/seo-rules.spec';
import { pageTypeOf, runAudit, type PageSnapshot } from '../index';
import { jsonLd, page, socialTags } from './fixtures';

/** A page saying nothing about its type: no structured data, no `og:type`, prose with a few links, at `path`. */
function plain(path: string, changes: Partial<PageSnapshot> = {}): PageSnapshot {
  const url = `https://example.com${path}`;
  return page({ url, canonicals: [{ href: url, resolved: url }], ogUrl: url, jsonLd: [], jsonLdTotal: 0, social: socialTags({ 'og:type': null }), ...changes });
}

const graph = (...types: string[]) => [jsonLd({ '@context': 'https://schema.org', '@graph': types.map((type, i) => ({ '@type': type, '@id': `#n${i}`, name: `Node ${i}` })) })];

/** `n` internal links. */
const internalLinks = (n: number): PageSnapshot['links'] =>
  Array.from({ length: n }, (_, i) => ({ href: `https://example.com/items/${i}`, scheme: 'https:', rel: '', text: `Item ${i}`, kind: 'internal' as const, target: null }));

/** A grid of `n` H3 entries under one H1. */
const grid = (n: number): PageSnapshot['headings'] => [{ level: 1, text: 'All items' }, ...Array.from({ length: n }, (_, i) => ({ level: 3, text: `Item ${i}` }))];
/** `n` entries under one H1, alternating H2 and H4. */
const mixed = (n: number): PageSnapshot['headings'] => [{ level: 1, text: 'All items' }, ...Array.from({ length: n }, (_, i) => ({ level: i % 2 === 0 ? 2 : 4, text: `Item ${i}` }))];

describe('page type heuristic', () => {
  test('schema-wins', () => {
    const post = pageTypeOf(plain('/2026/a-post', { jsonLd: graph('Organization', 'WebSite', 'BlogPosting'), social: socialTags({ 'og:type': 'article' }) }));
    expect(post.type).toBe('article');
    expect(post.confidence).toBe('high');
    expect(post.signals.map((s) => [s.signal, s.type])).toEqual([
      ['schema-type', 'article'],
      ['og-type', 'article'],
    ]);
    expect(post.signals[0]!.evidence).toBe('BlogPosting');

    // Structured data names a product; Open Graph says article: the product wins, and frost is unsure.
    const product = pageTypeOf(plain('/2026/trail-shoe', { jsonLd: graph('Product'), social: socialTags({ 'og:type': 'article' }) }));
    expect(product.type).toBe('product');
    expect(product.confidence).toBe('unsure');

    // The first mapped top-level entity decides; unmapped types (Organization, WebSite) say nothing.
    expect(pageTypeOf(plain('/x', { jsonLd: graph('WebSite', 'ContactPage', 'Product') })).signals).toEqual([{ signal: 'schema-type', type: 'contact', evidence: 'ContactPage' }]);
    expect(pageTypeOf(plain('/x', { jsonLd: graph('Organization', 'WebSite', 'Person') })).signals).toEqual([]);
    // A full schema.org IRI is the same type; a non-schema.org type is not.
    expect(pageTypeOf(plain('/x', { jsonLd: [jsonLd({ '@type': 'https://schema.org/TechArticle', name: 'API' })] })).type).toBe('documentation');
    expect(pageTypeOf(plain('/x', { jsonLd: [jsonLd({ '@type': 'https://example.org/Article', name: 'A' })] })).signals).toEqual([]);
    // A prototype key is not a type.
    expect(pageTypeOf(plain('/x', { social: socialTags({ 'og:type': 'constructor' }) })).signals).toEqual([]);
    // og:type is trimmed and lowercased; `website` says nothing.
    expect(pageTypeOf(plain('/x', { social: socialTags({ 'og:type': '  Product ' }) })).signals).toEqual([{ signal: 'og-type', type: 'product', evidence: 'product' }]);
    expect(pageTypeOf(plain('/x', { social: socialTags({ 'og:type': 'website' }) })).signals).toEqual([]);
  });

  test('path-hint-only-is-low', () => {
    const post = pageTypeOf(plain('/blog/how-to-brew-tea'));
    expect(post).toEqual({ type: 'article', confidence: 'low', signals: [{ signal: 'url-path', type: 'article', evidence: '/blog/…' }] });
    // The blog's own index is not a post.
    expect(pageTypeOf(plain('/blog/')).signals).toEqual([]);
    expect(pageTypeOf(plain('/blog')).signals).toEqual([]);
    const cases: [string, string][] = [
      ['/docs/getting-started', 'documentation'],
      ['/en/docs/api/auth.html', 'documentation'],
      ['/products/trail-shoe', 'product'],
      ['/contact', 'contact'],
      ['/en/Contact-Us.html', 'contact'],
      ['/pricing', 'landing'],
      ['/category/shoes', 'listing'],
      ['/news/2026/11/frost', 'article'],
      // The deepest matching segment decides: a tag page of the blog is a listing.
      ['/blog/tag/seo', 'listing'],
    ];
    for (const [path, type] of cases) {
      const result = pageTypeOf(plain(path));
      expect([path, result.type, result.confidence]).toEqual([path, type, 'low']);
    }
    expect(pageTypeOf(plain('/about-us')).signals).toEqual([]);
  });

  test('conflict-is-unsure', () => {
    // A path hint and Open Graph disagree: Open Graph (higher priority) names the type; unsure.
    const disagree = pageTypeOf(plain('/products/notes', { social: socialTags({ 'og:type': 'article' }) }));
    expect(disagree.type).toBe('article');
    expect(disagree.confidence).toBe('unsure');
    expect(disagree.signals.map((s) => s.type)).toEqual(['article', 'product']);
    // No signal at all: other, unsure.
    expect(pageTypeOf(plain('/about-us'))).toEqual({ type: 'other', confidence: 'unsure', signals: [] });
    // Two signals agreeing: high.
    expect(pageTypeOf(plain('/products/shoe', { jsonLd: graph('Product') })).confidence).toBe('high');
    expect(PAGE_TYPES).toContain('other');
  });

  test('home-by-root-path', () => {
    // The root path is an ordinary url-path signal: alone, `home` at `low`.
    expect(pageTypeOf(plain('/'))).toEqual({ type: 'home', confidence: 'low', signals: [{ signal: 'url-path', type: 'home', evidence: '/' }] });
    // A front page marked CollectionPage conflicts with the root: structured data names the type, unsure, both shown.
    const marked = pageTypeOf(plain('/', { jsonLd: graph('WebSite', 'CollectionPage') }));
    expect(marked).toEqual({
      type: 'listing',
      confidence: 'unsure',
      signals: [
        { signal: 'schema-type', type: 'listing', evidence: 'CollectionPage' },
        { signal: 'url-path', type: 'home', evidence: '/' },
      ],
    });
    // A listing structure on the root conflicts too (path before structure: home, unsure).
    const grid8 = pageTypeOf(plain('/', { headings: grid(8), headingTotal: 9, links: internalLinks(40), linkTotal: 40, wordCount: 300 }));
    expect(grid8.type).toBe('home');
    expect(grid8.confidence).toBe('unsure');
    expect(grid8.signals.map((s) => [s.signal, s.type])).toEqual([
      ['url-path', 'home'],
      ['structure', 'listing'],
    ]);
    // A query on the root is not the home page (`/?p=1` is a post, `/?s=tea` a search).
    expect(pageTypeOf(plain('/?p=1')).signals).toEqual([]);
  });

  test('listing-by-repeated-headings-and-links', () => {
    const { minSameLevelHeadings, minInternalLinks, maxWordsPerHeading } = PAGE_TYPE_STRUCTURE.listing;
    const headingTotal = minSameLevelHeadings + 1;
    const listing = pageTypeOf(plain('/shoes', { headings: grid(minSameLevelHeadings), headingTotal, links: internalLinks(minInternalLinks), linkTotal: minInternalLinks, wordCount: maxWordsPerHeading * headingTotal }));
    expect(listing).toEqual({
      type: 'listing',
      confidence: 'low',
      signals: [{ signal: 'structure', type: 'listing', evidence: `${minSameLevelHeadings} H3 headings, ${minInternalLinks} internal links, ${maxWordsPerHeading} words per heading` }],
    });
    // One short of each threshold: no structure signal.
    expect(pageTypeOf(plain('/shoes', { headings: grid(minSameLevelHeadings - 1), headingTotal: minSameLevelHeadings, links: internalLinks(minInternalLinks), linkTotal: minInternalLinks, wordCount: 100 })).signals).toEqual([]);
    expect(pageTypeOf(plain('/shoes', { headings: grid(minSameLevelHeadings), headingTotal, links: internalLinks(minInternalLinks - 1), linkTotal: minInternalLinks - 1, wordCount: 100 })).signals).toEqual([]);
    // Prose: many words per heading.
    expect(pageTypeOf(plain('/shoes', { headings: grid(minSameLevelHeadings), headingTotal, links: internalLinks(minInternalLinks), linkTotal: minInternalLinks, wordCount: (maxWordsPerHeading + 1) * headingTotal })).signals).toEqual([]);
    // Mixed levels (H2 and H4 alternating): no level has enough.
    expect(pageTypeOf(plain('/shoes', { headings: mixed(minSameLevelHeadings + 2), headingTotal: minSameLevelHeadings + 3, links: internalLinks(minInternalLinks), linkTotal: minInternalLinks, wordCount: 100 })).signals).toEqual([]);
    // External links do not count.
    const external = internalLinks(minInternalLinks).map((link) => ({ ...link, kind: 'external' as const }));
    expect(pageTypeOf(plain('/shoes', { headings: grid(minSameLevelHeadings), headingTotal, links: external, linkTotal: minInternalLinks, wordCount: 100 })).signals).toEqual([]);
    // H1s are not entries.
    const h1s = Array.from({ length: minSameLevelHeadings }, (_, i) => ({ level: 1, text: `Title ${i}` }));
    expect(pageTypeOf(plain('/shoes', { headings: h1s, headingTotal: minSameLevelHeadings, links: internalLinks(minInternalLinks), linkTotal: minInternalLinks, wordCount: 100 })).signals).toEqual([]);
  });

  test('page-type-in-the-audit-only', () => {
    // In the snapshot-derived audit, and no rule: the clean article page is an article, and its findings and score are unchanged by it.
    const audit = runAudit(page());
    expect(audit.pageType).toEqual(pageTypeOf(page()));
    expect(audit.pageType.type).toBe('article');
    expect(SEO_RULE_SPECS.some((rule) => /page.?type/i.test(rule.id))).toBe(false);
    expect(PAGE_TYPE_SIGNALS).toEqual(['schema-type', 'og-type', 'url-path', 'structure']);
  });
});
