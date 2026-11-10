import type { CrawlPacedHost } from '@app/specs/site-crawl.schema';
import { CRAWL_INTERVAL_MS, CRAWL_LIMITS, CRAWL_PACING_LIMITS, MAX_CRAWL_DELAY_MS } from '@app/specs/site-crawl.spec';

// The crawl's pacing (spec `site-crawl.spec.ts`, `CRAWL_INTERVAL_MS`, `MAX_CRAWL_DELAY_MS`,
// `CRAWL_LIMITS.backoffAfter` / `maxRetryAfterMs` / `maxPacedHosts`; acceptance `site-crawl.feature.md`,
// crawl-is-polite, crawl-honours-crawl-delay-and-retry-after, crawl-backs-off-and-pauses; plan
// Decision 3 K-B1 and Decision 6; Task 6a security review). Per **host name** (scheme and port
// aside: `http` and `https` of one host share it): one fetch call in flight, and each call starts no
// sooner than the effective interval after the previous call **started** there (and no sooner than a
// `Retry-After` allows). The effective interval is the run's choice, raised to the host's
// `Crawl-delay` (capped; the largest its origins asked for), then doubled per 429 / 503 answer in a
// row. A fetch call is one page's request with its same-host redirect hops (followed at once, inside
// the call); a redirect to another host name ends the call (`redirected`), so no host is ever reached
// outside its own pacing. The crawl lane's floor (`CRAWL_FETCHER_LIMITS`) is a second guarantee only.
//
// The pacing state is the crawl fetcher's, not a run's: within one session it survives a pause, a
// resume and a new run (`createPacing`, one per crawl fetcher); only the user's interval belongs to the
// run (`forRun`). Across a restart or a crash (a new crawl fetcher) the run carries it: `snapshot` gives each
// host's next allowed start and back-off (stored on the run, `CRAWL_PACING_LIMITS`), and `restore` seeds a
// resumed run's pacing from it (whole-branch review, `crawl-pacing-survives-a-restart`). `changes` counts
// every change to a host's state a stored snapshot would miss (council review, item 5): a back-off set or
// cleared, a `Retry-After`, a `Crawl-delay` learned or changed. A call about to start while the host's
// interval is raised above the run's own (by `Crawl-delay` or back-off) is `startRaises`: its start moves
// the host's `waitUntil`, so the crawler stores `snapshot(host)` (that start counted as now) **before**
// the request goes out (council review round 2, item B), and a crash or kill with it in flight never
// loses it; a plain call at the run's own interval changes nothing (a run with neither stores nothing
// per page). It is bounded: a host's state is forgotten only once no start could be early without it (its longest
// possible wait has passed), and past `maxPacedHosts` a new host is refused (`CrawlSlowDownError`)
// rather than forgetting one too soon. The clock and the timer are injected (tests: a fake clock).

/** Time and timers (main: `Date.now` and `setTimeout`; tests: a fake clock). `setTimeout` answers a function that cancels it. */
export interface CrawlClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

/** The system clock. */
export const systemClock: CrawlClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** A scheduled call taken out of its queue by its signal before it started. */
export class CrawlAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'CrawlAbortedError';
  }
}

/** A call to a new host refused because `maxPacedHosts` hosts are paced and none can be forgotten yet (the run pauses, `slow-down`). */
export class CrawlSlowDownError extends Error {
  constructor() {
    super('too many hosts paced at once');
    this.name = 'CrawlSlowDownError';
  }
}

/** What an answer did to a host's back-off: 429 / 503 answers in a row, and whether that many pause the run (`CRAWL_SLOW_DOWN_MESSAGE`). */
export interface PolitenessReport {
  readonly inARow: number;
  readonly slowDown: boolean;
}

/** The pacing key of a URL: its host name, lowercased, trailing dots dropped (`null`: not a URL). */
export function pacingKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

/** One run's view of the crawl's pacing (its own interval; the hosts' state is shared). Keys are `pacingKey`s. */
export interface Politeness {
  /**
   * Runs `fn` (one fetch call to `host`) when the host is free and its interval has passed: at once
   * for an idle host. `before`, when given, is awaited first inside the host's slot (the slot stays
   * held): the last async checks before the request. The call's start is stamped only once `before` has
   * settled, right before `fn` is called with nothing awaited between (council review round 2, item A:
   * a slow check never brings two requests closer than the interval). A `before` that rejects ends the
   * call with its error, no start stamped (nothing was requested). Answers what `fn` answers; rejects
   * with `CrawlAbortedError` when `signal` aborts before `fn` started (an abort once it runs is `fn`'s
   * to handle), and with `CrawlSlowDownError` for a new host while `maxPacedHosts` are paced.
   */
  schedule<T>(host: string, fn: () => Promise<T>, signal?: AbortSignal, before?: () => Promise<void>): Promise<T>;
  /** `Crawl-delay` for `host` as `source` (an origin's robots.txt; default the host) asked for it (ms; `null`: none). The host keeps the largest. */
  setCrawlDelay(host: string, ms: number | null, source?: string): void;
  /** A call's answer: its status (`null`: none, a network error, which changes nothing) and its `Retry-After` header. */
  report(host: string, answer: { readonly status: number | null; readonly retryAfter: string | null | undefined }): PolitenessReport;
  /** The effective interval for `host` now, at this run's interval (ms). */
  intervalFor(host: string): number;
  /** Hosts with state held (at most `maxPacedHosts`; K-B3 counts it). */
  size(): number;
  /**
   * Each host whose next start is still ahead or that is backed off: `waitUntil`, the later of its
   * `Retry-After` and its last start plus its effective interval at this run's interval, and its 429 /
   * 503 answers in a row (capped at `backoffAfter`). Host names past `CRAWL_PACING_LIMITS.maxHostChars`
   * are left out. With `starting`, that host's call is taken to start now (what the crawler stores just
   * before its request). What a run stores as it changes, before a raised start, and as it pauses.
   */
  snapshot(starting?: string): CrawlPacedHost[];
  /**
   * Seeds hosts from a stored `snapshot` (a resume after a restart): no start before `waitUntil` (honoured
   * at most `CRAWL_PACING_LIMITS.maxWaitMs` ahead), the back-off at least the stored one. Never loosens a
   * held state; a host the table has no room for is skipped.
   */
  restore(hosts: readonly CrawlPacedHost[]): void;
  /**
   * A counter that moves whenever a host's state changes in a way a stored snapshot would miss: a
   * back-off set or cleared, a `Retry-After` taken, a host's `Crawl-delay` changed. Never moved by
   * `restore` or by a start. The crawler stores the snapshot whenever it moved (council review, item 5).
   */
  changes(): number;
  /**
   * Whether a call starting on `host` now moves its `waitUntil` past what this run's own interval would
   * give (its effective interval is raised, by `Crawl-delay` or back-off): the crawler then stores
   * `snapshot(host)` before the request (council review round 2, item B).
   */
  startRaises(host: string): boolean;
}

export interface Pacing {
  /** A run's view at the user's `intervalMs` (clamped to `CRAWL_INTERVAL_MS`). */
  forRun(intervalMs: number): Politeness;
  size(): number;
}

/** The user's interval, within `CRAWL_INTERVAL_MS` (anything else: the default). */
export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return CRAWL_INTERVAL_MS.default;
  return Math.min(CRAWL_INTERVAL_MS.max, Math.max(CRAWL_INTERVAL_MS.min, Math.round(ms)));
}

/** A `Retry-After` value (seconds, or an HTTP date) as a wait from `now` (ms, capped at `CRAWL_LIMITS.maxRetryAfterMs`); `0` when absent, past or malformed. */
export function retryAfterMs(value: string | null | undefined, now: number): number {
  if (value === null || value === undefined) return 0;
  const text = value.trim();
  let wait: number;
  if (/^\d+$/.test(text)) wait = Number(text) * 1_000;
  else {
    const at = /[a-z]/i.test(text) ? Date.parse(text) : Number.NaN;
    wait = Number.isNaN(at) ? 0 : at - now;
  }
  // NaN, zero or negative: nothing to wait; a huge value (even `Infinity`) waits the cap.
  return wait > 0 ? Math.min(CRAWL_LIMITS.maxRetryAfterMs, wait) : 0;
}

interface HostState {
  busy: boolean;
  lastStart: number;
  waiting: { readonly start: () => void; readonly intervalMs: number }[];
  cancelTimer: (() => void) | undefined;
  /** `Crawl-delay` per source (an origin's robots.txt), ms. */
  readonly crawlDelays: Map<string, number>;
  inARow: number;
  retryUntil: number;
}

const delayOf = (state: HostState | undefined): number => (state ? Math.min(MAX_CRAWL_DELAY_MS, Math.max(0, ...state.crawlDelays.values())) : 0);

/** The effective interval of `state` at a run's `intervalMs`. */
const intervalOf = (state: HostState | undefined, intervalMs: number): number => Math.max(intervalMs, delayOf(state)) * 2 ** Math.min(state?.inARow ?? 0, CRAWL_LIMITS.backoffAfter);

/**
 * Whether forgetting `state` at `at` can never make a start early: idle, past its longest possible wait
 * (the largest interval any run may choose, raised to its `Crawl-delay`, at full back-off) and past its
 * `Retry-After`.
 */
const forgettable = (state: HostState, at: number): boolean =>
  !state.busy && state.waiting.length === 0 && state.cancelTimer === undefined && at >= state.lastStart + Math.max(CRAWL_INTERVAL_MS.max, delayOf(state)) * 2 ** CRAWL_LIMITS.backoffAfter && at >= state.retryUntil;

/** The crawl's pacing: per-host state shared by every run of one crawl fetcher. */
export function createPacing(options: { readonly clock?: CrawlClock; readonly maxHosts?: number } = {}): Pacing {
  const clock = options.clock ?? systemClock;
  const maxHosts = options.maxHosts ?? CRAWL_LIMITS.maxPacedHosts;
  const states = new Map<string, HostState>();
  /** `Politeness.changes`: shared by every run of this pacing, as the hosts' state is. */
  let changes = 0;

  /** `host`'s state, created if room can be made safely; `undefined` when every slot is held by a host that cannot be forgotten yet. */
  const stateOf = (host: string): HostState | undefined => {
    const known = states.get(host);
    if (known) return known;
    if (states.size >= maxHosts) {
      const at = clock.now();
      for (const [key, value] of states) if (forgettable(value, at)) states.delete(key);
      if (states.size >= maxHosts) return undefined;
    }
    const state: HostState = { busy: false, lastStart: Number.NEGATIVE_INFINITY, waiting: [], cancelTimer: undefined, crawlDelays: new Map(), inARow: 0, retryUntil: Number.NEGATIVE_INFINITY };
    states.set(host, state);
    return state;
  };

  /** Starts `host`'s next call when it is free and its interval (at that call's run interval) has passed: now, or by a timer. */
  const pump = (state: HostState): void => {
    if (state.busy || state.cancelTimer !== undefined || state.waiting.length === 0) return;
    const at = clock.now();
    const wait = Math.max(state.lastStart + intervalOf(state, state.waiting[0]!.intervalMs), state.retryUntil) - at;
    if (wait > 0) {
      state.cancelTimer = clock.setTimeout(() => {
        state.cancelTimer = undefined;
        pump(state);
      }, wait);
      return;
    }
    const next = state.waiting.shift()!;
    state.busy = true;
    next.start();
  };

  /** Stamps a call's start on `state`, right before its request (a raised start was stored before it: `startRaises`). */
  const stamp = (state: HostState): void => {
    state.lastStart = clock.now();
  };

  return {
    size: () => states.size,
    forRun(runIntervalMs) {
      const intervalMs = clampInterval(runIntervalMs);
      return {
        schedule<T>(host: string, fn: () => Promise<T>, signal?: AbortSignal, before?: () => Promise<void>): Promise<T> {
          if (signal?.aborted) return Promise.reject(new CrawlAbortedError());
          const state = stateOf(host);
          if (!state) return Promise.reject(new CrawlSlowDownError());
          return new Promise<T>((resolve, reject) => {
            const item = {
              intervalMs,
              start: () => {
                signal?.removeEventListener('abort', onAbort);
                /** The start is stamped here, after `before`, and `fn` called with nothing awaited between. */
                const call = (): Promise<T> => {
                  stamp(state);
                  return fn();
                };
                let running: Promise<T>;
                try {
                  running = before ? before().then(call) : call();
                } catch (error) {
                  running = Promise.reject(error);
                }
                void running.then(resolve, reject).finally(() => {
                  state.busy = false;
                  pump(state);
                });
              },
            };
            const onAbort = () => {
              const index = state.waiting.indexOf(item);
              if (index < 0) return;
              state.waiting.splice(index, 1);
              if (state.waiting.length === 0 && state.cancelTimer !== undefined) {
                state.cancelTimer();
                state.cancelTimer = undefined;
              }
              reject(new CrawlAbortedError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            state.waiting.push(item);
            pump(state);
          });
        },
        setCrawlDelay(host, ms, source = host) {
          const state = stateOf(host);
          if (!state) return;
          const before = delayOf(state);
          if (ms === null || !Number.isFinite(ms) || ms <= 0) state.crawlDelays.delete(source);
          else state.crawlDelays.set(source, Math.min(MAX_CRAWL_DELAY_MS, ms));
          if (delayOf(state) !== before) changes += 1;
        },
        report(host, answer) {
          const state = stateOf(host);
          if (!state) return { inARow: 0, slowDown: true };
          if (answer.status === 429 || answer.status === 503) {
            state.inARow += 1;
            const wait = retryAfterMs(answer.retryAfter, clock.now());
            if (wait > 0) state.retryUntil = Math.max(state.retryUntil, clock.now() + wait);
            changes += 1;
          } else if (answer.status !== null && state.inARow > 0) {
            state.inARow = 0;
            changes += 1;
          }
          return { inARow: state.inARow, slowDown: state.inARow >= CRAWL_LIMITS.backoffAfter };
        },
        intervalFor: (host) => intervalOf(states.get(host), intervalMs),
        size: () => states.size,
        snapshot(starting) {
          const at = clock.now();
          const hosts: CrawlPacedHost[] = [];
          for (const [host, state] of states) {
            if (host.length === 0 || host.length > CRAWL_PACING_LIMITS.maxHostChars) continue;
            const lastStart = host === starting ? Math.max(state.lastStart, at) : state.lastStart;
            const waitUntil = Math.max(state.retryUntil, lastStart + intervalOf(state, intervalMs));
            const inARow = Math.min(state.inARow, CRAWL_LIMITS.backoffAfter);
            if (waitUntil <= at && inARow === 0) continue;
            hosts.push({ host, waitUntil: Number.isFinite(waitUntil) ? Math.max(0, Math.ceil(waitUntil)) : 0, inARow });
          }
          return hosts;
        },
        restore(hosts) {
          const limit = clock.now() + CRAWL_PACING_LIMITS.maxWaitMs;
          for (const entry of hosts) {
            if (!Number.isFinite(entry.waitUntil) || !Number.isInteger(entry.inARow) || entry.inARow < 0) continue;
            const state = stateOf(entry.host);
            if (!state) continue;
            state.inARow = Math.max(state.inARow, Math.min(entry.inARow, CRAWL_LIMITS.backoffAfter));
            state.retryUntil = Math.max(state.retryUntil, Math.min(entry.waitUntil, limit));
          }
        },
        changes: () => changes,
        startRaises: (host) => intervalOf(states.get(host), intervalMs) > intervalMs,
      };
    },
  };
}

/** One run's pacing over a pacing of its own (tests, and a crawl fetcher's first run). */
export function createPoliteness(options: { readonly intervalMs: number; readonly clock?: CrawlClock; readonly maxHosts?: number }): Politeness {
  return createPacing({ ...(options.clock ? { clock: options.clock } : {}), ...(options.maxHosts !== undefined ? { maxHosts: options.maxHosts } : {}) }).forRun(options.intervalMs);
}
