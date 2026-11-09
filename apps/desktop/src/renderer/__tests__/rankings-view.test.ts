// Spec: specs/rankings.spec.ts (RANK_TABLE_COLUMNS, RANK_RANGES, RANK_RANGE_LABELS, DEFAULT_RANK_RANGE,
// RANK_VIEW_TEXT, COMPARE_MOVEMENT_LABELS, RANKINGS_REFUSAL_MESSAGES, rankLabel, changeLabel,
// RANK_HISTORY_NOTE, rankHistoryNote)
// Acceptance: specs/rankings.feature.md (The views; scenarios rank-row-view, trend-points-from-numbers,
// range-and-tag-filter, history-note-follows-retention, compare-view-rows)
import { describe, expect, test } from 'vitest';
import {
  COMPARE_MOVEMENT_LABELS,
  DEFAULT_RANK_RANGE,
  RANKINGS_REFUSAL_MESSAGES,
  RANK_HISTORY_NOTE,
  RANK_RANGES,
  RANK_RANGE_LABELS,
  RANK_VIEW_TEXT,
  rankHistoryNote,
  type RankPoint,
  type RankTableRow,
  type ReadingDate,
  type SearchParamsShape,
  type SerpComparison,
  type SerpComparisonSide,
} from '@app/specs/rankings.spec';
import { SERP_RESULT_TYPE_LABELS } from '@app/specs/serp-selector-pack.spec';
import {
  compareFeatureRows,
  compareProblem,
  compareSideLabel,
  compareViewRows,
  copyCsvText,
  defaultComparePicks,
  emptyStates,
  formatWhen,
  historyNote,
  rangeOptions,
  rankRowView,
  rankTableInput,
  rankingsRefusalText,
  readingDateOptions,
  resultPageUrl,
  rowsForTag,
  saveCsvText,
  seriesRows,
  tagOptions,
  trendPoints,
} from '../rankings-view';

const P1 = '01920000-0000-7000-8000-0000000000a1';
const KEY = 'a'.repeat(64);
const HOSTILE = '"><script>alert(1)</script>';

const params = (changes: Partial<SearchParamsShape> = {}): SearchParamsShape => ({
  engine: 'google',
  engineLabel: 'Google',
  query: 'green tea',
  gl: 'de',
  hl: 'en',
  device: 'desktop',
  page: 1,
  offset: null,
  url: 'https://www.google.com/search?q=green+tea&gl=de&hl=en',
  ...changes,
});

const point = (changes: Partial<RankPoint> = {}): RankPoint => ({ readingId: P1, at: Date.UTC(2026, 9, 1, 12), outcome: 'ranked', position: 3, url: 'https://example.com/a', organicRead: 10, page: 1, alsoIn: [], ...changes });

const row = (changes: Partial<RankTableRow> = {}): RankTableRow => ({
  searchKey: KEY,
  params: params(),
  filters: {},
  saved: { id: P1, tags: ['brand'] },
  latest: point(),
  previous: point({ position: 5 }),
  change: 2,
  best: 2,
  points: [point({ position: 5 }), point()],
  competitors: {},
  capped: false,
  ...changes,
});

describe('rankings view', () => {
  test('rank-row-view', () => {
    const view = rankRowView(row({ filters: { tbs: 'qdr:w', num: '20' }, competitors: { 'rival.com': point({ position: 1 }), 'other.org': null } }), ['other.org', 'rival.com']);
    expect(view.key).toBe(KEY);
    expect(view.search).toBe('green tea');
    expect(view.engine).toBe('Google');
    expect(view.locale).toBe('DE · en');
    expect(view.device).toBe('Desktop');
    expect(view.filters).toBe('num=20 tbs=qdr:w');
    expect(view.tags).toEqual(['brand']);
    expect(view.position).toBe('3');
    expect(view.outcome).toBe('ranked');
    expect(view.change).toBe('+2');
    expect(view.direction).toBe('up');
    expect(view.best).toBe('2');
    expect(view.lastChecked).toBe(formatWhen(Date.UTC(2026, 9, 1, 12)));
    // Competitors in the project's order; one with no reading is a dash.
    expect(view.competitors).toEqual([
      { host: 'other.org', position: RANK_VIEW_TEXT.none },
      { host: 'rival.com', position: '1' },
    ]);
    expect(view.capped).toBeNull();
    expect(view.alsoIn).toBe('');
    expect(view.url).toBe('https://www.google.com/search?q=green+tea&gl=de&hl=en');

    // Each outcome's label, as `rankLabel` says it.
    expect(rankRowView(row({ latest: point({ outcome: 'not-found', position: null, organicRead: 10 }), change: 'lost' }), []).position).toBe('> 10');
    expect(rankRowView(row({ latest: point({ outcome: 'not-found', position: null, organicRead: 8, page: 2 }) }), []).position).toBe('p2 · > 8');
    expect(rankRowView(row({ latest: point({ page: 2 }) }), []).position).toBe('p2 · 3');
    expect(rankRowView(row({ latest: point({ outcome: 'unknown', position: null }) }), []).position).toBe('Unknown');
    expect(rankRowView(row({ latest: point({ outcome: 'unreadable', position: null }) }), []).position).toBe('Unreadable');
    expect(rankRowView(row({ latest: point({ outcome: 'no-site', position: null }) }), []).position).toBe('No site set');
    // Change text and direction.
    const changeOf = (change: RankTableRow['change']) => {
      const shown = rankRowView(row({ change }), []);
      return [shown.change, shown.direction];
    };
    expect(changeOf(-3)).toEqual(['-3', 'down']);
    expect(changeOf(0)).toEqual(['0', 'same']);
    expect(changeOf('new')).toEqual(['new', 'new']);
    expect(changeOf('lost')).toEqual(['lost', 'lost']);
    expect(changeOf(null)).toEqual(['', 'none']);
    // No reading at all: never checked, no best.
    const unread = rankRowView(row({ latest: null, previous: null, change: null, best: null, points: [], saved: null, params: params({ gl: null, hl: null, device: 'mobile' }) }), []);
    expect(unread.position).toBe('No reading');
    expect(unread.outcome).toBe('none');
    expect(unread.best).toBe(RANK_VIEW_TEXT.none);
    expect(unread.lastChecked).toBe(RANK_VIEW_TEXT.noReading);
    expect(unread.locale).toBe(RANK_VIEW_TEXT.none);
    expect(unread.device).toBe('Mobile');
    expect(unread.tags).toEqual([]);
    // Also in: the feature labels, in order.
    expect(rankRowView(row({ latest: point({ alsoIn: ['featured-snippet', 'ai-overview'] }) }), []).alsoIn).toBe(`${RANK_VIEW_TEXT.alsoIn} ${SERP_RESULT_TYPE_LABELS['featured-snippet']}, ${SERP_RESULT_TYPE_LABELS['ai-overview']}`);
    // A capped row carries its hint.
    expect(rankRowView(row({ capped: true }), []).capped).toBe(RANK_VIEW_TEXT.capped);
    // Only an http(s) canonical URL opens.
    expect(rankRowView(row({ params: params({ url: 'javascript:alert(1)' }) }), []).url).toBeNull();
    expect(resultPageUrl(params({ url: 'file:///etc/passwd' }))).toBeNull();
    expect(resultPageUrl(params({ url: 'http://www.bing.com/search?q=x' }))).toBe('http://www.bing.com/search?q=x');
    expect(resultPageUrl({ url: 42 } as unknown as SearchParamsShape)).toBeNull();
    // Untrusted text passes as data (React renders it as text).
    expect(rankRowView(row({ params: params({ query: HOSTILE }) }), []).search).toBe(HOSTILE);
  });

  test('trend-points-from-numbers', () => {
    const points = [
      point({ position: 4, url: HOSTILE }),
      point({ position: 1, url: 'javascript:alert(1)' }),
      point({ outcome: 'unreadable', position: null }),
      point({ position: 7 }),
      point({ outcome: 'not-found', position: null }),
      point({ position: 2 }),
    ];
    const trend = trendPoints(points);
    expect(trend.empty).toBe(false);
    // Runs of consecutive positions are lines; a lone one a dot.
    expect(trend.segments).toHaveLength(1);
    expect(trend.dots).toHaveLength(2);
    for (const segment of trend.segments) expect(segment).toMatch(/^[\d.]+,[\d.]+( [\d.]+,[\d.]+)+$/);
    for (const dot of trend.dots) {
      expect(Number.isFinite(dot.x) && Number.isFinite(dot.y)).toBe(true);
    }
    // Best (1) at the top, worst (7) at the bottom: y grows with the position.
    const [first, second] = trend.segments[0]!.split(' ').map((pair) => pair.split(',').map(Number));
    expect(second![1]).toBeLessThan(first![1]!);
    const ys = [first![1]!, second![1]!, ...trend.dots.map((dot) => dot.y)];
    expect(Math.min(...ys)).toBe(second![1]);
    expect(trend.dots[0]!.y).toBe(Math.max(...ys));
    // x follows the index, left to right.
    expect(first![0]).toBeLessThan(second![0]!);
    expect(trend.dots[0]!.x).toBeLessThan(trend.dots[1]!.x);
    expect(trend.label).toBe('4 positions over 6 readings; best 1, worst 7.');
    expect(trend.label).not.toContain('script');

    // One position: a dot in the middle row.
    const one = trendPoints([point({ position: 5 })]);
    expect(one.segments).toEqual([]);
    expect(one.dots).toHaveLength(1);
    expect(one.dots[0]!.y).toBe(one.height / 2);
    // Nothing ranked, or garbage: nothing drawn, never a throw.
    const none = trendPoints([point({ outcome: 'unknown', position: null }), null as unknown as RankPoint, { outcome: 'ranked', position: '3' } as unknown as RankPoint, point({ position: Number.NaN })]);
    expect(none.empty).toBe(true);
    expect(none.segments).toEqual([]);
    expect(none.dots).toEqual([]);
    expect(trendPoints([]).empty).toBe(true);
    expect(trendPoints(null as unknown as RankPoint[]).empty).toBe(true);
  });

  test('range-and-tag-filter', () => {
    expect(rangeOptions()).toEqual(RANK_RANGES.map((range) => ({ value: range, label: RANK_RANGE_LABELS[range] })));
    expect(tagOptions(['brand', 'shop'])).toEqual([
      { value: '', label: RANK_VIEW_TEXT.allTags },
      { value: 'brand', label: 'brand' },
      { value: 'shop', label: 'shop' },
    ]);
    expect(rankTableInput(P1, { range: '7d', tag: null }, ['brand'])).toEqual({ projectId: P1, range: '7d' });
    expect(rankTableInput(P1, { range: '90d', tag: 'brand' }, ['brand'])).toEqual({ projectId: P1, range: '90d', tag: 'brand' });
    // A tag the project no longer has: all searches. An unknown range: the default.
    expect(rankTableInput(P1, { range: '365d', tag: 'gone' }, ['brand'])).toEqual({ projectId: P1, range: '365d' });
    expect(rankTableInput(P1, { range: 'bogus' as '7d', tag: '' }, [])).toEqual({ projectId: P1, range: DEFAULT_RANK_RANGE });
    // The rows shown keep only searches carrying the tag (observed-only searches have none).
    const rows = [row({ searchKey: 'a'.repeat(64) }), row({ searchKey: 'b'.repeat(64), saved: { id: P1, tags: ['shop'] } }), row({ searchKey: 'c'.repeat(64), saved: null })];
    expect(rowsForTag(rows, null).map((r) => r.searchKey[0])).toEqual(['a', 'b', 'c']);
    expect(rowsForTag(rows, 'brand').map((r) => r.searchKey[0])).toEqual(['a']);
    expect(rowsForTag(rows, 'shop').map((r) => r.searchKey[0])).toEqual(['b']);
    expect(rowsForTag(rows, 'none')).toEqual([]);
  });

  test('history-note-follows-retention', () => {
    expect(historyNote({ mode: 'forever', value: null })).toEqual({ limited: false, text: RANK_HISTORY_NOTE.profile });
    expect(historyNote({ mode: 'versions', value: 5 })).toEqual({ limited: true, text: rankHistoryNote({ mode: 'versions', value: 5 }) });
    expect(historyNote({ mode: 'versions', value: 5 }).text).toContain('newest 5 versions');
    expect(historyNote({ mode: 'days', value: 30 }).text).toContain('30 days');
    expect(historyNote({ mode: 'days', value: 30 }).text).toContain(RANK_HISTORY_NOTE.profile);
    // Empty states follow the site and the readings.
    const site = { domain: 'example.com', subdomains: true };
    expect(emptyStates({ site, rows: [row()] })).toEqual([]);
    expect(emptyStates({ site: null, rows: [row()] })).toEqual(['no-site']);
    expect(emptyStates({ site, rows: [] })).toEqual(['no-readings']);
    expect(emptyStates({ site: null, rows: [row({ latest: null, previous: null })] })).toEqual(['no-site', 'no-readings']);
    expect(RANK_VIEW_TEXT.noSite).toBe("Set your site's domain to see its position");
    expect(RANK_VIEW_TEXT.noReadings).toBe('No readings yet: capture a search or run Check rankings');
    // The series: newest first, date, position, URL.
    const series = seriesRows([point({ readingId: 'r1', at: 1_000, position: 5 }), point({ readingId: 'r2', at: 2_000, outcome: 'not-found', position: null, url: null, alsoIn: ['video'] })]);
    expect(series).toEqual([
      { readingId: 'r2', when: formatWhen(2_000), position: '> 10', url: RANK_VIEW_TEXT.none, alsoIn: `${RANK_VIEW_TEXT.alsoIn} ${SERP_RESULT_TYPE_LABELS.video}` },
      { readingId: 'r1', when: formatWhen(1_000), position: '5', url: 'https://example.com/a', alsoIn: '' },
    ]);
    // Refusals and export outcomes in words.
    expect(rankingsRefusalText({ status: 'ok' })).toBeNull();
    expect(rankingsRefusalText({ status: 'refused', reason: 'not-found' })).toBe(RANKINGS_REFUSAL_MESSAGES['not-found']);
    expect(rankingsRefusalText(null)).toBe(RANKINGS_REFUSAL_MESSAGES['store-failed']);
    expect(rankingsRefusalText({ status: 'refused', reason: 'bogus' })).toBe(RANKINGS_REFUSAL_MESSAGES['store-failed']);
    expect(copyCsvText(12)).toBe('Copied 12 rows as CSV.');
    expect(copyCsvText(null)).toBe(RANK_VIEW_TEXT.notCopied);
    expect(saveCsvText({ status: 'saved', rows: 3 })).toBe('Saved 3 rows as CSV.');
    expect(saveCsvText({ status: 'cancelled' })).toBe(RANK_VIEW_TEXT.saveCancelled);
    expect(saveCsvText({ status: 'refused', reason: 'write-failed' })).toBe(RANKINGS_REFUSAL_MESSAGES['write-failed']);
    expect(saveCsvText(null)).toBe(RANKINGS_REFUSAL_MESSAGES['store-failed']);
  });

  test('compare-view-rows', () => {
    const side = (changes: Partial<SerpComparisonSide> = {}): SerpComparisonSide => ({ readingId: P1, at: 1_000, params: params(), filters: {}, status: 'ready', organicRead: 10, complete: true, features: [], ...changes });
    const comparison: SerpComparison = {
      a: side(),
      b: side({ readingId: 'b', at: 2_000 }),
      rows: [
        { domain: 'example.com', a: { position: 4, url: null }, b: { position: 2, url: null }, movement: 'up', change: 2, role: 'site' },
        { domain: 'rival.com', a: { position: 1, url: null }, b: { position: 3, url: null }, movement: 'down', change: -2, role: 'competitor' },
        { domain: 'same.net', a: { position: 5, url: null }, b: { position: 5, url: null }, movement: 'same', change: 0, role: null },
        { domain: HOSTILE, a: null, b: { position: 6, url: null }, movement: 'new', change: null, role: null },
        { domain: 'old.org', a: { position: 7, url: null }, b: null, movement: 'gone', change: null, role: null },
      ],
      features: [
        { type: 'featured-snippet', a: true, b: false },
        { type: 'video', a: false, b: true },
      ],
      site: { a: point({ position: 4 }), b: point({ position: 2 }) },
      truncated: false,
    };
    expect(compareViewRows(comparison)).toEqual([
      { domain: 'example.com', a: '4', b: '2', movement: 'up', movementLabel: 'Up 2', role: 'site', roleLabel: RANK_VIEW_TEXT.siteRole },
      { domain: 'rival.com', a: '1', b: '3', movement: 'down', movementLabel: 'Down 2', role: 'competitor', roleLabel: RANK_VIEW_TEXT.competitorRole },
      { domain: 'same.net', a: '5', b: '5', movement: 'same', movementLabel: COMPARE_MOVEMENT_LABELS.same, role: null, roleLabel: '' },
      { domain: HOSTILE, a: RANK_VIEW_TEXT.none, b: '6', movement: 'new', movementLabel: 'New', role: null, roleLabel: '' },
      { domain: 'old.org', a: '7', b: RANK_VIEW_TEXT.none, movement: 'gone', movementLabel: 'Gone', role: null, roleLabel: '' },
    ]);
    expect(compareFeatureRows(comparison)).toEqual([
      { type: 'featured-snippet', label: SERP_RESULT_TYPE_LABELS['featured-snippet'], a: RANK_VIEW_TEXT.present, b: RANK_VIEW_TEXT.absent },
      { type: 'video', label: SERP_RESULT_TYPE_LABELS.video, a: RANK_VIEW_TEXT.absent, b: RANK_VIEW_TEXT.present },
    ]);
    expect(compareSideLabel(side())).toEqual({ search: '“green tea” on Google (DE, en, desktop)', when: formatWhen(1_000), status: 'ready' });
    expect(compareSideLabel(side({ params: null, status: 'unreadable' }))).toEqual({ search: 'Unreadable', when: formatWhen(1_000), status: 'unreadable' });
    expect(compareViewRows({ ...comparison, rows: null } as unknown as SerpComparison)).toEqual([]);

    // The date picker: newest first as main answers, an unreadable reading says so.
    const dates: ReadingDate[] = [
      { readingId: 'r3', at: 3_000, status: 'ready' },
      { readingId: 'r2', at: 2_000, status: 'unreadable' },
      { readingId: 'r1', at: 1_000, status: 'ready' },
    ];
    expect(readingDateOptions(dates)).toEqual([
      { value: 'r3', label: formatWhen(3_000) },
      { value: 'r2', label: `${formatWhen(2_000)} (${RANK_VIEW_TEXT.unreadableDate})` },
      { value: 'r1', label: formatWhen(1_000) },
    ]);
    // A on the second-newest, B on the newest; one reading: both on it; none: nothing.
    expect(defaultComparePicks(dates)).toEqual({ a: 'r2', b: 'r3' });
    expect(defaultComparePicks(dates.slice(0, 1))).toEqual({ a: 'r3', b: 'r3' });
    expect(defaultComparePicks([])).toEqual({ a: null, b: null });
    // Compare waits for two different readings.
    expect(compareProblem('r1', 'r2')).toBeNull();
    expect(compareProblem(null, 'r2')).toBe(RANK_VIEW_TEXT.compareNeedsTwo);
    expect(compareProblem('r2', 'r2')).toBe(RANK_VIEW_TEXT.compareSame);
  });
});
