import path from 'node:path';
import {
  CURRENT_INSTALL_MODE,
  MAX_PENDING_UPDATE_WATCHES,
  UPDATE_FETCH_LIMITS,
  UPDATE_PROGRESS_STEPS,
  UPDATE_SCHEDULE,
  jittered,
  updateUserAgent,
  type UpdateChecks,
  type UpdateErrorReason,
  type UpdateInstallMode,
  type UpdatePrefs,
  type UpdateState,
  type UpdateStatus,
} from '@app/specs/update-client.spec';
import { MAX_ENVELOPE_BYTES, UPDATE_PUBLIC_KEYS, type UpdateArtifact, type UpdateDecisionKind, type UpdateManifest, type UpdatePlatform, type UpdateVerifyReason } from '@app/specs/update-manifest.spec';
import { downloadArtifact, pruneDownloads, type DownloadFailure } from './download';
import { getBytes, type UpdateGetDeps, type UpdateGetFailure, type UpdateHop, type UpdateResolve } from './fetch';
import { checkFreshness, compareVersions, decide, verifyEnvelope } from './manifest';
import type { UpdatePrefsStore } from './prefs';

// The update client (spec `update-client.spec.ts`; acceptance `update-client.feature.md`, Client).
// A state machine in main: `disabled` without a feed (no request, ever), `off` while the user has
// automatic checks off, else `idle` → `checking` → `up-to-date` | `available` | `error`; then, only
// on `download()` (the user's consent), `downloading` → `ready` | `error`. It never installs
// anything: `ready` names how the user installs it (`manual` on every build today).
//
// A check: the feed's bytes (capped at `MAX_ENVELOPE_BYTES`) → `verifyEnvelope` against the trusted
// keys → the high-water mark (an older verified manifest is a replay: `older-than-seen`) → `decide`
// → the mark is raised unless `decide` said `prerelease-ignored` → `available` (or `up-to-date`
// for every other outcome, which `lastCheck()` keeps apart). Before a download the manifest's
// freshness is checked again. Every throw becomes an `error` state; no method rejects.

/** Injected timers (main: the global ones, unref'd). */
export interface UpdateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdateClientDeps {
  /** `resolveFeed(...)`; `null`: `disabled`. */
  readonly feed: { readonly url: string } | null;
  /** The running app's version (`app.getVersion()`). */
  readonly currentVersion: string;
  /** `updatePlatformKey(process.platform, process.arch)`; `null`: nothing is ever offered. */
  readonly platformKey: UpdatePlatform | null;
  /** How a ready update installs (default `CURRENT_INSTALL_MODE`, `manual`). */
  readonly installMode?: UpdateInstallMode;
  /** `app.getPath('userData')`: downloads go to its `updates/`. */
  readonly userData: string;
  readonly prefs: UpdatePrefsStore;
  /** Main: `netTransport(net, updateSession)`. */
  readonly hop: UpdateHop;
  /** Main: `netResolve(updateSession)`. */
  readonly resolve: UpdateResolve;
  readonly isPackaged: boolean;
  /** `resolveTrustedKeys(...)` (default `UPDATE_PUBLIC_KEYS`). */
  readonly keys?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timers?: UpdateTimers;
  readonly log?: (message: string) => void;
}

/** What the last check found (main-only; tests and logs): `decide`'s kind, or why it failed. */
export type UpdateCheckOutcome =
  | { readonly kind: 'decided'; readonly decision: UpdateDecisionKind; readonly version: string }
  | { readonly kind: 'failed'; readonly reason: UpdateErrorReason; readonly detail?: UpdateGetFailure | UpdateVerifyReason | DownloadFailure };

export interface UpdateClient {
  /** The chrome-facing state. */
  state(): UpdateState;
  /** Answers once the state is newer than `sinceVersion` (at once if it is, or when `signal` aborts). */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<UpdateState>;
  /** Checks now (a user action; works with checks `off`), at most once per `manualMinIntervalMs`. */
  checkNow(): Promise<UpdateState>;
  /** Downloads and verifies the offer (only from `available`): the user's consent. */
  download(): Promise<UpdateState>;
  /** "Skip this version" (only from `available`, never for a required update). */
  skip(): Promise<UpdateState>;
  /** Turns automatic checks on or off (saved). */
  setChecks(checks: UpdateChecks): Promise<UpdateState>;
  /** Main-only: the verified file's path once `ready` ("Show file"), else `null`. Never sent to the chrome. */
  readyFile(): string | null;
  /** Main-only: what the last check found. */
  lastCheck(): UpdateCheckOutcome | null;
  /** Stops the schedule, any request, and answers every watcher. */
  dispose(): void;
}

const DEFAULT_TIMERS: UpdateTimers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The feed getter's failures, as the chrome is told. */
const feedReason = (reason: UpdateGetFailure): UpdateErrorReason => {
  switch (reason) {
    case 'too-large':
      return 'feed-too-large';
    case 'insecure-url':
    case 'insecure-redirect':
      return 'insecure-redirect';
    case 'private-address':
      return 'private-address';
    case 'sink':
      return 'internal';
    default:
      return 'feed-unreachable';
  }
};

/** The download's failures, as the chrome is told. */
const downloadReason = (reason: DownloadFailure): UpdateErrorReason => {
  switch (reason) {
    case 'too-large':
    case 'size-mismatch':
    case 'hash-mismatch':
    case 'private-address':
    case 'disk':
      return reason;
    case 'insecure-url':
    case 'insecure-redirect':
      return 'insecure-redirect';
    default:
      return 'download-failed';
  }
};

/** What `download()` may act on: the verified manifest and this platform's artifact. */
interface Offer {
  readonly manifest: UpdateManifest;
  readonly artifact: UpdateArtifact;
  readonly required: boolean;
}

class DiskError extends Error {}

export async function createUpdateClient(deps: UpdateClientDeps): Promise<UpdateClient> {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const keys = deps.keys ?? UPDATE_PUBLIC_KEYS;
  const installMode = deps.installMode ?? CURRENT_INSTALL_MODE;
  const log = deps.log ?? (() => undefined);
  const getDeps: UpdateGetDeps = { hop: deps.hop, resolve: deps.resolve, isPackaged: deps.isPackaged, userAgent: updateUserAgent(deps.currentVersion) };

  let prefs: UpdatePrefs = await deps.prefs.read();
  let status: UpdateStatus = deps.feed === null ? { kind: 'disabled' } : prefs.checks === 'off' ? { kind: 'off' } : { kind: 'idle' };
  let version = 1;
  let lastCheckedAt: string | null = null;
  let offer: Offer | null = null;
  let ready: string | null = null;
  let outcome: UpdateCheckOutcome | null = null;
  let lastCheckStart = Number.NEGATIVE_INFINITY;
  let checking: Promise<UpdateState> | null = null;
  let downloading: Promise<UpdateState> | null = null;
  let timer: unknown = null;
  let disposed = false;
  /** Aborts the request in flight (check or download) on dispose. */
  const lifetime = new AbortController();
  /** Pending watches, oldest first: their wake-up check → their early finish. */
  const waiters = new Map<() => void, () => void>();

  const snapshot = (): UpdateState => ({ version, currentVersion: deps.currentVersion, checks: prefs.checks, lastCheckedAt, status });
  const changed = (): void => {
    version += 1;
    for (const wake of [...waiters.keys()]) wake();
  };
  const set = (next: UpdateStatus): void => {
    status = next;
    changed();
  };
  const savePrefs = async (next: UpdatePrefs): Promise<void> => {
    try {
      await deps.prefs.write(next);
    } catch (error) {
      log(`update prefs could not be written (${error instanceof Error ? error.message : String(error)})`);
      throw new DiskError('prefs');
    }
    prefs = next;
  };
  const failCheck = (reason: UpdateErrorReason, detail?: UpdateGetFailure | UpdateVerifyReason): UpdateState => {
    offer = null;
    outcome = detail === undefined ? { kind: 'failed', reason } : { kind: 'failed', reason, detail };
    set({ kind: 'error', reason });
    return snapshot();
  };

  // ---- Schedule ----------------------------------------------------------------------------------

  const unschedule = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay: number): void => {
    unschedule();
    if (disposed || deps.feed === null || prefs.checks === 'off') return;
    timer = timers.setTimeout(() => {
      timer = null;
      void scheduledCheck();
    }, jittered(delay, random()));
  };
  async function scheduledCheck(): Promise<void> {
    if (disposed || prefs.checks === 'off') return;
    if (checking === null && downloading === null && ready === null) await check();
    schedule(UPDATE_SCHEDULE.intervalMs);
  }

  // ---- Check -------------------------------------------------------------------------------------

  /** Whether a verified manifest is below the mark (a replay). */
  const olderThanMark = (manifest: UpdateManifest, mark: NonNullable<UpdatePrefs['highWaterMark']>): boolean => {
    const order = compareVersions(manifest.version, mark.version);
    return order < 0 || (order === 0 && Date.parse(manifest.releasedAt) < Date.parse(mark.releasedAt));
  };
  const aboveMark = (manifest: UpdateManifest, mark: UpdatePrefs['highWaterMark']): boolean => {
    if (mark === undefined) return true;
    const order = compareVersions(manifest.version, mark.version);
    return order > 0 || (order === 0 && Date.parse(manifest.releasedAt) > Date.parse(mark.releasedAt));
  };

  async function runCheck(feedUrl: string): Promise<UpdateState> {
    lastCheckStart = now();
    set({ kind: 'checking' });
    try {
      const got = await getBytes(feedUrl, getDeps, { ...UPDATE_FETCH_LIMITS.envelope, maxBytes: MAX_ENVELOPE_BYTES, maxRedirects: UPDATE_FETCH_LIMITS.maxRedirects }, lifetime.signal);
      if (disposed) return snapshot();
      if (!got.ok) return failCheck(feedReason(got.reason), got.reason);
      const verified = verifyEnvelope(got.bytes, { now: now(), keys });
      if (!verified.ok) return failCheck(verified.reason === 'expired' || verified.reason === 'not-yet-valid' ? 'stale' : 'bad-envelope', verified.reason);
      const { manifest } = verified;
      if (prefs.highWaterMark !== undefined && olderThanMark(manifest, prefs.highWaterMark)) return failCheck('older-than-seen');
      const decision =
        deps.platformKey === null
          ? ({ kind: 'no-artifact', version: manifest.version } as const)
          : decide(manifest, { currentVersion: deps.currentVersion, platformKey: deps.platformKey, installId: prefs.installId, skippedVersion: prefs.skippedVersion });
      // A pre-release this build is never offered does not raise the mark (a later release hotfix below it must not look like a replay).
      if (decision.kind !== 'prerelease-ignored' && aboveMark(manifest, prefs.highWaterMark)) {
        await savePrefs({ ...prefs, highWaterMark: { version: manifest.version, releasedAt: manifest.releasedAt } });
      }
      lastCheckedAt = new Date(now()).toISOString();
      outcome = { kind: 'decided', decision: decision.kind, version: decision.version };
      if (decision.kind === 'available' || decision.kind === 'required') {
        offer = { manifest, artifact: decision.artifact, required: decision.kind === 'required' };
        set({ kind: 'available', version: decision.version, notes: decision.notes, releasedAt: decision.releasedAt, required: decision.kind === 'required', size: decision.artifact.size });
      } else {
        offer = null;
        // Nothing newer than what runs: no earlier download is of use any more.
        if (decision.kind === 'up-to-date') await pruneDownloads(deps.userData, null);
        set({ kind: 'up-to-date' });
      }
      return snapshot();
    } catch (error) {
      if (!(error instanceof DiskError)) log(`update check failed (${error instanceof Error ? error.message : String(error)})`);
      return failCheck(error instanceof DiskError ? 'disk' : 'internal');
    }
  }

  function check(): Promise<UpdateState> {
    const feed = deps.feed;
    if (feed === null || disposed) return Promise.resolve(snapshot());
    if (checking !== null) return checking;
    checking = runCheck(feed.url).finally(() => {
      checking = null;
    });
    return checking;
  }

  // ---- Download ----------------------------------------------------------------------------------

  async function runDownload(held: Offer, platformKey: UpdatePlatform): Promise<UpdateState> {
    const target = held.manifest.version;
    try {
      // The manifest must still be fresh now, not only when it was checked.
      if (checkFreshness(held.manifest, now()) !== null) {
        offer = null;
        set({ kind: 'error', reason: 'stale', version: target });
        return snapshot();
      }
      const total = held.artifact.size;
      const step = Math.max(1, Math.floor(total / UPDATE_PROGRESS_STEPS));
      let reported = 0;
      set({ kind: 'downloading', version: target, bytes: 0, total });
      const result = await downloadArtifact({
        userData: deps.userData,
        version: target,
        platformKey,
        artifact: held.artifact,
        get: getDeps,
        signal: lifetime.signal,
        onProgress: (bytes) => {
          if (bytes - reported < step || bytes >= total) return;
          reported = bytes;
          set({ kind: 'downloading', version: target, bytes, total });
        },
      });
      offer = null;
      if (disposed) return snapshot();
      if (!result.ok) {
        set({ kind: 'error', reason: downloadReason(result.reason), version: target });
        return snapshot();
      }
      ready = result.file;
      set({ kind: 'ready', version: target, install: installMode, fileName: path.basename(result.file) });
      return snapshot();
    } catch (error) {
      log(`update download failed (${error instanceof Error ? error.message : String(error)})`);
      offer = null;
      set({ kind: 'error', reason: 'internal', version: target });
      return snapshot();
    }
  }

  // ---- Start ---------------------------------------------------------------------------------------

  schedule(UPDATE_SCHEDULE.firstCheckMs);

  return {
    state: snapshot,

    watch(sinceVersion, signal) {
      // A version from the future is clamped: wait for the next change, not forever.
      const since = Math.min(sinceVersion, version);
      return new Promise((resolve) => {
        if (version > since || signal?.aborted || disposed) {
          resolve(snapshot());
          return;
        }
        const finish = (): void => {
          waiters.delete(wake);
          signal?.removeEventListener('abort', finish);
          resolve(snapshot());
        };
        const wake = (): void => {
          if (version > since || disposed) finish();
        };
        // At the cap the oldest waiter is answered early with the current state.
        while (waiters.size >= MAX_PENDING_UPDATE_WATCHES) {
          const oldest = waiters.values().next().value;
          if (!oldest) break;
          oldest();
        }
        waiters.set(wake, finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    },

    async checkNow() {
      if (deps.feed === null || disposed) return snapshot();
      if (checking !== null) return checking;
      if (downloading !== null || ready !== null) return snapshot();
      if (now() - lastCheckStart < UPDATE_SCHEDULE.manualMinIntervalMs) return snapshot();
      return check();
    },

    async download() {
      if (downloading !== null) return downloading;
      const held = offer;
      const platformKey = deps.platformKey;
      if (disposed || status.kind !== 'available' || held === null || platformKey === null) return snapshot();
      downloading = runDownload(held, platformKey).finally(() => {
        downloading = null;
      });
      return downloading;
    },

    async skip() {
      const held = offer;
      if (disposed || status.kind !== 'available' || held === null || held.required) return snapshot();
      try {
        await savePrefs({ ...prefs, skippedVersion: held.manifest.version });
      } catch {
        set({ kind: 'error', reason: 'disk' });
        return snapshot();
      }
      offer = null;
      outcome = { kind: 'decided', decision: 'skipped', version: held.manifest.version };
      set({ kind: 'up-to-date' });
      return snapshot();
    },

    async setChecks(checks) {
      if (disposed) return snapshot();
      try {
        await savePrefs({ ...prefs, checks });
      } catch {
        if (deps.feed !== null) set({ kind: 'error', reason: 'disk' });
        return snapshot();
      }
      if (deps.feed === null) {
        changed();
        return snapshot();
      }
      if (checks === 'off') {
        unschedule();
        // An offer, a check or download in flight, or a ready file stays; anything else rests at `off`.
        if (['idle', 'up-to-date', 'error', 'off'].includes(status.kind)) set({ kind: 'off' });
        else changed();
      } else {
        if (timer === null) schedule(UPDATE_SCHEDULE.firstCheckMs);
        if (status.kind === 'off') set({ kind: 'idle' });
        else changed();
      }
      return snapshot();
    },

    readyFile: () => ready,
    lastCheck: () => outcome,

    dispose() {
      if (disposed) return;
      disposed = true;
      unschedule();
      lifetime.abort();
      for (const finish of [...waiters.values()]) finish();
    },
  };
}
