import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SessionDatabase } from './client';
import type { SqlDriver } from './driver-types';
import * as schema from './schema';

// Drizzle over any `SqlDriver` (Phase 7 Task 6; acceptance `sync-driver.feature.md`): Drizzle's
// `sqlite-proxy` driver hands each built query, or batch of queries, to the driver. The result is
// the same `SessionDatabase` type `createDrizzle` answers, so every repository factory
// (`createSessionRepository`, `createHistoryRepository`, `createSettingsRepository`,
// `createContentNotesRepository`) runs unchanged over `node:sqlite` or libSQL. A batch runs in one
// driver transaction; Drizzle's own `transaction()` (which would `await` between statements) is
// not used.

/** A Drizzle database over `driver` (the driver stays the caller's to close). */
export function createDrizzleOver(driver: SqlDriver): SessionDatabase {
  return drizzle(
    async (sql, params, method) => (await driver.execute(sql, params, method)) as { rows: unknown[] },
    async (queries) => (await driver.batch(queries)) as { rows: unknown[] }[],
    { schema },
  );
}
