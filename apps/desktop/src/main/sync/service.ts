import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { libsqlFileUrl, openLibsqlDriver, type LibsqlDriver } from '@app/db/driver-libsql';
import { createNodeSqliteDriver } from '@app/db/driver-node-sqlite';
import type { SqlDriver } from '@app/db/driver-types';
import { DB_BUSY_TIMEOUT_MS, DB_FILE_MODE, DB_SIDECAR_SUFFIXES } from '@app/specs/browser-session-db.spec';
import { SYNC_INTERVAL_MS, SYNC_REPLICA_FILE_NAME, type LibsqlConfig } from '@app/specs/sync.spec';
import { createSyncConfigStore, type SafeStorageLike, type SyncToken } from './config';
import { ensureSyncState, runSyncPass, type SyncPassReport } from './engine';

// The sync service in main (acceptance `sync-engine.feature.md`, Service). Fail safe and off the
// startup path, like `startUpdateService`: `startSyncService` never throws and returns at once; the
// work runs in the background, and any failure is one log line.
//
// Off (missing, disabled or tampered config): nothing else happens. libSQL is never loaded, no file
// is created, no timer is set. On: it opens `userData/frost-sync.db` through `openLibsqlDriver`
// (`syncUrl` and `authToken` only when an endpoint is configured; without one it is local staging
// only, and nothing leaves the device), narrows it and its sidecars to 0600 on POSIX, creates the
// engine's state tables in it, and runs a pass at once and every `SYNC_INTERVAL_MS`. With an
// endpoint, the replica's `sync()` runs after each push (the engine's `runSyncPass`); its errors are
// logged with the token redacted, and never thrown.
//
// The session database: a second `node:sqlite` handle on the store's own file (`SessionStore.file`),
// with the store's busy timeout (`DB_BUSY_TIMEOUT_MS`; the file uses SQLite's default rollback
// journal, as `open.ts` leaves it). The store's handle stays private to `@app/db` (its index exports
// no handle, and Phase 7 does not own it); two handles on one file is ordinary SQLite. While a pull
// page's `BEGIN IMMEDIATE` batch runs, the store's own writes wait for the lock (up to their busy
// timeout, then fail as under any other lock). When the store fell back to memory (`':memory:'`) there is nothing to mirror: an empty in-memory database
// stands in, and every table is skipped.
//
// Everything here runs on Electron's main thread. With an endpoint, libSQL's `sync()` is synchronous
// native code (`databaseSyncSync`) and blocks the main thread on network I/O with no timeout: the
// engine or `sync()` must move to a worker or utility process before remote sync is turned on
// (`sync.spec.ts`, Where sync runs). Local staging does local I/O only.
//
// No IPC and no chrome UI in this phase: only a hand-written `frost-sync.json` turns sync on.

export interface SyncStatus {
  /** `starting` until the config is read; `off` when sync is off (or disposed); `failed` when it could not start. */
  readonly state: 'starting' | 'off' | 'running' | 'failed';
  /** `local`: local staging only (no endpoint); `remote`: the replica syncs with an endpoint. */
  readonly mode?: 'local' | 'remote';
  /** Passes that ran to the end. */
  readonly passes: number;
  readonly lastPassAt?: number;
}

export interface StartSyncDeps {
  readonly app: { getPath(name: 'userData'): string };
  readonly safeStorage: SafeStorageLike;
  /** The session database file in use (`SessionStore.file`); `':memory:'` when it is in memory. */
  readonly sessionFile: string;
  readonly log?: (line: string) => void;
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Opens the replica (default `openLibsqlDriver`; tests). */
  readonly openReplica?: (config: LibsqlConfig) => Promise<LibsqlDriver>;
  /** Opens the session database's second handle (default `node:sqlite`; tests). */
  readonly openSession?: (file: string) => SqlDriver;
  readonly now?: () => number;
}

export interface SyncServiceHandle {
  status(): SyncStatus;
  /** Settles once the config is read and, when on, the replica is open (or that failed). */
  readonly whenStarted: Promise<void>;
  /** Settles once the pass running now (if any) has ended. */
  idle(): Promise<void>;
  /** Stops the timer, waits for a running pass, closes both databases. Never rejects. */
  dispose(): Promise<void>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Sidecars libSQL or SQLite may create beside the replica (the embedded replica's metadata among them). */
const REPLICA_SIDECARS = [...DB_SIDECAR_SUFFIXES, '-info', '-client_wal_index'] as const;

/** Narrows the replica and every sidecar there is to 0600 (POSIX); never follows a link. */
async function narrow(file: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  for (const name of [file, ...REPLICA_SIDECARS.map((suffix) => `${file}${suffix}`)]) {
    try {
      const info = await lstat(name);
      if (info.isFile() && (info.mode & 0o777) !== DB_FILE_MODE) await chmod(name, DB_FILE_MODE);
    } catch {
      // Not there.
    }
  }
}

function defaultOpenSession(file: string): SqlDriver {
  return createNodeSqliteDriver(file === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(file, { timeout: DB_BUSY_TIMEOUT_MS }));
}

/** What the skips of `report` come to, for one log line (`''`: nothing skipped). */
function skipped(report: SyncPassReport): string {
  const byReason = new Map<string, string[]>();
  for (const table of report.push.tables) if (table.status === 'skipped') byReason.set(table.reason!, [...(byReason.get(table.reason!) ?? []), table.table]);
  return [...byReason].map(([reason, tables]) => `${reason}: ${tables.join(', ')}`).join('; ');
}

/** Starts sync in the background (see the top of this file). Never throws. */
export function startSyncService(deps: StartSyncDeps): SyncServiceHandle {
  const log = deps.log ?? ((line: string) => console.warn(`frost: ${line}`));
  const platform = deps.platform ?? process.platform;
  const openReplica = deps.openReplica ?? ((config: LibsqlConfig) => openLibsqlDriver(config));
  const openSession = deps.openSession ?? defaultOpenSession;
  let state: SyncStatus['state'] = 'starting';
  let mode: SyncStatus['mode'];
  let passes = 0;
  let lastPassAt: number | undefined;
  let token: SyncToken | null = null;
  let replica: LibsqlDriver | null = null;
  let session: SqlDriver | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let lastSkips: string | null = null;

  /** `text` with the token (if any) replaced: errors from the replica or the server may echo it. */
  const redact = (text: string): string => {
    const secret = token?.reveal();
    return secret === undefined || secret === '' ? text : text.split(secret).join('[redacted]');
  };
  const say = (line: string) => log(redact(line));

  const pass = (replicaFile: string, deviceId: string): Promise<void> => {
    if (running !== null || disposed || replica === null || session === null) return running ?? Promise.resolve();
    const [source, target] = [session, replica];
    running = (async () => {
      try {
        const report = await runSyncPass({ source, replica: target, deviceId, ...(target.sync === undefined ? {} : { sync: target.sync }), ...(deps.now === undefined ? {} : { now: deps.now }) });
        await narrow(replicaFile, platform);
        if (report.syncError !== undefined) say(`sync: the replica could not sync with the endpoint (${describe(report.syncError)}); will retry`);
        const tooLarge = report.pull.tables.filter((t) => t.tooLarge > 0).map((t) => `${t.table}: ${t.tooLarge}`);
        if (tooLarge.length > 0) say(`sync: rows over the size cap were skipped (${tooLarge.join(', ')})`);
        const skips = skipped(report);
        if (skips !== lastSkips) {
          if (skips !== '') say(`sync: tables skipped (${skips})`);
          lastSkips = skips;
        }
        passes += 1;
        lastPassAt = (deps.now ?? Date.now)();
      } catch (error) {
        say(`sync: a pass failed (${describe(error)}); will retry`);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const start = async (): Promise<void> => {
    const userData = deps.app.getPath('userData');
    const store = createSyncConfigStore(userData, { safeStorage: deps.safeStorage, platform, log: say });
    const loaded = await store.load();
    if (!loaded.config.enabled || disposed) {
      state = 'off';
      return;
    }
    token = loaded.token;
    const { url } = loaded.config;
    const deviceId = await store.deviceId();
    const replicaFile = path.join(userData, SYNC_REPLICA_FILE_NAME);
    const opened = await openReplica({
      url: libsqlFileUrl(replicaFile),
      ...(url === undefined ? {} : { syncUrl: url }),
      ...(url === undefined || token === null ? {} : { authToken: token.reveal() }),
    });
    replica = opened;
    if (disposed) return;
    await narrow(replicaFile, platform);
    await ensureSyncState(opened);
    if (disposed) return;
    session = openSession(deps.sessionFile);
    mode = url === undefined ? 'local' : 'remote';
    state = 'running';
    void pass(replicaFile, deviceId);
    timer = setInterval(() => void pass(replicaFile, deviceId), SYNC_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  let whenStarted: Promise<void>;
  try {
    whenStarted = Promise.resolve()
      .then(start)
      .catch((error: unknown) => {
        state = 'failed';
        say(`sync is off for this run: it could not start (${describe(error)})`);
      });
  } catch (error) {
    // Unreachable (`Promise.resolve().then` does not throw); kept so this function never throws.
    state = 'failed';
    say(`sync is off for this run: it could not start (${describe(error)})`);
    whenStarted = Promise.resolve();
  }

  return {
    status: () => ({ state, ...(mode === undefined ? {} : { mode }), passes, ...(lastPassAt === undefined ? {} : { lastPassAt }) }),
    whenStarted,
    idle: async () => {
      await whenStarted;
      await running;
    },
    dispose: async () => {
      disposed = true;
      // After startup has settled, so a timer it set meanwhile is cleared too.
      await whenStarted.catch(() => undefined);
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running?.catch(() => undefined);
      for (const driver of [replica, session]) await driver?.close().catch(() => undefined);
      replica = null;
      session = null;
      if (state !== 'failed') state = 'off';
    },
  };
}
