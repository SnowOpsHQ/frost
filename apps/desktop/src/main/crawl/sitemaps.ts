import { decodeRobotsBytes, type CrawlRobotsParse } from '@app/seo-core';
import type { SitemapJob } from '@app/specs/seo-checks.schema';
import { LINK_CHECK_LIMITS, SITEMAP_LIMITS } from '@app/specs/seo-checks.spec';
import type { CrawlSettings } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS, CRAWL_RUN_NOTES, CRAWL_SITEMAP_ACCEPT } from '@app/specs/site-crawl.spec';
import type { CrawlSitemapInput, CrawlSitemapResult } from './analyse';
import type { CrawlFetchOptions, CrawlPageFetch, CrawlRobotsSource } from './fetch';
import type { CrawlScopeRule } from './scope';

// Sitemap seeding (spec `site-crawl.schema.ts`, `CrawlSettingsSchema.sitemaps`; `seo-checks.spec.ts`,
// `SITEMAP_LIMITS`; acceptance `site-crawl.feature.md`, Sitemap seeding; plan Decision 6 and Task 6b,
// with its review). When a run's settings ask for it, a fresh run reads the site's sitemaps before its
// first page: robots.txt's `Sitemap:` lines (main's robots fetcher, parsed in the crawl worker), else
// `/sitemap.xml` of the start's origin.
//
// Every sitemap request is a crawl request: it goes through the run's own page fetch (`fetchPage`), so
// it passes the run's scope (a private start's exact origin included) before anything is requested,
// robots.txt for `CRAWL_ROBOTS_TOKEN` (a disallowed sitemap is never fetched), the per-host pacing
// (`Crawl-delay` learned first, the answer reported, one call in flight per host) and the redirect hook
// (each hop checked before it is requested; a hop to another host ends the call and is followed here as
// a new request through the same checks, at most `LINK_CHECK_LIMITS.maxRedirects` of them). Only the
// caps (`SITEMAP_LIMITS.maxBytes`, `timeoutMs`, within `maxRunBytes`) and `Accept` are the sitemap's.
//
// Each file is read in the crawl worker as the sitemap check reads it (`parseSitemap`: no DTD, gzip
// inflated within `maxBytes`), **once**: the worker keeps its `<loc>` URLs and hands them out
// `CRAWL_LIMITS.sitemapUrlsPerJob` at a time, then drops them. An index's files are followed within
// `maxFiles` and `maxDepth`. URLs go straight to the frontier at depth 1, source `sitemap` (in scope
// only; never an inlink); at most the run's `maxPages` are seeded. A window that does not answer in time
// stops seeding with a log line and the run's note (`CRAWL_RUN_NOTES.sitemapTimeout`); any other failure
// to read a file (its fetch refused or failed, its parse failed) seeds nothing more from it. A store that
// fails (the run's fetch storing its pacing before a sitemap request or a hop, or the frontier taking
// the seeds) is never skipped: seeding rejects with it and the run fails (`error`; council review
// round 3, item I). A sitemap request answered as a slow-down (`backoffAfter` 429 / 503
// in a row, or `deferred`) stops seeding and says so (`slowDown`): the crawler pauses the run
// (`slow-down`) before any page is fetched (council review, item 4).

export interface SitemapSeederDeps {
  /** Main's robots.txt fetcher (`robots.get`; for a private start with the exact-origin rule): the `Sitemap:` lines. */
  readonly robots: CrawlRobotsSource;
  /** robots.txt text parsed in the crawl worker (`Analyzer.crawlRobots`). */
  readonly parseRobots: (text: string) => Promise<CrawlRobotsParse>;
  /** One sitemap window job in the crawl worker (`Analyzer.crawlSitemap`). */
  readonly analyse: (input: CrawlSitemapInput) => Promise<CrawlSitemapResult>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** What one run's seeding needs from the crawler. */
export interface SitemapSeedRun {
  readonly runId: string;
  readonly settings: CrawlSettings;
  readonly scope: CrawlScopeRule;
  /** The run's page fetch (`CrawlRunFetcher.fetchPage` with the run's signal and its `beforeRequest`). */
  readonly fetch: (url: string, options: CrawlFetchOptions) => Promise<CrawlPageFetch>;
  readonly signal: AbortSignal;
  /** Queues URLs met in a sitemap (`CrawlFrontier.discover(urls, 1, 'sitemap')`); answers how many were new. */
  readonly seed: (urls: readonly string[]) => Promise<number>;
}

export interface SitemapSeedReport {
  /** URLs that were new to the frontier. */
  readonly seeded: number;
  /** The run's note, when seeding stopped early for a reason the user should know (`CRAWL_RUN_NOTES`). */
  readonly note: string | null;
  /** The site asked frost to slow down on a sitemap request (or a new host was `deferred`): the run pauses (`slow-down`). */
  readonly slowDown: boolean;
}

export interface SitemapSeeder {
  /**
   * Seeds the run's frontier from the site's sitemaps. A sitemap it cannot read is skipped; it rejects
   * only when the run's store fails (the run's fetch storing its pacing, or `seed` writing the
   * frontier: round 3, item I), with that error, and the crawler fails the run (`error`).
   */
  seed(run: SitemapSeedRun): Promise<SitemapSeedReport>;
}

/** `raw` resolved against `base` as a sitemap URL (`http(s)`, no fragment, within `maxLocChars`); `null` otherwise. */
function sitemapUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href.length <= SITEMAP_LIMITS.maxLocChars ? url.href : null;
  } catch {
    return null;
  }
}

/** A store failure inside seeding (the run's fetch storing its pacing, or the frontier): passed up so the run fails (round 3, item I). */
class SeedStoreError extends Error {
  constructor(readonly error: unknown) {
    super('a sitemap seed could not be stored');
    this.name = 'SeedStoreError';
  }
}

/** `work`'s answer; whatever it throws is a store failure (`SeedStoreError`), never a sitemap the seeding may skip. */
async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new SeedStoreError(error);
  }
}

/** Why seeding stopped before its sources ran out (`null`: it did not). */
type Stop = 'aborted' | 'slow-down' | 'timeout' | null;

export function createSitemapSeeder(deps: SitemapSeederDeps): SitemapSeeder {
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log?.(`crawl: ${line}`);
  let jobs = 0;

  /** The run's first sitemaps: robots.txt's `Sitemap:` lines (at most `maxSources`), else `/sitemap.xml`. */
  async function sources(run: SitemapSeedRun): Promise<string[]> {
    const origin = new URL(run.scope.start).origin;
    try {
      const robots = await deps.robots.get(run.scope.start, run.scope.privateStart ? { exactOrigin: true } : undefined);
      if (robots?.outcome === 'ok') {
        const parsed = await deps.parseRobots(decodeRobotsBytes(robots.body));
        const base = robots.finalUrl ?? robots.url;
        const listed = [...new Set(parsed.file.sitemaps.map((sitemap) => sitemapUrl(sitemap.raw, base)).filter((url): url is string => url !== null))];
        if (listed.length > 0) return listed.slice(0, SITEMAP_LIMITS.maxSources);
      }
    } catch {
      // No readable robots.txt: the fallback (its own request still passes robots.txt, which then blocks it).
    }
    return [`${origin}/sitemap.xml`];
  }

  /**
   * One sitemap file through the crawl's own fetch: refused before any request when out of scope or
   * disallowed; a redirect to another host followed as a new crawl request (same checks), within
   * `LINK_CHECK_LIMITS.maxRedirects`.
   */
  async function fetchFile(run: SitemapSeedRun, url: string, maxBytes: number): Promise<CrawlPageFetch | 'slow-down' | null> {
    let target = url;
    for (let hops = 0; hops <= LINK_CHECK_LIMITS.maxRedirects; hops++) {
      if (run.scope.check(target) !== 'in') return null;
      // The run's fetch answers every fetch failure and refusal as an outcome: what it throws is its store failing.
      const fetched = await stored(() => run.fetch(target, { maxBytes, timeoutMs: SITEMAP_LIMITS.timeoutMs, accept: CRAWL_SITEMAP_ACCEPT, maxRedirects: LINK_CHECK_LIMITS.maxRedirects }));
      if (fetched.outcome === 'deferred' || fetched.slowDown) return 'slow-down';
      if (fetched.outcome === 'redirected' && fetched.redirectTarget !== null) {
        target = fetched.redirectTarget;
        continue;
      }
      return fetched.outcome === 'response' ? fetched : null;
    }
    return null;
  }

  return {
    async seed(run) {
      if (!run.settings.sitemaps) return { seeded: 0, note: null, slowDown: false };
      const budget = Math.min(run.settings.maxPages, SITEMAP_LIMITS.maxUrls);
      let seeded = 0;
      let counted = 0;
      let downloaded = 0;
      let stop: Stop = null;
      try {
        const queue = (await sources(run)).map((url) => ({ url, depth: 0 }));
        const seen = new Set(queue.map((file) => file.url));
        let files = 0;
        while (queue.length > 0 && files < SITEMAP_LIMITS.maxFiles && counted < budget && stop === null) {
          if (run.signal.aborted) {
            stop = 'aborted';
            break;
          }
          const { url, depth } = queue.shift()!;
          const left = SITEMAP_LIMITS.maxRunBytes - downloaded;
          if (left <= 0) break;
          files += 1;
          const answer = await fetchFile(run, url, Math.min(SITEMAP_LIMITS.maxBytes, left));
          if (answer === 'slow-down') {
            stop = 'slow-down';
            break;
          }
          if (answer === null || run.signal.aborted) continue;
          downloaded += answer.bytes;
          if (answer.status === null || answer.status < 200 || answer.status > 299 || answer.truncated || answer.finalUrl === null) continue;
          // The file is parsed once in the worker and kept there; its URLs come back a window at a time.
          const key = `sitemap-${++jobs}`;
          try {
            const job: SitemapJob = { kind: 'sitemap', bytes: answer.body, fileUrl: answer.finalUrl, pageUrl: run.scope.start, canonicalUrl: null, urlBudget: budget - counted, now: now() };
            let read = await deps.analyse({ key, job, take: CRAWL_LIMITS.sitemapUrlsPerJob });
            for (let skip = 0; ; ) {
              if (!read.ok) {
                if (read.reason === 'analysis-timeout') stop = 'timeout';
                break;
              }
              if (skip === 0 && read.sitemap.type === 'index') {
                for (const child of read.sitemap.children) {
                  if (seen.has(child) || depth + 1 > SITEMAP_LIMITS.maxDepth) continue;
                  seen.add(child);
                  queue.push({ url: child, depth: depth + 1 });
                }
                break;
              }
              if (read.urls.length === 0 || run.signal.aborted) break;
              const urls = read.urls;
              counted += urls.length;
              seeded += await stored(() => run.seed(urls));
              skip += read.urls.length;
              if (skip >= read.total || counted >= budget) break;
              read = await deps.analyse({ key, skip, take: Math.min(CRAWL_LIMITS.sitemapUrlsPerJob, budget - counted) });
            }
          } finally {
            await deps.analyse({ key, release: true }).catch(() => undefined);
          }
        }
      } catch (error) {
        // The run's store failed (a pacing write, the frontier): the run fails (round 3, item I).
        if (error instanceof SeedStoreError) throw error.error;
        // A sitemap that cannot be read (its fetch refused or failed, its parse failed) seeds nothing more.
      }
      if (stop === 'timeout') {
        log(`a sitemap window did not answer in time; seeding stopped (run ${run.runId})`);
        return { seeded, note: CRAWL_RUN_NOTES.sitemapTimeout, slowDown: false };
      }
      return { seeded, note: null, slowDown: stop === 'slow-down' };
    },
  };
}
