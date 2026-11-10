// Spec: specs/location-profiles.spec.ts (LOCATION_LIMITS, LOCATION_CREDENTIALS_FILE, locationCredentialSlots, LOCATION_WRITE_RESULTS,
// LOCATION_NEW_TAB_RESULTS), specs/location-profiles.schema.ts (LocationProfilesViewSchema), specs/agent-proxy.spec.ts (KEY_PROTECTIONS)
// Acceptance: specs/location-profiles.feature.md (Behaviour; location-credentials-never-leave-main)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Global constraints "Secrets", Task 10b
import { describe, expect, test, vi } from 'vitest';
import type { LocationProfilesRepository, LocationProfileValues, StoredLocationProfile } from '@app/db';
import { LOCATION_LIMITS, type LocationProxy } from '@app/specs/location-profiles.spec';
import { LocationProfilesViewSchema, type LocationProfileInput } from '@app/specs/location-profiles.schema';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import type { LocationPartitions } from '../partitions';
import { createLocationProfiles, type LocationTabs } from '../profiles';
import { createLocationSecrets } from '../secrets';

const FILE = '/user/location-credentials.json';
const PASS = 'proxy-pass-SECRET-0123';
const NOW = Date.UTC(2026, 10, 10, 12);
const BERLIN: LocationProfileInput = { label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, username: 'me', password: PASS };

function memoryRepo(): LocationProfilesRepository {
  const rows = new Map<string, StoredLocationProfile>();
  return {
    list: async () => [...rows.values()],
    get: async (id) => rows.get(id) ?? null,
    async insert(id, values, at) {
      if (rows.has(id) || rows.size >= LOCATION_LIMITS.maxProfiles) return false;
      rows.set(id, { id, ...values, createdAt: at, updatedAt: at });
      return true;
    },
    async update(id, values: LocationProfileValues, at) {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, { ...row, ...values, updatedAt: at });
      return true;
    },
    remove: async (id) => rows.delete(id),
  };
}

function setup(options: { weak?: boolean } = {}) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage(options);
  const log = vi.fn<(line: string) => void>();
  const secrets = createLocationSecrets({ safeStorage: safe.storage, file: FILE, fs: memory.fs, platform: 'linux', log });
  const repo = memoryRepo();
  const partitions = {
    ensure: vi.fn(async (_id: string, _proxy: LocationProxy) => ({}) as never),
    proxyOf: vi.fn(() => null),
    reset: vi.fn(async () => undefined),
    retire: vi.fn(async () => undefined),
  } satisfies LocationPartitions;
  const tabs = { forgetLocation: vi.fn(), openLocationTab: vi.fn(() => 5 as number | null) } satisfies LocationTabs;
  let n = 0;
  const service = createLocationProfiles({ repo, secrets, partitions, tabs, uuid: () => `01920000-0000-7000-8000-${(0xd00 + (n += 1)).toString(16).padStart(12, '0')}`, now: () => NOW, log });
  return { service, secrets, repo, partitions, tabs, memory, log };
}

describe('location profiles', () => {
  test('location-credentials-never-leave-main', async () => {
    const { service, secrets, memory, log } = setup();
    expect(await service.create(BERLIN)).toBe('saved');
    const view = await service.list();
    expect(LocationProfilesViewSchema.safeParse(view).success).toBe(true);
    expect(view.profiles).toEqual([{ id: expect.any(String), label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, hasCredentials: true }]);
    expect(JSON.stringify(view)).not.toContain(PASS);
    // Stored encrypted, 0600, sealed to their slots; only the closure sees them.
    expect(memory.text(FILE)).not.toContain(PASS);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    const id = view.profiles[0]!.id;
    expect(await secrets.withCredentials(id, (username, password) => `${username}:${password.length}`)).toEqual({ ok: true, value: `me:${PASS.length}` });
    expect(JSON.stringify(log.mock.calls)).not.toContain(PASS);
    // A SOCKS5 proxy takes none.
    expect(await service.create({ ...BERLIN, scheme: 'socks5', label: 'Tunnel' })).toBe('socks-credentials');
    const { username: _u, password: _p, ...bare } = BERLIN;
    expect(await service.create({ ...bare, scheme: 'socks5', label: 'Tunnel', host: '127.0.0.1', port: 9050 })).toBe('saved');
    // Without an OS keychain nothing is stored, and no profile is left looking signed in.
    const weak = setup({ weak: true });
    expect(await weak.service.create(BERLIN)).toBe('no-keychain');
    expect(weak.memory.files.size).toBe(0);
    expect((await weak.service.list()).profiles).toEqual([]);
    expect(await weak.service.create(bare)).toBe('saved');
    expect((await weak.service.list()).profiles[0]!.hasCredentials).toBe(false);
  });

  test('location-profile-input-checked', async () => {
    const { service } = setup();
    for (const input of [
      { ...BERLIN, label: '   ' },
      { ...BERLIN, host: 'https://proxy.example.net' },
      { ...BERLIN, host: 'proxy.example.net:3128' },
      { ...BERLIN, host: 'user@proxy.example.net' },
      { ...BERLIN, host: '*.example.net' },
      { ...BERLIN, port: 0 },
      { ...BERLIN, password: undefined },
    ]) {
      expect(await service.create(input as LocationProfileInput), JSON.stringify(input)).toBe('invalid');
    }
    // Normalised as stored: a trimmed label, a lower-case host.
    expect(await service.create({ ...BERLIN, label: '  Berlin  ', host: 'Proxy.Example.NET' })).toBe('saved');
    expect((await service.list()).profiles[0]).toMatchObject({ label: 'Berlin', host: 'proxy.example.net' });
  });

  test('location-profiles-capped', async () => {
    const { service } = setup();
    const { username: _u, password: _p, ...bare } = BERLIN;
    for (let i = 0; i < LOCATION_LIMITS.maxProfiles; i++) expect(await service.create({ ...bare, label: `L${i}` })).toBe('saved');
    expect(await service.create(bare)).toBe('limit');
  });

  test('location-edit-closes-tabs-and-guards-the-sign-in', async () => {
    const { service, secrets, partitions, tabs } = setup();
    expect(await service.create(BERLIN)).toBe('saved');
    const id = (await service.list()).profiles[0]!.id;
    // A label change keeps the sign-in, but closes the tabs and resets the partition first.
    const { username: _u, password: _p, ...bare } = BERLIN;
    expect(await service.update(id, { ...bare, label: 'Berlin 2' })).toBe('saved');
    expect(tabs.forgetLocation).toHaveBeenCalledWith(id);
    expect(partitions.reset).toHaveBeenCalledWith(id);
    expect(await secrets.hasCredentials(id)).toBe(true);
    // Another host without a new sign-in: the old one is removed (never sent to another proxy).
    expect(await service.update(id, { ...bare, host: 'other.example.net' })).toBe('saved');
    expect(await secrets.hasCredentials(id)).toBe(false);
    expect(await service.update(id, { ...BERLIN, host: 'other.example.net' })).toBe('saved');
    expect(await secrets.hasCredentials(id)).toBe(true);
    // To SOCKS5: the sign-in goes.
    expect(await service.update(id, { ...bare, scheme: 'socks5' })).toBe('saved');
    expect(await secrets.hasCredentials(id)).toBe(false);
    expect(await service.update('01920000-0000-7000-8000-00000000ffff', bare)).toBe('not-found');
  });

  test('location-remove-and-new-tab', async () => {
    const { service, secrets, partitions, tabs } = setup();
    expect(await service.create(BERLIN)).toBe('saved');
    const id = (await service.list()).profiles[0]!.id;
    // New tab: the partition is prepared (proxy, then browse-class) before the tab opens.
    const order: string[] = [];
    partitions.ensure.mockImplementationOnce(async () => {
      order.push('ensure');
      return {} as never;
    });
    tabs.openLocationTab.mockImplementationOnce(() => {
      order.push('open');
      return 7;
    });
    expect(await service.newTab(id)).toBe('opened');
    expect(order).toEqual(['ensure', 'open']);
    expect(partitions.ensure).toHaveBeenCalledWith(id, expect.objectContaining({ scheme: 'http', host: 'proxy.example.net', port: 3128 }));
    expect(tabs.openLocationTab).toHaveBeenCalledWith({ profileId: id, label: 'Berlin' });
    // A partition that cannot be prepared opens no tab.
    partitions.ensure.mockRejectedValueOnce(new Error('setProxy failed'));
    tabs.openLocationTab.mockClear();
    expect(await service.newTab(id)).toBe('failed');
    expect(tabs.openLocationTab).not.toHaveBeenCalled();
    tabs.openLocationTab.mockReturnValueOnce(null);
    expect(await service.newTab(id)).toBe('no-window');
    // Remove: tabs closed, partition retired, sign-in forgotten, row gone.
    expect(await service.remove(id)).toBe('removed');
    expect(tabs.forgetLocation).toHaveBeenLastCalledWith(id);
    expect(partitions.retire).toHaveBeenCalledWith(id);
    expect(await secrets.hasCredentials(id)).toBe(false);
    expect((await service.list()).profiles).toEqual([]);
    expect(await service.remove(id)).toBe('not-found');
    expect(await service.newTab(id)).toBe('not-found');
  });

  // Security review (Task 10b): a sign-in is removed before anything that depends on it changes.
  test('location-forget-failures-change-nothing', async () => {
    const { service, secrets, repo, partitions, tabs } = setup();
    expect(await service.create(BERLIN)).toBe('saved');
    const id = (await service.list()).profiles[0]!.id;
    const { username: _u, password: _p, ...bare } = BERLIN;
    const forget = vi.spyOn(secrets, 'forget');
    // Another host, and the old sign-in cannot be removed: failed, before the row, tabs or partition change.
    forget.mockResolvedValueOnce(false);
    expect(await service.update(id, { ...bare, host: 'other.example.net' })).toBe('failed');
    expect((await repo.get(id))!.host).toBe('proxy.example.net');
    expect(tabs.forgetLocation).not.toHaveBeenCalled();
    expect(partitions.reset).not.toHaveBeenCalled();
    expect(await secrets.hasCredentials(id)).toBe(true);
    // Retried: it goes through.
    expect(await service.update(id, { ...bare, host: 'other.example.net' })).toBe('saved');
    expect(await secrets.hasCredentials(id)).toBe(false);
    // A label-only edit never needs to forget.
    forget.mockClear();
    expect(await service.update(id, { ...bare, host: 'other.example.net', label: 'B' })).toBe('saved');
    expect(forget).not.toHaveBeenCalled();
    // A new sign-in that fails to store: its half is removed (and a failure to remove it is logged, never answered as saved).
    const set = vi.spyOn(secrets, 'setCredentials').mockResolvedValueOnce('failed');
    forget.mockResolvedValueOnce(false);
    expect(await service.update(id, { ...BERLIN, host: 'other.example.net' })).toBe('failed');
    expect(forget).toHaveBeenCalledWith(id);
    set.mockRestore();
    // Remove: the sign-in cannot be removed, so nothing is (the user can retry).
    expect(await service.update(id, { ...BERLIN, host: 'other.example.net' })).toBe('saved');
    tabs.forgetLocation.mockClear();
    forget.mockResolvedValueOnce(false);
    expect(await service.remove(id)).toBe('failed');
    expect(await repo.get(id)).not.toBeNull();
    expect(tabs.forgetLocation).not.toHaveBeenCalled();
    expect(partitions.retire).not.toHaveBeenCalled();
    expect(await service.remove(id)).toBe('removed');
    expect(partitions.retire).toHaveBeenCalledWith(id);
  });

  test('location-create-failed-sign-in-leaves-nothing', async () => {
    const { service, secrets, log } = setup();
    vi.spyOn(secrets, 'setCredentials').mockResolvedValueOnce('failed');
    const forget = vi.spyOn(secrets, 'forget').mockResolvedValueOnce(false);
    expect(await service.create(BERLIN)).toBe('failed');
    expect(forget).toHaveBeenCalledOnce();
    expect((await service.list()).profiles).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toContain('partial sign-in could not be removed');
  });
});
