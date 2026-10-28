import { useCallback, useEffect, useState } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AccountState } from '@app/specs/account-state.schema';
import type { GscStatus } from '@app/specs/gsc.spec';
import type { TelemetryState } from '@app/specs/telemetry-consent.schema';
import { ipc } from './ipc';

// The Settings view's live state from main (Phase 4 Task 9; acceptance `account-settings.feature.md`):
// `account.watch`, `gsc.watch` and `settingsView.watch` are long-polls (as `browser.watch`);
// telemetry has no watch, so its state is read once and then replaced by each `setConsent` answer.

const RETRY_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Long-polls `poll(since)`; each answer replaces the state and its `counter` is the next `since`. */
function useLongPoll<T>(poll: (since: number) => Promise<T>, counter: (value: T) => number): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    let since = -1;
    void (async () => {
      while (live) {
        try {
          const next = await poll(since);
          if (!live) return;
          since = counter(next);
          setValue(next);
        } catch {
          if (live) await sleep(RETRY_MS);
        }
      }
    })();
    return () => {
      live = false;
    };
    // The poll functions are module-level constants.
  }, [poll, counter]);
  return value;
}

const pollAccount = (since: number) => ipc.account.watch.query({ sinceVersion: since });
const pollGsc = (since: number) => ipc.gsc.watch.query({ sinceVersion: since });
const pollSettingsView = (since: number) => ipc.settingsView.watch.query({ sinceSeq: since });
const byVersion = (value: { version: number }) => value.version;
const bySeq = (value: { seq: number }) => value.seq;

/** The account as main shows it (`null` until main answers). */
export const useAccountState = (): AccountState | null => useLongPoll(pollAccount, byVersion);
/** The Search Console connection as main shows it (`null` until main answers). */
export const useGscStatus = (): GscStatus | null => useLongPoll(pollGsc, byVersion);
/** Main's count of the menu's Settings requests (`undefined` until main answers). */
export const useSettingsMenuSeq = (): number | undefined => useLongPoll(pollSettingsView, bySeq)?.seq;

/**
 * Telemetry's state as main answers it, and `setConsent`: the toggles show main's answer, never a
 * guess. A failed call reads the state again.
 */
export function useTelemetryState(): readonly [TelemetryState | null, (channel: 'usage' | 'errors', on: boolean) => Promise<void>] {
  const [state, setState] = useState<TelemetryState | null>(null);
  const read = useCallback(() => ipc.telemetry.state.query().then(setState, () => undefined), []);
  useEffect(() => {
    void read();
  }, [read]);
  const setConsent = useCallback(
    async (channel: 'usage' | 'errors', on: boolean) => {
      const next = await ipc.telemetry.setConsent.mutate({ channel, on }).catch(() => null);
      if (next) setState(next);
      else await read();
    },
    [read],
  );
  return [state, setConsent];
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
