import { app, net } from 'electron';
import { GSC_QUIT_REVOKE_TIMEOUT_MS } from '@app/specs/gsc.spec';
import { startLoopback } from '../account/loopback';
import type { AccountMain } from '../account/main';
import { holdQuitFor } from '../account/quit';
import { memorySecretStore } from '../account/secret-store';
import { openExternalIfAllowed } from '../security/gesture';
import { buildTimePublicEnv } from '../account/build-config';
import { resolveGscConfig } from './config';
import { createGscService, GSC_UNGATED_ACCESS, type GscMainService } from './service';

// Search Console in the main process (Phase 4 Task 8; acceptance `gsc.feature.md`): the one
// Electron-facing wiring of the pure modules beside it. Call once, after `createAccountMain()` (it
// reuses the account's secret store and gesture tracker). Search Console is free and needs no frost
// account (2026-10-29): it is not gated, and the Google connection is this profile's, so it must not
// be wired to the account's entitlements or user ID.

export interface GscMain {
  /** The IPC `gsc.*` service (`services.gsc`), and the `GscService` read API Phase 5 calls in main. */
  readonly service: GscMainService;
}

const log = (message: string): void => console.warn(`frost: ${message}`);

/**
 * Search Console in main. Never rejects: any exception while it is set up answers an unconfigured
 * service, logged with a fixed message, so the first window always opens (`gsc.feature.md`, "Startup
 * never stops the window").
 */
export async function createGscMain(account: AccountMain): Promise<GscMain> {
  try {
    return await startGscMain(account);
  } catch {
    log('gsc: could not start; unconfigured for this run');
    return { service: await unconfiguredGscService() };
  }
}

/** A service that is off for this run: nothing is read, stored or sent. */
function unconfiguredGscService(): Promise<GscMainService> {
  return createGscService({
    config: null,
    fetch: () => Promise.reject(new Error('gsc: unconfigured')),
    store: memorySecretStore(),
    ...GSC_UNGATED_ACCESS,
    startLoopback,
    openInBrowser: () => false,
    consumeGesture: () => false,
    log,
  });
}

async function startGscMain(account: AccountMain): Promise<GscMain> {
  // Build-time values; only an unpackaged build with none baked in reads them (and the fakes' endpoints) from its environment.
  const config = resolveGscConfig({ isPackaged: app.isPackaged, buildTime: buildTimePublicEnv(), runtime: process.env });
  const service = await createGscService({
    config,
    fetch: (url, init) => net.fetch(url, init),
    store: account.secretStore,
    // Not gated, and owned by this profile: signing in or out of frost (for sync) never touches it.
    ...GSC_UNGATED_ACCESS,
    startLoopback,
    openInBrowser: openExternalIfAllowed,
    consumeGesture: (windowId) => account.gestures.consume(windowId),
    log,
  });
  // On quit: a revocation or exchange still running, or the revocation of a connection kept for this run
  // only (memory-only keychain), holds the quit, capped, only when there is one.
  holdQuitFor(app, () => service.dispose(), GSC_QUIT_REVOKE_TIMEOUT_MS);
  return { service };
}
