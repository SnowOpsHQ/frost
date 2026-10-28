// Spec: specs/sync.spec.ts (Sync config), specs/sync-config.schema.ts · Acceptance: specs/sync-config.feature.md
import { inspect } from 'node:util';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_SYNC_CONFIG_BYTES, MAX_SYNC_TOKEN_CHARS, SYNC_CONFIG_FILE_NAME, syncEndpointProblem, syncTokenProblem } from '@app/specs/sync.spec';
import { createSyncConfigStore, SyncConfigError, SyncToken, type SafeStorageLike } from '../config';

const POSIX = process.platform !== 'win32';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.c2VjcmV0LXRva2VuLWZvci10ZXN0cw.sig-NOT-A-REAL-ONE';
const URL_OK = 'libsql://frost-db.example.turso.io';

/** A fake `safeStorage`: reversible, but the ciphertext never contains the plain text. */
function fakeSafeStorage(options: { available?: boolean; backend?: string } = {}): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  const mask = (bytes: Buffer) => Buffer.from(bytes.map((b) => b ^ 0x5a));
  return {
    calls,
    isEncryptionAvailable: () => (calls.push('isEncryptionAvailable'), options.available ?? true),
    getSelectedStorageBackend: () => (calls.push('getSelectedStorageBackend'), options.backend ?? 'gnome_libsecret'),
    encryptString: (text) => (calls.push('encryptString'), Buffer.concat([Buffer.from('v11'), mask(Buffer.from(text, 'utf8'))])),
    decryptString: (bytes) => {
      calls.push('decryptString');
      if (bytes.subarray(0, 3).toString() !== 'v11') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return mask(bytes.subarray(3)).toString('utf8');
    },
  };
}

let dir: string;
let logs: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'frost-sync-config-'));
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, SYNC_CONFIG_FILE_NAME);
const store = (safeStorage: SafeStorageLike = fakeSafeStorage(), platform: NodeJS.Platform = 'linux') => createSyncConfigStore(dir, { safeStorage, platform, log: (line) => logs.push(line) });
const modeOf = async () => (await stat(file())).mode & 0o777;
/** Nothing anywhere a token could leak to holds it. */
const expectNoToken = async (...values: unknown[]) => {
  const seen = [...logs, ...values.map((value) => JSON.stringify(value) ?? String(value)), ...values.map((value) => inspect(value, { depth: 5 }))];
  try {
    seen.push(await readFile(file(), 'utf8'));
  } catch {
    // No file.
  }
  for (const text of seen) expect(text).not.toContain(TOKEN);
};

describe('sync config', () => {
  test('config-missing-is-off', async () => {
    const safe = fakeSafeStorage();
    expect(await store(safe).read()).toEqual({ enabled: false, hasToken: false });
    expect(logs).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(safe.calls).toEqual([]);
  });

  test('config-local-staging', async () => {
    await writeFile(file(), '{"enabled":true}');
    const safe = fakeSafeStorage();
    const loaded = await store(safe).load();
    expect(loaded.config).toEqual({ enabled: true, hasToken: false });
    expect(loaded.token).toBeNull();
    expect(safe.calls).toEqual([]);
  });

  test('config-round-trip', async () => {
    const config = store();
    const written = await config.write({ enabled: true, url: URL_OK, token: TOKEN });
    expect(written).toEqual({ enabled: true, url: URL_OK, hasToken: true });
    const loaded = await store().load();
    expect(loaded.config).toEqual({ enabled: true, url: URL_OK, hasToken: true });
    expect(loaded.token?.reveal()).toBe(TOKEN);
    const onDisk = JSON.parse(await readFile(file(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['enabled', 'encryptedToken', 'url']);
    expect(Buffer.from(onDisk['encryptedToken'] as string, 'base64').subarray(0, 3).toString()).toBe('v11');
    if (POSIX) expect(await modeOf()).toBe(0o600);
    expect(await readdir(dir)).toEqual([SYNC_CONFIG_FILE_NAME]);

    // Without `token` the stored one is kept; `token: null` removes it; `url: null` removes the endpoint.
    expect(await config.write({ enabled: false })).toEqual({ enabled: false, url: URL_OK, hasToken: true });
    expect((await store().load()).token?.reveal()).toBe(TOKEN);
    expect(await config.write({ enabled: true, url: null, token: null })).toEqual({ enabled: true, hasToken: false });
    // A lax mode is narrowed again when read.
    if (POSIX) {
      await chmod(file(), 0o644);
      await store().read();
      expect(await modeOf()).toBe(0o600);
    }
    await expectNoToken(written, loaded, loaded.config);
  });

  test('config-token-needs-encryption', async () => {
    const unavailable = fakeSafeStorage({ available: false });
    await expect(store(unavailable).write({ enabled: true, url: URL_OK, token: TOKEN })).rejects.toMatchObject({ problem: 'encryption-unavailable' });
    expect(await readdir(dir)).toEqual([]);
    // A stored token can't be read without it: sync is off.
    await store().write({ enabled: true, url: URL_OK, token: TOKEN });
    expect(await store(unavailable).read()).toEqual({ enabled: false, url: URL_OK, hasToken: true, problem: 'encryption-unavailable' });
    // Local staging needs no encryption.
    expect(await store(unavailable).write({ enabled: true, url: null, token: null })).toEqual({ enabled: true, hasToken: false });
    await expectNoToken();
  });

  test('config-refuses-basic-text', async () => {
    const weak = fakeSafeStorage({ backend: 'basic_text' });
    const error = await store(weak, 'linux')
      .write({ enabled: true, url: URL_OK, token: TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncConfigError);
    expect(error).toMatchObject({ problem: 'encryption-weak' });
    expect(weak.calls).not.toContain('encryptString');
    await store(fakeSafeStorage(), 'linux').write({ enabled: true, url: URL_OK, token: TOKEN });
    expect(await store(weak, 'linux').read()).toMatchObject({ enabled: false, problem: 'encryption-weak' });
    // Off Linux the backend is not consulted.
    const mac = fakeSafeStorage({ backend: 'basic_text' });
    expect((await store(mac, 'darwin').load()).token?.reveal()).toBe(TOKEN);
    expect(mac.calls).not.toContain('getSelectedStorageBackend');
    await expectNoToken(error, String(error));
  });

  test('config-token-needs-endpoint', async () => {
    await expect(store().write({ enabled: true, token: TOKEN })).rejects.toMatchObject({ problem: 'token-needs-endpoint' });
    await store().write({ enabled: true, url: URL_OK, token: TOKEN });
    await expect(store().write({ enabled: true, url: null })).rejects.toMatchObject({ problem: 'token-needs-endpoint' });
    const ciphertext = (JSON.parse(await readFile(file(), 'utf8')) as { encryptedToken: string }).encryptedToken;
    await writeFile(file(), JSON.stringify({ enabled: true, encryptedToken: ciphertext }));
    expect(await store().read()).toEqual({ enabled: false, hasToken: false, problem: 'tampered' });
  });

  test('config-endpoint-rules', async () => {
    for (const url of ['libsql://db.example.turso.io', 'https://sqld.example.com:8443', 'https://sqld.example.com/path']) expect(syncEndpointProblem(url), url).toBeNull();
    const refused = [
      'http://sqld.example.com',
      'http://127.0.0.1:8080',
      'ws://db.example.com',
      'wss://db.example.com',
      'file:///tmp/x.db',
      'HTTPS://db.example.com',
      'https://user:pw@db.example.com',
      'https://user@db.example.com',
      'https://db.example.com/?tls=0',
      'https://db.example.com/#x',
      'https://',
      'https://db.example.com/a b',
      'https://dé.example.com',
      `https://db.example.com/${'a'.repeat(2048)}`,
      '',
    ];
    for (const url of refused) {
      expect(syncEndpointProblem(url), url).toBe('endpoint-invalid');
      await expect(store().write({ enabled: true, url }), url).rejects.toMatchObject({ problem: 'endpoint-invalid' });
    }
    for (const token of ['', 'has space', 'nön-ascii', 'a'.repeat(MAX_SYNC_TOKEN_CHARS + 1)]) {
      expect(syncTokenProblem(token)).toBe('token-invalid');
      await expect(store().write({ enabled: true, url: URL_OK, token })).rejects.toMatchObject({ problem: 'token-invalid' });
    }
    expect(syncTokenProblem('a'.repeat(MAX_SYNC_TOKEN_CHARS))).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test('config-tamper-is-off', async () => {
    const valid = await (async () => {
      await store().write({ enabled: true, url: URL_OK, token: TOKEN });
      return readFile(file(), 'utf8');
    })();
    const ciphertext = (JSON.parse(valid) as { encryptedToken: string }).encryptedToken;
    const tampered = [
      'not json',
      '{"enabled":true,"enabled":false}',
      '{"enabled":true,"extra":1}',
      '{"enabled":"yes"}',
      '{}',
      '[]',
      'null',
      '{"enabled":true,"url":"http://db.example.com"}',
      '{"enabled":true,"deviceId":"not-a-uuid"}',
      `{"enabled":true,"url":"${URL_OK}","encryptedToken":"not base64!"}`,
      `{"enabled":true,"encryptedToken":"${ciphertext}"}`,
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      `{"enabled":true,"url":"${URL_OK}","encryptedToken":"${'A'.repeat(MAX_SYNC_CONFIG_BYTES)}"}`,
    ];
    for (const content of tampered) {
      await writeFile(file(), content);
      logs = [];
      expect(await store().read(), String(content).slice(0, 60)).toMatchObject({ enabled: false, problem: 'tampered' });
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(String(content).slice(0, 12));
      // Left exactly as it was.
      expect(Buffer.compare(await readFile(file()), Buffer.from(content))).toBe(0);
    }

    // Not a regular file: a symbolic link to a valid one, a directory.
    await writeFile(file(), valid);
    if (POSIX) {
      const real = path.join(dir, 'real.json');
      await writeFile(real, valid);
      await rm(file());
      await symlink(real, file());
      expect(await store().read()).toMatchObject({ enabled: false, problem: 'tampered' });
      await rm(file());
    } else {
      await rm(file());
    }
    await mkdir(file());
    expect(await store().read()).toMatchObject({ enabled: false, problem: 'tampered' });
    await rm(file(), { recursive: true });

    // A ciphertext safeStorage refuses.
    await writeFile(file(), JSON.stringify({ enabled: true, url: URL_OK, encryptedToken: Buffer.from('garbage-bytes').toString('base64') }));
    expect(await store().read()).toEqual({ enabled: false, url: URL_OK, hasToken: true, problem: 'token-undecryptable' });
    await expectNoToken();
  });

  test('config-never-reveals-token', async () => {
    const token = new SyncToken(TOKEN);
    expect(String(token)).toBe('[redacted]');
    expect(`${token}`).toBe('[redacted]');
    expect(JSON.stringify({ token })).toBe('{"token":"[redacted]"}');
    expect(inspect(token)).toBe('[redacted]');
    expect(token.reveal()).toBe(TOKEN);
    const written = await store().write({ enabled: true, url: URL_OK, token: TOKEN });
    const loaded = await store().load();
    await expectNoToken(written, loaded, await store().read(), token);
  });

  test('config-device-id', async () => {
    await writeFile(file(), JSON.stringify({ enabled: true, url: URL_OK }));
    const id = await store().deviceId();
    expect(id).toMatch(UUID_V4);
    expect(await store().deviceId()).toBe(id);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ enabled: true, url: URL_OK, deviceId: id });
    if (POSIX) expect(await modeOf()).toBe(0o600);
    expect((await store().read()).deviceId).toBe(id);
  });
});
