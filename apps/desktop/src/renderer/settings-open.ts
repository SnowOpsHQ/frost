import type { AccountStatus } from '@app/specs/account-state.schema';
import type { SettingsSectionId } from '@app/specs/account-settings.spec';

// When the Settings sheet shows (Phase 4 Task 9; acceptance `account-settings.feature.md`, Opening and
// closing). Pure: the sheet's open state and the events that change it, and the chrome-side request
// bus the palette's actions use (main's menu requests arrive over `account.settingsWatch`).

export interface SettingsOpenState {
  readonly open: boolean;
  readonly section: SettingsSectionId;
  /** Rises with every request, so the sheet moves focus to the section again. */
  readonly focusSeq: number;
}

export type SettingsEvent =
  /** The palette, the menu, or a sign-in waiting for its confirmation asks for `section`. */
  | { readonly type: 'request'; readonly section: SettingsSectionId }
  /** Close or Esc. */
  | { readonly type: 'close' }
  /** The History sheet opened (only one of the two shows); `holding` while a sign-in waits for its confirmation (History closes instead). */
  | { readonly type: 'history-opened'; readonly holding: boolean }
  /** Another tab shows, or a new document committed in this one; `holding` while a sign-in waits for its confirmation. */
  | { readonly type: 'page-changed'; readonly holding: boolean };

export const SETTINGS_CLOSED: SettingsOpenState = Object.freeze({ open: false, section: 'account', focusSeq: 0 });

export function settingsReducer(state: SettingsOpenState, event: SettingsEvent): SettingsOpenState {
  switch (event.type) {
    case 'request':
      return { open: true, section: event.section, focusSeq: state.focusSeq + 1 };
    case 'close':
      return state.open ? { ...state, open: false } : state;
    case 'history-opened':
    case 'page-changed':
      return state.open && !event.holding ? { ...state, open: false } : state;
  }
}

/** Whether the account's move from `previous` to `next` opens Settings on Account (a sign-in now asks to be confirmed). */
export function opensForConfirmation(previous: AccountStatus | null, next: AccountStatus | null): boolean {
  return next === 'confirming' && previous !== 'confirming';
}

/**
 * Whether a sign-in holds the sheet open (its confirmation is shown there): page changes and History
 * do not close it, and Close / Esc cancel the sign-in before closing (`closeCancelsSignIn`).
 */
export function holdsSheet(status: AccountStatus | null): boolean {
  return status === 'confirming';
}

/** Whether closing the sheet now must cancel the pending sign-in first (a waiting confirmation is never hidden). */
export function closeCancelsSignIn(status: AccountStatus | null): boolean {
  return holdsSheet(status);
}

/**
 * Whether main's counter `seq` is a new request: a change after the first value seen (the value at
 * load time is history, not a request). `seen` is the last value seen (`undefined`: none yet).
 */
export function isMenuRequest(seen: number | undefined, seq: number): boolean {
  return seen !== undefined && seq !== seen;
}

// ---- The chrome's request bus (the palette's actions) -------------------------------------------

type Listener = (section: SettingsSectionId) => void;
const listeners = new Set<Listener>();

/** Asks the mounted Settings slot to open on `section`; answers whether one listened. */
export function requestSettings(section: SettingsSectionId): boolean {
  for (const listener of listeners) listener(section);
  return listeners.size > 0;
}

/** Subscribes to requests; answers the unsubscribe. */
export function onSettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
