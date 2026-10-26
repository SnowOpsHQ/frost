// `@app/db`: the local browser-session database (spec `specs/browser-session-db.feature.md`).
// Main process only: it opens `node:sqlite`. Never import it from the renderer or the preload.
export { createDrizzle, type SessionDatabase } from './client';
export { MIGRATIONS, runMigrations, type Migration } from './migrations';
export { openSessionDatabase, type OpenedDatabase, type OpenOptions } from './open';
export {
  createSessionRepository,
  sessionFromRows,
  type SavedSession,
  type SessionRepository,
  type SessionTab,
  type SessionWrite,
  type StoredDecision,
  type Visit,
  type VisitUpdate,
} from './repository';
export { openSessionStore, type SessionStore, type SessionStoreOptions } from './store';
export { storableOrigin, storableTitle, storableUrl } from './values';
export { createSessionWriter, type SessionWriter, type WriterOptions } from './writer';
