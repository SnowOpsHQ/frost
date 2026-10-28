import { MIGRATIONS_TABLE } from '@app/specs/browser-session-db.spec';
import type { SqlDriver } from './driver-types';
import { MIGRATIONS, type Migration } from './migrations';

// The forward-only migrations of `migrations.ts` over any `SqlDriver` (Phase 7 Task 6; acceptance
// `sync-driver.feature.md`, Same migrations; spec `browser-session-db.feature.md`, Migrations).
// The same `MIGRATIONS` list and `MIGRATIONS_TABLE` ledger, with `runMigrations`' rules; only the
// calls are async.

/**
 * Applies, in order, every migration of `migrations` whose id `MIGRATIONS_TABLE` lacks, each in its
 * own transaction with its id row (a failure rolls that migration back and rejects). Ids recorded
 * but unknown here (a newer build's) are left alone. Answers the ids it applied.
 */
export async function runMigrationsOver(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS, now: () => number = Date.now): Promise<string[]> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`);
  const { rows } = await driver.execute(`SELECT id FROM ${MIGRATIONS_TABLE}`, [], 'values');
  const recorded = new Set((rows as unknown[][]).map((row) => String(row[0])));
  const applied: string[] = [];
  for (const migration of migrations) {
    if (recorded.has(migration.id)) continue;
    await driver.batch([{ script: migration.sql }, { sql: `INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`, params: [migration.id, now()], method: 'run' }]);
    applied.push(migration.id);
  }
  return applied;
}
