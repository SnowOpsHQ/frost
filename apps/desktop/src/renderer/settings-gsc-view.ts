import type { GscConnectResult, GscError, GscStatus } from '@app/specs/gsc.spec';
import { GSC_SETTINGS_TEXT } from '@app/specs/account-settings.spec';

// The Settings view's Search Console section as a view model (Phase 4 Task 9; acceptance
// `account-settings.feature.md`, Search Console). Pure: every `GscStatus` main answers becomes the
// words and buttons the section shows. Search Console is free and needs no frost account (2026-10-29),
// so `entitled` (always true from main) changes nothing here.

export type GscButton = 'connect' | 'cancel' | 'disconnect';

export interface GscSection {
  readonly kind: 'unconfigured' | 'not-connected' | 'connecting' | 'connected';
  /** The state in a few words ("Connected" …), or `null`. */
  readonly headline: string | null;
  readonly message: string;
  readonly buttons: readonly GscButton[];
  /** Why the last connect failed or the connection ended, or `null`. */
  readonly error: string | null;
  readonly keychain: string | null;
}

/** What each `GSC_ERRORS` value says. */
export const GSC_ERROR_MESSAGES: Readonly<Record<GscError, string>> = Object.freeze({
  'browser-failed': "frost couldn't open your browser to connect. Try again.",
  'timed-out': 'Connecting took too long and was stopped. Try again.',
  cancelled: 'Connecting was cancelled in the browser.',
  'exchange-failed': "Google didn't complete the connection. Try again.",
  network: "frost couldn't reach Google. Check your connection and try again.",
  'scope-refused': 'Google granted more access than frost asks for, so frost refused it and kept nothing. Try again.',
  'auth-expired': 'Google no longer accepts this connection, so it was disconnected. Connect again.',
});

/** What each `gsc.connect` answer but `started` says (shown under the button). */
export const GSC_CONNECT_RESULT_MESSAGES: Readonly<Record<Exclude<GscConnectResult, 'started'>, string>> = Object.freeze({
  'needs-gesture': 'Click Connect again to open your browser.',
  unconfigured: GSC_SETTINGS_TEXT.unconfigured,
  // Kept for wire compatibility; main never answers it (Search Console is not gated).
  'not-entitled': GSC_SETTINGS_TEXT.unconfigured,
  'already-connected': 'Search Console is already connected. Disconnect first to use another Google account.',
  'browser-failed': GSC_ERROR_MESSAGES['browser-failed'],
});

/** The message for a `gsc.connect` answer (`null` for `started`). */
export function gscConnectResultMessage(result: GscConnectResult): string | null {
  return result === 'started' ? null : GSC_CONNECT_RESULT_MESSAGES[result];
}

/** The Search Console section for `status`. */
export function gscSection(status: GscStatus): GscSection {
  const error = status.error === null ? null : GSC_ERROR_MESSAGES[status.error];
  // Only while there is a connection (or a connect) that the quit would end.
  const keychain = status.configured && status.keychain === 'memory-only' && (status.connected || status.connecting) ? GSC_SETTINGS_TEXT.keychain : null;
  if (!status.configured) return { kind: 'unconfigured', headline: null, message: GSC_SETTINGS_TEXT.unconfigured, buttons: [], error: null, keychain: null };
  if (status.connecting) return { kind: 'connecting', headline: 'Waiting for your browser', message: GSC_SETTINGS_TEXT.connecting, buttons: ['cancel'], error, keychain };
  if (status.connected) return { kind: 'connected', headline: GSC_SETTINGS_TEXT.connected, message: GSC_SETTINGS_TEXT.readOnly, buttons: ['disconnect'], error, keychain };
  return { kind: 'not-connected', headline: null, message: `Connect a Google account to see clicks, impressions and positions for the pages you visit. ${GSC_SETTINGS_TEXT.readOnly}`, buttons: ['connect'], error, keychain };
}
