// Spec: specs/account-settings.spec.ts (ACCOUNT_SETTINGS_TEXT, FEATURE_LABELS), specs/account-state.schema.ts
// (AccountStateSchema, ACCOUNT_ERRORS, SIGN_IN_RESULTS), specs/entitlements-snapshot.spec.ts (EntitlementsSchema)
// Acceptance: specs/account-settings.feature.md (View models)
import { describe, expect, test } from 'vitest';
import { ACCOUNT_SETTINGS_TEXT, FEATURE_LABELS } from '@app/specs/account-settings.spec';
import { ACCOUNT_ERRORS, AccountStateSchema, SIGN_IN_RESULTS, type AccountState } from '@app/specs/account-state.schema';
import { FEATURE_FLAGS, NO_ENTITLEMENTS, OFFLINE_GRACE_MS, PLAN_FEATURES, type Entitlements } from '@app/specs/entitlements-snapshot.spec';
import { ACCOUNT_ERROR_MESSAGES, accountSection, planView, signInResultMessage } from '../account-view';

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

  test('account-view-awaiting-browser', () => {
    const section = accountSection(state({ status: 'awaiting-browser', ...pending }));
    expect(section.view).toEqual({ kind: 'awaiting-browser', message: ACCOUNT_SETTINGS_TEXT.awaitingBrowser, fingerprint: 'ABCD-EF12', hint: 'Your browser should show the same code', buttons: ['cancel'] });
    expect(section.requestId).toBe(pending.requestId);
  });

  test('account-view-confirming', () => {
    const section = accountSection(state({ status: 'confirming', user: USER, ...pending }));
    expect(section.view).toMatchObject({ kind: 'confirming', question: 'Sign in to frost as alice@example.com?', fingerprint: 'ABCD-EF12', buttons: ['confirm', 'cancel'] });
    expect(section.requestId).toBe(pending.requestId);
  });

  test('account-view-signed-in-plan', () => {
    const section = accountSection(state({ status: 'signed-in', user: USER, entitlements: PRO }), day);
    expect(section.view).toMatchObject({ kind: 'signed-in', email: 'alice@example.com', name: 'Alice', buttons: ['refresh', 'sign-out'] });
    if (section.view.kind !== 'signed-in') throw new Error('not signed in');
    expect(section.view.plan).toMatchObject({ label: 'Pro', pro: true, tone: 'ok' });
    // Every feature this build knows, in plain words (no flag IDs), in the spec's order.
    expect(section.view.plan.features.map((f) => f.flag).sort()).toEqual([...FEATURE_FLAGS].sort());
    for (const feature of section.view.plan.features) {
      expect(feature.label).toBe(FEATURE_LABELS[feature.flag]);
      expect(feature.included).toBe(true);
    }
    const free = accountSection(state({ status: 'signed-in', user: { email: 'bo@example.com', name: null }, entitlements: { ...PRO, plan: 'free', features: [] } }));
    if (free.view.kind !== 'signed-in') throw new Error('not signed in');
    expect(free.view.name).toBeNull();
    expect(free.view.plan.label).toBe('Free');
    expect(free.view.plan.features.every((f) => !f.included)).toBe(true);
  });

  test('account-view-entitlement-status', () => {
    expect(planView(PRO, day)).toMatchObject({ status: 'Pro is active.', tone: 'ok' });
    expect(planView({ ...PRO, status: 'grace' }, day).status).toBe(`Offline — Pro stays available until ${day(EXP + OFFLINE_GRACE_MS)}`);
    const expired = planView({ ...PRO, plan: 'free', features: [], status: 'expired' }, day);
    expect(expired).toMatchObject({ label: 'Free', tone: 'error' });
    expect(expired.status).toMatch(/^Free — .+/);
    const invalid = planView({ ...NO_ENTITLEMENTS, status: 'invalid' }, day);
    expect(invalid).toMatchObject({ label: 'Free', tone: 'error' });
    expect(invalid.status).toMatch(/^Free — .*verified/);
    expect(planView(NO_ENTITLEMENTS, day).status).toBe('Checking your plan…');
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
