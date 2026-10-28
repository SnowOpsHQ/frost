// Spec: specs/serp-snapshot.schema.ts (SerpReadSchema, SerpSnapshotSchema, the result model),
// specs/serp.spec.ts (SERP_READ_LIMITS, SERP_FEATURE_TYPES, SERP_UNREADABLE_REASONS), specs/serp-search-params.schema.ts
// Acceptance: specs/serp-overlay.feature.md (Analysis)
import { describe, expect, test } from 'vitest';
import { SERP_RESULT_TYPES } from '@app/specs/serp-selector-pack.spec';
import { SERP_FEATURE_TYPES, SERP_READ_LIMITS, isSerpFeature } from '@app/specs/serp.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpSnapshotSchema, type SerpReadBlock } from '@app/specs/serp-snapshot.schema';
import { analyseSerp } from '../serp-analyse';

const PARAMS: SearchParams = { engine: 'google', engineLabel: 'Google', query: 'frost', gl: 'us', hl: 'en', device: 'desktop', page: 1, url: 'https://www.google.com/search?q=frost' };
const CONTEXT = { params: PARAMS, packVersion: 1 };
const STATS = { nodes: 120, elapsedMs: 3.5, truncated: false };

const item = (title: string, url: string | null = null) => ({ title, url });
const block = (type: SerpReadBlock['type'], ...items: ReturnType<typeof item>[]): SerpReadBlock => ({ type, items });
const ok = (...blocks: SerpReadBlock[]) => ({ ok: true, blocks, stats: STATS });

/** A page like the Google fixture: ads, a snippet, organic results around related questions and a video, a panel, related searches. */
const PAGE = ok(
  block('ad', item('Ad one', 'https://ads.example.net/a'), item('Ad two', 'https://www.example.com/sale')),
  block('featured-snippet', item('Snippet', 'https://www.icecrystal.example/what')),
  block('organic', item('One', 'https://www.example.com/frost'), item('Two', 'https://blog.example.org/tips')),
  block('people-also-ask', item('Why?'), item('When?'), item('How?')),
  block('organic', item('Three', 'https://example.com/history')),
  block('video', item('Video', 'https://video.example.net/watch')),
  block('organic', item('Four', 'https://www.frostline.example/'), item('Five', 'https://shop.example.com/frost')),
  block('ad', item('Ad three', 'https://ads.example.net/b')),
  block('knowledge-panel', item('Frost', 'https://encyclopedia.example.org/frost')),
  block('related-searches', item('frost on windows', 'https://www.google.com/search?q=frost+on+windows'), item('black frost', 'https://www.google.com/search?q=black+frost')),
);

describe('analysis', () => {
  test('serp-analyse-positions', () => {
    const snapshot = analyseSerp(PAGE, CONTEXT);
    expect(SerpSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.status).toBe('ready');
    if (snapshot.status !== 'ready') return;
    expect(snapshot.params).toEqual(PARAMS);
    expect(snapshot.packVersion).toBe(1);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.results.map((r) => [r.rank, r.type, r.position, r.featureSlot, r.title])).toEqual([
      [1, 'ad', 1, null, 'Ad one'],
      [2, 'ad', 2, null, 'Ad two'],
      [3, 'featured-snippet', null, 1, 'Snippet'],
      [4, 'organic', 1, null, 'One'],
      [5, 'organic', 2, null, 'Two'],
      [6, 'people-also-ask', null, 2, 'Why?'],
      [7, 'people-also-ask', null, 2, 'When?'],
      [8, 'people-also-ask', null, 2, 'How?'],
      [9, 'organic', 3, null, 'Three'],
      [10, 'video', null, 3, 'Video'],
      [11, 'organic', 4, null, 'Four'],
      [12, 'organic', 5, null, 'Five'],
      [13, 'ad', 3, null, 'Ad three'],
      [14, 'knowledge-panel', null, 4, 'Frost'],
      [15, 'related-searches', null, 5, 'frost on windows'],
      [16, 'related-searches', null, 5, 'black frost'],
    ]);
    // Domains through the registrable domain; no link, no domain.
    expect(snapshot.results.map((r) => r.domain).slice(0, 8)).toEqual(['example.net', 'example.com', 'icecrystal.example', 'example.com', 'example.org', null, null, null]);
    expect(snapshot.composition.counts).toEqual({
      ...Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, 0])),
      organic: 5,
      ad: 3,
      'featured-snippet': 1,
      'people-also-ask': 3,
      video: 1,
      'knowledge-panel': 1,
      'related-searches': 2,
    });
    expect(snapshot.composition.features).toEqual([
      { slot: 1, type: 'featured-snippet', results: 1 },
      { slot: 2, type: 'people-also-ask', results: 3 },
      { slot: 3, type: 'video', results: 1 },
      { slot: 4, type: 'knowledge-panel', results: 1 },
      { slot: 5, type: 'related-searches', results: 2 },
    ]);
    // Two blocks of one feature type take two slots.
    const twice = analyseSerp(ok(block('video', item('V1', 'https://v.example/1')), block('organic', item('O', 'https://o.example/')), block('video', item('V2', 'https://v.example/2'))), CONTEXT);
    expect(twice.status === 'ready' && twice.composition.features.map((f) => [f.slot, f.type])).toEqual([
      [1, 'video'],
      [2, 'video'],
    ]);
    // Positions are the page's own: page 2 starts at 1 again.
    const page2 = analyseSerp(PAGE, { ...CONTEXT, params: { ...PARAMS, page: 2 } });
    expect(page2.status === 'ready' && [page2.results.find((r) => r.type === 'organic')?.position, page2.ownership.page]).toEqual([1, 2]);
    // The feature list in the spec is every type but organic and ad.
    expect(SERP_FEATURE_TYPES).toEqual(SERP_RESULT_TYPES.filter((type) => isSerpFeature(type)));
  });

  test('serp-ownership-share', () => {
    const snapshot = analyseSerp(PAGE, CONTEXT);
    if (snapshot.status !== 'ready') throw new Error('not ready');
    // www.example.com, example.com and shop.example.com are one registrable domain; the ad on example.com is not counted.
    expect(snapshot.ownership).toEqual({
      page: 1,
      organic: 5,
      domains: [
        { domain: 'example.com', count: 3, share: 3 / 5, positions: [1, 3, 5], best: 1 },
        { domain: 'example.org', count: 1, share: 1 / 5, positions: [2], best: 2 },
        { domain: 'frostline.example', count: 1, share: 1 / 5, positions: [4], best: 4 },
      ],
    });
    // Sorted by count, then best position.
    const tie = analyseSerp(ok(block('organic', item('a', 'https://a.example/'), item('b', 'https://b.example/'), item('b2', 'https://www.b.example/2'), item('c', 'https://c.example/'), item('a2', 'https://a.example/2'))), CONTEXT);
    expect(tie.status === 'ready' && tie.ownership.domains.map((d) => [d.domain, d.count, d.best])).toEqual([
      ['a.example', 2, 1],
      ['b.example', 2, 2],
      ['c.example', 1, 4],
    ]);
    // No organic results: nobody owns the page.
    const adsOnly = analyseSerp(ok(block('ad', item('Ad', 'https://ads.example.net/')), block('people-also-ask', item('Q?'))), CONTEXT);
    expect(adsOnly.status === 'ready' && adsOnly.ownership).toEqual({ page: 1, organic: 0, domains: [] });
  });

  test('serp-analyse-unreadable', () => {
    for (const reason of ['no-container', 'no-results', 'bad-selector', 'timeout'] as const) {
      expect(analyseSerp({ ok: false, reason, stats: STATS }, CONTEXT)).toEqual({ status: 'unreadable', reason, params: PARAMS, packVersion: 1 });
    }
    // A timeout's partial blocks are never analysed.
    expect(analyseSerp({ ok: false, reason: 'timeout', stats: STATS, blocks: PAGE.blocks }, CONTEXT)).toMatchObject({ status: 'unreadable', reason: 'timeout' });
    const tooMany = block('organic', ...Array.from({ length: SERP_READ_LIMITS.maxResults + 1 }, (_, i) => item(`r${i}`, `https://r${i}.example/`)));
    const split = Array.from({ length: SERP_READ_LIMITS.maxResults + 1 }, (_, i) => block('organic', item(`r${i}`, `https://r${i}.example/`)));
    for (const garbage of [
      undefined,
      null,
      'blocks',
      42,
      { ok: true },
      { ok: true, blocks: [], stats: STATS, extra: 1 },
      { ok: false, reason: 'pack-invalid', stats: STATS },
      { ok: false, reason: 'no-container', stats: STATS, blocks: [] },
      ok(tooMany),
      ok(...split),
      ok(block('organic', item('No link'))),
      ok(block('people-also-ask', item(''))),
      ok(block('organic', item('x'.repeat(SERP_READ_LIMITS.maxTitleChars + 1), 'https://a.example/'))),
      ok(block('organic', item('Script', 'javascript:alert(1)'))),
      ok(block('organic', { title: 'Extra', url: 'https://a.example/', html: '<b>' } as never)),
      { ok: true, blocks: [], stats: { ...STATS, nodes: SERP_READ_LIMITS.maxNodesVisited + 1 } },
    ]) {
      expect(analyseSerp(garbage, CONTEXT), JSON.stringify(garbage)?.slice(0, 80)).toEqual({ status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: 1 });
    }
    // An empty read is unreadable by the reader's own rule, never a ready page with nothing on it.
    expect(analyseSerp(ok(), CONTEXT)).toMatchObject({ status: 'unreadable', reason: 'no-results' });
    // Invalid parameters or pack version are not recorded.
    expect(analyseSerp(PAGE, { params: { ...PARAMS, page: 0 }, packVersion: 1 })).toEqual({ status: 'unreadable', reason: 'invalid-answer', params: null, packVersion: 1 });
    expect(analyseSerp(PAGE, { params: { ...PARAMS, gl: 'U S' }, packVersion: 1 })).toMatchObject({ reason: 'invalid-answer', params: null });
    expect(analyseSerp(PAGE, { params: PARAMS, packVersion: 0 })).toEqual({ status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: null });
    expect(analyseSerp(PAGE, { params: undefined, packVersion: 'one' })).toEqual({ status: 'unreadable', reason: 'invalid-answer', params: null, packVersion: null });
  });
});
