// Spec: specs/data-sources.spec.ts (DATA_CREDENTIAL_SLOTS, DATA_PROVIDER_SLOTS, DATA_CREDENTIALS_FILE,
// normalizeDataSecret), specs/data-sources.schema.ts (DataSourcesView, DATA_SET_KEY_RESULTS),
// specs/agent-proxy.spec.ts (KEY_PROTECTIONS)
// Acceptance: specs/data-sources.feature.md (Keys) · plan docs/plans/phase-12-big-bets.md, Decision 4, Task 1
import { describe, expect, test, vi } from 'vitest';
import { DATA_CREDENTIAL_SLOTS, DATA_PROVIDERS, normalizeDataSecret } from '@app/specs/data-sources.spec';
import { createDataApiClient } from '../api-client';
import { createDataCredentialStore } from '../credentials';
import { createDataSourcesService } from '../service';
import { allOpen, dataStore, DFS_LOGIN, DFS_PASSWORD, FILE, recordingFetch, SERPAPI_KEY, SERPER_KEY } from './fakes';

describe('data credentials', () => {
  test('data-credentials-need-os-protection', async () => {
    for (const options of [{ available: false }, { weak: true }]) {
      const { store, memory } = dataStore(options);
      const service = createDataSourcesService({ store, isOpen: allOpen });
      expect(await service.setKey({ provider: 'serpapi', key: SERPAPI_KEY })).toBe('no-keychain');
      expect(await service.setKey({ provider: 'dataforseo', login: DFS_LOGIN, password: DFS_PASSWORD })).toBe('no-keychain');
      expect(memory.files.size).toBe(0);
      const view = await service.status();
      expect(view.protection).toBe(options.available === false ? 'unavailable' : 'weak');
      for (const provider of DATA_PROVIDERS) expect(view.providers[provider].hasKey, provider).toBe(false);
    }
    // A good blob already in the file (written where a keychain worked) is not used on a machine with
    // only Chromium's fixed key: no request is sent, and the refusal says why.
    const weak = dataStore({ weak: true });
    weak.memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { serpapi: weak.safe.blob(`frost-agent-key/2\nserpapi\n${SERPAPI_KEY}`, 'v11') } })), mode: 0o600 });
    expect((await createDataSourcesService({ store: weak.store, isOpen: allOpen }).status()).providers.serpapi.hasKey).toBe(false);
    const { fetch, calls } = recordingFetch();
    const build = vi.fn((secrets: { serpapi?: string }) => ({ method: 'GET' as const, url: `https://serpapi.com/search.json?${new URLSearchParams({ q: 'x', api_key: secrets.serpapi! }).toString()}` }));
    const client = createDataApiClient({ store: weak.store, isOpen: allOpen, fetch, sleep: async () => undefined });
    expect(await client.dataApiRequest('serpapi', 'serp', build)).toMatchObject({ ok: false, refusal: 'no-keychain' });
    expect(build).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('data-credentials-sealed-to-slot', async () => {
    const { store, memory, safe } = dataStore();
    const service = createDataSourcesService({ store, isOpen: allOpen });
    expect(await service.setKey({ provider: 'serpapi', key: SERPAPI_KEY })).toBe('stored');
    expect(await service.setKey({ provider: 'serper', key: SERPER_KEY })).toBe('stored');
    const text = memory.text(FILE)!;
    expect(text).not.toContain(SERPAPI_KEY);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    // Move SerpApi's blob into Serper's slot: Serper has no usable key, and nothing is sent with SerpApi's key.
    const stored = JSON.parse(text) as { version: 1; keys: Record<string, string> };
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { serpapi: stored.keys.serpapi, serper: stored.keys.serpapi } })), mode: 0o600 });
    const reopened = createDataCredentialStore({ safeStorage: safe.storage, file: FILE, fs: memory.fs, platform: 'linux' });
    expect(await reopened.hasKey('serper')).toBe(false);
    expect(await reopened.hasKey('serpapi')).toBe(true);
    const { fetch, calls } = recordingFetch();
    const client = createDataApiClient({ store: reopened, isOpen: allOpen, fetch, sleep: async () => undefined });
    const outcome = await client.dataApiRequest('serper', 'serp', (secrets) => ({ method: 'POST', url: 'https://google.serper.dev/search', headers: { 'x-api-key': secrets.serper!, 'content-type': 'application/json' }, body: '{"q":"x"}' }));
    expect(outcome).toMatchObject({ ok: false, refusal: 'key-failed' });
    expect(calls).toEqual([]);
    // Only the data slots exist in this file.
    expect(await reopened.setKey('anthropic' as 'serpapi', SERPAPI_KEY)).toBe('invalid');
  });

  test('data-credentials-secret-rules', () => {
    for (const slot of DATA_CREDENTIAL_SLOTS) {
      expect(normalizeDataSecret(slot, `  ${DFS_PASSWORD}\n`), slot).toBe(DFS_PASSWORD);
      for (const bad of ['', '   ', 'a b c d e f g h', 'line\nbreak-12345', 'tab\tinside-12345', 'ключ-0123456789', 42, null]) expect(normalizeDataSecret(slot, bad), `${slot} ${JSON.stringify(bad)}`).toBeNull();
    }
    // A login may be shorter than a key.
    expect(normalizeDataSecret('dataforseo-login', 'a@b.io')).toBe('a@b.io');
    expect(normalizeDataSecret('dataforseo-password', 'a@b.io')).toBeNull();
  });

  test('dataforseo-needs-both-slots', async () => {
    const { store } = dataStore();
    const service = createDataSourcesService({ store, isOpen: allOpen });
    const { fetch, calls } = recordingFetch();
    const client = createDataApiClient({ store, isOpen: allOpen, fetch, sleep: async () => undefined });
    const request = () =>
      client.dataApiRequest('dataforseo', 'serp', (secrets) => ({
        method: 'POST',
        url: 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
        headers: { authorization: `Basic ${Buffer.from(`${secrets['dataforseo-login']}:${secrets['dataforseo-password']}`).toString('base64')}`, 'content-type': 'application/json' },
        body: '[{"keyword":"frost","location_code":2840,"language_code":"en"}]',
      }));

    // Only the login: no key, and nothing is sent.
    expect(await service.setKey({ provider: 'dataforseo', login: DFS_LOGIN })).toBe('stored');
    expect((await service.status()).providers.dataforseo.hasKey).toBe(false);
    expect(await request()).toMatchObject({ ok: false, refusal: 'no-key' });
    expect(calls).toEqual([]);

    // The password on its own: the login stays.
    expect(await service.setKey({ provider: 'dataforseo', password: DFS_PASSWORD })).toBe('stored');
    expect(await store.hasKey('dataforseo-login')).toBe(true);
    expect((await service.status()).providers.dataforseo.hasKey).toBe(true);
    expect(await request()).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Basic ${Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64')}`);

    // An invalid half stores nothing (the other half is untouched).
    expect(await service.setKey({ provider: 'dataforseo', login: 'a b', password: `${DFS_PASSWORD}-new` })).toBe('invalid');
    expect(await store.withKey('dataforseo-password', (value) => value === DFS_PASSWORD)).toEqual({ ok: true, value: true });

    // Clearing the provider clears both slots.
    expect(await service.clearKey('dataforseo')).toBe(true);
    expect(await store.hasKey('dataforseo-login')).toBe(false);
    expect(await store.hasKey('dataforseo-password')).toBe(false);
    // Neither slot alone, when the other is cleared.
    expect(await service.setKey({ provider: 'dataforseo', password: DFS_PASSWORD })).toBe('stored');
    expect((await service.status()).providers.dataforseo.hasKey).toBe(false);
  });
});
