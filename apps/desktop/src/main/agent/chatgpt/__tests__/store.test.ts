// Spec: specs/agent-chatgpt.schema.ts (ChatgptStoredStateSchema, EMPTY_CHATGPT_STATE), specs/agent-chatgpt.spec.ts
// (CHATGPT_CREDENTIALS_FILE, CHATGPT_HOST_ID_FILE, isChatgptHostId, CHATGPT_LIMITS)
// Acceptance: specs/agent-chatgpt.feature.md (Store and host id) · plan docs/plans/agent-chatgpt-plan.md, decision 3
import { describe, expect, test } from 'vitest';
import { isChatgptHostId } from '@app/specs/agent-chatgpt.spec';
import { EMPTY_CHATGPT_STATE, type ChatgptStoredState } from '@app/specs/agent-chatgpt.schema';
import { createFakeSafeStorage, createMemoryFs } from '../../__tests__/fakes';
import { createHostIdStore } from '../host-id';
import { canonicalChatgptState, createChatgptStore } from '../store';

const FILE = '/user-data/agent-chatgpt-credentials.json';
const HOST_FILE = '/user-data/agent-chatgpt-host.json';

const SIGNED_IN: ChatgptStoredState = {
  v: 1,
  clientId: 'oaiapp_TestClient',
  account: { sub: 'user-sub', email: 'ada@example.com' },
  tokens: { accessToken: 'access-SECRET', refreshToken: 'refresh-SECRET', idToken: 'a.b.c', expiresAt: 2, earliestRefreshAt: null, scopes: ['openid'], savedAt: 1 },
  expired: false,
  acknowledged: true,
};

function setup(options: { available?: boolean; weak?: boolean } = {}) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage(options);
  let n = 0;
  const store = createChatgptStore({ safeStorage: safe.storage, fs: memory.fs, file: FILE, platform: 'linux', tempSuffix: () => `t${(n += 1)}` });
  return { store, memory, safe };
}

describe('chatgpt store', () => {
  test('chatgpt-store-round-trip', async () => {
    const { store, memory } = setup();
    expect(await store.read()).toBeNull();
    expect(await store.write(SIGNED_IN)).toBe(true);
    expect(await store.read()).toEqual(SIGNED_IN);
    // Encrypted, 0600, written to a new file and renamed over the old one.
    const text = memory.text(FILE)!;
    for (const secret of ['SECRET', 'oaiapp_TestClient', 'user-sub', 'ada@example.com']) expect(text).not.toContain(secret);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    expect(memory.ops).toEqual(expect.arrayContaining([`write ${FILE}.t1.tmp 600 wx flush`, `rename ${FILE}.t1.tmp ${FILE}`]));
    expect(await store.write({ ...SIGNED_IN, tokens: null })).toBe(true);
    expect(await store.read()).toEqual({ ...SIGNED_IN, tokens: null });
    expect(await store.clear()).toBe(true);
    expect(await store.read()).toBeNull();
  });

  test('chatgpt-store-round-trip (refuses an invalid record)', async () => {
    const { store } = setup();
    expect(await store.write({ ...SIGNED_IN, extra: 1 } as unknown as ChatgptStoredState)).toBe(false);
    expect(await store.write({ ...SIGNED_IN, clientId: 'dynamic_agent_client' })).toBe(false);
    expect(await store.read()).toBeNull();
  });

  test('chatgpt-store-round-trip (tampered or foreign blobs read as nothing usable)', async () => {
    const memory = createMemoryFs();
    const safe = createFakeSafeStorage();
    // A store per run (the store reads its file once).
    const readPlanted = (plain: string, tag: 'v10' | 'v11' = 'v11') => {
      memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { chatgpt: safe.blob(plain, tag) } })), mode: 0o600 });
      return createChatgptStore({ safeStorage: safe.storage, fs: memory.fs, file: FILE, platform: 'linux' }).read();
    };
    const canonical = canonicalChatgptState(SIGNED_IN)!;
    // Another slot's envelope, a record that isn't canonical (keys reordered), a fixed-key (`v10`) blob.
    expect(await readPlanted(`frost-agent-key/2\nopenai\n${canonical}`)).toBe('failed');
    expect(await readPlanted(`frost-agent-key/2\nchatgpt\n${JSON.stringify(Object.fromEntries(Object.entries(SIGNED_IN).reverse()))}`)).toBe('failed');
    expect(await readPlanted(`frost-agent-key/2\nchatgpt\n${canonical}`, 'v10')).toBe('failed');
    expect(await readPlanted(`frost-agent-key/2\nchatgpt\n${canonical}`)).toEqual(SIGNED_IN);
    memory.files.set(FILE, { data: new TextEncoder().encode('not json'), mode: 0o600 });
    expect(await createChatgptStore({ safeStorage: safe.storage, fs: memory.fs, file: FILE, platform: 'linux' }).read()).toBeNull();
  });

  test('chatgpt-store-round-trip (no OS keychain: nothing stored or used)', async () => {
    for (const options of [{ weak: true }, { available: false }]) {
      const { store, memory, safe } = setup(options);
      expect(await store.protection()).not.toBe('os');
      expect(await store.write(EMPTY_CHATGPT_STATE)).toBe(false);
      expect(memory.text(FILE)).toBeNull();
      memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { chatgpt: safe.blob(`frost-agent-key/2\nchatgpt\n${canonicalChatgptState(SIGNED_IN)}`, 'v11') } })), mode: 0o600 });
      expect(await store.read()).toBe('unavailable');
    }
  });
});

describe('chatgpt host id', () => {
  test('chatgpt-host-id-format', async () => {
    const memory = createMemoryFs();
    const ids = ['3F1C2A9E-8B7D-4C6E-9F1A-0B2C3D4E5F60', '11111111-2222-4333-8444-555555555555'];
    const hostIds = createHostIdStore({ fs: memory.fs, file: HOST_FILE, randomUUID: () => ids.shift()!, tempSuffix: () => 'h' });
    const first = await hostIds.get();
    expect(first).toBe('urn:uuid:3f1c2a9e-8b7d-4c6e-9f1a-0b2c3d4e5f60');
    expect(isChatgptHostId(first)).toBe(true);
    expect(await hostIds.get()).toBe(first);
    expect(memory.files.get(HOST_FILE)!.mode).toBe(0o600);
    // Another run reads the same id back.
    const again = createHostIdStore({ fs: memory.fs, file: HOST_FILE, randomUUID: () => 'never-used' });
    expect(await again.get()).toBe(first);
  });

  test('chatgpt-host-id-format (a tampered file is replaced; a write failure is retried)', async () => {
    const memory = createMemoryFs();
    memory.files.set(HOST_FILE, { data: new TextEncoder().encode(JSON.stringify({ v: 1, hostId: 'user@example.com' })), mode: 0o600 });
    const hostIds = createHostIdStore({ fs: memory.fs, file: HOST_FILE, randomUUID: () => '11111111-2222-4333-8444-555555555555', tempSuffix: () => 'h' });
    expect(await hostIds.get()).toBe('urn:uuid:11111111-2222-4333-8444-555555555555');
    expect(JSON.parse(memory.text(HOST_FILE)!)).toEqual({ v: 1, hostId: 'urn:uuid:11111111-2222-4333-8444-555555555555' });

    const failing = createMemoryFs();
    let fail = true;
    const fs = { ...failing.fs, rename: async (from: string, to: string) => (fail ? Promise.reject(new Error('EIO')) : failing.fs.rename(from, to)) };
    const flaky = createHostIdStore({ fs, file: HOST_FILE, randomUUID: () => '11111111-2222-4333-8444-555555555555', tempSuffix: () => 'h' });
    await expect(flaky.get()).rejects.toThrow();
    expect(failing.text(`${HOST_FILE}.h.tmp`)).toBeNull();
    fail = false;
    expect(await flaky.get()).toBe('urn:uuid:11111111-2222-4333-8444-555555555555');
  });
});
