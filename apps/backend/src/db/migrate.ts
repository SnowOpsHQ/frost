import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { queryRows, type Database } from './client';

// Forward-only migrations (`specs/account-backend.feature.md`, Migrations). Each migration is one
// file `drizzle/NNNN_name.sql`; files apply in name order, each statement separated by a
// `--> statement-breakpoint` line (Drizzle's convention, so both drivers run one statement at a
// time). The run is one transaction under a Postgres advisory lock, so two processes starting at
// once cannot both apply, and a failing statement leaves nothing half-applied. Every applied file is
// recorded in `schema_migrations` with a SHA-256 of its SQL: an applied file that changed, one that
// disappeared, or a new file numbered before the latest applied one refuses to migrate.

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));
export const MIGRATIONS_TABLE = 'schema_migrations';

const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const BREAKPOINT = /^\s*-->\s*statement-breakpoint\s*$/m;
/** Arbitrary, fixed: the advisory lock every migrator of this database takes. */
const LOCK_KEY = 42_030_719;

export interface Migration {
  /** The file name without `.sql`: zero-padded number, then a snake_case name. */
  readonly id: string;
  readonly sql: string;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/** The migration files in `dir`, in apply order. Any other `.sql` file is refused. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  const numbers = new Set<string>();
  for (const name of names) {
    const id = FILE_PATTERN.exec(name)?.[1];
    if (!id) throw new MigrationError(`migration file name not NNNN_name.sql: ${name}`);
    const number = id.slice(0, 4);
    if (numbers.has(number)) throw new MigrationError(`two migrations numbered ${number}`);
    numbers.add(number);
    migrations.push({ id, sql: await readFile(join(dir, name), 'utf8') });
  }
  return migrations;
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function statements(text: string): string[] {
  return text
    .split(BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')));
}

/** Applies every pending migration; answers the ids it applied (none when up to date). */
export async function migrate(db: Database, migrations?: readonly Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const ids = all.map((m) => m.id);
  if (ids.some((id, i) => i > 0 && id <= (ids[i - 1] ?? ''))) throw new MigrationError('migrations are not in strictly increasing order');

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`));
    await tx.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`),
    );
    const applied = await queryRows<{ id: string; checksum: string }>(tx, sql.raw(`SELECT id, checksum FROM ${MIGRATIONS_TABLE} ORDER BY id`));
    const byId = new Map(all.map((m) => [m.id, m]));
    for (const row of applied) {
      const known = byId.get(row.id);
      if (!known) throw new MigrationError(`applied migration ${row.id} is missing from this build`);
      if (checksum(known.sql) !== row.checksum) throw new MigrationError(`applied migration ${row.id} was edited; add a new migration instead`);
    }
    const appliedIds = new Set(applied.map((row) => row.id));
    const latest = applied.at(-1)?.id ?? '';
    const pending = all.filter((m) => !appliedIds.has(m.id));
    for (const m of pending) {
      if (m.id < latest) throw new MigrationError(`migration ${m.id} is numbered before the applied ${latest}`);
      for (const statement of statements(m.sql)) await tx.execute(sql.raw(statement));
      await tx.execute(sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (id, checksum) VALUES (${m.id}, ${checksum(m.sql)})`);
    }
    return pending.map((m) => m.id);
  });
}
