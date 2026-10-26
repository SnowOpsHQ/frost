import { openSessionStore, type SavedSession, type SessionStore, type StoredDecision } from '@app/db';

// The browser-session database in main (spec `browser-session-db.feature.md`): opened once at
// startup in `userData`, read before the first window, written through the batched writer while
// the app runs, and flushed before the app quits. Never imported outside the main process.

export interface SavedState {
  readonly session: SavedSession;
  readonly decisions: readonly StoredDecision[];
}

const EMPTY_STATE: SavedState = { session: { tabs: [{ url: '', title: '' }], activeIndex: 0 }, decisions: [] };

/** Opens `<userData>/DB_FILE_NAME` (a corrupt or unusable file is handled there; see `@app/db`). */
export function openBrowserSessionStore(userData: string, log: (message: string) => void): SessionStore {
  return openSessionStore({ dir: userData, log });
}

/** What the last launch saved; nothing (one empty tab) if it cannot be read. Never rejects. */
export async function loadSavedState(store: SessionStore, log: (message: string) => void): Promise<SavedState> {
  try {
    const [session, decisions] = await Promise.all([store.repository.loadSession(), store.repository.loadPermissionDecisions()]);
    return { session, decisions };
  } catch (error) {
    log(`browser-session database could not be read (${error instanceof Error ? error.message : String(error)}); starting with an empty session`);
    return EMPTY_STATE;
  }
}

/** The parts of Electron's `app` the quit flush uses. */
export interface QuittingApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Holds the first `will-quit` until the store's pending writes are flushed and it is closed, then
 * quits again (that second `will-quit` passes). Writes are synchronous underneath, so the hold is
 * a few milliseconds; a failed flush still quits.
 */
export function flushBeforeQuit(app: QuittingApp, store: Pick<SessionStore, 'close'>): void {
  let closed = false;
  app.on('will-quit', (event) => {
    if (closed) return;
    event.preventDefault();
    void store
      .close()
      .catch(() => undefined)
      .then(() => {
        closed = true;
        // From a task of its own: a quit made from a microtask still runs inside Electron's
        // `will-quit` dispatch (microtasks drain before it returns) and is ignored.
        setImmediate(() => app.quit());
      });
  });
}
