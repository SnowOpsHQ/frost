// Spec: specs/rankings.feature.md (Comparison) and specs/rankings.spec.ts (COMPARE_MOVEMENTS,
// SerpComparison, RANK_LIMITS).
import { expect, test } from 'vitest';
import { COMPARE_MOVEMENTS, RANK_LIMITS, type SerpObservation, type SerpReadyShape, type SerpResultShape, type SiteMatch } from '@app/specs/rankings.spec';
import { compareSerps } from '../index';
import { DAY, NOW, UNREADABLE, observe, organic, paramsOf, ready } from './serp-fixtures';

const SITE: SiteMatch = { owner: 'example.com', host: 'example.com', subdomains: true };
const RIVAL: SiteMatch = { owner: 'rival.org', host: 'rival.org', subdomains: true };

test('compare-two-readings', () => {
  // spec: rankings.feature.md — Comparison: per domain up/down/same/new/gone; features; site and competitors flagged
  const a = observe(
    ready([
      { type: 'featured-snippet', url: 'https://example.com/f' },
      organic('https://down.org/1'),
      organic('https://same.org/2'),
      { type: 'ad', url: 'https://ads.org/x' },
      organic('https://up.org/3'),
      organic('https://gone.org/4'),
      { type: 'people-also-ask', url: null, title: 'Is tea good?' },
      organic('https://example.com/5'),
      organic('https://rival.org/6'),
      organic('https://www.example.com/7'),
    ]),
    NOW - DAY,
  );
  const b = observe(
    ready(
      [
        { type: 'people-also-ask', url: null, title: 'Is tea good?' },
        organic('https://up.org/1'),
        organic('https://same.org/2'),
        organic('https://down.org/3'),
        { type: 'ai-overview', url: 'https://rival.org/ai' },
        organic('https://new.org/4'),
        organic('https://shop.rival.org/5'),
        organic('https://example.com/6'),
      ],
      { params: paramsOf({ query: 'tea' }) },
    ),
    NOW,
  );
  const comparison = compareSerps(a, b, { site: SITE, competitors: [RIVAL] });
  expect(comparison.rows.map((row) => [row.domain, row.a?.position ?? null, row.b?.position ?? null, row.movement, row.change, row.role])).toEqual([
    ['up.org', 3, 1, 'up', 2, null],
    ['same.org', 2, 2, 'same', 0, null],
    ['down.org', 1, 3, 'down', -2, null],
    ['new.org', null, 4, 'new', null, null],
    ['rival.org', 6, 5, 'up', 1, 'competitor'],
    ['example.com', 5, 6, 'down', -1, 'site'],
    ['gone.org', 4, null, 'gone', null, null],
  ]);
  for (const row of comparison.rows) expect(COMPARE_MOVEMENTS).toContain(row.movement);
  expect(comparison.rows.find((row) => row.domain === 'example.com')!.a).toEqual({ position: 5, url: 'https://example.com/5' });
  expect(comparison.rows.some((row) => row.domain === 'ads.org')).toBe(false);
  expect(comparison.features).toEqual([
    { type: 'featured-snippet', a: true, b: false },
    { type: 'people-also-ask', a: true, b: true },
    { type: 'ai-overview', a: false, b: true },
  ]);
  expect(comparison.a).toEqual({ readingId: a.id, at: NOW - DAY, params: a.params, filters: {}, status: 'ready', organicRead: 7, complete: true, features: ['featured-snippet', 'people-also-ask'] });
  expect(comparison.b).toMatchObject({ readingId: b.id, status: 'ready', organicRead: 6, features: ['people-also-ask', 'ai-overview'] });
  expect(comparison.site?.a).toMatchObject({ outcome: 'ranked', position: 5, alsoIn: ['featured-snippet'] });
  expect(comparison.site?.b).toMatchObject({ outcome: 'ranked', position: 6 });
  expect(comparison.truncated).toBe(false);
  // The site's points use the full rule (exact host, subdomains off); its row is flagged by owner domain.
  const exact = compareSerps(a, b, { site: { ...SITE, host: 'shop.example.com', subdomains: false } });
  expect(exact.site?.a.outcome).toBe('not-found');
  expect(exact.rows.find((row) => row.domain === 'example.com')!.role).toBe('site');
  expect(exact.rows.find((row) => row.domain === 'rival.org')!.role).toBeNull();
  // No site: no site points; an unreadable side has no organic results.
  const half = compareSerps(observe(UNREADABLE, NOW - DAY), b, { site: null });
  expect(half.site).toBeNull();
  expect(half.a).toMatchObject({ status: 'unreadable', organicRead: 0, features: [] });
  expect(half.rows.every((row) => row.movement === 'new')).toBe(true);
});

test('compare-is-bounded', () => {
  // spec: rankings.feature.md — Comparison: at most RANK_LIMITS.maxRows rows, the site's and competitors' kept; never throws
  const many = (count: number, offset: number, extra: readonly string[] = []): SerpReadyShape => {
    const domains = [...Array.from({ length: count }, (_, i) => `d${i + offset}.org`), ...extra];
    const results: SerpResultShape[] = domains.map((domain, i) => ({ rank: i + 1, type: 'organic', position: i + 1, featureSlot: null, title: domain, url: `https://${domain}/`, redirected: false, domain }));
    return { ...ready([organic('https://x.org/')]), results, ownership: { page: 1, organic: results.length, complete: true, domains: [] } };
  };
  const a = observe(many(300, 0), NOW - DAY);
  const b = observe(many(300, 200, ['rival.org', 'example.com']), NOW);
  const comparison = compareSerps(a, b, { site: SITE, competitors: [RIVAL] });
  expect(comparison.rows).toHaveLength(RANK_LIMITS.maxRows);
  expect(comparison.truncated).toBe(true);
  expect(comparison.rows.find((row) => row.domain === 'example.com')).toMatchObject({ role: 'site', movement: 'new', b: { position: 302 } });
  expect(comparison.rows.find((row) => row.domain === 'rival.org')).toMatchObject({ role: 'competitor', movement: 'new' });
  expect(comparison.rows[0]).toMatchObject({ domain: 'd200.org', movement: 'up' });
  const bs = comparison.rows.map((row) => row.b?.position ?? Number.POSITIVE_INFINITY);
  expect(bs.every((value, i) => i === 0 || bs[i - 1]! <= value)).toBe(true);
  // Garbage never throws.
  const junk = [null, undefined, 3, {}, { id: 'x', snapshot: { status: 'ready', results: [null, { type: 'organic', position: 'one', domain: 5 }] } }] as unknown as SerpObservation[];
  for (const x of junk) for (const y of junk) expect(() => compareSerps(x, y, { site: SITE, competitors: [RIVAL] })).not.toThrow();
  expect(() => compareSerps(a, b, null as never)).not.toThrow();
  expect(compareSerps(null as never, null as never, { site: null }).rows).toEqual([]);
});
