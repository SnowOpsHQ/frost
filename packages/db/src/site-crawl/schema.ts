import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// The site crawler's tables (Phase 12 Task 5; spec `specs/site-crawl.spec.ts`, `SITE_CRAWL_TABLES`;
// acceptance `specs/site-crawl.feature.md`, Storage). Migration `0240_site_crawl` creates exactly these,
// column for column, with their `CHECK`s; `0241_site_crawl_guards` adds the triggers (a deleted run
// takes its pages, links and frontier with it; no row is written for a run that does not exist).
// Run ids are UUIDv7 text, page, link and frontier ids SQLite rowids; times Unix milliseconds; JSON
// text SQL never parses. Device-local: never synced, not part of Clear Browsing Data or retention.

/** A crawl run: its settings (`CrawlSettingsSchema` as JSON), state and counts. */
export const crawlRuns = sqliteTable(
  'crawl_runs',
  {
    id: text('id').primaryKey(),
    /** The project it belongs to (deleted with it), or `null`. */
    projectId: text('project_id'),
    /** The settings' start URL, kept apart for queries. */
    startUrl: text('start_url').notNull(),
    settings: text('settings').notNull(),
    /** One of `CRAWL_RUN_STATES`. */
    state: text('state').notNull(),
    /** One of `CRAWL_RUN_REASONS`, or `null`. */
    reason: text('reason'),
    pages: integer('pages').notNull(),
    queued: integer('queued').notNull(),
    refused: integer('refused').notNull(),
    failed: integer('failed').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
    /** A paused run's per-host pacing (`CrawlPacingSnapshotSchema` as JSON; `0246`), or `null`. Main only. */
    pacing: text('pacing'),
  },
  (table) => [index('crawl_runs_project_id').on(table.projectId)],
);

/** One page of a run (`CrawlPageRowSchema`): one row per `(runId, url)`, written as each page ends. */
export const crawlPages = sqliteTable(
  'crawl_pages',
  {
    id: integer('id').primaryKey(),
    runId: text('run_id').notNull(),
    url: text('url').notNull(),
    depth: integer('depth').notNull(),
    /** One of `CRAWL_PAGE_OUTCOMES`. */
    outcome: text('outcome').notNull(),
    status: integer('status'),
    finalUrl: text('final_url'),
    contentType: text('content_type'),
    title: text('title'),
    canonical: text('canonical'),
    indexable: integer('indexable', { mode: 'boolean' }),
    /** `CRAWL_ROBOTS_VERDICTS`: for `CRAWL_ROBOTS_TOKEN`, and for Googlebot. */
    robotsCrawl: text('robots_crawl').notNull(),
    robotsGooglebot: text('robots_googlebot').notNull(),
    wordCount: integer('word_count'),
    linkTotal: integer('link_total').notNull(),
    linksCut: integer('links_cut', { mode: 'boolean' }).notNull(),
    score: integer('score'),
    /** `CrawlFindingSchema[]` as JSON. */
    findings: text('findings').notNull(),
    outlinks: integer('outlinks').notNull(),
    bytes: integer('bytes').notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (table) => [uniqueIndex('crawl_pages_run_url').on(table.runId, table.url)],
);

/** Links found on a page (`fromPage`: a `crawl_pages` id), at most `CRAWL_LIMITS.maxLinksStoredPerPage` per page. */
export const crawlLinks = sqliteTable(
  'crawl_links',
  {
    id: integer('id').primaryKey(),
    runId: text('run_id').notNull(),
    fromPage: integer('from_page').notNull(),
    toUrl: text('to_url').notNull(),
    internal: integer('internal', { mode: 'boolean' }).notNull(),
    nofollow: integer('nofollow', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('crawl_links_run_from').on(table.runId, table.fromPage), index('crawl_links_run_to').on(table.runId, table.toUrl)],
);

/**
 * A run's frontier and seen-set: one row per `(runId, url)`, `queued` until fetched or refused, then
 * `done`. The authority for inlinks (links from crawled pages, one per discovering page) and orphans
 * (`fromSitemap` and no inlink); pages join it on `(runId, url)`.
 */
export const crawlFrontier = sqliteTable(
  'crawl_frontier',
  {
    id: integer('id').primaryKey(),
    runId: text('run_id').notNull(),
    url: text('url').notNull(),
    depth: integer('depth').notNull(),
    /** One of `CRAWL_FRONTIER_STATES`. */
    state: text('state').notNull(),
    inlinks: integer('inlinks').notNull(),
    fromSitemap: integer('from_sitemap', { mode: 'boolean' }).notNull(),
  },
  (table) => [uniqueIndex('crawl_frontier_run_url').on(table.runId, table.url), index('crawl_frontier_run_state').on(table.runId, table.state, table.id)],
);
