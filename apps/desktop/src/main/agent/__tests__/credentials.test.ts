// Spec: specs/agent-proxy.spec.ts (CREDENTIAL_SLOTS, CREDENTIAL_LIMITS, normalizeKey, KEY_PROTECTIONS)
// Acceptance: specs/agent-host.feature.md (Credentials)
import { describe, expect, test, vi } from 'vitest';
import { CREDENTIAL_LIMITS, CREDENTIAL_SLOTS } from '@app/specs/agent-proxy.spec';
import { createCredentialStore, credentialSettings, type CredentialStoreDeps } from '../credentials';
import { createFakeSafeStorage, createMemoryFs } from './fakes';

const FILE = '/user-data/agent-credentials.json';
const KEY = 'sk-test-0123456789abcdefSECRET';

function setup(options: { available?: boolean; weak?: boolean; platform?: NodeJS.Platform } = {}, overrides: Partial<CredentialStoreDeps> = {}) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage(options);
  const log = vi.fn<(line: string) => void>();
  let n = 0;
  const store = createCredentialStore({ safeStorage: safe.storage, file: FILE, fs: memory.fs, platform: options.platform ?? 'linux', log, tempSuffix: () => `t${(n += 1)}`, ...overrides });
  return { store, memory, safe, log };
}

describe('agent credentials', () => {
  test('credentials-file-not-plaintext', async () => {
    const { store, memory } = setup();
    expect(await store.setKey('anthropic', `  ${KEY}\n`)).toBe('stored');
    const text = memory.text(FILE)!;
    expect(text).not.toBeNull();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(KEY).toString('base64'));
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text)).toEqual({ version: 1, keys: { anthropic: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/) } });
    // Written to a new 0600 file, then renamed over the old one.
    expect(memory.ops.filter((op) => !op.startsWith('read'))).toEqual([`write ${FILE}.t1.tmp 600 wx flush`, `rename ${FILE}.t1.tmp ${FILE}`]);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    expect([...memory.files.keys()]).toEqual([FILE]);
  });

  test('credentials-only-withkey-returns-key', async () => {
    const { store, log } = setup();
    const answers: unknown[] = [];
    answers.push(await store.setKey('openai', KEY), await store.hasKey('openai'), await store.hasKey('anthropic'), await store.protection());
    const seen: string[] = [];
    const result = await store.withKey('openai', (key) => {
      seen.push(key);
      return 'sent';
    });
    expect(seen).toEqual([KEY]);
    expect(result).toEqual({ ok: true, value: 'sent' });
    answers.push(result, await store.withKey('gateway', () => 'never'), await store.clearKey('openai'), await store.hasKey('openai'));
    expect(JSON.stringify(answers)).not.toContain(KEY);
    expect(answers).toEqual(['stored', true, false, 'os', { ok: true, value: 'sent' }, { ok: false, reason: 'no-key' }, true, false]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);

    // The settings view has no way to read a key.
    const view = credentialSettings(store);
    expect(Object.keys(view).sort()).toEqual(['clearKey', 'hasKey', 'protection', 'setKey']);
    expect('withKey' in view).toBe(false);
  });

  test('credentials-key-validated', async () => {
    const { store, memory } = setup();
    for (const bad of ['short', 'x'.repeat(CREDENTIAL_LIMITS.maxKeyChars + 1), 'sk with space 12345', 'sk-ключ-123456789', 'sk-tab\tinside-1234', '', '        ']) {
      expect(await store.setKey('anthropic', bad), JSON.stringify(bad)).toBe('invalid');
    }
    expect(await store.setKey('nope' as 'anthropic', KEY)).toBe('invalid');
    expect(memory.files.size).toBe(0);
    expect(await store.setKey('gateway', 'x'.repeat(CREDENTIAL_LIMITS.maxKeyChars))).toBe('stored');
    expect(await store.withKey('gateway', (key) => key.length)).toEqual({ ok: true, value: CREDENTIAL_LIMITS.maxKeyChars });
  });

  test('credentials-protection', async () => {
    // No encryption, or only Chromium's fixed key (Linux `v10`): nothing is stored, and the UI can say why.
    for (const options of [{ available: false }, { weak: true }]) {
      const refused = setup(options);
      expect(await refused.store.protection()).toBe(options.available === false ? 'unavailable' : 'weak');
      expect(await refused.store.setKey('anthropic', KEY)).toBe('no-keychain');
      expect(refused.memory.files.size).toBe(0);
    }
    expect(await setup({ weak: false }).store.protection()).toBe('os');
    // The key source is a Linux question only.
    expect(await setup({ weak: true, platform: 'darwin' }).store.protection()).toBe('os');
    expect(await setup({ weak: true, platform: 'win32' }).store.protection()).toBe('os');
    // Encryption that goes away later is reported again.
    const later = setup();
    later.safe.state.available = false;
    expect(await later.store.protection()).toBe('unavailable');
    later.safe.state.available = true;
    expect(await later.store.protection()).toBe('os');
  });

  test('credentials-weak-blob-never-used', async () => {
    // A `v10` blob (anyone can make one: the agent process could plant its own key) is never used on Linux.
    const planted = setup();
    planted.memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { anthropic: planted.safe.blob('sk-attacker-key-123456', 'v10') } })), mode: 0o600 });
    expect(await planted.store.hasKey('anthropic')).toBe(false);
    expect(await planted.store.withKey('anthropic', () => 'never')).toEqual({ ok: false, reason: 'failed' });
    // With only the fixed key on this machine, even a good blob is not used.
    const weak = setup({ weak: true });
    weak.memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { anthropic: weak.safe.blob(KEY, 'v11') } })), mode: 0o600 });
    expect(await weak.store.hasKey('anthropic')).toBe(false);
    expect(await weak.store.withKey('anthropic', () => 'never')).toEqual({ ok: false, reason: 'unavailable' });
    // On macOS and Windows the tag says nothing about the key source.
    const mac = setup({ platform: 'darwin' });
    mac.memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { anthropic: mac.safe.blob(KEY, 'v10') } })), mode: 0o600 });
    expect(await mac.store.withKey('anthropic', (key) => key === KEY)).toEqual({ ok: true, value: true });
  });

  test('credentials-read-error-not-cached', async () => {
    const { store, memory } = setup();
    await store.setKey('anthropic', KEY);
    const before = memory.text(FILE);
    const fresh = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: FILE, fs: memory.fs, platform: 'linux' });
    const readFile = memory.fs.readFile;
    memory.fs.readFile = () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
    // A file that can't be read: nothing is overwritten, and the other slots survive.
    expect(await fresh.setKey('openai', KEY)).toBe('failed');
    expect(await fresh.clearKey('anthropic')).toBe(false);
    expect(await fresh.hasKey('anthropic')).toBe(false);
    expect(await fresh.withKey('anthropic', () => 'never')).toEqual({ ok: false, reason: 'failed' });
    expect(memory.text(FILE)).toBe(before);
    // Readable again: read afresh, not the failure remembered.
    memory.fs.readFile = readFile;
    expect(await fresh.hasKey('anthropic')).toBe(true);
    expect(await fresh.setKey('openai', KEY)).toBe('stored');
    expect(Object.keys((JSON.parse(memory.text(FILE)!) as { keys: object }).keys).sort()).toEqual(['anthropic', 'openai']);
  });

  test('credentials-re-encrypted-when-asked', async () => {
    const { store, safe, memory } = setup();
    await store.setKey('anthropic', KEY);
    const before = memory.text(FILE);
    // The encryptor's key rotated: it asks for the data to be encrypted again.
    safe.state.reEncrypt = true;
    expect(await store.withKey('anthropic', (key) => key === KEY)).toEqual({ ok: true, value: true });
    const after = memory.text(FILE)!;
    expect(after).not.toBe(before);
    expect(after).not.toContain(KEY);
    safe.state.reEncrypt = false;
    expect(await store.withKey('anthropic', (key) => key === KEY)).toEqual({ ok: true, value: true });
  });

  test('credentials-clear', async () => {
    const { store, memory } = setup();
    for (const slot of CREDENTIAL_SLOTS) expect(await store.setKey(slot, `${KEY}-${slot}`)).toBe('stored');
    expect(await store.clearKey('openai')).toBe(true);
    expect(await store.hasKey('openai')).toBe(false);
    expect(await store.hasKey('anthropic')).toBe(true);
    expect(await store.withKey('gateway', (key) => key === `${KEY}-gateway`)).toEqual({ ok: true, value: true });
    expect(Object.keys((JSON.parse(memory.text(FILE)!) as { keys: object }).keys).sort()).toEqual(['anthropic', 'gateway']);
    // A fresh store reads the same file.
    const again = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: FILE, fs: memory.fs, platform: 'linux' });
    expect(await again.hasKey('anthropic')).toBe(true);
    expect(await again.hasKey('openai')).toBe(false);
  });

  test('credentials-tampered-file', async () => {
    for (const content of ['not json', '{"version":2,"keys":{"anthropic":"AAAA"}}', '{"version":1,"keys":["x"]}', '{"version":1,"keys":{"anthropic":"not base64!"}}', '{"version":1,"keys":{"other":"AAAA"}}']) {
      const memory = createMemoryFs();
      memory.files.set(FILE, { data: new TextEncoder().encode(content), mode: 0o600 });
      const store = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: FILE, fs: memory.fs, platform: 'linux' });
      expect(await store.hasKey('anthropic'), content).toBe(false);
      expect(await store.withKey('anthropic', () => 'never')).toEqual({ ok: false, reason: 'no-key' });
    }
    // A blob safeStorage can't decrypt (another machine's, a changed keyring): no key comes out.
    const memory = createMemoryFs();
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { anthropic: Buffer.from('v11garbage').toString('base64') } })), mode: 0o600 });
    const log = vi.fn<(line: string) => void>();
    const store = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: FILE, fs: memory.fs, platform: 'linux', log });
    // Stored but unusable: not a key frost has.
    expect(await store.hasKey('anthropic')).toBe(false);
    const fn = vi.fn();
    expect(await store.withKey('anthropic', fn)).toEqual({ ok: false, reason: 'failed' });
    expect(fn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('agent credentials: a stored key could not be decrypted');
    // A failed write leaves the old file and reports `failed`.
    const failing = setup({}, {});
    failing.memory.fs.rename = () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
    expect(await failing.store.setKey('anthropic', KEY)).toBe('failed');
    expect(failing.memory.files.size).toBe(0);
    expect(JSON.stringify(failing.log.mock.calls)).not.toContain(KEY);
  });
});
