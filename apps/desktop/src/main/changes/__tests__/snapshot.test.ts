// Spec: specs/capture.spec.ts (CaptureSnapshot, CAPTURE_LIMITS), specs/capture-snapshot.schema.ts (CaptureSnapshotSchema),
// specs/capture-db.spec.ts (MAX_SNAPSHOT_JSON_BYTES), specs/changes.spec.ts (RegionAnswer)
// Acceptance: specs/changes-capture.feature.md (The snapshot), specs/changes-diff.feature.md (The snapshot, Identity)
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalJson, snapshotIdentityJson } from '@app/change-intel';
import { MAX_SNAPSHOT_JSON_BYTES } from '@app/specs/capture-db.spec';
import { CAPTURE_LIMITS as L, CaptureSnapshotSchema, PAGE_REGIONS } from '@app/specs/capture-snapshot.schema';
import { DEFAULT_RENDER_PROFILE } from '@app/specs/render-profile.spec';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { auditOf, regionAnswer, regionText } from '../../../test/changes-fakes';
import { buildCaptureSnapshot, identityHash, laneKeyFor, sha256Hex } from '../snapshot';

const PAGE = 'https://example.com/guides/tea';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A rich page: hreflang, a valid and a broken JSON-LD block, microdata, a noindex header, findings. */
function richAudit() {
  return auditOf(
    PAGE,
    {
      titles: [{ text: 'Green tea, brewed well', length: 22 }],
      hreflang: [
        { hreflang: 'en', href: PAGE, resolved: PAGE },
        { hreflang: 'de', href: '/de/tee', resolved: 'https://example.com/de/tee' },
      ],
      hreflangTotal: 2,
      jsonLd: ['{ "@type": "Product", "name": "Sencha",\n "offers": {"@type": "Offer", "price": "5"}, "@context": "https://schema.org" }', '{ broken'].map((text) => ({ text, length: text.length })),
      jsonLdTotal: 2,
      microdata: [{ types: ['https://schema.org/BreadcrumbList'], id: null, vocab: null, properties: [] }],
      microdataTotal: 1,
      images: [],
      imageTotal: 4,
    },
    {
      response: {
        url: PAGE,
        source: 'network',
        status: 200,
        headersAvailable: true,
        headers: [
          { name: 'x-robots-tag', value: 'noarchive' },
          { name: 'x-robots-tag', value: 'googlebot: nosnippet' },
        ],
        redirects: [],
        redirectTotal: 0,
      },
      robots: null,
    },
  );
}

describe('capture snapshot', () => {
  test('snapshot-builder-fits-the-schema', () => {
    const audit = richAudit();
    const regions = regionAnswer(PAGE, { footer: regionText(['© Example']) }, { partial: true });
    const snapshot = buildCaptureSnapshot(audit, regions, sha256Hex);
    expect(CaptureSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      version: 1,
      url: PAGE,
      takenAt: audit.takenAt,
      partial: true,
      http: { status: 200, xRobotsTag: 'noarchive, googlebot: nosnippet', indexable: audit.indexable },
      head: {
        title: 'Green tea, brewed well',
        metaDescription: audit.page.description!.text,
        canonical: PAGE,
        robotsMeta: 'robots: index, follow',
        lang: 'en',
        viewport: 'width=device-width, initial-scale=1',
        ogTitle: 'A well titled page',
        ogDescription: 'What the page is about.',
        ogImage: 'https://example.com/share.png',
        hreflang: [
          { hreflang: 'en', href: PAGE },
          { hreflang: 'de', href: 'https://example.com/de/tee' },
        ],
      },
      audit: { score: audit.score },
      images: { total: 4, missingAlt: 0 },
    });
    expect(snapshot.audit.findings).toEqual([...new Set(audit.findings.map((f) => f.ruleId))].sort());
    // Structured data: every entity's types; a parsed block hashes its canonical JSON, a broken one its text.
    expect(snapshot.structuredData.types).toEqual(['BreadcrumbList', 'Offer', 'Product']);
    const product = JSON.parse(audit.schema.blocks[0]!.text) as unknown;
    expect(snapshot.structuredData.blocks).toEqual([
      { types: ['Offer', 'Product'], hash: sha(canonicalJson(product)), text: canonicalJson(product) },
      { types: [], hash: sha('{ broken'), text: '{ broken' },
    ]);
    // From the regions: headings, links, and each region's hashed text.
    expect(snapshot.headings).toEqual(regions.headings);
    expect(snapshot.links).toEqual(regions.links);
    for (const region of PAGE_REGIONS) {
      const { words, blocks, truncated, text } = regions.regions[region];
      expect(snapshot.regions[region]).toEqual({ words, blocks, truncated, textHash: sha(text) });
    }
    expect(snapshot.regions.aside.textHash).toBe(sha(''));
    expect(identityHash(snapshot)).toBe(sha(snapshotIdentityJson(snapshot)));
  });

  test('snapshot-builder-cuts-to-the-caps', () => {
    // Values at and over every cap still give a snapshot the schema accepts.
    const long = (n: number) => 'é'.repeat(n);
    const read = auditOf(PAGE, {
      hreflang: Array.from({ length: 80 }, (_, i) => ({ hreflang: `x-${i}`, href: `/l${i}`, resolved: `https://example.com/l${i}` })),
      hreflangTotal: 80,
      jsonLd: Array.from({ length: 25 }, (_, i) => JSON.stringify({ '@type': `Type${i}`, body: 'b'.repeat(5_000) })).map((text) => ({ text, length: text.length })),
      jsonLdTotal: 25,
    });
    // Head values past what Phase 2 keeps (its caps may change): cut here too.
    const audit = { ...read, page: { ...read.page, title: { text: `  ${long(L.maxHeadChars + 50)}  `, length: L.maxHeadChars + 54 }, canonical: `https://example.com/${'c'.repeat(L.maxUrlChars)}` } };
    const snapshot = buildCaptureSnapshot(audit, regionAnswer(PAGE), sha256Hex);
    const parsed = CaptureSnapshotSchema.safeParse(snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    expect(snapshot.head.title).toHaveLength(L.maxHeadChars);
    expect(snapshot.head.hreflang).toHaveLength(L.maxHreflang);
    expect(snapshot.head.canonical).toHaveLength(L.maxUrlChars);
    expect(snapshot.structuredData.blocks).toHaveLength(L.maxJsonLdBlocks);
    for (const block of snapshot.structuredData.blocks) expect(block.text.length).toBeLessThanOrEqual(L.maxJsonLdBlockChars);

    // A snapshot over MAX_SNAPSHOT_JSON_BYTES keeps fewer links and blocks until it fits.
    const big = '\u{1F375}'.repeat(L.maxBlockChars / 2 - 1);
    const fullRegion = { ...regionText(Array.from({ length: 60 }, () => big)) };
    const links = Array.from({ length: L.maxLinks }, (_, i) => ({ href: `https://example.com/${'p'.repeat(2_000)}${i}`, text: 'é'.repeat(L.maxAnchorChars), rel: 'nofollow', region: 'main' as const }));
    const huge = regionAnswer(PAGE, Object.fromEntries(PAGE_REGIONS.map((region) => [region, fullRegion])), { links: { total: L.maxLinks, internal: L.maxLinks, external: 0, nofollow: L.maxLinks, list: links } });
    const fitted = buildCaptureSnapshot(audit, huge, sha256Hex);
    expect(Buffer.byteLength(canonicalJson(fitted), 'utf8')).toBeLessThanOrEqual(MAX_SNAPSHOT_JSON_BYTES);
    expect(CaptureSnapshotSchema.safeParse(fitted).success).toBe(true);
    expect(fitted.partial).toBe(true);
    expect(fitted.links.total).toBe(L.maxLinks);
    expect(fitted.links.list.length).toBeLessThan(L.maxLinks);
    expect(PAGE_REGIONS.some((region) => fitted.regions[region].truncated && fitted.regions[region].blocks.length < 60)).toBe(true);
    // The hash still covers the region's whole text.
    expect(fitted.regions.main.textHash).toBe(sha(fullRegion.text));
  });

  test('lane-key-is-canonical', () => {
    const params: SearchParams = { engine: 'google', query: 'green tea', country: 'de', language: 'de', location: null, device: 'mobile' };
    const lane = laneKeyFor(PAGE, null, null);
    expect(lane).toBe(sha(canonicalJson({ url: PAGE, renderProfile: null, searchParams: null })));
    // The fragment and userinfo are not part of the page.
    expect(laneKeyFor(`${PAGE}#brewing`, null, null)).toBe(lane);
    expect(laneKeyFor('https://user:pw@example.com/guides/tea', null, null)).toBe(lane);
    // Key order does not matter; another URL, profile or search does.
    const shuffled = Object.fromEntries(Object.entries(params).reverse()) as SearchParams;
    expect(laneKeyFor(PAGE, DEFAULT_RENDER_PROFILE, shuffled)).toBe(laneKeyFor(PAGE, DEFAULT_RENDER_PROFILE, params));
    const keys = new Set([lane, laneKeyFor(`${PAGE}?a=1`, null, null), laneKeyFor(PAGE, DEFAULT_RENDER_PROFILE, null), laneKeyFor(PAGE, { ...DEFAULT_RENDER_PROFILE, device: 'phone' }, null), laneKeyFor(PAGE, null, params)]);
    expect(keys.size).toBe(5);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Not a storable page: no lane.
    expect(laneKeyFor('file:///etc/passwd', null, null)).toBeNull();
    expect(laneKeyFor(`https://example.com/${'x'.repeat(20_000)}`, null, null)).toBeNull();
  });
});
