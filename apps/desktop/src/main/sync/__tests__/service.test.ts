// Spec: specs/sync.spec.ts (SYNC_INTERVAL_MS, SYNC_REPLICA_FILE_NAME, SYNC_STATE_TABLE) · Acceptance: specs/sync-engine.feature.md (Service)
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openLibsqlDriver, type LibsqlDriver } from '@app/db/driver-libsql';
import type { SqlDriver } from '@app/db/driver-types';
import type { LibsqlConfig } from '@app/specs/sync.spec';
import { SYNC_CONFIG_FILE_NAME, SYNC_INTERVAL_MS, SYNC_LOG_TABLE, SYNC_REPLICA_FILE_NAME, SYNC_STATE_TABLE } from '@app/specs/sync.spec';
import { createSyncConfigStore, type SafeStorageLike } from '../config';
import { startSyncService, type StartSyncDeps } from '../service';

const POSIX = process.platform !== 'win32';
const TOKEN = 'sqld-token-NOT-REAL-0123456789';
const URL_OK = 'libsql://frost-db.example.turso.io';

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text) => Buffer.from(`v11${Buffer.from(text).toString('hex')}`),
  decryptString: (bytes) => Buffer.from(bytes.toString().slice(3), 'hex').toString(),
};

let dir: string;
let logs: string[];
const opened: SqlDriver[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'frost-sync-service-'));
  logs = [];
});
afterEach(async () => {
  vi.useRealTimers();
  for (const driver of opened.splice(0)) await driver.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const config = (content: string) => writeFile(path.join(dir, SYNC_CONFIG_FILE_NAME), content);
const sessionFile = () => {
  const file = path.join(dir, 'frost-browser.db');
  new DatabaseSync(file).close();
  return file;
};

function deps(overrides: Partial<StartSyncDeps> = {}): StartSyncDeps {
  return {
    app: { getPath: () => dir },
    safeStorage,
    sessionFile: sessionFile(),
    log: (line) => logs.push(line),
    platform: 'linux',
    ...overrides,
  };
}

/** The real opener, recording what it was asked to open. */
function recordingOpener(): { calls: LibsqlConfig[]; open: (config: LibsqlConfig) => Promise<LibsqlDriver> } {
  const calls: LibsqlConfig[] = [];
  return {
    calls,
    open: async (config) => {
      calls.push(config);
      const driver = await openLibsqlDriver(config);
      opened.push(driver);
      return driver;
    },
  };
}

describe('sync service', () => {
  test.each([
    ['no config', null],
    ['disabled', '{"enabled":false}'],
    ['tampered', '{"enabled":true,"extra":1}'],
  ])('service-off-loads-nothing (%s)', async (_, content) => {
    if (content !== null) await config(content);
    const opener = vi.fn();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const d = deps({ openReplica: opener });
    const before = (await readdir(dir)).sort();
    const service = startSyncService(d);
    expect(service.status().state).toBe('starting');
    await service.whenStarted;
    expect(service.status().state).toBe('off');
    expect(opener).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    expect((await readdir(dir)).sort()).toEqual(before);
    await service.dispose();
  });

  test('service-local-staging', async () => {
    await config('{"enabled":true}');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const opener = recordingOpener();
    const service = startSyncService(deps({ openReplica: opener.open }));
    await service.whenStarted;
    await service.idle();
    expect(service.status()).toMatchObject({ state: 'running', mode: 'local', passes: 1 });
    const replicaFile = path.join(dir, SYNC_REPLICA_FILE_NAME);
    expect(opener.calls).toEqual([{ url: expect.stringMatching(/^file:/) }]);
    expect(Object.keys(opener.calls[0]!)).toEqual(['url']);

    // The replica and its state table exist; it and every sidecar are the user's alone.
    const check = new DatabaseSync(replicaFile, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row['name']);
    check.close();
    expect(tables).toEqual(expect.arrayContaining([SYNC_LOG_TABLE, SYNC_STATE_TABLE]));
    if (POSIX) {
      for (const name of (await readdir(dir)).filter((n) => n.startsWith(SYNC_REPLICA_FILE_NAME))) expect((await stat(path.join(dir, name))).mode & 0o777, name).toBe(0o600);
    }
    // Before Phase 6, every table is skipped and said so once.
    expect(logs.filter((line) => line.includes('skipped'))).toHaveLength(1);
    const { deviceId } = JSON.parse(await readFile(path.join(dir, SYNC_CONFIG_FILE_NAME), 'utf8')) as { deviceId: string };
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);

    // Another pass every SYNC_INTERVAL_MS.
    vi.advanceTimersByTime(SYNC_INTERVAL_MS - 1);
    await service.idle();
    expect(service.status().passes).toBe(1);
    vi.advanceTimersByTime(1);
    await service.idle();
    expect(service.status().passes).toBe(2);
    expect(logs.filter((line) => line.includes('skipped'))).toHaveLength(1);

    await service.dispose();
    expect(service.status().state).toBe('off');
    vi.advanceTimersByTime(SYNC_INTERVAL_MS * 3);
    await service.idle();
    expect(service.status().passes).toBe(2);
    expect(opened.every((driver) => !driver.isOpen)).toBe(true);
  });

  test('service-remote-calls-sync', async () => {
    await createSyncConfigStore(dir, { safeStorage, platform: 'linux' }).write({ enabled: true, url: URL_OK, token: TOKEN });
    const events: string[] = [];
    const configs: LibsqlConfig[] = [];
    let syncs = 0;
    const open = async (cfg: LibsqlConfig): Promise<LibsqlDriver> => {
      configs.push(cfg);
      // A local file stands in for the embedded replica; `sync()` is the fake remote.
      const real = await openLibsqlDriver({ url: cfg.url });
      opened.push(real);
      return {
        kind: 'libsql',
        get isOpen() {
          return real.isOpen;
        },
        execute: (sql, params, method) => {
          if (params[1] === 'push' || params[1] === 'pull') events.push(String(params[1]));
          return real.execute(sql, params, method);
        },
        batch: (items) => real.batch(items),
        exec: (script) => real.exec(script),
        close: () => real.close(),
        sync: async () => {
          events.push('sync');
          syncs += 1;
          if (syncs === 2) throw new Error(`401 Unauthorized: token ${TOKEN} expired`);
          return { framesSynced: 0, frameNo: 0 };
        },
      };
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const service = startSyncService(deps({ openReplica: open }));
    await service.whenStarted;
    await service.idle();
    expect(configs).toEqual([{ url: expect.stringMatching(/^file:/), syncUrl: URL_OK, authToken: TOKEN }]);
    expect(service.status()).toMatchObject({ state: 'running', mode: 'remote' });
    // Push, then sync(), then pull.
    expect(events.indexOf('push')).toBeLessThan(events.indexOf('sync'));
    expect(events.indexOf('sync')).toBeLessThan(events.indexOf('pull'));

    vi.advanceTimersByTime(SYNC_INTERVAL_MS);
    await service.idle();
    expect(syncs).toBe(2);
    expect(service.status().passes).toBe(2);
    const failure = logs.find((line) => line.includes('401'));
    expect(failure).toContain('[redacted]');
    for (const line of logs) expect(line).not.toContain(TOKEN);
    expect(JSON.stringify(service.status())).not.toContain(TOKEN);
    await service.dispose();
  });

  test('service-fail-safe', async () => {
    await config('{"enabled":true}');
    // The opener rejects.
    const refused = startSyncService(deps({ openReplica: () => Promise.reject(new Error('libsql failed to load')) }));
    await refused.whenStarted;
    expect(refused.status().state).toBe('failed');
    expect(logs).toEqual([expect.stringContaining('libsql failed to load')]);
    await refused.dispose();

    // No session database on disk (the store fell back to memory): passes still run, every table skipped.
    logs = [];
    const opener = recordingOpener();
    const memory = startSyncService(deps({ sessionFile: ':memory:', openReplica: opener.open }));
    await memory.whenStarted;
    await memory.idle();
    expect(memory.status()).toMatchObject({ state: 'running', passes: 1 });
    await memory.dispose();

    // A pass that throws: logged, and the service keeps running.
    logs = [];
    const broken: SqlDriver = {
      kind: 'node-sqlite',
      isOpen: true,
      execute: () => Promise.reject(new Error('disk I/O error')),
      batch: () => Promise.reject(new Error('disk I/O error')),
      exec: () => Promise.reject(new Error('disk I/O error')),
      close: async () => undefined,
    };
    const failing = startSyncService(deps({ openReplica: recordingOpener().open, openSession: () => broken }));
    await failing.whenStarted;
    await failing.idle();
    expect(failing.status()).toMatchObject({ state: 'running', passes: 0 });
    expect(logs.some((line) => line.includes('disk I/O error'))).toBe(true);
    await failing.dispose();

    // `app.getPath` throwing never escapes.
    logs = [];
    const bad = startSyncService(deps({ app: { getPath: () => { throw new Error('no userData'); } } }));
    await bad.whenStarted;
    expect(bad.status().state).toBe('failed');
    expect(logs).toEqual([expect.stringContaining('no userData')]);
    await bad.dispose();
  });
});
