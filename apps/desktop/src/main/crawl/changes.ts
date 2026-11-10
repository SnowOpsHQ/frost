import type { SiteCrawlRepository } from '@app/db';
import { CRAWL_WATCH } from '@app/specs/site-crawl.spec';

// The site crawl's change counter (Phase 12 Task 7; spec `site-crawl.spec.ts`, `CRAWL_WATCH`; acceptance
// `site-crawl.feature.md`, Pages and Site structure: Main). `crawl.watch` long-polls it, as
// `browser.watch` polls the browser state's version. Main counts a change on every write to the crawl
// tables that the sheet shows (a run created, updated or deleted; start-up's pauses), through
// `watchedCrawlRepo`, and whenever the running crawl starts or ends (the crawl service's `onChange`). A
// page is one change: the crawler writes the run's counts after each page row, so the row itself is not
// counted again. At most `CRAWL_WATCH.maxPending` polls wait **per sender** (its window); one more answers
// that sender's oldest early, never another window's. Nothing here reads a row.

export interface CrawlChanges {
  /** The counter: it starts at 1, so a first poll (`sinceVersion` 0) answers at once. */
  version(): number;
  /** Counts a change and answers every waiting poll. */
  bump(): void;
  /**
   * Resolves with the counter once it passes `since` (at once if it already has); when `signal` aborts,
   * or when more than `maxPending` polls of the same `sender` wait (its oldest first), with the counter
   * as it is.
   */
  wait(since: number, signal: AbortSignal, sender?: number | null): Promise<number>;
}

export function createCrawlChanges(maxPending: number = CRAWL_WATCH.maxPending): CrawlChanges {
  let version = 1;
  const waiting: { readonly sender: number | null; readonly done: () => void }[] = [];
  const drop = (waiter: (typeof waiting)[number]) => {
    const at = waiting.indexOf(waiter);
    if (at >= 0) waiting.splice(at, 1);
  };

  return {
    version: () => version,
    bump() {
      version += 1;
      for (const waiter of waiting.splice(0)) waiter.done();
    },
    wait(since, signal, sender = null) {
      if (version > since || signal.aborted) return Promise.resolve(version);
      return new Promise<number>((resolve) => {
        const waiter = {
          sender,
          done: () => {
            signal.removeEventListener('abort', onAbort);
            resolve(version);
          },
        };
        const onAbort = () => {
          drop(waiter);
          waiter.done();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(waiter);
        // Too many of this sender's: its oldest answer now; another sender's polls are never touched.
        const mine = waiting.filter((entry) => entry.sender === sender);
        for (const oldest of mine.slice(0, Math.max(0, mine.length - maxPending))) {
          drop(oldest);
          oldest.done();
        }
      });
    },
  };
}

/**
 * The writes the sheet shows: each counts a change once it is done (whether or not it wrote). `putPage`
 * is not one: the crawler writes the run's counts (`updateRun`) after every page, one change per page.
 */
const WATCHED = ['createRun', 'updateRun', 'deleteRun', 'deleteRunsOfProject', 'pauseInterrupted'] as const satisfies readonly (keyof SiteCrawlRepository)[];

/** `repo` with a change counted after each of its watched writes (`WATCHED`); reads and other writes are `repo`'s own. */
export function watchedCrawlRepo(repo: SiteCrawlRepository, bump: () => void): SiteCrawlRepository {
  const watched: SiteCrawlRepository = { ...repo };
  for (const name of WATCHED) {
    const write = repo[name] as (...args: unknown[]) => Promise<unknown>;
    (watched as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      try {
        return await write(...args);
      } finally {
        bump();
      }
    };
  }
  return watched;
}
