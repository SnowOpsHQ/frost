// Test-only: the pieces the Search Console unit tests share: the fake Google (`e2e/fake-google.ts`), a
// memory secret store, a fake gesture tracker and browser opener, the real loopback listener, a clock,
// and a `fetch` that can hold calls to one endpoint until released.
import { GSC_SCOPE } from '@app/specs/gsc.spec';
import type { SecretName } from '@app/specs/secret-store.spec';
import { FAKE_GSC_CLIENT_ID, FAKE_GSC_CLIENT_SECRET, startFakeGoogle, type FakeGoogle } from '../../../../e2e/fake-google';
import { startLoopback, type Loopback, type StartLoopbackOptions } from '../../account/loopback';
import type { GscConfig } from '../config';
import type { FetchLike } from '../http';

export const WINDOW_ID = 7;
export const OTHER_WINDOW_ID = 8;
/** 2026-10-28 12:00 UTC: a range of 28 days is 2026-09-29 … 2026-10-26. */
export const START_MS = Date.UTC(2026, 9, 28, 12);
/** The signed-in frost account's user ID the connection belongs to. */
export const OWNER = 'user-1';

/** A stored connection blob (`gsc`), owned by `owner`. */
export const storedBlob = (refreshToken = 'stored-refresh-token-1', owner: string = OWNER): string => JSON.stringify({ v: 1, refreshToken, scope: GSC_SCOPE, owner });

export interface MemoryStore {
  persistent: boolean;
  readonly values: Map<SecretName, string>;
  read(name: SecretName): string | null;
  write(name: SecretName, value: string): void;
  delete(name: SecretName): void;
}

export function memoryStore(persistent = true): MemoryStore {
  const values = new Map<SecretName, string>();
  return {
    persistent,
    values,
    read: (name) => values.get(name) ?? null,
    write: (name, value) => void values.set(name, value),
    delete: (name) => void values.delete(name),
  };
}

type Endpoint = 'token' | 'revoke' | 'api';

export interface Harness {
  readonly google: FakeGoogle;
  readonly config: GscConfig;
  readonly store: MemoryStore;
  readonly logs: string[];
  readonly opened: string[];
  readonly loopbacks: Loopback[];
  readonly clock: { now: number };
  /** The signed-in frost account (`null`: signed out). */
  readonly account: { userId: string | null };
  readonly currentUser: () => string | null;
  /** Makes one user gesture live in `WINDOW_ID` (spent by the next `consumeGesture`). */
  grant(): void;
  /** Calls to `endpoint` wait until the returned function is called. */
  hold(endpoint: Endpoint): () => void;
  /** Every fetch made, in order (its URL). */
  readonly fetched: string[];
  readonly fetch: FetchLike;
  readonly startLoopback: (options: StartLoopbackOptions) => Promise<Loopback>;
  readonly openInBrowser: (url: string, userGesture: boolean) => boolean;
  readonly consumeGesture: (windowId: number) => boolean;
  readonly log: (message: string) => void;
  readonly now: () => number;
  /** Acts as the browser on the last opened consent URL: the consent page's redirect, then the loopback. */
  follow(url?: string): Promise<{ consent: Response; callback: Response }>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const google = await startFakeGoogle();
  const config: GscConfig = { clientId: FAKE_GSC_CLIENT_ID, clientSecret: FAKE_GSC_CLIENT_SECRET, endpoints: google.endpoints };
  const store = memoryStore();
  const logs: string[] = [];
  const opened: string[] = [];
  const loopbacks: Loopback[] = [];
  const fetched: string[] = [];
  const clock = { now: START_MS };
  const account: { userId: string | null } = { userId: OWNER };
  let gestures = 0;
  const holds = new Map<Endpoint, Promise<void>>();

  const endpointOf = (url: string): Endpoint | null => {
    if (url.startsWith(google.endpoints.tokenUrl)) return 'token';
    if (url.startsWith(google.endpoints.revokeUrl)) return 'revoke';
    if (url.startsWith(google.endpoints.apiBase)) return 'api';
    return null;
  };

  const fetch: FetchLike = async (url, init) => {
    fetched.push(url);
    const endpoint = endpointOf(url);
    const gate = endpoint === null ? undefined : holds.get(endpoint);
    if (gate) await gate;
    return globalThis.fetch(url, init);
  };

  return {
    google,
    config,
    store,
    logs,
    opened,
    loopbacks,
    clock,
    account,
    currentUser: () => account.userId,
    fetched,
    grant: () => void (gestures = 1),
    hold: (endpoint) => {
      let release!: () => void;
      holds.set(endpoint, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        holds.delete(endpoint);
        release();
      };
    },
    fetch,
    startLoopback: async (options) => {
      const loopback = await startLoopback({ ...options, doneLingerMs: 50 });
      loopbacks.push(loopback);
      return loopback;
    },
    openInBrowser: (url, userGesture) => {
      if (!userGesture) return false;
      opened.push(url);
      return true;
    },
    consumeGesture: (windowId) => {
      if (windowId !== WINDOW_ID || gestures === 0) return false;
      gestures = 0;
      return true;
    },
    log: (message) => void logs.push(message),
    now: () => clock.now,
    async follow(url = opened.at(-1)) {
      if (!url) throw new Error('harness: nothing was opened');
      const consent = await globalThis.fetch(url, { redirect: 'manual' });
      const location = consent.headers.get('location');
      if (!location) throw new Error(`harness: the consent page answered ${consent.status}`);
      const callback = await globalThis.fetch(location, { redirect: 'manual' });
      return { consent, callback };
    },
    async close() {
      for (const loopback of loopbacks) loopback.close();
      await google.close();
    },
  };
}
