import { and, count, desc, eq, getTableColumns, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { PURGE_REASONS, type CapturedTable, type PurgeReason } from '@app/specs/capture-db.spec';
import type { SessionDatabase } from '../client';
import { capped, chunks, isCount, isId, isJsonOrNull, isOneOf, isRetention, isTime, pageSize } from './checks';
import { uuidv7 } from './ids';
import { ciCaptures, ciDiffs, ciProjects, ciPurges, ciScreenshots, ciTombstones, ciVersions, screenshotEdits } from './schema';
import { ciSerpApiPurges } from './serp-api-schema';
import { ciSerpReadings } from './workspace-schema';

// Retention's purges (spec `capture-db.feature.md`, Retention planning; the plan's "The purge path").
// `planPurge` is a dry run over one project; `executePurge` plans again and, if nothing moved,
// records the purge and its tombstones and deletes the rows in one transaction (the store's batch).
// A row of a captured table can be deleted only that way: its `_purge_only` trigger looks for the
// tombstone and the purge written just before it in the same transaction. Those triggers bind the app
// and any SQL that respects the schema; whoever can write the database file can also `DROP TRIGGER`,
// which no trigger can prevent.
//
// Phase 10 (`workspace-db.feature.md`, Purge): a capture's SERP reading lives as long as the capture.
// The purge deletes the purged captures' readings in the same batch, after `ci_captures` (the readings'
// delete guard, `ci_serp_readings_delete_guard` since Phase 12's `0245`, needs the capture gone first),
// and `bytes` counts their stored bytes. The readings are not in `CAPTURED_TABLES`, so they get no
// tombstone, and `ci_purges` keeps its columns.
//
// After a purge, main unlinks the files of the answer's `plan.unreferencedHashes` (the plan executed,
// planned again here), checking `isHashReferenced` once more before each unlink.
//
// Phase 12 Task 4 (`workspace-db.feature.md`, API readings (Phase 12)): a project's SERP API readings
// (`source = 'serp-api'`, no capture) follow its policy per search key. The plan carries their ids
// (`apiReadingIds`) and counts them (`counts.readings`, only when there is one); the stale and
// emptiness checks see them (so a project with only API readings is purged like any other); the
// purge records each id in `ci_serp_api_purges` (with the purge's id, reason and project) and then
// deletes the reading, in the same transaction. `ci_purges` keeps its columns: `readings` is never
// written there, and a purge of API readings only writes no `ci_purges` row at all (its log is
// `ci_serp_api_purges`, device-local; the purge log view lists `ci_purges` only).
//
// Phase 11 Task 7: deleting a `ci_screenshots` row here also removes the local `screenshot_edits`
// link of that row as an edited copy, in the same transaction, through migration `0231`'s
// `screenshot_edits_follow_screenshots` trigger; so does a synced tombstone's delete. A link naming
// the row as its source stays (council round 1), so the copy keeps its lane below.

/** What to purge: a project's retention policy, or `all` (internal: the `project-deleted` purge). */
export type PurgePolicy = { readonly mode: 'forever' } | { readonly mode: 'versions' | 'days'; readonly value: number } | { readonly mode: 'all' };

export interface PurgeCounts {
  readonly captures: number;
  readonly versions: number;
  readonly diffs: number;
  readonly screenshots: number;
  /** Phase 12 Task 4: the plan's SERP API readings; present only when there is at least one (never in `ci_purges`). */
  readonly readings?: number;
}

/** A dry run: the rows a purge would delete (sorted ids), and what it would free. */
export interface PurgePlan {
  readonly projectId: string;
  readonly policy: PurgePolicy;
  /** The time the plan was made for (`days` measures from it); `executePurge` plans again with it. */
  readonly now: number;
  readonly captureIds: readonly string[];
  readonly versionIds: readonly string[];
  readonly diffIds: readonly string[];
  readonly screenshotIds: readonly string[];
  /** Phase 12 Task 4: the project's `serp-api` readings the policy selects (sorted ids). */
  readonly apiReadingIds: readonly string[];
  /** Hashes of purged screenshots no remaining row has: the files main may unlink afterwards. */
  readonly unreferencedHashes: readonly string[];
  readonly counts: PurgeCounts;
  /**
   * Freed bytes as planned: purged snapshots and diffs and the purged captures' SERP readings (stored
   * UTF-8 bytes), plus each unreferenced file once by its row's `bytes`. This is the figure `ci_purges.bytes` records; main reports what
   * it really freed (the files it did unlink, measured) separately.
   */
  readonly bytes: number;
  /** Of `bytes`, the unreferenced files' (their rows' `bytes`). */
  readonly fileBytes: number;
}

export type ExecutePurgeResult = { readonly status: 'purged'; readonly purgeId: string; readonly plan: PurgePlan } | { readonly status: 'stale' } | { readonly status: 'empty' };

/** A `ci_purges` row: the purge log (its counts never have `readings`). */
export interface PurgeRecord {
  readonly id: string;
  readonly reason: PurgeReason;
  readonly projectId: string | null;
  readonly policyJson: string | null;
  readonly counts: Omit<PurgeCounts, 'readings'>;
  readonly bytes: number;
  readonly createdAt: number;
}

export interface PurgeOperations {
  /**
   * A dry run for `projectId`; `null` for an invalid policy, time or project. `all` is only for a
   * tombstoned project (its `project-deleted` purge); the retention policies for any project.
   */
  planPurge(input: { readonly projectId: string; readonly policy: PurgePolicy; readonly now: number }): Promise<PurgePlan | null>;
  /**
   * Plans again with `plan`'s inputs; deletes only if the id sets are unchanged. `null` for invalid
   * input, and for `project-deleted` with any policy but `all` (or `all` with another reason). A
   * failed transaction is rolled back: `stale` if planning again then gives other rows (a capture
   * raced in), else the error is thrown.
   */
  executePurge(plan: PurgePlan, reason: PurgeReason, now: number): Promise<ExecutePurgeResult | null>;
  /** The purge log, newest first, of one project or of all. */
  purges(filter: { readonly projectId?: string; readonly limit?: number }): Promise<PurgeRecord[]>;
}

const DAY_MS = 86_400_000;
const MAX_POLICY_JSON = 64;

/** `policy` with nothing but its own keys, or `null` if it is not a policy. */
function normalPolicy(policy: unknown): PurgePolicy | null {
  if (typeof policy !== 'object' || policy === null) return null;
  const { mode, value } = policy as { mode?: unknown; value?: unknown };
  if (mode === 'all' || mode === 'forever') return { mode };
  return (mode === 'versions' || mode === 'days') && isRetention(mode, value) ? { mode, value: value as number } : null;
}

/** The policy as stored in `ci_purges.policy`: canonical JSON (keys sorted, no white space). */
const policyJson = (policy: PurgePolicy): string => JSON.stringify('value' in policy ? { mode: policy.mode, value: policy.value } : { mode: policy.mode });

const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY);
/** Newest first by `(at, id)`. */
const newestFirst = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

interface CaptureRow {
  readonly id: string;
  readonly versionId: string;
  readonly laneKey: string;
  readonly at: number;
}

/** The project's captures the policy purges (`versions N`, `days N`, `all`; see the feature file). */
function purgedCaptures(rows: readonly CaptureRow[], policy: PurgePolicy, now: number): CaptureRow[] {
  if (policy.mode === 'forever') return [];
  if (policy.mode === 'all') return [...rows];
  // Per lane, versions ranked by their newest capture in this project.
  const kept = new Set<string>();
  const keep = policy.mode === 'versions' ? policy.value : 1;
  for (const lane of groupBy(rows, (row) => row.laneKey).values()) {
    const versions = [...groupBy(lane, (row) => row.versionId)].map(([id, captures]) => ({ id, at: captures.reduce((newest, c) => Math.max(newest, c.at), Number.NEGATIVE_INFINITY) }));
    for (const version of versions.sort(newestFirst).slice(0, keep)) kept.add(version.id);
  }
  if (policy.mode === 'versions') return rows.filter((row) => !kept.has(row.versionId));
  const cutoff = now - policy.value * DAY_MS;
  return rows.filter((row) => row.at < cutoff && !kept.has(row.versionId));
}

interface ScreenshotRow {
  readonly id: string;
  readonly group: string;
  readonly at: number;
  readonly sha256: unknown;
  readonly bytes: unknown;
}

/** The project's screenshots the policy purges: the same window per lane and kind (`group`). */
function purgedScreenshots(rows: readonly ScreenshotRow[], policy: PurgePolicy, now: number): ScreenshotRow[] {
  if (policy.mode === 'forever') return [];
  if (policy.mode === 'all') return [...rows];
  const purged: ScreenshotRow[] = [];
  const cutoff = now - policy.value * DAY_MS;
  for (const group of groupBy(rows, (row) => row.group).values()) {
    // Newest first; the newest always stays.
    group.sort(newestFirst).forEach((row, rank) => {
      if (policy.mode === 'versions' ? rank >= policy.value : rank > 0 && row.at < cutoff) purged.push(row);
    });
  }
  return purged;
}

interface ApiReadingRow {
  readonly id: string;
  readonly key: string;
  readonly at: number;
}

/**
 * The project's `serp-api` readings the policy purges, per search key (and key version): `forever`
 * none; `versions N` all but the N newest of each key; `days N` those observed before `now − N days`
 * except each key's newest; `all` every one.
 */
function purgedApiReadings<T extends ApiReadingRow>(rows: readonly T[], policy: PurgePolicy, now: number): T[] {
  if (policy.mode === 'forever') return [];
  if (policy.mode === 'all') return [...rows];
  const cutoff = now - (policy.mode === 'days' ? policy.value : 0) * DAY_MS;
  // Newest first per key; `days N` keeps each key's newest whatever its age (Phase 6's "the newest
  // always stays", lead ruling), `versions N` the N newest.
  return [...groupBy(rows, (row) => row.key).values()].flatMap((group) =>
    group.sort(newestFirst).filter((row, rank) => (policy.mode === 'versions' ? rank >= policy.value : rank > 0 && row.at < cutoff)),
  );
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
const sameIds = (a: readonly string[], b: unknown): boolean => Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
/** Whether `plan` would delete exactly the rows `fresh` does. */
const sameRows = (fresh: PurgePlan, plan: PurgePlan): boolean =>
  sameIds(fresh.captureIds, plan.captureIds) &&
  sameIds(fresh.versionIds, plan.versionIds) &&
  sameIds(fresh.diffIds, plan.diffIds) &&
  sameIds(fresh.screenshotIds, plan.screenshotIds) &&
  sameIds(fresh.apiReadingIds, plan.apiReadingIds);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function createPurgeOperations(db: SessionDatabase): PurgeOperations {
  /** Sums `expression` over the rows of `table` whose id is in `ids`, an `IN` list at a time. */
  const sumOver = async (table: typeof ciVersions | typeof ciDiffs, expression: SQL, ids: readonly string[]): Promise<number> => {
    let total = 0;
    for (const part of chunks(ids)) {
      const [row] = await db.select({ n: sql<unknown>`coalesce(sum(${expression}), 0)` }).from(table).where(inArray(table.id, part));
      total += num(row?.n);
    }
    return total;
  };

  /** Rows per key value among `values` (`SELECT key, count(*) … GROUP BY key`). */
  const countsBy = async (column: typeof ciCaptures.versionId | typeof ciScreenshots.sha256, table: typeof ciCaptures | typeof ciScreenshots, values: readonly string[]): Promise<Map<string, number>> => {
    const totals = new Map<string, number>();
    for (const part of chunks(values)) {
      const rows = await db.select({ key: column, n: count() }).from(table).where(inArray(column, part)).groupBy(column);
      for (const row of rows) totals.set(String(row.key), num(row.n));
    }
    return totals;
  };

  async function planPurge(input: { projectId: unknown; policy: unknown; now: unknown }): Promise<PurgePlan | null> {
    const policy = normalPolicy(input.policy);
    const { projectId, now } = input;
    if (policy === null || !isId(projectId) || !isTime(now)) return null;
    const [project] = await db.select({ deletedAt: ciProjects.deletedAt }).from(ciProjects).where(eq(ciProjects.id, projectId)).limit(1);
    // Everything of a project goes only once the project itself has gone.
    if (!project || (policy.mode === 'all' && project.deletedAt === null)) return null;

    const captureRows = (await db.select({ id: ciCaptures.id, versionId: ciCaptures.versionId, laneKey: ciCaptures.laneKey, at: ciCaptures.createdAt }).from(ciCaptures).where(eq(ciCaptures.projectId, projectId)))
      .filter((row) => typeof row.id === 'string' && typeof row.versionId === 'string')
      .map((row) => ({ id: row.id, versionId: row.versionId, laneKey: String(row.laneKey), at: time(row.at) }));
    const screenshotRows = (
      await db
        .select({
          id: ciScreenshots.id,
          pageUrl: ciScreenshots.pageUrl,
          kind: ciScreenshots.kind,
          renderProfile: ciScreenshots.renderProfile,
          searchParams: ciScreenshots.searchParams,
          at: ciScreenshots.createdAt,
          sha256: ciScreenshots.sha256,
          bytes: ciScreenshots.bytes,
          edited: screenshotEdits.screenshotId,
        })
        .from(ciScreenshots)
        .leftJoin(screenshotEdits, eq(screenshotEdits.screenshotId, ciScreenshots.id))
        .where(eq(ciScreenshots.projectId, projectId))
    )
      .filter((row) => typeof row.id === 'string')
      // A screenshot's lane is its page, render profile and search parameters: a phone's and a desktop's never compete.
      // Phase 11 Task 7 (security review): an edited copy (one `screenshot_edits` links) has a lane of
      // its own beside the captured ones, so saving an edit never pushes out its source or any taken
      // screenshot; copies are kept among copies. The link outlives its source, so a copy whose
      // source has gone stays in the copy lane.
      .map((row) => ({ id: row.id, group: JSON.stringify([row.pageUrl, row.kind, row.renderProfile, row.searchParams, row.edited !== null]), at: time(row.at), sha256: row.sha256, bytes: row.bytes }));

    const captures = purgedCaptures(captureRows, policy, now);
    const screenshots = purgedScreenshots(screenshotRows, policy, now);
    // Phase 12 Task 4: the project's API readings (a tampered row, with no well-formed id, is left alone).
    const apiRows = (
      await db
        .select({ id: ciSerpReadings.id, searchKey: ciSerpReadings.searchKey, searchKeyVersion: ciSerpReadings.searchKeyVersion, at: ciSerpReadings.observedAt, bytes: sql<unknown>`length(CAST(${ciSerpReadings.reading} AS BLOB))` })
        .from(ciSerpReadings)
        .where(and(eq(ciSerpReadings.projectId, projectId), eq(ciSerpReadings.source, 'serp-api')))
    )
      .filter((row) => isId(row.id))
      .map((row) => ({ id: row.id, key: JSON.stringify([String(row.searchKey), num(row.searchKeyVersion)]), at: time(row.at), bytes: num(row.bytes) }));
    const apiReadings = purgedApiReadings(apiRows, policy, now);

    // A version goes once every capture of it, in any project, goes (and only if the row is there).
    const purgedPerVersion = new Map<string, number>();
    for (const row of captures) purgedPerVersion.set(row.versionId, (purgedPerVersion.get(row.versionId) ?? 0) + 1);
    const totals = await countsBy(ciCaptures.versionId, ciCaptures, [...purgedPerVersion.keys()]);
    const orphaned = [...purgedPerVersion].filter(([id, n]) => (totals.get(id) ?? 0) <= n).map(([id]) => id);
    const versionIds: string[] = [];
    const diffIds: string[] = [];
    for (const part of chunks(orphaned)) {
      versionIds.push(...(await db.select({ id: ciVersions.id }).from(ciVersions).where(inArray(ciVersions.id, part))).map((row) => row.id));
      const diffs = await db.select({ id: ciDiffs.id }).from(ciDiffs).where(or(inArray(ciDiffs.fromVersionId, part), inArray(ciDiffs.toVersionId, part)));
      diffIds.push(...diffs.map((row) => row.id));
    }

    // A file is freed only when no remaining row has its hash; counted once.
    const purgedPerHash = new Map<string, { n: number; bytes: number }>();
    for (const row of screenshots) {
      if (typeof row.sha256 !== 'string') continue;
      const seen = purgedPerHash.get(row.sha256);
      purgedPerHash.set(row.sha256, { n: (seen?.n ?? 0) + 1, bytes: Math.max(seen?.bytes ?? 0, isCount(row.bytes) ? row.bytes : 0) });
    }
    const hashTotals = await countsBy(ciScreenshots.sha256, ciScreenshots, [...purgedPerHash.keys()]);
    const unreferenced = [...purgedPerHash].filter(([hash, { n }]) => (hashTotals.get(hash) ?? 0) <= n);

    const plan = {
      projectId,
      policy,
      now,
      captureIds: sorted(captures.map((row) => row.id)),
      versionIds: sorted(versionIds),
      diffIds: sorted(diffIds),
      screenshotIds: sorted(screenshots.map((row) => row.id)),
      apiReadingIds: sorted(apiReadings.map((row) => row.id)),
      unreferencedHashes: sorted(unreferenced.map(([hash]) => hash)),
    };
    const fileBytes = unreferenced.reduce((sum, [, { bytes }]) => sum + bytes, 0);
    let readingBytes = 0;
    for (const part of chunks(plan.captureIds)) {
      const [row] = await db
        .select({ n: sql<unknown>`coalesce(sum(length(CAST(${ciSerpReadings.reading} AS BLOB))), 0)` })
        .from(ciSerpReadings)
        .where(and(eq(ciSerpReadings.source, 'capture'), inArray(ciSerpReadings.captureId, part)));
      readingBytes += num(row?.n);
    }
    const bytes =
      (await sumOver(ciVersions, sql`length(CAST(${ciVersions.snapshot} AS BLOB))`, plan.versionIds)) +
      (await sumOver(ciDiffs, sql`length(CAST(${ciDiffs.diff} AS BLOB))`, plan.diffIds)) +
      readingBytes +
      apiReadings.reduce((sum, row) => sum + row.bytes, 0) +
      fileBytes;
    const counts: PurgeCounts = {
      captures: plan.captureIds.length,
      versions: plan.versionIds.length,
      diffs: plan.diffIds.length,
      screenshots: plan.screenshotIds.length,
      // Only when there is one: every other plan's counts stay exactly Phase 6's.
      ...(plan.apiReadingIds.length > 0 ? { readings: plan.apiReadingIds.length } : {}),
    };
    return { ...plan, counts, bytes, fileBytes };
  }

  return {
    planPurge,

    async executePurge(plan, reason, now) {
      if (typeof plan !== 'object' || plan === null || !isOneOf(PURGE_REASONS, reason) || !isTime(now)) return null;
      if ((reason === 'project-deleted') !== (normalPolicy(plan.policy)?.mode === 'all')) return null;
      const fresh = await planPurge({ projectId: plan.projectId, policy: plan.policy, now: plan.now });
      if (fresh === null) return null;
      if (!sameRows(fresh, plan)) return { status: 'stale' };
      const { counts } = fresh;
      if (counts.captures + counts.versions + counts.diffs + counts.screenshots + fresh.apiReadingIds.length === 0) return { status: 'empty' };
      // The purge log's counts are Phase 6's columns: never the API readings'.
      const logged = { captures: counts.captures, versions: counts.versions, diffs: counts.diffs, screenshots: counts.screenshots };

      const purgeId = uuidv7(now);
      // Children first: a diff, a screenshot and a capture name versions and captures.
      const order: [CapturedTable, typeof ciDiffs | typeof ciScreenshots | typeof ciCaptures | typeof ciVersions, readonly string[]][] = [
        ['ci_diffs', ciDiffs, fresh.diffIds],
        ['ci_screenshots', ciScreenshots, fresh.screenshotIds],
        ['ci_captures', ciCaptures, fresh.captureIds],
        ['ci_versions', ciVersions, fresh.versionIds],
      ];
      // An API-only purge writes no `ci_purges` row (a synced, all-zero row would tell other devices
      // nothing): `ci_serp_api_purges` records it, by this same purge id.
      const capturedRows = logged.captures + logged.versions + logged.diffs + logged.screenshots > 0;
      const items: BatchItem<'sqlite'>[] = capturedRows ? [db.insert(ciPurges).values({ id: purgeId, reason, projectId: fresh.projectId, policy: policyJson(fresh.policy), ...logged, bytes: fresh.bytes, createdAt: now })] : [];
      for (const [tableName, , ids] of order) {
        for (const part of chunks(ids)) items.push(db.insert(ciTombstones).values(part.map((rowId) => ({ id: uuidv7(now), purgeId, tableName, rowId, createdAt: now }))));
      }
      for (const [, table, ids] of order) {
        for (const part of chunks(ids)) items.push(db.delete(table).where(inArray(table.id, part)));
      }
      // The purged captures' readings, now that the captures are gone (same transaction).
      for (const part of chunks(fresh.captureIds)) items.push(db.delete(ciSerpReadings).where(and(eq(ciSerpReadings.source, 'capture'), inArray(ciSerpReadings.captureId, part))));
      // Phase 12 Task 4: the API readings, each recorded first (`0245`'s delete guard looks for the record).
      for (const part of chunks(fresh.apiReadingIds)) {
        items.push(db.insert(ciSerpApiPurges).values(part.map((readingId) => ({ readingId, purgeId, reason, projectId: fresh.projectId, purgedAt: now }))));
        items.push(db.delete(ciSerpReadings).where(and(eq(ciSerpReadings.source, 'serp-api'), inArray(ciSerpReadings.id, part))));
      }
      try {
        await db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
      } catch (error) {
        // Rolled back. A capture written since the re-plan (a version it reuses still has captures,
        // `ci_versions_unreferenced_only`) makes the plan stale; anything else is a real failure.
        const again = await planPurge({ projectId: fresh.projectId, policy: fresh.policy, now: fresh.now });
        if (again && !sameRows(again, fresh)) return { status: 'stale' };
        throw error;
      }
      return { status: 'purged', purgeId, plan: fresh };
    },

    async purges({ projectId, limit }) {
      if (projectId !== undefined && !isId(projectId)) return [];
      const rows = await db
        .select({ ...getTableColumns(ciPurges), policy: capped(ciPurges.policy, MAX_POLICY_JSON) })
        .from(ciPurges)
        .where(projectId === undefined ? undefined : eq(ciPurges.projectId, projectId))
        .orderBy(desc(ciPurges.createdAt), desc(ciPurges.id))
        .limit(pageSize(limit));
      const records: PurgeRecord[] = [];
      for (const row of rows) {
        const counted = [row.captures, row.versions, row.diffs, row.screenshots, row.bytes].every((n) => isCount(n));
        if (!isId(row.id) || !isOneOf(PURGE_REASONS, row.reason) || !(row.projectId === null || isId(row.projectId)) || !isJsonOrNull(row.policy, MAX_POLICY_JSON) || !counted || !isTime(row.createdAt)) continue;
        const counts = { captures: row.captures, versions: row.versions, diffs: row.diffs, screenshots: row.screenshots };
        records.push({ id: row.id, reason: row.reason, projectId: row.projectId, policyJson: row.policy, counts, bytes: row.bytes, createdAt: row.createdAt });
      }
      return records;
    },
  };
}
