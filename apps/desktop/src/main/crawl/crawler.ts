import type { SiteCrawlRepository } from '@app/db';
import { SERVED_HTML_TYPES } from '@app/specs/seo-javascript.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { CrawlPacedHost, CrawlPageAnalysis, CrawlPageJob, CrawlPageRow, CrawlRunView, CrawlSettings } from '@app/specs/site-crawl.schema';
import { CRAWL_FAILED_OUTCOMES, CRAWL_KEEP_HEADERS, CRAWL_LIMITS, CRAWL_REFUSED_OUTCOMES, type CrawlPageOutcome, type CrawlRunReason, type CrawlRunState } from '@app/specs/site-crawl.spec';
import { mediaType } from '../seo/served';
import type { CrawlPageResult } from './analyse';
import type { CrawlFetchOptions, CrawlPageFetch } from './fetch';
import { createFrontier, type CrawlFrontier } from './frontier';
import type { Politeness } from './politeness';
import { normaliseCrawlUrl, type CrawlScopeRule } from './scope';
import type { SitemapSeeder } from './sitemaps';

// One crawl run, page by page (spec `site-crawl.spec.ts`, `CRAWL_LIMITS`, `CRAWL_RUN_STATES`,
// `CRAWL_RUN_REASONS`, `CRAWL_PAGE_OUTCOMES`; acceptance `site-crawl.feature.md`, Runs, frontier, resume
// and the served-HTML audit; plan Decision 6, Decision 3 K-B3 and Task 6b). A run takes the oldest queued
// URL of its frontier (SQLite), checks that its project is still live (a synced tombstone cancels it
// before any fetch call), fetches it through the run's crawl fetcher (scope, robots.txt, pacing: Task
// 6a), and records one row as the page ends:
// - an HTML answer is parsed and audited in the crawl worker (`analyse`, the served-HTML rules only),
//   its body cut to `CRAWL_LIMITS.maxBodyBytes` before it is sent; its links (those the served parse
//   kept) are discovered at depth + 1 when it answered 2xx, and the first `maxLinksStoredPerPage` stored;
// - another media type is recorded `not-html`, never parsed;
// - `redirected` (another host name) is recorded and its target queued at depth + 1, as a link;
// - a refusal or a failure is recorded as such; `deferred` records nothing, leaves the URL queued and
//   pauses the run (`slow-down`), as `slowDown` does after its row.
// Nothing is written once the run is stopped: every write follows a check of its signal, and a fetch or
// a parse still under way when it stops is left to end on its own (its answer is dropped). The run ends
// `done` when the frontier is empty or `maxPages` rows are recorded (`max-pages` with URLs still
// queued); `paused` (by the user, a quit, a slow-down) or `cancelled` (by the user, or its project gone)
// when stopped; `failed` (`error`) when the database fails. Held in memory: the frontier's window, one
// page's links while they are discovered, the pacing table (K-B3); every page goes to SQLite at once.
// A run that pauses (any reason) stores its pacing with its end (`Politeness.snapshot`; a finished one
// clears it), and a resumed run seeds its crawl fetcher's pacing from it before its first request, so a
// restart never lets a resume reach a host sooner than it asked (`crawl-pacing-survives-a-restart`).

/** What one run's fetching offers the crawler (`CrawlFetcher.forRun`; tests fake it). */
export interface CrawlerRunFetcher {
  readonly scope: CrawlScopeRule;
  fetchPage(url: string, signal?: AbortSignal, options?: CrawlFetchOptions): Promise<CrawlPageFetch>;
  readonly politeness?: Politeness;
}

export interface CrawlerDeps {
  readonly repo: SiteCrawlRepository;
  /** The crawl fetcher (`createCrawlFetcher`): a run's scope, pacing and page fetch. */
  readonly fetcher: { forRun(settings: CrawlSettings): CrawlerRunFetcher };
  /** One page's parse and audit in the crawl worker (`Analyzer.analyseCrawlPage`). */
  readonly analyse: (job: CrawlPageJob) => Promise<CrawlPageResult>;
  /** Sitemap seeding for a fresh run whose settings ask for it (`createSitemapSeeder`). */
  readonly sitemaps?: SitemapSeeder;
  /** Whether a project is live (not tombstoned, not deleted): checked before every fetch call of a project's run. */
  readonly projectLive: (projectId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Called after every page with what the crawler holds in memory (K-B3's test counts it). */
  readonly observe?: (memory: CrawlMemory) => void;
}

/** The crawler's in-memory entries (K-B3: their sum stays under `CRAWL_LIMITS.maxInMemoryEntries`). */
export interface CrawlMemory {
  /** Frontier entries read from SQLite and not yet done (at most `frontierWindow`). */
  readonly frontierWindow: number;
  /** One page's links, held while they are stored and discovered (at most `SNAPSHOT_LIMITS.maxLinks`). */
  readonly pendingLinks: number;
  /** Hosts whose pacing state is held (at most `maxPacedHosts`). */
  readonly pacedHosts: number;
  /** Paths whose query variants one discovery counts (keys of that page's links: never more than `pendingLinks`). */
  readonly queryPaths: number;
}

/** Why a run is stopped from outside: the user's Pause or Cancel, a quit, or its project's deletion. */
export type CrawlStopReason = 'pause' | 'cancel' | 'quit' | 'project-deleted';

/** How a run ended (its stored state and reason). */
export interface CrawlRunEnd {
  readonly state: CrawlRunState;
  readonly reason: CrawlRunReason | null;
}

export interface CrawlRunHandle {
  readonly runId: string;
  readonly projectId: string | null;
  /** Settles once the run has ended and its end is stored; never rejects. */
  readonly done: Promise<CrawlRunEnd>;
  /** Stops the run (the first reason wins); nothing more is fetched or written for it. */
  stop(why: CrawlStopReason): void;
  /** This session's note about the run (`CRAWL_RUN_NOTES`), or `null`. */
  note(): string | null;
  /** The run's pacing now (`Politeness.snapshot`), for a quit's immediate write; `null` before its fetcher exists. */
  pacing?(): CrawlPacedHost[] | null;
}

export interface Crawler {
  /** Runs `run` (its settings readable): `fresh` queues its start URL and seeds sitemaps first; otherwise it continues from its frontier. */
  run(run: CrawlRunView & { readonly settings: CrawlSettings }, fresh: boolean): CrawlRunHandle;
}

const STOPPED: Readonly<Record<CrawlStopReason, CrawlRunEnd>> = {
  pause: { state: 'paused', reason: 'user' },
  cancel: { state: 'cancelled', reason: 'user' },
  quit: { state: 'paused', reason: 'quit' },
  'project-deleted': { state: 'cancelled', reason: 'project-deleted' },
};
const SLOW_DOWN: CrawlRunEnd = { state: 'paused', reason: 'slow-down' };
const TERMINAL: ReadonlySet<CrawlRunState> = new Set(['done', 'cancelled', 'failed']);
const REFUSED: ReadonlySet<string> = new Set(CRAWL_REFUSED_OUTCOMES);
const FAILED: ReadonlySet<string> = new Set(CRAWL_FAILED_OUTCOMES);
const HTML: ReadonlySet<string> = new Set(SERVED_HTML_TYPES);
const ABORTED = Symbol('aborted');

/** `promise`'s value, or `ABORTED` as soon as `signal` aborts (the promise is left to settle on its own). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** An error's code or name for the log, never its message (it may hold URLs). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

/** A status the row can keep (100–599), else `null`. */
const statusOf = (status: number | null): number | null => (status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null);

/** `value` cut to `max` characters (`null` stays `null`; empty is `null`). */
const capped = (value: string | null | undefined, max: number): string | null => (value === null || value === undefined || value === '' ? null : value.slice(0, max));

export function createCrawler(deps: CrawlerDeps): Crawler {
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log?.(`crawl: ${line}`);
  const { repo } = deps;

  return {
    run(view, fresh) {
      const controller = new AbortController();
      const signal = controller.signal;
      let stopped: CrawlStopReason | null = null;
      const runId = view.id;
      const settings = view.settings;
      let frontier: CrawlFrontier | null = null;
      let runFetcher: CrawlerRunFetcher | null = null;
      let linksHeld = 0;
      let note: string | null = null;
      /** The project is still live (a run of no project always is); a deleted one stops the run (`project-deleted`). */
      const projectLive = async (): Promise<boolean> => {
        if (view.projectId === null || (await deps.projectLive(view.projectId))) return true;
        stopped ??= 'project-deleted';
        controller.abort();
        return false;
      };
      /** Asked inside each request's paced slot, right before it is sent (after the robots.txt and pacing waits). */
      const beforeRequest = async (): Promise<boolean> => !signal.aborted && (await projectLive());

      const memory = (): CrawlMemory => {
        const held = frontier?.memory() ?? { window: 0, pending: 0, paths: 0 };
        return { frontierWindow: held.window, pendingLinks: Math.max(held.pending, linksHeld), pacedHosts: runFetcher?.politeness?.size() ?? 0, queryPaths: held.paths };
      };

      /** The row a page's fetch (and its parse, for HTML) records. */
      const rowOf = (url: string, depth: number, fetched: CrawlPageFetch, outcome: CrawlPageOutcome, page: CrawlPageAnalysis | null): CrawlPageRow => ({
        runId,
        url,
        depth,
        outcome,
        status: statusOf(fetched.status),
        finalUrl: capped(fetched.refusedUrl ?? fetched.finalUrl, CRAWL_LIMITS.maxUrlChars),
        contentType: capped(fetched.headers['content-type'], 256),
        title: page?.title ?? null,
        canonical: capped(page?.canonical, CRAWL_LIMITS.maxUrlChars),
        indexable: page?.indexable ?? null,
        robotsCrawl: fetched.robots.crawl,
        robotsGooglebot: fetched.robots.googlebot,
        wordCount: page?.wordCount ?? null,
        linkTotal: page?.linkTotal ?? 0,
        // The served parse keeps `SNAPSHOT_LIMITS.maxLinks`: a page with more is marked, its total kept.
        linksCut: (page?.linkTotal ?? 0) > SNAPSHOT_LIMITS.maxLinks,
        score: page?.score ?? null,
        findings: page?.findings ?? [],
        outlinks: page?.links.length ?? 0,
        bytes: Math.min(fetched.bytes, CRAWL_LIMITS.maxBodyBytes),
        fetchedAt: fetched.startedAt ?? now(),
      });

      const done = (async (): Promise<CrawlRunEnd> => {
        const counts = { pages: 0, refused: 0, failed: 0, bytes: 0 };
        const finish = async (end: CrawlRunEnd): Promise<CrawlRunEnd> => {
          frontier?.reset();
          try {
            const queued = (await frontier?.queued()) ?? 0;
            const at = now();
            // A pause keeps the run's pacing for a resume after a restart; a finished run needs none.
            const pacing = end.state === 'paused' ? (runFetcher?.politeness?.snapshot() ?? null) : TERMINAL.has(end.state) ? null : undefined;
            await repo.updateRun(runId, { state: end.state, reason: end.reason, counts: { ...counts, queued }, finishedAt: TERMINAL.has(end.state) ? at : null, ...(pacing === undefined ? {} : { pacing }) }, at);
          } catch (error) {
            log(`a run's end could not be stored (${codeOf(error)})`);
          }
          return end;
        };
        const stoppedEnd = (): CrawlRunEnd => STOPPED[stopped ?? 'pause'];
        try {
          runFetcher = deps.fetcher.forRun(settings);
          const scope = runFetcher.scope;
          frontier = createFrontier({ repo, runId, scope });
          Object.assign(counts, await repo.pageCounts(runId));
          // A resume (perhaps after a restart, with a new crawl fetcher): no host is reached sooner, or less backed off, than when it paused.
          if (!fresh && runFetcher.politeness) runFetcher.politeness.restore(await repo.runPacing(runId));
          if (signal.aborted) return await finish(stoppedEnd());
          // A project deleted while this run was being started or resumed: nothing is discovered or fetched.
          if (!(await projectLive())) return await finish(stoppedEnd());
          await repo.updateRun(runId, { state: 'running', reason: null, finishedAt: null }, now());
          if (fresh) {
            await frontier.discover([scope.start], 0, 'start');
            if (settings.sitemaps && deps.sitemaps && !signal.aborted) {
              const seeding = frontier;
              const fetching = runFetcher;
              // Sitemap requests are crawl requests: the run's own fetch (scope, robots.txt, pacing, the redirect hook).
              const report = await deps.sitemaps.seed({
                runId,
                settings,
                scope,
                fetch: (url, options) => fetching.fetchPage(url, signal, { ...options, beforeRequest }),
                signal,
                seed: (urls) => seeding.discover(urls, 1, 'sitemap'),
              });
              note = report.note ?? note;
            }
          }
          for (;;) {
            if (signal.aborted) return await finish(stoppedEnd());
            if (counts.pages >= settings.maxPages) {
              const queued = await frontier.queued();
              return await finish({ state: 'done', reason: queued > 0 ? 'max-pages' : null });
            }
            const entry = await frontier.next();
            if (entry === null) return await finish({ state: 'done', reason: null });
            // Before each fetch call (and again inside its paced slot, `beforeRequest`): a project deleted here or by sync meanwhile cancels the run.
            if (!(await projectLive())) return await finish(stoppedEnd());
            if (signal.aborted) return await finish(stoppedEnd());
            const fetched = await untilAborted(runFetcher.fetchPage(entry.url, signal, { beforeRequest }), signal);
            if (fetched === ABORTED || fetched.outcome === 'aborted' || signal.aborted) return await finish(stoppedEnd());
            // A host past the pacing table's cap: nothing requested, nothing recorded; the URL stays queued.
            if (fetched.outcome === 'deferred') return await finish(SLOW_DOWN);

            let outcome: CrawlPageOutcome;
            let page: CrawlPageAnalysis | null = null;
            if (fetched.outcome === 'response') {
              const type = mediaType(fetched.headers['content-type']);
              if (type !== null && !HTML.has(type)) outcome = 'not-html';
              else {
                const body = fetched.body.byteLength > CRAWL_LIMITS.maxBodyBytes ? fetched.body.slice(0, CRAWL_LIMITS.maxBodyBytes) : fetched.body;
                const job: CrawlPageJob = {
                  // The URL the HTML came from (its links resolve against it).
                  url: fetched.finalUrl !== null && fetched.finalUrl.length <= CRAWL_LIMITS.maxUrlChars ? fetched.finalUrl : entry.url,
                  contentType: capped(fetched.headers['content-type'], 256),
                  body,
                  status: statusOf(fetched.status) ?? 200,
                  headers: Object.fromEntries(CRAWL_KEEP_HEADERS.flatMap((name) => (typeof fetched.headers[name] === 'string' ? [[name, fetched.headers[name]!]] : []))),
                  xRobotsTag: [...fetched.xRobotsTag],
                  chain: fetched.chain.map((hop) => ({ url: hop.url, status: hop.status, location: hop.location })),
                  extractedAt: fetched.startedAt ?? now(),
                  durationMs: fetched.durationMs,
                  robots: fetched.robots.fetch,
                };
                const analysed = await untilAborted(deps.analyse(job), signal);
                if (analysed === ABORTED || signal.aborted) return await finish(stoppedEnd());
                if (analysed.ok) {
                  outcome = 'crawled';
                  page = analysed.page;
                } else outcome = 'parse-failed';
              }
            } else outcome = fetched.outcome;

            // One row per page, written as the page ends.
            const row = rowOf(entry.url, entry.depth, fetched, outcome, page);
            if (await repo.putPage(row)) {
              counts.pages += 1;
              if (REFUSED.has(outcome)) counts.refused += 1;
              if (FAILED.has(outcome)) counts.failed += 1;
              counts.bytes += row.bytes;
            } else log('a page row was refused');
            if (page !== null && !signal.aborted) {
              linksHeld = page.links.length;
              const stored = page.links.slice(0, CRAWL_LIMITS.maxLinksStoredPerPage).flatMap((link) => {
                const toUrl = normaliseCrawlUrl(link.url);
                return toUrl === null ? [] : [{ toUrl, internal: scope.check(toUrl) === 'in', nofollow: link.nofollow }];
              });
              await repo.putLinks(runId, entry.url, stored);
              const status = row.status ?? 0;
              // The page's links are the most the crawler holds at once (K-B3 samples it here).
              deps.observe?.(memory());
              if (status >= 200 && status <= 299 && !signal.aborted) await frontier.discover(page.links.map((link) => link.url), entry.depth + 1, 'link');
              linksHeld = 0;
            }
            if (outcome === 'redirected' && fetched.redirectTarget !== null && !signal.aborted) await frontier.discover([fetched.redirectTarget], entry.depth + 1, 'link');
            await frontier.done(entry.url);
            const at = now();
            await repo.updateRun(runId, { counts: { ...counts, queued: await frontier.queued() } }, at);
            deps.observe?.(memory());
            // The site asked frost to slow down (`backoffAfter` 429 / 503 in a row): the run pauses.
            if (fetched.slowDown) return await finish(SLOW_DOWN);
          }
        } catch (error) {
          log(`a run failed (${codeOf(error)})`);
          return finish(stopped !== null ? stoppedEnd() : { state: 'failed', reason: 'error' });
        }
      })();

      return {
        runId,
        projectId: view.projectId,
        done,
        stop(why) {
          stopped ??= why;
          controller.abort();
        },
        note: () => note,
        pacing: () => runFetcher?.politeness?.snapshot() ?? null,
      };
    },
  };
}
