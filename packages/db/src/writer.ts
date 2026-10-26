import { MAX_RECENT_VISITS, SESSION_WRITE_BATCH_MS } from '@app/specs/browser-session-db.spec';
import type { SavedSession, SessionRepository, StoredDecision, VisitUpdate } from './repository';

// Batched writes (spec `browser-session-db.feature.md`, Batched writes). The tab strip and visits
// are held in memory and written together at most once per `SESSION_WRITE_BATCH_MS`; permission
// decisions are written at once. Writes never throw into the caller: a failure is logged once.

export interface SessionWriter {
  /** The latest tab strip (replaces any pending one). */
  saveSession(session: SavedSession): void;
  /** A committed visit to `url`, now. */
  recordVisit(url: string): void;
  /** The latest title of `url`'s page (updates its visit only; never creates one). */
  updateVisitTitle(url: string, title: string): void;
  /** Remembers a decision (written at once). */
  savePermissionDecision(decision: StoredDecision): void;
  /** Writes everything pending now; resolves once it (and every earlier write) is done. */
  flush(): Promise<void>;
}

export interface WriterOptions {
  readonly now?: () => number;
  readonly batchMs?: number;
  /** Reports the first failed write (later failures are not reported again). */
  readonly log?: (message: string) => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

interface PendingVisit {
  visits: number;
  lastVisitAt: number;
  title: string;
}

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
  let failed = false;

  /** Runs `write` after every earlier one; it never rejects. */
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    tail = tail.then(write).catch((error: unknown) => {
      if (failed) return;
      failed = true;
      log(`browser-session write failed (${error instanceof Error ? error.message : String(error)}); later failures are not reported`);
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

    flush: writeBatch,
  };
}
