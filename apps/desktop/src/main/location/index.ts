import fs from 'node:fs/promises';
import path from 'node:path';
import { uuidv7, type LocationProfilesRepository } from '@app/db';
import type { LocationService } from '@app/ipc-contract';
import { LOCATION_CREDENTIALS_FILE } from '@app/specs/location-profiles.spec';
import type { CredentialFs, SafeStorageLike } from '../agent/credentials';
import { createLocationPartitions, type LocationPartitionsDeps } from './partitions';
import { createLocationProfiles, type LocationTabs } from './profiles';
import { installProxyLogin, type LoginApp } from './proxy-auth';
import { createLocationSecrets } from './secrets';

// Location profiles' main-side composition (Phase 12 Task 10b; plan Decision 11; acceptance
// `location-profiles.feature.md`): the sign-in store in `userData` (`location-credentials.json`), the
// in-memory partitions (proxy set and awaited, then browse-class), the one `login` listener (answers
// only a profile's own proxy on its own partition), and the `locations.*` service. Main wires it
// with one line after app ready (before any location tab can exist) and passes `service` to the IPC.

export interface LocationsElectron {
  readonly app: LoginApp & { getPath(name: 'userData'): string };
  readonly safeStorage: SafeStorageLike;
  /** The profile rows (`sessionStore.locationProfiles`). */
  readonly store: LocationProfilesRepository;
  /** The browser controller: opens and forgets location tabs. */
  readonly browser: LocationTabs;
  /** One line per failure (never a secret, a URL or a host). */
  readonly log?: (line: string) => void;
  readonly fs?: CredentialFs;
  readonly platform?: NodeJS.Platform;
  /** Tests replace Electron's sessions. */
  readonly partitions?: LocationPartitionsDeps;
}

export interface LocationsMain {
  readonly service: LocationService;
}

export function setupLocations(deps: LocationsElectron): LocationsMain {
  const log = deps.log ?? (() => undefined);
  const secrets = createLocationSecrets({ safeStorage: deps.safeStorage, file: path.join(deps.app.getPath('userData'), LOCATION_CREDENTIALS_FILE), fs: deps.fs ?? fs, platform: deps.platform ?? process.platform, log });
  const partitions = createLocationPartitions({ ...deps.partitions, log });
  installProxyLogin(deps.app, { proxyOf: partitions.proxyOf, withCredentials: (profileId, fn) => secrets.withCredentials(profileId, fn), log });
  return { service: createLocationProfiles({ repo: deps.store, secrets, partitions, tabs: deps.browser, uuid: uuidv7, log }) };
}
