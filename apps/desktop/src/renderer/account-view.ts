// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AccountError, AccountState, SignInResult } from '@app/specs/account-state.schema';
import type { Entitlements, FeatureFlag, Plan } from '@app/specs/entitlements-snapshot.spec';
import { ACCOUNT_SETTINGS_TEXT, FEATURE_LABELS } from '@app/specs/account-settings.spec';

// The Settings view's Account section as a view model (Phase 4 Task 9; acceptance
// `account-settings.feature.md`, View models). Pure: every `AccountState` main answers becomes the
// words and buttons the section shows. Nothing here guesses: the section shows what main said.

/** The account section's buttons (each calls one `account.*` procedure from its click). */
export type AccountButton = 'sign-in' | 'cancel' | 'confirm' | 'refresh' | 'sign-out';

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

export interface PlanView {
  readonly label: string;
  readonly pro: boolean;
  /** One line on whether the plan's features count now (active, offline grace, or why Free). */
  readonly status: string;
  readonly tone: Tone;
  /** Every feature this build knows, in plain words, and whether the plan includes it now. */
  readonly features: readonly { readonly flag: FeatureFlag; readonly label: string; readonly included: boolean }[];
}

export type AccountView =
  | { readonly kind: 'unconfigured'; readonly message: string; readonly buttons: readonly AccountButton[] }
  | { readonly kind: 'signed-out'; readonly message: string; readonly buttons: readonly AccountButton[] }
  | { readonly kind: 'awaiting-browser'; readonly message: string; readonly fingerprint: string; readonly hint: string; readonly buttons: readonly AccountButton[] }
  | { readonly kind: 'confirming'; readonly question: string; readonly fingerprint: string; readonly hint: string; readonly buttons: readonly AccountButton[] }
  | {
      readonly kind: 'signed-in';
      readonly email: string;
      readonly name: string | null;
      readonly plan: PlanView;
      readonly buttons: readonly AccountButton[];
    };

export interface AccountSection {
  readonly view: AccountView;
  /** Why the last sign-in or session ended (shown once, until the next sign-in), or `null`. */
  readonly error: string | null;
  /** The no-keychain notice, or `null`. */
  readonly keychain: string | null;
  /** The request ID `confirmSignIn` / `cancelSignIn` answer, or `null`. */
  readonly requestId: string | null;
}

/** What each `ACCOUNT_ERRORS` value says. */
export const ACCOUNT_ERROR_MESSAGES: Readonly<Record<AccountError, string>> = Object.freeze({
  'browser-failed': "frost couldn't open your browser to sign in. Try again.",
  'timed-out': 'The sign-in took too long and was stopped. Try again.',
  'exchange-failed': "The sign-in couldn't be completed. Try again.",
  network: "frost couldn't reach the account service. Check your connection and try again.",
  cancelled: 'The sign-in was cancelled in the browser.',
  'session-ended': 'Your session ended, so you were signed out. Sign in again to keep using Pro.',
});

/** What each `account.signIn` answer but `started` says (shown under the button). */
export const SIGN_IN_RESULT_MESSAGES: Readonly<Record<Exclude<SignInResult, 'started'>, string>> = Object.freeze({
  'needs-gesture': 'Click Sign in again to open your browser.',
  unconfigured: ACCOUNT_SETTINGS_TEXT.unconfigured,
  'already-signed-in': 'You are already signed in. Sign out first to use another account.',
  'browser-failed': ACCOUNT_ERROR_MESSAGES['browser-failed'],
});

/** The message for a `signIn` answer (`null` for `started`). */
export function signInResultMessage(result: SignInResult): string | null {
  return result === 'started' ? null : SIGN_IN_RESULT_MESSAGES[result];
}

const PLAN_LABELS: Readonly<Record<Plan, string>> = Object.freeze({ free: 'Free', pro: 'Pro' });

/** A day as the section shows it (the user's locale). */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The plan as the signed-in section shows it. */
export function planView(entitlements: Entitlements, formatDate: (ms: number) => string = formatDay): PlanView {
  const features = (Object.keys(FEATURE_LABELS) as FeatureFlag[]).map((flag) => ({ flag, label: FEATURE_LABELS[flag], included: entitlements.features.includes(flag) }));
  const label = PLAN_LABELS[entitlements.plan];
  const base = { label, pro: entitlements.plan === 'pro', features };
  switch (entitlements.status) {
    case 'active':
      return { ...base, status: `${label} is active.`, tone: 'ok' };
    case 'grace':
      return { ...base, status: `Offline — ${label} stays available until ${formatDate(entitlements.graceEndsAtMs ?? 0)}`, tone: 'warn' };
    case 'expired':
      return { ...base, status: "Free — frost couldn't confirm your plan for too long. Refresh when you're online.", tone: 'error' };
    case 'invalid':
      return { ...base, status: "Free — your plan couldn't be verified. Refresh to try again.", tone: 'error' };
    case 'none':
      return { ...base, status: 'Checking your plan…', tone: 'neutral' };
  }
}

/** The Account section for `state` (`null`: main has not answered yet). */
export function accountSection(state: AccountState, formatDate: (ms: number) => string = formatDay): AccountSection {
  const error = state.error === null ? null : ACCOUNT_ERROR_MESSAGES[state.error];
  const keychain = state.keychain === 'memory-only' && state.status !== 'unconfigured' && state.status !== 'signed-out' ? ACCOUNT_SETTINGS_TEXT.keychain : null;
  const requestId = state.requestId;
  switch (state.status) {
    case 'unconfigured':
      return { view: { kind: 'unconfigured', message: ACCOUNT_SETTINGS_TEXT.unconfigured, buttons: [] }, error: null, keychain: null, requestId: null };
    case 'signed-out':
      return { view: { kind: 'signed-out', message: ACCOUNT_SETTINGS_TEXT.signedOut, buttons: ['sign-in'] }, error, keychain, requestId: null };
    case 'awaiting-browser':
      return {
        view: { kind: 'awaiting-browser', message: ACCOUNT_SETTINGS_TEXT.awaitingBrowser, fingerprint: state.fingerprint ?? '', hint: ACCOUNT_SETTINGS_TEXT.fingerprintHint, buttons: ['cancel'] },
        error,
        keychain,
        requestId,
      };
    case 'confirming':
      return {
        view: {
          kind: 'confirming',
          question: ACCOUNT_SETTINGS_TEXT.confirmQuestion(state.user?.email ?? ''),
          fingerprint: state.fingerprint ?? '',
          hint: ACCOUNT_SETTINGS_TEXT.confirmHint,
          buttons: ['confirm', 'cancel'],
        },
        error,
        keychain,
        requestId,
      };
    case 'signed-in':
      return {
        view: { kind: 'signed-in', email: state.user?.email ?? '', name: state.user?.name ?? null, plan: planView(state.entitlements, formatDate), buttons: ['refresh', 'sign-out'] },
        error,
        keychain,
        requestId: null,
      };
  }
}
