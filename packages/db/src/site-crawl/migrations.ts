import { CRAWL_FRONTIER_STATES, CRAWL_LIMITS, CRAWL_PAGE_OUTCOMES, CRAWL_ROBOTS_VERDICTS, CRAWL_RUN_REASONS, CRAWL_RUN_STATES } from '@app/specs/site-crawl.spec';
import type { Migration } from '../migrations';

// The site crawler's storage (Phase 12 Task 5; spec `specs/site-crawl.spec.ts`; acceptance
// `specs/site-crawl.feature.md`, Storage). Ids `0240`–`0249` are Phase 12's; this list is spread in
// `MIGRATIONS` right after Phase 11's `...PHASE11_MIGRATIONS` (plan Global constraints), in id order.
// Plain SQLite SQL, no foreign keys (as Phase 6's and 10's). `schema.ts` declares exactly these tables.
//
// The `CHECK`s are in `0240` itself: SQLite cannot add one to an existing table, and both migrations
// are new together. Each list is the spec's array at the time of writing (`site-crawl.test.ts` checks
// they accept exactly it); a later change to an array needs a table rebuild in a new migration.
// `0241` holds the guards: a run's delete takes its pages, links and frontier with it, and no page,
// link or frontier row can be written for a run that does not exist (a cancelled crawl writing late
// writes nothing).

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const url = (column: string, nullable = false) =>
  `${column} TEXT${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${column} IS NULL OR ` : ''}length(${column}) BETWEEN 1 AND ${CRAWL_LIMITS.maxUrlChars})`;
const flag = (column: string, nullable = false) => `${column} INTEGER${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${column} IS NULL OR ` : ''}${column} IN (0, 1))`;
const counter = (column: string) => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`;
const depth = `depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND ${CRAWL_LIMITS.maxDepth})`;
const runId = 'run_id TEXT NOT NULL CHECK (length(run_id) = 36)';

/** Longest settings JSON stored: a start URL and 2 × `maxPrefixes` prefixes, with room to spare. */
export const MAX_CRAWL_SETTINGS_JSON_CHARS = 32_768;
/** Longest findings JSON stored: every crawl rule once, with room to spare. */
export const MAX_CRAWL_FINDINGS_JSON_CHARS = 16_384;

export const SITE_CRAWL_MIGRATIONS: readonly Migration[] = [
  {
    id: '0240_site_crawl',
    sql: `
      CREATE TABLE crawl_runs (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        project_id TEXT CHECK (project_id IS NULL OR length(project_id) = 36),
        ${url('start_url')},
        settings TEXT NOT NULL CHECK (length(settings) <= ${MAX_CRAWL_SETTINGS_JSON_CHARS}),
        state TEXT NOT NULL CHECK (state IN (${list(CRAWL_RUN_STATES)})),
        reason TEXT CHECK (reason IS NULL OR reason IN (${list(CRAWL_RUN_REASONS)})),
        ${counter('pages')},
        ${counter('queued')},
        ${counter('refused')},
        ${counter('failed')},
        ${counter('bytes')},
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX crawl_runs_project_id ON crawl_runs (project_id);
      CREATE TABLE crawl_pages (
        id INTEGER PRIMARY KEY,
        ${runId},
        ${url('url')},
        ${depth},
        outcome TEXT NOT NULL CHECK (outcome IN (${list(CRAWL_PAGE_OUTCOMES)})),
        status INTEGER CHECK (status IS NULL OR status BETWEEN 100 AND 599),
        ${url('final_url', true)},
        content_type TEXT CHECK (content_type IS NULL OR length(content_type) <= 256),
        title TEXT,
        canonical TEXT CHECK (canonical IS NULL OR length(canonical) <= ${CRAWL_LIMITS.maxUrlChars}),
        ${flag('indexable', true)},
        robots_crawl TEXT NOT NULL CHECK (robots_crawl IN (${list(CRAWL_ROBOTS_VERDICTS)})),
        robots_googlebot TEXT NOT NULL CHECK (robots_googlebot IN (${list(CRAWL_ROBOTS_VERDICTS)})),
        word_count INTEGER CHECK (word_count IS NULL OR word_count >= 0),
        ${counter('link_total')},
        ${flag('links_cut')},
        score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
        findings TEXT NOT NULL CHECK (length(findings) <= ${MAX_CRAWL_FINDINGS_JSON_CHARS}),
        ${counter('outlinks')},
        ${counter('bytes')},
        fetched_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX crawl_pages_run_url ON crawl_pages (run_id, url);
      CREATE TABLE crawl_links (
        id INTEGER PRIMARY KEY,
        ${runId},
        from_page INTEGER NOT NULL,
        ${url('to_url')},
        ${flag('internal')},
        ${flag('nofollow')}
      );
      CREATE INDEX crawl_links_run_from ON crawl_links (run_id, from_page);
      CREATE INDEX crawl_links_run_to ON crawl_links (run_id, to_url);
      CREATE TABLE crawl_frontier (
        id INTEGER PRIMARY KEY,
        ${runId},
        ${url('url')},
        ${depth},
        state TEXT NOT NULL CHECK (state IN (${list(CRAWL_FRONTIER_STATES)})),
        ${counter('inlinks')},
        from_sitemap INTEGER NOT NULL DEFAULT 0 CHECK (from_sitemap IN (0, 1))
      );
      CREATE UNIQUE INDEX crawl_frontier_run_url ON crawl_frontier (run_id, url);
      CREATE INDEX crawl_frontier_run_state ON crawl_frontier (run_id, state, id);
    `,
  },
  {
    id: '0241_site_crawl_guards',
    sql: `
      CREATE TRIGGER crawl_runs_delete_rows AFTER DELETE ON crawl_runs
      BEGIN
        DELETE FROM crawl_pages WHERE run_id = OLD.id;
        DELETE FROM crawl_links WHERE run_id = OLD.id;
        DELETE FROM crawl_frontier WHERE run_id = OLD.id;
      END;
      ${['crawl_pages', 'crawl_links', 'crawl_frontier']
        .map(
          (table) => `
      CREATE TRIGGER ${table}_run_exists BEFORE INSERT ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM crawl_runs WHERE id = NEW.run_id)
      BEGIN
        SELECT RAISE(ABORT, '${table}: no such crawl run');
      END;`,
        )
        .join('')}
    `,
  },
];

/** Longest pacing JSON stored (`crawl_runs.pacing`): `maxPacedHosts` entries of a 253-character host, with room to spare. */
export const MAX_CRAWL_PACING_JSON_CHARS = 98_304;

/**
 * `0246_crawl_run_pacing` (Phase 12 whole-branch review; spec `CRAWL_PACING_LIMITS`,
 * `CRAWL_PACING_MIGRATION_IDS`; acceptance `crawl-pacing-survives-a-restart`): a paused run's per-host
 * pacing (`CrawlPacingSnapshotSchema` as JSON; `NULL`: none), so a resume after a restart honours what
 * the site asked for. Its own migration rather than an edit of `0240`, so a database that already took
 * `0240` gets it too; spread in `MIGRATIONS` in id order, after the SERP-API readings' `0245`.
 */
export const SITE_CRAWL_PACING_MIGRATIONS: readonly Migration[] = [
  {
    id: '0246_crawl_run_pacing',
    sql: `ALTER TABLE crawl_runs ADD COLUMN pacing TEXT CHECK (pacing IS NULL OR length(pacing) <= ${MAX_CRAWL_PACING_JSON_CHARS});`,
  },
];
