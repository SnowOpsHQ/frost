import { app, net } from 'electron';
import { entitlementGrants } from '@app/specs/entitlements-snapshot.spec';
import { GSC_QUIT_REVOKE_TIMEOUT_MS } from '@app/specs/gsc.spec';
import { startLoopback } from '../account/loopback';
import type { AccountMain } from '../account/main';
import { holdQuitFor } from '../account/quit';
import { openExternalIfAllowed } from '../security/gesture';
import { buildTimePublicEnv } from '../account/build-config';
import { resolveGscConfig } from './config';
import { createGscService, type GscMainService } from './service';

// Search Console in the main process (Phase 4 Task 8; acceptance `gsc.feature.md`): the one
// Electron-facing wiring of the pure modules beside it. Call once, after `createAccountMain()` (it
// reuses the account's secret store, gesture tracker and entitlements).

export interface GscMain {
  /** The IPC `gsc.*` service (`services.gsc`), and the `GscService` read API Phase 5 calls in main. */
  readonly service: GscMainService;
}

const log = (message: string): void => console.warn(`frost: ${message}`);

export function createGscMain(account: AccountMain): GscMain {
  // Build-time values; only an unpackaged build with none baked in reads them (and the fakes' endpoints) from its environment.
  const config = resolveGscConfig({ isPackaged: app.isPackaged, buildTime: buildTimePublicEnv(), runtime: process.env });
  const service = createGscService({
    config,
    fetch: (url, init) => net.fetch(url, init),
    store: account.secretStore,
    // The account service's entitlements are `none` unless signed in (fails closed).
    entitled: () => entitlementGrants(account.service.entitlements(), 'search-console'),
    onEntitlementsChange: (listener) => account.entitlements?.onChange(() => listener()) ?? (() => undefined),
    // The connection belongs to the frost account that made it; a different account's sign-in drops it.
    userId: () => account.service.userId(),
    onAccountChange: (listener) => account.service.onChange(listener),
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
