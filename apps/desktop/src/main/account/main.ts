import path from 'node:path';
import { app, BrowserWindow, net, safeStorage } from 'electron';
import { SECRETS_DIR_NAME } from '@app/specs/secret-store.spec';
import { openExternalIfAllowed, trackUserGesture } from '../security/gesture';
import { createAccountApi } from './api-client';
import { buildTimePublicEnv } from './build-config';
import { resolveAccountConfig } from './config';
import { createEntitlements, entitlementsReaderOf, type EntitlementsController, type EntitlementsReader } from './entitlements';
import { createWindowGestures, type WindowGestures } from './gestures';
import { startLoopback } from './loopback';
import { holdQuitFor } from './quit';
import { createSecretStore, type SecretStore } from './secret-store';
import { redact } from './redact';
import { createAccountService, type AccountMainService } from './service';
import { createSettingsRequestsMain } from './settings-requests';

// The account in the main process (Phase 4 Task 5; acceptance `account-signin.feature.md`): the one
// Electron-facing wiring of the pure modules beside it. Call once, after `app.whenReady()` (the secret
// store decides there whether the keychain is real) and before the first window opens (gestures are
// tracked from `browser-window-created`).

export interface AccountMain {
  /** The IPC `account.*` service (`services.account`). */
  readonly service: AccountMainService;
  /** The secret store (the account, entitlements and, from Task 8, Search Console blobs). */
  readonly secretStore: SecretStore;
  /**
   * Main's one entitlements gate (Phase 5 gates its agent on it): `none` unless an account is signed
   * in and the held snapshot is that account's; `onChange` fires on sign-in, sign-out, account and
   * entitlement changes. Unconfigured: always `none`. The store's controller stays private.
   */
  readonly entitlements: EntitlementsReader;
  /** Live user gestures per app window (Search Console's connect spends them too, Task 8). */
  readonly gestures: WindowGestures;
  /** The application menu's account commands (Task 9: Settings…, `account-settings.feature.md`). */
  readonly menu: { showSettings(windowId?: number): void };
}

const log = (message: string): void => console.warn(`frost: ${redact(message)}`);

/** A store that keeps nothing beyond this run (used only if the real one cannot be created). */
function memoryStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    persistent: false,
    read: async (name) => values.get(name) ?? null,
    write: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
    clear: async () => values.clear(),
    pending: () => false,
    whenIdle: async () => undefined,
  };
}

function focusWindow(windowId: number): void {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

export async function createAccountMain(): Promise<AccountMain> {
  let secretStore: SecretStore;
  try {
    secretStore = await createSecretStore({ dir: path.join(app.getPath('userData'), SECRETS_DIR_NAME), safeStorage, isReady: () => app.isReady(), log });
  } catch {
    log('account: the secret store could not be created; memory only');
    secretStore = memoryStore();
  }
  // Build-time values; only an unpackaged build with none baked in reads them from its environment.
  let config = resolveAccountConfig({ isPackaged: app.isPackaged, buildTime: buildTimePublicEnv(), runtime: process.env });
  let entitlementsStore: EntitlementsController | null = null;
  if (config !== null) {
    try {
      entitlementsStore = await createEntitlements({ jwks: config.jwks, store: secretStore, log });
    } catch {
      // Never stops the app from starting: without entitlements the account is off for this run.
      log('account: entitlements could not be loaded; account disabled for this run');
      config = null;
    }
  }
  const gestures = createWindowGestures({
    app,
    existing: () => BrowserWindow.getAllWindows(),
    track: (contents: Electron.WebContents) => trackUserGesture(contents, () => performance.now()),
  });
  const service = await createAccountService({
    config,
    api: config === null ? null : createAccountApi({ apiBase: config.apiBase, fetch: (url, init) => net.fetch(url, init) }),
    store: secretStore,
    entitlements: entitlementsStore,
    startLoopback,
    openInBrowser: openExternalIfAllowed,
    consumeGesture: (windowId) => gestures.consume(windowId),
    focusWindow,
    log,
  });
  // On quit: a token exchanged but not confirmed, a sign-out still revoking, or a signed-in token kept
  // for this run only (memory-only keychain) is revoked first, and secrets still on their way to disk
  // are written, holding the quit at most QUIT_REVOKE_TIMEOUT_MS
  // (only when there is either).
  holdQuitFor(app, () => {
    gestures.dispose();
    entitlementsStore?.dispose();
    const revoking = service.dispose();
    if (revoking === null && !secretStore.pending()) return null;
    return Promise.allSettled([revoking, secretStore.whenIdle()]);
  });
  // The menu's Settings… requests (Task 9), served as `account.settingsWatch`.
  const settings = createSettingsRequestsMain();
  app.once('will-quit', () => settings.dispose());
  const entitlements = entitlementsReaderOf(service);
  return { service: Object.assign(service, { settings }), secretStore, entitlements, gestures, menu: { showSettings: (windowId) => settings.show(windowId) } };
}
