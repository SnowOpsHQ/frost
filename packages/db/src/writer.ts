import { MAX_RECENT_VISITS, SESSION_WRITE_BATCH_MS } from '@app/specs/browser-session-db.spec';
import type { RenderProfile } from '@app/specs/render-profile.spec';
import type { SavedSession, SessionRepository, StoredDecision, VisitUpdate } from './repository';

// Batched writes (spec `browser-session-db.feature.md`, Batched writes). The tab strip and visits
// are held in memory and written together at most once per `SESSION_WRITE_BATCH_MS`; permission
// decisions are written at once. Writes never throw into the caller: each kind of failure is
// logged once.

export interface SessionWriter {
  /** The latest tab strip (replaces any pending one). */
  saveSession(session: SavedSession): void;
  /** A committed visit to `url`, now. */
  recordVisit(url: string): void;
  /** The latest title of `url`'s page (updates its visit only; never creates one). */
  updateVisitTitle(url: string, title: string): void;
  /** Remembers a Block (written at once). */
  savePermissionDecision(decision: StoredDecision): void;
  /** Pins a render profile to `origin` (written at once; `render-profile.feature.md`). */
  saveRenderProfilePin(origin: string, profile: RenderProfile): void;
  /** Removes `origin`'s pinned render profile (written at once). */
  deleteRenderProfilePin(origin: string): void;
  /**
   * Clear Browsing Data: drops the visits still pending (never written), then, after every earlier
   * write, deletes every stored visit and decision. A pending tab strip is kept (and written as
   * usual). Resolves once done; never rejects.
   */
  clearBrowsingData(): Promise<void>;
  /** Writes everything pending now; resolves once it (and every earlier write) is done. */
  flush(): Promise<void>;
}

export interface WriterOptions {
  readonly now?: () => number;
  readonly batchMs?: number;
  /** Reports a failed write, once per kind of failure (`failureKind`). */
  readonly log?: (message: string) => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface PendingVisit {
  visits: number;
  lastVisitAt: number;
  title: string;
}

/**
 * What kind of failure `error` is, for logging each kind once: SQLite's primary result code
 * (disk full, I/O error, busy, …), else the message.
 */
function failureKind(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { errcode?: unknown }).errcode : undefined;
  if (typeof code === 'number') return `sqlite:${code & 0xff}`;
  return `error:${error instanceof Error ? error.message : String(error)}`;
}

/** At most this many distinct failure kinds are reported (a flood of distinct messages stays bounded). */
const MAX_REPORTED_FAILURE_KINDS = 20;

export function createSessionWriter(repository: SessionRepository, options: WriterOptions = {}): SessionWriter {
  const now = options.now ?? Date.now;
  const batchMs = options.batchMs ?? SESSION_WRITE_BATCH_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const log = options.log ?? (() => {});

  let session: SavedSession | undefined;
  /** Pending visits by URL, oldest first (bounded: the table keeps no more anyway). */
  const visits = new Map<string, PendingVisit>();
  let timer: unknown = null;
  /** Every write started and not yet settled (they run one after another). */
  let tail: Promise<void> = Promise.resolve();
  /** Failure kinds already reported. */
  const reported = new Set<string>();

  /** Runs `write` after every earlier one; it never rejects. */
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    tail = tail.then(write).catch((error: unknown) => {
      const kind = failureKind(error);
      if (reported.has(kind) || reported.size >= MAX_REPORTED_FAILURE_KINDS) return;
      reported.add(kind);
      log(`browser-session write failed (${error instanceof Error ? error.message : String(error)}); further failures of this kind are not reported`);
    });
    return tail;
  };

  const takeBatch = (): { session?: SavedSession; visits: VisitUpdate[] } | null => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (session === undefined && visits.size === 0) return null;
    const batch = { ...(session ? { session } : {}), visits: [...visits].map(([url, visit]) => ({ url, ...visit })) };
    session = undefined;
    visits.clear();
    return batch;
  };

  const writeBatch = (): Promise<void> => {
    const batch = takeBatch();
    return batch === null ? tail : enqueue(() => repository.write(batch));
  };

  const schedule = (): void => {
    if (timer === null) timer = setTimer(() => void writeBatch(), batchMs);
  };

  /** Adds a pending entry for `url`, dropping the oldest one at the cap. */
  const addVisit = (url: string, visit: PendingVisit): void => {
    if (visits.size >= MAX_RECENT_VISITS) {
      const oldest = visits.keys().next().value;
      if (oldest !== undefined) visits.delete(oldest);
    }
    visits.set(url, visit);
  };

  return {
    saveSession(next) {
      session = next;
      schedule();
    },

    recordVisit(url) {
      const at = now();
      const pending = visits.get(url);
      if (pending) {
        pending.visits += 1;
        pending.lastVisitAt = at;
      } else {
        addVisit(url, { visits: 1, lastVisitAt: at, title: '' });
      }
      schedule();
    },

    updateVisitTitle(url, title) {
      const pending = visits.get(url);
      if (pending) pending.title = title;
      else addVisit(url, { visits: 0, lastVisitAt: 0, title });
      schedule();
    },

    savePermissionDecision(decision) {
      const at = now();
      void enqueue(() => repository.savePermissionDecision(decision, at));
    },

    saveRenderProfilePin(origin, profile) {
      const at = now();
      void enqueue(() => repository.saveRenderProfilePin(origin, profile, at));
    },

    deleteRenderProfilePin(origin) {
      void enqueue(() => repository.deleteRenderProfilePin(origin));
    },

    clearBrowsingData() {
      visits.clear();
      return enqueue(() => repository.clearBrowsingData());
    },

    flush: writeBatch,
  };
}
