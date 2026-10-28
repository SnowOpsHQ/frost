// Spec: specs/entitlements-snapshot.spec.ts (EntitlementsSchema, FEATURE_NOT_ENTITLED_CODE, entitlementGrants),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/entitlements-client.feature.md (Router) · plan Global Constraint "Tokens stay in main"
import { getTRPCErrorShape, TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import {
  FEATURE_FLAGS,
  FEATURE_NOT_ENTITLED_CODE,
  INVALID_ENTITLEMENTS,
  NO_ENTITLEMENTS,
  OFFLINE_GRACE_MS,
  type Entitlements,
  type FeatureFlag,
} from '@app/specs/entitlements-snapshot.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { requireFeature } from '../account-router';
import { appRouter, createSenderPolicy, type AccountService, type IpcContext } from '../index';
import { enforceSender, publicProcedure, router } from '../trpc';

const WINDOW_ID = 7;
const FAKE_SNAPSHOT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';
const FAKE_TOKEN = 'frost-desktop-token-0123456789abcdef';
const EXP = Date.UTC(2026, 9, 4);

const entitled = (status: 'active' | 'grace', features: FeatureFlag[] = [...FEATURE_FLAGS]): Entitlements => ({
  plan: 'pro',
  features,
  status,
  expiresAtMs: EXP,
  graceEndsAtMs: EXP + OFFLINE_GRACE_MS,
});
const EXPIRED: Entitlements = { plan: 'free', features: [], status: 'expired', expiresAtMs: EXP, graceEndsAtMs: EXP + OFFLINE_GRACE_MS };

function fakeAccount(entitlements: Entitlements = entitled('active')) {
  return { entitlements: vi.fn(() => entitlements) } satisfies AccountService;
}

function ctxFor(account: AccountService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: account === undefined ? {} : { account },
  };
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const accountCaller = (ctx: IpcContext) => (appRouter.createCaller(ctx) as unknown as { account: { entitlements: () => Promise<unknown> } }).account;

/** A Phase 5-style gated procedure, built the way the interface says: sender first, then the feature. */
const handler = vi.fn(() => 'ran' as const);
const gated = router({
  agent: publicProcedure.use(enforceSender).use(requireFeature('ai-agent')).query(handler),
});
const gatedCall = (ctx: IpcContext) => gated.createCaller(ctx).agent();

describe('account router', () => {
  test('account-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('account.'));
    expect(paths).toEqual(['account.entitlements']);
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
      const account = fakeAccount();
      expect((await errorOf(accountCaller(ctxFor(account, origin)).entitlements())).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(account.entitlements).not.toHaveBeenCalled();
    }
  });

  test('account-without-service-fail-closed', async () => {
    const error = await errorOf(accountCaller(ctxFor(undefined)).entitlements());
    expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
    const shape = getTRPCErrorShape({ config: appRouter._def._config, error, type: 'query', path: 'account.entitlements', input: undefined, ctx: undefined });
    expect(shape.message).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('entitlements-answers-verified-state', async () => {
    for (const value of [entitled('active'), entitled('grace', ['sync']), EXPIRED, NO_ENTITLEMENTS, INVALID_ENTITLEMENTS]) {
      await expect(accountCaller(ctxFor(fakeAccount(value))).entitlements()).resolves.toEqual(value);
    }
  });

  test('answers-carry-no-secret', async () => {
    const answer = await accountCaller(ctxFor(fakeAccount())).entitlements();
    const serialized = JSON.stringify(answer);
    for (const secret of [FAKE_SNAPSHOT, FAKE_TOKEN, 'eyJ']) expect(serialized).not.toContain(secret);
    // A service that lets the snapshot (or a token) ride along is refused, masked; nothing is forwarded.
    for (const leak of [{ snapshot: FAKE_SNAPSHOT }, { token: FAKE_TOKEN }]) {
      const leaky = { entitlements: () => ({ ...entitled('active'), ...leak }) as Entitlements };
      const error = await errorOf(accountCaller(ctxFor(leaky)).entitlements());
      expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
      const shape = getTRPCErrorShape({ config: appRouter._def._config, error, type: 'query', path: 'account.entitlements', input: undefined, ctx: undefined });
      expect(JSON.stringify(shape)).not.toContain(FAKE_SNAPSHOT);
      expect(JSON.stringify(shape)).not.toContain(FAKE_TOKEN);
    }
    // A value that breaks the fail-closed rule (expired yet pro) is refused too.
    const broken = { entitlements: () => ({ ...EXPIRED, plan: 'pro', features: ['sync'] }) as Entitlements };
    expect((await errorOf(accountCaller(ctxFor(broken)).entitlements())).code).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('require-feature-passes-when-entitled', async () => {
    for (const value of [entitled('active'), entitled('grace'), entitled('active', ['ai-agent'])]) {
      handler.mockClear();
      await expect(gatedCall(ctxFor(fakeAccount(value)))).resolves.toBe('ran');
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  test('require-feature-forbidden-when-not', async () => {
    const denied = [entitled('active', ['sync', 'search-console']), entitled('grace', []), EXPIRED, NO_ENTITLEMENTS, INVALID_ENTITLEMENTS];
    // Even a malformed service answer (expired but carrying the flag) is not entitled.
    denied.push({ ...EXPIRED, plan: 'pro', features: ['ai-agent'] });
    for (const value of denied) {
      handler.mockClear();
      const error = await errorOf(gatedCall(ctxFor(fakeAccount(value))));
      expect(error.code, value.status).toBe('FORBIDDEN');
      expect(error.message).toBe(FEATURE_NOT_ENTITLED_CODE);
      expect((error.cause as { code?: unknown } | undefined)?.code).toBe(FEATURE_NOT_ENTITLED_CODE);
      expect(handler).not.toHaveBeenCalled();
      // What the renderer sees: FORBIDDEN with the code as the message.
      const shape = getTRPCErrorShape({ config: gated._def._config, error, type: 'query', path: 'agent', input: undefined, ctx: undefined });
      expect(shape).toMatchObject({ message: FEATURE_NOT_ENTITLED_CODE, data: { code: 'FORBIDDEN', httpStatus: 403, path: 'agent' } });
    }
    expect(() => requireFeature('teleport' as FeatureFlag)).toThrow(/feature flag/);
  });

  test('require-feature-after-sender', async () => {
    for (const origin of ['https://evil.com', 'null']) {
      const account = fakeAccount(NO_ENTITLEMENTS);
      handler.mockClear();
      const error = await errorOf(gatedCall(ctxFor(account, origin)));
      expect(error.code).toBe(IPC_SENDER_ERROR_CODE);
      expect(error.message).toBe(IPC_SENDER_ERROR_CODE);
      expect(account.entitlements).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });

  test('require-feature-without-service-masked', async () => {
    handler.mockClear();
    const error = await errorOf(gatedCall(ctxFor(undefined)));
    expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
    const shape = getTRPCErrorShape({ config: gated._def._config, error, type: 'query', path: 'agent', input: undefined, ctx: undefined });
    expect(shape.message).toBe(IPC_INTERNAL_ERROR_CODE);
    expect(handler).not.toHaveBeenCalled();
  });
});
