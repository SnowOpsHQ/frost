// Spec: specs/rankings.feature.md (the rank read model; plan Decisions 3–7 and 15) and
// specs/rankings.spec.ts (RANK_OUTCOMES, RANK_RANGES, rangeStart, RANK_LIMITS, the CSV columns, labels).
import { describe, expect, test } from 'vitest';
import {
  MAX_PROJECT_COMPETITORS,
  RANK_CSV_COLUMNS,
  RANK_HISTORY_CSV_COLUMNS,
  RANK_HISTORY_NOTE,
  RANK_LIMITS,
  RANK_OUTCOMES,
  SEARCH_KEY_VERSION,
  changeLabel,
  rangeStart,
  rankHistoryNote,
  rankLabel,
  type RankPoint,
  type SavedSearchRef,
  type SerpObservation,
  type SerpSnapshotShape,
  type SiteMatch,
} from '@app/specs/rankings.spec';
import { rankCsvRows, rankOf, rankRowOf, rankSeries, rankTable } from '../index';
import { DAY, KEY, NOW, PARAMS, UNREADABLE, keyOf, observe, organic, page, paramsOf, ready } from './serp-fixtures';

const SITE: SiteMatch = { owner: 'example.com', host: 'example.com', subdomains: true };
const EXACT: SiteMatch = { owner: 'example.com', host: 'example.com', subdomains: false };

const saved = (id: string, query: string, tags: string[] = []): SavedSearchRef => {
  const params = paramsOf({ query });
  return { id, searchKey: keyOf(params, {})!, params, filters: {}, tags };
};

describe('rank-of-ready-reading', () => {
  // spec: rankings.feature.md — What a position is (Decision 6)
  test('best organic position; ads and features never a position; alsoIn', () => {
    const snapshot = ready([
      { type: 'ad', url: 'https://www.example.com/buy' },
      { type: 'featured-snippet', url: 'https://www.example.com/what-is-tea' },
      organic('https://other.org/a'),
      organic('https://another.net/b'),
      { type: 'ai-overview', url: 'https://example.com/ai' },
      organic('https://third.org/c'),
      organic('https://www.example.com/tea'),
      organic('https://four.org/d'),
      { type: 'featured-snippet', url: 'https://example.com/again' },
      organic('https://five.org/e'),
      organic('https://six.org/f'),
      organic('https://www.example.com/second'),
    ]);
    const reading = observe(snapshot, NOW);
    const point = rankOf(reading, SITE);
    expect(point).toEqual({
      readingId: reading.id,
      at: NOW,
      outcome: 'ranked',
      position: 4,
      url: 'https://www.example.com/tea',
      organicRead: 8,
      page: 1,
      alsoIn: ['featured-snippet', 'ai-overview'],
    } satisfies RankPoint);
    expect(RANK_OUTCOMES).toContain(point.outcome);
  });

  test('a site only in an ad and a feature has no position', () => {
    const snapshot = ready([{ type: 'ad', url: 'https://www.example.com/buy' }, { type: 'people-also-ask', url: 'https://example.com/faq' }, organic('https://other.org/a'), organic('https://another.net/b')]);
    const point = rankOf(observe(snapshot, NOW), SITE);
    expect(point.outcome).toBe('not-found');
    expect(point.position).toBeNull();
    expect(point.url).toBeNull();
    expect(point.alsoIn).toEqual(['people-also-ask']);
    expect(point.organicRead).toBe(2);
  });
});

test('rank-subdomain-rule', () => {
  // spec: rankings.feature.md — Whose result it is (Decision 7), including the one-`www.` rule
  const at = (url: string, site: SiteMatch) => rankOf(observe(ready([organic('https://other.org/a'), organic(url)]), NOW), site);
  // On: the owner domain (the result's `domain`).
  expect(at('https://shop.example.com/x', SITE).position).toBe(2);
  expect(at('https://www.example.com/x', SITE).position).toBe(2);
  expect(at('https://example.org/x', SITE).outcome).toBe('not-found');
  // Off: the exact host, one leading `www.` ignored on either side.
  expect(at('https://www.example.com/x', EXACT).position).toBe(2);
  expect(at('https://example.com/x', EXACT).position).toBe(2);
  expect(at('https://example.com/x', { ...EXACT, host: 'www.example.com' }).position).toBe(2);
  expect(at('https://shop.example.com/x', EXACT).outcome).toBe('not-found');
  expect(at('https://www.www.example.com/x', EXACT).outcome).toBe('not-found');
  expect(at('https://shop.example.com/x', { ...EXACT, host: 'shop.example.com' }).position).toBe(2);
  // A port, `user@` part, query or fragment does not change the host.
  expect(at('https://user@www.example.com:8443/x?y=1', EXACT).position).toBe(2);
  expect(at('https://example.com?y=1', EXACT).position).toBe(2);
  expect(at('https://example.com#top', EXACT).position).toBe(2);
  // A result with no domain (a link Phase 3 could not use) is never the site's, in either mode.
  const noDomain = ready([organic('https://www.example.com/x', null)]);
  expect(rankOf(observe(noDomain, NOW), SITE).outcome).toBe('not-found');
  expect(rankOf(observe(noDomain, NOW), EXACT).outcome).toBe('not-found');
  // Another host dressed up as the site never matches: a `user@` part, a backslash, the site's name in the path or query.
  for (const evil of ['https://example.com@evil.com/', 'https://example.com\\@evil.com/', 'https://evil.com/p@example.com', 'https://evil.com/?x=@example.com', 'https://example.com;@evil.com/']) {
    const reading = observe(ready([organic(evil, 'evil.com')]), NOW);
    expect(rankOf(reading, EXACT).outcome, evil).toBe('not-found');
    expect(rankOf(reading, SITE).outcome, evil).toBe('not-found');
  }
});

test('rank-not-found-vs-unknown', () => {
  // spec: rankings.feature.md — not-found needs ownership.complete; otherwise unknown
  const items = [organic('https://other.org/a'), organic('https://another.net/b'), organic('https://third.org/c')];
  const complete = rankOf(observe(ready(items), NOW), SITE);
  expect(complete).toMatchObject({ outcome: 'not-found', position: null, organicRead: 3 });
  expect(rankLabel(complete)).toBe('> 3');
  const cut = rankOf(observe(ready(items, { complete: false }), NOW), SITE);
  expect(cut).toMatchObject({ outcome: 'unknown', position: null, organicRead: 3 });
  expect(rankLabel(cut)).toBe('Unknown');
  // Found among what was read: ranked, even when a cap cut the rest.
  expect(rankOf(observe(ready([...items, organic('https://example.com/')], { complete: false }), NOW), SITE).position).toBe(4);
});

test('rank-unreadable', () => {
  // spec: rankings.feature.md — an unreadable reading, or anything that is not a reading
  const point = rankOf(observe(UNREADABLE, NOW), SITE);
  expect(point).toMatchObject({ outcome: 'unreadable', position: null, url: null, organicRead: 0, page: 1, alsoIn: [] });
  const garbage = [null, 7, 'ready', {}, { status: 'ready' }, { status: 'ready', results: 'x' }, { status: 'ready', results: [null, 1, { type: 'organic' }] }];
  for (const snapshot of garbage) {
    const reading = { ...observe(UNREADABLE, NOW), snapshot } as unknown as SerpObservation;
    const answer = rankOf(reading, SITE);
    expect(['unreadable', 'not-found', 'unknown']).toContain(answer.outcome);
    expect(answer.position).toBeNull();
  }
  expect(rankOf({ ...observe(UNREADABLE, NOW), snapshot: null } as unknown as SerpObservation, SITE).outcome).toBe('unreadable');
  expect(rankLabel(point)).toBe('Unreadable');
});

test('rank-no-site', () => {
  // spec: rankings.feature.md — no site set: no position, nothing in alsoIn, whatever the reading
  const snapshot = ready([{ type: 'featured-snippet', url: 'https://example.com/x' }, organic('https://example.com/y')]);
  for (const reading of [observe(snapshot, NOW), observe(UNREADABLE, NOW)]) {
    const point = rankOf(reading, null);
    expect(point).toMatchObject({ outcome: 'no-site', position: null, url: null, alsoIn: [] });
    expect(rankLabel(point)).toBe('No site set');
  }
  expect(rankOf(observe(snapshot, NOW), null).organicRead).toBe(1);
});

test('rank-page-two-keeps-page', () => {
  // spec: rankings.feature.md — a page-2 reading keeps its page-local position and its page
  const snapshot = ready([organic('https://other.org/a'), organic('https://another.net/b'), organic('https://example.com/c')], { page: 2 });
  const point = rankOf(observe(snapshot, NOW), SITE);
  expect(point).toMatchObject({ outcome: 'ranked', position: 3, page: 2 });
  expect(rankLabel(point)).toBe('p2 · 3');
  const absent = rankOf(observe(ready([organic('https://other.org/a')], { page: 2 }), NOW), SITE);
  expect(rankLabel(absent)).toBe('p2 · > 1');
});

describe('rank-change-and-best', () => {
  // spec: rankings.feature.md — Series, change and best
  const rowOf = (pages: SerpSnapshotShape[], options: { range?: '7d' | 'all' } = {}) => {
    const readings = pages.map((snapshot, index) => observe(snapshot, NOW - (pages.length - index) * DAY));
    const table = rankTable(readings, { site: SITE, ...options, now: NOW });
    expect(table.rows).toHaveLength(1);
    return table.rows[0]!;
  };

  test('change only between two ranked points; lost and new', () => {
    expect(rowOf([page(5), page(3)]).change).toBe(2);
    expect(rowOf([page(3), page(6)]).change).toBe(-3);
    expect(rowOf([page(4), page(4)]).change).toBe(0);
    expect(rowOf([page(4), page(null)]).change).toBe('lost');
    expect(rowOf([page(null), page(4)]).change).toBe('new');
    expect(rowOf([page(null), page(null)]).change).toBeNull();
    expect(rowOf([page(4), UNREADABLE]).change).toBeNull();
    expect(rowOf([UNREADABLE, page(4)]).change).toBeNull();
    const cut = ready([organic('https://other.org/a')], { complete: false });
    expect(rowOf([page(4), cut]).change).toBeNull();
    expect(rowOf([cut, page(4)]).change).toBeNull();
    expect(rowOf([page(4)]).change).toBeNull();
    expect(changeLabel(2)).toBe('+2');
    expect(changeLabel(-3)).toBe('-3');
    expect(changeLabel(0)).toBe('0');
    expect(changeLabel('new')).toBe('new');
    expect(changeLabel('lost')).toBe('lost');
    expect(changeLabel(null)).toBe('');
  });

  test('best is the best ranked point in range; latest and previous ignore the range', () => {
    const row = rowOf([page(2), page(9), page(null), page(5), page(7)]);
    expect(row.best).toBe(2);
    expect(row.latest?.position).toBe(7);
    expect(row.previous?.position).toBe(5);
    expect(row.points.map((p) => p.position)).toEqual([2, 9, null, 5, 7]);
    const old = [page(1), page(3)].map((snapshot, index) => observe(snapshot, NOW - (30 - index) * DAY));
    const recent = observe(page(6), NOW - DAY);
    const ranged = rankTable([...old, recent], { site: SITE, range: '7d', now: NOW }).rows[0]!;
    expect(ranged.points.map((p) => p.position)).toEqual([6]);
    expect(ranged.best).toBe(6);
    expect(ranged.previous?.position).toBe(3);
    expect(ranged.change).toBe(-3);
    expect(rowOf([page(null), UNREADABLE]).best).toBeNull();
  });

  test('best covers every reading in range, not only the newest maxPointsPerSeries points', () => {
    const count = RANK_LIMITS.maxPointsPerSeries + 50;
    const readings = Array.from({ length: count }, (_, i) => observe(page(i === 0 ? 1 : 5), NOW - (count - i) * 60_000));
    const row = rankTable(readings, { site: SITE, range: '7d', now: NOW }).rows[0]!;
    expect(row.points).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
    expect(row.points.every((point) => point.position === 5)).toBe(true);
    expect(row.best).toBe(1);
    // Out of range, it no longer counts.
    expect(rankTable(readings, { site: SITE, range: '7d', now: NOW + 7 * DAY - (count - 1) * 60_000 }).rows[0]!.best).toBe(5);
  });

  test('a range needs the time it ends at', () => {
    // @ts-expect-error: `now` is required with a range
    expect(() => rankTable([], { site: SITE, range: '7d' })).not.toThrow();
    // @ts-expect-error: `now` is required with a range
    expect(() => rankSeries([], KEY, { site: SITE, range: 'all' })).not.toThrow();
  });
});

test('rank-range-filters-points', () => {
  // spec: rankings.feature.md — the range, and at most maxPointsPerSeries points
  expect(rangeStart('7d', NOW)).toBe(NOW - 7 * DAY);
  expect(rangeStart('30d', NOW)).toBe(NOW - 30 * DAY);
  expect(rangeStart('90d', NOW)).toBe(NOW - 90 * DAY);
  expect(rangeStart('365d', NOW)).toBe(NOW - 365 * DAY);
  expect(rangeStart('all', NOW)).toBe(0);
  expect(rangeStart('7d', 3 * DAY)).toBe(0);
  expect(rangeStart('nope' as never, NOW)).toBe(0);
  expect(rangeStart('7d', Number.NaN)).toBe(0);
  const readings = [40, 20, 8, 7, 3, 0].map((days) => observe(page(1), NOW - days * DAY));
  const days = (range: '7d' | '30d' | '90d' | 'all') => rankSeries(readings, KEY, { site: SITE, range, now: NOW }).map((p) => (NOW - p.at) / DAY);
  expect(days('7d')).toEqual([7, 3, 0]);
  expect(days('30d')).toEqual([20, 8, 7, 3, 0]);
  expect(days('all')).toEqual([40, 20, 8, 7, 3, 0]);
  expect(rankSeries(readings, 'another key', { site: SITE })).toEqual([]);
  // At most maxPointsPerSeries, the newest, oldest first.
  const many = Array.from({ length: RANK_LIMITS.maxPointsPerSeries + 25 }, (_, i) => observe(page(1), NOW - i * 60_000));
  const series = rankSeries([...many].reverse(), KEY, { site: SITE });
  expect(series).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
  expect(series.at(-1)!.at).toBe(NOW);
  expect(series[0]!.at).toBe(NOW - (RANK_LIMITS.maxPointsPerSeries - 1) * 60_000);
  expect(series.every((p, i) => i === 0 || series[i - 1]!.at <= p.at)).toBe(true);
});

test('rank-table-saved-first-then-observed', () => {
  // spec: rankings.feature.md — The table (Decision 5)
  const tea = saved('s-tea', 'green tea', ['tea']);
  const coffee = saved('s-coffee', 'coffee', ['drinks']);
  const mate = saved('s-mate', 'mate', ['tea']);
  const seen = (query: string, at: number) => observe(ready([organic('https://example.com/x')], { params: paramsOf({ query }) }), at);
  const readings = [seen('green tea', NOW - 3 * DAY), seen('black tea', NOW - 2 * DAY), seen('coffee', NOW - 5 * DAY), seen('oolong', NOW - DAY), seen('green tea', NOW - DAY)];
  const table = rankTable(readings, { site: SITE, saved: [coffee, tea, mate, { ...tea, id: 's-dup' }], now: NOW });
  expect(table.truncated).toBe(false);
  expect(table.rows.map((row) => [row.params.query, row.saved?.id ?? null, row.points.length])).toEqual([
    ['coffee', 's-coffee', 1],
    ['green tea', 's-tea', 2],
    ['mate', 's-mate', 0],
    ['oolong', null, 1],
    ['black tea', null, 1],
  ]);
  const mateRow = table.rows[2]!;
  expect(mateRow).toMatchObject({ latest: null, previous: null, change: null, best: null, points: [], filters: {} });
  expect(mateRow.params).toEqual(mate.params);
  expect(table.rows[1]!.saved).toEqual({ id: 's-tea', tags: ['tea'] });
  // A tag keeps the saved searches carrying it only.
  expect(rankTable(readings, { site: SITE, saved: [coffee, tea, mate], tag: 'tea' }).rows.map((row) => row.saved?.id)).toEqual(['s-tea', 's-mate']);
  // At most maxRows rows.
  const lots = Array.from({ length: RANK_LIMITS.maxRows + 10 }, (_, i) => seen(`query ${i}`, NOW - i * 1_000));
  const capped = rankTable(lots, { site: SITE });
  expect(capped.rows).toHaveLength(RANK_LIMITS.maxRows);
  expect(capped.truncated).toBe(true);
  expect(capped.rows[0]!.params.query).toBe('query 0');
});

test('rank-competitor-columns', () => {
  // spec: rankings.feature.md — competitors from the same readings, keyed by host
  const rival: SiteMatch = { owner: 'rival.org', host: 'rival.org', subdomains: true };
  const other: SiteMatch = { owner: 'nowhere.net', host: 'nowhere.net', subdomains: true };
  const first = observe(ready([organic('https://rival.org/a'), organic('https://example.com/b')]), NOW - DAY);
  const second = observe(ready([organic('https://example.com/b'), organic('https://shop.rival.org/a')]), NOW);
  const table = rankTable([first, second], { site: SITE, competitors: [rival, other, rival], saved: [saved('s-none', 'nothing')] });
  const row = table.rows.find((r) => r.saved === null)!;
  expect(Object.keys(row.competitors)).toEqual(['rival.org', 'nowhere.net']);
  expect(row.competitors['rival.org']).toMatchObject({ outcome: 'ranked', position: 2, readingId: second.id });
  expect(row.competitors['nowhere.net']).toMatchObject({ outcome: 'not-found', position: null });
  const empty = table.rows.find((r) => r.saved?.id === 's-none')!;
  expect(empty.competitors).toEqual({ 'rival.org': null, 'nowhere.net': null });
  // Cut to MAX_PROJECT_COMPETITORS.
  const many = Array.from({ length: MAX_PROJECT_COMPETITORS + 5 }, (_, i): SiteMatch => ({ owner: `c${i}.org`, host: `c${i}.org`, subdomains: true }));
  expect(Object.keys(rankTable([second], { site: SITE, competitors: many }).rows[0]!.competitors)).toHaveLength(MAX_PROJECT_COMPETITORS);
});

test('rank-ignores-serp-api-or-capture-alike', () => {
  // spec: rankings.feature.md — Inputs: the source never changes a point (Decision 3)
  const snapshot = page(3);
  const capture = observe(snapshot, NOW - DAY, { source: 'capture' });
  const api = observe(snapshot, NOW, { source: 'serp-api' });
  const { readingId: _a, at: _x, ...fromCapture } = rankOf(capture, SITE);
  // Phase 12 Task 4: the point only says where it came from (`source`); its position is the same.
  const { readingId: _b, at: _y, source, ...fromApi } = rankOf(api, SITE);
  expect(source).toBe('serp-api');
  expect(fromApi).toEqual(fromCapture);
  const rows = rankTable([capture, api], { site: SITE }).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.points.map((p) => p.readingId)).toEqual([capture.id, api.id]);
  expect(rows[0]!.change).toBe(0);
});

test('rank-old-key-version-regrouped', () => {
  // spec: rankings.feature.md — The search key and its version (Decision 4)
  const current = observe(page(4), NOW);
  const old = observe(page(6), NOW - DAY, { searchKey: 'f'.repeat(64), searchKeyVersion: SEARCH_KEY_VERSION - 1 });
  const absentVersion = observe(page(5), NOW - 2 * DAY);
  expect(absentVersion.searchKeyVersion).toBeUndefined();
  const regrouped = rankTable([current, old, absentVersion], { site: SITE, keyOf });
  expect(regrouped.rows).toHaveLength(1);
  expect(regrouped.rows[0]!.searchKey).toBe(KEY);
  expect(regrouped.rows[0]!.points.map((p) => p.position)).toEqual([5, 6, 4]);
  expect(rankSeries([current, old], KEY, { site: SITE, keyOf }).map((p) => p.position)).toEqual([6, 4]);
  // Without a key function, or one that fails, the old reading keeps its stored key.
  expect(rankTable([current, old], { site: SITE }).rows.map((row) => row.searchKey)).toEqual([KEY, 'f'.repeat(64)]);
  const throwing = () => {
    throw new Error('no');
  };
  for (const broken of [throwing, () => null, () => 42 as unknown as string, () => '']) {
    expect(rankTable([current, old], { site: SITE, keyOf: broken }).rows.map((row) => row.searchKey)).toEqual([KEY, 'f'.repeat(64)]);
  }
  // A current-version reading is never re-keyed.
  const calls: string[] = [];
  rankTable([current], { site: SITE, keyOf: (p, f) => (calls.push(p.query), keyOf(p, f)) });
  expect(calls).toEqual([]);
});

test('rank-model-is-total', () => {
  // spec: rankings.feature.md — Inputs: any array, never throws; duplicate ids count once
  const good = observe(page(2), NOW);
  const garbage = [null, undefined, 1, 'x', [], {}, { id: 'a' }, { id: 'b', searchKey: 'k', observedAt: 'now', params: {} }, { id: 'c', searchKey: 'k', observedAt: NOW, params: null }, { ...good, observedAt: Number.NaN }, { ...good, params: { ...PARAMS, page: 'two' } }];
  const input = [...garbage, good, { ...good, observedAt: NOW - DAY }] as unknown as SerpObservation[];
  const table = rankTable(input, { site: SITE, competitors: [null, { owner: 1 }] as unknown as SiteMatch[], saved: [null, { id: 3 }] as unknown as SavedSearchRef[], range: 'bogus' as never, now: Number.NaN });
  expect(table.rows.map((row) => row.searchKey)).toContain(KEY);
  const row = table.rows.find((r) => r.searchKey === KEY)!;
  expect(row.points.map((p) => p.readingId)).toEqual([good.id]);
  expect(() => rankTable(null as never, null as never)).not.toThrow();
  expect(() => rankTable(input, { site: { owner: null, host: undefined, subdomains: 'yes' } as unknown as SiteMatch })).not.toThrow();
  expect(() => rankSeries(input, KEY, { site: SITE })).not.toThrow();
  expect(() => rankOf(null as never, SITE)).not.toThrow();
  expect(() => rankCsvRows(null as never, 'table')).not.toThrow();
  expect(() => rankCsvRows(table.rows, 'nope' as never)).not.toThrow();
});

test('rank-csv-rows', () => {
  // spec: rankings.feature.md — CSV rows (plain strings and numbers, ISO dates; no cell formatting here)
  const rival: SiteMatch = { owner: 'rival.org', host: 'rival.org', subdomains: true };
  const filtered = paramsOf({ query: '=cmd' });
  const readings = [
    observe(ready([organic('https://rival.org/a'), organic('https://example.com/b')]), Date.UTC(2026, 9, 1, 8)),
    observe(ready([{ type: 'featured-snippet', url: 'https://example.com/f' }, organic('https://example.com/c'), organic('https://rival.org/a')]), Date.UTC(2026, 9, 2, 8)),
    observe(ready([organic('https://rival.org/a')], { params: filtered }), Date.UTC(2026, 9, 3, 8), { searchKey: keyOf(filtered, { tbs: 'qdr:w', num: '20' })!, filters: { num: '20', tbs: 'qdr:w' } }),
  ];
  const table = rankTable(readings, { site: SITE, competitors: [rival], saved: [saved('s-tea', 'green tea', ['tea', 'main'])] });
  const csv = rankCsvRows(table.rows, 'table');
  expect(csv[0]).toEqual([...RANK_CSV_COLUMNS, 'rival.org']);
  expect(csv.slice(1)).toEqual([
    ['green tea', 'google', 'de', 'de', 'desktop', 1, '', 'tea; main', 'ranked', 1, 1, 1, 'https://example.com/c', '2026-10-02T08:00:00.000Z', 2],
    ['=cmd', 'google', 'de', 'de', 'desktop', 1, 'num=20 tbs=qdr:w', '', 'not-found', '', '', '', '', '2026-10-03T08:00:00.000Z', 1],
  ]);
  for (const line of csv) for (const cell of line) expect(['string', 'number']).toContain(typeof cell);
  const history = rankCsvRows(table.rows, 'history');
  expect(history[0]).toEqual([...RANK_HISTORY_CSV_COLUMNS]);
  expect(history.slice(1)).toEqual([
    ['green tea', 'google', 'de', 'de', 'desktop', 1, '', '2026-10-01T08:00:00.000Z', 'ranked', 2, 2, 'https://example.com/b', ''],
    ['green tea', 'google', 'de', 'de', 'desktop', 1, '', '2026-10-02T08:00:00.000Z', 'ranked', 1, 2, 'https://example.com/c', 'featured-snippet'],
    ['=cmd', 'google', 'de', 'de', 'desktop', 1, 'num=20 tbs=qdr:w', '2026-10-03T08:00:00.000Z', 'not-found', '', 1, '', ''],
  ]);
  // A saved search with no reading, and a time that is no date.
  const bare = rankCsvRows(rankTable([], { site: SITE, saved: [saved('s-x', 'x')] }).rows, 'table');
  expect(bare[1]).toEqual(['x', 'google', 'de', 'de', 'desktop', 1, '', '', '', '', '', '', '', '']);
  const odd = rankCsvRows(rankTable([observe(page(1), 9e15)], { site: SITE }).rows, 'history');
  expect(odd[1]![7]).toBe('');
});

test('rank-labels-and-history-note', () => {
  // spec: rankings.feature.md — Wording
  const point = (outcome: RankPoint['outcome'], position: number | null, page = 1): RankPoint => ({ readingId: 'r', at: NOW, outcome, position, url: null, organicRead: 10, page, alsoIn: [] });
  expect(rankLabel(point('ranked', 3))).toBe('3');
  expect(rankLabel(point('ranked', 3, 2))).toBe('p2 · 3');
  expect(rankLabel(point('not-found', null))).toBe('> 10');
  expect(rankLabel(point('not-found', null, 3))).toBe('p3 · > 10');
  expect(rankLabel(point('unknown', null))).toBe('Unknown');
  expect(rankLabel(point('unreadable', null))).toBe('Unreadable');
  expect(rankLabel(point('no-site', null))).toBe('No site set');
  expect(rankLabel(null)).toBe('No reading');
  const days = rankHistoryNote({ mode: 'days', value: 30 });
  expect(days).toContain('30 days');
  expect(days).toContain('as your signed-in browser profile sees them');
  expect(rankHistoryNote({ mode: 'versions', value: 5 })).toContain('newest 5 versions');
  expect(rankHistoryNote({ mode: 'forever', value: null })).toContain(RANK_HISTORY_NOTE.forever);
  expect(Object.values(RANK_HISTORY_NOTE).join(' ')).not.toContain('{n} {n}');
});

describe('rank-row-from-parts', () => {
  // spec: rankings.feature.md — The table read in parts (`rankRowOf`; Phase 10 Task 5)
  test('latest from the newest readings, points and best from the points given, competitors on the latest', () => {
    const RIVAL: SiteMatch = { owner: 'rival.com', host: 'rival.com', subdomains: true };
    const withRival = (position: number) => ready([organic('https://rival.com/x'), ...Array.from({ length: position - 2 }, (_, i) => organic(`https://o${i}.org/`)), organic('https://example.com/tea')]);
    const old = observe(withRival(5), NOW - 400 * DAY);
    const before = observe(withRival(6), NOW - 300 * DAY);
    const newest = observe(withRival(3), NOW - 200 * DAY);
    // Points come in already computed, any order, a duplicate once, out-of-range dropped, garbage skipped.
    const points = [rankOf(newest, SITE), rankOf(old, SITE), rankOf(before, SITE), rankOf(before, SITE), null, { readingId: 7 }] as never as RankPoint[];
    const row = rankRowOf({ searchKey: KEY, saved: null, recent: [newest, before], points }, { site: SITE, competitors: [RIVAL], keyOf, range: '365d', now: NOW })!;
    expect(row.latest).toMatchObject({ readingId: newest.id, position: 3 });
    expect(row.previous).toMatchObject({ readingId: before.id, position: 6 });
    expect(row.change).toBe(3);
    expect(row.points.map((point) => point.readingId)).toEqual([before.id, newest.id]);
    expect(row.best).toBe(3);
    expect(row.competitors).toEqual({ 'rival.com': rankOf(newest, RIVAL) });
    expect(row.params).toEqual(newest.params);
    // Latest and change whatever the range: the 7-day range keeps no point.
    const week = rankRowOf({ searchKey: KEY, saved: null, recent: [before, newest, old], points: [] }, { site: SITE, range: '7d', now: NOW })!;
    expect(week.points).toEqual([]);
    expect(week.best).toBeNull();
    expect(week.latest?.readingId).toBe(newest.id);
    expect(week.change).toBe(3);
    // A reading of another series in `recent` is not this row's.
    const other = observe(ready([organic('https://example.com/')], { params: paramsOf({ query: 'black tea' }) }), NOW);
    expect(rankRowOf({ searchKey: KEY, saved: null, recent: [newest, other], points: [] }, { site: SITE, keyOf })!.latest?.readingId).toBe(newest.id);
    // A saved search with no reading: its own parameters, no point; with neither, no row.
    const tea = saved('s-1', 'green tea', ['tea']);
    expect(rankRowOf({ searchKey: tea.searchKey, saved: tea, recent: [], points: [] }, { site: SITE })).toMatchObject({ latest: null, previous: null, change: null, best: null, saved: { id: 's-1', tags: ['tea'] }, params: tea.params });
    expect(rankRowOf({ searchKey: KEY, saved: null, recent: [], points: [] }, { site: SITE })).toBeNull();
    // The points are bounded: the newest maxPointsPerSeries, best over all of them.
    const many = Array.from({ length: RANK_LIMITS.maxPointsPerSeries + 5 }, (_, i) => ({ ...rankOf(newest, SITE), readingId: `p-${String(i).padStart(4, '0')}`, at: NOW - 100 * DAY + i, position: i === 0 ? 1 : 4 }));
    const bounded = rankRowOf({ searchKey: KEY, saved: null, recent: [newest], points: many }, { site: SITE, range: 'all', now: NOW })!;
    expect(bounded.points).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
    expect(bounded.best).toBe(1);
    // Total: garbage never throws.
    for (const garbage of [null, 1, {}, { searchKey: KEY, recent: 'x', points: 7 }]) expect(() => rankRowOf(garbage as never, garbage as never)).not.toThrow();
  });
});

test('rank-point-carries-its-source', () => {
  // spec: projects.feature.md — Checking searches via a data API (Phase 12 Task 4): each point says where
  // it came from; a tab capture's point is Phase 10's exactly (no `source` key), an API point names its vendor.
  const snapshot = page(2);
  const capture = observe(snapshot, NOW - DAY);
  const api = observe(snapshot, NOW, { source: 'serp-api', provider: 'serpapi' });
  const unknown = observe(snapshot, NOW + 1, { source: 'serp-api' });
  const forged = observe(snapshot, NOW + 2, { source: 'serp-api', provider: 'evil' as never });
  expect(Object.keys(rankOf(capture, SITE))).not.toContain('source');
  expect(rankOf(capture, null)).not.toHaveProperty('source');
  expect(rankOf(api, SITE)).toMatchObject({ source: 'serp-api', provider: 'serpapi', outcome: 'ranked', position: 2 });
  expect(rankOf(api, null)).toMatchObject({ source: 'serp-api', provider: 'serpapi', outcome: 'no-site' });
  expect(rankOf(unknown, SITE)).toMatchObject({ source: 'serp-api' });
  expect(rankOf(unknown, SITE)).not.toHaveProperty('provider');
  expect(rankOf(forged, SITE)).not.toHaveProperty('provider');
  // One series, each point with its own source.
  const [row] = rankTable([capture, api], { site: SITE }).rows;
  expect(row!.points.map((p) => p.source ?? 'capture')).toEqual(['capture', 'serp-api']);
  expect(row!.latest).toMatchObject({ readingId: api.id, source: 'serp-api', provider: 'serpapi' });
  expect(row!.previous).not.toHaveProperty('source');
});
