// Spec: specs/account-settings.spec.ts (ACCOUNT_SETTINGS_TEXT, FEATURE_LABELS), specs/account-state.schema.ts
// (AccountStateSchema, ACCOUNT_ERRORS, SIGN_IN_RESULTS), specs/entitlements-snapshot.spec.ts (EntitlementsSchema,
// ACCOUNT_FEATURES: frost is free and open source, 2026-10-29)
// Acceptance: specs/account-settings.feature.md (View models)
import { describe, expect, test } from 'vitest';
import { ACCOUNT_SETTINGS_TEXT, FEATURE_LABELS } from '@app/specs/account-settings.spec';
import { ACCOUNT_ERRORS, AccountStateSchema, SIGN_IN_RESULTS, type AccountState } from '@app/specs/account-state.schema';
import { ACCOUNT_FEATURES, NO_ENTITLEMENTS, OFFLINE_GRACE_MS, PLAN_FEATURES, type Entitlements } from '@app/specs/entitlements-snapshot.spec';
import { ACCOUNT_ERROR_MESSAGES, accountSection, initialOf, planView, signInResultMessage } from '../account-view';

const EXP = Date.UTC(2026, 9, 30);
const day = (ms: number) => `day ${new Date(ms).toISOString().slice(0, 10)}`;
const PRO: Entitlements = { plan: 'pro', features: [...PLAN_FEATURES.pro], status: 'active', expiresAtMs: EXP, graceEndsAtMs: EXP + OFFLINE_GRACE_MS };
const USER = { email: 'alice@example.com', name: 'Alice' };

/** A state main could answer (checked against the schema). */
function state(changes: Partial<AccountState>): AccountState {
  return AccountStateSchema.parse({ status: 'signed-out', user: null, entitlements: NO_ENTITLEMENTS, keychain: 'persistent', requestId: null, fingerprint: null, error: null, version: 1, ...changes });
}
const pending = { requestId: 'AAAAAAAAAAAAAAAAAAAAAA', fingerprint: 'ABCD-EF12' };

describe('account view model', () => {
  test('account-view-unconfigured', () => {
    const section = accountSection(state({ status: 'unconfigured', keychain: 'memory-only' }));
    expect(section.view).toEqual({ kind: 'unconfigured', message: "Accounts aren't configured in this build", buttons: [] });
    expect(section.keychain).toBeNull();
  });

  test('account-view-signed-out', () => {
    const section = accountSection(state({}));
    expect(section.view).toMatchObject({ kind: 'signed-out', buttons: ['sign-in'] });
    expect(section.error).toBeNull();
    const messages = new Set<string>();
    for (const error of ACCOUNT_ERRORS) {
      const shown = accountSection(state({ error })).error;
      expect(shown, error).toBe(ACCOUNT_ERROR_MESSAGES[error]);
      expect(shown!.length, error).toBeGreaterThan(10);
      messages.add(shown!);
    }
    expect(messages.size).toBe(ACCOUNT_ERRORS.length);
  });

  test('account-view-signed-out-says-free', () => {
    const section = accountSection(state({}));
    if (section.view.kind !== 'signed-out') throw new Error('not signed out');
    expect(section.view.message).toMatch(/free and open source/);
    expect(section.view.message).toMatch(/AI agent/);
    expect(section.view.message).toMatch(/Search Console/);
    expect(section.view.message).toMatch(/without an account/);
    expect(section.view.message).toMatch(/only to sync/);
    // No copy of the section offers a plan to buy.
    const words = [
      ...Object.values(ACCOUNT_SETTINGS_TEXT).flatMap((value) => (typeof value === 'string' ? [value] : typeof value === 'function' ? [value('x')] : Object.values(value).map((v) => (typeof v === 'function' ? v('x') : v)))),
      ...Object.values(ACCOUNT_ERROR_MESSAGES),
      ...SIGN_IN_RESULTS.map(signInResultMessage).filter((m): m is string => m !== null),
    ];
    for (const text of words) expect(text, text).not.toMatch(/\bPro\b|upgrade|paid/i);
  });

  test('account-view-awaiting-browser', () => {
    const section = accountSection(state({ status: 'awaiting-browser', ...pending }));
    expect(section.view).toEqual({ kind: 'awaiting-browser', message: ACCOUNT_SETTINGS_TEXT.awaitingBrowser, fingerprint: 'ABCD-EF12', hint: 'Your browser should show the same code', buttons: ['cancel'] });
    expect(section.requestId).toBe(pending.requestId);
  });

  test('account-view-confirming', () => {
    const section = accountSection(state({ status: 'confirming', user: USER, ...pending }));
    // Cancel first, then the confirmation's own words (never "Sign in" where Sign in was).
    expect(section.view).toMatchObject({ kind: 'confirming', question: 'Sign in to frost as alice@example.com?', fingerprint: 'ABCD-EF12', buttons: ['cancel', 'confirm'] });
    expect(ACCOUNT_SETTINGS_TEXT.confirmLabel).toBe('Confirm sign-in');
    expect(section.requestId).toBe(pending.requestId);
  });

  test('account-view-signed-in-plan', () => {
    const section = accountSection(state({ status: 'signed-in', user: USER, entitlements: PRO }), day);
    expect(section.view).toMatchObject({ kind: 'signed-in', email: 'alice@example.com', name: 'Alice', initial: 'A', buttons: ['refresh', 'sign-out'] });
    // A whole grapheme, never half a surrogate pair or a bare combining mark.
    expect(initialOf('\u{1F469}\u200D\u{1F4BB} Dev', 'x@example.com')).toBe('\u{1F469}\u200D\u{1F4BB}');
    expect(initialOf('e\u0301mile', 'x@example.com')).toBe('E\u0301');
    expect(initialOf(null, 'bo@example.com')).toBe('B');
    expect(initialOf('  ', 'zed@example.com')).toBe('Z');
    if (section.view.kind !== 'signed-in') throw new Error('not signed in');
    expect(section.view.plan).toMatchObject({ label: 'Pro', tone: 'ok' });
    // What the account adds (sync), in plain words (no flag IDs): not the free features.
    expect(section.view.plan.features.map((f) => f.flag)).toEqual([...ACCOUNT_FEATURES]);
    for (const feature of section.view.plan.features) {
      expect(feature.label).toBe(FEATURE_LABELS[feature.flag]);
      expect(feature.included).toBe(true);
    }
    // The default plan has every feature too.
    const free = accountSection(state({ status: 'signed-in', user: { email: 'bo@example.com', name: null }, entitlements: { ...PRO, plan: 'free', features: [...PLAN_FEATURES.free] } }));
    if (free.view.kind !== 'signed-in') throw new Error('not signed in');
    expect(free.view.name).toBeNull();
    expect(free.view.plan.label).toBe('Free');
    expect(free.view.plan.status).toBe(planView(PRO).status);
    expect(free.view.plan.features.every((f) => f.included)).toBe(true);
    // A snapshot without sync (an older server's free plan) shows it as not included.
    const without = planView({ ...PRO, plan: 'free', features: [] });
    expect(without.features.every((f) => !f.included)).toBe(true);
  });

  test('account-view-entitlement-status', () => {
    expect(planView(PRO, day)).toMatchObject({ status: 'Your account is active.', tone: 'ok' });
    expect(planView({ ...PRO, status: 'grace' }, day).status).toBe(`Offline — your account's features stay available until ${day(EXP + OFFLINE_GRACE_MS)}`);
    // The default format carries the time as well as the date.
    expect(planView({ ...PRO, status: 'grace' }).status).toMatch(/\d{1,2}:\d{2}/);
    const expired = planView({ ...PRO, plan: 'free', features: [], status: 'expired' }, day);
    expect(expired).toMatchObject({ label: 'Free', tone: 'error' });
    expect(expired.status).toMatch(/sync is off/);
    // Expired is not only "offline": the copy does not claim so.
    expect(expired.status).not.toMatch(/offline|online/i);
    const invalid = planView({ ...NO_ENTITLEMENTS, status: 'invalid' }, day);
    expect(invalid).toMatchObject({ label: 'Free', tone: 'error' });
    expect(invalid.status).toMatch(/verified, so sync is off/);
    expect(planView(NO_ENTITLEMENTS, day).status).toBe('Checking your account…');
    // No status line names a plan to buy.
    for (const status of ['active', 'grace', 'expired', 'invalid'] as const) expect(planView({ ...PRO, status }, day).status).not.toMatch(/\bPro\b|\bFree\b|upgrade/);
  });

  test('account-view-keychain-notice', () => {
    const memory = { keychain: 'memory-only' } as const;
    expect(accountSection(state({ ...memory, status: 'signed-in', user: USER, entitlements: PRO })).keychain).toBe("This system has no keychain; you'll be signed out when frost quits");
    expect(accountSection(state({ ...memory, status: 'confirming', user: USER, ...pending })).keychain).toBe(ACCOUNT_SETTINGS_TEXT.keychain);
    expect(accountSection(state({ ...memory, status: 'awaiting-browser', ...pending })).keychain).toBe(ACCOUNT_SETTINGS_TEXT.keychain);
    expect(accountSection(state({ ...memory })).keychain).toBeNull();
    expect(accountSection(state({ status: 'signed-in', user: USER, entitlements: PRO })).keychain).toBeNull();
  });

  test('account-view-sign-in-results', () => {
    expect(signInResultMessage('started')).toBeNull();
    for (const result of SIGN_IN_RESULTS.filter((r) => r !== 'started')) expect(signInResultMessage(result), result).toMatch(/\w{3,}/);
    expect(signInResultMessage('needs-gesture')).toMatch(/Click Sign in again/);
  });
});
