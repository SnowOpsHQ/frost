import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { MAX_SEARCH_PARAMS_JSON_BYTES } from '@app/specs/capture-db.spec';
import {
  MAX_READING_BYTES_PER_READ,
  MAX_READINGS_PER_READ,
  MAX_SERP_FILTERS_JSON_BYTES,
  MAX_SERP_READING_JSON_BYTES,
  SERP_READING_SOURCES,
  SERP_READING_STATUSES,
  type SerpReadingSource,
  type SerpReadingStatus,
} from '@app/specs/workspace-db.spec';
import type { SessionDatabase } from '../client';
import { batch, capped, chunks, insertWhere, isCount, isHash, isId, isJson, isOneOf, isStoredUrl, isTime, liveProject, pageKey, utf8Bytes } from './checks';
import { ciSerpReadings } from './workspace-schema';

// The SERP readings (Phase 10 Task 1; spec `workspace-db.spec.ts`; acceptance `workspace-db.feature.md`,
// Repository): what Phase 3 read on a result page, stored with the capture of that page (Decision 1),
// append-only, deleted only with their capture (a purge, `purge.ts`) or once it is gone (the orphan
// sweep). Zod-free and dumb about JSON, as the rest of the repository: main hands in the reading's
// JSON, its search key and parameters, and validates what it reads back (`StoredReadingSchema`).
// Every read skips a tampered row, and a capture-sourced reading whose capture is gone. A reading of
// another source (Phase 12's `serp-api`, `capture_id` `NULL` by design) is never such an orphan.

/** A reading as main hands it in with its capture (`AppendCaptureInput.reading`): the capture gives the rest. */
export interface CaptureReadingInput {
  readonly id: string;
  /** SHA-256 hex of the search identity (`searchIdentityJson`) under `searchKeyVersion`. */
  readonly searchKey: string;
  readonly searchKeyVersion: number;
  /** The capture's search parameters (JSON). */
  readonly searchParamsJson: string;
  /** The known filter parameters of the landed page (JSON, sorted keys). */
  readonly filtersJson: string;
  readonly status: SerpReadingStatus;
  /** The selector pack's version, `null` for an unreadable page read with none. */
  readonly packVersion: number | null;
  /** The `SerpSnapshot` JSON. */
  readonly readingJson: string;
}

/** A reading on its own (`appendReading`); Phase 10 accepts `source: 'capture'` only. */
export interface AppendReadingInput extends CaptureReadingInput {
  readonly projectId: string;
  /** The capture it was read with; required for `capture`, `null` for another source. */
  readonly captureId: string | null;
  readonly source: SerpReadingSource;
  readonly pageUrl: string | null;
  readonly observedAt: number;
  readonly createdAt: number;
}

export interface StoredReading extends AppendReadingInput {
  /** Stored UTF-8 bytes of `readingJson`. */
  readonly readingBytes: number;
}

/** A search seen in a project's readings: its key, and its newest reading's parameters and filters. */
export interface ReadingSearch {
  readonly searchKey: string;
  readonly searchKeyVersion: number;
  readonly searchParamsJson: string;
  readonly filtersJson: string;
  readonly readings: number;
  readonly lastObservedAt: number;
}

export interface ReadingsFilter {
  readonly projectId: string;
  readonly searchKey?: string;
  /** Inclusive bounds on `observedAt`. */
  readonly from?: number;
  readonly to?: number;
  /** At most this many (clamped to 1…`MAX_READINGS_PER_READ`). */
  readonly limit: number;
  /**
   * At most this many stored reading bytes (clamped to 1…`MAX_READING_BYTES_PER_READ`; absent: that
   * cap): a caller with a budget of its own across several reads (the rank table) passes what is left.
   */
  readonly maxBytes?: number;
}

/** Which readings `countReadings` counts: as `ReadingsFilter`, without the bounds. */
export type ReadingsCountFilter = Pick<ReadingsFilter, 'projectId' | 'searchKey' | 'from' | 'to'>;

/** One reading's date, as the Compare view's picker lists it (`readingDates`): no reading JSON. */
export interface ReadingDateRow {
  readonly id: string;
  readonly observedAt: number;
  readonly status: SerpReadingStatus;
}

export interface ReadingOperations {
  /**
   * A reading on its own. Refuses (`false`, nothing written) any source but `capture` in Phase 10,
   * and a `capture` reading unless its capture exists in its live project and has no reading yet.
   */
  appendReading(input: AppendReadingInput): Promise<boolean>;
  /**
   * A project's readings, newest first by `(observedAt, id)`: at most `limit`, and only while their
   * running total of stored bytes stays within `MAX_READING_BYTES_PER_READ` (the JSON of the rest is
   * never read).
   */
  readings(filter: ReadingsFilter): Promise<StoredReading[]>;
  /** How many readings `readings` would answer without its `limit` and byte bounds (orphans skipped). */
  countReadings(filter: ReadingsCountFilter): Promise<number>;
  /**
   * One search key's readings of a project, newest first by `(observedAt, id)`, at most `limit`
   * (clamped to 1…`MAX_READINGS_PER_READ`): ids, times and statuses only, the reading JSON never loaded.
   */
  readingDates(filter: { readonly projectId: string; readonly searchKey: string; readonly limit: number }): Promise<ReadingDateRow[]>;
  /** The searches seen in a project's readings, most recently observed first. */
  readingSearches(projectId: string): Promise<ReadingSearch[]>;
  reading(id: string): Promise<StoredReading | null>;
  /** Deletes the capture-sourced readings whose capture is gone (one project's, or all); answers how many. */
  deleteOrphanReadings(projectId?: string): Promise<number>;
}

/** Whether a reading's own fields are valid (the capture's are checked with the capture). */
export function isCaptureReading(reading: unknown): reading is CaptureReadingInput {
  if (typeof reading !== 'object' || reading === null) return false;
  const { id, searchKey, searchKeyVersion, searchParamsJson, filtersJson, status, packVersion, readingJson } = reading as CaptureReadingInput;
  return (
    isId(id) &&
    isHash(searchKey) &&
    isCount(searchKeyVersion, 1) &&
    isJson(searchParamsJson, MAX_SEARCH_PARAMS_JSON_BYTES) &&
    isJson(filtersJson, MAX_SERP_FILTERS_JSON_BYTES) &&
    isOneOf(SERP_READING_STATUSES, status) &&
    (packVersion === null || isCount(packVersion, 1)) &&
    isJson(readingJson, MAX_SERP_READING_JSON_BYTES)
  );
}

/** The row of a reading (validated) for `ci_serp_readings`. */
export function readingRow(reading: CaptureReadingInput, of: { projectId: string; captureId: string | null; source: SerpReadingSource; pageUrl: string | null; observedAt: number; createdAt: number }) {
  return {
    id: reading.id,
    projectId: of.projectId,
    captureId: of.captureId,
    source: of.source,
    searchKey: reading.searchKey,
    searchKeyVersion: reading.searchKeyVersion,
    searchParams: reading.searchParamsJson,
    filters: reading.filtersJson,
    pageUrl: of.pageUrl,
    status: reading.status,
    packVersion: reading.packVersion,
    reading: reading.readingJson,
    readingBytes: utf8Bytes(reading.readingJson),
    observedAt: of.observedAt,
    createdAt: of.createdAt,
  };
}

/** Not a capture-sourced reading whose capture is gone (the filter names `source`, never the capture alone). */
export const notOrphan: SQL = sql`(ci_serp_readings.source <> 'capture' OR EXISTS (SELECT 1 FROM ci_captures c WHERE c.id = ci_serp_readings.capture_id))`;
const orphan: SQL = sql`(ci_serp_readings.source = 'capture' AND ci_serp_readings.capture_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ci_captures c WHERE c.id = ci_serp_readings.capture_id))`;

const readingColumns = {
  id: ciSerpReadings.id,
  projectId: capped(ciSerpReadings.projectId, 36),
  captureId: capped(ciSerpReadings.captureId, 36),
  source: capped(ciSerpReadings.source, 16),
  searchKey: capped(ciSerpReadings.searchKey, 64),
  searchKeyVersion: ciSerpReadings.searchKeyVersion,
  searchParams: capped(ciSerpReadings.searchParams, MAX_SEARCH_PARAMS_JSON_BYTES),
  filters: capped(ciSerpReadings.filters, MAX_SERP_FILTERS_JSON_BYTES),
  pageUrl: capped(ciSerpReadings.pageUrl, MAX_STORED_URL_LENGTH),
  status: capped(ciSerpReadings.status, 16),
  packVersion: ciSerpReadings.packVersion,
  reading: capped(ciSerpReadings.reading, MAX_SERP_READING_JSON_BYTES),
  readingBytes: ciSerpReadings.readingBytes,
  observedAt: ciSerpReadings.observedAt,
  createdAt: ciSerpReadings.createdAt,
};
type ReadingRow = { [K in keyof typeof readingColumns]: unknown };

function readingOf(row: ReadingRow): StoredReading | null {
  const { id, projectId, captureId, source, searchKey, searchKeyVersion, searchParams, filters, pageUrl, status, packVersion, reading, readingBytes, observedAt, createdAt } = row;
  if (!isId(id) || !isId(projectId) || !isOneOf(SERP_READING_SOURCES, source) || !(source === 'capture' ? isId(captureId) : captureId === null)) return null;
  const valid = { id, searchKey, searchKeyVersion, searchParamsJson: searchParams, filtersJson: filters, status, packVersion, readingJson: reading };
  if (!isCaptureReading(valid) || !(pageUrl === null || isStoredUrl(pageUrl)) || readingBytes !== utf8Bytes(valid.readingJson) || !isTime(observedAt) || !isTime(createdAt)) return null;
  return { ...valid, projectId, captureId: captureId as string | null, source, pageUrl, readingBytes, observedAt, createdAt };
}

const present = <T>(value: T | null): value is T => value !== null;
const readLimit = (limit: unknown): number => Math.min(Math.max(Math.trunc(Number(limit)) || 1, 1), MAX_READINGS_PER_READ);
const byteBudget = (maxBytes: unknown): number => (maxBytes === undefined ? MAX_READING_BYTES_PER_READ : Math.min(Math.max(Math.trunc(Number(maxBytes)) || 1, 1), MAX_READING_BYTES_PER_READ));
/** The `WHERE` of a project's (non-orphan) readings, optionally of one key and within `from`…`to`; `null` for an invalid filter. */
function readingsWhere({ projectId, searchKey, from, to }: ReadingsCountFilter): SQL | null {
  if (!isId(projectId) || (searchKey !== undefined && !isHash(searchKey)) || (from !== undefined && !isTime(from)) || (to !== undefined && !isTime(to))) return null;
  return and(
    eq(ciSerpReadings.projectId, projectId),
    searchKey === undefined ? undefined : eq(ciSerpReadings.searchKey, searchKey),
    from === undefined ? undefined : gte(ciSerpReadings.observedAt, from),
    to === undefined ? undefined : lte(ciSerpReadings.observedAt, to),
    notOrphan,
  )!;
}

export function createReadingOperations(db: SessionDatabase): ReadingOperations {
  const exists = async (id: string): Promise<boolean> => (await db.select({ id: ciSerpReadings.id }).from(ciSerpReadings).where(eq(ciSerpReadings.id, id)).limit(1)).length > 0;

  return {
    async appendReading(input) {
      if (typeof input !== 'object' || input === null || input.source !== 'capture') return false;
      const { projectId, captureId, observedAt, createdAt } = input;
      const pageUrl = input.pageUrl === null ? null : pageKey(input.pageUrl);
      if (!isCaptureReading(input) || !isId(projectId) || !isId(captureId) || (input.pageUrl !== null && pageUrl === null) || !isTime(observedAt) || !isTime(createdAt)) return false;
      if (await exists(input.id)) return false;
      const row = readingRow(input, { projectId, captureId, source: 'capture', pageUrl, observedAt, createdAt });
      // Checked inside the insert: the project is live, the capture is its own, and has no reading yet
      // (a second one would abort on `ci_serp_readings_no_replace`).
      const condition = sql`${liveProject(projectId)} AND EXISTS (SELECT 1 FROM ci_captures WHERE id = ${captureId} AND project_id = ${projectId}) AND NOT EXISTS (SELECT 1 FROM ci_serp_readings WHERE capture_id = ${captureId} OR id = ${input.id})`;
      await batch(db, [insertWhere(db, ciSerpReadings, row, condition)]);
      return exists(input.id);
    },

    async readings(filter) {
      const where = typeof filter === 'object' && filter !== null ? readingsWhere(filter) : null;
      if (where === null) return [];
      const budget = byteBudget(filter.maxBytes);
      // First the newest ids with their stored sizes (measured in SQL; no JSON is loaded), then the
      // rows of the newest prefix that fits the byte budget.
      const sized = await db
        .select({ id: ciSerpReadings.id, bytes: sql<unknown>`length(CAST(${ciSerpReadings.reading} AS BLOB))` })
        .from(ciSerpReadings)
        .where(where)
        .orderBy(desc(ciSerpReadings.observedAt), desc(ciSerpReadings.id))
        .limit(readLimit(filter.limit));
      const ids: string[] = [];
      let total = 0;
      for (const { id, bytes } of sized) {
        total += typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
        if (total > budget) break;
        if (typeof id === 'string') ids.push(id);
      }
      const found = new Map<string, StoredReading>();
      for (const part of chunks(ids)) {
        for (const reading of (await db.select(readingColumns).from(ciSerpReadings).where(inArray(ciSerpReadings.id, part))).map(readingOf).filter(present)) found.set(reading.id, reading);
      }
      return ids.flatMap((id) => found.get(id) ?? []);
    },

    async countReadings(filter) {
      const where = typeof filter === 'object' && filter !== null ? readingsWhere(filter) : null;
      if (where === null) return 0;
      const [row] = await db.select({ n: count() }).from(ciSerpReadings).where(where);
      return isCount(row?.n, 0) ? row.n : 0;
    },

    async readingDates(filter) {
      const where = typeof filter === 'object' && filter !== null && isHash(filter.searchKey) ? readingsWhere({ projectId: filter.projectId, searchKey: filter.searchKey }) : null;
      if (where === null) return [];
      const rows = await db
        .select({ id: ciSerpReadings.id, observedAt: ciSerpReadings.observedAt, status: capped(ciSerpReadings.status, 16) })
        .from(ciSerpReadings)
        .where(where)
        .orderBy(desc(ciSerpReadings.observedAt), desc(ciSerpReadings.id))
        .limit(readLimit(filter.limit));
      return rows.flatMap(({ id, observedAt, status }) => (isId(id) && isTime(observedAt) && isOneOf(SERP_READING_STATUSES, status) ? [{ id, observedAt, status }] : []));
    },

    async readingSearches(projectId) {
      if (!isId(projectId)) return [];
      // One row per (key, key version); the bare columns come from the row with the newest `observed_at`.
      const last = sql<unknown>`max(${ciSerpReadings.observedAt})`;
      const rows = await db
        .select({
          searchKey: capped(ciSerpReadings.searchKey, 64),
          searchKeyVersion: ciSerpReadings.searchKeyVersion,
          searchParams: capped(ciSerpReadings.searchParams, MAX_SEARCH_PARAMS_JSON_BYTES),
          filters: capped(ciSerpReadings.filters, MAX_SERP_FILTERS_JSON_BYTES),
          readings: count(),
          lastObservedAt: last,
        })
        .from(ciSerpReadings)
        .where(and(eq(ciSerpReadings.projectId, projectId), notOrphan))
        .groupBy(ciSerpReadings.searchKey, ciSerpReadings.searchKeyVersion)
        .orderBy(desc(last), asc(ciSerpReadings.searchKey), asc(ciSerpReadings.searchKeyVersion))
        .limit(MAX_READINGS_PER_READ);
      return rows.flatMap(({ searchKey, searchKeyVersion, searchParams, filters, readings, lastObservedAt }) =>
        isHash(searchKey) && isCount(searchKeyVersion, 1) && isJson(searchParams, MAX_SEARCH_PARAMS_JSON_BYTES) && isJson(filters, MAX_SERP_FILTERS_JSON_BYTES) && isCount(readings, 1) && isTime(lastObservedAt)
          ? [{ searchKey, searchKeyVersion, searchParamsJson: searchParams, filtersJson: filters, readings, lastObservedAt }]
          : [],
      );
    },

    async reading(id) {
      if (!isId(id)) return null;
      const [row] = await db
        .select(readingColumns)
        .from(ciSerpReadings)
        .where(and(eq(ciSerpReadings.id, id), notOrphan))
        .limit(1);
      return row ? readingOf(row) : null;
    },

    async deleteOrphanReadings(projectId) {
      if (projectId !== undefined && !isId(projectId)) return 0;
      const rows = await db
        .delete(ciSerpReadings)
        .where(and(orphan, projectId === undefined ? undefined : eq(ciSerpReadings.projectId, projectId)))
        .returning({ id: ciSerpReadings.id });
      return rows.length;
    },
  };
}
