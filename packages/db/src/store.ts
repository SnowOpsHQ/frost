import { createDrizzle } from './client';
import { createChangeIntelRepository, type ChangeIntelRepository } from './change-intel/repository';
import { createContentNotesRepository, type ContentNotesRepository } from './content-notes';
import { createHistoryRepository, type HistoryRepository } from './history';
import { createSettingsRepository, type SettingsRepository } from './settings';
import { openSessionDatabase, type OpenOptions } from './open';
import { createSessionRepository, type SessionRepository } from './repository';
import { createSessionWriter, type SessionWriter, type WriterOptions } from './writer';

// The browser-session store main opens once at startup (spec `browser-session-db.feature.md`).

export interface SessionStore {
  /** The database file in use, or `':memory:'` (nothing persists this run). */
  readonly file: string;
  /** Reads (startup) and direct writes. */
  readonly repository: SessionRepository;
  /** Batched writes while the app runs. */
  readonly writer: SessionWriter;
  /** The Content panel's target queries and snippet drafts (Phase 2.5 Task 3), written at once. */
  readonly contentNotes: ContentNotesRepository;
  /** Browser polish (Phase 2.5 Task 6): the History view's reads and deletes, and local preferences. */
  readonly history: HistoryRepository;
  readonly settings: SettingsRepository;
  /** Change intelligence (Phase 6): captures, versions, diffs, screenshots, projects and audited purges. */
  readonly changeIntel: ChangeIntelRepository;
  /** Whether the database is still open (`close()` closes it). */
  readonly isOpen: boolean;
  /** Flushes pending writes, then closes the database (idempotent; never rejects). */
  close(): Promise<void>;
}

export type SessionStoreOptions = OpenOptions & Pick<WriterOptions, 'batchMs' | 'setTimer' | 'clearTimer'>;

export function openSessionStore(options: SessionStoreOptions): SessionStore {
  const { db, file } = openSessionDatabase(options);
  const drizzle = createDrizzle(db);
  const repository = createSessionRepository(drizzle);
  const writer = createSessionWriter(repository, options);
  let closing: Promise<void> | null = null;
  return {
    file,
    repository,
    writer,
    contentNotes: createContentNotesRepository(drizzle),
    history: createHistoryRepository(drizzle),
    settings: createSettingsRepository(drizzle),
    changeIntel: createChangeIntelRepository(drizzle),
    get isOpen() {
      return db.isOpen;
    },
    close() {
      closing ??= writer.flush().then(() => {
        try {
          db.close();
        } catch {
          // Already closed.
        }
      });
      return closing;
    },
  };
}
