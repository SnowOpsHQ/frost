// Spec: specs/site-crawl.spec.ts (CRAWL_INTERVAL_MS, MAX_CRAWL_DELAY_MS, CRAWL_LIMITS.backoffAfter / maxRetryAfterMs,
// CRAWL_SLOW_DOWN_MESSAGE); specs/fetcher.spec.ts (the crawl lane)
// Acceptance: specs/site-crawl.feature.md (Fetching, politeness and robots: crawl-is-polite, crawl-honours-crawl-delay-and-retry-after,
// crawl-backs-off-and-pauses); plan docs/plans/phase-12-big-bets.md Decision 3 (K-B1), Decision 6 and Task 6a
import { describe, expect, test } from 'vitest';
import { CRAWL_INTERVAL_MS, CRAWL_LIMITS, MAX_CRAWL_DELAY_MS } from '@app/specs/site-crawl.spec';
import { createPacing, createPoliteness, CrawlSlowDownError, type CrawlClock } from '../politeness';

/** A fake clock: time moves only when the test advances it; timers fire in time order. */
function fakeClock(start = 1_000_000) {
  let time = start;
  let serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: CrawlClock = {
    now: () => time,
    setTimeout(fn, ms) {
      const id = ++serial;
      timers.set(id, { at: time + Math.max(0, ms), fn });
      return () => timers.delete(id);
    },
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** Runs every timer due by `until` (all of them when absent), letting promises settle between. */
  async function run(until = Number.POSITIVE_INFINITY): Promise<void> {
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      time = Math.max(time, next[1].at);
      next[1].fn();
      await flush();
    }
    if (until !== Number.POSITIVE_INFINITY) time = Math.max(time, until);
  }
  return { clock, run, pending: () => timers.size, now: () => time, set: (at: number) => (time = at) };
}

/** A fetch call that takes `ms` on the fake clock and records its start and end. */
function call(clockKit: ReturnType<typeof fakeClock>, log: { start: number; end: number }[], inFlight: { now: number; max: number }, ms: number) {
  return () =>
    new Promise<number>((resolve) => {
      const start = clockKit.now();
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      clockKit.clock.setTimeout(() => {
        inFlight.now -= 1;
        log.push({ start, end: clockKit.now() });
        resolve(start);
      }, ms);
    });
}

describe('crawl politeness', () => {
  test('crawl-is-polite', async () => {
    // K-B1: for every interval choice, never two calls in flight per origin, and consecutive starts at
    // least the effective interval apart, whatever each call's length (shorter or longer than the interval).
    for (let interval = CRAWL_INTERVAL_MS.min; interval <= CRAWL_INTERVAL_MS.max; interval++) {
      const kit = fakeClock();
      const polite = createPoliteness({ intervalMs: interval, clock: kit.clock });
      expect(polite.intervalFor('https://a.example')).toBe(interval);
      const log: { start: number; end: number }[] = [];
      const inFlight = { now: 0, max: 0 };
      const lengths = [1, interval + 250, 0, Math.floor(interval / 3)];
      const calls = lengths.map((ms) => polite.schedule('https://a.example', call(kit, log, inFlight, ms)));
      // Another origin runs on its own pace, at once.
      const other = polite.schedule('https://b.example', call(kit, [], { now: 0, max: 0 }, 5));
      await kit.run();
      const starts = await Promise.all(calls);
      await other;
      expect(inFlight.max, `interval ${interval}`).toBe(1);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i]! - starts[i - 1]!, `interval ${interval}, call ${i}`).toBeGreaterThanOrEqual(interval);
        // One at a time: a call starts only after the previous one ended.
        expect(starts[i]!, `interval ${interval}, call ${i}`).toBeGreaterThanOrEqual(log[i - 1]!.end);
      }
      // The first call to an idle origin starts at once.
      expect(starts[0]).toBe(1_000_000);
    }
  });

  test('crawl-interval-is-clamped-to-the-range', () => {
    const kit = fakeClock();
    expect(createPoliteness({ intervalMs: 10, clock: kit.clock }).intervalFor('https://a.example')).toBe(CRAWL_INTERVAL_MS.min);
    expect(createPoliteness({ intervalMs: 99_000, clock: kit.clock }).intervalFor('https://a.example')).toBe(CRAWL_INTERVAL_MS.max);
    expect(createPoliteness({ intervalMs: Number.NaN, clock: kit.clock }).intervalFor('https://a.example')).toBe(CRAWL_INTERVAL_MS.default);
  });

  test('crawl-honours-crawl-delay-and-retry-after', async () => {
    const kit = fakeClock();
    const polite = createPoliteness({ intervalMs: 1_000, clock: kit.clock });
    const origin = 'https://a.example';
    // Crawl-delay raises the interval, capped; never lowers it below the user's choice.
    polite.setCrawlDelay(origin, 3_000);
    expect(polite.intervalFor(origin)).toBe(3_000);
    polite.setCrawlDelay(origin, 500);
    expect(polite.intervalFor(origin)).toBe(1_000);
    polite.setCrawlDelay(origin, 60_000);
    expect(polite.intervalFor(origin)).toBe(MAX_CRAWL_DELAY_MS);
    polite.setCrawlDelay(origin, null);
    expect(polite.intervalFor(origin)).toBe(1_000);
    polite.setCrawlDelay(origin, 2_500);

    const starts: number[] = [];
    const quick = () => {
      starts.push(kit.now());
      return Promise.resolve();
    };
    await polite.schedule(origin, quick);
    // A 429 with Retry-After in seconds: the next call waits it from when it was received (beyond the interval).
    kit.set(kit.now() + 100);
    polite.report(origin, { status: 429, retryAfter: '30' });
    const second = polite.schedule(origin, quick);
    await kit.run();
    await second;
    expect(starts[1]! - (starts[0]! + 100)).toBe(30_000);
    // As an HTTP date.
    polite.report(origin, { status: 503, retryAfter: new Date(kit.now() + 45_000).toUTCString() });
    const third = polite.schedule(origin, quick);
    await kit.run();
    await third;
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(44_000);
    expect(starts[2]! - starts[1]!).toBeLessThanOrEqual(45_000);
    // Capped at maxRetryAfterMs.
    polite.report(origin, { status: 429, retryAfter: '86400' });
    const fourth = polite.schedule(origin, quick);
    await kit.run();
    await fourth;
    expect(starts[3]! - starts[2]!).toBe(CRAWL_LIMITS.maxRetryAfterMs);
    // A past date, a malformed value, or Retry-After on a 200: nothing beyond the interval (with any back-off reset).
    for (const [status, retryAfter] of [[200, '60'], [200, 'soon'], [200, new Date(kit.now() - 60_000).toUTCString()]] as const) {
      polite.report(origin, { status, retryAfter });
      const next = polite.schedule(origin, quick);
      await kit.run();
      await next;
      expect(starts.at(-1)! - starts.at(-2)!, `${status} ${retryAfter}`).toBe(2_500);
    }
    polite.report(origin, { status: 429, retryAfter: 'soon' });
    const malformed = polite.schedule(origin, quick);
    await kit.run();
    await malformed;
    // A 429 without a usable Retry-After still backs off (2 × 2 500).
    expect(starts.at(-1)! - starts.at(-2)!).toBe(5_000);
  });

  test('crawl-backs-off-and-pauses', async () => {
    const kit = fakeClock();
    const polite = createPoliteness({ intervalMs: 1_000, clock: kit.clock });
    const origin = 'https://a.example';
    const reports = [];
    for (let i = 1; i <= CRAWL_LIMITS.backoffAfter; i++) {
      const report = polite.report(origin, { status: i % 2 === 0 ? 503 : 429, retryAfter: null });
      reports.push(report);
      expect(polite.intervalFor(origin), `in a row ${i}`).toBe(1_000 * 2 ** i);
      expect(report.slowDown, `in a row ${i}`).toBe(i >= CRAWL_LIMITS.backoffAfter);
      expect(report.inARow).toBe(i);
    }
    // Any other answer resets the back-off.
    expect(polite.report(origin, { status: 200, retryAfter: null })).toEqual({ inARow: 0, slowDown: false });
    expect(polite.intervalFor(origin)).toBe(1_000);
    polite.report(origin, { status: 429, retryAfter: null });
    polite.report(origin, { status: 404, retryAfter: null });
    expect(polite.intervalFor(origin)).toBe(1_000);
    // No answer (a network error) leaves it as it is.
    polite.report(origin, { status: 503, retryAfter: null });
    polite.report(origin, { status: null, retryAfter: null });
    expect(polite.intervalFor(origin)).toBe(2_000);
    // Back-off doubles the Crawl-delay-raised interval too; each origin has its own.
    polite.setCrawlDelay(origin, 3_000);
    expect(polite.intervalFor(origin)).toBe(6_000);
    expect(polite.intervalFor('https://b.example')).toBe(1_000);
  });

  test('crawl-politeness-abort-and-bounds', async () => {
    const kit = fakeClock();
    const polite = createPoliteness({ intervalMs: 4_000, clock: kit.clock });
    const origin = 'https://a.example';
    let ran = 0;
    await polite.schedule(origin, async () => {
      ran++;
    });
    const controller = new AbortController();
    const waiting = polite.schedule(
      origin,
      async () => {
        ran++;
      },
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    await kit.run();
    expect(ran).toBe(1);
    // A call already aborted never runs.
    await expect(polite.schedule(origin, async () => void ran++, controller.signal)).rejects.toThrow(/aborted/);
    expect(ran).toBe(1);
    // A call that throws frees the origin for the next.
    const throwing = expect(
      polite.schedule(origin, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await kit.run();
    await throwing;
    const after = polite.schedule(origin, async () => void ran++);
    await kit.run();
    await after;
    expect(ran).toBe(2);
  });

  test('crawl-politeness-bounds-never-start-early', async () => {
    // Bounded per-host state (K-B3) whose pruning never makes a start early, with back-off, Retry-After and
    // Crawl-delay active. A model of each host (last start, back-off, Retry-After, Crawl-delay) gives the earliest
    // allowed start; the model forgets back-off only where the pacing may (the longest possible wait has passed).
    const kit = fakeClock();
    const maxHosts = 4;
    const polite = createPoliteness({ intervalMs: 1_000, clock: kit.clock, maxHosts });
    const hosts = Array.from({ length: 10 }, (_, i) => `h${i}.example`);
    const model = new Map<string, { lastStart: number; inARow: number; retryUntil: number; delay: number }>();
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    let refused = 0;
    let checked = 0;
    const started = new Set<string>();
    for (let step = 0; step < 600; step++) {
      const host = hosts[random(hosts.length)]!;
      const known = model.get(host);
      const at = kit.now();
      // Where the pacing may have forgotten the host (judged on the state it had), its back-off counts from zero.
      if (known && at >= known.lastStart + Math.max(CRAWL_INTERVAL_MS.max, known.delay) * 2 ** CRAWL_LIMITS.backoffAfter && at >= known.retryUntil) known.inARow = 0;
      // A robots.txt read before the call may change the Crawl-delay (as fetchPage does).
      if (random(4) === 0) {
        const delay = random(3) === 0 ? MAX_CRAWL_DELAY_MS : 0;
        polite.setCrawlDelay(host, delay === 0 ? null : delay);
        if (known) known.delay = delay;
      }
      const required = known ? Math.max(known.lastStart + Math.max(1_000, known.delay) * 2 ** Math.min(known.inARow, CRAWL_LIMITS.backoffAfter), known.retryUntil) : Number.NEGATIVE_INFINITY;
      const call = polite.schedule(host, async () => {
        const startedAt = kit.now();
        // Never early, whatever was forgotten meanwhile.
        expect(startedAt, `${host} step ${step}`).toBeGreaterThanOrEqual(required);
        checked++;
        const status = [200, 429, 503, 429][random(4)]!;
        const retryAfter = random(3) === 0 ? String(random(90)) : null;
        polite.report(host, { status, retryAfter });
        const entry = model.get(host) ?? { lastStart: 0, inARow: 0, retryUntil: Number.NEGATIVE_INFINITY, delay: 0 };
        entry.lastStart = startedAt;
        entry.inARow = status === 200 ? 0 : entry.inARow + 1;
        if (status !== 200 && retryAfter !== null && Number(retryAfter) > 0) entry.retryUntil = Math.max(entry.retryUntil, startedAt + Math.min(CRAWL_LIMITS.maxRetryAfterMs, Number(retryAfter) * 1_000));
        model.set(host, entry);
      });
      const outcome = call.then(
        () => 'ran' as const,
        (error: unknown) => (error instanceof CrawlSlowDownError ? ('refused' as const) : Promise.reject(error)),
      );
      await kit.run();
      if ((await outcome) === 'refused') refused++;
      else started.add(host);
      expect(polite.size()).toBeLessThanOrEqual(maxHosts);
      kit.set(kit.now() + random(60_000));
    }
    // Pruning happened (more distinct hosts ran than fit at once), a full table refused new hosts, and the check ran.
    expect(started.size).toBeGreaterThan(maxHosts);
    expect(refused).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(100);
    // The default cap keeps the table within the in-memory budget.
    expect(CRAWL_LIMITS.maxPacedHosts).toBeLessThan(CRAWL_LIMITS.maxInMemoryEntries);
  });

  test('crawl-pacing-survives-runs', async () => {
    // The pacing belongs to the crawl fetcher: a paused run's host state holds for the next run; only the interval is the run's.
    const kit = fakeClock();
    const pacing = createPacing({ clock: kit.clock });
    const first = pacing.forRun(1_000);
    const starts: number[] = [];
    await first.schedule('a.example', async () => void starts.push(kit.now()));
    first.report('a.example', { status: 429, retryAfter: null });
    // Paused; a new run (or a resume) at another interval.
    const second = pacing.forRun(500);
    expect(second.intervalFor('a.example')).toBe(1_000);
    const next = second.schedule('a.example', async () => void starts.push(kit.now()));
    await kit.run();
    await next;
    expect(starts[1]! - starts[0]!).toBe(1_000);
    expect(pacing.size()).toBe(1);
  });
});
