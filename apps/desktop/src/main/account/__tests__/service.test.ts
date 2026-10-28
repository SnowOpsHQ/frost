// Spec: specs/account-state.schema.ts (AccountStateSchema, SIGN_IN_RESULTS, CONFIRM_TIMEOUT_MS,
// ACCOUNT_REFRESH_INTERVAL_MS, MAX_PENDING_ACCOUNT_WATCHES), specs/account-api.schema.ts (requestFingerprint,
// DesktopAuthorizeQuerySchema), specs/entitlements-snapshot.spec.ts (NO_ENTITLEMENTS)
// Acceptance: specs/account-signin.feature.md (The flow) · review focus "A website or another app cannot
// sign the user in to someone else's account" · plan Global Constraints "Tokens stay in main", "Logs never carry secrets"
import { request } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DesktopAuthorizeQuerySchema, requestFingerprint } from '@app/specs/account-api.schema';
import {
  ACCOUNT_REFRESH_INTERVAL_MS,
  AccountStateSchema,
  CONFIRM_TIMEOUT_MS,
  MAX_PENDING_ACCOUNT_WATCHES,
  type AccountState,
} from '@app/specs/account-state.schema';
import { NO_ENTITLEMENTS, OFFLINE_GRACE_MS, type Entitlements, type EntitlementRefreshFailure } from '@app/specs/entitlements-snapshot.spec';
import type { AccountApi, ApiResult } from '../api-client';
import type { AccountConfig } from '../config';
import type { EntitlementsController } from '../entitlements';
import { startLoopback as realStartLoopback, type Loopback, type LoopbackCallback, type StartLoopbackOptions } from '../loopback';
import { ACCOUNT_SECRET, createAccountService, type AccountServiceDeps } from '../service';

const CONFIG: AccountConfig = { apiBase: 'https://api.example.com', jwks: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), kid: 'k1' }] } };
const WINDOW = 3;
const OTHER_WINDOW = 4;
const TOKEN = `frost_dt_${'tok0'.repeat(10)}abc`;
const TOKEN_2 = `frost_dt_${'two2'.repeat(10)}xyz`;
const CODE = 'codeCODE'.repeat(5) + 'abc';
const EMAIL = 'dana.secret@example.com';
const USER = { id: 'user-1', email: EMAIL, name: 'Dana' };
const SNAPSHOT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIn0.c2lnbmF0dXJlLXNlY3JldA';
const FAR_FUTURE = Date.UTC(2099, 0, 1);
const PRO: Entitlements = { plan: 'pro', features: ['ai-agent', 'search-console', 'sync'], status: 'active', expiresAtMs: FAR_FUTURE, graceEndsAtMs: FAR_FUTURE + OFFLINE_GRACE_MS };

afterEach(() => vi.useRealTimers());

// ---- Fakes ----------------------------------------------------------------------------------------

function fakeStore(persistent = true, initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    persistent,
    values,
    read: vi.fn((name: string) => values.get(name) ?? null),
    write: vi.fn((name: string, value: string) => void values.set(name, value)),
    delete: vi.fn((name: string) => void values.delete(name)),
  };
}

function fakeEntitlements(initial: Entitlements = NO_ENTITLEMENTS) {
  let current: Entitlements = initial;
  const listeners = new Set<(e: Entitlements) => void>();
  const set = (next: Entitlements) => {
    current = next;
    for (const l of listeners) l(next);
  };
  const controller = {
    current: vi.fn(() => current),
    has: vi.fn(() => false),
    requireFeature: vi.fn(),
    onChange: vi.fn((l: (e: Entitlements) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    update: vi.fn(async (_snapshot: string, _sub: string) => {
      set(PRO);
      return current;
    }),
    markRefreshFailed: vi.fn((kind: EntitlementRefreshFailure) => {
      if (kind === 'auth') set(NO_ENTITLEMENTS);
      if (kind === 'invalid') set({ ...NO_ENTITLEMENTS, status: 'invalid' });
      return current;
    }),
    clear: vi.fn(() => {
      set(NO_ENTITLEMENTS);
      return current;
    }),
    dispose: vi.fn(),
  } satisfies EntitlementsController;
  return { controller, set };
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const fail = (failure: 'network' | 'auth' | 'invalid'): ApiResult<never> => ({ ok: false, failure });

function fakeApi() {
  return {
    exchange: vi.fn(async (_req: { code: string; verifier: string; redirectUri: string }) => ok({ token: TOKEN, expiresAt: FAR_FUTURE, user: USER })),
    session: vi.fn(async (_token: string) => ok({ user: USER })),
    entitlements: vi.fn(async (_token: string) => ok({ snapshot: SNAPSHOT })),
    signOut: vi.fn(async (_token: string) => ok(null)),
  } satisfies AccountApi;
}

interface FakeLoop {
  readonly options: StartLoopbackOptions;
  readonly loopback: Loopback & { close: ReturnType<typeof vi.fn> };
  callback(cb?: Partial<LoopbackCallback>): void;
  timeout(): void;
}

function fakeLoopbacks() {
  const started: FakeLoop[] = [];
  const start = vi.fn(async (options: StartLoopbackOptions) => {
    const port = 50_000 + started.length;
    let closedResolve!: () => void;
    const closed = new Promise<void>((resolve) => (closedResolve = resolve));
    const loopback = { port, address: '127.0.0.1', redirectUri: `http://127.0.0.1:${port}/callback`, closed, close: vi.fn(() => closedResolve()) };
    started.push({
      options,
      loopback,
      callback: (cb = {}) => options.onCallback({ code: CODE, error: null, params: new URLSearchParams(), ...cb }),
      timeout: () => options.onTimeout?.(),
    });
    return loopback;
  });
  return { started, start };
}

function harness(overrides: Partial<AccountServiceDeps> & { gestures?: number[] } = {}) {
  const log: string[] = [];
  const store = fakeStore();
  const ents = fakeEntitlements();
  const api = fakeApi();
  const loops = fakeLoopbacks();
  const gestures = new Set<number>(overrides.gestures ?? [WINDOW]);
  const opened: string[] = [];
  const deps: AccountServiceDeps = {
    config: CONFIG,
    api,
    store,
    entitlements: ents.controller,
    startLoopback: loops.start,
    openInBrowser: vi.fn((url: string, userGesture: boolean) => {
      if (!userGesture) return false;
      opened.push(url);
      return true;
    }),
    consumeGesture: vi.fn((windowId: number) => gestures.delete(windowId)),
    focusWindow: vi.fn(),
    log: (message: string) => void log.push(message),
    ...overrides,
  };
  const service = createAccountService(deps);
  const secrets = new Set<string>([TOKEN, TOKEN_2, CODE, EMAIL, SNAPSHOT]);
  return { service, deps, store, ents, api, loops, gestures, opened, log, secrets };
}
type Harness = ReturnType<typeof harness>;

/** The state, validated against the strict spec schema. */
const stateOf = (h: Harness): AccountState => AccountStateSchema.parse(h.service.state());

/** Signs in up to `confirming`; answers the started loopback. */
async function toConfirming(h: Harness): Promise<FakeLoop> {
  h.gestures.add(WINDOW);
  expect(await h.service.signIn(WINDOW)).toBe('started');
  const loop = h.loops.started.at(-1)!;
  h.secrets.add(loop.options.state);
  loop.callback();
  await h.service.whenIdle();
  const verifier = h.api.exchange.mock.calls.at(-1)?.[0].verifier;
  if (verifier) h.secrets.add(verifier);
  expect(stateOf(h).status).toBe('confirming');
  return loop;
}

async function toSignedIn(h: Harness): Promise<void> {
  await toConfirming(h);
  expect(await h.service.confirmSignIn(stateOf(h).requestId!)).toBe(true);
  await h.service.whenIdle();
}

function expectLogClean(h: Harness): void {
  const text = h.log.join('\n');
  for (const secret of h.secrets) expect(text, 'log carries a secret').not.toContain(secret);
  expect(text).not.toContain('example.com');
}

const storedAccount = (overrides: Record<string, unknown> = {}) => JSON.stringify({ v: 1, token: TOKEN, expiresAt: FAR_FUTURE, user: USER, ...overrides });

// ---- Tests ----------------------------------------------------------------------------------------

describe('account sign-in flow', () => {
  test('sign-in-unconfigured', async () => {
    const h = harness({ config: null, api: null, entitlements: null });
    expect(stateOf(h)).toMatchObject({ status: 'unconfigured', user: null, entitlements: NO_ENTITLEMENTS });
    expect(await h.service.signIn(WINDOW)).toBe('unconfigured');
    expect(await h.service.refresh()).toBe(false);
    expect(await h.service.signOut()).toBe(false);
    expect(h.loops.start).not.toHaveBeenCalled();
    expect(h.deps.openInBrowser).not.toHaveBeenCalled();
    expect(h.deps.consumeGesture).not.toHaveBeenCalled();
    expect(h.service.entitlements()).toEqual(NO_ENTITLEMENTS);
  });

  test('sign-in-without-gesture-opens-nothing', async () => {
    const h = harness({ gestures: [OTHER_WINDOW] });
    expect(await h.service.signIn(WINDOW)).toBe('needs-gesture');
    expect(h.loops.start).not.toHaveBeenCalled();
    expect(h.deps.openInBrowser).not.toHaveBeenCalled();
    expect(h.opened).toEqual([]);
    expect(stateOf(h).status).toBe('signed-out');
    // The other window's gesture was not spent on this window's request.
    expect(h.gestures.has(OTHER_WINDOW)).toBe(true);
  });

  test('sign-in-opens-authorize-url', async () => {
    const h = harness();
    expect(await h.service.signIn(WINDOW)).toBe('started');
    expect(h.deps.consumeGesture).toHaveBeenCalledWith(WINDOW);
    expect(h.loops.started).toHaveLength(1);
    const [loop] = h.loops.started;
    expect(h.opened).toHaveLength(1);
    const url = new URL(h.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.example.com/desktop/authorize');
    const query = DesktopAuthorizeQuerySchema.parse(Object.fromEntries(url.searchParams));
    expect(query.redirect_uri).toBe(loop!.loopback.redirectUri);
    expect(query.state).toBe(loop!.options.state);
    const state = stateOf(h);
    expect(state).toMatchObject({ status: 'awaiting-browser', user: null, error: null });
    expect(state.fingerprint).toBe(requestFingerprint(query.code_challenge));
    expect(h.api.exchange).not.toHaveBeenCalled();
  });

  test('sign-in-needs-confirmation', async () => {
    const h = harness();
    await h.service.signIn(WINDOW);
    const loop = h.loops.started[0]!;
    const challenge = new URL(h.opened[0]!).searchParams.get('code_challenge')!;
    loop.callback();
    await h.service.whenIdle();
    expect(h.api.exchange).toHaveBeenCalledOnce();
    const exchanged = h.api.exchange.mock.calls[0]![0];
    expect(exchanged.code).toBe(CODE);
    expect(exchanged.redirectUri).toBe(loop.loopback.redirectUri);
    const { challengeOf } = await import('../pkce');
    expect(challengeOf(exchanged.verifier)).toBe(challenge);
    expect(h.api.session).toHaveBeenCalledWith(TOKEN);
    const state = stateOf(h);
    expect(state).toMatchObject({ status: 'confirming', user: { email: EMAIL, name: 'Dana' }, entitlements: NO_ENTITLEMENTS, fingerprint: requestFingerprint(challenge) });
    expect(h.deps.focusWindow).toHaveBeenCalledWith(WINDOW);
    // Nothing stored or used before the confirmation.
    expect(h.store.write).not.toHaveBeenCalled();
    expect(h.api.entitlements).not.toHaveBeenCalled();
    expect(h.ents.controller.update).not.toHaveBeenCalled();
    expect(h.service.entitlements()).toEqual(NO_ENTITLEMENTS);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  test('state-mismatch-refused', async () => {
    const h = harness({ startLoopback: realStartLoopback });
    expect(await h.service.signIn(WINDOW)).toBe('started');
    const url = new URL(h.opened[0]!);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    const state = url.searchParams.get('state')!;
    const hit = (query: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: Number(redirect.port), path: `/callback?${query}`, headers: { Connection: 'close' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    expect(await hit(`code=${CODE}&state=forged-state-0123456789`)).toBe(400);
    await h.service.whenIdle();
    expect(h.api.exchange).not.toHaveBeenCalled();
    expect(stateOf(h).status).toBe('awaiting-browser');
    expect(await hit(`code=${CODE}&state=${state}`)).toBe(303);
    await h.service.whenIdle();
    expect(h.api.exchange).toHaveBeenCalledOnce();
    expect(stateOf(h).status).toBe('confirming');
    await h.service.cancelSignIn(stateOf(h).requestId!);
  });

  test('callback-without-pending-ignored', async () => {
    const h = harness();
    await h.service.signIn(WINDOW);
    const first = h.loops.started[0]!;
    expect(await h.service.cancelSignIn(stateOf(h).requestId!)).toBe(true);
    expect(first.loopback.close).toHaveBeenCalled();
    first.callback();
    await h.service.whenIdle();
    expect(h.api.exchange).not.toHaveBeenCalled();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: null });
    // A replaced request's callback is dropped too.
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.loops.started[1]!.callback();
    await h.service.whenIdle();
    expect(h.api.exchange).not.toHaveBeenCalled();
    expect(stateOf(h).status).toBe('awaiting-browser');
  });

  test('second-callback-ignored', async () => {
    const h = harness();
    const loop = await toConfirming(h);
    loop.callback();
    loop.callback({ code: 'other-code-0123456789' });
    await h.service.whenIdle();
    expect(h.api.exchange).toHaveBeenCalledOnce();
    expect(stateOf(h).status).toBe('confirming');
  });

  test('browser-error-is-cancelled', async () => {
    const h = harness();
    await h.service.signIn(WINDOW);
    h.loops.started[0]!.callback({ code: null, error: 'access_denied' });
    await h.service.whenIdle();
    expect(h.api.exchange).not.toHaveBeenCalled();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'cancelled', requestId: null });
  });

  test('timeout-is-timed-out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const h = harness();
    await h.service.signIn(WINDOW);
    h.loops.started[0]!.timeout();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'timed-out' });
    // A timeout after the callback (the exchange is under way) changes nothing.
    await toConfirming(h);
    h.loops.started[1]!.timeout();
    expect(stateOf(h).status).toBe('confirming');
    // No confirmation in time: dropped and the exchanged token revoked.
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'timed-out' });
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);
    expect(h.store.write).not.toHaveBeenCalled();
  });

  test('new-sign-in-replaces-pending', async () => {
    const h = harness();
    await h.service.signIn(WINDOW);
    const first = h.loops.started[0]!;
    const firstId = stateOf(h).requestId;
    // The first request's exchange is slow and finishes after it was replaced.
    let finish!: (r: ApiResult<{ token: string; expiresAt: number; user: typeof USER }>) => void;
    h.api.exchange.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    first.callback();
    h.gestures.add(WINDOW);
    expect(await h.service.signIn(WINDOW)).toBe('started');
    expect(first.loopback.close).toHaveBeenCalled();
    expect(stateOf(h).requestId).not.toBe(firstId);
    finish(ok({ token: TOKEN_2, expiresAt: FAR_FUTURE, user: USER }));
    await h.service.whenIdle();
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN_2);
    expect(h.api.session).not.toHaveBeenCalled();
    expect(stateOf(h).status).toBe('awaiting-browser');
    // Replacing a confirming request revokes its token.
    await toConfirming(h);
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    await h.service.whenIdle();
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);
    expect(stateOf(h).status).toBe('awaiting-browser');
    expect(h.store.write).not.toHaveBeenCalled();
  });

  test('cancel-revokes-exchanged-token', async () => {
    const h = harness();
    await toConfirming(h);
    const { requestId } = stateOf(h);
    expect(await h.service.cancelSignIn('BBBBBBBBBBBBBBBBBBBBBB')).toBe(false);
    expect(stateOf(h).status).toBe('confirming');
    expect(await h.service.cancelSignIn(requestId!)).toBe(true);
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);
    expect(h.store.write).not.toHaveBeenCalled();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', user: null, error: null });
    expect(await h.service.cancelSignIn(requestId!)).toBe(false);
    expectLogClean(h);
  });

  test('confirm-stale-request-refused', async () => {
    const h = harness();
    await h.service.signIn(WINDOW);
    const awaitingId = stateOf(h).requestId!;
    // Not exchanged yet: nothing to confirm.
    expect(await h.service.confirmSignIn(awaitingId)).toBe(false);
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.loops.started[1]!.callback();
    await h.service.whenIdle();
    // The replaced request's ID, and an unknown one.
    expect(await h.service.confirmSignIn(awaitingId)).toBe(false);
    expect(await h.service.confirmSignIn('CCCCCCCCCCCCCCCCCCCCCC')).toBe(false);
    expect(h.store.write).not.toHaveBeenCalled();
    expect(stateOf(h).status).toBe('confirming');
  });

  test('confirm-stores-and-fetches-entitlements', async () => {
    const h = harness();
    await toConfirming(h);
    const before = stateOf(h).version;
    expect(await h.service.confirmSignIn(stateOf(h).requestId!)).toBe(true);
    await h.service.whenIdle();
    expect(h.store.write).toHaveBeenCalledWith(ACCOUNT_SECRET, expect.any(String));
    expect(JSON.parse(h.store.values.get(ACCOUNT_SECRET)!)).toEqual({ v: 1, token: TOKEN, expiresAt: FAR_FUTURE, user: USER });
    expect(h.api.entitlements).toHaveBeenCalledWith(TOKEN);
    expect(h.ents.controller.update).toHaveBeenCalledWith(SNAPSHOT, USER.id);
    const state = stateOf(h);
    expect(state).toMatchObject({ status: 'signed-in', user: { email: EMAIL, name: 'Dana' }, entitlements: PRO, requestId: null, fingerprint: null, keychain: 'persistent' });
    expect(state.version).toBeGreaterThan(before);
    expect(h.service.entitlements()).toEqual(PRO);
    // Confirming twice does nothing more.
    expect(await h.service.confirmSignIn(state.requestId ?? 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(await h.service.signIn(WINDOW)).toBe('already-signed-in');
    expectLogClean(h);
  });

  test('exchange-failures', async () => {
    const h = harness();
    h.api.exchange.mockResolvedValueOnce(fail('invalid'));
    await h.service.signIn(WINDOW);
    h.loops.started[0]!.callback();
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'exchange-failed' });

    h.api.exchange.mockResolvedValueOnce(fail('network'));
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    expect(stateOf(h).error).toBeNull();
    h.loops.started[1]!.callback();
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'network' });

    // A code that is not a desktop code is not even sent.
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.loops.started[2]!.callback({ code: 'x' });
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'exchange-failed' });
    expect(h.api.exchange).toHaveBeenCalledTimes(2);

    // The session names another account than the token: refused, the token revoked.
    h.api.session.mockResolvedValueOnce(ok({ user: { ...USER, id: 'user-2' } }));
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.loops.started[3]!.callback();
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'exchange-failed' });
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);

    // The session cannot be read: the token is revoked.
    h.api.signOut.mockClear();
    h.api.session.mockResolvedValueOnce(fail('network'));
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.loops.started[4]!.callback();
    await h.service.whenIdle();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'network' });
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);

    // The browser could not be opened.
    h.gestures.add(WINDOW);
    (h.deps.openInBrowser as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    expect(await h.service.signIn(WINDOW)).toBe('browser-failed');
    expect(h.loops.started[5]!.loopback.close).toHaveBeenCalled();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'browser-failed' });
    // The listener could not start.
    h.gestures.add(WINDOW);
    h.loops.start.mockRejectedValueOnce(new Error('EADDRINUSE /some/path'));
    expect(await h.service.signIn(WINDOW)).toBe('browser-failed');
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'browser-failed' });
    expect(h.store.write).not.toHaveBeenCalled();
    expectLogClean(h);
    expect(h.log.join('\n')).not.toContain('/some/path');
  });

  test('sign-out-revokes-and-drops-to-free', async () => {
    const h = harness();
    await toSignedIn(h);
    expect(h.service.entitlements()).toEqual(PRO);
    expect(await h.service.signOut()).toBe(true);
    expect(h.api.signOut).toHaveBeenCalledWith(TOKEN);
    expect(h.store.values.has(ACCOUNT_SECRET)).toBe(false);
    expect(h.ents.controller.clear).toHaveBeenCalled();
    expect(stateOf(h)).toMatchObject({ status: 'signed-out', user: null, entitlements: NO_ENTITLEMENTS });
    expect(h.service.entitlements()).toEqual(NO_ENTITLEMENTS);
    expect(await h.service.signOut()).toBe(false);
    // A revocation that fails still signs out locally.
    h.api.signOut.mockResolvedValueOnce(fail('network'));
    await toSignedIn(h);
    expect(await h.service.signOut()).toBe(true);
    expect(stateOf(h).status).toBe('signed-out');
    expectLogClean(h);
  });

  test('stored-account-restores-and-refreshes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = fakeStore(true, { [ACCOUNT_SECRET]: storedAccount() });
    const h = harness({ store });
    expect(stateOf(h)).toMatchObject({ status: 'signed-in', user: { email: EMAIL, name: 'Dana' } });
    await h.service.whenIdle();
    expect(h.api.session).toHaveBeenCalledTimes(1);
    expect(h.api.entitlements).toHaveBeenCalledTimes(1);
    expect(h.ents.controller.update).toHaveBeenCalledWith(SNAPSHOT, USER.id);
    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_INTERVAL_MS);
    await h.service.whenIdle();
    expect(h.api.entitlements).toHaveBeenCalledTimes(2);
    expect(await h.service.refresh()).toBe(true);
    expect(h.api.entitlements).toHaveBeenCalledTimes(3);
    // A renamed account updates what is shown (and stored).
    h.api.session.mockResolvedValueOnce(ok({ user: { ...USER, name: 'Dana R.' } }));
    await h.service.refresh();
    expect(stateOf(h).user).toEqual({ email: EMAIL, name: 'Dana R.' });
    expect(JSON.parse(store.values.get(ACCOUNT_SECRET)!).user.name).toBe('Dana R.');
    h.service.dispose();

    // Expired or malformed stored accounts are dropped, without a call.
    for (const stored of [storedAccount({ expiresAt: 1 }), storedAccount({ token: 'not-a-token' }), storedAccount({ extra: 1 }), 'not json']) {
      const dropped = harness({ store: fakeStore(true, { [ACCOUNT_SECRET]: stored }) });
      expect(stateOf(dropped).status, stored).toBe('signed-out');
      expect(dropped.store.values.has(ACCOUNT_SECRET)).toBe(false);
      await dropped.service.whenIdle();
      expect(dropped.api.session).not.toHaveBeenCalled();
      expectLogClean(dropped);
      dropped.service.dispose();
    }
  });

  test('refresh-401-signs-out', async () => {
    for (const where of ['session', 'entitlements'] as const) {
      const h = harness();
      await toSignedIn(h);
      h.api[where].mockResolvedValueOnce(fail('auth'));
      expect(await h.service.refresh()).toBe(true);
      expect(h.ents.controller.markRefreshFailed).toHaveBeenCalledWith('auth');
      expect(h.store.values.has(ACCOUNT_SECRET)).toBe(false);
      expect(stateOf(h)).toMatchObject({ status: 'signed-out', error: 'session-ended', entitlements: NO_ENTITLEMENTS });
      expect(await h.service.refresh()).toBe(false);
      expectLogClean(h);
    }
  });

  test('refresh-network-keeps-grace', async () => {
    for (const where of ['session', 'entitlements'] as const) {
      const h = harness();
      await toSignedIn(h);
      h.api[where].mockResolvedValueOnce(fail('network'));
      expect(await h.service.refresh()).toBe(true);
      expect(h.ents.controller.markRefreshFailed).toHaveBeenCalledWith('network');
      expect(h.ents.controller.markRefreshFailed).not.toHaveBeenCalledWith('auth');
      expect(stateOf(h)).toMatchObject({ status: 'signed-in', entitlements: PRO, error: null });
      expect(h.store.values.has(ACCOUNT_SECRET)).toBe(true);
    }
  });

  test('refresh-invalid-snapshot-is-free', async () => {
    const h = harness();
    await toSignedIn(h);
    h.api.entitlements.mockResolvedValueOnce(fail('invalid'));
    await h.service.refresh();
    expect(h.ents.controller.markRefreshFailed).toHaveBeenCalledWith('invalid');
    expect(stateOf(h)).toMatchObject({ status: 'signed-in', entitlements: { plan: 'free', status: 'invalid' } });
  });

  test('entitlements-none-unless-signed-in', async () => {
    // A snapshot left behind without an account is cleared at start.
    const ents = fakeEntitlements(PRO);
    const h = harness({ entitlements: ents.controller });
    expect(ents.controller.clear).toHaveBeenCalled();
    expect(h.service.entitlements()).toEqual(NO_ENTITLEMENTS);
    // While confirming, even a controller that holds something answers none.
    await toConfirming(h);
    ents.set(PRO);
    expect(h.service.entitlements()).toEqual(NO_ENTITLEMENTS);
    expect(stateOf(h).entitlements).toEqual(NO_ENTITLEMENTS);
  });

  test('memory-only-keychain-signs-in', async () => {
    const h = harness({ store: fakeStore(false) });
    expect(stateOf(h).keychain).toBe('memory-only');
    await toSignedIn(h);
    expect(stateOf(h)).toMatchObject({ status: 'signed-in', keychain: 'memory-only', entitlements: PRO });
  });

  test('watch-long-polls', async () => {
    const h = harness();
    const v0 = stateOf(h).version;
    await expect(h.service.watch(v0 - 1)).resolves.toMatchObject({ version: v0 });
    const next = h.service.watch(v0);
    let settled = false;
    void next.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await h.service.signIn(WINDOW);
    const answered = await next;
    expect(answered.version).toBeGreaterThan(v0);
    expect(answered.status).toBe('awaiting-browser');
    // Aborting answers the current state.
    const abort = new AbortController();
    const aborted = h.service.watch(answered.version, abort.signal);
    abort.abort();
    await expect(aborted).resolves.toMatchObject({ version: answered.version });
    // Over the cap, the oldest is answered early.
    const waiting = Array.from({ length: MAX_PENDING_ACCOUNT_WATCHES + 1 }, () => h.service.watch(answered.version));
    await expect(waiting[0]).resolves.toMatchObject({ version: answered.version });
    await h.service.cancelSignIn(answered.requestId!);
    for (const w of waiting.slice(1)) expect((await w).version).toBeGreaterThan(answered.version);
  });

  test('logs-carry-no-secret', async () => {
    const h = harness();
    // Every path that logs: a no-gesture try, a replaced request, a failed exchange, a sign-in, a refresh
    // that fails, a sign-out, a 401.
    h.gestures.clear();
    await h.service.signIn(WINDOW);
    await toConfirming(h);
    h.gestures.add(WINDOW);
    await h.service.signIn(WINDOW);
    h.api.exchange.mockResolvedValueOnce(fail('invalid'));
    h.loops.started.at(-1)!.callback();
    await h.service.whenIdle();
    await toSignedIn(h);
    h.api.entitlements.mockResolvedValueOnce(fail('network'));
    await h.service.refresh();
    await h.service.signOut();
    await toSignedIn(h);
    h.api.session.mockResolvedValueOnce(fail('auth'));
    await h.service.refresh();
    expect(h.log.length).toBeGreaterThan(0);
    expectLogClean(h);
    // The redactor also scrubs a secret-shaped value that would reach it some other way.
    const redacting = harness();
    await toSignedIn(redacting);
    const { redact } = await import('../service');
    for (const leaked of [TOKEN, EMAIL, SNAPSHOT, `code=${CODE}&state=abc`]) expect(redact(`x ${leaked} y`)).not.toMatch(/frost_dt_|@|eyJ|codeCODE/);
  });
});
