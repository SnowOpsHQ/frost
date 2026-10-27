// Spec: specs/seo-checks.spec.ts (LINK_CHECK_LIMITS)
// Acceptance: specs/seo-checks.feature.md (Scheduler); review focus link-checks-are-bounded
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LINK_CHECK_LIMITS } from '@app/specs/seo-checks.spec';
import { runBounded } from '../checks-scheduler';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Items `origin/i`; each task takes `ms` (fake time) and records when it started and how many ran at once. */
function harness(ms: number) {
  const starts: { item: string; at: number }[] = [];
  const running = new Map<string, number>();
  let peak = 0;
  const peakPerOrigin = new Map<string, number>();
  let inflight = 0;
  const task = (item: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const origin = item.split('/')[0]!;
      starts.push({ item, at: Date.now() });
      inflight += 1;
      running.set(origin, (running.get(origin) ?? 0) + 1);
      peak = Math.max(peak, inflight);
      peakPerOrigin.set(origin, Math.max(peakPerOrigin.get(origin) ?? 0, running.get(origin)!));
      const done = () => {
        clearTimeout(timer);
        inflight -= 1;
        running.set(origin, running.get(origin)! - 1);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  return { starts, task, peak: () => peak, peakPerOrigin };
}

const items = (origins: number, each: number) => Array.from({ length: origins * each }, (_, i) => `o${i % origins}/${Math.floor(i / origins)}`);
const originOf = (item: string) => item.split('/')[0]!;
const options = (signal: AbortSignal) => ({ perOrigin: LINK_CHECK_LIMITS.perOriginConcurrency, intervalMs: LINK_CHECK_LIMITS.perOriginIntervalMs, maxConcurrency: LINK_CHECK_LIMITS.maxConcurrency, signal });

describe('scheduler', () => {
  test('link-checks-are-bounded', async () => {
    // Slow answers: the per-origin and total concurrency caps bind.
    const slow = harness(2_000);
    const all = items(10, 4);
    const run = runBounded(all, originOf, slow.task, options(new AbortController().signal));
    await vi.runAllTimersAsync();
    await run;
    expect(slow.starts).toHaveLength(40);
    expect(slow.peak()).toBe(LINK_CHECK_LIMITS.maxConcurrency);
    for (const peak of slow.peakPerOrigin.values()) expect(peak).toBeLessThanOrEqual(LINK_CHECK_LIMITS.perOriginConcurrency);

    // Fast answers on one origin: the rate limit binds (starts at least the interval apart, in order).
    const fast = harness(1);
    const one = items(1, 6);
    const second = runBounded(one, originOf, fast.task, options(new AbortController().signal));
    await vi.runAllTimersAsync();
    await second;
    expect(fast.starts.map((s) => s.item)).toEqual(one);
    for (let i = 1; i < fast.starts.length; i++) expect(fast.starts[i]!.at - fast.starts[i - 1]!.at).toBeGreaterThanOrEqual(LINK_CHECK_LIMITS.perOriginIntervalMs);

    // An abort starts nothing more; the running tasks get the signal and the run settles.
    const cancelled = harness(10_000);
    const controller = new AbortController();
    let settled = false;
    const third = runBounded(items(3, 10), originOf, cancelled.task, options(controller.signal)).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(600);
    const started = cancelled.starts.length;
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(30);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await third;
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelled.starts).toHaveLength(started);
  });

  test('scheduler-survives-throwing-tasks', async () => {
    const seen: string[] = [];
    const run = runBounded(
      ['a/1', 'a/2', 'b/1'],
      originOf,
      (item) => {
        seen.push(item);
        if (item === 'a/1') throw new Error('sync');
        return Promise.reject(new Error('async'));
      },
      options(new AbortController().signal),
    );
    await vi.runAllTimersAsync();
    await run;
    expect(seen.sort()).toEqual(['a/1', 'a/2', 'b/1']);
    // Nothing to do settles at once.
    await expect(runBounded([], originOf, async () => undefined, options(new AbortController().signal))).resolves.toBeUndefined();
  });
});
