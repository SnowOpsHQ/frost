// Spec: specs/account-state.schema.ts (AccountStateSchema, AccountWatchInputSchema, AccountRequestInputSchema)
// Acceptance: specs/account-signin.feature.md (Spec schema)
import { describe, expect, test } from 'vitest';
import {
  AccountRequestInputSchema,
  AccountStateSchema,
  AccountWatchInputSchema,
  type AccountState,
} from '@app/specs/account-state.schema';
import { INVALID_ENTITLEMENTS, NO_ENTITLEMENTS, OFFLINE_GRACE_MS, type Entitlements } from '@app/specs/entitlements-snapshot.spec';

const PRO: Entitlements = { plan: 'pro', features: ['ai-agent', 'search-console', 'sync'], status: 'active', expiresAtMs: 1_000, graceEndsAtMs: 1_000 + OFFLINE_GRACE_MS };
const USER = { email: 'dana@example.com', name: 'Dana' };
const REQUEST_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const FINGERPRINT = '1MMS-P7NN';

const base = (overrides: Partial<AccountState>): AccountState => ({
  status: 'signed-out',
  user: null,
  entitlements: { ...NO_ENTITLEMENTS, features: [] },
  keychain: 'persistent',
  requestId: null,
  fingerprint: null,
  error: null,
  version: 0,
  ...overrides,
});

const VALID: AccountState[] = [
  base({ status: 'unconfigured' }),
  base({ status: 'signed-out', error: 'timed-out' }),
  base({ status: 'awaiting-browser', requestId: REQUEST_ID, fingerprint: FINGERPRINT }),
  base({ status: 'confirming', requestId: REQUEST_ID, fingerprint: FINGERPRINT, user: USER }),
  base({ status: 'signed-in', user: USER, entitlements: PRO, keychain: 'memory-only' }),
  base({ status: 'signed-in', user: { email: 'x@example.com', name: null }, entitlements: INVALID_ENTITLEMENTS as Entitlements }),
];

describe('account state schema', () => {
  test('state-schema-has-no-secret-fields', () => {
    for (const state of VALID) expect(AccountStateSchema.safeParse(state).success, state.status).toBe(true);
    for (const leak of ['token', 'code', 'verifier', 'state', 'snapshot', 'userId']) {
      expect(AccountStateSchema.safeParse({ ...VALID[4], [leak]: 'secret-value' }).success, leak).toBe(false);
    }
    expect(AccountStateSchema.safeParse({ ...VALID[4], user: { ...USER, id: 'user-1' } }).success).toBe(false);
    expect(AccountStateSchema.safeParse({ ...VALID[4], entitlements: { ...PRO, snapshot: 'eyJ.x.y' } }).success).toBe(false);
  });

  test('state-schema-ties-fields-to-status', () => {
    const invalid: AccountState[] = [
      base({ status: 'signed-out', user: USER }),
      base({ status: 'signed-in' }),
      base({ status: 'confirming', requestId: REQUEST_ID, fingerprint: FINGERPRINT }),
      base({ status: 'awaiting-browser', requestId: REQUEST_ID }),
      base({ status: 'awaiting-browser', fingerprint: FINGERPRINT }),
      base({ status: 'signed-out', requestId: REQUEST_ID }),
      base({ status: 'signed-in', user: USER, fingerprint: FINGERPRINT }),
      base({ status: 'awaiting-browser', requestId: REQUEST_ID, fingerprint: '1mms-p7nn' }),
      base({ status: 'awaiting-browser', requestId: 'short', fingerprint: FINGERPRINT }),
      base({ status: 'signed-in', user: { email: 'not-an-email', name: null } }),
      base({ error: 'something-else' as AccountState['error'] }),
      base({ version: -1 }),
    ];
    for (const state of invalid) expect(AccountStateSchema.safeParse(state).success, JSON.stringify(state)).toBe(false);
  });

  test('state-schema-fails-closed', () => {
    for (const status of ['unconfigured', 'signed-out'] as const) {
      expect(AccountStateSchema.safeParse(base({ status, entitlements: PRO })).success).toBe(false);
      expect(AccountStateSchema.safeParse(base({ status, entitlements: INVALID_ENTITLEMENTS as Entitlements })).success).toBe(false);
    }
    expect(AccountStateSchema.safeParse(base({ status: 'confirming', requestId: REQUEST_ID, fingerprint: FINGERPRINT, user: USER, entitlements: PRO })).success).toBe(false);
    // The entitlements' own fail-closed rule still holds inside the state.
    expect(AccountStateSchema.safeParse(base({ status: 'signed-in', user: USER, entitlements: { ...PRO, status: 'expired' } })).success).toBe(false);
  });

  test('input-schemas-are-strict', () => {
    expect(AccountWatchInputSchema.safeParse({ sinceVersion: -1 }).success).toBe(true);
    expect(AccountWatchInputSchema.safeParse({ sinceVersion: 3 }).success).toBe(true);
    for (const bad of [{}, { sinceVersion: -2 }, { sinceVersion: 1.5 }, { sinceVersion: '1' }, { sinceVersion: 1, extra: true }]) {
      expect(AccountWatchInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(AccountRequestInputSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(true);
    for (const bad of [{}, { requestId: '' }, { requestId: `${REQUEST_ID}A` }, { requestId: 'AAAAAAAAAAAAAAAAAAAAA=' }, { requestId: REQUEST_ID, token: 'x' }]) {
      expect(AccountRequestInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
