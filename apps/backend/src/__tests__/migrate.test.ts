import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openMemoryDatabase, queryRows, type DatabaseHandle } from '../db/client';
import { loadMigrations, migrate, MigrationError } from '../db/migrate';

// Acceptance: specs/account-backend.feature.md (Migrations).

let handle: DatabaseHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function tables(h: DatabaseHandle): Promise<string[]> {
  const rows = await queryRows<{ table_name: string }>(
    h.db,
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

describe('migrations', () => {
  it('migrations-apply-in-order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    const ids = migrations.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    for (const id of ids) expect(id).toMatch(/^\d{4}_[a-z0-9_]+$/);

    handle = await openMemoryDatabase();
    expect(await migrate(handle.db, migrations)).toEqual(ids);
    expect(await tables(handle)).toEqual(expect.arrayContaining(['accounts', 'schema_migrations', 'sessions', 'users', 'verifications']));
  });

  it('migrations-are-idempotent', async () => {
    handle = await openMemoryDatabase();
    await migrate(handle.db);
    expect(await migrate(handle.db)).toEqual([]);
  });

  it('migration-edit-refused', async () => {
    handle = await openMemoryDatabase();
    const migrations = await loadMigrations();
    await migrate(handle.db, migrations);
    const [first, ...rest] = migrations;
    if (!first) throw new Error('no migrations');
    const edited = [{ ...first, sql: `${first.sql}\n-- edited` }, ...rest];
    await expect(migrate(handle.db, edited)).rejects.toThrow(MigrationError);
    await expect(migrate(handle.db, edited)).rejects.toThrow(first.id);
  });
});
