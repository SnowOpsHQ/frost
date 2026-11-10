import type { KeyProtection } from '@app/specs/agent-proxy.spec';
import { isLocationCredentialSlot, isLocationProfileId, locationCredentialSlots, normalizeLocationPassword, normalizeLocationUsername } from '@app/specs/location-profiles.spec';
import { createCredentialStore, type CredentialFs, type SafeStorageLike, type SetKeyResult } from '../agent/credentials';

// A location profile's proxy sign-in (Phase 12 Task 10b; plan Decision 11, Global constraints
// "Secrets"; acceptance `location-profiles.feature.md`): a username and a password per profile, in
// their own file (`location-credentials.json`), through the agent's key store (`os` protection only,
// each blob sealed to its slot, atomic 0600 writes), two slots per profile as the MCP secrets keep
// theirs (`agent/mcp/secrets.ts`). Write-only for the renderer: the settings learn `hasCredentials`.
// Only the `login` listener (`proxy-auth.ts`) reads them, inside `withCredentials`, for the one
// answer it gives; nothing here logs, returns or caches either value.

type LocationSlot = `location-username.${string}` | `location-password.${string}`;

function normalize(slot: LocationSlot, value: unknown): string | null {
  return slot.startsWith('location-username.') ? normalizeLocationUsername(value) : normalizeLocationPassword(value);
}

export interface LocationSecrets {
  protection(): Promise<KeyProtection>;
  /** Both halves are stored and usable (`os` protection, decrypting, sealed to their slots). */
  hasCredentials(profileId: string): Promise<boolean>;
  /** Stores both (replacing any); on a failure of the second, the first is removed again. */
  setCredentials(profileId: string, username: string, password: string): Promise<SetKeyResult>;
  /** Removes both; whether that worked. */
  forget(profileId: string): Promise<boolean>;
  /**
   * Runs `fn` with the username and password (`ok: false` when either is missing or unusable). The
   * values live for the call only: `fn` must not keep or return them.
   */
  withCredentials<T>(profileId: string, fn: (username: string, password: string) => T | Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }>;
}

export interface LocationSecretsDeps {
  readonly safeStorage: SafeStorageLike;
  /** `<userData>/location-credentials.json`. */
  readonly file: string;
  readonly fs: CredentialFs;
  readonly platform?: NodeJS.Platform;
  /** One line per failure (never a value). */
  readonly log?: (line: string) => void;
  readonly tempSuffix?: () => string;
}

export function createLocationSecrets(deps: LocationSecretsDeps): LocationSecrets {
  const store = createCredentialStore<LocationSlot>({
    safeStorage: deps.safeStorage,
    file: deps.file,
    fs: deps.fs,
    isSlot: isLocationCredentialSlot,
    normalize,
    logPrefix: 'location credentials',
    // Twenty profiles, two slots each at their caps, encrypted and base64: well under 1 MiB.
    maxFileBytes: 1024 * 1024,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {}),
  });
  const slots = (profileId: string) => (isLocationProfileId(profileId) ? locationCredentialSlots(profileId) : null);
  return {
    protection: () => store.protection(),
    async hasCredentials(profileId) {
      const found = slots(profileId);
      if (!found) return false;
      return (await store.hasKey(found.username)) && (await store.hasKey(found.password));
    },
    async setCredentials(profileId, username, password) {
      const found = slots(profileId);
      if (!found || normalizeLocationUsername(username) === null || normalizeLocationPassword(password) === null) return 'invalid';
      const first = await store.setKey(found.username, username);
      if (first !== 'stored') return first;
      const second = await store.setKey(found.password, password);
      if (second !== 'stored') {
        // No half of a sign-in is left: not the new username, nor the old password beside it.
        await store.clearKey(found.username);
        await store.clearKey(found.password);
      }
      return second;
    },
    async forget(profileId) {
      const found = slots(profileId);
      if (!found) return false;
      const username = await store.clearKey(found.username);
      const password = await store.clearKey(found.password);
      return username && password;
    },
    async withCredentials(profileId, fn) {
      const found = slots(profileId);
      if (!found) return { ok: false };
      const outer = await store.withKey(found.username, async (username) => {
        const inner = await store.withKey(found.password, (password) => fn(username, password));
        return inner;
      });
      if (!outer.ok || !outer.value.ok) return { ok: false };
      return { ok: true, value: outer.value.value };
    },
  };
}

/** Secrets in memory (tests). `protection` other than `os` refuses to store, as the real store does. */
export function createMemoryLocationSecrets(protection: KeyProtection = 'os'): LocationSecrets & { readonly peek: () => ReadonlyMap<string, { username: string; password: string }> } {
  const stored = new Map<string, { username: string; password: string }>();
  return {
    protection: async () => protection,
    hasCredentials: async (profileId) => protection === 'os' && stored.has(profileId),
    async setCredentials(profileId, username, password) {
      if (!isLocationProfileId(profileId) || normalizeLocationUsername(username) === null || normalizeLocationPassword(password) === null) return 'invalid';
      if (protection !== 'os') return 'no-keychain';
      stored.set(profileId, { username, password });
      return 'stored';
    },
    async forget(profileId) {
      stored.delete(profileId);
      return true;
    },
    async withCredentials(profileId, fn) {
      const found = protection === 'os' ? stored.get(profileId) : undefined;
      if (!found) return { ok: false };
      return { ok: true, value: await fn(found.username, found.password) };
    },
    peek: () => stored,
  };
}
