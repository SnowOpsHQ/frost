import type { LocationProfilesRepository, LocationProfileValues, StoredLocationProfile } from '@app/db';
import type { LocationService } from '@app/ipc-contract';
import { isLocationPort, isLocationProfileId, isLocationProxyScheme, LOCATION_LIMITS, normalizeLocationHost, normalizeLocationLabel, schemeTakesCredentials, type LocationNewTabResult, type LocationWriteResult } from '@app/specs/location-profiles.spec';
import { LocationProfileInputSchema, LocationProfilesViewSchema, type LocationProfile, type LocationProfileInput, type LocationProfilesView, type TabLocation } from '@app/specs/location-profiles.schema';
import type { LocationPartitions } from './partitions';
import type { LocationSecrets } from './secrets';

// Location profiles' service (Phase 12 Task 10b; acceptance `location-profiles.feature.md`): the
// `locations.*` procedures over the profile rows (`location_profiles`, no secret), the key store
// (`secrets.ts`, write-only: the view says `hasCredentials`, never a value) and the partitions
// (`partitions.ts`). Writes run one at a time.
// - create / update: the label and host normalised and checked (`invalid`), a sign-in only for
//   `http` / `https` (`socks-credentials`) and only with `os` protection (`no-keychain`), at most
//   `LOCATION_LIMITS.maxProfiles` (`limit`). Update first removes a sign-in saved for another proxy
//   (scheme, host or port changed, or now SOCKS5; `failed` and nothing changed if it cannot), then
//   closes the profile's tabs and resets its partition; a sign-in is never sent to a proxy it was not
//   saved for. A failed sign-in write leaves no half of it behind.
// - remove: forgets its sign-in first (`failed`, nothing removed, if it cannot), then closes its tabs,
//   retires its partition and deletes the row.
// - newTab: prepares the partition (proxy set and awaited, then browse-class), then opens the tab.

/** What the service needs of the browser controller. */
export interface LocationTabs {
  /** Closes every tab of the profile and drops its closed tabs (Reopen Closed Tab). */
  forgetLocation(profileId: string): void;
  /** Opens a new, active, empty tab on the profile's partition; its id, or `null` (no window, tab limit). */
  openLocationTab(location: TabLocation): number | null;
}

export interface LocationProfilesDeps {
  readonly repo: LocationProfilesRepository;
  readonly secrets: LocationSecrets;
  readonly partitions: LocationPartitions;
  readonly tabs: LocationTabs;
  readonly uuid: (now?: number) => string;
  readonly now?: () => number;
  /** One line per failure (never a secret, a host or a label). */
  readonly log?: (line: string) => void;
}

/** The input's values as stored, or `null` when they are not valid. */
function valuesOf(input: LocationProfileInput): LocationProfileValues | null {
  const label = normalizeLocationLabel(input.label);
  const host = normalizeLocationHost(input.host);
  if (label === null || host === null || !isLocationProxyScheme(input.scheme) || !isLocationPort(input.port)) return null;
  return { label, scheme: input.scheme, host, port: input.port };
}

const sameProxy = (a: Pick<LocationProfileValues, 'scheme' | 'host' | 'port'>, b: Pick<LocationProfileValues, 'scheme' | 'host' | 'port'>): boolean => a.scheme === b.scheme && a.host === b.host && a.port === b.port;

export function createLocationProfiles(deps: LocationProfilesDeps): LocationService {
  const { repo, secrets, partitions, tabs } = deps;
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log?.(`location: ${line}`);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>, fallback: T, what: string): Promise<T> => {
    const next = queue.then(run, run).catch(() => {
      log(`${what} failed`);
      return fallback;
    });
    queue = next;
    return next;
  };

  /** The input checked again with its schema (the router already did; main never trusts a caller). */
  const parse = (input: unknown): LocationProfileInput | null => {
    const parsed = LocationProfileInputSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
  };

  /** Whether the input's sign-in may be stored here (`null`: yes, or none given). */
  const credentialRefusal = async (input: LocationProfileInput): Promise<LocationWriteResult | null> => {
    if (input.username === undefined) return null;
    if (!schemeTakesCredentials(input.scheme)) return 'socks-credentials';
    return (await secrets.protection()) === 'os' ? null : 'no-keychain';
  };

  const viewOf = async (row: StoredLocationProfile): Promise<LocationProfile> => ({
    id: row.id,
    label: row.label,
    scheme: row.scheme,
    host: row.host,
    port: row.port,
    hasCredentials: schemeTakesCredentials(row.scheme) && (await secrets.hasCredentials(row.id)),
  });

  return {
    async list(): Promise<LocationProfilesView> {
      try {
        const rows = await repo.list();
        const view = { protection: await secrets.protection(), profiles: await Promise.all(rows.map(viewOf)) };
        const parsed = LocationProfilesViewSchema.safeParse(view);
        if (parsed.success) return parsed.data;
        log('a profile view did not fit its schema');
      } catch {
        log('the profiles could not be read');
      }
      return { protection: 'unavailable', profiles: [] };
    },

    create: (raw) =>
      serial(
        async (): Promise<LocationWriteResult> => {
          const input = parse(raw);
          const values = input && valuesOf(input);
          if (!input || !values) return 'invalid';
          const refusal = await credentialRefusal(input);
          if (refusal !== null) return refusal;
          if ((await repo.list()).length >= LOCATION_LIMITS.maxProfiles) return 'limit';
          const at = now();
          const id = deps.uuid(at);
          if (!(await repo.insert(id, values, at))) return (await repo.list()).length >= LOCATION_LIMITS.maxProfiles ? 'limit' : 'failed';
          if (input.username !== undefined && input.password !== undefined) {
            const stored = await secrets.setCredentials(id, input.username, input.password);
            if (stored !== 'stored') {
              // Never a profile that looks signed in but is not: it goes again, with any half of its sign-in.
              if (!(await secrets.forget(id))) log('a partial sign-in could not be removed');
              await repo.remove(id);
              return stored === 'no-keychain' ? 'no-keychain' : stored === 'invalid' ? 'invalid' : 'failed';
            }
          }
          return 'saved';
        },
        'failed',
        'creating a profile',
      ),

    update: (id, raw) =>
      serial(
        async (): Promise<LocationWriteResult> => {
          if (!isLocationProfileId(id)) return 'invalid';
          const input = parse(raw);
          const values = input && valuesOf(input);
          if (!input || !values) return 'invalid';
          const existing = await repo.get(id);
          if (!existing) return 'not-found';
          const refusal = await credentialRefusal(input);
          if (refusal !== null) return refusal;
          // A sign-in saved for another proxy (scheme, host or port changed, or now SOCKS5) goes first,
          // before anything else changes: if it cannot be removed, nothing changes and the user retries.
          if ((!sameProxy(existing, values) || !schemeTakesCredentials(values.scheme)) && !(await secrets.forget(id))) {
            log('a sign-in for the old proxy could not be removed');
            return 'failed';
          }
          // Its tabs go, then the partition is cleared: the next tab starts clean on the new proxy.
          tabs.forgetLocation(id);
          await partitions.reset(id);
          if (!(await repo.update(id, values, now()))) return 'failed';
          if (input.username !== undefined && input.password !== undefined) {
            const stored = await secrets.setCredentials(id, input.username, input.password);
            if (stored !== 'stored') {
              // No half sign-in is left behind; if even that fails it is said (a lone half is never used).
              if (!(await secrets.forget(id))) log('a partial sign-in could not be removed');
              return stored === 'no-keychain' ? 'no-keychain' : 'failed';
            }
          }
          return 'saved';
        },
        'failed',
        'updating a profile',
      ),

    remove: (id) =>
      serial(
        async (): Promise<LocationWriteResult> => {
          if (!isLocationProfileId(id)) return 'invalid';
          // The sign-in goes first: if it cannot be removed, the profile stays (no orphaned secret) and the user retries.
          if (!(await secrets.forget(id))) {
            log('a sign-in could not be removed');
            return 'failed';
          }
          // A tampered row reads as none, and is removed all the same.
          tabs.forgetLocation(id);
          await partitions.retire(id);
          return (await repo.remove(id)) ? 'removed' : 'not-found';
        },
        'failed',
        'removing a profile',
      ),

    newTab: (profileId) =>
      serial(
        async (): Promise<LocationNewTabResult> => {
          const row = isLocationProfileId(profileId) ? await repo.get(profileId) : null;
          if (!row) return 'not-found';
          try {
            await partitions.ensure(row.id, row);
          } catch {
            log('a location partition could not be prepared');
            return 'failed';
          }
          return tabs.openLocationTab({ profileId: row.id, label: row.label }) === null ? 'no-window' : 'opened';
        },
        'failed',
        'opening a location tab',
      ),
  };
}
