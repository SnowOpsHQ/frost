// Spec: specs/seo-content.spec.ts (SERP_PREVIEW_VARIANTS, SERP_PREVIEW_LIMITS, SERP_PREVIEW_BUDGETS_PX,
// SERP_SITE_NAME_SOURCES, SERP_BREADCRUMB_SOURCES, SERP_DATE_SOURCES, SNIPPET_JSONLD_SOURCES, SUGGESTED_JSONLD_SHAPE),
// specs/seo-limits.spec.ts (SOCIAL_TAGS: article times)
// Acceptance: specs/seo-content.feature.md (Result preview facts)
import { describe, expect, test } from 'vitest';
import { SCHEMA_PARSE_LIMITS } from '@app/specs/schema-types.spec';
import { SERP_PREVIEW_BUDGETS_PX, SERP_PREVIEW_LIMITS, SNIPPET_ELLIPSIS, SUGGESTED_JSONLD_SHAPE } from '@app/specs/seo-content.spec';
import { previewJsonLdBlocks, runAudit, serpPreview, suggestedJsonLd, textWidth } from '../index';
import type { PageSnapshot } from '../types';
import { page, socialTags, withJsonLd } from './fixtures';

const CTX = 'https://schema.org';

/** The clean page with only these JSON-LD blocks and these social tags. */
function audit(blocks: unknown[], social: Parameters<typeof socialTags>[0] = {}, url?: string, changes: Partial<PageSnapshot> = {}) {
  const base = withJsonLd(...blocks);
  return runAudit({ ...base, social: socialTags(social), ...(url ? { url } : {}), ...changes });
}

const trail = (...names: string[]) => ({
  '@context': CTX,
  '@type': 'BreadcrumbList',
  itemListElement: names.map((name, i) => ({ '@type': 'ListItem', position: i + 1, name, item: `https://example.com/${i}` })),
});

describe('result preview facts', () => {
  test('site-name-prefers-website-schema', () => {
    const facts = serpPreview(audit([{ '@context': CTX, '@type': 'WebSite', name: 'Schema Site', url: 'https://example.com/' }], { 'og:site_name': 'OG Site' }));
    expect(facts.siteName).toMatchObject({ text: 'Schema Site', source: 'website-schema', monogram: 'S' });
    expect(facts.siteName.shown.truncated).toBe(false);
    // A nested or later WebSite still counts; the override wins over both.
    expect(serpPreview(audit([{ '@context': CTX, '@type': 'WebSite', name: 'Schema Site' }], { 'og:site_name': 'OG Site' }), { siteName: '  my site  ' }).siteName).toMatchObject({ text: 'my site', source: 'override', monogram: 'M' });
    // Cut at maxSiteNameChars code points, ellipsis included.
    const longName = serpPreview(audit([{ '@context': CTX, '@type': 'WebSite', name: 'é'.repeat(80) }])).siteName;
    expect([...longName.text].length).toBe(SERP_PREVIEW_LIMITS.maxSiteNameChars);
    expect(longName.text.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
    // The name as its source holds it, for a suggested JSON-LD.
    expect(longName.name).toBe('é'.repeat(80));
    // A WebSite with a blank name does not count.
    expect(serpPreview(audit([{ '@context': CTX, '@type': 'WebSite', name: '   ' }], { 'og:site_name': 'OG Site' })).siteName.source).toBe('og-site-name');
  });

  test('site-name-falls-back-to-og-then-host', () => {
    expect(serpPreview(audit([], { 'og:site_name': 'OG Site' })).siteName).toMatchObject({ text: 'OG Site', source: 'og-site-name' });
    const host = serpPreview(audit([], { 'og:site_name': null }, 'https://www.Example.org/a'));
    expect(host.siteName).toMatchObject({ text: 'example.org', source: 'host', monogram: 'E' });
    expect(host.breadcrumb.host).toBe('www.example.org');
    // A site name with no letter or digit still has a drawn mark.
    expect(serpPreview(audit([], { 'og:site_name': '— ★ —' })).siteName.monogram).toBe('•');
  });

  test('breadcrumb-from-breadcrumblist', () => {
    // Positions out of order, one ListItem by @id reference, one named by its item node, one without a name.
    const list = {
      '@context': CTX,
      '@graph': [
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 3, name: 'Basics', item: 'https://example.com/guides/basics' },
            { '@id': 'https://example.com/#crumb-1' },
            { '@type': 'ListItem', position: 2, item: { '@type': 'Thing', '@id': 'https://example.com/guides', name: 'Guides' } },
          ],
        },
        { '@type': 'ListItem', '@id': 'https://example.com/#crumb-1', position: 1, name: 'Home', item: 'javascript:alert(1)' },
      ],
    };
    const facts = serpPreview(audit([list]));
    expect(facts.breadcrumb.source).toBe('breadcrumb-schema');
    expect(facts.breadcrumb.crumbs).toEqual([
      { name: 'Home', shown: 'Home', url: null },
      { name: 'Guides', shown: 'Guides', url: 'https://example.com/guides' },
      { name: 'Basics', shown: 'Basics', url: 'https://example.com/guides/basics' },
    ]);
    expect(facts.breadcrumb.line.shown).toBe('example.com › Home › Guides › Basics');
    expect(facts.blocks).toEqual([0]);
    // At most maxCrumbs steps, each cut to maxCrumbChars; the line is cut by width.
    const many = serpPreview(audit([trail('a'.repeat(60), 'b', 'c', 'd', 'e', 'f', 'g')]));
    expect(many.breadcrumb.crumbs).toHaveLength(SERP_PREVIEW_LIMITS.maxCrumbs);
    expect(many.breadcrumb.more).toBe(true);
    expect([...many.breadcrumb.crumbs[0]!.shown].length).toBe(SERP_PREVIEW_LIMITS.maxCrumbChars);
    expect(many.breadcrumb.crumbs[0]!.name).toBe('a'.repeat(60));
    expect(many.breadcrumb.steps.map((c) => c.name)).toEqual(['a'.repeat(60), 'b', 'c', 'd', 'e', 'f', 'g']);
    const wide = serpPreview(audit([trail(...Array.from({ length: 5 }, () => 'W'.repeat(40)))]));
    expect(wide.breadcrumb.line.truncated).toBe(true);
    expect(textWidth(wide.breadcrumb.line.shown, 'description')).toBeLessThanOrEqual(SERP_PREVIEW_BUDGETS_PX.breadcrumb);
  });

  test('breadcrumb-falls-back-to-url', () => {
    const facts = serpPreview(audit([], {}, 'https://example.com/guides/caf%C3%A9/%E0%A4%A/tea?x=1#top'));
    expect(facts.breadcrumb.source).toBe('url');
    expect(facts.breadcrumb.crumbs.map((c) => [c.name, c.url])).toEqual([
      ['guides', 'https://example.com/guides'],
      ['café', 'https://example.com/guides/caf%C3%A9'],
      ['%E0%A4%A', 'https://example.com/guides/caf%C3%A9/%E0%A4%A'],
      ['tea', 'https://example.com/guides/caf%C3%A9/%E0%A4%A/tea'],
    ]);
    expect(facts.breadcrumb.line.shown).toBe('example.com › guides › café › %E0%A4%A › tea');
    // A BreadcrumbList without a named step is no trail.
    expect(serpPreview(audit([{ '@context': CTX, '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }])).breadcrumb.source).toBe('url');
    // The root has no steps.
    expect(serpPreview(audit([], {}, 'https://example.com/')).breadcrumb).toMatchObject({ crumbs: [], line: { shown: 'example.com' } });
  });

  test('date-from-article-schema', () => {
    const published = serpPreview(audit([{ '@context': CTX, '@type': 'NewsArticle', headline: 'News', datePublished: '2025-01-05T08:00:00+09:00', dateModified: '2025-02-01' }]));
    // As written: never moved to another time zone.
    expect(published.date).toEqual({ iso: '2025-01-05T08:00:00+09:00', shown: 'Jan 5, 2025', source: 'article-date-published' });
    expect(published.article).toEqual({ headline: 'News' });
    expect(published.variants['top-stories']).toBe(true);
    const modified = serpPreview(audit([{ '@context': CTX, '@type': 'BlogPosting', dateModified: '2024-12' }], { 'article:published_time': '2020-01-01' }));
    expect(modified.date).toEqual({ iso: '2024-12', shown: 'Dec 2024', source: 'article-date-modified' });
    // The clean fixture's Article.
    expect(serpPreview(runAudit(page())).date).toMatchObject({ shown: 'Jan 5, 2025', source: 'article-date-published' });
  });

  test('date-falls-back-to-article-published-time', () => {
    const tag = serpPreview(audit([], { 'article:published_time': '2023-07-14T10:00:00Z', 'article:modified_time': '2023-08-01' }));
    expect(tag.date).toEqual({ iso: '2023-07-14T10:00:00Z', shown: 'Jul 14, 2023', source: 'article-published-time' });
    expect(tag.variants['top-stories']).toBe(false);
    expect(serpPreview(audit([], { 'article:modified_time': '2023' })).date).toEqual({ iso: '2023', shown: '2023', source: 'article-modified-time' });
    expect(serpPreview(audit([])).date).toBeNull();
    // A WebPage's date is not an article's.
    expect(serpPreview(audit([{ '@context': CTX, '@type': 'WebPage', datePublished: '2025-01-01' }])).date).toBeNull();
  });

  test('rating-from-aggregate', () => {
    const product = { '@context': CTX, '@type': 'Product', name: 'Kettle', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4,4', reviewCount: '120' } };
    expect(serpPreview(audit([product])).rating).toEqual({ value: 4.4, best: 5, worst: 1, count: 120, countOf: 'reviews', stars: 4, shown: '4.4' });
    const ten = serpPreview(audit([{ '@context': CTX, '@type': 'AggregateRating', ratingValue: 7.25, bestRating: 10, worstRating: 0, ratingCount: 9 }])).rating;
    expect(ten).toEqual({ value: 7.25, best: 10, worst: 0, count: 9, countOf: 'ratings', stars: 4, shown: '7.3' });
    expect(serpPreview(audit([])).rating).toBeNull();
  });

  test('video-and-recipe-facts', () => {
    const video = { '@context': CTX, '@type': 'VideoObject', name: 'Brewing sencha', duration: 'PT1M35S', uploadDate: '2024-03-02', thumbnailUrl: 'https://example.com/t.jpg' };
    const recipe = {
      '@context': CTX,
      '@type': 'Recipe',
      name: 'Iced tea',
      prepTime: 'PT15M',
      cookTime: 'PT1H',
      recipeYield: ['4 glasses', '4'],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 5, ratingCount: 3 },
    };
    const facts = serpPreview(audit([video, recipe]));
    expect(facts.video).toEqual({ name: 'Brewing sencha', duration: '1:35', uploadDate: { iso: '2024-03-02', shown: 'Mar 2, 2024' }, thumbnail: true });
    expect(facts.recipe).toEqual({ name: 'Iced tea', totalTime: '1 hr 15 min', yield: '4 glasses', rating: { value: 5, best: 5, worst: 1, count: 3, countOf: 'ratings', stars: 5, shown: '5' } });
    expect(facts.variants).toEqual({ standard: true, 'top-stories': false, video: true, recipe: true });
    expect(facts.blocks).toEqual([0, 1]);
    // totalTime wins; a long video shows hours; a relative thumbnail is not one.
    const more = serpPreview(audit([{ ...video, duration: 'PT2H3M4S', thumbnailUrl: '/t.jpg' }, { ...recipe, totalTime: 'PT45M', aggregateRating: undefined }]));
    expect(more.video).toMatchObject({ duration: '2:03:04', thumbnail: false });
    expect(more.recipe).toMatchObject({ totalTime: '45 min', rating: null });
    expect(serpPreview(audit([])).variants).toEqual({ standard: true, 'top-stories': false, video: false, recipe: false });
  });

  test('invalid-dates-and-ratings-ignored', () => {
    // Not ISO 8601, or not a real date: the next source is read.
    const dates = serpPreview(audit([{ '@context': CTX, '@type': 'Article', datePublished: 'yesterday', dateModified: '2025-02-30' }], { 'article:published_time': '05/01/2025', 'article:modified_time': '2025-13-01' }));
    expect(dates.date).toBeNull();
    const next = serpPreview(audit([{ '@context': CTX, '@type': 'Article', datePublished: 'soon' }], { 'article:published_time': '2022-02-02' }));
    expect(next.date?.source).toBe('article-published-time');
    // Ratings: not a number, out of range, best not above worst; the first valid one is read.
    const bad = [
      { '@context': CTX, '@type': 'AggregateRating', ratingValue: 'five' },
      { '@context': CTX, '@type': 'AggregateRating', ratingValue: 6 },
      { '@context': CTX, '@type': 'AggregateRating', ratingValue: 3, bestRating: 1, worstRating: 1 },
      { '@context': CTX, '@type': 'AggregateRating', ratingValue: '-1' },
      { '@context': CTX, '@type': 'AggregateRating', ratingValue: '4.5.1' },
    ];
    expect(serpPreview(audit(bad)).rating).toBeNull();
    expect(serpPreview(audit([...bad, { '@context': CTX, '@type': 'AggregateRating', ratingValue: 2, ratingCount: '1.5', reviewCount: 'many' }])).rating).toMatchObject({ value: 2, count: null, countOf: null });
    // A duration with years or months, or not ISO 8601, is not shown; an invalid upload date is dropped.
    const video = serpPreview(audit([{ '@context': CTX, '@type': 'VideoObject', name: 'V', duration: 'P1Y', uploadDate: 'last week' }])).video;
    expect(video).toEqual({ name: 'V', duration: null, uploadDate: null, thumbnail: false });
    expect(serpPreview(audit([{ '@context': CTX, '@type': 'Recipe', name: 'R', totalTime: '90 minutes' }])).recipe?.totalTime).toBeNull();
  });

  test('suggested-jsonld-escapes-lt', () => {
    const facts = audit([{ '@context': CTX, '@type': 'NewsArticle', datePublished: '2025-01-05' }], { 'og:site_name': 'Tea <b>& co</b>' }, 'https://example.com/guides/tea?x=1#top', { canonicals: [], canonicalTotal: 0 });
    const text = suggestedJsonLd({ ...facts, page: { ...facts.page, title: { text: 'A </script><script>alert(1)</script> title', length: 40 } } })!;
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>');
    const json = JSON.parse(text) as { '@context': string; '@graph': Record<string, unknown>[] };
    expect(json['@context']).toBe(SUGGESTED_JSONLD_SHAPE.context);
    expect(json['@graph'].map((node) => node['@type'])).toEqual([...SUGGESTED_JSONLD_SHAPE.graph]);
    expect(json['@graph']).toEqual([
      { '@type': 'WebSite', '@id': 'https://example.com/#website', name: 'Tea <b>& co</b>', url: 'https://example.com/' },
      {
        '@type': 'BreadcrumbList',
        '@id': 'https://example.com/guides/tea?x=1#breadcrumb',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'guides', item: 'https://example.com/guides' },
          { '@type': 'ListItem', position: 2, name: 'tea', item: 'https://example.com/guides/tea' },
        ],
      },
      {
        '@type': 'WebPage',
        '@id': 'https://example.com/guides/tea?x=1',
        url: 'https://example.com/guides/tea?x=1',
        name: 'A </script><script>alert(1)</script> title',
        isPartOf: { '@id': 'https://example.com/#website' },
        breadcrumb: { '@id': 'https://example.com/guides/tea?x=1#breadcrumb' },
        datePublished: '2025-01-05',
      },
    ]);
    // The override and the toggles; no title, no name.
    const bare = JSON.parse(suggestedJsonLd({ ...facts, page: { ...facts.page, title: null } }, { siteName: 'Mine', breadcrumb: false, date: false })!) as { '@graph': Record<string, unknown>[] };
    expect(bare['@graph']).toEqual([
      { '@type': 'WebSite', '@id': 'https://example.com/#website', name: 'Mine', url: 'https://example.com/' },
      { '@type': 'WebPage', '@id': 'https://example.com/guides/tea?x=1', url: 'https://example.com/guides/tea?x=1', isPartOf: { '@id': 'https://example.com/#website' } },
    ]);
    // A deep URL: every step is listed (five are drawn); a long site name is written whole; a modified date is dateModified.
    const deep = audit(
      [{ '@context': CTX, '@type': 'Article', dateModified: '2025-02-01' }],
      { 'og:site_name': `Tea ${'x'.repeat(70)}` },
      'https://example.com/a/b/c/d/e/f/g',
      { canonicals: [], canonicalTotal: 0 },
    );
    expect(serpPreview(deep).breadcrumb.crumbs).toHaveLength(SERP_PREVIEW_LIMITS.maxCrumbs);
    const deepGraph = (JSON.parse(suggestedJsonLd(deep)!) as { '@graph': Record<string, unknown>[] })['@graph'];
    expect(deepGraph[0]!.name).toBe(`Tea ${'x'.repeat(70)}`);
    expect((deepGraph[1]!.itemListElement as { position: number; name: string; item: string }[]).map((item) => [item.position, item.name, item.item])).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => [i + 1, name, `https://example.com/${['a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, i + 1).join('/')}`]),
    );
    expect(deepGraph[2]).toMatchObject({ dateModified: '2025-02-01' });
    expect(deepGraph[2]).not.toHaveProperty('datePublished');
    expect((JSON.parse(suggestedJsonLd(audit([], { 'article:modified_time': '2024-05-05' }))!) as { '@graph': Record<string, unknown>[] })['@graph'][2]).toMatchObject({ dateModified: '2024-05-05' });
    // The effective canonical names the page (without its fragment); a canonical that is not an absolute web URL does not.
    const canon = audit([], {}, 'https://example.com/guides/tea?utm=x', { canonicals: [{ href: '/guides/tea#c', resolved: 'https://example.com/guides/tea#c' }], canonicalTotal: 1 });
    const canonGraph = (JSON.parse(suggestedJsonLd(canon)!) as { '@graph': Record<string, unknown>[] })['@graph'];
    expect(canonGraph[1]).toMatchObject({ '@id': 'https://example.com/guides/tea#breadcrumb' });
    expect(canonGraph[2]).toMatchObject({ '@id': 'https://example.com/guides/tea', url: 'https://example.com/guides/tea' });
    const relative = audit([], {}, 'https://example.com/guides/tea', { canonicals: [{ href: 'mailto:x@example.com', resolved: null }], canonicalTotal: 1 });
    expect((JSON.parse(suggestedJsonLd(relative)!) as { '@graph': Record<string, unknown>[] })['@graph'][2]).toMatchObject({ '@id': 'https://example.com/guides/tea' });
    // Not a web page: nothing.
    const file = audit([], {}, 'file:///tmp/a.html');
    expect(suggestedJsonLd(file)).toBeNull();
  });

  test('page-jsonld-blocks-that-fed-the-preview', () => {
    const unrelated = { '@context': CTX, '@type': 'Organization', name: 'Org' };
    const site = { '@context': CTX, '@type': 'WebSite', name: 'Site' };
    const facts = audit([unrelated, site, '{ broken', trail('One')]);
    expect(serpPreview(facts).blocks).toEqual([1, 3]);
    const text = previewJsonLdBlocks(facts)!;
    expect(text.split('\n\n')).toHaveLength(2);
    expect(JSON.parse(text.split('\n\n')[0]!)).toEqual(site);
    expect(text).not.toContain('Org');
    // A block too big to format whole is written as written (still valid JSON), never cut short.
    const big = { '@context': CTX, '@type': 'WebSite', name: 'Big', description: 'd'.repeat(SCHEMA_PARSE_LIMITS.maxPrettyChars) };
    const bigText = previewJsonLdBlocks(audit([big]))!;
    expect(bigText).toBe(JSON.stringify(big));
    expect(JSON.parse(bigText)).toEqual(big);
    // Nothing fed by JSON-LD: nothing.
    expect(previewJsonLdBlocks(audit([unrelated]))).toBeNull();
  });
});
