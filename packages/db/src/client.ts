import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

// Drizzle over Node's built-in `node:sqlite`. Drizzle 0.45 has no `node:sqlite` driver, so its
// `sqlite-proxy` driver hands each built query to these callbacks, which run it on the
// `DatabaseSync` handle synchronously. Rows go back as arrays (`setReturnArrays`), as the proxy
// driver expects. A batch runs in one transaction, inside one callback: nothing else can
// interleave with it (Drizzle's `transaction()` would `await` between statements; it is not used).

export type SessionDatabase = SqliteRemoteDatabase<typeof schema>;

type Method = 'run' | 'all' | 'values' | 'get';

function execute(db: DatabaseSync, sql: string, params: unknown[], method: Method): { rows: unknown[] } {
  const statement = db.prepare(sql);
  const values = params as SQLInputValue[];
  if (method === 'run') {
    statement.run(...values);
    return { rows: [] };
  }
  statement.setReturnArrays(true);
  if (method === 'get') return { rows: (statement.get(...values) ?? undefined) as unknown as unknown[] };
  return { rows: statement.all(...values) as unknown[] };
}

/** A Drizzle database over `db` (its own handle stays the caller's to close). */
export function createDrizzle(db: DatabaseSync): SessionDatabase {
  return drizzle(
    async (sql, params, method) => execute(db, sql, params, method),
    async (queries) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = queries.map(({ sql, params, method }) => execute(db, sql, params, method));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    { schema },
  );
}
