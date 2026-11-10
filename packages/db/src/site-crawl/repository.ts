import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, type InferSelectModel, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import {
  CRAWL_FAILED_OUTCOMES,
  CRAWL_LIMITS,
  CRAWL_PAGES_LIMITS,
  CRAWL_REFUSED_OUTCOMES,
  CRAWL_RULE_IDS,
  CRAWL_TREE_LIMITS,
  type CrawlDiscoverySource,
  type CrawlFrontierState,
  type CrawlPageSort,
  type CrawlRunReason,
  type CrawlRunState,
  type CrawlSortDirection,
} from '@app/specs/site-crawl.spec';
import {
  CrawlFindingSchema,
  CrawlPacedHostSchema,
  CrawlPageListRowSchema,
  CrawlPageRowSchema,
  CrawlRunViewSchema,
  CrawlSettingsSchema,
  CrawlUrlSchema,
  type CrawlPacedHost,
  type CrawlPageFilter,
  type CrawlPageListRow,
  type CrawlPageRow,
  type CrawlRunCounts,
  type CrawlRunView,
  type CrawlSettings,
  type CrawlTreeNode,
} from '@app/specs/site-crawl.schema';
import type { SessionDatabase } from '../client';
import { uuidv7 } from '../change-intel/ids';
import { crawlFrontier, crawlLinks, crawlPages, crawlRuns } from './schema';

// The site crawler's storage (Phase 12 Task 5; spec `specs/site-crawl.spec.ts`; acceptance
// `specs/site-crawl.feature.md`, Storage): runs, their pages, links and frontier. Main only. Every
// value is checked strictly on the way in (`CrawlSettingsSchema`, `CrawlPageRowSchema`) and leniently
// on the way out: a finding whose id is no longer a crawl rule is dropped (the row stays), a run whose
// settings no longer parse is listed with `settings: null` (still deletable), and any other malformed
// row reads as nothing. Deleting a run deletes its links, then its pages and frontier, in bounded
// chunks with a yield between them, then the run (the `0241` trigger is the backstop). No row is
// written for a run that does not exist (`*_run_exists`): only that write answers `false` / `0`;
// every other error is thrown.

/** A link found on a page, as stored (`crawl_links`). */
export interface CrawlLink {
  readonly toUrl: string;
  readonly internal: boolean;
  readonly nofollow: boolean;
}

/** A frontier entry: a URL to fetch and its depth (clicks from the start URL). */
export interface CrawlFrontierEntry {
  readonly url: string;
  readonly depth: number;
}

/** A URL met by the run (`enqueue`): from the start URL, a link on a crawled page, or a sitemap. */
export interface CrawlDiscovery extends CrawlFrontierEntry {
  readonly source: CrawlDiscoverySource;
}

/** A frontier entry as stored: the authority for inlinks and orphans. */
export interface StoredCrawlFrontierEntry extends CrawlFrontierEntry {
  readonly state: CrawlFrontierState;
  /** Links to it from crawled pages (one per discovering page; a sitemap seed is not one). */
  readonly inlinks: number;
  /** A sitemap listed it. */
  readonly fromSitemap: boolean;
}

export interface CreateCrawlRunInput {
  /** The project it belongs to, or `null`. */
  readonly projectId: string | null;
  readonly settings: CrawlSettings;
  readonly now: number;
}

export interface CrawlRunPatch {
  readonly state?: CrawlRunState;
  readonly reason?: CrawlRunReason | null;
  readonly counts?: Partial<CrawlRunCounts>;
  readonly finishedAt?: number | null;
  /**
   * A paused run's per-host pacing (`CrawlPacingSnapshotSchema`; whole-branch review): stored for a
   * resume after a restart; `null` clears it; absent leaves it. Entries the schema refuses are dropped
   * and at most `CRAWL_LIMITS.maxPacedHosts` kept, so storing it never fails a run's end.
   */
  readonly pacing?: readonly CrawlPacedHost[] | null;
}

/** One page of a run's pages as the Pages view asks for it (Task 7): filtered and sorted in SQL. */
export interface CrawlPagesQuery {
  readonly filter: CrawlPageFilter;
  readonly sort: CrawlPageSort;
  readonly direction: CrawlSortDirection;
  readonly offset: number;
  /** At most `CRAWL_PAGES_LIMITS.maxPageSize` (a larger one reads that many). */
  readonly limit: number;
}

/** One level of a run's path tree (Task 7): its nodes, most pages first, and how many more it holds. */
export interface CrawlTreeLevel {
  readonly nodes: CrawlTreeNode[];
  readonly more: number;
}

export interface SiteCrawlRepository {
  /** Creates a `queued` run (a fresh UUIDv7 id). Throws on settings `CrawlSettingsSchema` refuses (nothing written). */
  createRun(input: CreateCrawlRunInput): Promise<CrawlRunView>;
  /** Changes a run's state, reason, counts and finish time; `false` when there is no such run. */
  updateRun(id: string, patch: CrawlRunPatch, now: number): Promise<boolean>;
  getRun(id: string): Promise<CrawlRunView | null>;
  /** A run's stored pacing (its valid entries; `[]` for none, a malformed value or no such run). Main only. */
  runPacing(id: string): Promise<CrawlPacedHost[]>;
  /** Runs, newest first: all, or one project's (`projectId`); at most `limit` (default `CRAWL_LIMITS.maxListedRuns`). */
  listRuns(filter?: { readonly projectId?: string; readonly limit?: number }): Promise<CrawlRunView[]>;
  /** Deletes a run's links, pages and frontier (in chunks, yielding between them), then the run; `false` when there was none. */
  deleteRun(id: string): Promise<boolean>;
  /** Deletes every run of the project, each as `deleteRun`; answers how many. The caller cancels and awaits the project's active crawl first. */
  deleteRunsOfProject(projectId: string): Promise<number>;
  /** Of `projectIds`, those with at least one crawl run (`deletedProjectsWithRows`' crawl arm). */
  projectsWithRuns(projectIds: readonly string[]): Promise<string[]>;
  /** Writes a page row, replacing the run's row for its URL; `false` (nothing written) for an invalid row or a run that does not exist. */
  putPage(row: CrawlPageRow): Promise<boolean>;
  getPage(runId: string, url: string): Promise<CrawlPageRow | null>;
  /** A run's pages in the order they were first written. */
  pagesOf(runId: string, page: { readonly limit: number; readonly offset: number }): Promise<CrawlPageRow[]>;
  /**
   * Replaces the links stored for the page at `fromUrl` with the first `CRAWL_LIMITS.maxLinksStoredPerPage`
   * valid ones of `links`; answers how many were stored (`0` when the run has no page at `fromUrl`).
   */
  putLinks(runId: string, fromUrl: string, links: readonly CrawlLink[]): Promise<number>;
  linksOf(runId: string, fromUrl: string): Promise<CrawlLink[]>;
  /**
   * Records what one source met (one call per discovering page, or for the start URL, or per sitemap):
   * a new URL is queued; a URL seen before is never queued again (the frontier is the seen-set), but
   * a `link` adds one inlink, a `sitemap` sets `fromSitemap`, and while it is still `queued` it keeps
   * the lower depth. Each URL counts once per call. Answers how many URLs were new; `0` (nothing
   * written) for a run that does not exist.
   */
  enqueue(runId: string, entries: readonly CrawlDiscovery[]): Promise<number>;
  /** One URL's frontier entry (its inlinks and sitemap flag), or `null`. */
  frontierEntry(runId: string, url: string): Promise<StoredCrawlFrontierEntry | null>;
  /** Of `urls`, those the run's frontier already holds (queued or done): the seen-set (Task 6b). */
  knownUrls(runId: string, urls: readonly string[]): Promise<Set<string>>;
  /**
   * How many query variants of the path `base` (a URL without a query or fragment) the run's frontier
   * holds: entries `base?…`, never a longer path's (Task 6b: the per-path cap is counted here, in SQLite).
   */
  queryVariantCount(runId: string, base: string): Promise<number>;
  /** The run's page rows counted: all of them, those refused (`CRAWL_REFUSED_OUTCOMES`) and failed (`CRAWL_FAILED_OUTCOMES`), and their bytes (Task 6b: a resumed run's counts). */
  pageCounts(runId: string): Promise<Pick<CrawlRunCounts, 'pages' | 'refused' | 'failed' | 'bytes'>>;
  /**
   * Task 7: the run's pages `query.filter` selects (`total`) and, sorted by `query.sort`, the rows from
   * `query.offset` (at most `query.limit`, capped at `CRAWL_PAGES_LIMITS.maxPageSize`), each with its
   * in-links from the frontier. A malformed stored row is skipped (the total still counts it).
   */
  pagesPage(runId: string, query: CrawlPagesQuery): Promise<{ total: number; rows: CrawlPageListRow[] }>;
  /**
   * Task 7: one level of the run's path tree, read in SQL: under `prefix` (an `http(s)` URL text ending
   * in `/`), the path segments of the run's page URLs; with `prefix` `null`, their origins. At most
   * `limit` nodes, most pages first, then by label; the rest are counted (`more`).
   */
  treeLevel(runId: string, prefix: string | null, limit: number): Promise<CrawlTreeLevel>;
  /**
   * Task 7 (CSV export): the ids of the run's pages the filter selects, in the sort, at most `limit`
   * (one statement: the export's fixed set and order, so rows written or changed meanwhile never move it).
   */
  pageOrder(runId: string, query: Omit<CrawlPagesQuery, 'offset' | 'limit'>, limit: number): Promise<number[]>;
  /** Task 7 (CSV export): the run's pages with these ids (at most `CRAWL_PAGES_LIMITS.maxPageSize`), in the order of `ids`; ids gone or malformed are skipped. */
  pagesByIds(runId: string, ids: readonly number[]): Promise<CrawlPageListRow[]>;
  /** Task 7: the run's pages per click depth, shallowest first (depths with no page left out). */
  depthHistogram(runId: string): Promise<{ depth: number; pages: number }[]>;
  /** The run's orphans (a sitemap listed them, no crawled page links to them), in discovery order. */
  orphansOf(runId: string, page: { readonly limit: number; readonly offset: number }): Promise<string[]>;
  orphanCount(runId: string): Promise<number>;
  /** The run's oldest `limit` queued entries (breadth first: entries are queued in discovery order). */
  nextQueued(runId: string, limit: number): Promise<CrawlFrontierEntry[]>;
  /** Marks entries done (fetched, refused or skipped); they stay seen. */
  markDone(runId: string, urls: readonly string[]): Promise<void>;
  queuedCount(runId: string): Promise<number>;
  /** Start-up: every `running` or `queued` run (left by a crash, a kill or a quit) becomes `paused` (`interrupted`); answers how many. */
  pauseInterrupted(now: number): Promise<number>;
}

/** Rows per multi-row insert (well under SQLite's bound-parameter limit). */
const CHUNK = 250;

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const runBatch = (db: SessionDatabase, items: BatchItem<'sqlite'>[]) => db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

/** Lets other work on main's thread run between two delete chunks. */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Whether `error` (or its cause, Drizzle wrapping it) is a `*_run_exists` refusal: the run does not exist. */
function isNoSuchRun(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (e.message.includes('no such crawl run')) return true;
  }
  return false;
}

const CRAWL_RULES: ReadonlySet<string> = new Set(CRAWL_RULE_IDS);
const REFUSED: ReadonlySet<string> = new Set(CRAWL_REFUSED_OUTCOMES);
const FAILED: ReadonlySet<string> = new Set(CRAWL_FAILED_OUTCOMES);

const validUrl = (url: unknown): url is string => CrawlUrlSchema.safeParse(url).success;
const validDepth = (depth: unknown): depth is number => Number.isInteger(depth) && (depth as number) >= 0 && (depth as number) <= CRAWL_LIMITS.maxDepth;

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function runView(row: InferSelectModel<typeof crawlRuns>): CrawlRunView | null {
  // Settings that no longer parse (or name another start URL) read as `null`: the run stays listed and deletable.
  const settings = CrawlSettingsSchema.safeParse(parseJson(row.settings));
  const parsed = CrawlRunViewSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    startUrl: row.startUrl,
    settings: settings.success && settings.data.startUrl === row.startUrl ? settings.data : null,
    state: row.state,
    reason: row.reason,
    counts: { pages: row.pages, queued: row.queued, refused: row.refused, failed: row.failed, bytes: row.bytes },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  });
  return parsed.success ? parsed.data : null;
}

/** The entries of `value` `CrawlPacedHostSchema` accepts, at most `CRAWL_LIMITS.maxPacedHosts`. */
function pacedHosts(value: unknown): CrawlPacedHost[] {
  if (!Array.isArray(value)) return [];
  const kept: CrawlPacedHost[] = [];
  for (const entry of value) {
    if (kept.length >= CRAWL_LIMITS.maxPacedHosts) break;
    const parsed = CrawlPacedHostSchema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

function pageRow(row: InferSelectModel<typeof crawlPages>): CrawlPageRow | null {
  const { id: _id, findings, ...rest } = row;
  // A finding whose id is no longer a crawl rule (or is malformed) is dropped; the row stays.
  const stored = parseJson(findings);
  const kept = (Array.isArray(stored) ? stored : []).filter((finding) => CrawlFindingSchema.safeParse(finding).success && CRAWL_RULES.has((finding as { id: string }).id));
  const parsed = CrawlPageRowSchema.safeParse({ ...rest, findings: kept.slice(0, CRAWL_RULE_IDS.length) });
  return parsed.success ? parsed.data : null;
}

const present = <T>(value: T | null): value is T => value !== null;

const STATUS_RANGES = { '2xx': [200, 299], '3xx': [300, 399], '4xx': [400, 499], '5xx': [500, 599] } as const;

/** The Pages view's filter as SQL conditions on `crawl_pages` (every value is bound, never spliced). */
function pageConditions(runId: string, filter: CrawlPageFilter): SQL[] {
  const where: SQL[] = [eq(crawlPages.runId, runId)];
  if (filter.status === 'none') where.push(isNull(crawlPages.status));
  else if (filter.status !== undefined) {
    const [low, high] = STATUS_RANGES[filter.status];
    where.push(sql`${crawlPages.status} BETWEEN ${low} AND ${high}`);
  }
  if (filter.indexable === 'yes') where.push(eq(crawlPages.indexable, true));
  else if (filter.indexable === 'no') where.push(eq(crawlPages.indexable, false));
  else if (filter.indexable === 'unknown') where.push(isNull(crawlPages.indexable));
  if (filter.finding !== undefined) where.push(sql`EXISTS (SELECT 1 FROM json_each(${crawlPages.findings}) WHERE json_extract(value, '$.id') = ${filter.finding})`);
  if (filter.depth !== undefined) where.push(eq(crawlPages.depth, filter.depth));
  if (filter.linksCut === true) where.push(eq(crawlPages.linksCut, true));
  return where;
}

/** In-links of a page: its frontier entry's (the authority), `0` without one. */
const inlinksOf = sql<number>`coalesce(${crawlFrontier.inlinks}, 0)`;

/** The sort key of each `CRAWL_PAGE_SORTS` entry; `nullable` keys sort their `NULL`s last either way. */
const SORT_KEYS: Readonly<Record<CrawlPageSort, { readonly key: SQL | typeof crawlPages.id; readonly nullable: boolean }>> = {
  order: { key: crawlPages.id, nullable: false },
  url: { key: sql`${crawlPages.url}`, nullable: false },
  status: { key: sql`${crawlPages.status}`, nullable: true },
  depth: { key: sql`${crawlPages.depth}`, nullable: false },
  inlinks: { key: inlinksOf, nullable: false },
  score: { key: sql`${crawlPages.score}`, nullable: true },
  words: { key: sql`${crawlPages.wordCount}`, nullable: true },
};

/** A page's frontier entry, joined on `(run_id, url)`. */
const joinFrontier = and(eq(crawlFrontier.runId, crawlPages.runId), eq(crawlFrontier.url, crawlPages.url));

/** The Pages view's order: a nullable key's `NULL`s last, the key, then the crawl's order (the row id). */
function orderOf(sort: CrawlPageSort, direction: CrawlSortDirection): SQL[] {
  const { key, nullable } = SORT_KEYS[sort] ?? SORT_KEYS.order;
  const keyed = sql`${key}`;
  return [...(nullable ? [sql`${key} IS NULL`] : []), direction === 'desc' ? desc(keyed) : asc(keyed), asc(crawlPages.id)];
}

/** A joined page row as the Pages view lists it (no run id, its in-links), or `null` when it no longer parses. */
function listRow({ page, inlinks }: { readonly page: InferSelectModel<typeof crawlPages>; readonly inlinks: unknown }): CrawlPageListRow | null {
  const row = pageRow(page);
  if (row === null) return null;
  const { runId: _runId, ...rest } = row;
  const parsed = CrawlPageListRowSchema.safeParse({ ...rest, inlinks: Number(inlinks) });
  return parsed.success ? parsed.data : null;
}

/** Rows of a raw `db.all` (the driver may answer each row as an array of columns, in select order, or as an object). */
function rowsOf<T extends Record<string, unknown>>(result: unknown, names: readonly (keyof T & string)[]): T[] {
  if (!Array.isArray(result)) return [];
  return result.map((row) => (Array.isArray(row) ? (Object.fromEntries(names.map((name, i) => [name, row[i]])) as T) : (row as T)));
}

/** A URL text prefix ending in `/` as a half-open range on the `(run_id, url)` index: `/` + 1 is `0`. */
const prefixEnd = (prefix: string): string => `${prefix.slice(0, -1)}0`;

/** Where the first `/`, `?` or `#` of `rest` is (1-based), or past its end: one tree segment's end. */
const SEGMENT_END = (rest: SQL) =>
  sql`min(iif(instr(${rest}, '/') > 0, instr(${rest}, '/'), length(${rest}) + 1), iif(instr(${rest}, '?') > 0, instr(${rest}, '?'), length(${rest}) + 1), iif(instr(${rest}, '#') > 0, instr(${rest}, '#'), length(${rest}) + 1))`;

export function createSiteCrawlRepository(db: SessionDatabase): SiteCrawlRepository {
  const pageId = async (runId: string, url: string): Promise<number | null> => {
    const [row] = await db
      .select({ id: crawlPages.id })
      .from(crawlPages)
      .where(and(eq(crawlPages.runId, runId), eq(crawlPages.url, url)))
      .limit(1);
    return row?.id ?? null;
  };

  /** Deletes up to `deleteChunkRows` of the run's rows of `table` per statement until none is left, yielding between statements. */
  const deleteInChunks = async (table: typeof crawlLinks | typeof crawlPages | typeof crawlFrontier, runId: string) => {
    for (;;) {
      const chunk = db.select({ id: table.id }).from(table).where(eq(table.runId, runId)).limit(CRAWL_LIMITS.deleteChunkRows);
      const gone = await db.delete(table).where(inArray(table.id, chunk)).returning({ id: table.id });
      if (gone.length < CRAWL_LIMITS.deleteChunkRows) return;
      await yieldToLoop();
    }
  };

  const deleteRun = async (id: string): Promise<boolean> => {
    const [run] = await db.select({ id: crawlRuns.id }).from(crawlRuns).where(eq(crawlRuns.id, id)).limit(1);
    if (!run) return false;
    // Links first (the most rows), then pages and the frontier, then the run (its trigger takes anything left).
    for (const table of [crawlLinks, crawlPages, crawlFrontier]) {
      await deleteInChunks(table, id);
      await yieldToLoop();
    }
    const deleted = await db.delete(crawlRuns).where(eq(crawlRuns.id, id)).returning({ id: crawlRuns.id });
    return deleted.length > 0;
  };

  const orphan = (runId: string) => and(eq(crawlFrontier.runId, runId), eq(crawlFrontier.fromSitemap, true), eq(crawlFrontier.inlinks, 0));

  return {
    async createRun({ projectId, settings, now }) {
      const valid = CrawlSettingsSchema.parse(settings);
      const id = uuidv7(now);
      await db.insert(crawlRuns).values({
        id,
        projectId,
        startUrl: valid.startUrl,
        settings: JSON.stringify(valid),
        state: 'queued',
        reason: null,
        pages: 0,
        queued: 0,
        refused: 0,
        failed: 0,
        bytes: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });
      return { id, projectId, startUrl: valid.startUrl, settings: valid, state: 'queued', reason: null, counts: { pages: 0, queued: 0, refused: 0, failed: 0, bytes: 0 }, createdAt: now, updatedAt: now, finishedAt: null };
    },

    async updateRun(id, { state, reason, counts, finishedAt, pacing }, now) {
      const updated = await db
        .update(crawlRuns)
        .set({
          ...(state === undefined ? {} : { state }),
          ...(reason === undefined ? {} : { reason }),
          ...(counts?.pages === undefined ? {} : { pages: counts.pages }),
          ...(counts?.queued === undefined ? {} : { queued: counts.queued }),
          ...(counts?.refused === undefined ? {} : { refused: counts.refused }),
          ...(counts?.failed === undefined ? {} : { failed: counts.failed }),
          ...(counts?.bytes === undefined ? {} : { bytes: counts.bytes }),
          ...(finishedAt === undefined ? {} : { finishedAt }),
          ...(pacing === undefined ? {} : { pacing: pacing === null ? null : JSON.stringify(pacedHosts(pacing)) }),
          updatedAt: now,
        })
        .where(eq(crawlRuns.id, id))
        .returning({ id: crawlRuns.id });
      return updated.length > 0;
    },

    async getRun(id) {
      const [row] = await db.select().from(crawlRuns).where(eq(crawlRuns.id, id)).limit(1);
      return row ? runView(row) : null;
    },

    async runPacing(id) {
      const [row] = await db.select({ pacing: crawlRuns.pacing }).from(crawlRuns).where(eq(crawlRuns.id, id)).limit(1);
      return pacedHosts(parseJson(row?.pacing));
    },

    async listRuns(filter = {}) {
      const limit = Math.max(0, Math.min(filter.limit ?? CRAWL_LIMITS.maxListedRuns, CRAWL_LIMITS.maxListedRuns));
      const rows = await db
        .select()
        .from(crawlRuns)
        .where(filter.projectId === undefined ? undefined : eq(crawlRuns.projectId, filter.projectId))
        .orderBy(desc(crawlRuns.createdAt), desc(crawlRuns.id))
        .limit(limit);
      return rows.map(runView).filter(present);
    },

    deleteRun,

    async deleteRunsOfProject(projectId) {
      const runs = await db.select({ id: crawlRuns.id }).from(crawlRuns).where(eq(crawlRuns.projectId, projectId));
      let deleted = 0;
      for (const run of runs) if (await deleteRun(run.id)) deleted += 1;
      return deleted;
    },

    async projectsWithRuns(projectIds) {
      const found = new Set<string>();
      for (const chunk of chunks([...new Set(projectIds)])) {
        const rows = await db.selectDistinct({ projectId: crawlRuns.projectId }).from(crawlRuns).where(inArray(crawlRuns.projectId, chunk));
        for (const row of rows) if (row.projectId !== null) found.add(row.projectId);
      }
      return projectIds.filter((id, i) => found.has(id) && projectIds.indexOf(id) === i);
    },

    async putPage(row) {
      const parsed = CrawlPageRowSchema.safeParse(row);
      if (!parsed.success) return false;
      const { findings, ...rest } = parsed.data;
      const values = { ...rest, findings: JSON.stringify(findings) };
      const { runId: _runId, url: _url, ...changes } = values;
      try {
        await db
          .insert(crawlPages)
          .values(values)
          .onConflictDoUpdate({ target: [crawlPages.runId, crawlPages.url], set: changes });
        return true;
      } catch (error) {
        // No such run (`crawl_pages_run_exists`): a crawl writing after its run was deleted.
        if (isNoSuchRun(error)) return false;
        throw error;
      }
    },

    async getPage(runId, url) {
      const [row] = await db
        .select()
        .from(crawlPages)
        .where(and(eq(crawlPages.runId, runId), eq(crawlPages.url, url)))
        .limit(1);
      return row ? pageRow(row) : null;
    },

    async pagesOf(runId, { limit, offset }) {
      const rows = await db
        .select()
        .from(crawlPages)
        .where(eq(crawlPages.runId, runId))
        .orderBy(asc(crawlPages.id))
        .limit(Math.max(0, Math.trunc(limit)))
        .offset(Math.max(0, Math.trunc(offset)));
      return rows.map(pageRow).filter(present);
    },

    async putLinks(runId, fromUrl, links) {
      const fromPage = await pageId(runId, fromUrl);
      if (fromPage === null) return 0;
      const kept = links
        .filter((link) => validUrl(link.toUrl) && typeof link.internal === 'boolean' && typeof link.nofollow === 'boolean')
        .slice(0, CRAWL_LIMITS.maxLinksStoredPerPage)
        .map(({ toUrl, internal, nofollow }) => ({ runId, fromPage, toUrl, internal, nofollow }));
      await runBatch(db, [
        db.delete(crawlLinks).where(and(eq(crawlLinks.runId, runId), eq(crawlLinks.fromPage, fromPage))),
        ...chunks(kept).map((chunk) => db.insert(crawlLinks).values(chunk)),
      ]);
      return kept.length;
    },

    async linksOf(runId, fromUrl) {
      const fromPage = await pageId(runId, fromUrl);
      if (fromPage === null) return [];
      return db
        .select({ toUrl: crawlLinks.toUrl, internal: crawlLinks.internal, nofollow: crawlLinks.nofollow })
        .from(crawlLinks)
        .where(and(eq(crawlLinks.runId, runId), eq(crawlLinks.fromPage, fromPage)))
        .orderBy(asc(crawlLinks.id));
    },

    async enqueue(runId, entries) {
      const byUrl = new Map<string, { runId: string; url: string; depth: number; state: 'queued'; inlinks: number; fromSitemap: boolean }>();
      for (const { url, depth, source } of entries) {
        if (!validUrl(url) || !validDepth(depth) || (source !== 'start' && source !== 'link' && source !== 'sitemap')) continue;
        const entry = byUrl.get(url) ?? { runId, url, depth, state: 'queued' as const, inlinks: 0, fromSitemap: false };
        // Each URL counts once per call (one call per discovering page).
        entry.depth = Math.min(entry.depth, depth);
        if (source === 'link') entry.inlinks = 1;
        if (source === 'sitemap') entry.fromSitemap = true;
        byUrl.set(url, entry);
      }
      if (byUrl.size === 0) return 0;
      const size = db.select({ n: count() }).from(crawlFrontier).where(eq(crawlFrontier.runId, runId));
      try {
        const results = await runBatch(db, [
          size,
          ...chunks([...byUrl.values()]).map((chunk) =>
            db
              .insert(crawlFrontier)
              .values(chunk)
              .onConflictDoUpdate({
                target: [crawlFrontier.runId, crawlFrontier.url],
                set: {
                  inlinks: sql`${crawlFrontier.inlinks} + excluded.inlinks`,
                  fromSitemap: sql`max(${crawlFrontier.fromSitemap}, excluded.from_sitemap)`,
                  depth: sql`CASE WHEN ${crawlFrontier.state} = 'queued' THEN min(${crawlFrontier.depth}, excluded.depth) ELSE ${crawlFrontier.depth} END`,
                },
              }),
          ),
          size,
        ]);
        const before = (results[0] as { n: number }[])[0]?.n ?? 0;
        const after = (results[results.length - 1] as { n: number }[])[0]?.n ?? 0;
        return after - before;
      } catch (error) {
        // No such run (`crawl_frontier_run_exists`).
        if (isNoSuchRun(error)) return 0;
        throw error;
      }
    },

    async frontierEntry(runId, url) {
      const [row] = await db
        .select({ url: crawlFrontier.url, depth: crawlFrontier.depth, state: crawlFrontier.state, inlinks: crawlFrontier.inlinks, fromSitemap: crawlFrontier.fromSitemap })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.runId, runId), eq(crawlFrontier.url, url)))
        .limit(1);
      return row ? { ...row, state: row.state as CrawlFrontierState } : null;
    },

    async knownUrls(runId, urls) {
      const known = new Set<string>();
      for (const chunk of chunks([...new Set(urls)])) {
        const rows = await db
          .select({ url: crawlFrontier.url })
          .from(crawlFrontier)
          .where(and(eq(crawlFrontier.runId, runId), inArray(crawlFrontier.url, chunk)));
        for (const row of rows) known.add(row.url);
      }
      return known;
    },

    async queryVariantCount(runId, base) {
      // `base?` up to (not including) `base@`: every URL that is `base` plus a query, on the `(run_id, url)` index.
      const [row] = await db
        .select({ n: count() })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.runId, runId), gte(crawlFrontier.url, `${base}?`), lt(crawlFrontier.url, `${base}@`)));
      return row?.n ?? 0;
    },

    async pageCounts(runId) {
      const rows = await db
        .select({ outcome: crawlPages.outcome, n: count(), bytes: sql<number>`coalesce(sum(${crawlPages.bytes}), 0)` })
        .from(crawlPages)
        .where(eq(crawlPages.runId, runId))
        .groupBy(crawlPages.outcome);
      const counts = { pages: 0, refused: 0, failed: 0, bytes: 0 };
      for (const { outcome, n, bytes } of rows) {
        counts.pages += n;
        counts.bytes += Number(bytes);
        if (REFUSED.has(outcome)) counts.refused += n;
        if (FAILED.has(outcome)) counts.failed += n;
      }
      return counts;
    },

    async pagesPage(runId, { filter, sort, direction, offset, limit }) {
      const where = and(...pageConditions(runId, filter));
      const [counted] = await db.select({ n: count() }).from(crawlPages).where(where);
      const total = counted?.n ?? 0;
      const rows = await db
        .select({ page: crawlPages, inlinks: inlinksOf })
        .from(crawlPages)
        .leftJoin(crawlFrontier, joinFrontier)
        .where(where)
        .orderBy(...orderOf(sort, direction))
        .limit(Math.max(0, Math.min(Math.trunc(limit), CRAWL_PAGES_LIMITS.maxPageSize)))
        .offset(Math.max(0, Math.trunc(offset)));
      return { total, rows: rows.map(listRow).filter(present) };
    },

    async pageOrder(runId, { filter, sort, direction }, limit) {
      const rows = await db
        .select({ id: crawlPages.id })
        .from(crawlPages)
        .leftJoin(crawlFrontier, joinFrontier)
        .where(and(...pageConditions(runId, filter)))
        .orderBy(...orderOf(sort, direction))
        .limit(Math.max(0, Math.min(Math.trunc(limit), CRAWL_LIMITS.maxPagesCap)));
      return rows.map((row) => row.id);
    },

    async pagesByIds(runId, ids) {
      const wanted = ids.filter((id) => Number.isInteger(id)).slice(0, CRAWL_PAGES_LIMITS.maxPageSize);
      if (wanted.length === 0) return [];
      const rows = await db
        .select({ page: crawlPages, inlinks: inlinksOf })
        .from(crawlPages)
        .leftJoin(crawlFrontier, joinFrontier)
        .where(and(eq(crawlPages.runId, runId), inArray(crawlPages.id, wanted)));
      const byId = new Map(rows.map((row) => [row.page.id, row] as const));
      return wanted.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => row !== undefined).map(listRow).filter(present);
    },

    async treeLevel(runId, prefix, limit) {
      const cap = Math.max(0, Math.min(Math.trunc(limit), CRAWL_TREE_LIMITS.maxChildren));
      type Group = { seg: string; pages: number; folder: number; here: number; groups: number };
      const names = ['seg', 'pages', 'folder', 'here', 'groups'] as const;
      if (prefix === null) {
        // Origins: each URL up to (not including) the first `/` after its `://` (stored URLs are normalised hrefs).
        const after = sql`substr(${crawlPages.url}, instr(${crawlPages.url}, '://') + 3)`;
        const origin = sql`iif(instr(${after}, '/') > 0, substr(${crawlPages.url}, 1, instr(${crawlPages.url}, '://') + 1 + instr(${after}, '/')), ${crawlPages.url})`;
        const groups = rowsOf<Group>(
          await db.all(
            sql`SELECT origin AS seg, count(*) AS pages, 1 AS folder, 0 AS here, count(*) OVER () AS groups FROM (SELECT ${origin} AS origin FROM ${crawlPages} WHERE ${crawlPages.runId} = ${runId}) GROUP BY origin ORDER BY pages DESC, origin ASC LIMIT ${cap}`,
          ),
          names,
        );
        const total = Number(groups[0]?.groups ?? 0);
        return { nodes: groups.map((g) => ({ label: String(g.seg), pages: Number(g.pages), prefix: `${String(g.seg)}/`, url: null })), more: Math.max(0, total - groups.length) };
      }
      const rest = sql.raw('rest');
      const groups = rowsOf<Group>(
        await db.all(
          sql`SELECT seg, count(*) AS pages, max(folder) AS folder, max(here) AS here, count(*) OVER () AS groups FROM (
                SELECT substr(rest, 1, cut - 1) AS seg, substr(rest, cut, 1) = '/' AS folder, cut > length(rest) AS here FROM (
                  SELECT rest, ${SEGMENT_END(rest)} AS cut FROM (
                    SELECT substr(${crawlPages.url}, ${prefix.length + 1}) AS rest FROM ${crawlPages}
                    WHERE ${crawlPages.runId} = ${runId} AND ${crawlPages.url} >= ${prefix} AND ${crawlPages.url} < ${prefixEnd(prefix)})))
              GROUP BY seg ORDER BY pages DESC, seg ASC LIMIT ${cap}`,
        ),
        names,
      );
      const total = Number(groups[0]?.groups ?? 0);
      return {
        nodes: groups.map((g) => {
          const seg = String(g.seg);
          return { label: seg, pages: Number(g.pages), prefix: Number(g.folder) === 1 ? `${prefix}${seg}/` : null, url: Number(g.here) === 1 ? `${prefix}${seg}` : null };
        }),
        more: Math.max(0, total - groups.length),
      };
    },

    async depthHistogram(runId) {
      const rows = await db.select({ depth: crawlPages.depth, pages: count() }).from(crawlPages).where(eq(crawlPages.runId, runId)).groupBy(crawlPages.depth).orderBy(asc(crawlPages.depth));
      return rows.filter((row) => validDepth(row.depth)).map((row) => ({ depth: row.depth, pages: row.pages }));
    },

    async orphansOf(runId, { limit, offset }) {
      const rows = await db
        .select({ url: crawlFrontier.url })
        .from(crawlFrontier)
        .where(orphan(runId))
        .orderBy(asc(crawlFrontier.id))
        .limit(Math.max(0, Math.trunc(limit)))
        .offset(Math.max(0, Math.trunc(offset)));
      return rows.map((row) => row.url);
    },

    async orphanCount(runId) {
      const [row] = await db.select({ n: count() }).from(crawlFrontier).where(orphan(runId));
      return row?.n ?? 0;
    },

    async nextQueued(runId, limit) {
      return db
        .select({ url: crawlFrontier.url, depth: crawlFrontier.depth })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.runId, runId), eq(crawlFrontier.state, 'queued')))
        .orderBy(asc(crawlFrontier.id))
        .limit(Math.max(0, Math.min(Math.trunc(limit), CRAWL_LIMITS.maxInMemoryEntries)));
    },

    async markDone(runId, urls) {
      if (urls.length === 0) return;
      await runBatch(
        db,
        chunks(urls).map((chunk) =>
          db
            .update(crawlFrontier)
            .set({ state: 'done' })
            .where(and(eq(crawlFrontier.runId, runId), inArray(crawlFrontier.url, chunk))),
        ),
      );
    },

    async queuedCount(runId) {
      const [row] = await db
        .select({ n: count() })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.runId, runId), eq(crawlFrontier.state, 'queued')));
      return row?.n ?? 0;
    },

    async pauseInterrupted(now) {
      const paused = await db
        .update(crawlRuns)
        .set({ state: 'paused', reason: 'interrupted', updatedAt: now })
        .where(inArray(crawlRuns.state, ['running', 'queued']))
        .returning({ id: crawlRuns.id });
      return paused.length;
    },
  };
}
