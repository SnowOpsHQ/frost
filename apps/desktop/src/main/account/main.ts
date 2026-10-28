import path from 'node:path';
import { app, BrowserWindow, net, safeStorage } from 'electron';
import { SECRETS_DIR_NAME } from '@app/specs/secret-store.spec';
import { openExternalIfAllowed, trackUserGesture } from '../security/gesture';
import { createAccountApi } from './api-client';
import { buildTimeAccountEnv, resolveAccountConfig } from './config';
import { createEntitlements, type EntitlementsReader } from './entitlements';
import { createWindowGestures } from './gestures';
import { startLoopback } from './loopback';
import { createSecretStore, type SecretStore } from './secret-store';
import { createAccountService, redact, type AccountMainService } from './service';

// The account in the main process (Phase 4 Task 5; acceptance `account-signin.feature.md`): the one
// Electron-facing wiring of the pure modules beside it. Call once, after `app.whenReady()` (the secret
// store decides there whether the keychain is real) and before the first window opens (gestures are
// tracked from `browser-window-created`).

export interface AccountMain {
  /** The IPC `account.*` service (`services.account`). */
  readonly service: AccountMainService;
  /** The secret store (the account, entitlements and, from Task 8, Search Console blobs). */
  readonly secretStore: SecretStore;
  /** Main's entitlements (`null` when unconfigured: nothing is entitled). Gate in main on `service.entitlements()`. */
  readonly entitlements: EntitlementsReader | null;
}

const log = (message: string): void => console.warn(`frost: ${redact(message)}`);

/** A store that keeps nothing beyond this run (used only if the real one cannot be created). */
function memoryStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    persistent: false,
    read: (name) => values.get(name) ?? null,
    write: (name, value) => void values.set(name, value),
    delete: (name) => void values.delete(name),
    clear: () => values.clear(),
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
    secretStore = createSecretStore({ dir: path.join(app.getPath('userData'), SECRETS_DIR_NAME), safeStorage, isReady: () => app.isReady(), log });
  } catch {
    log('account: the secret store could not be created; memory only');
    secretStore = memoryStore();
  }
  // Build-time values; an unpackaged build (dev, e2e) may also take them from its environment.
  let config = resolveAccountConfig({ isPackaged: app.isPackaged, buildTime: buildTimeAccountEnv(), runtime: process.env });
  let entitlements: Awaited<ReturnType<typeof createEntitlements>> | null = null;
  if (config !== null) {
    try {
      entitlements = await createEntitlements({ jwks: config.jwks, store: secretStore, log });
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
  const service = createAccountService({
    config,
    api: config === null ? null : createAccountApi({ apiBase: config.apiBase, fetch: (url, init) => net.fetch(url, init) }),
    store: secretStore,
    entitlements,
    startLoopback,
    openInBrowser: openExternalIfAllowed,
    consumeGesture: (windowId) => gestures.consume(windowId),
    focusWindow,
    log,
  });
  app.once('will-quit', () => {
    service.dispose();
    gestures.dispose();
    entitlements?.dispose();
  });
  return { service, secretStore, entitlements };
}
