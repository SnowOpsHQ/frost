// Spec: specs/site-crawl.spec.ts (CRAWL_RULE_IDS, CRAWL_KEEP_HEADERS), specs/seo-javascript.schema.ts (ServedSnapshotSchema),
// specs/seo-snapshot.spec.ts (PageSnapshotSchema, PageContextSchema, ResponseMetaSchema), specs/seo-indexability.spec.ts
// (RESPONSE_HEADER_ALLOWLIST, RESPONSE_LIMITS, headerValueCap)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: The snapshot adapter, The context,
// The audit); plan docs/plans/phase-12-big-bets.md Decision 6 and Task 6b (the adapter's and the context's field lists)
import { describe, expect, test } from 'vitest';
import type { ServedSnapshot } from '@app/specs/seo-javascript.schema';
import { RESPONSE_LIMITS } from '@app/specs/seo-indexability.spec';
import { SOCIAL_TAGS } from '@app/specs/seo-limits.spec';
import { PageContextSchema, PageSnapshotSchema, type RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { CRAWL_RULE_IDS } from '@app/specs/site-crawl.spec';
import { RULES } from '../../rules';
import { crawlContext, type CrawlFetchFacts } from '../crawl-context';
import { CRAWL_RULES, crawlAudit } from '../crawl-rules';
import { servedToPageSnapshot } from '../served-to-page';

const URL_A = 'https://example.com/guides/a';
const JSON_LD = '{"@context":"https://schema.org","@type":"Article","headline":"Guide A"}';
const encoder = new TextEncoder();

/** A served snapshot with a value in every field (frost's own values). */
function served(changes: Partial<ServedSnapshot> = {}): ServedSnapshot {
  return {
    url: URL_A,
    lang: 'en',
    titles: [{ text: 'Guide A', length: 7 }],
    titleTotal: 1,
    metaDescriptions: [{ text: 'A guide to A.', length: 13 }],
    metaDescriptionTotal: 1,
    metaRobots: [{ name: 'robots', content: 'index, follow' }],
    canonicals: [{ href: '/guides/a', resolved: URL_A }],
    canonicalTotal: 1,
    ogUrl: URL_A,
    viewport: 'width=device-width, initial-scale=1',
    headings: [
      { level: 1, text: 'Guide A' },
      { level: 2, text: 'Part one' },
    ],
    headingTotal: 2,
    links: [
      { href: 'https://example.com/guides/b', scheme: 'https:', rel: '', text: 'B', kind: 'internal', target: null },
      { href: 'https://other.example.org/', scheme: 'https:', rel: 'nofollow', text: 'Other', kind: 'external', target: '_blank' },
    ],
    linkTotal: 3,
    images: [
      { src: 'https://example.com/a.png', alt: { text: 'A diagram', length: 9 } },
      { src: 'https://example.com/b.png', alt: null },
    ],
    imageTotal: 2,
    jsonLd: [{ text: JSON_LD, length: JSON_LD.length }],
    jsonLdTotal: 1,
    hreflang: [{ hreflang: 'en', href: URL_A, resolved: URL_A }],
    hreflangTotal: 1,
    wordCount: 420,
    textTruncated: false,
    leadText: 'Guide A Part one',
    noscript: { count: 0, wordCount: 0, linkCount: 0 },
    nodes: 120,
    partial: false,
    ...changes,
  };
}

const robotsOk = (text: string): RobotsFetch => ({ url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: encoder.encode(text), truncated: false });

const facts = (changes: Partial<CrawlFetchFacts> = {}): CrawlFetchFacts => ({
  url: URL_A,
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', link: '<https://example.com/guides/a>; rel="canonical"', 'x-robots-tag': 'googlebot: nofollow\nnoindex', 'retry-after': '120' },
  xRobotsTag: ['googlebot: nofollow', 'noindex'],
  chain: [{ url: 'http://example.com/guides/a', status: 301, location: URL_A }],
  ...changes,
});

describe('the crawl snapshot adapter', () => {
  test('served-to-page-snapshot-maps-fields', () => {
    const source = served();
    const page = servedToPageSnapshot(source, { extractedAt: 1_700_000_000_000, durationMs: 85 });
    // It is a page snapshot (imageTotal included), as the extractor would answer one.
    expect(PageSnapshotSchema.safeParse(page).error?.issues ?? []).toEqual([]);
    // Copied.
    for (const key of ['url', 'lang', 'titles', 'titleTotal', 'metaDescriptions', 'metaDescriptionTotal', 'metaRobots', 'canonicals', 'canonicalTotal', 'ogUrl', 'viewport', 'headings', 'headingTotal', 'links', 'linkTotal', 'imageTotal', 'jsonLd', 'jsonLdTotal', 'hreflang', 'hreflangTotal', 'wordCount', 'textTruncated', 'partial'] as const) {
      expect(page[key], key).toEqual(source[key]);
    }
    // Mapped: each image's src and alt, layout values none (the rules reading them are not crawl rules).
    expect(page.images).toEqual([
      { src: 'https://example.com/a.png', alt: { text: 'A diagram', length: 9 }, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
      { src: 'https://example.com/b.png', alt: null, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
    ]);
    // Defaulted: the fetch's time and duration, no social tag, a neutral security value, no microdata or RDFa.
    expect(page.extractedAt).toBe(1_700_000_000_000);
    expect(page.durationMs).toBe(85);
    expect(Object.keys(page.social).sort()).toEqual([...SOCIAL_TAGS].sort());
    expect(Object.values(page.social).every((value) => value === null)).toBe(true);
    expect(page.security).toEqual({ insecureResources: [], insecureResourceTotal: 0, resourcesTruncated: false, metaCsp: [], metaReferrer: null });
    expect(page).toMatchObject({ microdata: [], microdataTotal: 0, rdfa: [], rdfaTotal: 0 });
    // Omitted: hidden headings, blocking scripts and visible text; and nothing of the served snapshot's own (lead text, noscript, nodes).
    for (const key of ['hiddenHeadings', 'blockingScripts', 'visibleText', 'leadText', 'noscript', 'nodes']) expect(Object.hasOwn(page, key), key).toBe(false);
  });

  test('served-to-page-snapshot-keeps-caps', () => {
    // A page whose lists were cut by the served parse stays a valid snapshot (totals above the lists).
    const page = servedToPageSnapshot(served({ links: [], linkTotal: 5_000, images: [], imageTotal: 40, partial: true }), { extractedAt: 0, durationMs: 0 });
    expect(PageSnapshotSchema.safeParse(page).error?.issues ?? []).toEqual([]);
    expect(page).toMatchObject({ linkTotal: 5_000, imageTotal: 40, partial: true });
  });
});

describe('the crawl context', () => {
  test('crawl-context-from-the-fetch', () => {
    const robots = robotsOk('User-agent: *\nDisallow: /private\n');
    const context = crawlContext(facts(), robots);
    expect(PageContextSchema.safeParse(context).success).toBe(true);
    expect(context.robots).toBe(robots);
    // No accessibility, no checks.
    expect(Object.hasOwn(context, 'accessibility')).toBe(false);
    expect(Object.hasOwn(context, 'checks')).toBe(false);
    const response = context.response!;
    expect(response).toMatchObject({ url: URL_A, source: 'network', status: 200, headersAvailable: true, redirectTotal: 1 });
    expect(response.redirects).toEqual([{ url: 'http://example.com/guides/a', status: 301, location: URL_A, internal: false }]);
    // Only the kept headers the audit's allowlist names (`retry-after` is the back-off's, not the audit's); X-Robots-Tag values apart.
    expect(response.headers).toEqual([
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'link', value: '<https://example.com/guides/a>; rel="canonical"' },
      { name: 'x-robots-tag', value: 'googlebot: nofollow' },
      { name: 'x-robots-tag', value: 'noindex' },
    ]);
  });

  test('crawl-context-caps-what-it-keeps', () => {
    const long = 'x'.repeat(RESPONSE_LIMITS.maxHeaderValueChars + 10);
    const many = Array.from({ length: RESPONSE_LIMITS.maxValuesPerHeader + 3 }, (_, i) => `noindex${i}`);
    const chain = Array.from({ length: RESPONSE_LIMITS.maxRedirects + 2 }, (_, i) => ({ url: `https://example.com/${i}`, status: 302, location: `https://example.com/${i + 1}` }));
    const context = crawlContext(facts({ headers: { 'content-type': long }, xRobotsTag: many, chain }), null);
    expect(PageContextSchema.safeParse(context).success).toBe(true);
    const response = context.response!;
    expect(response.headers[0]).toEqual({ name: 'content-type', value: long.slice(0, RESPONSE_LIMITS.maxHeaderValueChars), truncated: true });
    expect(response.headers.filter((h) => h.name === 'x-robots-tag')).toHaveLength(RESPONSE_LIMITS.maxValuesPerHeader);
    expect(response.redirects).toHaveLength(RESPONSE_LIMITS.maxRedirects);
    expect(response.redirectTotal).toBe(chain.length);
    expect(context.robots).toBeNull();
  });
});

describe('the crawl rule set', () => {
  test('crawl-rules-are-the-crawl-rule-ids', () => {
    expect(CRAWL_RULES.map((rule) => rule.id).sort()).toEqual([...CRAWL_RULE_IDS].sort());
    // In catalogue order.
    const order = RULES.map((rule) => rule.id);
    expect(CRAWL_RULES.map((rule) => order.indexOf(rule.id))).toEqual([...CRAWL_RULES.map((rule) => order.indexOf(rule.id))].sort((a, b) => a - b));
  });

  test('crawl-audit-reads-only-crawl-rules', () => {
    const snapshot = servedToPageSnapshot(served({ titles: [], titleTotal: 0, lang: null }), { extractedAt: 0, durationMs: 0 });
    const audit = crawlAudit(snapshot, crawlContext(facts({ headers: { 'content-type': 'text/html' }, xRobotsTag: [], chain: [] }), robotsOk('User-agent: *\nAllow: /\n')));
    const ids = audit.findings.map((finding) => finding.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['title-missing', 'lang-missing']));
    for (const id of ids) expect(CRAWL_RULE_IDS as readonly string[]).toContain(id);
  });
});
