import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AccountState } from '@app/specs/account-state.schema';
import type { GscStatus } from '@app/specs/gsc.spec';
import type { TelemetryState } from '@app/specs/telemetry-consent.schema';
import { settingsRetryDelay } from '@app/specs/account-settings.spec';
import { ipc } from './ipc';
import { createWatchStore, type WatchStore } from './settings-store';

// The Settings view's live state from main (Phase 4 Task 9; acceptance `account-settings.feature.md`):
// `account.watch`, `gsc.watch` and `account.settingsWatch` are long-polls, one shared store each for the
// whole chrome (the Search Console panel reads the same two); telemetry has no watch, so its state is
// read (retried with backoff until main answers) and then replaced by each `setConsent` answer.

const byVersion = (value: { version: number }) => value.version;

/** The account as main shows it: one `account.watch` for the chrome. */
export const accountStore: WatchStore<AccountState> = createWatchStore((since) => ipc.account.watch.query({ sinceVersion: since }), byVersion);
/** The Search Console connection as main shows it: one `gsc.watch` for the chrome. */
export const gscStore: WatchStore<GscStatus> = createWatchStore((since) => ipc.gsc.watch.query({ sinceVersion: since }), byVersion);
/** This window's count of the menu's Settings requests. */
const settingsRequestStore = createWatchStore((since) => ipc.account.settingsWatch.query({ sinceSeq: since }), (value) => value.seq);

function useStore<T>(store: WatchStore<T>): T | null {
  return useSyncExternalStore(store.subscribe, store.current);
}

/** The account as main shows it (`null` until main answers). */
export const useAccountState = (): AccountState | null => useStore(accountStore);
/** The Search Console connection as main shows it (`null` until main answers). */
export const useGscStatus = (): GscStatus | null => useStore(gscStore);
/** Main's count of the menu's Settings requests for this window (`undefined` until main answers). */
export const useSettingsMenuSeq = (): number | undefined => useStore(settingsRequestStore)?.seq;

export interface TelemetryRead {
  /** Main's answer (`null` until it answered). */
  readonly state: TelemetryState | null;
  /** The last read failed (it is being tried again). */
  readonly failed: boolean;
}

/**
 * Telemetry's state as main answers it, and `setConsent`: the switches show main's answer, never a
 * guess. Until main answered the read is retried with `settingsRetryDelay`; a failed `setConsent`
 * reads the state again.
 */
export function useTelemetryState(): readonly [TelemetryRead, (channel: 'usage' | 'errors', on: boolean) => Promise<void>] {
  const [read, setRead] = useState<TelemetryRead>({ state: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (failures: number) => {
      ipc.telemetry.state.query().then(
        (state) => {
          if (live) setRead({ state, failed: false });
        },
        () => {
          if (!live) return;
          setRead((current) => ({ ...current, failed: true }));
          timer = setTimeout(() => run(failures + 1), settingsRetryDelay(failures + 1));
        },
      );
    };
    run(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [attempt]);
  const setConsent = useCallback(async (channel: 'usage' | 'errors', on: boolean) => {
    const next = await ipc.telemetry.setConsent.mutate({ channel, on }).catch(() => null);
    if (next) setRead({ state: next, failed: false });
    else setAttempt((n) => n + 1);
  }, []);
  return [read, setConsent];
}

/** The `account.*` and `gsc.*` calls the sections' buttons make, each from its own click. */
export const settingsActions = {
  signIn: () => ipc.account.signIn.mutate().catch(() => 'browser-failed' as const),
  confirmSignIn: (requestId: string) => ipc.account.confirmSignIn.mutate({ requestId }).catch(() => false),
  cancelSignIn: (requestId: string) => ipc.account.cancelSignIn.mutate({ requestId }).catch(() => false),
  signOut: () => ipc.account.signOut.mutate().catch(() => false),
  refresh: () => ipc.account.refresh.mutate().catch(() => false),
  connectGsc: () => ipc.gsc.connect.mutate().catch(() => 'browser-failed' as const),
  cancelGsc: () => ipc.gsc.cancelConnect.mutate().catch(() => false),
  disconnectGsc: () => ipc.gsc.disconnect.mutate().catch(() => false),
};
