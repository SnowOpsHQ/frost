import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import {
  CAPTURE_SOURCES,
  MAX_DIFF_JSON_BYTES,
  MAX_DIFF_SUMMARY_JSON_BYTES,
  MAX_PROFILE_JSON_BYTES,
  MAX_PROJECT_PAGES,
  MAX_PROJECT_QUERIES,
  MAX_PROJECTS,
  MAX_RECT_JSON_BYTES,
  MAX_SEARCH_PARAMS_JSON_BYTES,
  MAX_SNAPSHOT_JSON_BYTES,
  PROJECT_NAME_MAX_CHARS,
  PROJECT_QUERY_MAX_CHARS,
  SCREENSHOT_KINDS,
  UNFILED_PROJECT_ID,
  type CaptureSource,
  type CapturedTable,
  type RetentionMode,
  type ScreenshotKind,
} from '@app/specs/capture-db.spec';
import type { SessionDatabase } from '../client';
import { capped, isCount, isHash, isId, isJson, isJsonOrNull, isOneOf, isRetention, isStoredUrl, isTime, pageKey, pageSize, SHA256_GLOB, trimmedText, utf8Bytes, UUIDV7_GLOB } from './checks';
import { uuidv7 } from './ids';
import { createPurgeOperations, type PurgeOperations } from './purge';
import { ciCaptures, ciDiffs, ciProjectPages, ciProjectQueries, ciProjects, ciScreenshots, ciTombstones, ciVersions } from './schema';

export type { ExecutePurgeResult, PurgeCounts, PurgePlan, PurgePolicy, PurgeRecord } from './purge';

// The change-intelligence repository (Phase 6 Task 1; spec `capture-db.spec.ts`; acceptance
// `capture-db.feature.md`): the only reads and writes of the `ci_*` tables. Zod-free and dumb about
// JSON: main hands in canonical JSON text, hashes and lane keys it computed, and gets text back to
// validate. Everything that can be checked here is, both ways: invalid input is refused (`null` or
// `false`, nothing written); a tampered row is skipped on the way out.

// ---- Shapes ------------------------------------------------------------------------------------

/** The diff of a new version against the lane's latest one, computed by main. */
export interface AppendDiffInput {
  readonly id: string;
  /** The lane's latest version main diffed against; another one makes the append `stale`. */
  readonly fromVersionId: string;
  readonly engineVersion: number;
  readonly diffJson: string;
  readonly summaryJson: string;
  readonly changeCount: number;
}

export interface AppendCaptureInput {
  readonly captureId: string;
  /** The id of the new version, used only if the snapshot hash differs from the lane's latest. */
  readonly versionId: string;
  readonly projectId: string;
  readonly laneKey: string;
  readonly pageUrl: string;
  readonly renderProfileJson: string | null;
  readonly renderProfilePartial: boolean;
  readonly searchParamsJson: string | null;
  readonly source: CaptureSource;
  readonly auditTakenAt: number;
  readonly snapshotJson: string;
  readonly snapshotHash: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  /**
   * Required when the lane's latest version (as `latestVersion` answers it) has another hash; absent
   * when `latestVersion` answers `null` (an empty lane, or a latest row that fails its checks).
   */
  readonly diff?: AppendDiffInput;
}

export type AppendCaptureResult = { readonly status: 'appended'; readonly captureId: string; readonly versionId: string; readonly newVersion: boolean } | { readonly status: 'stale' };

export interface AppendScreenshotInput {
  readonly id: string;
  readonly projectId: string;
  readonly pageUrl: string;
  readonly captureId: string | null;
  readonly kind: ScreenshotKind;
  /** The selected area (JSON) of an `area` screenshot; `null` for the other kinds. */
  readonly rectJson: string | null;
  readonly width: number;
  readonly height: number;
  /** The PNG file's size. */
  readonly bytes: number;
  readonly sha256: string;
  readonly segments: number;
  readonly renderProfileJson: string | null;
  readonly searchParamsJson: string | null;
  readonly createdAt: number;
}

export type StoredScreenshot = AppendScreenshotInput;

/** A version without its snapshot. */
export interface VersionSummary {
  readonly id: string;
  readonly laneKey: string;
  readonly pageUrl: string;
  readonly renderProfileJson: string | null;
  readonly searchParamsJson: string | null;
  readonly snapshotHash: string;
  readonly snapshotBytes: number;
  readonly schemaVersion: number;
  /** The lane's latest version when this one was inserted (it may since have been purged). */
  readonly parentVersionId: string | null;
  readonly createdAt: number;
}

export interface StoredVersion extends VersionSummary {
  readonly snapshotJson: string;
}

/** The stored diff of a version against its parent, without the diff itself. */
export interface DiffSummary {
  readonly id: string;
  readonly fromVersionId: string;
  readonly engineVersion: number;
  readonly summaryJson: string;
  readonly changeCount: number;
}

export interface StoredDiff extends DiffSummary {
  readonly laneKey: string;
  readonly toVersionId: string;
  readonly diffJson: string;
  readonly createdAt: number;
}

export interface HistoryEntry extends VersionSummary {
  /** Captures of this version (in the project, when the history is a project's). */
  readonly captureCount: number;
  readonly lastCapturedAt: number | null;
  /** The stored diff against `parentVersionId`, if there is one. */
  readonly diff: DiffSummary | null;
}

/** Where a page of a newest-first list starts: after this row. */
export interface ChangeIntelCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  readonly next: ChangeIntelCursor | null;
}

export interface ScreenshotPage {
  readonly screenshots: readonly StoredScreenshot[];
  readonly next: ChangeIntelCursor | null;
}

export interface CapturedPage {
  readonly pageUrl: string;
  readonly captureCount: number;
  readonly lastCapturedAt: number;
}

export interface RetentionPolicy {
  readonly mode: RetentionMode;
  /** N for `versions` and `days`; `null` for `forever`. */
  readonly value: number | null;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly renderProfileJson: string | null;
  readonly retention: RetentionPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectPage {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectQuery {
  readonly id: string;
  readonly projectId: string;
  readonly query: string;
  readonly searchParamsJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Stored sizes (UTF-8 bytes of the stored text; screenshots by their rows' `bytes`, each hash once). */
export interface ChangeIntelUsage {
  readonly captures: number;
  readonly versions: number;
  /** Of `versions`, the ones another project's captures also point at (without a project: two or more projects'). */
  readonly sharedVersions: number;
  readonly snapshotBytes: number;
  /** Diffs into `versions`. */
  readonly diffBytes: number;
  readonly screenshots: number;
  readonly screenshotBytes: number;
  /** Distinct screenshot hashes (files) another project's rows also name (without a project: two or more projects'). */
  readonly sharedScreenshotFiles: number;
}

export interface ChangeIntelRepository extends PurgeOperations {
  /** Appends a capture (and a new version and its diff when the snapshot changed) in one transaction; `null` for invalid input. */
  appendCapture(input: AppendCaptureInput): Promise<AppendCaptureResult | null>;
  appendScreenshot(input: AppendScreenshotInput): Promise<boolean>;
  /** The lane's latest version (greatest `(created_at, id)` among rows with a well-formed id, hash and time); `null` if that row fails its checks. */
  latestVersion(laneKey: string): Promise<VersionSummary | null>;
  version(id: string): Promise<StoredVersion | null>;
  /** A page's versions across lanes, newest first. */
  history(filter: { readonly pageUrl: string; readonly projectId?: string; readonly cursor?: ChangeIntelCursor | null; readonly limit?: number }): Promise<HistoryPage>;
  diffFor(fromVersionId: string, toVersionId: string): Promise<StoredDiff | null>;
  screenshots(filter: { readonly pageUrl?: string; readonly projectId?: string; readonly cursor?: ChangeIntelCursor | null; readonly limit?: number }): Promise<ScreenshotPage>;
  screenshot(id: string): Promise<StoredScreenshot | null>;
  /** Captured page URLs, most recently captured first. */
  pages(filter: { readonly projectId?: string; readonly limit?: number }): Promise<CapturedPage[]>;
  isHashReferenced(sha256: string): Promise<boolean>;
  /** Every distinct screenshot hash (the orphan sweep keeps these files), or one project's (its usage measures them). */
  screenshotHashes(filter?: { readonly projectId?: string }): Promise<string[]>;

  createProject(name: string, now: number): Promise<Project | null>;
  renameProject(id: string, name: string, now: number): Promise<boolean>;
  setProjectRenderProfile(id: string, renderProfileJson: string | null, now: number): Promise<boolean>;
  setRetention(id: string, mode: RetentionMode, value: number | null, now: number): Promise<boolean>;
  /** Tombstones the project with its live pages and queries (never Unfiled). */
  tombstoneProject(id: string, now: number): Promise<boolean>;
  /** Live projects, Unfiled first, then by creation. */
  projects(): Promise<Project[]>;
  /** Tombstoned projects that still have captures or screenshots (a `project-deleted` purge that did not run), oldest deletion first. */
  deletedProjectsWithRows(): Promise<string[]>;
  /** A live project. */
  project(id: string): Promise<Project | null>;
  /** Adds a page (its live row if it has one already); `null` if invalid or past the cap. */
  addPage(projectId: string, url: string, now: number): Promise<ProjectPage | null>;
  removePage(projectId: string, pageId: string, now: number): Promise<boolean>;
  projectPages(projectId: string): Promise<ProjectPage[]>;
  /** Live projects holding `url` as a live page. */
  projectsForPage(url: string): Promise<Project[]>;
  addQuery(projectId: string, query: string, searchParamsJson: string, now: number): Promise<ProjectQuery | null>;
  removeQuery(projectId: string, queryId: string, now: number): Promise<boolean>;
  projectQueries(projectId: string): Promise<ProjectQuery[]>;

  /** One project's usage, or the totals (no project); `null` for an invalid project id. */
  usage(projectId?: string): Promise<ChangeIntelUsage | null>;
  /** `VACUUM`: rewrites the session database file, giving back the free pages purges left (Task 7's "Compact"). */
  compact(): Promise<void>;
}

// ---- Helpers -----------------------------------------------------------------------------------

type Value = string | number | null;

/**
 * `INSERT INTO table (…) SELECT … WHERE condition`: the row is written only if `condition` holds
 * when the statement runs, inside the batch's transaction. Values are bound as given (booleans as 0/1).
 */
function insertWhere<T extends SQLiteTable>(db: SessionDatabase, table: T, row: Partial<Record<keyof T['$inferInsert'] & string, Value>>, condition: SQL): BatchItem<'sqlite'> {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const keys = Object.keys(row) as (keyof typeof row & string)[];
  const names = sql.join(
    keys.map((key) => sql.identifier(columns[key]!.name)),
    sql`, `,
  );
  const values = sql.join(
    keys.map((key) => sql`${row[key]}`),
    sql`, `,
  );
  return db.run(sql`INSERT INTO ${table} (${names}) SELECT ${values} WHERE ${condition}`);
}

const liveProject = (projectId: string): SQL => sql`EXISTS (SELECT 1 FROM ci_projects WHERE id = ${projectId} AND deleted_at IS NULL)`;
/**
 * The rows that can be a lane's latest version: those whose id, hash and time are well-formed. The
 * read (`latestVersion`), `appendCapture`'s read and its in-transaction check all use it, so a
 * tampered row never becomes a head the reads cannot see (which would block the lane for good).
 */
const laneHeads = (laneKey: string): SQL =>
  sql`lane_key = ${laneKey} AND id GLOB ${UUIDV7_GLOB} AND snapshot_hash GLOB ${SHA256_GLOB} AND typeof(created_at) = 'integer' AND created_at >= 0`;
/** The lane's latest version id, as `latestVersion` orders it. */
const latestIdOf = (laneKey: string): SQL => sql`(SELECT id FROM ci_versions WHERE ${laneHeads(laneKey)} ORDER BY created_at DESC, id DESC LIMIT 1)`;

/** Rows after `cursor` in `(createdAt, id)` descending order. */
function olderThan(createdAt: typeof ciVersions.createdAt | typeof ciScreenshots.createdAt, id: typeof ciVersions.id | typeof ciScreenshots.id, cursor: ChangeIntelCursor): SQL | undefined {
  return or(lt(createdAt, cursor.createdAt), and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)));
}
const isCursor = (cursor: unknown): cursor is ChangeIntelCursor =>
  typeof cursor === 'object' && cursor !== null && isTime((cursor as ChangeIntelCursor).createdAt) && typeof (cursor as ChangeIntelCursor).id === 'string';
/** The cursor after the last row read (a skipped tampered row still moves it on). */
function nextCursor(found: readonly { createdAt: unknown; id: unknown }[], size: number): ChangeIntelCursor | null {
  const last = found[size - 1];
  return found.length > size && last && isTime(last.createdAt) && typeof last.id === 'string' ? { createdAt: last.createdAt, id: last.id } : null;
}

const versionColumns = {
  id: ciVersions.id,
  laneKey: capped(ciVersions.laneKey, 64),
  pageUrl: capped(ciVersions.pageUrl, MAX_STORED_URL_LENGTH),
  renderProfile: capped(ciVersions.renderProfile, MAX_PROFILE_JSON_BYTES),
  searchParams: capped(ciVersions.searchParams, MAX_SEARCH_PARAMS_JSON_BYTES),
  snapshotHash: capped(ciVersions.snapshotHash, 64),
  snapshotBytes: ciVersions.snapshotBytes,
  schemaVersion: ciVersions.schemaVersion,
  parentVersionId: capped(ciVersions.parentVersionId, 36),
  createdAt: ciVersions.createdAt,
};
type VersionRow = { [K in keyof typeof versionColumns]: unknown };

function versionOf(row: VersionRow): VersionSummary | null {
  const { id, laneKey, pageUrl, renderProfile, searchParams, snapshotHash, snapshotBytes, schemaVersion, parentVersionId, createdAt } = row;
  if (!isId(id) || !isHash(laneKey) || !isStoredUrl(pageUrl) || !isJsonOrNull(renderProfile, MAX_PROFILE_JSON_BYTES) || !isJsonOrNull(searchParams, MAX_SEARCH_PARAMS_JSON_BYTES)) return null;
  if (!isHash(snapshotHash) || !isCount(snapshotBytes, 1) || !isCount(schemaVersion, 1) || !(parentVersionId === null || isId(parentVersionId)) || !isTime(createdAt)) return null;
  return { id, laneKey, pageUrl, renderProfileJson: renderProfile, searchParamsJson: searchParams, snapshotHash, snapshotBytes, schemaVersion, parentVersionId, createdAt };
}

const diffColumns = {
  id: ciDiffs.id,
  laneKey: capped(ciDiffs.laneKey, 64),
  fromVersionId: capped(ciDiffs.fromVersionId, 36),
  toVersionId: capped(ciDiffs.toVersionId, 36),
  engineVersion: ciDiffs.engineVersion,
  summary: capped(ciDiffs.summary, MAX_DIFF_SUMMARY_JSON_BYTES),
  changeCount: ciDiffs.changeCount,
  createdAt: ciDiffs.createdAt,
};
type DiffRow = { [K in keyof typeof diffColumns]: unknown };

function diffSummaryOf(row: DiffRow): (DiffSummary & { laneKey: string; toVersionId: string; createdAt: number }) | null {
  const { id, laneKey, fromVersionId, toVersionId, engineVersion, summary, changeCount, createdAt } = row;
  if (!isId(id) || !isHash(laneKey) || !isId(fromVersionId) || !isId(toVersionId) || !isCount(engineVersion, 1) || !isJson(summary, MAX_DIFF_SUMMARY_JSON_BYTES) || !isCount(changeCount) || !isTime(createdAt)) return null;
  return { id, laneKey, fromVersionId, toVersionId, engineVersion, summaryJson: summary, changeCount, createdAt };
}

const screenshotColumns = {
  id: ciScreenshots.id,
  projectId: capped(ciScreenshots.projectId, 36),
  pageUrl: capped(ciScreenshots.pageUrl, MAX_STORED_URL_LENGTH),
  captureId: capped(ciScreenshots.captureId, 36),
  kind: capped(ciScreenshots.kind, 16),
  rect: capped(ciScreenshots.rect, MAX_RECT_JSON_BYTES),
  width: ciScreenshots.width,
  height: ciScreenshots.height,
  bytes: ciScreenshots.bytes,
  sha256: capped(ciScreenshots.sha256, 64),
  segments: ciScreenshots.segments,
  renderProfile: capped(ciScreenshots.renderProfile, MAX_PROFILE_JSON_BYTES),
  searchParams: capped(ciScreenshots.searchParams, MAX_SEARCH_PARAMS_JSON_BYTES),
  createdAt: ciScreenshots.createdAt,
};
type ScreenshotRow = { [K in keyof typeof screenshotColumns]: unknown };

/** A valid screenshot (input or row): an `area` has its rect, the other kinds none. */
function screenshotOf(row: Omit<ScreenshotRow, 'rect' | 'renderProfile' | 'searchParams'> & { rectJson: unknown; renderProfileJson: unknown; searchParamsJson: unknown }): StoredScreenshot | null {
  const { id, projectId, pageUrl, captureId, kind, rectJson, width, height, bytes, sha256, segments, renderProfileJson, searchParamsJson, createdAt } = row;
  if (!isId(id) || !isId(projectId) || !isStoredUrl(pageUrl) || !(captureId === null || isId(captureId)) || !isOneOf(SCREENSHOT_KINDS, kind)) return null;
  if (!(kind === 'area' ? isJson(rectJson, MAX_RECT_JSON_BYTES) : rectJson === null) || !isCount(width, 1) || !isCount(height, 1) || !isCount(bytes, 1) || !isHash(sha256) || !isCount(segments, 1)) return null;
  if (!isJsonOrNull(renderProfileJson, MAX_PROFILE_JSON_BYTES) || !isJsonOrNull(searchParamsJson, MAX_SEARCH_PARAMS_JSON_BYTES) || !isTime(createdAt)) return null;
  return { id, projectId, pageUrl, captureId, kind, rectJson: rectJson as string | null, width, height, bytes, sha256, segments, renderProfileJson, searchParamsJson, createdAt };
}
const screenshotOfRow = ({ rect, renderProfile, searchParams, ...row }: ScreenshotRow) => screenshotOf({ ...row, rectJson: rect, renderProfileJson: renderProfile, searchParamsJson: searchParams });

const projectColumns = {
  id: ciProjects.id,
  name: capped(ciProjects.name, PROJECT_NAME_MAX_CHARS),
  renderProfile: capped(ciProjects.renderProfile, MAX_PROFILE_JSON_BYTES),
  retentionMode: capped(ciProjects.retentionMode, 16),
  retentionValue: ciProjects.retentionValue,
  createdAt: ciProjects.createdAt,
  updatedAt: ciProjects.updatedAt,
};
type ProjectRow = { [K in keyof typeof projectColumns]: unknown };

function projectOf(row: ProjectRow): Project | null {
  const { id, name, renderProfile, retentionMode, retentionValue, createdAt, updatedAt } = row;
  if (!isId(id) || trimmedText(name, PROJECT_NAME_MAX_CHARS) !== name || !isJsonOrNull(renderProfile, MAX_PROFILE_JSON_BYTES) || !isRetention(retentionMode, retentionValue)) return null;
  if (!isTime(createdAt) || !isTime(updatedAt)) return null;
  return { id, name: name as string, renderProfileJson: renderProfile, retention: { mode: retentionMode, value: retentionValue as number | null }, createdAt, updatedAt };
}

const pageColumns = { id: ciProjectPages.id, projectId: ciProjectPages.projectId, url: capped(ciProjectPages.url, MAX_STORED_URL_LENGTH), createdAt: ciProjectPages.createdAt, updatedAt: ciProjectPages.updatedAt };
function pageOf(row: { [K in keyof typeof pageColumns]: unknown }): ProjectPage | null {
  const { id, projectId, url, createdAt, updatedAt } = row;
  return isId(id) && isId(projectId) && isStoredUrl(url) && isTime(createdAt) && isTime(updatedAt) ? { id, projectId, url, createdAt, updatedAt } : null;
}

const queryColumns = {
  id: ciProjectQueries.id,
  projectId: ciProjectQueries.projectId,
  query: capped(ciProjectQueries.query, PROJECT_QUERY_MAX_CHARS),
  searchParams: capped(ciProjectQueries.searchParams, MAX_SEARCH_PARAMS_JSON_BYTES),
  createdAt: ciProjectQueries.createdAt,
  updatedAt: ciProjectQueries.updatedAt,
};
function queryOf(row: { [K in keyof typeof queryColumns]: unknown }): ProjectQuery | null {
  const { id, projectId, query, searchParams, createdAt, updatedAt } = row;
  if (!isId(id) || !isId(projectId) || trimmedText(query, PROJECT_QUERY_MAX_CHARS) !== query || !isJson(searchParams, MAX_SEARCH_PARAMS_JSON_BYTES) || !isTime(createdAt) || !isTime(updatedAt)) return null;
  return { id, projectId, query: query as string, searchParamsJson: searchParams, createdAt, updatedAt };
}

const present = <T>(value: T | null): value is T => value !== null;
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const batch = (db: SessionDatabase, items: BatchItem<'sqlite'>[]) => db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

// ---- The repository ----------------------------------------------------------------------------

export function createChangeIntelRepository(db: SessionDatabase): ChangeIntelRepository {
  /** Whether `id` is already a row of `table`, or was one (a tombstone names it). */
  const idTaken = async (table: typeof ciVersions | typeof ciCaptures | typeof ciDiffs | typeof ciScreenshots, tableName: CapturedTable, id: string): Promise<boolean> => {
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
    if (row) return true;
    const [tombstone] = await db.select({ id: ciTombstones.id }).from(ciTombstones).where(and(eq(ciTombstones.tableName, tableName), eq(ciTombstones.rowId, id))).limit(1);
    return tombstone !== undefined;
  };
  const isLiveProject = async (id: string): Promise<boolean> => (await db.select({ id: ciProjects.id }).from(ciProjects).where(and(eq(ciProjects.id, id), isNull(ciProjects.deletedAt))).limit(1)).length > 0;
  const captureExists = async (id: string): Promise<boolean> => (await db.select({ id: ciCaptures.id }).from(ciCaptures).where(eq(ciCaptures.id, id)).limit(1)).length > 0;

  const liveProjects = (where: SQL | undefined) =>
    db
      .select(projectColumns)
      .from(ciProjects)
      .where(and(isNull(ciProjects.deletedAt), where))
      .orderBy(desc(sql`${ciProjects.id} = ${UNFILED_PROJECT_ID}`), asc(ciProjects.createdAt), asc(ciProjects.id))
      .limit(MAX_PROJECTS);

  /** Updates a live project's fields (and `updated_at`); `false` when there is no such live project. */
  const updateProject = async (id: string, set: Partial<typeof ciProjects.$inferInsert>, now: number): Promise<boolean> => {
    const rows = await db
      .update(ciProjects)
      .set({ ...set, updatedAt: now })
      .where(and(eq(ciProjects.id, id), isNull(ciProjects.deletedAt)))
      .returning({ id: ciProjects.id });
    return rows.length > 0;
  };

  function validCapture(input: AppendCaptureInput): { pageUrl: string } | null {
    if (typeof input !== 'object' || input === null) return null;
    const { captureId, versionId, projectId, laneKey, renderProfileJson, renderProfilePartial, searchParamsJson, source, auditTakenAt, snapshotJson, snapshotHash, schemaVersion, createdAt, diff } = input;
    const pageUrl = pageKey(input.pageUrl);
    if (pageUrl === null || !isId(captureId) || !isId(versionId) || captureId === versionId || !isId(projectId) || !isHash(laneKey) || !isHash(snapshotHash)) return null;
    if (!isJsonOrNull(renderProfileJson, MAX_PROFILE_JSON_BYTES) || typeof renderProfilePartial !== 'boolean' || !isJsonOrNull(searchParamsJson, MAX_SEARCH_PARAMS_JSON_BYTES) || !isOneOf(CAPTURE_SOURCES, source)) return null;
    if (!isTime(auditTakenAt) || !isTime(createdAt) || !isJson(snapshotJson, MAX_SNAPSHOT_JSON_BYTES) || !isCount(schemaVersion, 1)) return null;
    if (diff !== undefined) {
      if (typeof diff !== 'object' || diff === null || !isId(diff.id) || !isId(diff.fromVersionId) || !isCount(diff.engineVersion, 1) || !isCount(diff.changeCount)) return null;
      if (!isJson(diff.diffJson, MAX_DIFF_JSON_BYTES) || !isJson(diff.summaryJson, MAX_DIFF_SUMMARY_JSON_BYTES)) return null;
    }
    return { pageUrl };
  }

  const repository: Omit<ChangeIntelRepository, keyof PurgeOperations> = {
    async appendCapture(input) {
      const valid = validCapture(input);
      if (valid === null) return null;
      const { captureId, versionId, projectId, laneKey, snapshotHash, createdAt, diff } = input;
      if (!(await isLiveProject(projectId)) || (await idTaken(ciCaptures, 'ci_captures', captureId)) || (await idTaken(ciVersions, 'ci_versions', versionId))) return null;
      if (diff && (await idTaken(ciDiffs, 'ci_diffs', diff.id))) return null;
      const [head] = await db.select(versionColumns).from(ciVersions).where(laneHeads(laneKey)).orderBy(desc(ciVersions.createdAt), desc(ciVersions.id)).limit(1);
      // `laneHeads` vouches for these three; the rest of the row is checked as `latestVersion` checks it.
      const latest = head ? { id: head.id as string, snapshotHash: head.snapshotHash as string, createdAt: head.createdAt as number, readable: versionOf(head) !== null } : null;
      const captureRow = (id: string) => ({
        id: captureId,
        projectId,
        versionId: id,
        laneKey,
        pageUrl: valid.pageUrl,
        renderProfile: input.renderProfileJson,
        renderProfilePartial: input.renderProfilePartial ? 1 : 0,
        searchParams: input.searchParamsJson,
        source: input.source,
        auditTakenAt: input.auditTakenAt,
        createdAt,
      });
      // Each insert is conditional on what was read above still holding inside the transaction,
      // so a capture racing another into the lane is refused (`stale`), never written against an
      // older parent. Whether the capture went in says which.
      const appended = async (items: BatchItem<'sqlite'>[], result: AppendCaptureResult): Promise<AppendCaptureResult> => {
        await batch(db, items);
        return (await captureExists(captureId)) ? result : { status: 'stale' };
      };

      if (latest && latest.snapshotHash === snapshotHash) {
        const unchanged = sql`${liveProject(projectId)} AND ${latestIdOf(laneKey)} = ${latest.id}`;
        return appended([insertWhere(db, ciCaptures, captureRow(latest.id), unchanged)], { status: 'appended', captureId, versionId: latest.id, newVersion: false });
      }
      // A new version: with a parent main can read (`latestVersion` answers it) it needs the diff from
      // that parent; with none, or one whose row is tampered (main saw `null`), no diff.
      if (latest?.readable ? diff?.fromVersionId !== latest.id : diff !== undefined) return { status: 'stale' };
      const parentId = latest?.id ?? null;
      // Strictly after its parent by (created_at, id), so the new version is the lane's latest; a
      // clock gone back, or an equal time with a lower id, takes the parent's time plus one.
      const afterParent = !latest || createdAt > latest.createdAt || (createdAt === latest.createdAt && versionId > latest.id);
      const versionAt = afterParent ? createdAt : latest.createdAt + 1;
      const version = {
        id: versionId,
        laneKey,
        pageUrl: valid.pageUrl,
        renderProfile: input.renderProfileJson,
        searchParams: input.searchParamsJson,
        snapshot: input.snapshotJson,
        snapshotHash,
        snapshotBytes: utf8Bytes(input.snapshotJson),
        schemaVersion: input.schemaVersion,
        parentVersionId: parentId,
        createdAt: versionAt,
      };
      const inserted = sql`EXISTS (SELECT 1 FROM ci_versions WHERE id = ${versionId} AND lane_key = ${laneKey} AND snapshot_hash = ${snapshotHash})`;
      const items = [insertWhere(db, ciVersions, version, sql`${liveProject(projectId)} AND ${latestIdOf(laneKey)} IS ${parentId}`), insertWhere(db, ciCaptures, captureRow(versionId), inserted)];
      if (diff && parentId !== null) {
        const row = { id: diff.id, laneKey, fromVersionId: parentId, toVersionId: versionId, engineVersion: diff.engineVersion, diff: diff.diffJson, summary: diff.summaryJson, changeCount: diff.changeCount, createdAt: versionAt };
        items.push(insertWhere(db, ciDiffs, row, inserted));
      }
      return appended(items, { status: 'appended', captureId, versionId, newVersion: true });
    },

    async appendScreenshot(input) {
      if (typeof input !== 'object' || input === null) return false;
      const pageUrl = pageKey(input.pageUrl);
      const shot = pageUrl === null ? null : screenshotOf({ ...input, pageUrl });
      if (shot === null || (await idTaken(ciScreenshots, 'ci_screenshots', shot.id))) return false;
      const { rectJson, renderProfileJson, searchParamsJson, ...rest } = shot;
      // The project's liveness and the capture's existence are checked in the insert itself.
      const capture = shot.captureId === null ? sql`1` : sql`EXISTS (SELECT 1 FROM ci_captures WHERE id = ${shot.captureId})`;
      const row = { ...rest, rect: rectJson, renderProfile: renderProfileJson, searchParams: searchParamsJson };
      await batch(db, [insertWhere(db, ciScreenshots, row, sql`${liveProject(shot.projectId)} AND ${capture}`)]);
      return (await db.select({ id: ciScreenshots.id }).from(ciScreenshots).where(eq(ciScreenshots.id, shot.id)).limit(1)).length > 0;
    },

    async latestVersion(laneKey) {
      if (!isHash(laneKey)) return null;
      const [row] = await db.select(versionColumns).from(ciVersions).where(laneHeads(laneKey)).orderBy(desc(ciVersions.createdAt), desc(ciVersions.id)).limit(1);
      return row ? versionOf(row) : null;
    },

    async version(id) {
      if (!isId(id)) return null;
      const [row] = await db
        .select({ ...versionColumns, snapshot: capped(ciVersions.snapshot, MAX_SNAPSHOT_JSON_BYTES) })
        .from(ciVersions)
        .where(eq(ciVersions.id, id))
        .limit(1);
      const version = row ? versionOf(row) : null;
      return version && row && isJson(row.snapshot, MAX_SNAPSHOT_JSON_BYTES) ? { ...version, snapshotJson: row.snapshot } : null;
    },

    async history({ pageUrl, projectId, cursor, limit }) {
      const key = pageKey(pageUrl);
      if (key === null || (projectId !== undefined && !isId(projectId)) || (cursor != null && !isCursor(cursor))) return { entries: [], next: null };
      const size = pageSize(limit);
      const inProject = projectId === undefined ? sql`` : sql` AND c.project_id = ${projectId}`;
      // Correlated subqueries name the outer column in full (`ci_versions.id`): Drizzle renders a
      // column in a select list unqualified, which inside the subquery would mean `c.id`.
      const found = await db
        .select({
          ...versionColumns,
          captureCount: sql<unknown>`(SELECT count(*) FROM ci_captures c WHERE c.version_id = ci_versions.id${inProject})`,
          lastCapturedAt: sql<unknown>`(SELECT max(c.created_at) FROM ci_captures c WHERE c.version_id = ci_versions.id${inProject})`,
        })
        .from(ciVersions)
        .where(
          and(
            eq(ciVersions.pageUrl, key),
            projectId === undefined ? undefined : sql`EXISTS (SELECT 1 FROM ci_captures c WHERE c.version_id = ci_versions.id AND c.project_id = ${projectId})`,
            cursor ? olderThan(ciVersions.createdAt, ciVersions.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(ciVersions.createdAt), desc(ciVersions.id))
        .limit(size + 1);
      const page = found.slice(0, size);
      const versions = page.flatMap((row) => {
        const version = versionOf(row);
        return version && isCount(row.captureCount) && (row.lastCapturedAt === null || isTime(row.lastCapturedAt)) ? [{ ...version, captureCount: row.captureCount, lastCapturedAt: row.lastCapturedAt }] : [];
      });
      const diffs = versions.length === 0 ? [] : await db.select(diffColumns).from(ciDiffs).where(inArray(ciDiffs.toVersionId, versions.map((v) => v.id)));
      const diffOf = new Map<string, DiffSummary>();
      for (const summary of diffs.map(diffSummaryOf).filter(present)) {
        const { id, fromVersionId, engineVersion, summaryJson, changeCount } = summary;
        diffOf.set(`${fromVersionId} ${summary.toVersionId}`, { id, fromVersionId, engineVersion, summaryJson, changeCount });
      }
      const entries = versions.map((version) => ({ ...version, diff: version.parentVersionId === null ? null : (diffOf.get(`${version.parentVersionId} ${version.id}`) ?? null) }));
      return { entries, next: nextCursor(found, size) };
    },

    async diffFor(fromVersionId, toVersionId) {
      if (!isId(fromVersionId) || !isId(toVersionId)) return null;
      const [row] = await db
        .select({ ...diffColumns, diff: capped(ciDiffs.diff, MAX_DIFF_JSON_BYTES) })
        .from(ciDiffs)
        .where(and(eq(ciDiffs.fromVersionId, fromVersionId), eq(ciDiffs.toVersionId, toVersionId)))
        .orderBy(desc(ciDiffs.createdAt), desc(ciDiffs.id))
        .limit(1);
      const summary = row ? diffSummaryOf(row) : null;
      if (!summary || !row || !isJson(row.diff, MAX_DIFF_JSON_BYTES)) return null;
      const { id, laneKey, engineVersion, summaryJson, changeCount, createdAt } = summary;
      return { id, laneKey, fromVersionId, toVersionId, engineVersion, diffJson: row.diff, summaryJson, changeCount, createdAt };
    },

    async screenshots({ pageUrl, projectId, cursor, limit }) {
      const key = pageUrl === undefined ? undefined : pageKey(pageUrl);
      if (key === null || (projectId !== undefined && !isId(projectId)) || (cursor != null && !isCursor(cursor))) return { screenshots: [], next: null };
      const size = pageSize(limit);
      const found = await db
        .select(screenshotColumns)
        .from(ciScreenshots)
        .where(
          and(
            key === undefined ? undefined : eq(ciScreenshots.pageUrl, key),
            projectId === undefined ? undefined : eq(ciScreenshots.projectId, projectId),
            cursor ? olderThan(ciScreenshots.createdAt, ciScreenshots.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(ciScreenshots.createdAt), desc(ciScreenshots.id))
        .limit(size + 1);
      return { screenshots: found.slice(0, size).map(screenshotOfRow).filter(present), next: nextCursor(found, size) };
    },

    async screenshot(id) {
      if (!isId(id)) return null;
      const [row] = await db.select(screenshotColumns).from(ciScreenshots).where(eq(ciScreenshots.id, id)).limit(1);
      return row ? screenshotOfRow(row) : null;
    },

    async pages({ projectId, limit }) {
      if (projectId !== undefined && !isId(projectId)) return [];
      const last = sql<unknown>`max(${ciCaptures.createdAt})`;
      const rows = await db
        .select({ pageUrl: capped(ciCaptures.pageUrl, MAX_STORED_URL_LENGTH), captureCount: count(), lastCapturedAt: last })
        .from(ciCaptures)
        .where(projectId === undefined ? undefined : eq(ciCaptures.projectId, projectId))
        .groupBy(ciCaptures.pageUrl)
        .orderBy(desc(last), asc(ciCaptures.pageUrl))
        .limit(pageSize(limit));
      return rows.flatMap(({ pageUrl, captureCount, lastCapturedAt }) => (isStoredUrl(pageUrl) && isCount(captureCount, 1) && isTime(lastCapturedAt) ? [{ pageUrl, captureCount, lastCapturedAt }] : []));
    },

    async isHashReferenced(sha256) {
      if (!isHash(sha256)) return false;
      return (await db.select({ id: ciScreenshots.id }).from(ciScreenshots).where(eq(ciScreenshots.sha256, sha256)).limit(1)).length > 0;
    },

    async screenshotHashes(filter) {
      const projectId = filter?.projectId;
      if (projectId !== undefined && !isId(projectId)) return [];
      const rows = await db
        .selectDistinct({ sha256: capped(ciScreenshots.sha256, 64) })
        .from(ciScreenshots)
        .where(projectId === undefined ? undefined : eq(ciScreenshots.projectId, projectId));
      return rows.map((row) => row.sha256).filter(isHash);
    },

    // ---- Projects ----

    async createProject(name, now) {
      const value = trimmedText(name, PROJECT_NAME_MAX_CHARS);
      if (value === null || !isTime(now)) return null;
      const id = uuidv7(now);
      const row = { id, name: value, renderProfile: null, retentionMode: 'forever', retentionValue: null, createdAt: now, updatedAt: now, deletedAt: null };
      await batch(db, [insertWhere(db, ciProjects, row, sql`(SELECT count(*) FROM ci_projects WHERE deleted_at IS NULL) < ${MAX_PROJECTS}`)]);
      return repository.project(id);
    },

    async renameProject(id, name, now) {
      const value = trimmedText(name, PROJECT_NAME_MAX_CHARS);
      // Unfiled is named the same on every device.
      if (value === null || !isId(id) || id === UNFILED_PROJECT_ID || !isTime(now)) return false;
      return updateProject(id, { name: value }, now);
    },

    async setProjectRenderProfile(id, renderProfileJson, now) {
      if (!isId(id) || !isJsonOrNull(renderProfileJson, MAX_PROFILE_JSON_BYTES) || !isTime(now)) return false;
      return updateProject(id, { renderProfile: renderProfileJson }, now);
    },

    async setRetention(id, mode, value, now) {
      if (!isId(id) || !isRetention(mode, value) || !isTime(now)) return false;
      return updateProject(id, { retentionMode: mode, retentionValue: value }, now);
    },

    async tombstoneProject(id, now) {
      if (!isId(id) || id === UNFILED_PROJECT_ID || !isTime(now)) return false;
      const gone = { deletedAt: now, updatedAt: now };
      // The pages and queries go with the project, in the same transaction, only if it went just now.
      const wentNow = sql`EXISTS (SELECT 1 FROM ci_projects WHERE id = ${id} AND deleted_at = ${now})`;
      const [project] = await db.batch([
        db
          .update(ciProjects)
          .set(gone)
          .where(and(eq(ciProjects.id, id), isNull(ciProjects.deletedAt)))
          .returning({ id: ciProjects.id }),
        db
          .update(ciProjectPages)
          .set(gone)
          .where(and(eq(ciProjectPages.projectId, id), isNull(ciProjectPages.deletedAt), wentNow)),
        db
          .update(ciProjectQueries)
          .set(gone)
          .where(and(eq(ciProjectQueries.projectId, id), isNull(ciProjectQueries.deletedAt), wentNow)),
      ]);
      return project.length > 0;
    },

    async projects() {
      return (await liveProjects(undefined)).map(projectOf).filter(present);
    },

    async deletedProjectsWithRows() {
      const rows = await db
        .select({ id: ciProjects.id })
        .from(ciProjects)
        .where(
          and(
            sql`${ciProjects.deletedAt} IS NOT NULL`,
            sql`(EXISTS (SELECT 1 FROM ci_captures c WHERE c.project_id = ${ciProjects.id}) OR EXISTS (SELECT 1 FROM ci_screenshots s WHERE s.project_id = ${ciProjects.id}))`,
          ),
        )
        .orderBy(asc(ciProjects.deletedAt), asc(ciProjects.id))
        .limit(MAX_PROJECTS);
      return rows.map((row) => row.id).filter(isId);
    },

    async project(id) {
      if (!isId(id)) return null;
      const [row] = await liveProjects(eq(ciProjects.id, id));
      return row ? projectOf(row) : null;
    },

    // ---- Pages and queries ----

    async addPage(projectId, url, now) {
      const key = pageKey(url);
      if (key === null || !isId(projectId) || !isTime(now)) return null;
      const live = and(eq(ciProjectPages.projectId, projectId), eq(ciProjectPages.url, key), isNull(ciProjectPages.deletedAt));
      const [existing] = await db.select(pageColumns).from(ciProjectPages).where(live).limit(1);
      if (existing) return pageOf(existing);
      const row = { id: uuidv7(now), projectId, url: key, createdAt: now, updatedAt: now, deletedAt: null };
      const room = sql`(SELECT count(*) FROM ci_project_pages WHERE project_id = ${projectId} AND deleted_at IS NULL) < ${MAX_PROJECT_PAGES}`;
      await batch(db, [insertWhere(db, ciProjectPages, row, sql`${liveProject(projectId)} AND ${room}`)]);
      const [added] = await db.select(pageColumns).from(ciProjectPages).where(eq(ciProjectPages.id, row.id)).limit(1);
      return added ? pageOf(added) : null;
    },

    async removePage(projectId, pageId, now) {
      if (!isId(projectId) || !isId(pageId) || !isTime(now)) return false;
      const rows = await db
        .update(ciProjectPages)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(ciProjectPages.id, pageId), eq(ciProjectPages.projectId, projectId), isNull(ciProjectPages.deletedAt)))
        .returning({ id: ciProjectPages.id });
      return rows.length > 0;
    },

    async projectPages(projectId) {
      if (!isId(projectId)) return [];
      const rows = await db
        .select(pageColumns)
        .from(ciProjectPages)
        .where(and(eq(ciProjectPages.projectId, projectId), isNull(ciProjectPages.deletedAt)))
        .orderBy(asc(ciProjectPages.createdAt), asc(ciProjectPages.id))
        .limit(MAX_PROJECT_PAGES);
      return rows.map(pageOf).filter(present);
    },

    async projectsForPage(url) {
      const key = pageKey(url);
      if (key === null) return [];
      const rows = await liveProjects(sql`${ciProjects.id} IN (SELECT project_id FROM ci_project_pages WHERE url = ${key} AND deleted_at IS NULL)`);
      return rows.map(projectOf).filter(present);
    },

    async addQuery(projectId, query, searchParamsJson, now) {
      const text = trimmedText(query, PROJECT_QUERY_MAX_CHARS);
      if (text === null || !isId(projectId) || !isJson(searchParamsJson, MAX_SEARCH_PARAMS_JSON_BYTES) || !isTime(now)) return null;
      const live = and(eq(ciProjectQueries.projectId, projectId), eq(ciProjectQueries.query, text), eq(ciProjectQueries.searchParams, searchParamsJson), isNull(ciProjectQueries.deletedAt));
      const [existing] = await db.select(queryColumns).from(ciProjectQueries).where(live).limit(1);
      if (existing) return queryOf(existing);
      const row = { id: uuidv7(now), projectId, query: text, searchParams: searchParamsJson, createdAt: now, updatedAt: now, deletedAt: null };
      const room = sql`(SELECT count(*) FROM ci_project_queries WHERE project_id = ${projectId} AND deleted_at IS NULL) < ${MAX_PROJECT_QUERIES}`;
      await batch(db, [insertWhere(db, ciProjectQueries, row, sql`${liveProject(projectId)} AND ${room}`)]);
      const [added] = await db.select(queryColumns).from(ciProjectQueries).where(eq(ciProjectQueries.id, row.id)).limit(1);
      return added ? queryOf(added) : null;
    },

    async removeQuery(projectId, queryId, now) {
      if (!isId(projectId) || !isId(queryId) || !isTime(now)) return false;
      const rows = await db
        .update(ciProjectQueries)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(ciProjectQueries.id, queryId), eq(ciProjectQueries.projectId, projectId), isNull(ciProjectQueries.deletedAt)))
        .returning({ id: ciProjectQueries.id });
      return rows.length > 0;
    },

    async projectQueries(projectId) {
      if (!isId(projectId)) return [];
      const rows = await db
        .select(queryColumns)
        .from(ciProjectQueries)
        .where(and(eq(ciProjectQueries.projectId, projectId), isNull(ciProjectQueries.deletedAt)))
        .orderBy(asc(ciProjectQueries.createdAt), asc(ciProjectQueries.id))
        .limit(MAX_PROJECT_QUERIES);
      return rows.map(queryOf).filter(present);
    },

    // ---- Usage ----

    async usage(projectId) {
      if (projectId !== undefined && !isId(projectId)) return null;
      const inProject = (column: SQL | typeof ciVersions.id) => sql`${column} IN (SELECT version_id FROM ci_captures WHERE project_id = ${projectId})`;
      const shared =
        projectId === undefined
          ? sql`(SELECT count(DISTINCT c.project_id) FROM ci_captures c WHERE c.version_id = ci_versions.id) > 1`
          : sql`EXISTS (SELECT 1 FROM ci_captures c WHERE c.version_id = ci_versions.id AND c.project_id <> ${projectId})`;
      const perHash = db
        .select({ bytes: sql<unknown>`max(${ciScreenshots.bytes})`.as('bytes') })
        .from(ciScreenshots)
        .where(projectId === undefined ? undefined : eq(ciScreenshots.projectId, projectId))
        .groupBy(ciScreenshots.sha256)
        .as('per_hash');
      const [captures, versions, diffs, screenshots, files, sharedFiles] = await db.batch([
        db
          .select({ n: count() })
          .from(ciCaptures)
          .where(projectId === undefined ? undefined : eq(ciCaptures.projectId, projectId)),
        db
          .select({
            n: count(),
            shared: sql<unknown>`coalesce(sum(CASE WHEN ${shared} THEN 1 ELSE 0 END), 0)`,
            bytes: sql<unknown>`coalesce(sum(length(CAST(${ciVersions.snapshot} AS BLOB))), 0)`,
          })
          .from(ciVersions)
          .where(projectId === undefined ? undefined : inProject(ciVersions.id)),
        db
          .select({ bytes: sql<unknown>`coalesce(sum(length(CAST(${ciDiffs.diff} AS BLOB))), 0)` })
          .from(ciDiffs)
          .where(projectId === undefined ? undefined : inProject(sql`${ciDiffs.toVersionId}`)),
        db
          .select({ n: count() })
          .from(ciScreenshots)
          .where(projectId === undefined ? undefined : eq(ciScreenshots.projectId, projectId)),
        db.select({ bytes: sql<unknown>`coalesce(sum(${perHash.bytes}), 0)` }).from(perHash),
        db
          .select({ n: sql<unknown>`count(DISTINCT ${ciScreenshots.sha256})` })
          .from(ciScreenshots)
          .where(
            projectId === undefined
              ? sql`(SELECT count(DISTINCT o.project_id) FROM ci_screenshots o WHERE o.sha256 = ${ciScreenshots.sha256}) > 1`
              : sql`${ciScreenshots.projectId} = ${projectId} AND EXISTS (SELECT 1 FROM ci_screenshots o WHERE o.sha256 = ${ciScreenshots.sha256} AND o.project_id <> ${projectId})`,
          ),
      ]);
      return {
        captures: num(captures[0]?.n),
        versions: num(versions[0]?.n),
        sharedVersions: num(versions[0]?.shared),
        snapshotBytes: num(versions[0]?.bytes),
        diffBytes: num(diffs[0]?.bytes),
        screenshots: num(screenshots[0]?.n),
        screenshotBytes: num(files[0]?.bytes),
        sharedScreenshotFiles: num(sharedFiles[0]?.n),
      };
    },

    async compact() {
      // Plain SQLite, outside any transaction (the store's batches are synchronous, so none is open).
      await db.run(sql`VACUUM`);
    },
  };

  return { ...repository, ...createPurgeOperations(db) };
}
