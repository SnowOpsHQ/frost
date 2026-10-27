// `@app/db`: the local browser-session database (spec `specs/browser-session-db.feature.md`).
// Main process only: it opens `node:sqlite`. Never import it from the renderer or the preload.
// Main uses the store (`openSessionStore`) and the shapes it loads; the schema, migrations,
// repository and writer are the package's own (its tests import them from their modules).
export type { SavedSession, StoredDecision, StoredRenderProfilePin } from './repository';
export type { ContentNotes, ContentNotesRepository, SnippetVariant } from './content-notes';
export { openSessionStore, type SessionStore } from './store';
