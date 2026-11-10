import { isDataCredentialSlot, normalizeDataSecret, type DataCredentialSlot } from '@app/specs/data-sources.spec';
import { createCredentialStore, type CredentialFs, type CredentialStore, type SafeStorageLike } from '../agent/credentials';

// The data sources' key store (Phase 12 Task 1; plan Decision 4; spec `data-sources.spec.ts`;
// acceptance `data-sources.feature.md`, Keys): the agent's reviewed `createCredentialStore` with the
// data slots (`DATA_CREDENTIAL_SLOTS`), one secret each, in its own file (`DATA_CREDENTIALS_FILE`).
// Everything the agent's store guarantees holds here: `os` protection only (`weak` and
// `unavailable` refuse), each blob sealed to its slot, atomic 0600 writes, and no method that returns
// a key except `withKey`, which only the data API client calls (`api-client.ts`).

export interface DataCredentialStoreDeps {
  readonly safeStorage: SafeStorageLike;
  /** `<userData>/data-credentials.json`. */
  readonly file: string;
  readonly fs: CredentialFs;
  readonly platform?: NodeJS.Platform;
  /** One line per failure (never a key). */
  readonly log?: (line: string) => void;
  readonly tempSuffix?: () => string;
}

export type DataCredentialStore = CredentialStore<DataCredentialSlot>;

export function createDataCredentialStore(deps: DataCredentialStoreDeps): DataCredentialStore {
  return createCredentialStore<DataCredentialSlot>({
    safeStorage: deps.safeStorage,
    file: deps.file,
    fs: deps.fs,
    isSlot: isDataCredentialSlot,
    normalize: normalizeDataSecret,
    logPrefix: 'data credentials',
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {}),
  });
}
