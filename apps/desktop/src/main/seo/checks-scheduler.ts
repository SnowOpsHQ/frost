// The checks' request scheduler (spec `seo-checks.spec.ts`, `LINK_CHECK_LIMITS`; acceptance
// `seo-checks.feature.md`, Scheduler; review focus `link-checks-are-bounded`). It runs `task` for
// each item, at most `perOrigin` at a time per origin and `maxConcurrency` in all, never starting two
// of one origin less than `intervalMs` apart (the rate limit), in the items' order within an origin.
// When `signal` aborts no task starts any more; the running ones get the same signal, and the run
// settles once they have. A task that throws counts as done. Never rejects.

export interface ScheduleOptions {
  readonly perOrigin: number;
  readonly intervalMs: number;
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
  /** The clock (`Date.now`; injectable for tests). */
  readonly now?: () => number;
}

interface OriginQueue<T> {
  readonly items: T[];
  inflight: number;
  lastStart: number;
}

export function runBounded<T>(items: readonly T[], originOf: (item: T) => string, task: (item: T, signal: AbortSignal) => Promise<unknown>, options: ScheduleOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const { signal } = options;
  const queues = new Map<string, OriginQueue<T>>();
  for (const item of items) {
    const origin = originOf(item);
    let queue = queues.get(origin);
    if (!queue) {
      queue = { items: [], inflight: 0, lastStart: Number.NEGATIVE_INFINITY };
      queues.set(origin, queue);
    }
    queue.items.push(item);
  }
  return new Promise<void>((resolve) => {
    let inflight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', pump);
      resolve();
    };
    function pump(): void {
      if (done) return;
      clearTimeout(timer);
      timer = undefined;
      if (signal.aborted) {
        // Nothing new starts; the running tasks have the signal too.
        if (inflight === 0) finish();
        return;
      }
      let wait = Number.POSITIVE_INFINITY;
      let queued = 0;
      for (const queue of queues.values()) {
        while (queue.items.length > 0 && queue.inflight < options.perOrigin && inflight < options.maxConcurrency) {
          const due = queue.lastStart + options.intervalMs - now();
          if (due > 0) {
            wait = Math.min(wait, due);
            break;
          }
          const item = queue.items.shift()!;
          queue.inflight += 1;
          inflight += 1;
          queue.lastStart = now();
          let running: Promise<unknown>;
          try {
            running = Promise.resolve(task(item, signal));
          } catch (error) {
            running = Promise.reject(error);
          }
          void running
            .catch(() => undefined)
            .then(() => {
              queue.inflight -= 1;
              inflight -= 1;
              pump();
            });
        }
        queued += queue.items.length;
      }
      if (queued === 0 && inflight === 0) finish();
      else if (wait !== Number.POSITIVE_INFINITY && inflight < options.maxConcurrency) timer = setTimeout(pump, wait);
    }
    signal.addEventListener('abort', pump, { once: true });
    pump();
  });
}
