import { count, desc, eq, getTableColumns, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { PURGE_REASONS, type CapturedTable, type PurgeReason } from '@app/specs/capture-db.spec';
import type { SessionDatabase } from '../client';
import { capped, chunks, isCount, isId, isJsonOrNull, isOneOf, isRetention, isTime, pageSize } from './checks';
import { uuidv7 } from './ids';
import { ciCaptures, ciDiffs, ciProjects, ciPurges, ciScreenshots, ciTombstones, ciVersions } from './schema';

// Retention's purges (spec `capture-db.feature.md`, Retention planning; the plan's "The purge path").
// `planPurge` is a dry run over one project; `executePurge` plans again and, if nothing moved,
// records the purge and its tombstones and deletes the rows in one transaction (the store's batch).
// A row of a captured table can be deleted only that way: its `_purge_only` trigger looks for the
// tombstone and the purge written just before it in the same transaction. Those triggers bind the app
// and any SQL that respects the schema; whoever can write the database file can also `DROP TRIGGER`,
// which no trigger can prevent.
//
// After a purge, main unlinks the files of the answer's `plan.unreferencedHashes` (the plan executed,
// planned again here), checking `isHashReferenced` once more before each unlink.

/** What to purge: a project's retention policy, or `all` (internal: the `project-deleted` purge). */
export type PurgePolicy = { readonly mode: 'forever' } | { readonly mode: 'versions' | 'days'; readonly value: number } | { readonly mode: 'all' };

export interface PurgeCounts {
  readonly captures: number;
  readonly versions: number;
  readonly diffs: number;
  readonly screenshots: number;
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
  /** Hashes of purged screenshots no remaining row has: the files main may unlink afterwards. */
  readonly unreferencedHashes: readonly string[];
  readonly counts: PurgeCounts;
  /** Freed bytes: purged snapshots and diffs (stored UTF-8 bytes), plus each unreferenced file once. */
  readonly bytes: number;
}

export type ExecutePurgeResult = { readonly status: 'purged'; readonly purgeId: string; readonly plan: PurgePlan } | { readonly status: 'stale' } | { readonly status: 'empty' };

/** A `ci_purges` row: the purge log. */
export interface PurgeRecord {
  readonly id: string;
  readonly reason: PurgeReason;
  readonly projectId: string | null;
  readonly policyJson: string | null;
  readonly counts: PurgeCounts;
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

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();
const sameIds = (a: readonly string[], b: unknown): boolean => Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
/** Whether `plan` would delete exactly the rows `fresh` does. */
const sameRows = (fresh: PurgePlan, plan: PurgePlan): boolean =>
  sameIds(fresh.captureIds, plan.captureIds) && sameIds(fresh.versionIds, plan.versionIds) && sameIds(fresh.diffIds, plan.diffIds) && sameIds(fresh.screenshotIds, plan.screenshotIds);
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
        })
        .from(ciScreenshots)
        .where(eq(ciScreenshots.projectId, projectId))
    )
      .filter((row) => typeof row.id === 'string')
      // A screenshot's lane is its page, render profile and search parameters: a phone's and a desktop's never compete.
      .map((row) => ({ id: row.id, group: JSON.stringify([row.pageUrl, row.kind, row.renderProfile, row.searchParams]), at: time(row.at), sha256: row.sha256, bytes: row.bytes }));

    const captures = purgedCaptures(captureRows, policy, now);
    const screenshots = purgedScreenshots(screenshotRows, policy, now);

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
      unreferencedHashes: sorted(unreferenced.map(([hash]) => hash)),
    };
    const bytes =
      (await sumOver(ciVersions, sql`length(CAST(${ciVersions.snapshot} AS BLOB))`, plan.versionIds)) +
      (await sumOver(ciDiffs, sql`length(CAST(${ciDiffs.diff} AS BLOB))`, plan.diffIds)) +
      unreferenced.reduce((sum, [, { bytes }]) => sum + bytes, 0);
    const counts = { captures: plan.captureIds.length, versions: plan.versionIds.length, diffs: plan.diffIds.length, screenshots: plan.screenshotIds.length };
    return { ...plan, counts, bytes };
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
      if (counts.captures + counts.versions + counts.diffs + counts.screenshots === 0) return { status: 'empty' };

      const purgeId = uuidv7(now);
      // Children first: a diff, a screenshot and a capture name versions and captures.
      const order: [CapturedTable, typeof ciDiffs | typeof ciScreenshots | typeof ciCaptures | typeof ciVersions, readonly string[]][] = [
        ['ci_diffs', ciDiffs, fresh.diffIds],
        ['ci_screenshots', ciScreenshots, fresh.screenshotIds],
        ['ci_captures', ciCaptures, fresh.captureIds],
        ['ci_versions', ciVersions, fresh.versionIds],
      ];
      const items: BatchItem<'sqlite'>[] = [
        db.insert(ciPurges).values({ id: purgeId, reason, projectId: fresh.projectId, policy: policyJson(fresh.policy), ...counts, bytes: fresh.bytes, createdAt: now }),
      ];
      for (const [tableName, , ids] of order) {
        for (const part of chunks(ids)) items.push(db.insert(ciTombstones).values(part.map((rowId) => ({ id: uuidv7(now), purgeId, tableName, rowId, createdAt: now }))));
      }
      for (const [, table, ids] of order) {
        for (const part of chunks(ids)) items.push(db.delete(table).where(inArray(table.id, part)));
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
