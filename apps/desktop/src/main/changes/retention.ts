import { lstat, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChangeIntelRepository, Project, PurgePlan, PurgePolicy, PurgeRecord } from '@app/db';
import type { RetentionService } from '@app/ipc-contract';
import { MAX_HISTORY_PAGE, RETENTION_MODES, type RetentionMode } from '@app/specs/capture-db.spec';
import {
  ORPHAN_TMP_MIN_AGE_MS,
  PURGE_LOG_LIMIT,
  RETENTION_ENFORCE_MIN_INTERVAL_MS,
  SCREENSHOT_FILE_NAME_PATTERN,
  SCREENSHOT_TMP_NAME_PATTERN,
  isRetentionPolicy,
  plural,
  type PurgeCountsView,
  type PurgeLogEntry,
  type RetentionPolicyInput,
  type RetentionRefusal,
  type RetentionUsage,
} from '@app/specs/retention.spec';
import type { ScreenshotFiles } from '../screenshots/store';
import { createPurgeFiles, type PurgeFiles } from './purge-files';

// Retention and disk usage (Phase 6 Task 7; spec `retention.spec.ts`, `retention.schema.ts`;
// acceptance `retention.feature.md`). Deletion goes only through the audited purge path
// (`planPurge` / `executePurge`, then `purge-files.ts`, which unlinks a file only once no row names
// it); files are touched only in the screenshot directory, by hash name, and nothing here takes a
// path from the renderer.
//
// - "Purge now" plans with the project's policy, asks in main's dialog with the plan's counts and
//   bytes, and executes exactly that plan; a plan made stale by a capture is planned and asked again,
//   once.
// - The policy is enforced without a dialog (a recorded `retention` purge): after a run of the
//   project ends, after a manual capture or screenshot into it (at most once per
//   `RETENTION_ENFORCE_MIN_INTERVAL_MS`), and at startup when due. The last-enforced times are kept in
//   memory, seeded from the purge log.
// - Usage adds measured sizes to the rows' stored ones: each named screenshot file by `lstat`, the
//   database file and its `-wal` by `stat`.
// - Compact `VACUUM`s the session database after main's dialog, never during a capture run.
// - The startup orphan sweep removes only regular, hash-named files no row names (and old crash
//   leftovers of a write), never following a link.

export interface RetentionServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  /** The screenshot file store: its directory (the sweep lists it), `fileFor` (usage measures) and `unlink`. */
  readonly files: Pick<ScreenshotFiles, 'dir' | 'fileFor' | 'unlink'>;
  /** The purge-then-unlink path, shared with a project's delete (default: one over `store` and `files`). */
  readonly purges?: PurgeFiles;
  /** `SessionStore.file`: the database file, or `':memory:'`. */
  readonly databaseFile: string;
  /** The project whose capture run is under way, else `null` (`CaptureRuns.running`). */
  readonly running: () => string | null;
  /** Main's "Purge now" dialog (`PURGE_NOW`): whether the user confirmed. */
  readonly confirmPurge: (name: string, counts: PurgeCountsView, bytes: number) => Promise<boolean>;
  /** Main's "Compact" dialog (`COMPACT_DATABASE`): whether the user confirmed. */
  readonly confirmCompact: () => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface SweepCounts {
  /** Hash-named files no row names. */
  readonly removed: number;
  /** Old temporary files of a write. */
  readonly temporary: number;
}

/** Main's retention service: the procedures', the enforcement hooks and the startup work. */
export interface MainRetentionService extends RetentionService {
  /** A manual capture or screenshot was saved into the project: enforce its policy if due (rate-limited). */
  afterCapture(projectId: string): void;
  /** A capture run of the project ended: enforce its policy. */
  afterRun(projectId: string): void;
  /** Startup: seeds the last-enforced times from the purge log, enforces where due, then sweeps orphans. Never rejects. */
  startup(): Promise<void>;
  /** The orphan sweep of the screenshot directory. Never rejects. */
  sweepOrphans(): Promise<SweepCounts>;
  /** Resolves once the enforcements asked for so far are done (tests, and a clean quit). */
  settled(): Promise<void>;
}

const refused = (reason: RetentionRefusal) => ({ status: 'refused' as const, reason });
/** An error's code or name: never its message (it may hold a path or a URL). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};
const isEmpty = (plan: PurgePlan): boolean => plan.counts.captures + plan.counts.versions + plan.counts.diffs + plan.counts.screenshots === 0;
const policyOf = (project: Project): PurgePolicy => (project.retention.mode === 'forever' || project.retention.value === null ? { mode: 'forever' } : { mode: project.retention.mode, value: project.retention.value });
const policyInput = (policy: PurgePolicy): RetentionPolicyInput => (policy.mode === 'versions' || policy.mode === 'days' ? { mode: policy.mode, value: policy.value } : { mode: 'forever', value: null });

/** A purge record's policy as the log shows it; `null` when its JSON does not read back as one. */
function logPolicy(json: string | null): PurgeLogEntry['policy'] {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { mode?: unknown; value?: unknown };
    if (parsed.mode === 'all') return { mode: 'all', value: null };
    const value = parsed.value ?? null;
    return (RETENTION_MODES as readonly unknown[]).includes(parsed.mode) && isRetentionPolicy(parsed.mode, value) ? { mode: parsed.mode as RetentionMode, value: value as number | null } : null;
  } catch {
    return null;
  }
}

const entryOf = (record: PurgeRecord): PurgeLogEntry => ({ id: record.id, reason: record.reason, projectId: record.projectId, policy: logPolicy(record.policyJson), counts: { ...record.counts }, bytes: record.bytes, createdAt: record.createdAt });

/** A file's size by `stat`, `0` when it is not there (a `-wal` that does not exist). */
async function sizeOf(file: string): Promise<number> {
  try {
    const found = await stat(file);
    return found.isFile() ? found.size : 0;
  } catch {
    return 0;
  }
}

/** Whether `at` is a directory itself (not a link to one). */
async function realDirectory(at: string): Promise<boolean> {
  try {
    const found = await lstat(at);
    return found.isDirectory() && !found.isSymbolicLink();
  } catch {
    return false;
  }
}

export function createRetentionService(deps: RetentionServiceDeps): MainRetentionService {
  const { store, files } = deps;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`retention: ${message}`);
  const purges = deps.purges ?? createPurgeFiles({ store, files, log });
  const inMemory = deps.databaseFile === ':memory:';

  /** When each project's policy was last enforced (in memory; seeded from the purge log at startup). */
  const enforcedAt = new Map<string, number>();

  /** `run`'s answer, or `fallback` (logged) when the database fails. */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return fallback;
    }
  };
  const storeFailed = refused('store-failed');

  // ---- Enforcement --------------------------------------------------------------------------------

  /** Enforcements, one at a time. */
  let enforcing: Promise<unknown> = Promise.resolve();
  const enqueue = (run: () => Promise<unknown>): void => {
    enforcing = enforcing.then(run, run).catch(() => undefined);
  };

  /** Enforces the project's policy now: a recorded `retention` purge, planned again once if stale. */
  const enforce = async (projectId: string): Promise<void> => {
    try {
      const at = now();
      enforcedAt.set(projectId, at);
      for (let attempt = 0; attempt < 2; attempt++) {
        const project = await store.project(projectId);
        if (project === null || project.retention.mode === 'forever') return;
        const plan = await store.planPurge({ projectId, policy: policyOf(project), now: at });
        if (plan === null || isEmpty(plan)) return;
        const { result } = await purges.execute(plan, 'retention', at);
        if (result?.status !== 'stale') return;
      }
      log('a retention purge was skipped: its captures kept changing');
    } catch (error) {
      log(`a retention purge failed (${codeOf(error)})`);
    }
  };

  const due = (projectId: string, at: number): boolean => {
    const last = enforcedAt.get(projectId);
    return last === undefined || at - last >= RETENTION_ENFORCE_MIN_INTERVAL_MS;
  };

  /** Each live project's newest `retention` purge, from the log. */
  const seed = async (projects: readonly Project[]): Promise<void> => {
    for (const project of projects) {
      if (enforcedAt.has(project.id)) continue;
      const newest = (await store.purges({ projectId: project.id, limit: MAX_HISTORY_PAGE })).find((record) => record.reason === 'retention');
      if (newest) enforcedAt.set(project.id, newest.createdAt);
    }
  };

  // ---- The orphan sweep ---------------------------------------------------------------------------

  const sweepOrphans = async (): Promise<SweepCounts> => {
    let removed = 0;
    let temporary = 0;
    try {
      const dir = files.dir;
      // Both directories must be directories themselves: behind a link, nothing is touched.
      if (!(await realDirectory(path.dirname(dir))) || !(await realDirectory(dir))) return { removed, temporary };
      const entries = await readdir(dir, { withFileTypes: true });
      const named = entries.filter((entry) => entry.isFile() && (SCREENSHOT_FILE_NAME_PATTERN.test(entry.name) || SCREENSHOT_TMP_NAME_PATTERN.test(entry.name)));
      if (named.length === 0) return { removed, temporary };
      const kept = new Set(await store.screenshotHashes());
      const cutoff = now() - ORPHAN_TMP_MIN_AGE_MS;
      for (const entry of named) {
        const file = path.join(dir, entry.name);
        try {
          // Again by `lstat` (never followed): a regular file, old enough that no write under way owns it.
          const found = await lstat(file);
          if (!found.isFile() || found.isSymbolicLink() || found.mtimeMs > cutoff) continue;
          if (SCREENSHOT_TMP_NAME_PATTERN.test(entry.name)) {
            if (!(await realDirectory(dir))) break;
            await unlink(file);
            temporary += 1;
            continue;
          }
          const hash = entry.name.slice(0, 64);
          // A row may have named it since the list was read: asked again just before.
          if (kept.has(hash) || (await store.isHashReferenced(hash))) continue;
          if (await files.unlink(hash)) removed += 1;
        } catch {
          // Gone meanwhile, or not ours to remove: left alone.
        }
      }
    } catch (error) {
      log(`the orphan sweep stopped (${codeOf(error)})`);
    }
    log(`the orphan sweep removed ${plural(removed, 'file', 'files')} and ${plural(temporary, 'temporary file', 'temporary files')}`);
    return { removed, temporary };
  };

  // ---- Usage --------------------------------------------------------------------------------------

  /** The named screenshot files, each once, measured by `lstat` (a missing or non-regular one is `missing`). */
  const measureFiles = async (hashes: readonly string[]): Promise<RetentionUsage['files']> => {
    const measured = { count: 0, bytes: 0, missing: 0 };
    const dirOk = (await realDirectory(path.dirname(files.dir))) && (await realDirectory(files.dir));
    for (const hash of hashes) {
      let size: number | null = null;
      if (dirOk) {
        try {
          const found = await lstat(files.fileFor(hash));
          if (found.isFile() && !found.isSymbolicLink()) size = found.size;
        } catch {
          size = null;
        }
      }
      if (size === null) measured.missing += 1;
      else {
        measured.count += 1;
        measured.bytes += size;
      }
    }
    return measured;
  };

  const databaseSize = async (): Promise<RetentionUsage['database']> => (inMemory ? null : { bytes: await sizeOf(deps.databaseFile), walBytes: await sizeOf(`${deps.databaseFile}-wal`) });

  return {
    setRetention: (projectId, mode, value) =>
      guarded(
        'set retention',
        async () => {
          if (!isRetentionPolicy(mode, value)) return refused('invalid-retention');
          if ((await store.project(projectId)) === null) return refused('not-found');
          if (!(await store.setRetention(projectId, mode, value, now()))) return refused('not-found');
          // The policy the user just set is enforced at the next capture into the project.
          enforcedAt.delete(projectId);
          return { status: 'ok' as const };
        },
        storeFailed,
      ),

    retentionPreview: (projectId) =>
      guarded(
        'preview',
        async () => {
          const project = await store.project(projectId);
          if (project === null) return refused('not-found');
          const policy = policyOf(project);
          const plan = await store.planPurge({ projectId, policy, now: now() });
          if (plan === null) return refused('not-found');
          return { status: 'ok' as const, policy: policyInput(policy), counts: { ...plan.counts }, bytes: plan.bytes };
        },
        storeFailed,
      ),

    purgeNow: (projectId) =>
      guarded(
        'purge now',
        async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            if (deps.running() === projectId) return refused('running');
            const project = await store.project(projectId);
            if (project === null) return refused('not-found');
            // 1–2. The plan, at this moment; nothing to remove asks nothing.
            const plan = await store.planPurge({ projectId, policy: policyOf(project), now: now() });
            if (plan === null) return refused('not-found');
            if (isEmpty(plan)) return { status: 'empty' as const };
            // 3. Main's dialog shows exactly this plan.
            if (!(await deps.confirmPurge(project.name, { ...plan.counts }, plan.bytes))) return refused('declined');
            if (deps.running() === projectId) return refused('running');
            // 4–6. That plan only (re-planned and compared inside), then the files no row names any more.
            const { result, files: removed } = await purges.execute(plan, 'purge-now', now());
            if (result === null) return storeFailed;
            if (result.status === 'empty') return { status: 'empty' as const };
            if (result.status === 'purged') return { status: 'purged' as const, counts: { ...result.plan.counts }, bytes: result.plan.bytes, files: removed };
            // 5. Stale: a capture raced in; plan again and ask again (once).
          }
          return { status: 'changed' as const };
        },
        storeFailed,
      ),

    usage: (projectId) =>
      guarded(
        'usage',
        async () => {
          if (projectId !== null && (await store.project(projectId)) === null) return refused('not-found');
          const stored = await store.usage(projectId ?? undefined);
          if (stored === null) return refused('not-found');
          const hashes = await store.screenshotHashes(projectId === null ? {} : { projectId });
          const usage: RetentionUsage = {
            projectId,
            captures: stored.captures,
            versions: stored.versions,
            sharedVersions: stored.sharedVersions,
            snapshotBytes: stored.snapshotBytes,
            diffBytes: stored.diffBytes,
            screenshots: stored.screenshots,
            files: await measureFiles(hashes),
            database: await databaseSize(),
          };
          return { status: 'ok' as const, usage };
        },
        storeFailed,
      ),

    purgeLog: (projectId) =>
      guarded('purge log', async () => ({ entries: (await store.purges({ ...(projectId === null ? {} : { projectId }), limit: PURGE_LOG_LIMIT })).map(entryOf) }), { entries: [] }),

    compact: () =>
      guarded(
        'compact',
        async () => {
          if (deps.running() !== null) return refused('running');
          if (inMemory) return refused('unavailable');
          if (!(await deps.confirmCompact())) return refused('declined');
          if (deps.running() !== null) return refused('running');
          // After the enforcements under way (a purge never meets the rewrite).
          await enforcing;
          const size = async () => (await sizeOf(deps.databaseFile)) + (await sizeOf(`${deps.databaseFile}-wal`));
          const before = await size();
          await store.compact();
          return { status: 'compacted' as const, before, after: await size() };
        },
        storeFailed,
      ),

    afterCapture(projectId) {
      // A run's captures wait for its end.
      if (deps.running() === projectId || !due(projectId, now())) return;
      enforcedAt.set(projectId, now());
      enqueue(() => enforce(projectId));
    },

    afterRun(projectId) {
      enqueue(() => enforce(projectId));
    },

    async startup() {
      try {
        const projects = await store.projects();
        await seed(projects);
        const at = now();
        for (const project of projects) if (project.retention.mode !== 'forever' && due(project.id, at)) enqueue(() => enforce(project.id));
        await enforcing;
      } catch (error) {
        log(`startup enforcement failed (${codeOf(error)})`);
      }
      await sweepOrphans();
    },

    sweepOrphans,

    settled: async () => {
      await enforcing;
    },
  };
}
