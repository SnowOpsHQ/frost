// Spec: specs/entitlements-snapshot.spec.ts (EntitlementsSchema, FEATURE_NOT_ENTITLED_CODE, entitlementGrants),
// specs/account-state.schema.ts (AccountStateSchema, AccountWatchInputSchema, AccountRequestInputSchema, SIGN_IN_RESULTS),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE), specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/entitlements-client.feature.md (Router), specs/account-signin.feature.md (Router)
// · plan Global Constraint "Tokens stay in main"
import { getTRPCErrorShape, TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SIGN_IN_RESULTS, type AccountState, type SignInResult } from '@app/specs/account-state.schema';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
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

const REQUEST_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const FAKE_CODE = 'fake-code-0123456789abcdefghijklmnopqrstuv';
const FAKE_VERIFIER = 'fake-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const FAKE_STATE = 'fake-state-0123456789abcdef';
const SECRETS = [FAKE_SNAPSHOT, FAKE_TOKEN, FAKE_CODE, FAKE_VERIFIER, FAKE_STATE, 'user-1'];

const accountState = (version: number, overrides: Partial<AccountState> = {}): AccountState => ({
  status: 'signed-in',
  user: { email: 'dana@example.com', name: 'Dana' },
  entitlements: entitled('active'),
  keychain: 'persistent',
  requestId: null,
  fingerprint: null,
  error: null,
  version,
  ...overrides,
});

function fakeAccount(entitlements: Entitlements = entitled('active')) {
  let release: ((s: AccountState) => void) | null = null;
  const account = {
    entitlements: vi.fn(() => entitlements),
    state: vi.fn(() => accountState(3)),
    watch: vi.fn((since: number, signal?: AbortSignal) =>
      since < 3
        ? Promise.resolve(accountState(3))
        : new Promise<AccountState>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(accountState(3)));
          }),
    ),
    signIn: vi.fn(async (_windowId: number): Promise<SignInResult> => 'started'),
    confirmSignIn: vi.fn(async (requestId: string) => requestId === REQUEST_ID),
    cancelSignIn: vi.fn(async (requestId: string) => requestId === REQUEST_ID),
    signOut: vi.fn(async () => true),
    refresh: vi.fn(async () => true),
  } satisfies AccountService;
  return Object.assign(account, { push: (s: AccountState) => release?.(s) });
}

/** Every account procedure, its type and a valid input. */
const ACCOUNT_PROCEDURES: Record<string, { type: 'query' | 'mutation'; input?: unknown }> = {
  entitlements: { type: 'query' },
  state: { type: 'query' },
  watch: { type: 'query', input: { sinceVersion: -1 } },
  signIn: { type: 'mutation' },
  confirmSignIn: { type: 'mutation', input: { requestId: REQUEST_ID } },
  cancelSignIn: { type: 'mutation', input: { requestId: REQUEST_ID } },
  signOut: { type: 'mutation' },
  refresh: { type: 'mutation' },
};

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { account: Record<string, (input?: unknown) => Promise<unknown>> }).account;
  const fn = caller[name];
  if (!fn) throw new Error(`no account.${name}`);
  return fn(input);
}

afterEach(() => vi.useRealTimers());

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
    expect(paths.sort()).toEqual(Object.keys(ACCOUNT_PROCEDURES).map((n) => `account.${n}`).sort());
    for (const [name, { input }] of Object.entries(ACCOUNT_PROCEDURES)) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const account = fakeAccount();
        expect((await errorOf(call(ctxFor(account, origin), name, input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        for (const fn of Object.values(account)) if (vi.isMockFunction(fn)) expect(fn, name).not.toHaveBeenCalled();
      }
    }
    // Each is the type it should be (a mutation is not reachable as a query, and the other way round).
    for (const [name, { type }] of Object.entries(ACCOUNT_PROCEDURES)) {
      expect((appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)[`account.${name}`]?._def.type, name).toBe(type);
    }
  });

  test('sign-in-passes-window-id', async () => {
    for (const result of SIGN_IN_RESULTS) {
      const account = fakeAccount();
      account.signIn.mockResolvedValueOnce(result);
      await expect(call(ctxFor(account), 'signIn')).resolves.toBe(result);
      expect(account.signIn).toHaveBeenCalledExactlyOnceWith(WINDOW_ID);
    }
    const account = fakeAccount();
    await expect(call(ctxFor(account), 'confirmSignIn', { requestId: REQUEST_ID })).resolves.toBe(true);
    expect(account.confirmSignIn).toHaveBeenCalledWith(REQUEST_ID);
    await expect(call(ctxFor(account), 'cancelSignIn', { requestId: 'BBBBBBBBBBBBBBBBBBBBBB' })).resolves.toBe(false);
    await expect(call(ctxFor(account), 'signOut')).resolves.toBe(true);
    await expect(call(ctxFor(account), 'refresh')).resolves.toBe(true);
    // Inputs are validated before the service is reached.
    for (const [name, input] of [
      ['confirmSignIn', { requestId: 'short' }],
      ['cancelSignIn', {}],
      ['confirmSignIn', { requestId: REQUEST_ID, token: FAKE_TOKEN }],
      ['watch', { sinceVersion: -2 }],
    ] as const) {
      const fresh = fakeAccount();
      expect((await errorOf(call(ctxFor(fresh), name, input))).code, name).toBe('BAD_REQUEST');
      expect(fresh.confirmSignIn).not.toHaveBeenCalled();
      expect(fresh.cancelSignIn).not.toHaveBeenCalled();
      expect(fresh.watch).not.toHaveBeenCalled();
    }
  });

  test('account-watch-long-polls', async () => {
    const account = fakeAccount();
    await expect(call(ctxFor(account), 'state')).resolves.toEqual(accountState(3));
    await expect(call(ctxFor(account), 'watch', { sinceVersion: 1 })).resolves.toEqual(accountState(3));
    // Up to date: waits for the next change.
    const next = call(ctxFor(account), 'watch', { sinceVersion: 3 });
    await vi.waitFor(() => expect(account.watch).toHaveBeenCalledTimes(2));
    account.push(accountState(4, { status: 'signed-out', user: null, entitlements: NO_ENTITLEMENTS }));
    await expect(next).resolves.toMatchObject({ version: 4, status: 'signed-out' });
    // Nothing changes: the current state after WATCH_TIMEOUT_MS, and the waiter released.
    vi.useFakeTimers();
    const idle = call(ctxFor(account), 'watch', { sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(idle).resolves.toEqual(accountState(3));
    const signal = account.watch.mock.calls.at(-1)?.[1];
    expect(signal?.aborted).toBe(true);
  });

  test('account-outputs-are-strict', async () => {
    const bad: [string, (a: ReturnType<typeof fakeAccount>) => void][] = [
      ['state', (a) => a.state.mockReturnValue({ ...accountState(3), token: FAKE_TOKEN } as AccountState)],
      ['state', (a) => a.state.mockReturnValue({ ...accountState(3), status: 'signed-out' })],
      ['watch', (a) => a.watch.mockResolvedValue({ ...accountState(3), user: { email: 'x@example.com', name: null, id: 'user-1' } } as AccountState)],
      ['signIn', (a) => a.signIn.mockResolvedValue('opened' as SignInResult)],
      ['confirmSignIn', (a) => a.confirmSignIn.mockResolvedValue({ token: FAKE_TOKEN } as unknown as boolean)],
      ['cancelSignIn', (a) => a.cancelSignIn.mockResolvedValue('yes' as unknown as boolean)],
      ['signOut', (a) => a.signOut.mockResolvedValue(FAKE_TOKEN as unknown as boolean)],
      ['refresh', (a) => a.refresh.mockResolvedValue(undefined as unknown as boolean)],
    ];
    for (const [name, breakIt] of bad) {
      const account = fakeAccount();
      breakIt(account);
      const error = await errorOf(call(ctxFor(account), name, ACCOUNT_PROCEDURES[name]?.input));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
      const shape = getTRPCErrorShape({ config: appRouter._def._config, error, type: 'query', path: `account.${name}`, input: undefined, ctx: undefined });
      expect(JSON.stringify(shape)).not.toContain(FAKE_TOKEN);
      expect(shape.message).toBe(IPC_INTERNAL_ERROR_CODE);
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
    // Every account procedure, across the states the flow goes through.
    const states: AccountState[] = [
      accountState(1, { status: 'awaiting-browser', user: null, entitlements: NO_ENTITLEMENTS, requestId: REQUEST_ID, fingerprint: '1MMS-P7NN' }),
      accountState(2, { status: 'confirming', entitlements: NO_ENTITLEMENTS, requestId: REQUEST_ID, fingerprint: '1MMS-P7NN' }),
      accountState(3),
    ];
    for (const state of states) {
      const account = fakeAccount();
      account.state.mockReturnValue(state);
      account.watch.mockResolvedValue(state);
      for (const [name, { input }] of Object.entries(ACCOUNT_PROCEDURES)) {
        const text = JSON.stringify(await call(ctxFor(account), name, input));
        for (const secret of SECRETS) expect(text, `${name} ${state.status}`).not.toContain(secret);
      }
    }
    // A service that lets the snapshot (or a token) ride along is refused, masked; nothing is forwarded.
    for (const leak of [{ snapshot: FAKE_SNAPSHOT }, { token: FAKE_TOKEN }]) {
      const leaky = { ...fakeAccount(), entitlements: () => ({ ...entitled('active'), ...leak }) as Entitlements };
      const error = await errorOf(accountCaller(ctxFor(leaky)).entitlements());
      expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
      const shape = getTRPCErrorShape({ config: appRouter._def._config, error, type: 'query', path: 'account.entitlements', input: undefined, ctx: undefined });
      expect(JSON.stringify(shape)).not.toContain(FAKE_SNAPSHOT);
      expect(JSON.stringify(shape)).not.toContain(FAKE_TOKEN);
    }
    // A value that breaks the fail-closed rule (expired yet pro) is refused too.
    const broken = { ...fakeAccount(), entitlements: () => ({ ...EXPIRED, plan: 'pro', features: ['sync'] }) as Entitlements };
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
