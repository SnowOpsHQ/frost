import path from 'node:path';
import { CHATGPT_CREDENTIALS_FILE, CHATGPT_HOST_ID_FILE } from '@app/specs/agent-chatgpt.spec';
import type { CredentialFs, SafeStorageLike } from '../credentials';
import { createHostIdStore } from './host-id';
import { createChatgptAuth, type ChatgptAuth, type ChatgptAuthDeps } from './service';
import { createChatgptStore, type ChatgptStore } from './store';

// The ChatGPT plan route's main-side pieces (plan `docs/plans/agent-chatgpt-plan.md`, Tasks 2 and 3):
// the sign-in service, its store and host id, and the route (`./route`: the model list, readiness,
// plan failures) that `../index.ts` hands to the model proxy and the session. Task 5: the sign-in
// procedures (`signIn`, `cancel`, `signOut`, `acknowledge`) on the IPC router and the settings.

export { createChatgptAuth, type ChatgptAuth, type ChatgptAuthDeps, type ChatgptTokenFailure, type ListModelsResult, type WithAccessTokenOptions, type WithAccessTokenResult } from './service';
export { createChatgptStore, type ChatgptStore } from './store';
export { createHostIdStore, type HostIdStore } from './host-id';
export { createChatgptRoute, type ChatgptRoute, type ChatgptRouteDeps } from './route';

export interface ChatgptAuthSystemDeps extends Omit<ChatgptAuthDeps, 'store' | 'hostId'> {
  readonly userData: string;
  /** Default: the encrypted store in `userData` (the unpackaged e2e seam may keep it in memory, `./e2e-seam`). */
  readonly store?: ChatgptStore;
  readonly fs: CredentialFs;
  readonly safeStorage: SafeStorageLike;
  readonly platform?: NodeJS.Platform;
}

/** The service with its store and host id in `userData` (`CHATGPT_CREDENTIALS_FILE`, `CHATGPT_HOST_ID_FILE`). */
export function createChatgptAuthInUserData(deps: ChatgptAuthSystemDeps): ChatgptAuth {
  const { userData, fs, safeStorage, platform, store: given, ...rest } = deps;
  const log = rest.log;
  const store = given ?? createChatgptStore({ safeStorage, fs, file: path.join(userData, CHATGPT_CREDENTIALS_FILE), ...(platform ? { platform } : {}), ...(log ? { log } : {}) });
  const hostId = createHostIdStore({ fs, file: path.join(userData, CHATGPT_HOST_ID_FILE), ...(log ? { log } : {}) });
  return createChatgptAuth({ ...rest, store, hostId });
}
