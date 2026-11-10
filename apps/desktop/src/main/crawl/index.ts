import type { ChangeIntelRepository, SiteCrawlRepository } from '@app/db';
import { crawlRobotsRulesOf } from '@app/seo-core';
import { LEGAL_GATES_E2E_SWITCH } from '@app/specs/data-sources.spec';
import { CRAWL_ANALYSIS_TIMEOUT_MS } from '@app/specs/site-crawl.spec';
import { createLegalGates } from '../data-sources/gates';
import { createAnalyzer, type AnalysisWorker, type Analyzer } from '../seo/analysis';
import type { Hop, Resolve } from '../seo/fetcher';
import { createCrawlChanges, watchedCrawlRepo, type CrawlChanges } from './changes';
import { createCrawler, type Crawler } from './crawler';
import { createCrawlFetcher, createCrawlLane, type CrawlRobotsSource } from './fetch';
import { createCrawlService, type CrawlService } from './service';
import { createSitemapSeeder } from './sitemaps';

// The site crawl's main-side composition (Phase 12 Task 6b; plan Decision 6; acceptance
// `site-crawl.feature.md`): a worker instance of the crawl's own (the `seo-analysis.cjs` bundle, as the
// checks have theirs, so a crawl never delays a sidebar audit), the crawl service (one crawl at a time,
// start and resume behind the L6 gate) over the session store's crawl tables, start-up recovery
// (`running` and `queued` runs become `paused`, nothing resumes), and a quit that pauses the running
// crawl. Fetching is bound once main's hop and resolver exist (`bindFetching`): the crawl lane
// (`createCrawlLane`) for pages and sitemaps (both through the crawl fetcher's policy), robots.txt through main's robots fetcher on the audit lane
// (never the crawl lane), parsed in the crawl worker. Main wires it with a few lines; Task 7 wires the
// service to IPC. No IPC and no UI here.

/** The crawl's own analyzer: a worker instance of its own with the crawl's deadline. */
export function createCrawlAnalyzer(spawn: () => AnalysisWorker): Analyzer {
  return createAnalyzer({ spawn, timeoutMs: CRAWL_ANALYSIS_TIMEOUT_MS });
}

export interface CrawlSetupDeps {
  readonly app: {
    readonly isPackaged: boolean;
    readonly commandLine: { getSwitchValue(name: string): string };
    on(event: 'before-quit', listener: () => void): unknown;
    once(event: 'will-quit', listener: () => void): unknown;
  };
  /** The session store's crawl tables and projects (`sessionStore.siteCrawl`, `.changeIntel`). */
  readonly store: { readonly siteCrawl: SiteCrawlRepository; readonly changeIntel: Pick<ChangeIntelRepository, 'project'> };
  /** Starts a worker on the `seo-analysis.cjs` bundle (a new instance, never the sidebar's). */
  readonly spawnWorker: () => AnalysisWorker;
  readonly log?: (line: string) => void;
}

/** What main binds once the browse session's hop and resolver exist. */
export interface CrawlFetching {
  readonly hop: Hop;
  readonly resolve: Resolve;
  /** Main's robots.txt fetcher (the audit lane's). */
  readonly robots: CrawlRobotsSource;
  /** The browse session's user agent. */
  readonly userAgent: () => string;
}

export interface CrawlMain {
  /** For Task 7's IPC (start, pause, resume, cancel, delete, status) and the project cleanup. */
  readonly service: CrawlService;
  /** The crawl tables (Task 7's Pages and Site structure reads), every watched write counted in `changes`. */
  readonly repo: SiteCrawlRepository;
  /** The change counter `crawl.watch` long-polls (Task 7). */
  readonly changes: CrawlChanges;
  /** Binds the crawl lane and the robots fetcher (main, after app ready); until then start and resume answer `unavailable`. */
  bindFetching(fetching: CrawlFetching): void;
}

export function setupCrawl(deps: CrawlSetupDeps): CrawlMain {
  const { app, store } = deps;
  const log = deps.log ?? (() => undefined);
  const gates = createLegalGates({ switchValue: app.commandLine.getSwitchValue(LEGAL_GATES_E2E_SWITCH), packaged: app.isPackaged });
  const analyzer = createCrawlAnalyzer(deps.spawnWorker);
  app.once('will-quit', () => analyzer.dispose());
  const projectLive = async (projectId: string): Promise<boolean> => (await store.changeIntel.project(projectId)) !== null;
  // Task 7: every write the crawl sheet shows, and every start and end of a crawl, counts a change for `crawl.watch`.
  const changes = createCrawlChanges();
  const repo = watchedCrawlRepo(store.siteCrawl, changes.bump);
  let crawler: Crawler | null = null;
  const service = createCrawlService({ repo, crawler: () => crawler, isOpen: (id) => gates.isOpen(id), projectLive, log, onChange: changes.bump });
  // Start-up: a run left running by a crash (or queued) is paused, never resumed by itself.
  void service.startup();
  // Quitting pauses the running crawl (`quit`), before the store closes at will-quit.
  app.on('before-quit', () => service.quit());
  return {
    service,
    repo,
    changes,
    bindFetching({ hop, resolve, robots, userAgent }) {
      const lane = createCrawlLane({ hop, resolve });
      // robots.txt is parsed in the crawl worker; main only matches URLs against what it answers.
      const parseRobotsData = async (text: string) => {
        const parsed = await analyzer.crawlRobots(text);
        if (!parsed.ok) throw new Error('robots.txt could not be parsed');
        return parsed.robots;
      };
      const fetcher = createCrawlFetcher({ fetcher: lane, robots, userAgent, parseRobots: async (text) => crawlRobotsRulesOf(await parseRobotsData(text)) });
      // Sitemap files go through each run's own page fetch (scope, robots.txt, pacing, the redirect hook), read once in the crawl worker.
      const sitemaps = createSitemapSeeder({ robots, parseRobots: parseRobotsData, analyse: (input) => analyzer.crawlSitemap(input), log });
      crawler = createCrawler({ repo, fetcher, analyse: (job) => analyzer.analyseCrawlPage(job), sitemaps, projectLive, log });
    },
  };
}
