// @vitest-environment jsdom
// Spec: specs/gsc-panel.spec.ts, specs/gsc.schema.ts (GscPerformanceQuery, GscPerformanceAnswer, GscQueriesAnswer)
// Acceptance: specs/gsc-panel.feature.md (Reading)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GscPerformanceAnswer, GscPerformanceQuery, GscQueriesAnswer } from '@app/specs/gsc.schema';
import type { GscRequest } from '../gsc-view';

/** The reads the test settles, in order. */
const calls = vi.hoisted(() => ({
  performance: [] as { query: GscPerformanceQuery; resolve: (answer: GscPerformanceAnswer) => void }[],
  topQueries: [] as { query: GscPerformanceQuery; resolve: (answer: GscQueriesAnswer) => void }[],
}));
vi.mock('../ipc', () => ({
  ipc: {
    gsc: {
      performance: { query: (query: GscPerformanceQuery) => new Promise<GscPerformanceAnswer>((resolve) => calls.performance.push({ query, resolve })) },
      topQueries: { query: (query: GscPerformanceQuery) => new Promise<GscQueriesAnswer>((resolve) => calls.topQueries.push({ query, resolve })) },
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
const request = (url: string, changes: Partial<GscRequest> = {}): GscRequest => ({ url, scope: 'page', days: 28, connection: 1, ...changes });

let root: Root;
let latest: ReturnType<typeof useGscData>;
function Probe({ request }: { readonly request: GscRequest | null }) {
  latest = useGscData(request);
  return null;
}
const render = (value: GscRequest | null) => act(() => root.render(createElement(Probe, { request: value })));
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
    expect(calls.performance.map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28 }]);
    expect(calls.topQueries.map((c) => c.query)).toEqual([{ url: A, scope: 'page', days: 28 }]);
    expect(latest.loading).toBe(true);
    await settle(0, 5);
    expect(latest.loading).toBe(false);
    expect(latest.answers?.performance).toEqual(perf(5));

    // The same request again (a re-render, another fragment) reads nothing.
    render(request(`${A}#other`));
    expect(calls.performance).toHaveLength(1);
    // No polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(calls.performance).toHaveLength(1);

    render(request(A, { scope: 'property' }));
    render(request(A, { scope: 'property', days: 7 }));
    render(request(B, { scope: 'property', days: 7 }));
    expect(calls.performance.map((c) => c.query)).toEqual([
      { url: A, scope: 'page', days: 28 },
      { url: A, scope: 'property', days: 28 },
      { url: A, scope: 'property', days: 7 },
      { url: B, scope: 'property', days: 7 },
    ]);
  });

  test('use-gsc-data-drops-stale-answers', async () => {
    render(request(A));
    render(request(B));
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

  test('use-gsc-data-retry', async () => {
    render(request(A));
    await settle(0, 1);
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
