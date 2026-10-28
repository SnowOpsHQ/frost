import type { DatabaseSync } from 'node:sqlite';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { createDrizzleOver } from './driver-drizzle';
import { createNodeSqliteDriver } from './driver-node-sqlite';
import type * as schema from './schema';

// Drizzle over Node's built-in `node:sqlite`. Drizzle 0.45 has no `node:sqlite` driver, so its
// `sqlite-proxy` driver hands each built query to the `node:sqlite` driver
// (`driver-node-sqlite.ts`, Phase 7's driver seam), which runs it on the `DatabaseSync` handle
// synchronously. Rows go back as arrays (`setReturnArrays`), as the proxy driver expects. A batch
// runs in one transaction, inside one callback: nothing else can interleave with it (Drizzle's
// `transaction()` would `await` between statements; it is not used).

export type SessionDatabase = SqliteRemoteDatabase<typeof schema>;

/**
 * A Drizzle database over `db`. The handle stays the caller's to close: the driver wrapping it is
 * never closed here, and Drizzle never closes it.
 */
export function createDrizzle(db: DatabaseSync): SessionDatabase {
  return createDrizzleOver(createNodeSqliteDriver(db));
}
