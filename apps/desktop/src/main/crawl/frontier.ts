import type { CrawlFrontierEntry, SiteCrawlRepository } from '@app/db';
import { CRAWL_LIMITS, type CrawlDiscoverySource } from '@app/specs/site-crawl.spec';
import { normaliseCrawlUrl, type CrawlScopeRule } from './scope';

// A run's frontier (spec `site-crawl.spec.ts`, `CRAWL_FRONTIER_STATES`, `CRAWL_LIMITS.frontierWindow`,
// `maxDepth`, `maxQueryVariantsPerPath`; acceptance `site-crawl.feature.md`, The frontier; plan
// Decision 6, Decision 3 K-B3 and Task 6b). The frontier lives in SQLite (`crawl_frontier`): it is the
// queue, the seen-set, the authority for inlinks and sitemap orphans, and (Task 6b) for the per-path
// query-variant cap, so a resumed run, or a new crawler after a restart, counts what the run already
// holds. In memory only a window of the oldest queued entries (at most `frontierWindow`), read again
// when it is used up, and the batch being discovered.
//
// A discovered URL is normalised (`normaliseCrawlUrl`: tracking parameters stripped, the fragment
// dropped) and queued only when it is in the run's scope; a new one only within `CRAWL_LIMITS.maxDepth`
// and, when it has a query, while its path has fewer than `maxQueryVariantsPerPath` variants in the
// frontier. A URL the frontier already holds is recorded again whatever its depth or query (one inlink
// per discovering page, a sitemap flag), and keeps its lower depth while it is queued.

export interface CrawlFrontier {
  /** The oldest queued entry not handed out yet (reading the next window when this one is used up); `null` when none is queued. */
  next(): Promise<CrawlFrontierEntry | null>;
  /** Forgets the window (a pause or an end): the next `next()` reads the frontier again. */
  reset(): void;
  /**
   * Records what one source met at `depth` (one call per discovering page, the start URL, or a sitemap
   * file's batch): answers how many URLs were new. Out-of-scope and unparseable URLs are left out.
   */
  discover(urls: readonly string[], depth: number, source: CrawlDiscoverySource): Promise<number>;
  /** Marks `url` done (fetched, refused or skipped): it stays seen. */
  done(url: string): Promise<void>;
  queued(): Promise<number>;
  /** Entries held in memory now (K-B3): the window, and the batch being discovered. */
  memory(): { readonly window: number; readonly pending: number; readonly paths: number };
}

/** `url` without its query (`origin` + `path`), when it has one; `null` otherwise. */
function baseOf(url: string): string | null {
  const at = url.indexOf('?');
  return at < 0 ? null : url.slice(0, at);
}

export function createFrontier(options: { readonly repo: SiteCrawlRepository; readonly runId: string; readonly scope: CrawlScopeRule; readonly window?: number }): CrawlFrontier {
  const { repo, runId, scope } = options;
  const size = Math.max(1, Math.min(options.window ?? CRAWL_LIMITS.frontierWindow, CRAWL_LIMITS.frontierWindow));
  let window: CrawlFrontierEntry[] = [];
  /** URLs handed out from this window and not yet done (never handed out twice while queued). */
  const handed = new Set<string>();
  let pending = 0;
  let paths = 0;
  /** Queued entries, counted once from SQLite and then kept up to date here (`null`: not counted yet). */
  let queuedCount: number | null = null;

  return {
    async next() {
      for (;;) {
        const entry = window.shift();
        if (entry) {
          if (handed.has(entry.url)) continue;
          handed.add(entry.url);
          return entry;
        }
        handed.clear();
        window = await repo.nextQueued(runId, size);
        if (window.length === 0) return null;
      }
    },

    reset() {
      window = [];
      handed.clear();
      queuedCount = null;
    },

    async discover(urls, depth, source) {
      // Normalised, in scope, once each.
      const found = new Set<string>();
      for (const raw of urls) {
        const url = normaliseCrawlUrl(raw);
        if (url !== null && scope.check(url) === 'in') found.add(url);
      }
      if (found.size === 0) return 0;
      pending = found.size;
      try {
        const known = await repo.knownUrls(runId, [...found]);
        const admitted: string[] = [];
        // New query variants per path, counted from the frontier (SQLite) plus those admitted in this batch.
        const variants = new Map<string, number>();
        for (const url of found) {
          if (known.has(url)) {
            admitted.push(url);
            continue;
          }
          if (depth > CRAWL_LIMITS.maxDepth) continue;
          const base = baseOf(url);
          if (base !== null) {
            let held = variants.get(base);
            if (held === undefined) held = await repo.queryVariantCount(runId, base);
            if (held >= CRAWL_LIMITS.maxQueryVariantsPerPath) {
              variants.set(base, held);
              continue;
            }
            variants.set(base, held + 1);
            paths = variants.size;
          }
          admitted.push(url);
        }
        // A known URL past the depth cap keeps its own (lower) depth: it is recorded at the cap.
        const at = Math.min(depth, CRAWL_LIMITS.maxDepth);
        const added = admitted.length === 0 ? 0 : await repo.enqueue(runId, admitted.map((url) => ({ url, depth: at, source })));
        if (queuedCount !== null) queuedCount += added;
        return added;
      } finally {
        pending = 0;
        paths = 0;
      }
    },

    async done(url) {
      await repo.markDone(runId, [url]);
      // Only a handed-out entry (a queued one) is marked done here.
      if (handed.delete(url) && queuedCount !== null) queuedCount = Math.max(0, queuedCount - 1);
    },

    async queued() {
      queuedCount ??= await repo.queuedCount(runId);
      return queuedCount;
    },

    memory: () => ({ window: window.length + handed.size, pending, paths }),
  };
}
