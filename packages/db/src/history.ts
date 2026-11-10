import { and, desc, eq, gte, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { HISTORY_PAGE_SIZE, HISTORY_QUERY_MAX_CHARS, JUMP_BACK_IN_MOST_VISITED, JUMP_BACK_IN_RECENT } from '@app/specs/browser-polish.spec';
import type { SessionDatabase } from './client';
import { recentVisits } from './schema';
import { storableTitle, storableUrl } from './values';

// The History view's and the new-tab page's reads of `recent_visits` (Phase 2.5 Task 6; spec
// `browser-polish.spec.ts`; acceptance `browser-polish.feature.md`, History view and New-tab page),
// and deleting one visit or all of them. Rows read back are checked like the session tables'
// (`values.ts`): a tampered row is skipped, never handed to the chrome.

export interface HistoryVisit {
  readonly url: string;
  readonly title: string;
  readonly visitCount: number;
  readonly lastVisitAt: number;
  /**
   * `list` only (Phase 11 Task 10): how many times frost recorded this page changing, summed over its
   * capture lanes (its `ci_versions`, less one per lane); `0` when never captured.
   */
  readonly changeCount?: number;
}

/** Where a page of visits starts: after this one (newest first). */
export interface HistoryCursor {
  readonly lastVisitAt: number;
  readonly url: string;
}

export interface HistoryPage {
  readonly visits: readonly HistoryVisit[];
  /** Where the next page starts, or `null` when this is the last one. */
  readonly next: HistoryCursor | null;
}

export interface JumpBackIn {
  /** The most visited pages, most visits first. */
  readonly mostVisited: readonly HistoryVisit[];
  /** Other recent pages (none of `mostVisited`), newest first. */
  readonly recent: readonly HistoryVisit[];
}

export interface HistoryListOptions {
  /** Title or URL substring (`''`: every visit); case-insensitive for ASCII, `%` and `_` literal. */
  readonly query: string;
  readonly after: HistoryCursor | null;
  /** At most `HISTORY_PAGE_SIZE`. */
  readonly limit?: number;
  /** Only visits to this live project's live pages (fragment ignored); Phase 11 Task 10. */
  readonly projectId?: string;
}

export interface HistoryRepository {
  /** One page of visits, newest first (`last_visit_at`, then URL, descending). */
  list(options: HistoryListOptions): Promise<HistoryPage>;
  jumpBackIn(): Promise<JumpBackIn>;
  /**
   * Retention (Phase 11 Task 10): deletes the visit rows last seen before `before`; with
   * `keepProjectPages`, not those whose URL (fragment ignored) is a live page of a live project.
   * Resolves how many rows went.
   */
  prune(before: number, keepProjectPages: boolean): Promise<number>;
  /** Clear by range: deletes the visit rows last seen at or after `since`. Resolves how many went. */
  clearSince(since: number): Promise<number>;
}

/** The history part of Clear Browsing Data: every visit (`SessionRepository.clearBrowsingData` and `clearHistory`). */
export function clearHistoryItems(db: SessionDatabase): BatchItem<'sqlite'>[] {
  return [db.delete(recentVisits)];
}

/** Deletes `url`'s visit (as given, and as it would be stored); `null` for a URL that cannot be stored. */
export function deleteVisitItem(db: SessionDatabase, url: string): BatchItem<'sqlite'> | null {
  const stored = storableUrl(url);
  return stored === null ? null : db.delete(recentVisits).where(inArray(recentVisits.url, [...new Set([url, stored])]));
}

/** `query` as a LIKE pattern: `\`, `%` and `_` escaped (for `ESCAPE '\'`), wrapped in `%`. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
const isChangeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A visit's URL without its fragment, as `ci_project_pages` and `ci_versions` store a page (`noteUrl`): in a serialized URL the first `#` starts the fragment. */
// Written out in full (`recent_visits.url`): Drizzle may render a column unqualified, which inside
// the correlated subqueries below would mean the inner table's `url`.
const pageUrlOf = sql.raw(`(CASE WHEN instr(recent_visits.url, '#') > 0 THEN substr(recent_visits.url, 1, instr(recent_visits.url, '#') - 1) ELSE recent_visits.url END)`);

/** Whether the visit's page is a live page of a live project (`projectId`: of that one). */
function isProjectPage(projectId?: string): SQL {
  const inProject = projectId === undefined ? sql`` : sql` AND p.project_id = ${projectId}`;
  return sql`EXISTS (SELECT 1 FROM ci_project_pages p JOIN ci_projects j ON j.id = p.project_id AND j.deleted_at IS NULL WHERE p.deleted_at IS NULL AND p.url = ${pageUrlOf}${inProject})`;
}
const isTime = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

type Row = { url: unknown; title: unknown; visitCount: unknown; lastVisitAt: unknown; changeCount?: unknown };

/** `row` as a visit, if every value is one frost could have stored; else `null`. */
function visitOf(row: Row): HistoryVisit | null {
  const url = storableUrl(row.url);
  if (url === null || url !== row.url || !isCount(row.visitCount) || !isTime(row.lastVisitAt)) return null;
  const visit = { url, title: storableTitle(row.title), visitCount: row.visitCount, lastVisitAt: row.lastVisitAt };
  if (!('changeCount' in row)) return visit;
  return { ...visit, changeCount: isChangeCount(row.changeCount) ? row.changeCount : 0 };
}

export function createHistoryRepository(db: SessionDatabase): HistoryRepository {
  // A tampered file may hold values of any size: no more of each than can be stored (one over the URL cap).
  const columns = {
    url: sql<unknown>`substr(${recentVisits.url}, 1, ${MAX_STORED_URL_LENGTH + 1})`,
    title: sql<unknown>`substr(${recentVisits.title}, 1, ${MAX_STORED_TITLE_LENGTH * 2})`,
    visitCount: recentVisits.visitCount,
    lastVisitAt: recentVisits.lastVisitAt,
  };
  // The page's versions less one per lane: each lane's first version is not a change.
  const changeCount = sql<unknown>`(SELECT count(*) - count(DISTINCT v.lane_key) FROM ci_versions v WHERE v.page_url = ${pageUrlOf})`;
  const newestFirst = [desc(recentVisits.lastVisitAt), desc(recentVisits.url)];
  const rows = (where: SQL | undefined, order: SQL[], limit: number, withChanges = false): Promise<Row[]> =>
    db
      .select(withChanges ? { ...columns, changeCount } : columns)
      .from(recentVisits)
      .where(where)
      .orderBy(...order)
      .limit(limit);

  return {
    async list({ query, after, limit = HISTORY_PAGE_SIZE, projectId }) {
      const size = Math.min(Math.max(Math.trunc(limit), 1), HISTORY_PAGE_SIZE);
      const text = query.slice(0, HISTORY_QUERY_MAX_CHARS).trim();
      const pattern = likePattern(text);
      const matches = text === '' ? undefined : sql`(${recentVisits.title} LIKE ${pattern} ESCAPE '\\' OR ${recentVisits.url} LIKE ${pattern} ESCAPE '\\')`;
      const older = after === null ? undefined : or(lt(recentVisits.lastVisitAt, after.lastVisitAt), and(eq(recentVisits.lastVisitAt, after.lastVisitAt), lt(recentVisits.url, after.url)));
      const inProject = projectId === undefined ? undefined : isProjectPage(projectId);
      // One more than a page: whether another page follows.
      const found = await rows(and(matches, older, inProject), newestFirst, size + 1, true);
      const page = found.slice(0, size);
      const visits = page.flatMap((row) => visitOf(row) ?? []);
      // The cursor is the last row read (a skipped tampered row still moves it on).
      const last = page[page.length - 1];
      const next = found.length > size && last && isTime(last.lastVisitAt) && typeof last.url === 'string' ? { lastVisitAt: last.lastVisitAt, url: last.url } : null;
      return { visits, next };
    },

    async jumpBackIn() {
      const top = (await rows(undefined, [desc(recentVisits.visitCount), ...newestFirst], JUMP_BACK_IN_MOST_VISITED)).flatMap((row) => visitOf(row) ?? []);
      const taken = top.map((visit) => visit.url);
      const latest = await rows(taken.length > 0 ? notInArray(recentVisits.url, taken) : undefined, newestFirst, JUMP_BACK_IN_RECENT);
      return { mostVisited: top, recent: latest.flatMap((row) => visitOf(row) ?? []) };
    },

    async prune(before, keepProjectPages) {
      if (!Number.isSafeInteger(before)) return 0;
      const gone = await db
        .delete(recentVisits)
        .where(and(lt(recentVisits.lastVisitAt, before), keepProjectPages ? sql`NOT ${isProjectPage()}` : undefined))
        .returning({ url: recentVisits.url });
      return gone.length;
    },

    async clearSince(since) {
      if (!Number.isSafeInteger(since)) return 0;
      const gone = await db.delete(recentVisits).where(gte(recentVisits.lastVisitAt, since)).returning({ url: recentVisits.url });
      return gone.length;
    },
  };
}
