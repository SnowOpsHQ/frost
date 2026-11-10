// Change intelligence in the session database (Phase 6 Task 1; spec `specs/capture-db.feature.md`):
// the repository the store exposes as `changeIntel`, its shapes, and the UUIDv7 ids main makes rows with.
// Phase 10 (`specs/workspace-db.feature.md`) adds the SERP readings and the project workspace to it.
export { isUuidv7, uuidv7 } from './ids';
export type * from './repository';
