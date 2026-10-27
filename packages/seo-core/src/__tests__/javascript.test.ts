// Spec: specs/seo-javascript.spec.ts (JS_FIELDS, WORD_COUNT_TOLERANCE, JS_DIFF_LIMITS, JS_VERDICT_THRESHOLDS, JAVASCRIPT_RULE_SPECS)
// Acceptance: specs/seo-javascript.feature.md (Comparison and rules)
import { describe, expect, test } from 'vitest';
import { JAVASCRIPT_RULE_SPECS, JS_DIFF_LIMITS, JS_FIELDS, JS_VERDICT_THRESHOLDS, WORD_COUNT_TOLERANCE } from '@app/specs/seo-javascript.spec';
import type { ServedFetch, ServedSnapshot, ServedState } from '@app/specs/seo-javascript.schema';
import { SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import { javascriptReport, RULES, runAudit, type JavascriptComparison, type PageSnapshot } from '../index';
import { cleanSnapshot, PAGE_URL, text } from './fixtures';

const FETCH: ServedFetch = { url: PAGE_URL, finalUrl: PAGE_URL, status: 200, redirects: 0, bytes: 12_000, truncated: false, contentType: 'text/html', userAgent: null, durationMs: 40 };

/** The served snapshot of `page` as a static page would serve it (the same fields). */
function servedOf(page: PageSnapshot, changes: Partial<ServedSnapshot> = {}): ServedSnapshot {
  return {
    url: page.url,
    lang: page.lang,
    titles: page.titles,
    titleTotal: page.titleTotal,
    metaDescriptions: page.metaDescriptions,
    metaDescriptionTotal: page.metaDescriptionTotal,
    metaRobots: page.metaRobots,
    canonicals: page.canonicals,
    canonicalTotal: page.canonicalTotal,
    ogUrl: page.ogUrl,
    viewport: page.viewport,
    headings: page.headings,
    headingTotal: page.headingTotal,
    links: page.links,
    linkTotal: page.linkTotal,
    images: page.images.map((image) => ({ src: image.src, alt: image.alt })),
    imageTotal: page.imageTotal,
    jsonLd: page.jsonLd,
    jsonLdTotal: page.jsonLdTotal,
    hreflang: page.hreflang,
    hreflangTotal: page.hreflangTotal,
    wordCount: page.wordCount,
    textTruncated: false,
    noscript: { count: 0, wordCount: 0, linkCount: 0 },
    nodes: 400,
    partial: false,
    ...changes,
  };
}

/** `rendered` with its served side (`served` changes on a copy of it, or a whole state). */
function withServed(rendered: PageSnapshot, served: Partial<ServedSnapshot> | ServedState = {}, fetch: Partial<ServedFetch> = {}): PageSnapshot {
  const state: ServedState = 'status' in served ? (served as ServedState) : { status: 'ready', fetch: { ...FETCH, ...fetch }, snapshot: servedOf(rendered, served as Partial<ServedSnapshot>) };
  return { ...rendered, served: state };
}

function comparison(snapshot: PageSnapshot): JavascriptComparison {
  const report = javascriptReport(snapshot);
  if (report.status !== 'ready' && report.status !== 'identical') throw new Error(`no comparison: ${report.status}`);
  return report;
}

const fieldOf = (report: JavascriptComparison, id: (typeof JS_FIELDS)[number]) => report.fields.find((f) => f.id === id)!;
const rule = (id: SeoRuleId) => RULES.find((r) => r.id === id)!;
const link = (href: string, text = 'A link') => ({ href, scheme: href.startsWith('https:') ? 'https:' : 'http:', rel: '', text, kind: 'internal' as const, target: null });

describe('javascript report', () => {
  test('js-report-states', () => {
    const page = cleanSnapshot();
    expect(javascriptReport(page)).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null, finalUrl: null });
    expect(javascriptReport({ ...page, served: null })).toMatchObject({ status: 'unavailable', reason: 'not-fetched' });
    expect(javascriptReport({ ...page, served: { status: 'pending' } })).toEqual({ status: 'pending' });
    expect(javascriptReport({ ...page, served: { status: 'unavailable', reason: 'http-status', httpStatus: 403, finalUrl: PAGE_URL } })).toEqual({ status: 'unavailable', reason: 'http-status', httpStatus: 403, finalUrl: PAGE_URL });
    const same = comparison(withServed(page));
    expect(same.status).toBe('identical');
    expect(same.verdict).toBe('independent');
    expect(same.changed).toBe(0);
    expect(same.fields.map((f) => f.id)).toEqual([...JS_FIELDS]);
    // runAudit carries it, and every catalog rule with the `javascript` category is checked.
    expect(runAudit(withServed(page)).javascript.status).toBe('identical');
    expect(SEO_RULE_SPECS.filter((s) => s.category === 'javascript').map((s) => s.id)).toEqual(JAVASCRIPT_RULE_SPECS.map((s) => s.id));
  });

  test('js-diff-fields', () => {
    const page = cleanSnapshot();
    const report = comparison(
      withServed(page, {
        titles: [text('Loading…')],
        canonicals: [],
        canonicalTotal: 0,
        metaRobots: [...page.metaRobots].reverse(),
        ogUrl: 'https://example.com/old',
        lang: null,
        headings: page.headings.filter((h) => h.level !== 1),
        hreflang: [],
        wordCount: page.wordCount - WORD_COUNT_TOLERANCE.words,
        viewport: page.viewport,
      }),
    );
    expect(fieldOf(report, 'title')).toMatchObject({ status: 'changed', served: 'Loading…', rendered: page.titles[0]!.text });
    expect(fieldOf(report, 'canonical')).toMatchObject({ status: 'only-rendered', served: null, rendered: PAGE_URL });
    // Robots and hreflang compare as sets.
    expect(fieldOf(report, 'robots').status).toBe('same');
    expect(fieldOf(report, 'og-url')).toMatchObject({ status: 'changed', served: 'https://example.com/old' });
    expect(fieldOf(report, 'lang')).toMatchObject({ status: 'only-rendered', served: null, rendered: 'en' });
    expect(fieldOf(report, 'h1')).toMatchObject({ status: 'only-rendered' });
    expect(fieldOf(report, 'hreflang').status).toBe('same');
    // Within the tolerance, word counts are the same.
    expect(fieldOf(report, 'word-count').status).toBe('same');
    const words = comparison(withServed(page, { wordCount: 100 }));
    expect(fieldOf(words, 'word-count')).toMatchObject({ status: 'changed', served: '100', rendered: '850' });
    // Removed by JavaScript.
    const removed = comparison(withServed({ ...page, metaRobots: [] }, { metaRobots: [{ name: 'robots', content: 'noindex' }] }));
    expect(fieldOf(removed, 'robots')).toMatchObject({ status: 'only-served', served: 'robots: noindex', rendered: null });
    expect(report.status).toBe('ready');
    expect(report.changed).toBe(report.fields.filter((f) => f.status !== 'same').length);
  });

  test('js-diff-lists', () => {
    const page = { ...cleanSnapshot(), links: [link('https://example.com/a'), link('https://example.com/b'), link('https://example.com/b'), link('https://example.com/new', 'New')], linkTotal: 4 };
    const report = comparison(
      withServed(page, {
        links: [link('https://example.com/a'), link('https://example.com/gone'), { ...link('javascript:void(0)'), scheme: 'javascript:', kind: 'other' }],
        linkTotal: 3,
        headings: [...page.headings, { level: 2, text: 'Only served' }, { level: 3, text: 'Headings' }],
        jsonLd: [{ text: JSON.stringify(JSON.parse(page.jsonLd[0]!.text), null, 2), length: 999_999 }],
      }),
    );
    // Links: http(s) only, by URL, as a set (a link listed twice is one).
    expect(report.links.added.map((i) => i.label)).toEqual(['https://example.com/b', 'https://example.com/new']);
    expect(report.links.added[1]).toMatchObject({ detail: 'New', url: 'https://example.com/new', count: 1 });
    expect(report.links.removed.map((i) => i.label)).toEqual(['https://example.com/gone']);
    expect(report.metrics).toMatchObject({ servedLinks: 2, renderedLinks: 3, linksAdded: 2 });
    // Headings by level and text, counted.
    // (in the served order of each heading's first appearance).
    expect(report.headings.removed).toEqual([
      { key: '3\u0000Headings', label: 'Headings', detail: 'H3', count: 1, url: null },
      { key: '2\u0000Only served', label: 'Only served', detail: 'H2', count: 1, url: null },
    ]);
    // A cut JSON-LD block is compared by its text (not parsed), so it differs.
    expect(report.structuredData.addedTotal).toBe(1);
    // Formatting alone does not count.
    const pretty = comparison(withServed(cleanSnapshot(), { jsonLd: [{ text: JSON.stringify(JSON.parse(cleanSnapshot().jsonLd[0]!.text), null, 2), length: JSON.stringify(JSON.parse(cleanSnapshot().jsonLd[0]!.text), null, 2).length }] }));
    expect(pretty.structuredData.addedTotal + pretty.structuredData.removedTotal).toBe(0);
    expect(pretty.structuredData.served).toBe(1);
    // Capped, with totals.
    const many = Array.from({ length: JS_DIFF_LIMITS.maxListItems + 20 }, (_, i) => link(`https://example.com/p${i}`));
    const capped = comparison(withServed({ ...cleanSnapshot(), links: many, linkTotal: many.length }, { links: [], linkTotal: 0 }));
    expect(capped.links.added).toHaveLength(JS_DIFF_LIMITS.maxListItems);
    expect(capped.links.addedTotal).toBe(many.length);
  });

  test('js-verdict-thresholds', () => {
    const t = JS_VERDICT_THRESHOLDS;
    const page = { ...cleanSnapshot(), wordCount: 1_000 };
    // Half the words added: heavily.
    expect(comparison(withServed(page, { wordCount: 1_000 * (1 - t.heavyShare) })).verdict).toBe('heavily');
    expect(comparison(withServed(page, { wordCount: 1_000 * (1 - t.heavyShare) + 1 })).verdict).toBe('partly');
    // A tenth added: partly; less: independent.
    expect(comparison(withServed(page, { wordCount: 1_000 * (1 - t.partlyShare) })).verdict).toBe('partly');
    expect(comparison(withServed(page, { wordCount: 1_000 * (1 - t.partlyShare) + 10 })).verdict).toBe('independent');
    // Too few words to judge by words.
    const small = { ...cleanSnapshot(), wordCount: t.minWords - 1 };
    expect(comparison(withServed(small, { wordCount: 0 })).verdict).toBe('independent');
    // Links: most added (with enough links) is heavily; one added is partly.
    const links = Array.from({ length: t.minLinks * 2 }, (_, i) => link(`https://example.com/l${i}`));
    const linked = { ...cleanSnapshot(), links, linkTotal: links.length };
    expect(comparison(withServed(linked, { links: links.slice(0, t.minLinks), linkTotal: t.minLinks })).verdict).toBe('heavily');
    expect(comparison(withServed(linked, { links: links.slice(1), linkTotal: links.length - 1 })).verdict).toBe('partly');
    // A key field changed: partly.
    expect(comparison(withServed(cleanSnapshot(), { titles: [text('Other')] })).verdict).toBe('partly');
    // A structured-data block added: partly.
    expect(comparison(withServed(cleanSnapshot(), { jsonLd: [], jsonLdTotal: 0 })).verdict).toBe('partly');
    // A non-key field (viewport) alone: still independent, but not identical.
    const viewport = comparison(withServed(cleanSnapshot(), { viewport: null }));
    expect(viewport).toMatchObject({ verdict: 'independent', status: 'ready' });
  });
});

describe('javascript rules', () => {
  const partial = (page: PageSnapshot, served: Partial<ServedSnapshot>) => [withServed(page, { ...served, partial: true }), withServed(page, served, { truncated: true })];
  const notComparable = (page: PageSnapshot) => [{ ...page, served: { status: 'pending' } as ServedState }, { ...page, served: { status: 'unavailable', reason: 'timeout', httpStatus: null, finalUrl: null } as ServedState }, page];

  test('js-canonical-changed', () => {
    const page = cleanSnapshot();
    const changed = withServed(page, { canonicals: [{ href: '/old', resolved: 'https://example.com/old' }] });
    expect(rule('js-canonical-changed').check(changed)?.facts).toEqual([
      { label: 'Served HTML', value: 'https://example.com/old' },
      { label: 'After JavaScript', value: PAGE_URL },
    ]);
    expect(rule('js-canonical-changed').check(withServed(page, { canonicals: [], canonicalTotal: 0 }))).not.toBeNull();
    expect(rule('js-canonical-changed').check(withServed(page))).toBeNull();
    for (const s of [...partial(page, { canonicals: [] }), ...notComparable(page)]) expect(rule('js-canonical-changed').check(s)).toBeNull();
    expect(rule('js-canonical-changed').severity).toBe('warning');
  });

  test('js-robots-changed', () => {
    const page = cleanSnapshot();
    expect(rule('js-robots-changed').check(withServed(page, { metaRobots: [{ name: 'robots', content: 'noindex' }] }))).not.toBeNull();
    expect(rule('js-robots-changed').check(withServed({ ...page, metaRobots: [{ name: 'googlebot', content: 'noindex' }] }, { metaRobots: [] }))).not.toBeNull();
    expect(rule('js-robots-changed').check(withServed(page))).toBeNull();
    for (const s of [...partial(page, { metaRobots: [] }), ...notComparable(page)]) expect(rule('js-robots-changed').check(s)).toBeNull();
    expect(rule('js-robots-changed').severity).toBe('warning');
  });

  test('js-title-changed', () => {
    const page = cleanSnapshot();
    const result = rule('js-title-changed').check(withServed(page, { titles: [text('App')] }));
    expect(result?.facts).toEqual([
      { label: 'Served HTML', value: 'App' },
      { label: 'After JavaScript', value: page.titles[0]!.text },
    ]);
    expect(rule('js-title-changed').check(withServed(page, { titles: [], titleTotal: 0 }))?.facts[0]).toEqual({ label: 'Served HTML', value: '(none)' });
    // Only the first title counts.
    expect(rule('js-title-changed').check(withServed({ ...page, titles: [...page.titles, text('Second')], titleTotal: 2 }))).toBeNull();
    for (const s of [...partial(page, { titles: [] }), ...notComparable(page)]) expect(rule('js-title-changed').check(s)).toBeNull();
    expect(rule('js-title-changed').severity).toBe('info');
  });

  test('js-content-added', () => {
    const page = { ...cleanSnapshot(), wordCount: 1_000 };
    const result = rule('js-content-added').check(withServed(page, { wordCount: 200 }));
    expect(result?.facts).toContainEqual({ label: 'Added by JavaScript', value: '80%' });
    expect(rule('js-content-added').check(withServed(page, { wordCount: 600 }))).toBeNull();
    expect(rule('js-content-added').check(withServed({ ...page, wordCount: JS_VERDICT_THRESHOLDS.minWords - 1 }, { wordCount: 0 }))).toBeNull();
    for (const s of [...partial(page, { wordCount: 0 }), ...notComparable(page)]) expect(rule('js-content-added').check(s)).toBeNull();
    expect(rule('js-content-added').severity).toBe('info');
  });

  test('js-links-added', () => {
    const links = [link('https://example.com/a'), link('https://example.com/b'), link('https://example.com/c')];
    const page = { ...cleanSnapshot(), links, linkTotal: 3 };
    const result = rule('js-links-added').check(withServed(page, { links: links.slice(0, 1), linkTotal: 1 }));
    expect(result).toMatchObject({ count: 2, samples: ['https://example.com/b', 'https://example.com/c'] });
    expect(result?.facts[0]).toEqual({ label: 'Links only after JavaScript', value: '2' });
    // Links removed by JavaScript, or non-web links added, never fail it.
    expect(rule('js-links-added').check(withServed({ ...page, links: links.slice(0, 1), linkTotal: 1 }, { links, linkTotal: 3 }))).toBeNull();
    expect(rule('js-links-added').check(withServed({ ...page, links: [...links, { ...link('mailto:a@example.com'), scheme: 'mailto:', kind: 'other' }] }, { links }))).toBeNull();
    for (const s of [...partial(page, { links: [] }), ...notComparable(page)]) expect(rule('js-links-added').check(s)).toBeNull();
    expect(rule('js-links-added').severity).toBe('info');
  });
});
