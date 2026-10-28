// Spec: specs/capture-snapshot.schema.ts (CaptureSnapshotSchema, SnapshotDiffSchema),
// specs/capture-search-params.schema.ts (SearchParamsSchema), specs/capture.spec.ts (CAPTURE_LIMITS)
// Acceptance: specs/changes-diff.feature.md (The snapshot, Search parameters, Schemas)
import { afterAll, describe, expect, test } from 'vitest';
import { CaptureSnapshotSchema, SnapshotDiffSchema, CAPTURE_LIMITS as L, type CaptureSnapshot } from '@app/specs/capture-snapshot.schema';
import { SearchParamsSchema, type SearchParams } from '@app/specs/capture-search-params.schema';
import { PROJECT_QUERY_MAX_CHARS } from '@app/specs/capture-db.spec';
import { base, diff, diffsChecked, edited, region, sha } from './fixtures';

describe('search parameters', () => {
  const params: SearchParams = { engine: 'google', query: 'frost seo browser', country: 'de', language: 'de-de', location: 'Berlin', device: 'mobile' };
  const unset: SearchParams = { engine: 'bing', query: 'q', country: null, language: null, location: null, device: null };

  test('search-params-schema-rejects-unknown-keys', () => {
    expect(SearchParamsSchema.parse(params)).toEqual(params);
    expect(SearchParamsSchema.parse(unset)).toEqual(unset);
    expect(SearchParamsSchema.safeParse({ ...params, query: 'q'.repeat(PROJECT_QUERY_MAX_CHARS) }).success).toBe(true);
    expect(SearchParamsSchema.safeParse({ ...params, language: 'zh-hant-tw' }).success).toBe(true);
    expect(SearchParamsSchema.safeParse({ ...params, query: 'café 東京 😀' }).success).toBe(true);
    const { device: _device, ...missing } = params;
    const refused: unknown[] = [
      { ...params, page: 2 },
      missing,
      { ...params, engine: 'altavista' },
      { ...params, query: '' },
      { ...params, query: '   ' },
      { ...params, query: ' padded' },
      { ...params, query: 'q'.repeat(PROJECT_QUERY_MAX_CHARS + 1) },
      { ...params, query: 'line\nbreak' },
      { ...params, country: 'DE' },
      { ...params, country: 'deu' },
      { ...params, language: 'english' },
      { ...params, language: 'de-DE' },
      { ...params, language: 'EN' },
      { ...params, query: 'abc\u202edef' },
      { ...params, query: 'left\u200fmark' },
      { ...params, location: 'Berlin\u2066' },
      { ...params, query: 'lone \ud800 surrogate' },
      { ...params, location: 'trail \udc00' },
      { ...params, language: `en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}` },
      { ...params, location: '' },
      { ...params, location: 'x'.repeat(101) },
      { ...params, location: 'Berlin\u0007' },
      { ...params, device: 'tablet' },
      { ...params, device: undefined },
    ];
    for (const value of refused) expect(SearchParamsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('capture snapshot', () => {
  const refused = (edit: (s: CaptureSnapshot) => void) => CaptureSnapshotSchema.safeParse(edited(edit)).success;
  const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

  test('capture-snapshot-schema-caps', () => {
    expect(CaptureSnapshotSchema.parse(base())).toEqual(base());
    // Lists one over their caps.
    expect(refused((s) => { s.headings = many(L.maxHeadings + 1, () => ({ level: 2, text: 'h', region: 'main' })); })).toBe(false);
    expect(refused((s) => { s.links.list = many(L.maxLinks + 1, (i) => ({ href: `https://example.com/${i}`, text: '', rel: '', region: 'main' })); })).toBe(false);
    expect(refused((s) => { s.head.hreflang = many(L.maxHreflang + 1, (i) => ({ hreflang: `x${i}`, href: 'https://example.com/' })); })).toBe(false);
    expect(refused((s) => { s.structuredData.blocks = many(L.maxJsonLdBlocks + 1, (i) => ({ types: [], hash: sha(String(i)), text: '{}' })); })).toBe(false);
    expect(refused((s) => { s.structuredData.types = many(L.maxTypes + 1, (i) => `T${String(i).padStart(3, '0')}`); })).toBe(false);
    expect(refused((s) => { s.audit.findings = many(L.maxFindings + 1, (i) => `r${String(i).padStart(3, '0')}`); })).toBe(false);
    expect(refused((s) => { s.regions.main = region(many(L.maxBlocksPerRegion + 1, () => 'b')); })).toBe(false);
    // At the caps is fine.
    expect(refused((s) => { s.headings = many(L.maxHeadings, () => ({ level: 2, text: 'h'.repeat(L.maxHeadingChars), region: 'main' })); })).toBe(true);
    // Strings one over their caps.
    expect(refused((s) => { s.head.title = 't'.repeat(L.maxHeadChars + 1); })).toBe(false);
    expect(refused((s) => { s.head.canonical = `https://example.com/${'p'.repeat(L.maxUrlChars)}`; })).toBe(false);
    expect(refused((s) => { s.headings[0]!.text = 'h'.repeat(L.maxHeadingChars + 1); })).toBe(false);
    expect(refused((s) => { s.links.list[0]!.text = 'a'.repeat(L.maxAnchorChars + 1); })).toBe(false);
    expect(refused((s) => { s.links.list[0]!.href = `https://example.com/${'p'.repeat(L.maxUrlChars)}`; })).toBe(false);
    expect(refused((s) => { s.regions.main.blocks[0] = 'b'.repeat(L.maxBlockChars + 1); })).toBe(false);
    expect(refused((s) => { s.structuredData.blocks[0]!.text = 'j'.repeat(L.maxJsonLdBlockChars + 1); })).toBe(false);
    expect(refused((s) => { s.structuredData.types = ['T'.repeat(L.maxTypeChars + 1)]; })).toBe(false);
    // A region whose blocks together are over maxRegionChars.
    expect(refused((s) => { s.regions.main = region(many(Math.ceil(L.maxRegionChars / L.maxBlockChars) + 1, () => 'b'.repeat(L.maxBlockChars))); })).toBe(false);
    // Shape: sorted unique lists, every region, no unknown key, valid numbers.
    expect(refused((s) => { s.audit.findings = ['title-too-short', 'meta-description-too-short']; })).toBe(false);
    expect(refused((s) => { s.audit.findings = ['a', 'a']; })).toBe(false);
    expect(refused((s) => { delete (s.regions as Partial<CaptureSnapshot['regions']>).other; })).toBe(false);
    expect(refused((s) => { (s as unknown as Record<string, unknown>).extra = 1; })).toBe(false);
    expect(refused((s) => { (s.head as unknown as Record<string, unknown>).keywords = 'x'; })).toBe(false);
    expect(refused((s) => { s.version = 2 as 1; })).toBe(false);
    expect(refused((s) => { s.url = 'file:///etc/passwd'; })).toBe(false);
    expect(refused((s) => { s.audit.score = 101; })).toBe(false);
    expect(refused((s) => { s.http.status = 99; })).toBe(false);
    expect(refused((s) => { s.images.total = -1; })).toBe(false);
    expect(refused((s) => { s.regions.main.textHash = 'nothex'; })).toBe(false);
    expect(refused((s) => { s.regions.main.blocks = ['']; })).toBe(false);

    // A diff whose numbers disagree is refused.
    const good = diff(base(), edited((s) => { s.head.title = 'Other'; }));
    expect(SnapshotDiffSchema.safeParse(good).success).toBe(true);
    expect(SnapshotDiffSchema.safeParse({ ...good, changeCount: 2 }).success).toBe(false);
    expect(SnapshotDiffSchema.safeParse({ ...good, truncated: true }).success).toBe(false);
    expect(SnapshotDiffSchema.safeParse({ ...good, changes: [{ ...good.changes[0]!, before: null }] }).success).toBe(false);
    expect(SnapshotDiffSchema.safeParse({ ...good, changes: [{ ...good.changes[0]!, field: 'colour' }] }).success).toBe(false);
    expect(SnapshotDiffSchema.safeParse({ ...good, partial: undefined }).success).toBe(false);
    // Untruncated: the summary is exactly the changes' counts.
    const zero = { added: 0, removed: 0, changed: 0 };
    expect(SnapshotDiffSchema.safeParse({ ...good, summary: { ...good.summary, head: zero, http: { ...zero, changed: 1 } } }).success).toBe(false);
    // Segments only on a changed text block, and they must rebuild it.
    expect(SnapshotDiffSchema.safeParse({ ...good, changes: [{ ...good.changes[0]!, segments: [{ op: 'del', text: 'Frost pricing' }, { op: 'ins', text: 'Other' }] }] }).success).toBe(false);
    const text = diff(base(), edited((s) => { s.regions.main.blocks[1] = 'Plans start at twelve dollars a month for one seat.'; }));
    expect(text.changes.find((c) => c.field === 'text')?.segments).toBeDefined();
    const broken = (segments: { op: 'same' | 'del' | 'ins'; text: string }[]) => ({ ...text, changes: text.changes.map((c) => (c.field === 'text' ? { ...c, segments } : c)) });
    expect(SnapshotDiffSchema.safeParse(broken(text.changes.find((c) => c.field === 'text')!.segments!)).success).toBe(true);
    expect(SnapshotDiffSchema.safeParse(broken([{ op: 'del', text: 'something else' }, { op: 'ins', text: 'entirely' }])).success).toBe(false);
  });

  // Every diff any test in this file made went through `SnapshotDiffSchema` (fixtures' `diff`).
  afterAll(() => {
    expect(diffsChecked).toBeGreaterThan(0);
  });
});
