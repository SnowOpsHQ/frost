import { X509Certificate } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { UpdateService } from '@app/ipc-contract';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import {
  UPDATE_FEED_SWITCH,
  UPDATE_PARTITION,
  UPDATE_PUBLIC_KEY_SWITCH,
  UPDATE_TEST_CERT_PATTERN,
  UPDATE_TEST_CERT_SWITCH,
  updateUserAgent,
  type UpdateState,
} from '@app/specs/update-client.spec';
import { updatePlatformKey } from '@app/specs/update-manifest.spec';
import { withE2ePublicHosts } from '../seo/fetcher';
import { createUpdateClient, type UpdateClient } from './client';
import { resolveFeed, resolveTrustedKeys } from './feed';
import { hardenUpdateSession, netResolve, netTransport, type UpdateNet, type UpdateSessionLike } from './fetch';
import { createPrefsStore } from './prefs';

// The update client in main, as the chrome reaches it (spec `update-client.spec.ts`; acceptance
// `update-client.feature.md`, Main). `startUpdateService` builds the client from Electron's objects:
// the dedicated in-memory session (`UPDATE_PARTITION`, hardened by `hardenUpdateSession`), `net`
// through it, its resolver, the feed and keys (`feed.ts`) and the prefs file. `index.ts` only starts
// it, hands `service` to the IPC handler and calls `dispose()` on quit.
//
// Fail safe and off the startup path: `startUpdateService` never throws and returns at once. The
// client (and the prefs file, only when a feed is configured) is built in the background; until then,
// and for good if building it fails (one log line), the service answers a `disabled` state at
// version 0, so the chrome shows nothing and startup never waits on, or breaks over, updates.
//
// `install()` never installs: on every build today (`install: 'manual'`) it reveals the verified file
// in the system file manager (`shell.showItemInFolder`); the user opens it. It never calls
// `openExternal` or `openPath` and never runs anything.
//
// The e2e seams, unpackaged builds only (a packaged build refuses to start with any of these
// switches, `PACKAGED_FORBIDDEN_SWITCHES`): the feed (`UPDATE_FEED_SWITCH`) and public key
// (`UPDATE_PUBLIC_KEY_SWITCH`), names not checked against private addresses (`E2E_PUBLIC_HOSTS_SWITCH`,
// shared with the bounded fetcher), and one pinned test certificate (`UPDATE_TEST_CERT_SWITCH`) that
// the update session, and only it, accepts.

/** The part of Electron's `shell` the service uses: only revealing a file, never opening one. */
export interface UpdateShell {
  showItemInFolder(fullPath: string): void;
}

/** Whether `file` is a regular file (not a link, a directory, or gone). */
const isRegularFile = async (file: string): Promise<boolean> => {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
};

/** `UpdateService` over a client: what the `update.*` procedures call. */
export function createUpdateService(client: UpdateClient, deps: { readonly shell: UpdateShell; readonly isFile?: (file: string) => Promise<boolean> }): UpdateService {
  const isFile = deps.isFile ?? isRegularFile;
  return {
    state: () => client.state(),
    watch: (sinceVersion, signal) => client.watch(sinceVersion, signal),
    check: () => client.checkNow(),
    // Started, not awaited (a download can take long): the chrome follows it through `watch`.
    download: async () => {
      void client.download();
      return client.state();
    },
    skip: () => client.skip(),
    setChecks: (checks) => client.setChecks(checks),
    install: async () => {
      const { status } = client.state();
      if (status.kind !== 'ready') return false;
      switch (status.install) {
        case 'manual':
          break;
        case 'restart':
          // TODO(update-restart): `autoUpdater.quitAndInstall()`, once a signed build's `autoUpdater` has
          // itself downloaded this update (`update-downloaded`). Unreachable today: `CURRENT_INSTALL_MODE`
          // is `manual` on every build (update-client.spec.ts, Install), so nothing is faked here.
          return false;
      }
      const file = client.readyFile();
      if (file === null || !(await isFile(file))) return false;
      // Still the same verified file after the check (a new check or download may have moved on).
      if (client.readyFile() !== file || client.state().status.kind !== 'ready') return false;
      deps.shell.showItemInFolder(file);
      return true;
    },
  };
}

/** The verify proc's request, as much of it as the pin needs. */
interface CertificateRequest {
  readonly certificate: { readonly data: string };
}

/** The DER SHA-256 of a PEM certificate (lowercase hex), or `null` when it does not parse. */
export function certificateSha256(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The e2e certificate pin (`UPDATE_TEST_CERT_SWITCH`): accepts (`0`) exactly the certificate whose
 * DER SHA-256 is `sha256`, and defers every other one to Chromium's own verification (`-3`).
 */
export function pinnedCertificateVerifier(sha256: string): (request: CertificateRequest, callback: (result: number) => void) => void {
  return (request, callback) => callback(certificateSha256(request.certificate.data) === sha256 ? 0 : -3);
}

/** The update session as the service sets it up: hardened, plus the e2e certificate pin. */
export type UpdateSession = UpdateSessionLike & {
  resolveHost(host: string): Promise<{ readonly endpoints: readonly { readonly address: string }[] }>;
  setCertificateVerifyProc(proc: ((request: CertificateRequest, callback: (result: number) => void) => void) | null): void;
};

export interface StartUpdateDeps {
  readonly app: {
    readonly isPackaged: boolean;
    getVersion(): string;
    getPath(name: 'userData'): string;
    readonly commandLine: { getSwitchValue(name: string): string };
  };
  readonly net: UpdateNet;
  readonly session: { fromPartition(partition: string, options: { cache: boolean }): unknown };
  readonly shell: UpdateShell;
  /** Default `process.env` (`FROST_UPDATE_FEED_URL`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

/** The state while the client is being built, or for good when that failed: nothing to show. */
const disabledState = (currentVersion: string): UpdateState => ({ version: 0, currentVersion, checks: 'on', lastCheckedAt: null, status: { kind: 'disabled' } });

/**
 * `UpdateService` over a client still being built (`pending`): `disabled` at version 0 until it is
 * ready, then the client's own (whose versions start at 1, so a waiting `watch` answers at once). If
 * `pending` resolves `null` (it failed) the service stays `disabled`: steps answer that state, `install`
 * `false`, and `watch` waits for its signal (the router's timeout), never answering in a loop.
 */
export function deferredUpdateService(pending: Promise<UpdateClient | null>, deps: { readonly shell: UpdateShell; readonly currentVersion: string }): { readonly service: UpdateService; dispose(): void } {
  const placeholder = disabledState(deps.currentVersion);
  let ready: UpdateService | null = null;
  let client: UpdateClient | null = null;
  let disposed = false;
  const settled = pending.then(
    (built) => {
      if (built === null) return null;
      if (disposed) {
        built.dispose();
        return null;
      }
      client = built;
      ready = createUpdateService(built, { shell: deps.shell });
      return ready;
    },
    () => null,
  );
  /** Waits for the client (or `signal`); `null`: none (failed, disposed, or the caller gave up). */
  const service = (signal?: AbortSignal): Promise<UpdateService | null> =>
    ready !== null
      ? Promise.resolve(ready)
      : Promise.race([settled, new Promise<null>((resolve) => (signal?.aborted ? resolve(null) : signal?.addEventListener('abort', () => resolve(null), { once: true })))]);
  const step = async (run: (s: UpdateService) => Promise<UpdateState>): Promise<UpdateState> => {
    const live = await service();
    return live === null ? placeholder : run(live);
  };
  return {
    service: {
      state: () => ready?.state() ?? placeholder,
      async watch(sinceVersion, signal) {
        if (ready === null && sinceVersion < placeholder.version) return placeholder;
        const live = await service(signal);
        if (live !== null) return live.watch(sinceVersion, signal);
        // Disabled for good: nothing will change; answer only when the caller stops waiting.
        if (signal !== undefined && !signal.aborted && !disposed) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return placeholder;
      },
      check: () => step((live) => live.check()),
      download: () => step((live) => live.download()),
      skip: () => step((live) => live.skip()),
      setChecks: (checks) => step((live) => live.setChecks(checks)),
      install: async () => {
        const live = await service();
        return live === null ? false : live.install();
      },
    },
    dispose: () => {
      disposed = true;
      (client as UpdateClient | null)?.dispose();
    },
  };
}

/**
 * Starts the update client in the background and answers its service at once (see the top of this
 * file). Never throws: a failure, now or while the client is built, is one log line and a service that
 * stays `disabled`.
 */
export function startUpdateService(deps: StartUpdateDeps): { readonly service: UpdateService; dispose(): void } {
  const log = deps.log ?? ((line: string) => console.warn(`frost: ${line}`));
  let currentVersion = '0.0.0';
  const failed = (error: unknown): null => {
    log(`updates are off for this run: the update client could not start (${error instanceof Error ? error.message : String(error)})`);
    return null;
  };
  let pending: Promise<UpdateClient | null>;
  try {
    const { app } = deps;
    const isPackaged = app.isPackaged;
    // A packaged build never reads an e2e switch (and refuses to start with one anyway).
    const switchValue = (name: string): string => (isPackaged ? '' : app.commandLine.getSwitchValue(name));
    currentVersion = app.getVersion();
    const userData = app.getPath('userData');

    // Nothing shared with browsing: in memory, no cache, its own cookie jar (never used: no cookies are sent).
    const updateSession = deps.session.fromPartition(UPDATE_PARTITION, { cache: false }) as UpdateSession;
    hardenUpdateSession(updateSession, updateUserAgent(currentVersion), { isPackaged });
    const pin = switchValue(UPDATE_TEST_CERT_SWITCH).toLowerCase();
    if (UPDATE_TEST_CERT_PATTERN.test(pin)) updateSession.setCertificateVerifyProc(pinnedCertificateVerifier(pin));
    const e2eHosts = switchValue(E2E_PUBLIC_HOSTS_SWITCH);
    const resolve = e2eHosts === '' ? netResolve(updateSession) : withE2ePublicHosts(netResolve(updateSession), e2eHosts.split(','));

    // The prefs store does no I/O until read, and the client reads it only when there is a feed.
    pending = createUpdateClient({
      feed: resolveFeed({ env: deps.env ?? process.env, switchValue: switchValue(UPDATE_FEED_SWITCH), isPackaged }),
      keys: resolveTrustedKeys({ switchValue: switchValue(UPDATE_PUBLIC_KEY_SWITCH), isPackaged }),
      currentVersion,
      platformKey: updatePlatformKey(process.platform, process.arch),
      userData,
      prefs: createPrefsStore(userData, { log }),
      hop: netTransport(deps.net, updateSession as unknown as Electron.Session),
      resolve,
      isPackaged,
      log,
    }).catch(failed);
  } catch (error) {
    pending = Promise.resolve(failed(error));
  }
  return deferredUpdateService(pending, { shell: deps.shell, currentVersion });
}
