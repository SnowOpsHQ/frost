// Spec: specs/location-profiles.spec.ts (LOCATION_CREDENTIALS_FILE, locationPartition)
// Acceptance: specs/location-profiles.feature.md (Behaviour: the composition; proxy-login-only-for-its-proxy end to end in main)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Task 10b
import { describe, expect, test, vi } from 'vitest';
import type { LocationProfilesRepository, StoredLocationProfile } from '@app/db';
import { locationPartition } from '@app/specs/location-profiles.spec';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import { fakeEvent } from '../../../test/electron-fake';
import type { LocationSession } from '../partitions';
import type { LoginListener } from '../proxy-auth';
import { setupLocations } from '../index';

function memoryRepo(): LocationProfilesRepository {
  const rows = new Map<string, StoredLocationProfile>();
  return {
    list: async () => [...rows.values()],
    get: async (id) => rows.get(id) ?? null,
    insert: async (id, values, at) => (rows.has(id) ? false : (rows.set(id, { id, ...values, createdAt: at, updatedAt: at }), true)),
    update: async (id, values, at) => (rows.has(id) ? (rows.set(id, { ...rows.get(id)!, ...values, updatedAt: at }), true) : false),
    remove: async (id) => rows.delete(id),
  };
}

describe('locations setup', () => {
  test('location-setup-wires-login-partition-and-store', async () => {
    const memory = createMemoryFs();
    const safe = createFakeSafeStorage();
    let listener: LoginListener | null = null;
    const app = { getPath: () => '/user', on: vi.fn((_event: 'login', l: LoginListener) => (listener = l)) };
    const sessions = new Map<string, LocationSession>();
    const fromPartition = (partition: string) => {
      if (!sessions.has(partition)) sessions.set(partition, { setProxy: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) });
      return sessions.get(partition)!;
    };
    const register = vi.fn();
    const browser = { forgetLocation: vi.fn(), openLocationTab: vi.fn(() => 3) };
    const { service } = setupLocations({ app, safeStorage: safe.storage, store: memoryRepo(), browser, fs: memory.fs, platform: 'linux', partitions: { fromPartition, register } });
    expect(app.on).toHaveBeenCalledExactlyOnceWith('login', expect.any(Function));
    expect(await service.create({ label: 'Berlin', scheme: 'https', host: 'proxy.example.net', port: 443, username: 'me', password: 'pw-SECRET' })).toBe('saved');
    // The sign-in went to its own file under userData, encrypted.
    expect([...memory.files.keys()].map((file) => file.replace(/\\/g, '/'))).toEqual(['/user/location-credentials.json']);
    const id = (await service.list()).profiles[0]!.id;
    expect(await service.newTab(id)).toBe('opened');
    const session = sessions.get(locationPartition(id))!;
    expect(register).toHaveBeenCalledExactlyOnceWith(session);
    // The listener answers that partition's proxy with the stored sign-in.
    const callback = vi.fn();
    listener!(fakeEvent(), { session, isDestroyed: () => false }, { firstAuthAttempt: true }, { isProxy: true, host: 'proxy.example.net', port: 443 }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith('me', 'pw-SECRET'));
  });
});
