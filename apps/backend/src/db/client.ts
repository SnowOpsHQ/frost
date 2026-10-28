import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { SQL } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { schema, type Schema } from './schema';

/** The backend's Drizzle database: PGlite (tests, dev without `DATABASE_URL`) or node-postgres. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/** A throwaway in-memory PGlite (tests). */
export async function openMemoryDatabase(): Promise<DatabaseHandle> {
  const client = await PGlite.create();
  return { db: drizzlePglite({ client, schema }), kind: 'pglite', close: () => client.close() };
}

/** A PGlite database persisted in `dataDir` (local development without Postgres). */
export async function openPgliteDatabase(dataDir: string): Promise<DatabaseHandle> {
  mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  return { db: drizzlePglite({ client, schema }), kind: 'pglite', close: () => client.close() };
}

/** Pool bounds: a stuck database answers errors (and `/healthz` 503) instead of hanging requests. */
export const POSTGRES_POOL_LIMITS = { max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statementTimeoutMillis: 15_000 } as const;

/** A real Postgres through a node-postgres pool. The URL is never logged. */
export function openPostgresDatabase(connectionString: string): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: POSTGRES_POOL_LIMITS.max,
    connectionTimeoutMillis: POSTGRES_POOL_LIMITS.connectionTimeoutMillis,
    idleTimeoutMillis: POSTGRES_POOL_LIMITS.idleTimeoutMillis,
    // Server-side cap, and the client-side one for when the server itself stops answering.
    statement_timeout: POSTGRES_POOL_LIMITS.statementTimeoutMillis,
    query_timeout: POSTGRES_POOL_LIMITS.statementTimeoutMillis + 1_000,
  });
  // An idle client's error (the server restarted, the network dropped) would otherwise crash the
  // process. The name only: a driver error can carry connection details.
  pool.on('error', (error) => console.error(`[backend] postgres pool error: ${error.name}`));
  return { db: drizzleNodePg({ client: pool, schema }), kind: 'postgres', close: () => pool.end() };
}

/** `DATABASE_URL` when set, else the PGlite directory. */
export function openDatabase(env: { readonly DATABASE_URL?: string | undefined; readonly PGLITE_DIR: string }): Promise<DatabaseHandle> {
  return env.DATABASE_URL ? Promise.resolve(openPostgresDatabase(env.DATABASE_URL)) : openPgliteDatabase(env.PGLITE_DIR);
}

/**
 * Rows of a raw query. Both drivers answer an object with `rows` (PGlite's `Results`, node-postgres's
 * `QueryResult`), which Drizzle's driver-neutral `PgDatabase` type cannot express.
 */
export async function queryRows<TRow extends Record<string, unknown>>(db: Database, query: SQL): Promise<TRow[]> {
  const result: unknown = await db.execute(query);
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('unexpected query result');
  return rows as TRow[];
}
