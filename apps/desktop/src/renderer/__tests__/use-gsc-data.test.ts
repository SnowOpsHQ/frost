// @vitest-environment jsdom
// Spec: specs/gsc-panel.spec.ts, specs/gsc.schema.ts (GscPerformanceQuery, GscPerformanceAnswer, GscQueriesAnswer, GscCountriesAnswer)
// Acceptance: specs/gsc-panel.feature.md (Reading)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GscCountriesAnswer, GscPerformanceAnswer, GscPerformanceQuery, GscQueriesAnswer } from '@app/specs/gsc.schema';
import { GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import type { GscRequest } from '../gsc-view';

/** The reads the test settles, in order. */
const calls = vi.hoisted(() => ({
  performance: [] as { query: GscPerformanceQuery; resolve: (answer: GscPerformanceAnswer) => void }[],
  topQueries: [] as { query: GscPerformanceQuery; resolve: (answer: GscQueriesAnswer) => void }[],
  countries: [] as { query: GscPerformanceQuery; resolve: (answer: GscCountriesAnswer) => void }[],
}));
vi.mock('../ipc', () => ({
  ipc: {
    gsc: {
      performance: { query: (query: GscPerformanceQuery) => new Promise<GscPerformanceAnswer>((resolve) => calls.performance.push({ query, resolve })) },
      topQueries: { query: (query: GscPerformanceQuery) => new Promise<GscQueriesAnswer>((resolve) => calls.topQueries.push({ query, resolve })) },
      countries: { query: (query: GscPerformanceQuery) => new Promise<GscCountriesAnswer>((resolve) => calls.countries.push({ query, resolve })) },
    },
  },
}));

const { useGscData } = await import('../hooks/useGscData');

const A = 'https://www.example.com/a';
const B = 'https://www.example.com/b';
const PROPERTY = { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' } as const;
const RANGE = { start: '2026-09-29', end: '2026-10-26' };
const perf = (clicks: number): GscPerformanceAnswer => ({
  status: 'ok',
  property: PROPERTY,
  scope: 'page',
  range: RANGE,
  rows: [{ date: RANGE.start, clicks, impressions: clicks * 10, ctr: 0.1, position: 2 }],
  totals: { clicks, impressions: clicks * 10, ctr: 0.1, position: 2 },
});
const top: GscQueriesAnswer = { status: 'ok', property: PROPERTY, scope: 'page', range: RANGE, rows: [] };
const request = (url: string, changes: Partial<GscRequest> = {}): GscRequest => ({ url, scope: 'page', days: 28, country: null, device: null, connection: 1, ...changes }) as GscRequest;
const countriesOf = (...codes: string[]): GscCountriesAnswer => ({ status: 'ok', property: PROPERTY, range: RANGE, countries: codes.map((country) => ({ country, clicks: 1, impressions: 10 })) });

let root: Root;
let latest: ReturnType<typeof useGscData>;
function Probe({ request }: { readonly request: GscRequest | null }) {
  latest = useGscData(request);
  return null;
}
const render = (value: GscRequest | null) => act(() => root.render(createElement(Probe, { request: value })));
/** Renders `value` and lets the debounce pass. */
const show = async (value: GscRequest | null) => {
  render(value);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS);
  });
};
const settle = async (index: number, clicks: number) => {
  await act(async () => {
    calls.performance[index]!.resolve(perf(clicks));
    calls.topQueries[index]!.resolve(top);
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  calls.performance.length = 0;
  calls.topQueries.length = 0;
  calls.countries.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useGscData', () => {
  test('use-gsc-data-reads-on-change', async () => {
    render(null);
    expect(calls.performance).toHaveLength(0);
    expect(latest).toMatchObject({ answers: null, loading: false });

    render(request(`${A}#top`));
    // Nothing until the debounce passed.
    expect(calls.performance).toHaveLength(0);
    expect(latest.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS);
    });
    expect(calls.performance.map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28 }]);
    expect(calls.topQueries.map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28 }]);
    expect(latest.loading).toBe(true);
    await settle(0, 5);
    expect(latest.loading).toBe(false);
    expect(latest.answers?.performance).toEqual(perf(5));

    // The same request again (a re-render, another fragment) reads nothing.
    await show(request(`${A}#other`));
    expect(calls.performance).toHaveLength(1);
    // No polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(calls.performance).toHaveLength(1);

    await show(request(A, { scope: 'property' }));
    await show(request(A, { scope: 'property', days: 7 }));
    await show(request(B, { scope: 'property', days: 7 }));
    expect(calls.performance.map((c) => c.query)).toEqual([
      { url: A, scope: 'page', days: 28 },
      { url: A, scope: 'property', days: 28 },
      { url: A, scope: 'property', days: 7 },
      { url: B, scope: 'property', days: 7 },
    ]);
    // Quick changes (a page rewriting its URL as it loads) read once, for the last.
    render(request(`${B}?step=1`));
    render(request(`${B}?step=2`));
    await show(request(`${B}?step=3`));
    expect(calls.performance.slice(4).map((c) => c.query.url)).toEqual([`${B}?step=3`]);
  });

  test('use-gsc-data-drops-stale-answers', async () => {
    await show(request(A));
    await show(request(B));
    expect(calls.performance).toHaveLength(2);
    // A's answer lands after the tab moved to B: not shown.
    await settle(0, 111);
    expect(latest.answers).toBeNull();
    expect(latest.loading).toBe(true);
    await settle(1, 222);
    expect(latest.answers?.performance).toEqual(perf(222));
    // Back to A: B's answer is not shown for A.
    render(request(A));
    expect(latest.answers).toBeNull();
    expect(latest.loading).toBe(true);
  });

  test('filters-trigger-one-read', async () => {
    await show(request(A));
    await settle(0, 5);
    expect(calls.countries.map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28 }]);
    await act(async () => {
      calls.countries[0]!.resolve(countriesOf('usa', 'gbr'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.countries).toEqual(countriesOf('usa', 'gbr'));

    // A country: one read of each with the filter, after the debounce; the countries list is not read again.
    render(request(A, { country: 'gbr' }));
    render(request(A, { country: 'usa' }));
    expect(calls.performance).toHaveLength(1);
    // The last data stays, pending.
    expect(latest).toMatchObject({ pending: true, loading: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS);
    });
    expect(calls.performance.slice(1).map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28, country: 'usa' }]);
    expect(calls.topQueries.slice(1).map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28, country: 'usa' }]);
    expect(calls.countries).toHaveLength(1);
    await settle(1, 3);
    expect(latest).toMatchObject({ pending: false, loading: false });

    // A device: one read of each, and the countries again (for that device), never with the country.
    await show(request(A, { country: 'usa', device: 'MOBILE' }));
    expect(calls.performance.slice(2).map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28, country: 'usa', device: 'MOBILE' }]);
    expect(calls.countries.slice(1).map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28, device: 'MOBILE' }]);
    // While the new list reads, the page's last list is kept.
    expect(latest.countries).toEqual(countriesOf('usa', 'gbr'));
    await act(async () => {
      calls.countries[1]!.resolve(countriesOf('usa'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.countries).toEqual(countriesOf('usa'));
    // Another page: no list of the last one.
    render(request(B));
    expect(latest.countries).toBeNull();
    // B reads once: its data and its countries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS);
    });
    expect(calls.performance).toHaveLength(4);
    expect(calls.countries).toHaveLength(3);
  });

  test('use-gsc-data-keeps-data-for-scope-change', async () => {
    await show(request(A));
    await settle(0, 5);
    // Another range of the same page: the last data stays, pending, until the new answer.
    render(request(A, { days: 7 }));
    expect(latest).toMatchObject({ pending: true, loading: true });
    expect(latest.answers?.performance).toEqual(perf(5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS);
    });
    await settle(1, 7);
    expect(latest).toMatchObject({ pending: false, loading: false });
    expect(latest.answers?.performance).toEqual(perf(7));
    // Another page: nothing of the last one shows.
    render(request(B, { days: 7 }));
    expect(latest).toMatchObject({ answers: null, pending: false, loading: true });
  });

  test('use-gsc-data-retry', async () => {
    await show(request(A));
    await settle(0, 1);
    // Retry reads at once (no debounce).
    act(() => latest.retry());
    expect(calls.performance.map((c) => c.query)).toEqual([
      { url: A, scope: 'page', days: 28 },
      { url: A, scope: 'page', days: 28 },
    ]);
    expect(latest.loading).toBe(true);
    await settle(1, 2);
    expect(latest.answers?.performance).toEqual(perf(2));
  });
});
