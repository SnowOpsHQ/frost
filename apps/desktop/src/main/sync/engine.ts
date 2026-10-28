import type { SqlDriver, SqlQuery } from '@app/db/driver-types';
import {
  SYNC_LOG_TABLE,
  SYNC_MAX_CLOCK_SKEW_MS,
  SYNC_MAX_PAGES_PER_PASS,
  SYNC_MAX_ROW_BYTES,
  SYNC_PAGE_ROWS,
  SYNC_PURGE_DELETE_ORDER,
  SYNC_PUSH_SETTLE_MS,
  SYNC_STATE_TABLE,
  SYNC_TABLES,
  SYNC_TOMBSTONE_TABLE,
  type SyncDirection,
  type SyncSkipReason,
  type SyncTableName,
} from '@app/specs/sync.spec';

// The row-mirror sync engine (spec `sync.spec.ts`, Sync tables; acceptance `sync-engine.feature.md`,
// Engine; plan, Sync design note). Pure over two `SqlDriver`s: `source`, the browser-session
// database, and `replica`, the libSQL replica `frost-sync.db`. A pass pushes the session database's
// new `SYNC_TABLES` rows into the replica, then (with an endpoint) lets the caller `sync()`, then
// pulls the replica's new rows back, each page in one transaction on the side written.
//
// Only spec identifiers reach SQL: `SYNC_TABLES`' names and columns and the engine's own two tables,
// each through `quoteIdentifier`. Every value is a bound parameter; a tombstone's `table_name` is
// compared with `SYNC_PURGE_DELETE_ORDER` and never put into SQL itself.
//
// Marks (`SYNC_STATE_TABLE`, replica only) are keyed by device: with an endpoint the replica is the
// primary's copy, shared by every device. Push marks are the session rows' `(time, id)` (time read
// from this device's own rows); pull reads the replica's change log (`SYNC_LOG_TABLE`) by `seq`, the
// primary's commit order, so a row whose time is older than anything pulled before still arrives.
//
// Runs on whatever thread calls it: today Electron's main thread (see `sync.spec.ts`, Where sync
// runs). Nothing here bounds how long a page takes beyond `SYNC_PAGE_ROWS` and `SYNC_MAX_ROW_BYTES`.

type Row = readonly unknown[];
type Table = (typeof SYNC_TABLES)[number];

/** Where `column` is in `table`'s rows. */
const columnAt = (table: Table, column: string): number => (table.columns as readonly string[]).indexOf(column);

const STATE_COLUMNS = ['device_id', 'direction', 'table_name', 'mark_time', 'mark_id', 'mark_seq', 'updated_at'] as const;
const LOG_COLUMNS = ['seq', 'table_name', 'row_id'] as const;

/** Every identifier the engine may put into SQL. */
const IDENTIFIERS: ReadonlySet<string> = new Set([
  ...SYNC_TABLES.flatMap((table) => [table.name, ...table.columns]),
  SYNC_STATE_TABLE,
  SYNC_LOG_TABLE,
  ...STATE_COLUMNS,
  ...LOG_COLUMNS,
]);

/** `name` double-quoted, if it is a spec identifier (`SYNC_TABLES`, their columns, the engine's own tables); else throws. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIERS.has(name) || !/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('not a sync identifier');
  return `"${name}"`;
}

const q = quoteIdentifier;
const list = (names: readonly string[]) => names.map(q).join(', ');
const marks = (count: number) => Array.from({ length: count }, () => '?').join(', ');
const run = (sql: string, params: readonly unknown[]): SqlQuery => ({ sql, params, method: 'run' });
/** Bound parameters per `IN (…)` list: far under SQLite's limit. */
const CHUNK = 500;
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/** Creates the engine's tables in the replica (idempotent). Never called on the session database. */
export async function ensureSyncState(replica: SqlDriver): Promise<void> {
  await replica.exec(
    `CREATE TABLE IF NOT EXISTS ${q(SYNC_STATE_TABLE)} (` +
      `${q('device_id')} TEXT NOT NULL, ${q('direction')} TEXT NOT NULL CHECK (${q('direction')} IN ('push', 'pull')), ` +
      `${q('table_name')} TEXT NOT NULL, ${q('mark_time')} INTEGER, ${q('mark_id')} TEXT, ${q('mark_seq')} INTEGER, ` +
      `${q('updated_at')} INTEGER NOT NULL, PRIMARY KEY (${list(['device_id', 'direction', 'table_name'])}));\n` +
      `CREATE TABLE IF NOT EXISTS ${q(SYNC_LOG_TABLE)} (` +
      `${q('seq')} INTEGER PRIMARY KEY AUTOINCREMENT, ${q('table_name')} TEXT NOT NULL, ${q('row_id')} TEXT NOT NULL);\n` +
      `CREATE INDEX IF NOT EXISTS frost_sync_log_table_name_seq ON ${q(SYNC_LOG_TABLE)} (${list(['table_name', 'seq'])});`,
  );
}

export interface SyncTableReport {
  readonly table: SyncTableName;
  readonly status: 'synced' | 'skipped';
  readonly reason?: SyncSkipReason;
  /** Rows inserted or replaced on the side written. */
  written: number;
  /** Rows deleted there by arriving tombstones. */
  deleted: number;
  /** Pulled rows skipped for being larger than `SYNC_MAX_ROW_BYTES` (never read). */
  tooLarge: number;
}

export interface SyncDirectionReport {
  readonly direction: SyncDirection;
  readonly tables: SyncTableReport[];
  /** Pages run (each one transaction on the side written). */
  pages: number;
  /** Rows were left for the next pass (`SYNC_MAX_PAGES_PER_PASS` reached). */
  more: boolean;
}

export interface SyncPassReport {
  readonly push: SyncDirectionReport;
  readonly pull: SyncDirectionReport;
  /** The replica's `sync()` ran and succeeded (`false` without one). */
  readonly synced: boolean;
  /** What `sync()` threw, if it did (the pull still ran, over the replica as it was). */
  readonly syncError?: unknown;
}

export interface SyncPassOptions {
  /** The session database. */
  readonly source: SqlDriver;
  /** The replica (`frost-sync.db`), with `ensureSyncState` already run. */
  readonly replica: SqlDriver;
  /** This device's ID (`SyncConfigFile.deviceId`): keys its marks. */
  readonly deviceId: string;
  /** Default `Date.now`. */
  readonly now?: () => number;
  /** Default `SYNC_PAGE_ROWS`. */
  readonly pageRows?: number;
  /** Default `SYNC_MAX_PAGES_PER_PASS`. */
  readonly maxPages?: number;
  /** Default `SYNC_MAX_ROW_BYTES` (tests). */
  readonly maxRowBytes?: number;
}

// ---- Tables on each side -------------------------------------------------------------------

async function columnsOf(driver: SqlDriver, table: string): Promise<Set<string> | null> {
  const { rows } = await driver.execute('SELECT name FROM pragma_table_info(?)', [table], 'all');
  const names = (rows as [string][]).map(([name]) => name);
  return names.length === 0 ? null : new Set(names);
}

/** Each table's skip reason, or `null` when both sides have it with every spec'd column. */
async function tableProblems(source: SqlDriver, replica: SqlDriver): Promise<Map<SyncTableName, SyncSkipReason | null>> {
  const problems = new Map<SyncTableName, SyncSkipReason | null>();
  for (const table of SYNC_TABLES) {
    const [mine, theirs] = [await columnsOf(source, table.name), await columnsOf(replica, table.name)];
    const complete = (columns: Set<string>) => table.columns.every((column) => columns.has(column));
    problems.set(table.name, mine === null ? 'missing-in-source' : theirs === null ? 'missing-in-replica' : complete(mine) && complete(theirs) ? null : 'columns-missing');
  }
  const tombstones = problems.get(SYNC_TOMBSTONE_TABLE) === null;
  for (const table of SYNC_TABLES) {
    if (table.rule === 'append-only' && problems.get(table.name) === null && !tombstones) problems.set(table.name, 'needs-tombstones');
  }
  return problems;
}

function emptyReport(direction: SyncDirection, problems: Map<SyncTableName, SyncSkipReason | null>): SyncDirectionReport {
  return {
    direction,
    tables: SYNC_TABLES.map((table) => {
      const reason = problems.get(table.name) ?? null;
      return reason === null
        ? { table: table.name, status: 'synced', written: 0, deleted: 0, tooLarge: 0 }
        : { table: table.name, status: 'skipped', reason, written: 0, deleted: 0, tooLarge: 0 };
    }),
    pages: 0,
    more: false,
  };
}

// ---- Marks ---------------------------------------------------------------------------------

interface PushMark {
  readonly time: number;
  readonly id: string;
}
const START: PushMark = { time: Number.MIN_SAFE_INTEGER, id: '' };
const after = (a: PushMark, b: PushMark): boolean => a.time > b.time || (a.time === b.time && a.id > b.id);

async function readMarks(replica: SqlDriver, deviceId: string, direction: SyncDirection): Promise<Map<string, { time: number | null; id: string | null; seq: number | null }>> {
  const { rows } = await replica.execute(
    `SELECT ${list(['table_name', 'mark_time', 'mark_id', 'mark_seq'])} FROM ${q(SYNC_STATE_TABLE)} WHERE ${q('device_id')} = ? AND ${q('direction')} = ?`,
    [deviceId, direction],
    'all',
  );
  return new Map((rows as [string, number | null, string | null, number | null][]).map(([table, time, id, seq]) => [table, { time, id, seq }]));
}

function markStatement(deviceId: string, direction: SyncDirection, table: SyncTableName, mark: { time?: number; id?: string; seq?: number }, now: number): SqlQuery {
  const set = ['mark_time', 'mark_id', 'mark_seq', 'updated_at'].map((column) => `${q(column)} = excluded.${q(column)}`).join(', ');
  return run(
    `INSERT INTO ${q(SYNC_STATE_TABLE)} (${list(STATE_COLUMNS)}) VALUES (${marks(STATE_COLUMNS.length)}) ` +
      `ON CONFLICT (${list(['device_id', 'direction', 'table_name'])}) DO UPDATE SET ${set}`,
    [deviceId, direction, table, mark.time ?? null, mark.id ?? null, mark.seq ?? null, now],
  );
}

// ---- Reading rows --------------------------------------------------------------------------

/** `table`'s rows whose `id` is in `ids`, by id. */
async function rowsById(driver: SqlDriver, table: Table, ids: readonly string[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  for (const chunk of chunks(ids)) {
    const { rows } = await driver.execute(`SELECT ${list(table.columns)} FROM ${q(table.name)} WHERE ${q('id')} IN (${marks(chunk.length)})`, chunk, 'all');
    for (const row of rows as Row[]) found.set(row[0] as string, row);
  }
  return found;
}

/** The `(table_name, row_id)` pairs among `rowIds` that `driver`'s tombstone table already has. */
async function tombstonedPairs(driver: SqlDriver, rowIds: readonly string[]): Promise<Set<string>> {
  const pairs = new Set<string>();
  for (const chunk of chunks(rowIds)) {
    const { rows } = await driver.execute(
      `SELECT ${list(['table_name', 'row_id'])} FROM ${q(SYNC_TOMBSTONE_TABLE)} WHERE ${q('row_id')} IN (${marks(chunk.length)})`,
      chunk,
      'all',
    );
    for (const [table, rowId] of rows as [string, string][]) pairs.add(pairKey(table, rowId));
  }
  return pairs;
}
const pairKey = (table: string, rowId: string) => JSON.stringify([table, rowId]);

const TOMBSTONE = SYNC_TABLES.find((table) => table.name === SYNC_TOMBSTONE_TABLE)!;
const TOMBSTONE_TABLE_NAME = columnAt(TOMBSTONE, 'table_name');
const TOMBSTONE_ROW_ID = columnAt(TOMBSTONE, 'row_id');
const DELETABLE: ReadonlySet<string> = new Set(SYNC_PURGE_DELETE_ORDER);

// ---- Merging into one side -----------------------------------------------------------------

/** What one page writes into one side. */
interface PagePlan {
  readonly statements: SqlQuery[];
  /** Rows inserted or replaced, per table (push logs them). */
  readonly written: Map<SyncTableName, string[]>;
  /** Mutable rows whose incoming version lost to the target's (pull fetches the winner back). */
  readonly lost: Map<SyncTableName, string[]>;
  readonly deleted: Map<SyncTableName, number>;
  readonly tooLarge: Map<SyncTableName, number>;
  /** Tombstoned `(table_name, row_id)` pairs seen in this page (they veto inserts after them). */
  readonly vetoes: Set<string>;
  /** Rows to delete, per `SYNC_PURGE_DELETE_ORDER` table. */
  readonly deletes: Map<string, Set<string>>;
}

const newPlan = (): PagePlan => ({ statements: [], written: new Map(), lost: new Map(), deleted: new Map(), tooLarge: new Map(), vetoes: new Set(), deletes: new Map() });
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => map.set(key, [...(map.get(key) ?? []), value]);

function insertStatement(table: Table, row: Row): SqlQuery {
  const missing = `NOT EXISTS (SELECT 1 FROM ${q(table.name)} WHERE ${q('id')} = ?)`;
  const notTombstoned = `NOT EXISTS (SELECT 1 FROM ${q(SYNC_TOMBSTONE_TABLE)} WHERE ${q('table_name')} = ? AND ${q('row_id')} = ?)`;
  const base = `INSERT INTO ${q(table.name)} (${list(table.columns)}) SELECT ${marks(table.columns.length)} WHERE ${missing}`;
  switch (table.rule) {
    case 'append-only':
      return run(`${base} AND ${notTombstoned}`, [...row, row[0], table.name, row[0]]);
    case 'tombstone':
      return run(`${base} AND ${notTombstoned}`, [...row, row[0], row[TOMBSTONE_TABLE_NAME], row[TOMBSTONE_ROW_ID]]);
    default:
      return run(base, [...row, row[0]]);
  }
}

/**
 * Whether the incoming version of a mutable row replaces the target's: later `updated_at` (each
 * counted as at most `now + SYNC_MAX_CLOCK_SKEW_MS`), or on a tie the larger values.
 */
function incomingWins(table: Table, incoming: Row, current: Row, now: number): boolean | 'same' {
  const at = columnAt(table, 'updated_at');
  const cap = now + SYNC_MAX_CLOCK_SKEW_MS;
  const [mine, theirs] = [Math.min(incoming[at] as number, cap), Math.min(current[at] as number, cap)];
  if (mine !== theirs) return mine > theirs;
  const [a, b] = [JSON.stringify(incoming), JSON.stringify(current)];
  return a === b ? 'same' : a > b;
}

/** Adds the statements that merge `incoming` rows of `table` into `target` to `plan`. */
async function planTable(plan: PagePlan, target: SqlDriver, table: Table, incoming: readonly Row[], now: number): Promise<void> {
  if (incoming.length === 0) return;
  const ids = incoming.map((row) => row[0] as string);
  const current = await rowsById(target, table, ids);
  const vetoed = table.rule === 'append-only' || table.rule === 'tombstone' ? await tombstonedPairs(target, table.rule === 'append-only' ? ids : incoming.map((row) => row[TOMBSTONE_ROW_ID] as string)) : new Set<string>();
  for (const row of incoming) {
    const id = row[0] as string;
    const existing = current.get(id);
    if (table.rule === 'mutable-lww') {
      if (existing === undefined) {
        plan.statements.push(insertStatement(table, row));
        push(plan.written, table.name, id);
        continue;
      }
      const wins = incomingWins(table, row, existing, now);
      if (wins === 'same') continue;
      if (!wins) {
        push(plan.lost, table.name, id);
        continue;
      }
      const at = columnAt(table, 'updated_at');
      const columns = table.columns.slice(1);
      plan.statements.push(
        run(`UPDATE ${q(table.name)} SET ${columns.map((column) => `${q(column)} = ?`).join(', ')} WHERE ${q('id')} = ? AND ${q('updated_at')} = ?`, [...row.slice(1), id, existing[at]]),
      );
      push(plan.written, table.name, id);
      continue;
    }
    if (existing !== undefined) continue;
    if (table.rule === 'append-only') {
      const pair = pairKey(table.name, id);
      if (vetoed.has(pair) || plan.vetoes.has(pair)) continue;
    }
    if (table.rule === 'tombstone') {
      const [named, rowId] = [String(row[TOMBSTONE_TABLE_NAME]), String(row[TOMBSTONE_ROW_ID])];
      const pair = pairKey(named, rowId);
      if (vetoed.has(pair) || plan.vetoes.has(pair)) continue;
      plan.vetoes.add(pair);
      if (DELETABLE.has(named)) plan.deletes.set(named, (plan.deletes.get(named) ?? new Set()).add(rowId));
    }
    plan.statements.push(insertStatement(table, row));
    push(plan.written, table.name, id);
  }
}

/**
 * Adds the children-first deletes of every tombstoned row `target` still has: those this page's
 * tombstones name, and those named by tombstones already in `target` (from earlier pages, when a
 * purge spanned more than one). Called only when `ci_tombstones` is caught up, so a purge's
 * tombstones are all there before any of its rows is deleted.
 */
async function planDeletes(plan: PagePlan, target: SqlDriver, usable: (table: SyncTableName) => boolean): Promise<void> {
  for (const name of SYNC_PURGE_DELETE_ORDER) {
    if (!usable(name)) continue;
    const table = SYNC_TABLES.find((t) => t.name === name)!;
    const { rows } = await target.execute(
      `SELECT ${q('id')} FROM ${q(name)} WHERE ${q('id')} IN (SELECT ${q('row_id')} FROM ${q(SYNC_TOMBSTONE_TABLE)} WHERE ${q('table_name')} = ?)`,
      [name],
      'all',
    );
    const named = [...(plan.deletes.get(name) ?? [])];
    const present = [...new Set([...(rows as [string][]).map(([id]) => id), ...(await rowsById(target, table, named)).keys()])];
    for (const chunk of chunks(present)) plan.statements.push(run(`DELETE FROM ${q(name)} WHERE ${q('id')} IN (${marks(chunk.length)})`, chunk));
    if (present.length > 0) plan.deleted.set(name, present.length);
  }
}

function tally(report: SyncDirectionReport, plan: PagePlan): void {
  for (const entry of report.tables) {
    entry.written += plan.written.get(entry.table)?.length ?? 0;
    entry.deleted += plan.deleted.get(entry.table) ?? 0;
    entry.tooLarge += plan.tooLarge.get(entry.table) ?? 0;
  }
}

/** Of `ids`, those whose row in `driver` is at most `SYNC_MAX_ROW_BYTES` (measured in SQL; the rows themselves are not read). */
async function withinRowCap(driver: SqlDriver, table: Table, ids: readonly string[], cap: number): Promise<{ readonly fits: string[]; readonly tooLarge: number }> {
  const size = table.columns.map((column) => `coalesce(length(CAST(${q(column)} AS BLOB)), 0)`).join(' + ');
  const fits: string[] = [];
  let tooLarge = 0;
  for (const chunk of chunks(ids)) {
    const { rows } = await driver.execute(`SELECT ${q('id')}, ${size} FROM ${q(table.name)} WHERE ${q('id')} IN (${marks(chunk.length)})`, chunk, 'all');
    for (const [id, bytes] of rows as [string, number][]) {
      if (bytes <= cap) fits.push(id);
      else tooLarge += 1;
    }
  }
  return { fits, tooLarge };
}

// ---- Push ----------------------------------------------------------------------------------

async function pushPages(options: SyncPassOptions): Promise<{ report: SyncDirectionReport; lost: Map<SyncTableName, string[]> }> {
  const { source, replica, deviceId } = options;
  const now = options.now ?? Date.now;
  const pageRows = options.pageRows ?? SYNC_PAGE_ROWS;
  const maxPages = options.maxPages ?? SYNC_MAX_PAGES_PER_PASS;
  const problems = await tableProblems(source, replica);
  const report = emptyReport('push', problems);
  const lost = new Map<SyncTableName, string[]>();
  const usable = (name: SyncTableName) => problems.get(name) === null;
  // Where this pass has read each table up to: pages go on from here, apart from the stored mark,
  // which `now − settle` caps. More than a page of rows dated past that cap would otherwise hold the
  // mark, and so every page, at the same rows, and the rest of the table would never be read.
  const scanned = new Map<SyncTableName, PushMark>();
  for (;;) {
    if (report.pages >= maxPages) {
      report.more = true;
      break;
    }
    const stored = await readMarks(replica, deviceId, 'push');
    const plan = newPlan();
    const moved: SqlQuery[] = [];
    const at = now();
    const cap: PushMark = { time: at - SYNC_PUSH_SETTLE_MS, id: '' };
    let more = false;
    let tombstonesCaughtUp = false;
    for (const table of SYNC_TABLES) {
      if (!usable(table.name)) continue;
      const saved = stored.get(table.name);
      const mark: PushMark = saved?.time != null && saved.id != null ? { time: saved.time, id: saved.id } : START;
      const seen = scanned.get(table.name);
      const from = seen !== undefined && after(seen, mark) ? seen : mark;
      const limit = pageRows;
      const { rows } = await source.execute(
        `SELECT ${list(table.columns)} FROM ${q(table.name)} WHERE (${q(table.time)} > ? OR (${q(table.time)} = ? AND ${q('id')} > ?)) ORDER BY ${q(table.time)}, ${q('id')} LIMIT ?`,
        [from.time, from.time, from.id, limit],
        'all',
      );
      const page = rows as Row[];
      await planTable(plan, replica, table, page, at);
      if (table.name === SYNC_TOMBSTONE_TABLE) tombstonesCaughtUp = page.length < limit;
      if (page.length === 0) continue;
      const timeAt = columnAt(table, table.time);
      const last = page[page.length - 1]!;
      const reached: PushMark = { time: last[timeAt] as number, id: last[0] as string };
      scanned.set(table.name, reached);
      // Never past `now − settle`: a row committed late with an earlier time is read again next pass.
      const capped = after(reached, cap) ? cap : reached;
      const next = after(capped, mark) ? capped : mark;
      if (next !== mark) moved.push(markStatement(deviceId, 'push', table.name, next, at));
      // A full page leaves the rest (from where it was read to), and every later table, for the next page.
      if (page.length === limit) {
        more = true;
        break;
      }
    }
    if (tombstonesCaughtUp) await planDeletes(plan, replica, usable);
    const log = [...plan.written].flatMap(([table, ids]) => ids.map((id) => run(`INSERT INTO ${q(SYNC_LOG_TABLE)} (${list(['table_name', 'row_id'])}) VALUES (?, ?)`, [table, id])));
    const batch = [...plan.statements, ...log, ...moved];
    if (batch.length > 0) await replica.batch(batch);
    report.pages += 1;
    tally(report, plan);
    for (const [table, ids] of plan.lost) for (const id of ids) push(lost, table, id);
    if (!more) break;
  }
  return { report, lost };
}

/** Copies the session database's new `SYNC_TABLES` rows into the replica (see the top of this file). */
export async function pushPass(options: SyncPassOptions): Promise<SyncDirectionReport> {
  return (await pushPages(options)).report;
}

// ---- Pull ----------------------------------------------------------------------------------

async function pullPages(options: SyncPassOptions, pullBack: Map<SyncTableName, string[]> = new Map()): Promise<SyncDirectionReport> {
  const { source, replica, deviceId } = options;
  const now = options.now ?? Date.now;
  const pageRows = options.pageRows ?? SYNC_PAGE_ROWS;
  const maxPages = options.maxPages ?? SYNC_MAX_PAGES_PER_PASS;
  const problems = await tableProblems(source, replica);
  const report = emptyReport('pull', problems);
  const usable = (name: SyncTableName) => problems.get(name) === null;
  const extra = new Map(pullBack);
  for (;;) {
    if (report.pages >= maxPages) {
      report.more = true;
      break;
    }
    const stored = await readMarks(replica, deviceId, 'pull');
    const plan = newPlan();
    const moved: SqlQuery[] = [];
    const at = now();
    let more = false;
    let tombstonesCaughtUp = false;
    /** The tables this page read: only their pull-back ids are done (a later table's wait for its page). */
    const visited = new Set<SyncTableName>();
    for (const table of SYNC_TABLES) {
      if (!usable(table.name)) continue;
      visited.add(table.name);
      const mark = stored.get(table.name)?.seq ?? 0;
      const limit = pageRows;
      const { rows } = await replica.execute(
        `SELECT ${list(['seq', 'row_id'])} FROM ${q(SYNC_LOG_TABLE)} WHERE ${q('table_name')} = ? AND ${q('seq')} > ? ORDER BY ${q('seq')} LIMIT ?`,
        [table.name, mark, limit],
        'all',
      );
      const entries = rows as [number, string][];
      const ids = [...new Set([...entries.map(([, id]) => id), ...(extra.get(table.name) ?? [])])];
      // Measured before they are read: a row over `SYNC_MAX_ROW_BYTES` is skipped, and counted.
      const { fits, tooLarge } = await withinRowCap(replica, table, ids, options.maxRowBytes ?? SYNC_MAX_ROW_BYTES);
      if (tooLarge > 0) plan.tooLarge.set(table.name, tooLarge);
      const found = await rowsById(replica, table, fits);
      await planTable(plan, source, table, fits.flatMap((id) => (found.has(id) ? [found.get(id)!] : [])), at);
      if (table.name === SYNC_TOMBSTONE_TABLE) tombstonesCaughtUp = entries.length < limit;
      if (entries.length === 0) continue;
      moved.push(markStatement(deviceId, 'pull', table.name, { seq: entries[entries.length - 1]![0] }, at));
      if (entries.length === limit) {
        more = true;
        break;
      }
    }
    // A full page stops before the later tables: their pull-back ids (pushes that lost) are kept for
    // the next page, or the winner would never be fetched (its log entry may be behind the mark).
    for (const name of visited) extra.delete(name);
    if (tombstonesCaughtUp) await planDeletes(plan, source, usable);
    // The session side in one transaction; the marks move only once it has committed.
    if (plan.statements.length > 0) await source.batch(plan.statements);
    if (moved.length > 0) await replica.batch(moved);
    report.pages += 1;
    tally(report, plan);
    if (!more) break;
  }
  return report;
}

/** Copies the replica's new `SYNC_TABLES` rows into the session database (see the top of this file). */
export async function pullPass(options: SyncPassOptions): Promise<SyncDirectionReport> {
  return pullPages(options);
}

/**
 * One pass: push, then `sync()` (with an endpoint; a failure is reported, and the pull still runs
 * over the replica as it is), then pull. A mutable row whose push lost to the replica's newer
 * version is fetched back by the pull, so this device ends with the winner.
 */
export async function runSyncPass(options: SyncPassOptions & { readonly sync?: () => Promise<unknown> }): Promise<SyncPassReport> {
  const { report: pushed, lost } = await pushPages(options);
  let synced = false;
  let syncError: unknown;
  if (options.sync !== undefined) {
    try {
      await options.sync();
      synced = true;
    } catch (error) {
      syncError = error;
    }
  }
  const pulled = await pullPages(options, lost);
  return syncError === undefined ? { push: pushed, pull: pulled, synced } : { push: pushed, pull: pulled, synced, syncError };
}
