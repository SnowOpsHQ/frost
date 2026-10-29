import type { AccountState, SignInResult } from '@app/specs/account-state.schema';
import type { Entitlements } from '@app/specs/entitlements-snapshot.spec';
import type { SettingsViewState } from '@app/specs/account-settings.schema';

// The account as the `account.*` procedures and `requireFeature` see it (Phase 4; specs
// `entitlements-snapshot.spec.ts`, `account-state.schema.ts`; acceptance `entitlements-client.feature.md`
// and `account-signin.feature.md`, Router). Main implements it (`apps/desktop/src/main/account/service.ts`);
// this package only knows the interface. Tokens stay in main: no member answers a token, code,
// verifier, `state` or snapshot string.

export interface AccountService {
  /**
   * The verified entitlements now (`EntitlementsSchema`), never the snapshot they came from. `none`
   * unless signed in (a pending sign-in is not confirmed yet).
   */
  entitlements(): Entitlements;
  /** The account now (`AccountStateSchema`). */
  state(): AccountState;
  /**
   * Resolves with the state once its `version` exceeds `sinceVersion` (at once if it already does), or
   * when `signal` aborts. At most `MAX_PENDING_ACCOUNT_WATCHES` wait; one more answers the oldest early.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<AccountState>;
  /**
   * Starts a sign-in for app window `windowId` (the IPC sender's): needs a live user gesture there
   * (else `needs-gesture`, nothing opened); opens the authorize page in the system browser.
   */
  signIn(windowId: number): Promise<SignInResult>;
  /**
   * Keeps the exchanged sign-in `requestId`: `true` only if it is the pending, `confirming` one,
   * asked from app window `windowId` (the IPC sender's) that started it, with a live user gesture
   * there (spent). Otherwise `false`, nothing stored.
   */
  confirmSignIn(windowId: number, requestId: string): Promise<boolean>;
  /** Drops the pending sign-in `requestId` (revoking a token already exchanged): `true` if it was pending. */
  cancelSignIn(requestId: string): Promise<boolean>;
  /** Revokes the token (best effort), forgets the account and its entitlements: `true` if signed in. */
  signOut(): Promise<boolean>;
  /**
   * Refreshes the session and entitlements now: `true` if signed in (a refresh ran). The router's
   * `account.refresh` calls it at most once per `ACCOUNT_REFRESH_MIN_INTERVAL_MS` (else answers `false`).
   */
  refresh(): Promise<boolean>;
  /**
   * The menu's requests to open the account's Settings view (Phase 4 Task 9, `account-settings.feature.md`):
   * `account.settingsWatch`. Optional so other fakes need not grow; without it the procedure fails closed.
   */
  readonly settings?: SettingsRequests;
}

/** Main's per-window counters of the menu's Settings… requests (`account.settingsWatch`). */
export interface SettingsRequests {
  /** App window `windowId`'s count of requests so far. */
  state(windowId: number): SettingsViewState;
  /**
   * Resolves with window `windowId`'s state once its `seq` exceeds `sinceSeq` (at once if it already
   * does), or when `signal` aborts. At most `MAX_PENDING_SETTINGS_WATCHES` wait; one more answers the
   * oldest early.
   */
  watch(windowId: number, sinceSeq: number, signal?: AbortSignal): Promise<SettingsViewState>;
}
