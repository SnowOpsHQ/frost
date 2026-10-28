import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isScript, type SqlBatchItem, type SqlDriver, type SqlMethod, type SqlResult } from './driver-types';

// The `node:sqlite` driver (Phase 7 Task 6; spec `sync.spec.ts`, `DEFAULT_DB_DRIVER`): Node's
// built-in `DatabaseSync`, as the browser-session database has always been queried (`client.ts`
// delegates here). Each call runs synchronously on the handle; rows go back as arrays
// (`setReturnArrays`). A batch runs in one transaction inside one call, so nothing else can
// interleave with it (Drizzle's `transaction()` would `await` between statements; it is not used).

function execute(db: DatabaseSync, sql: string, params: readonly unknown[], method: SqlMethod): SqlResult {
  const statement = db.prepare(sql);
  const values = params as SQLInputValue[];
  if (method === 'run') {
    statement.run(...values);
    return { rows: [] };
  }
  statement.setReturnArrays(true);
  if (method === 'get') return { rows: statement.get(...values) ?? undefined };
  return { rows: statement.all(...values) };
}

/** Rolls back a transaction `db` still has open (a failed batch, or a script that began one). */
function rollBackOpen(db: DatabaseSync): void {
  if (db.isOpen && db.isTransaction) db.exec('ROLLBACK');
}

/**
 * A driver over `db`. Only `close()` closes the handle; until it is called the handle is the
 * caller's too (`createDrizzle` never calls it, so there `db` stays the caller's to close).
 */
export function createNodeSqliteDriver(db: DatabaseSync): SqlDriver {
  const run = (item: SqlBatchItem): SqlResult => {
    if (!isScript(item)) return execute(db, item.sql, item.params, item.method);
    db.exec(item.script);
    if (!db.isTransaction) throw new Error('a batch script ended its transaction');
    return { rows: [] };
  };

  return {
    kind: 'node-sqlite',
    get isOpen() {
      return db.isOpen;
    },
    execute: async (sql, params, method) => execute(db, sql, params, method),
    async batch(items) {
      if (items.length === 0) return [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = items.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        rollBackOpen(db);
        throw error;
      }
    },
    async exec(script) {
      try {
        db.exec(script);
      } catch (error) {
        rollBackOpen(db);
        throw error;
      }
      // As libSQL's pool does: a connection never stays inside a transaction a script left open.
      rollBackOpen(db);
    },
    async close() {
      try {
        if (db.isOpen) db.close();
      } catch {
        // Already closed.
      }
    },
  };
}
