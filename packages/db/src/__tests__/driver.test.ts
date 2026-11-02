// Spec: specs/sync.spec.ts (DB_DRIVER_IDS, DEFAULT_DB_DRIVER, SYNC_REPLICA_FILE_NAME, LIBSQL_*,
// libsqlConfigProblem), specs/browser-session-db.spec.ts (MIGRATIONS_TABLE, MAX_RECENT_VISITS),
// specs/browser-polish.spec.ts (HISTORY_PAGE_SIZE, DEFAULT_SEARCH_ENGINE)
// Acceptance: specs/sync-driver.feature.md
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_RECENT_VISITS, MIGRATIONS_TABLE } from '@app/specs/browser-session-db.spec';
import { DEFAULT_SEARCH_ENGINE, HISTORY_PAGE_SIZE } from '@app/specs/browser-polish.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import {
  DB_DRIVER_IDS,
  DEFAULT_DB_DRIVER,
  LIBSQL_INT_MODE,
  LIBSQL_SQLITE_VERSION,
  MAX_LIBSQL_AUTH_TOKEN_CHARS,
  MAX_LIBSQL_URL_CHARS,
  SYNC_REPLICA_FILE_NAME,
  libsqlConfigProblem,
  libsqlFilePath,
  type DbDriverId,
  type LibsqlConfig,
  type LibsqlConfigProblem,
} from '@app/specs/sync.spec';
import { createContentNotesRepository, EMPTY_NOTES } from '../content-notes';
import { createDrizzleOver } from '../driver-drizzle';
import { LibsqlConfigError, libsqlFileUrl, openLibsqlDriver } from '../driver-libsql';
import { runMigrationsOver } from '../driver-migrations';
import { createNodeSqliteDriver } from '../driver-node-sqlite';
import type { SqlDriver } from '../driver-types';
import { createHistoryRepository } from '../history';
import { MIGRATIONS, runMigrations, type Migration } from '../migrations';
import { createSessionRepository, type StoredDecision } from '../repository';
import { createSettingsRepository } from '../settings';

// Real SQLite files on both drivers: Windows runners are slow at file I/O under a parallel load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Counts how often `@libsql/client` (its local `sqlite3` entry, what the driver imports) is loaded (its real module is still what loads).
const libsqlLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@libsql/client/sqlite3', async (importOriginal) => {
  libsqlLoads.count += 1;
  return importOriginal();
});

interface DriverCase {
  readonly kind: DbDriverId;
  open(file: string): Promise<SqlDriver>;
}

const DRIVERS: readonly DriverCase[] = [
  { kind: 'node-sqlite', open: async (file) => createNodeSqliteDriver(new DatabaseSync(file)) },
  { kind: 'libsql', open: (file) => openLibsqlDriver({ url: libsqlFileUrl(file) }) },
];

let dir: string;
const opened: SqlDriver[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-driver-'));
});

afterEach(async () => {
  for (const driver of opened.splice(0)) await driver.close();
  removeTempDir(dir);
});

/**
 * Removes a test's directory. On Windows a closed database's file can stay locked for a moment
 * (libSQL's native handle is released after `close()` returns), so removal retries, and a file
 * still locked there is left to the OS temp cleaner rather than failing the test.
 */
function removeTempDir(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
  }
}

async function openIn(driverCase: DriverCase, name = 'test.db'): Promise<SqlDriver> {
  const driver = await driverCase.open(path.join(dir, name));
  opened.push(driver);
  return driver;
}

/** Every row of `sql`, as arrays. */
async function all(driver: SqlDriver, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return (await driver.execute(sql, params, 'all')).rows as unknown[][];
}

const count = async (driver: SqlDriver, table: string) => Number((await all(driver, `SELECT count(*) FROM ${table}`))[0]![0]);

// First, before any libSQL driver in this file has been opened.
describe('libsql-not-loaded-by-default', () => {
  test('libsql-not-loaded-by-default', async () => {
    vi.resetModules();
    const before = libsqlLoads.count;
    const index = await import('../index');
    expect(index.openSessionStore).toBeTypeOf('function');
    expect(libsqlLoads.count).toBe(before);

    // No module the index reaches imports libSQL, so neither does a bundle of it (Vite never sees it).
    const reached = importGraph(path.join(here, '../index.ts'));
    expect([...reached.files].map((file) => path.basename(file))).not.toContain('driver-libsql.ts');
    expect([...reached.files].map((file) => path.basename(file))).toContain('client.ts');
    expect([...reached.packages].filter((name) => /libsql/.test(name))).toEqual([]);

    // The spy does see a load: opening a libSQL driver loads it.
    const { openLibsqlDriver: open } = await import('../driver-libsql');
    const driver = await open({ url: libsqlFileUrl(path.join(dir, 'loaded.db')) });
    opened.push(driver);
    expect(libsqlLoads.count).toBeGreaterThan(before);
    expect(driver.kind).toBe('libsql');
  });
});

describe('driver ids', () => {
  test('drivers-are-named', async () => {
    expect(DB_DRIVER_IDS).toEqual(['node-sqlite', 'libsql']);
    expect(DEFAULT_DB_DRIVER).toBe('node-sqlite');
    expect(LIBSQL_INT_MODE).toBe('number');
    for (const driverCase of DRIVERS) {
      const driver = await openIn(driverCase, `${driverCase.kind}.db`);
      expect(driver.kind).toBe(driverCase.kind);
      expect(driver.isOpen).toBe(true);
      // Phase 6's `_no_replace` guards rely on recursive triggers being off: so they are, on both.
      expect(await all(driver, 'PRAGMA recursive_triggers')).toEqual([[0]]);
      const [[version]] = (await all(driver, 'SELECT sqlite_version()')) as [[string]];
      if (driverCase.kind === 'libsql') expect(version).toBe(LIBSQL_SQLITE_VERSION);
      // `node:sqlite` is the newer SQLite: what both run is what 3.45 supports.
      else expect(version.localeCompare(LIBSQL_SQLITE_VERSION, 'en', { numeric: true })).toBeGreaterThan(0);
      await driver.close();
      await driver.close();
      expect(driver.isOpen).toBe(false);
    }
  });
});

describe.each(DRIVERS)('drivers-run-the-same-repositories ($kind)', (driverCase) => {
  let driver: SqlDriver;
  let db: ReturnType<typeof createDrizzleOver>;

  beforeEach(async () => {
    driver = await openIn(driverCase);
    await runMigrationsOver(driver);
    db = createDrizzleOver(driver);
  });

  test('session', async () => {
    const repo = createSessionRepository(db);
    expect(await repo.loadSession()).toEqual({ tabs: [{ url: '', title: '' }], activeIndex: 0 });
    const session = {
      tabs: [
        { url: 'https://a.example/', title: 'A' },
        { url: '', title: '' },
        { url: 'http://127.0.0.1:8080/b?q=1#frag', title: 'B' },
      ],
      activeIndex: 2,
    };
    await repo.saveSession(session);
    expect(await repo.loadSession()).toEqual(session);
    await repo.saveSession({ tabs: [{ url: 'https://d.example/', title: 'D' }], activeIndex: 0 });
    expect(await repo.loadSession()).toEqual({ tabs: [{ url: 'https://d.example/', title: 'D' }], activeIndex: 0 });
    // Only browsable URLs are stored; userinfo never is.
    await repo.saveSession({ tabs: [{ url: 'file:///etc/passwd', title: 'f' }, { url: 'https://user:secret@a.example/p', title: 'p' }], activeIndex: 1 });
    expect(await all(driver, 'SELECT url, active FROM browser_tabs ORDER BY position')).toEqual([
      ['', 0],
      ['https://a.example/p', 1],
    ]);
  });

  test('visits', async () => {
    const repo = createSessionRepository(db);
    await repo.recordVisit('https://a.example/', 1_000);
    await repo.recordVisit('https://a.example/', 2_000);
    await repo.updateVisitTitle('https://a.example/', 'Page A');
    await repo.recordVisit('https://b.example/', 1_500, 'Page B');
    expect(await repo.recentVisits()).toEqual([
      { url: 'https://a.example/', title: 'Page A', visitCount: 2, lastVisitAt: 2_000 },
      { url: 'https://b.example/', title: 'Page B', visitCount: 1, lastVisitAt: 1_500 },
    ]);
    await repo.write({ visits: [{ url: 'https://a.example/', visits: 3, lastVisitAt: 500, title: '' }] });
    expect((await repo.recentVisits())[0]).toEqual({ url: 'https://a.example/', title: 'Page A', visitCount: 5, lastVisitAt: 2_000 });
    // Pruned to the cap, the oldest first.
    await repo.write({ visits: Array.from({ length: MAX_RECENT_VISITS + 10 }, (_, i) => ({ url: `https://v${i}.example/`, visits: 1, lastVisitAt: 10_000 + i, title: '' })) });
    const kept = await repo.recentVisits(MAX_RECENT_VISITS + 100);
    expect(kept).toHaveLength(MAX_RECENT_VISITS);
    expect(kept.at(-1)?.lastVisitAt).toBe(10_010);
  });

  test('permissions-and-pins', async () => {
    const repo = createSessionRepository(db);
    const block: StoredDecision = { origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'notifications', decision: 'block' };
    await repo.savePermissionDecision(block, 1);
    await repo.savePermissionDecision(block, 2);
    await repo.savePermissionDecision({ ...block, decision: 'allow' } as unknown as StoredDecision, 3);
    expect(await repo.loadPermissionDecisions()).toEqual([block]);
    const phoneBot: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
    await repo.saveRenderProfilePin('https://a.example', phoneBot, 4);
    expect(await repo.loadRenderProfilePins()).toEqual([{ origin: 'https://a.example', profile: phoneBot }]);
    const session = { tabs: [{ url: 'https://a.example/', title: 'A' }], activeIndex: 0 };
    await repo.write({ session, visits: [{ url: 'https://a.example/', visits: 1, lastVisitAt: 5, title: 'A' }] });
    await repo.clearBrowsingData();
    expect(await repo.recentVisits()).toEqual([]);
    expect(await repo.loadPermissionDecisions()).toEqual([]);
    expect(await repo.loadSession()).toEqual(session);
    expect(await repo.loadRenderProfilePins()).toEqual([]);
  });

  test('history', async () => {
    const plant = (url: string, title: string, visits: number, at: number) => driver.execute('INSERT INTO recent_visits (url, title, visit_count, last_visit_at) VALUES (?, ?, ?, ?)', [url, title, visits, at], 'run');
    for (let i = 0; i < 130; i++) await plant(`https://site.example/p${String(i).padStart(3, '0')}`, `Page ${i}`, i + 1, 1_000 + Math.floor(i / 2));
    await plant('https://shop.example/100%25', '100% cotton', 1, 1);
    const history = createHistoryRepository(db);
    const first = await history.list({ query: '', after: null });
    expect(first.visits).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.visits[0]!.url).toBe('https://site.example/p129');
    const seen = first.visits.map((visit) => visit.url);
    let next = first.next;
    while (next) {
      const page = await history.list({ query: '', after: next });
      seen.push(...page.visits.map((visit) => visit.url));
      next = page.next;
    }
    expect(new Set(seen).size).toBe(131);
    expect((await history.list({ query: '%', after: null })).visits.map((visit) => visit.url)).toEqual(['https://shop.example/100%25']);
    expect((await history.list({ query: 'PAGE 12', after: null })).visits.length).toBeGreaterThan(0);
    const jump = await history.jumpBackIn();
    expect(jump.mostVisited[0]!.url).toBe('https://site.example/p129');
    expect(jump.recent.map((visit) => visit.url)).not.toContain('https://site.example/p129');
  });

  test('settings', async () => {
    const settings = createSettingsRepository(db);
    expect(await settings.searchEngine()).toBe(DEFAULT_SEARCH_ENGINE);
    expect(await settings.setSearchEngine('duckduckgo', 5)).toBe(true);
    expect(await settings.searchEngine()).toBe('duckduckgo');
    expect(await settings.setSearchEngine('evil' as never, 6)).toBe(false);
    expect(await settings.searchEngine()).toBe('duckduckgo');
  });

  test('content-notes', async () => {
    const notes = createContentNotesRepository(db);
    const page = 'https://example.com/guides/tea';
    expect(await notes.notes(page)).toEqual(EMPTY_NOTES);
    expect(await notes.setTargetQuery(page, '  green tea  ', 1)).toBe(true);
    expect(await notes.saveVariant(`${page}#brewing`, { slot: 2, title: 'Second', description: 'Two' }, 10)).toBe(true);
    expect(await notes.saveVariant(page, { slot: 0, title: 'First', description: '' }, 11)).toBe(true);
    expect(await notes.notes(`${page}#x`)).toEqual({
      query: 'green tea',
      variants: [
        { slot: 0, title: 'First', description: '', updatedAt: 11 },
        { slot: 2, title: 'Second', description: 'Two', updatedAt: 10 },
      ],
    });
    expect(await notes.setTargetQuery('file:///etc/passwd', 'x', 2)).toBe(false);
    await notes.clearAll();
    expect(await notes.notes(page)).toEqual(EMPTY_NOTES);
  });
});

/** Every entry of `sqlite_master`, in a stable order. */
async function schemaOf(driver: SqlDriver): Promise<unknown[][]> {
  return all(driver, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
}

const recordedIds = async (driver: SqlDriver) => (await all(driver, `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`)).map((row) => String(row[0]));

describe('migrations-over-both-drivers', () => {
  test('migrations-over-both-drivers', async () => {
    // The reference: today's runner over `node:sqlite`.
    const reference = new DatabaseSync(':memory:');
    runMigrations(reference);
    const expected = reference.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all().map((row) => Object.values(row));
    reference.close();

    const ids = MIGRATIONS.map((m) => m.id);
    const schemas: unknown[][][] = [];
    for (const driverCase of DRIVERS) {
      const driver = await openIn(driverCase, `${driverCase.kind}.db`);
      let stamp = 0;
      expect(await runMigrationsOver(driver, MIGRATIONS, () => ++stamp), driverCase.kind).toEqual(ids);
      expect(await recordedIds(driver)).toEqual(ids);
      // Each id recorded with its own time, in list order.
      expect(await all(driver, `SELECT applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id`)).toEqual(ids.map((_, i) => [i + 1]));
      // Re-running is a no-op, even if an applied migration's SQL would now fail.
      expect(await runMigrationsOver(driver)).toEqual([]);
      expect(await runMigrationsOver(driver, MIGRATIONS.map((m) => ({ id: m.id, sql: 'THIS IS NOT SQL' })))).toEqual([]);
      schemas.push(await schemaOf(driver));

      // A newer build's id is left alone; a new one is applied after the known ones.
      await driver.execute(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES ('9999_from_the_future', 1)`, [], 'run');
      const next: Migration = { id: '9000_test_extra', sql: 'CREATE TABLE extra (x INTEGER)' };
      expect(await runMigrationsOver(driver, [...MIGRATIONS, next])).toEqual(['9000_test_extra']);
      expect(await recordedIds(driver)).toEqual([...ids, '9000_test_extra', '9999_from_the_future']);

      // A failing migration is rolled back whole (no table, no id), and can be retried once fixed.
      const broken: Migration = { id: '9001_broken', sql: 'CREATE TABLE half (x INTEGER); CREATE TABLE half (y INTEGER);' };
      await expect(runMigrationsOver(driver, [...MIGRATIONS, next, broken])).rejects.toThrow();
      expect((await schemaOf(driver)).map((row) => row[1])).not.toContain('half');
      expect(await recordedIds(driver)).not.toContain('9001_broken');
      expect(await runMigrationsOver(driver, [...MIGRATIONS, next, { id: '9001_broken', sql: 'CREATE TABLE half (x INTEGER)' }])).toEqual(['9001_broken']);
    }
    expect(schemas[0]).toEqual(expected);
    expect(schemas[1]).toEqual(expected);
  });
});

describe.each(DRIVERS)('batch-rolls-back ($kind)', (driverCase) => {
  test('batch-rolls-back', async () => {
    const driver = await openIn(driverCase);
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE u (x INTEGER);');
    const insert = (id: number, v: string) => ({ sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [id, v], method: 'run' as const });

    // The third statement conflicts: nothing of the batch is written.
    await expect(driver.batch([insert(1, 'a'), insert(2, 'b'), insert(1, 'again'), insert(3, 'c')])).rejects.toThrow();
    expect(await count(driver, 't')).toBe(0);
    // A failing script inside a batch rolls back the statements before it, and its own first half.
    await expect(driver.batch([insert(1, 'a'), { script: 'INSERT INTO u (x) VALUES (1); INSERT INTO missing (x) VALUES (1);' }])).rejects.toThrow();
    expect(await count(driver, 't')).toBe(0);
    expect(await count(driver, 'u')).toBe(0);

    // The driver is still usable, and a batch that succeeds answers each statement's rows.
    const results = await driver.batch([
      insert(1, 'a'),
      { script: 'INSERT INTO u (x) VALUES (7); INSERT INTO u (x) VALUES (8);' },
      { sql: 'SELECT id, v FROM t', params: [], method: 'all' },
      { sql: 'SELECT v FROM t WHERE id = ?', params: [1], method: 'get' },
      { sql: 'SELECT v FROM t WHERE id = ?', params: [99], method: 'get' },
      { sql: 'SELECT x FROM u ORDER BY x', params: [], method: 'values' },
    ]);
    expect(results.map((result) => result.rows)).toEqual([[], [], [[1, 'a']], ['a'], undefined, [[7], [8]]]);
    expect(await count(driver, 't')).toBe(1);
    // An empty batch is fine.
    expect(await driver.batch([])).toEqual([]);
    // A failing `exec` leaves no transaction open either.
    await expect(driver.exec('BEGIN IMMEDIATE; INSERT INTO u (x) VALUES (9); INSERT INTO missing VALUES (1);')).rejects.toThrow();
    expect(await count(driver, 'u')).toBe(2);
    await driver.batch([insert(2, 'b')]);
    expect(await count(driver, 't')).toBe(2);
  });
});

describe.each(DRIVERS)('libsql-reads-numbers ($kind)', (driverCase) => {
  test('libsql-reads-numbers', async () => {
    const driver = await openIn(driverCase);
    await driver.exec('CREATE TABLE v (i INTEGER, b INTEGER, x BLOB, r REAL, s TEXT, n INTEGER)');
    // A real boolean is bound as 1 (and read back as 1, not `true`).
    await driver.execute('INSERT INTO v (i, b, x, r, s, n) VALUES (?, ?, ?, ?, ?, ?)', [Number.MAX_SAFE_INTEGER, true, new Uint8Array([1, 2]), 1.5, 'a', null], 'run');
    expect(await all(driver, 'SELECT typeof(b) FROM v')).toEqual([['integer']]);
    const [row] = await all(driver, 'SELECT i, b, x, r, s, n FROM v');
    expect(row).toEqual([Number.MAX_SAFE_INTEGER, 1, new Uint8Array([1, 2]), 1.5, 'a', null]);
    expect(row![2]).toBeInstanceOf(Uint8Array);
    expect((await driver.execute('SELECT s FROM v WHERE i = ?', [Number.MAX_SAFE_INTEGER], 'get')).rows).toEqual(['a']);
    expect((await driver.execute('SELECT s FROM v WHERE i = 0', [], 'get')).rows).toBeUndefined();
    // Two columns with the same name (a join) both come back, in column order.
    await driver.exec("CREATE TABLE w (i INTEGER, s TEXT); INSERT INTO w VALUES (1, 'w');");
    expect(await all(driver, 'SELECT v.s, w.s, w.i AS s FROM v JOIN w')).toEqual([['a', 'w', 1]]);
    // Beyond 2^53 - 1 an integer is never rounded: reading it throws a RangeError.
    await driver.execute('INSERT INTO v (i) VALUES (9007199254740993)', [], 'run');
    await expect(driver.execute('SELECT i FROM v WHERE i > ?', [Number.MAX_SAFE_INTEGER], 'all')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('libsql-url-rules', () => {
  const file = (name: string) => `file:///home/u/.config/frost/${name}`;
  const replica = file(SYNC_REPLICA_FILE_NAME);
  const accepted: [LibsqlConfig, boolean?][] = [
    [{ url: file('frost-browser.db') }],
    [{ url: 'file:/home/u/frost.db' }],
    [{ url: 'file:///Users/u/Library/Application%20Support/frost/frost-sync.db' }],
    [{ url: replica, syncUrl: 'libsql://db-org.turso.io' }],
    [{ url: replica, syncUrl: 'https://sqld.example.com:8443', authToken: 'eyJhbGciOiJFZERTQSJ9.e30.c2ln', syncInterval: 60 }],
    [{ url: replica, syncUrl: 'http://127.0.0.1:8080' }, true],
    [{ url: replica, syncUrl: 'http://[::1]:8080/' }, true],
    // Windows: `file:<drive>:/…`, what libSQL hands Windows as `C:/…`.
    [{ url: 'file:C:/Users/u/AppData/Roaming/frost/frost-browser.db' }],
    [{ url: 'file:c:/Users/u/AppData/Roaming/frost/frost-sync.db', syncUrl: 'https://sqld.example.com' }],
  ];
  const refused: [LibsqlConfig, LibsqlConfigProblem, boolean?][] = [
    [{ url: 'libsql://db-org.turso.io' }, 'url-not-file'],
    [{ url: 'https://sqld.example.com' }, 'url-not-file'],
    [{ url: 'http://127.0.0.1:8080' }, 'url-not-file', true],
    [{ url: ':memory:' }, 'url-not-file'],
    [{ url: 'file::memory:' }, 'url-not-absolute'],
    [{ url: 'file:frost.db' }, 'url-not-absolute'],
    [{ url: 'file://host/x.db' }, 'url-not-absolute'],
    [{ url: 'file://localhost/x.db' }, 'url-not-absolute'],
    [{ url: `${file('a.db')}?authToken=x` }, 'url-invalid'],
    [{ url: `${file('a.db')}#frag` }, 'url-invalid'],
    [{ url: 'file:///home/u/a b.db' }, 'url-invalid'],
    [{ url: 'file:///home/u/%E0%A4%A.db' }, 'url-invalid'],
    [{ url: 'file:///home/u/a%00.db' }, 'url-invalid'],
    [{ url: 'file:///' }, 'url-invalid'],
    // UNC / SMB shares, however encoded.
    [{ url: 'file:////srv/share/frost-sync.db', syncUrl: 'https://sqld.example.com' }, 'url-invalid'],
    [{ url: 'file:////srv/share/x.db' }, 'url-invalid'],
    [{ url: 'file:/%2F%2Fsrv/share/x.db' }, 'url-invalid'],
    [{ url: 'file:///%2Fsrv/share/x.db' }, 'url-invalid'],
    [{ url: 'file:///%5C%5Csrv%5Cshare%5Cx.db' }, 'url-invalid'],
    [{ url: 'file:%5C%5Csrv%5Cshare%5Cx.db' }, 'url-not-absolute'],
    [{ url: 'file:C:/%5C%5Csrv/x.db' }, 'url-invalid'],
    [{ url: 'file:C://srv/share/x.db' }, 'url-invalid'],
    [{ url: 'file:C:/a%5Cb.db' }, 'url-invalid'],
    // Windows paths libSQL would misread: `/C:/…`, drive-relative `C:x`.
    [{ url: 'file:///C:/Users/u/x.db' }, 'url-invalid'],
    [{ url: 'file:/C%3A/Users/u/x.db' }, 'url-invalid'],
    [{ url: 'file:C:x.db' }, 'url-not-absolute'],
    [{ url: 'file:C:/' }, 'url-invalid'],
    [{ url: `file:///${'a'.repeat(MAX_LIBSQL_URL_CHARS)}` }, 'url-invalid'],
    [{ url: replica, syncUrl: 'http://sqld.example.com' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'http://127.0.0.1:8080' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'http://localhost:8080' }, 'sync-url-scheme', true],
    [{ url: replica, syncUrl: 'http://0x7f.1:8080' }, 'sync-url-scheme', true],
    [{ url: replica, syncUrl: 'http://127.0.0.1.example.com' }, 'sync-url-scheme', true],
    [{ url: replica, syncUrl: 'wss://sqld.example.com' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'ws://127.0.0.1:8080' }, 'sync-url-scheme', true],
    [{ url: replica, syncUrl: 'file:///tmp/x.db' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'HTTPS://sqld.example.com' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'https:sqld.example.com' }, 'sync-url-scheme'],
    [{ url: replica, syncUrl: 'https://user:pw@sqld.example.com' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'libsql://sqld.example.com:8080?tls=0' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com/?authToken=x' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com/#x' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'https://' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'https://sqld example.com' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.exämple.com' }, 'sync-url-invalid'],
    [{ url: replica, syncUrl: `https://sqld.example.com/${'a'.repeat(MAX_LIBSQL_URL_CHARS)}` }, 'sync-url-invalid'],
    [{ url: file('frost-browser.db'), syncUrl: 'https://sqld.example.com' }, 'sync-file-not-replica'],
    [{ url: 'file:///home/u/frost-sync.db/frost-browser.db', syncUrl: 'https://sqld.example.com' }, 'sync-file-not-replica'],
    [{ url: file('other.db'), syncUrl: 'https://sqld.example.com' }, 'sync-file-not-replica'],
    [{ url: replica, authToken: 'token' }, 'needs-sync-url'],
    [{ url: replica, syncInterval: 60 }, 'needs-sync-url'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', authToken: 'has space' }, 'auth-token-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', authToken: '' }, 'auth-token-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', authToken: 't'.repeat(MAX_LIBSQL_AUTH_TOKEN_CHARS + 1) }, 'auth-token-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', syncInterval: 0.5 }, 'sync-interval-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', syncInterval: 0 }, 'sync-interval-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', syncInterval: 86_401 }, 'sync-interval-invalid'],
    [{ url: replica, syncUrl: 'https://sqld.example.com', syncInterval: Number.NaN }, 'sync-interval-invalid'],
  ];

  test('libsql-url-rules', async () => {
    for (const [config, allowLoopbackHttp] of accepted) expect(libsqlConfigProblem(config, { allowLoopbackHttp }), JSON.stringify(config)).toBeNull();
    for (const [config, problem, allowLoopbackHttp] of refused) expect(libsqlConfigProblem(config, { allowLoopbackHttp }), JSON.stringify(config)).toBe(problem);
    expect(libsqlFilePath('file:///Users/u/Library/Application%20Support/frost/frost-sync.db')).toBe('/Users/u/Library/Application Support/frost/frost-sync.db');
    expect(libsqlFilePath('file:/tmp/x.db')).toBe('/tmp/x.db');
    expect(libsqlFilePath('file:C:/Users/u/My%20Files/x.db')).toBe('C:/Users/u/My Files/x.db');
    // Every accepted URL names exactly the path libSQL's own parser reads from it (no host, no query).
    const { parseUri } = await import('@libsql/core/uri');
    for (const [config] of accepted) {
      const parsed = parseUri(config.url);
      expect(parsed.path, config.url).toBe(libsqlFilePath(config.url));
      expect(parsed.authority?.host ?? '', config.url).toBe('');
      expect(parsed.query, config.url).toBeUndefined();
    }

    // The driver refuses the same configs before libSQL is even loaded, and names the problem.
    const before = libsqlLoads.count;
    for (const [config, problem, allowLoopbackHttp] of refused) {
      const error = await openLibsqlDriver(config, { allowLoopbackHttp }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, JSON.stringify(config)).toBeInstanceOf(LibsqlConfigError);
      expect((error as LibsqlConfigError).problem).toBe(problem);
      // The message never holds the token.
      if (config.authToken) expect((error as Error).message).not.toContain(config.authToken);
    }
    expect(libsqlLoads.count).toBe(before);

    // `libsqlFileUrl` round-trips through `libsqlFilePath` on both platforms' paths (spaces, `#`,
    // `%`, `?`, non-ASCII), and refuses what Windows can't name on a drive.
    const roundTrip = (file: string, pathApi: typeof path) => pathApi.normalize(libsqlFilePath(libsqlFileUrl(file, pathApi)));
    for (const file of ['/home/u/.config/frost/with space #1.db', '/tmp/a%b?c/ünï.db']) {
      expect(roundTrip(file, path.posix)).toBe(file);
      expect(libsqlFileUrl(file, path.posix)).toMatch(/^file:\/\/\//);
    }
    for (const file of ['C:\\Users\\u\\AppData\\Roaming\\frost\\with space #1.db', 'D:\\a%b?c\\ünï.db']) {
      expect(roundTrip(file, path.win32)).toBe(file);
      expect(libsqlFileUrl(file, path.win32)).toMatch(/^file:[CD]:\//);
      expect(libsqlConfigProblem({ url: libsqlFileUrl(file, path.win32) })).toBeNull();
    }
    expect(libsqlFileUrl('C:\\Users\\u\\frost-sync.db', path.win32)).toBe('file:C:/Users/u/frost-sync.db');
    for (const file of ['\\\\srv\\share\\x.db', '\\\\?\\C:\\x.db', '//srv/share/x.db']) expect(() => libsqlFileUrl(file, path.win32), file).toThrow();
    expect(() => libsqlFileUrl('relative.db', path.posix)).toThrow();

    // The real platform's temporary path round-trips and opens; a driver without a `syncUrl` has no `sync()`.
    const odd = path.join(dir, 'with space #1.db');
    expect(path.normalize(libsqlFilePath(libsqlFileUrl(odd)))).toBe(odd);
    const driver = await openLibsqlDriver({ url: libsqlFileUrl(odd) });
    opened.push(driver);
    expect('sync' in driver).toBe(false);
    await driver.exec('CREATE TABLE t (x INTEGER)');
    expect(await count(driver, 't')).toBe(0);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));

/** The source files `entry` reaches through relative imports, and the packages they import. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) {
        // A module file (`./x` is `./x.ts`), else a folder's index (`./x` is `./x/index.ts`).
        const base = path.resolve(path.dirname(file), specifier.replace(/\.ts$/, ''));
        visit(existsSync(`${base}.ts`) ? `${base}.ts` : path.join(base, 'index.ts'));
      } else packages.add(specifier);
    }
  };
  visit(entry);
  return { files, packages };
}
