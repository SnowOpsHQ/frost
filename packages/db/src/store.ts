import { createDrizzle } from './client';
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
  /** Flushes pending writes, then closes the database (idempotent; never rejects). */
  close(): Promise<void>;
}

export type SessionStoreOptions = OpenOptions & Pick<WriterOptions, 'batchMs' | 'setTimer' | 'clearTimer'>;

export function openSessionStore(options: SessionStoreOptions): SessionStore {
  const { db, file } = openSessionDatabase(options);
  const repository = createSessionRepository(createDrizzle(db));
  const writer = createSessionWriter(repository, options);
  let closing: Promise<void> | null = null;
  return {
    file,
    repository,
    writer,
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
