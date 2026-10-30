// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_ENDPOINTS, CHATGPT_SCOPE, CHATGPT_RESOURCE,
// CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_AGENT_NAME, CHATGPT_REDIRECT_PATH, CHATGPT_REFRESH_MARGIN_MS,
// CHATGPT_REFRESH_FAILURE_CODES, ChatgptAccountView, planUsageOf), specs/agent-chatgpt.schema.ts
// (ChatgptStoredStateSchema, ChatgptTokenAnswerSchema)
// Acceptance: specs/agent-chatgpt.feature.md (Sign-in, Tokens) · plan docs/plans/agent-chatgpt-plan.md, Task 2 and Protocol
import { afterEach, describe, expect, test } from 'vitest';
import { CHATGPT_AGENT_NAME, CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_ENDPOINTS, CHATGPT_REFRESH_FAILURE_CODES, CHATGPT_REFRESH_MARGIN_MS, CHATGPT_RESOURCE, CHATGPT_SCOPE } from '@app/specs/agent-chatgpt.spec';
import { challengeOf } from '../../../account/pkce';
import { CHATGPT_LIMITS } from '@app/specs/agent-chatgpt.spec';
import { createChatgptStore } from '../store';
import { CLIENT_ID, createHarness, CREDENTIALS_FILE, EMAIL, HOST_UUID, KEY, OTHER_KEY, SUB, T0 } from './harness';

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
function setup(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.auth.dispose();
    await h.close();
  }
});

const tokenRequests = (h: Harness) => h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.token);

/** A signed-in harness (first registration done). */
async function signedIn(options: Parameters<typeof createHarness>[0] = {}) {
  const h = setup(options);
  const view = await h.signIn();
  expect(view.state).toBe('signed-in');
  return h;
}

/** Everything a test can see that came out of the service: views, results, logs. */
function outward(h: Harness, ...more: unknown[]): string {
  return JSON.stringify([h.auth.view(), h.logs, ...more]);
}

describe('chatgpt sign-in', () => {
  test('chatgpt-authorize-url (first registration)', async () => {
    const h = setup();
    expect(await h.auth.signIn()).toBe('started');
    expect(h.auth.view()).toEqual({ state: 'pending', acknowledged: false });
    const url = new URL(h.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(CHATGPT_ENDPOINTS.authorize);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(q.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME);
    expect(q.get('ext_agent_host_id')).toBe(`urn:uuid:${HOST_UUID}`);
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.get('scope')).toBe(CHATGPT_SCOPE);
    expect(q.get('resource')).toBe(CHATGPT_RESOURCE);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('nonce')).not.toBe(q.get('state'));
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.has('prompt')).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test('chatgpt-authorize-url (returning and re-consent)', async () => {
    const h = await signedIn();
    expect(await h.auth.signIn({ reconsent: true })).toBe('started');
    const q = new URL(h.opened.at(-1)!).searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('ext_agent_host_id')).toBe(`urn:uuid:${HOST_UUID}`);
    // A fresh state, nonce and challenge for each attempt.
    const first = new URL(h.opened[0]!).searchParams;
    for (const name of ['state', 'nonce', 'code_challenge']) expect(q.get(name), name).not.toBe(first.get(name));
  });

  test('chatgpt-host-id-persisted-before-sign-in', async () => {
    const h = setup();
    await h.auth.signIn();
    expect(h.events.indexOf('host-id')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('host-id')).toBeLessThan(h.events.indexOf('browser'));
    expect(JSON.parse(h.memory.text('/user-data/agent-chatgpt-host.json')!)).toEqual({ v: 1, hostId: `urn:uuid:${HOST_UUID}` });
    expect(h.memory.files.get('/user-data/agent-chatgpt-host.json')!.mode).toBe(0o600);
    expect(h.memory.ops).toContain('write /user-data/agent-chatgpt-host.json.host.tmp 600 wx flush');
  });

  test('chatgpt-first-registration-persists-client-id-before-exchange', async () => {
    const h = setup();
    const view = await h.signIn();
    expect(view).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: false });
    const stored = h.events.indexOf(`store ${CLIENT_ID} no-tokens`);
    const exchange = h.events.indexOf('token authorization_code');
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(stored).toBeLessThan(exchange);
    const form = tokenRequests(h)[0]!.form!;
    expect(form.get('client_id')).toBe(CLIENT_ID);
    const state = await h.realStore.read();
    expect(state).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB, email: EMAIL }, expired: false });
  });

  test('chatgpt-code-exchange', async () => {
    const h = setup();
    await h.signIn();
    const authorize = new URL(h.opened[0]!).searchParams;
    const [exchange] = tokenRequests(h);
    expect(exchange!.method).toBe('POST');
    expect(exchange!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect([...exchange!.form!.keys()].sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource']);
    expect(exchange!.form!.get('grant_type')).toBe('authorization_code');
    expect(exchange!.form!.get('code')).toBe('auth-code-0123456789');
    expect(exchange!.form!.get('redirect_uri')).toBe(authorize.get('redirect_uri'));
    expect(exchange!.form!.get('resource')).toBe(CHATGPT_RESOURCE);
    expect(challengeOf(exchange!.form!.get('code_verifier')!)).toBe(authorize.get('code_challenge'));
    // Every request: no redirects, no cookies, no cache.
    for (const r of h.recorded) {
      expect(r.init.redirect, r.url).toBe('error');
      expect(r.init.credentials, r.url).toBe('omit');
      expect(r.init.cache, r.url).toBe('no-store');
      expect(Object.values(CHATGPT_ENDPOINTS)).toContain(r.url);
    }
  });

  test('chatgpt-missing-client-id-fails', async () => {
    const h = setup();
    for (const clientId of [null, CHATGPT_DYNAMIC_CLIENT_ID, 'bad client']) {
      const view = await h.signIn({ client_id: clientId });
      expect(view, String(clientId)).toEqual({ state: 'signed-out', acknowledged: false, error: 'registration-incomplete' });
    }
    expect(tokenRequests(h)).toHaveLength(0);
    expect(await h.realStore.read()).toBeNull();
  });

  test('chatgpt-returning-client-mismatch-fails', async () => {
    const h = await signedIn();
    await h.auth.signOut();
    const view = await h.signIn({ client_id: 'oaiapp_SomeoneElse' });
    expect(view).toMatchObject({ state: 'signed-out', error: 'client-mismatch' });
    expect(tokenRequests(h)).toHaveLength(1);
    // A returning redirect may name no client: the saved one is used.
    expect(await h.signIn({ client_id: null })).toMatchObject({ state: 'signed-in' });
    expect(tokenRequests(h).at(-1)!.form!.get('client_id')).toBe(CLIENT_ID);
  });

  test('chatgpt-state-mismatch-fails', async () => {
    const h = setup();
    await h.auth.signIn();
    for (const state of ['wrong-state', null, '']) expect(await h.redirect({ state }), String(state)).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.auth.view().state).toBe('pending');
    // The right one still works.
    expect(await h.redirect()).toBe(303);
    await h.until(() => h.auth.view().state === 'signed-in');
  });

  test('chatgpt-declined-in-browser', async () => {
    const h = setup();
    await h.auth.signIn();
    expect(await h.redirect({ code: null, client_id: null, scope: null, error: 'access_denied' })).toBe(303);
    await h.until(() => h.auth.view().state !== 'pending');
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'declined' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['bad signature', { key: OTHER_KEY }],
    ['issuer', { claims: { iss: 'https://auth.example.com' } }],
    ['audience', { claims: { aud: ['oaiapp_Other'] } }],
    ['audience list without azp', { claims: { aud: [CLIENT_ID, 'oaiapp_Other'] } }],
    ['azp', { claims: { azp: 'oaiapp_Other' } }],
    ['nonce', { claims: { nonce: 'another-nonce' } }],
    ['expired', { claims: { exp: Math.floor(T0 / 1000) - 600 } }],
    ['not yet valid', { claims: { nbf: Math.floor(T0 / 1000) + 600 } }],
    ['issued in the future', { claims: { iat: Math.floor(T0 / 1000) + 600 } }],
    ['no subject', { claims: { sub: '' } }],
  ] as const)('chatgpt-id-token-checks (%s)', async (_name, change) => {
    const h = setup();
    if ('key' in change) h.server.key = change.key;
    if ('claims' in change) h.server.claims = change.claims;
    // The JWKS serves the trusted key whatever key signed the token.
    h.server.jwks = () => ({ keys: [KEY.jwk] });
    const view = await h.signIn();
    expect(view).toEqual({ state: 'signed-out', acknowledged: false, error: 'id-token' });
    // Nothing kept but the client id, and the new refresh token is revoked.
    const stored = await h.realStore.read();
    expect(stored).toMatchObject({ clientId: CLIENT_ID, account: null, tokens: null });
    await h.until(() => h.events.includes('revoke'), 'the revocation');
    const revoke = h.recorded.find((r) => r.url === CHATGPT_ENDPOINTS.revoke)!;
    expect(revoke.form!.get('token')).toBe('refresh-token-1');
    expect(await h.auth.withAccessToken(() => 'used')).toEqual({ ok: false, reason: 'signed-out' });
  });

  test('chatgpt-id-token-checks (an unknown key id fetches the keys again, rate-limited)', async () => {
    const h = setup();
    let served = 0;
    // The first document lacks the signing key (a rotation the cache hasn't seen).
    h.server.jwks = () => (served++ === 0 ? { keys: [OTHER_KEY.jwk] } : { keys: [OTHER_KEY.jwk, KEY.jwk] });
    expect(await h.signIn()).toMatchObject({ state: 'signed-out', error: 'id-token' });
    expect(await h.signIn()).toMatchObject({ state: 'signed-out', error: 'id-token' });
    expect(h.events.filter((e) => e === 'jwks')).toHaveLength(1);
    h.clock.now += CHATGPT_LIMITS.jwksRefetchMs;
    expect(await h.signIn()).toMatchObject({ state: 'signed-in' });
    expect(h.events.filter((e) => e === 'jwks')).toHaveLength(2);
  });

  test('chatgpt-account-mismatch', async () => {
    const h = await signedIn();
    await h.auth.signOut();
    h.server.claims = { sub: 'another-user' };
    const view = await h.signIn();
    expect(view).toMatchObject({ state: 'signed-out', error: 'account-mismatch' });
    expect((await h.realStore.read()) as object).toMatchObject({ account: { sub: SUB }, tokens: null });
  });

  test('chatgpt-use-different-account (signs out, revokes, forgets the registration, registers fresh)', async () => {
    const h = await signedIn();
    expect(await h.auth.acknowledge()).toBe(true);
    h.server.claims = { sub: 'another-user', email: 'grace@example.com', aud: ['oaiapp_OtherClient-42'] };
    expect(await h.auth.signIn({ differentAccount: true, userGesture: true })).toBe('started');
    // The held refresh token was revoked before the browser opened; the registration is forgotten.
    expect(h.events.slice(h.events.lastIndexOf('revoke'))).toContain('browser');
    expect(h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke).map((r) => r.form!.get('token'))).toEqual(['refresh-token-1']);
    const url = new URL(h.opened.at(-1)!);
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(url.searchParams.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME);
    expect(url.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${HOST_UUID}`);
    expect(h.auth.view()).toMatchObject({ state: 'pending', acknowledged: false });
    // The new account signs in as a first registration: no account mismatch.
    expect(await h.redirect({ client_id: 'oaiapp_OtherClient-42' })).toBe(303);
    await h.until(() => h.auth.view().state !== 'pending');
    expect(h.auth.view()).toEqual({ state: 'signed-in', email: 'grace@example.com', planUsage: 'on', acknowledged: false });
    expect((await h.realStore.read()) as object).toMatchObject({ clientId: 'oaiapp_OtherClient-42', account: { sub: 'another-user' } });
    expect(h.gestures.at(-1)).toBe(true);
  });

  test('chatgpt-use-different-account (from an account mismatch; refused without a keychain or while unreadable)', async () => {
    const h = await signedIn();
    await h.auth.signOut();
    h.server.claims = { sub: 'another-user' };
    expect(await h.signIn()).toMatchObject({ state: 'signed-out', error: 'account-mismatch' });
    h.server.claims = { sub: 'another-user', aud: ['oaiapp_OtherClient-42'] };
    expect(await h.signIn({ client_id: 'oaiapp_OtherClient-42' }, { differentAccount: true })).toMatchObject({ state: 'signed-in', planUsage: 'on' });
    expect((await h.realStore.read()) as object).toMatchObject({ account: { sub: 'another-user' } });
    const weak = setup({ protection: 'weak' });
    expect(await weak.auth.signIn({ differentAccount: true })).toBe('no-keychain');
    expect(weak.events).not.toContain('revoke');
  });

  test('chatgpt-use-different-account (not revoked: stops, forgets nothing, the next try revokes again)', async () => {
    const h = await signedIn();
    expect(await h.auth.acknowledge()).toBe(true);
    const opened = h.opened.length;
    // Every revocation attempt fails: the switch stops before anything is forgotten or opened.
    h.server.revokeStatus = [503];
    expect(await h.auth.signIn({ differentAccount: true, userGesture: true })).toBe('not-revoked');
    expect(h.events.filter((e) => e === 'revoke')).toHaveLength(CHATGPT_LIMITS.revokeAttempts);
    expect(h.opened).toHaveLength(opened);
    expect(h.auth.view()).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: true });
    expect((await h.realStore.read()) as object).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB }, tokens: { refreshToken: 'refresh-token-1' }, acknowledged: true });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-1' });
    // Tried again once ChatGPT answers: the same refresh token is revoked, then the switch goes on.
    h.server.revokeStatus = [200];
    expect(await h.auth.signIn({ differentAccount: true, userGesture: true })).toBe('started');
    expect(new Set(h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke).map((r) => r.form!.get('token')))).toEqual(new Set(['refresh-token-1']));
    expect(new URL(h.opened.at(-1)!).searchParams.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(h.auth.view()).toMatchObject({ state: 'pending', acknowledged: false });
  });

  test('chatgpt-sign-in-focuses-window (a successful sign-in brings its window to the front)', async () => {
    const h = setup();
    // Declined in the browser: nothing is focused.
    expect(await h.auth.signIn({ windowId: 7 })).toBe('started');
    expect(await h.redirect({ code: null, client_id: null, scope: null, error: 'access_denied' })).toBe(303);
    await h.until(() => h.auth.view().state !== 'pending');
    // Cancelled: nothing either.
    expect(await h.auth.signIn({ windowId: 7 })).toBe('started');
    h.auth.cancel();
    expect(h.focused).toEqual([]);
    expect(await h.signIn({}, { windowId: 7 })).toMatchObject({ state: 'signed-in' });
    expect(h.focused).toEqual([7]);
    // No window named (a sign-in main started itself): nothing to focus.
    await h.auth.signOut();
    expect(await h.signIn({ client_id: null })).toMatchObject({ state: 'signed-in' });
    expect(h.focused).toEqual([7]);
  });

  test('chatgpt-sign-in-gesture (the browser opener is told whether a user gesture backs the sign-in)', async () => {
    const h = setup();
    expect(await h.auth.signIn()).toBe('started');
    expect(h.gestures).toEqual([false]);
    h.auth.cancel();
    expect(await h.auth.signIn({ userGesture: true })).toBe('started');
    expect(h.gestures).toEqual([false, true]);
  });

  test('chatgpt-plan-usage-from-granted-scope', async () => {
    const h = setup();
    h.server.scope = 'openid profile email offline_access resource.invoke';
    const view = await h.signIn();
    expect(view).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'declined', acknowledged: false });
    let called = false;
    expect(await h.auth.withAccessToken(() => (called = true))).toEqual({ ok: false, reason: 'plan-usage-off' });
    expect(called).toBe(false);
    expect(await h.auth.listModels()).toEqual({ ok: false, reason: 'plan-usage-off' });
    // Re-consent grants it.
    h.server.scope = CHATGPT_SCOPE;
    expect(await h.signIn({}, { reconsent: true })).toMatchObject({ state: 'signed-in', planUsage: 'on' });
    expect(new URL(h.opened.at(-1)!).searchParams.get('prompt')).toBe('consent');
  });

  test('chatgpt-plan-usage-from-granted-scope (the token answer decides, not the redirect)', async () => {
    const h = setup();
    h.server.scope = 'openid email offline_access';
    expect(await h.signIn({ scope: CHATGPT_SCOPE })).toMatchObject({ planUsage: 'declined' });
  });

  test('chatgpt-no-keychain', async () => {
    for (const protection of ['weak', 'unavailable'] as const) {
      const h = setup({ protection });
      expect(await h.auth.signIn()).toBe('no-keychain');
      expect(h.opened).toEqual([]);
      expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'no-keychain' });
    }
  });

  test('chatgpt-cancel', async () => {
    const h = setup();
    await h.auth.signIn();
    expect(h.auth.cancel()).toBe(true);
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'cancelled' });
    expect(h.auth.cancel()).toBe(false);
    await expect(h.redirect()).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test('chatgpt-cancel (cancelled while the sign-in is being stored: not kept, the new refresh token revoked)', async () => {
    const h = await signedIn();
    await h.auth.signOut();
    const previous = await h.realStore.read();
    expect(previous).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB }, tokens: null });
    // The new sign-in's write is held until the cancel has gone through.
    const write = h.store.write;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    h.store.write = async (state) => {
      if (!held && state.tokens?.refreshToken === 'refresh-token-2') {
        held = true;
        await gate;
      }
      return write(state);
    };
    expect(await h.auth.signIn({ windowId: 7 })).toBe('started');
    expect(await h.redirect({ client_id: null })).toBe(303);
    await h.until(() => held, 'the sign-in to be stored');
    expect(h.auth.cancel()).toBe(true);
    release();
    await h.auth.dispose();
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'cancelled' });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'signed-out' });
    expect(await h.realStore.read()).toEqual(previous);
    expect(h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke).map((r) => r.form!.get('token'))).toEqual(['refresh-token-1', 'refresh-token-2']);
    expect(h.focused).toEqual([]);
  });

  /** Holds the write storing `refreshToken` until released; writes stay in call order, like the real store's queue. */
  function holdWriteOf(h: Harness, refreshToken: string) {
    const write = h.store.write;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    let queue: Promise<unknown> = Promise.resolve();
    h.store.write = (state) => {
      const run = queue.then(async () => {
        if (!held && state.tokens?.refreshToken === refreshToken) {
          held = true;
          await gate;
        }
        return write(state);
      });
      queue = run.catch(() => undefined);
      return run;
    };
    return { held: () => held, release };
  }

  const revokedTokens = (h: Harness) => new Set(h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke).map((r) => r.form!.get('token')));

  test('chatgpt-cancel (signed out while the sign-in is being stored: stays signed out, both refresh tokens revoked)', async () => {
    const h = await signedIn();
    const hold = holdWriteOf(h, 'refresh-token-2');
    expect(await h.auth.signIn({ windowId: 7 })).toBe('started');
    expect(await h.redirect({ client_id: null })).toBe(303);
    await h.until(hold.held, 'the sign-in to be stored');
    const out = h.auth.signOut();
    await h.until(() => revokedTokens(h).has('refresh-token-2'), 'the sign-out to revoke the new refresh token');
    hold.release();
    expect(await out).toBe('signed-out');
    await h.auth.dispose();
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'signed-out' });
    expect((await h.realStore.read()) as object).toMatchObject({ tokens: null });
    expect(revokedTokens(h)).toEqual(new Set(['refresh-token-1', 'refresh-token-2']));
    expect(h.focused).toEqual([]);
  });

  test('chatgpt-cancel ("Use a different account" while the sign-in is being stored: the previous account is not restored)', async () => {
    const h = await signedIn();
    const hold = holdWriteOf(h, 'refresh-token-2');
    expect(await h.auth.signIn()).toBe('started');
    expect(await h.redirect({ client_id: null })).toBe(303);
    await h.until(hold.held, 'the sign-in to be stored');
    const switching = h.auth.signIn({ differentAccount: true });
    await h.until(() => revokedTokens(h).has('refresh-token-2'), 'the switch to revoke the new refresh token');
    hold.release();
    expect(await switching).toBe('started');
    expect(h.auth.view()).toMatchObject({ state: 'pending' });
    expect(new URL(h.opened.at(-1)!).searchParams.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    await h.auth.dispose();
    expect((await h.realStore.read()) as object).toMatchObject({ clientId: null, account: null, tokens: null });
    expect(revokedTokens(h)).toEqual(new Set(['refresh-token-1', 'refresh-token-2']));
  });

  test('chatgpt-exchange-refused', async () => {
    const h = setup();
    h.server.token = () => h.json(400, { error: 'invalid_grant' });
    expect(await h.signIn()).toMatchObject({ state: 'signed-out', error: 'exchange-failed' });
    h.server.token = () => {
      throw new TypeError('offline');
    };
    expect(await h.signIn()).toMatchObject({ state: 'signed-out', error: 'network' });
  });
});

describe('chatgpt tokens', () => {
  test('chatgpt-refresh-margin-and-earliest', async () => {
    const h = await signedIn();
    const use = () => h.auth.withAccessToken((token) => token);
    expect(await use()).toEqual({ ok: true, value: 'access-token-1' });
    h.clock.now = T0 + 3600_000 - CHATGPT_REFRESH_MARGIN_MS - 1;
    expect(await use()).toEqual({ ok: true, value: 'access-token-1' });
    expect(tokenRequests(h)).toHaveLength(1);
    h.clock.now = T0 + 3600_000 - CHATGPT_REFRESH_MARGIN_MS;
    expect(await use()).toEqual({ ok: true, value: 'access-token-2' });
    const refresh = tokenRequests(h)[1]!.form!;
    expect([...refresh.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token', 'resource']);
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('client_id')).toBe(CLIENT_ID);
    expect(refresh.get('refresh_token')).toBe('refresh-token-1');
    expect(refresh.get('resource')).toBe(CHATGPT_RESOURCE);
  });

  test('chatgpt-refresh-margin-and-earliest (not before earliest_refresh_at)', async () => {
    const h = setup();
    h.server.earliestRefreshAt = Math.floor((T0 + 1800_000) / 1000);
    await h.signIn();
    const use = (rejected?: string) => h.auth.withAccessToken((token) => token, rejected === undefined ? {} : { rejected });
    // A 401 before the earliest time: no refresh, and the refused token isn't handed out again.
    h.clock.now = T0 + 1000_000;
    expect(await use('access-token-1')).toEqual({ ok: false, reason: 'failed' });
    expect(await use()).toEqual({ ok: true, value: 'access-token-1' });
    expect(tokenRequests(h)).toHaveLength(1);
    h.clock.now = T0 + 1800_000;
    expect(await use('access-token-1')).toEqual({ ok: true, value: 'access-token-2' });
  });

  test('chatgpt-refresh-on-rejected-token', async () => {
    const h = await signedIn();
    expect(await h.auth.withAccessToken((token) => token, { rejected: 'access-token-1' })).toEqual({ ok: true, value: 'access-token-2' });
    // A stale rejection (the token already changed) doesn't refresh again.
    expect(await h.auth.withAccessToken((token) => token, { rejected: 'access-token-1' })).toEqual({ ok: true, value: 'access-token-2' });
    expect(tokenRequests(h)).toHaveLength(2);
  });

  test('chatgpt-refresh-coalesces', async () => {
    const h = await signedIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.server.token = async () => {
      await gate;
      return h.tokenAnswer(false);
    };
    h.clock.now = T0 + 3600_000;
    const calls = Array.from({ length: 5 }, () => h.auth.withAccessToken((token) => token));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await Promise.all(calls);
    expect(new Set(results.map((r) => (r.ok ? r.value : r.reason)))).toEqual(new Set(['access-token-2']));
    expect(tokenRequests(h)).toHaveLength(2);
  });

  test('chatgpt-rotation-persisted', async () => {
    const h = await signedIn();
    h.clock.now = T0 + 3600_000;
    const seen: unknown[] = [];
    const result = await h.auth.withAccessToken(async (token) => {
      // When the new access token is handed out, the replacement refresh token is already stored.
      seen.push(token, ((await h.realStore.read()) as { tokens: { refreshToken: string } }).tokens.refreshToken);
      return token;
    });
    expect(result).toEqual({ ok: true, value: 'access-token-2' });
    expect(seen).toEqual(['access-token-2', 'refresh-token-2']);
    h.clock.now = T0 + 2 * 3600_000;
    await h.auth.withAccessToken((token) => token);
    expect(tokenRequests(h)[2]!.form!.get('refresh_token')).toBe('refresh-token-2');
  });

  test('chatgpt-rotation-persisted (survives a restart)', async () => {
    const h = await signedIn();
    h.clock.now = T0 + 3600_000;
    await h.auth.withAccessToken((token) => token);
    const { createChatgptAuth } = await import('../service');
    const again = createChatgptAuth({ ...h.deps, store: h.realStore });
    await again.load();
    expect(again.view()).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: false });
    expect(await again.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-2' });
  });

  test.each(CHATGPT_REFRESH_FAILURE_CODES)('chatgpt-refresh-failure-codes-expire (%s)', async (code) => {
    const h = await signedIn();
    h.server.token = () => h.json(400, { error: code, error_description: 'no' });
    h.clock.now = T0 + 3600_000;
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'expired' });
    expect(h.auth.view()).toEqual({ state: 'expired', email: EMAIL, acknowledged: false });
    const stored = await h.realStore.read();
    expect(stored).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB }, tokens: null, expired: true });
    expect(h.memory.text('/user-data/agent-chatgpt-host.json')).not.toBeNull();
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'expired' });
    // Signing in again reuses the saved client id.
    h.server.token = null;
    expect(await h.signIn({ client_id: null })).toMatchObject({ state: 'signed-in' });
    expect(new URL(h.opened.at(-1)!).searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  test('chatgpt-refresh-failure-codes-expire (network and 5xx keep the tokens)', async () => {
    const h = await signedIn();
    h.clock.now = T0 + 3600_000;
    h.server.token = () => {
      throw new TypeError('offline');
    };
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'network' });
    // Each retried after the back-off (CHATGPT_LIMITS.refreshBackoffMs).
    h.clock.now += CHATGPT_LIMITS.refreshBackoffMs;
    h.server.token = () => h.json(503, { error: 'temporarily_unavailable' });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'network' });
    h.clock.now += CHATGPT_LIMITS.refreshBackoffMs;
    h.server.token = () => h.json(400, { error: 'invalid_client' });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'failed' });
    expect(h.auth.view().state).toBe('signed-in');
    h.clock.now += CHATGPT_LIMITS.refreshBackoffMs;
    h.server.token = null;
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-2' });
  });

  test('chatgpt-refresh-id-token-must-keep-the-account', async () => {
    const h = await signedIn();
    h.clock.now = T0 + 3600_000;
    h.server.token = () => h.tokenAnswer(false, { id_token: h.idToken({ sub: 'another-user', nonce: undefined }) });
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'expired' });
    expect(h.auth.view().state).toBe('expired');
  });

  test('chatgpt-sign-out-revokes-then-forgets', async () => {
    const h = await signedIn();
    await h.auth.acknowledge();
    expect(await h.auth.signOut()).toBe('signed-out');
    const revoke = h.recorded.find((r) => r.url === CHATGPT_ENDPOINTS.revoke)!;
    expect([...revoke.form!.entries()]).toEqual([
      ['token', 'refresh-token-1'],
      ['token_type_hint', 'refresh_token'],
      ['client_id', CLIENT_ID],
    ]);
    expect(h.events.indexOf('revoke')).toBeLessThan(h.events.indexOf(`store ${CLIENT_ID} no-tokens`, h.events.indexOf('revoke')));
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: true });
    expect(await h.realStore.read()).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB }, tokens: null, expired: false, acknowledged: true });
    expect(JSON.parse(h.memory.text('/user-data/agent-chatgpt-host.json')!).hostId).toBe(`urn:uuid:${HOST_UUID}`);
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'signed-out' });
    expect(h.memory.text('/user-data/agent-chatgpt-credentials.json')).not.toContain('refresh-token-1');
  });

  test('chatgpt-sign-out-revokes-then-forgets (unconfirmed)', async () => {
    const h = await signedIn();
    h.server.revokeStatus = [0, 503, 500];
    expect(await h.auth.signOut()).toBe('not-revoked');
    expect(h.events.filter((e) => e === 'revoke')).toHaveLength(3);
    expect(h.auth.view().state).toBe('signed-out');
    expect(await h.realStore.read()).toMatchObject({ tokens: null });
  });

  test('chatgpt-sign-out-revokes-then-forgets (retries, then confirmed)', async () => {
    const h = await signedIn();
    h.server.revokeStatus = [503, 200];
    expect(await h.auth.signOut()).toBe('signed-out');
    expect(h.events.filter((e) => e === 'revoke')).toHaveLength(2);
  });

  test('chatgpt-sign-out-waits-for-a-refresh-in-flight', async () => {
    const h = await signedIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.server.token = async () => {
      await gate;
      return h.tokenAnswer(false);
    };
    h.clock.now = T0 + 3600_000;
    const using = h.auth.withAccessToken((token) => token);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const out = h.auth.signOut();
    release();
    await using;
    expect(await out).toBe('signed-out');
    // The rotated token is the one revoked.
    expect(h.recorded.find((r) => r.url === CHATGPT_ENDPOINTS.revoke)!.form!.get('token')).toBe('refresh-token-2');
  });

  test('chatgpt-models', async () => {
    const h = await signedIn();
    h.server.models = {
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-6.1-mini', display_name: ' GPT-6.1 mini ', visibility: 'list', extra: true },
        { slug: '../evil', display_name: 'Evil', visibility: 'list' },
        { slug: 'gpt-6.1-sol', display_name: 'Duplicate', visibility: 'list' },
        { slug: 'blank', display_name: '   ', visibility: 'list' },
        { slug: 'bidi', display_name: 'a\u202eb', visibility: 'list' },
        'not an object',
      ],
    };
    expect(await h.auth.listModels()).toEqual({
      ok: true,
      models: [
        { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
        { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini' },
      ],
    });
    const request = h.recorded.find((r) => r.url === CHATGPT_ENDPOINTS.models)!;
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBe('Bearer access-token-1');
    expect(Object.keys(request.headers).sort()).toEqual(['accept', 'authorization']);
  });

  test('chatgpt-models-large-list', async () => {
    const h = await signedIn();
    // Per-model metadata pushes a live list past the auth answers' bound.
    const padding = 'x'.repeat(CHATGPT_LIMITS.maxResponseBytes);
    h.server.models = { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', base_instructions: padding }] };
    expect(await h.auth.listModels()).toEqual({ ok: true, models: [{ id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' }] });
    // Past its own bound, the list is still refused.
    h.server.models = { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', base_instructions: 'x'.repeat(CHATGPT_LIMITS.maxModelListBytes) }] };
    expect(await h.auth.listModels()).toEqual({ ok: false, reason: 'failed' });
  });

  test('chatgpt-models (a 401 refreshes once and asks again)', async () => {
    const h = await signedIn();
    h.server.modelsStatus = [401, 401];
    expect(await h.auth.listModels()).toEqual({ ok: false, reason: 'failed' });
    const asked = h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.models).map((r) => r.headers.authorization);
    expect(asked).toEqual(['Bearer access-token-1', 'Bearer access-token-2']);
    expect(tokenRequests(h)).toHaveLength(2);
  });

  test('chatgpt-acknowledge', async () => {
    const h = await signedIn();
    expect(h.auth.view().acknowledged).toBe(false);
    expect(await h.auth.acknowledge()).toBe(true);
    expect(h.auth.view().acknowledged).toBe(true);
    expect(await h.realStore.read()).toMatchObject({ acknowledged: true });
  });

  test('chatgpt-no-token-in-any-view', async () => {
    const h = await signedIn();
    const results: unknown[] = [h.auth.view()];
    h.clock.now = T0 + 3600_000;
    results.push(await h.auth.withAccessToken(() => 'ran'));
    h.server.models = { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] };
    results.push(await h.auth.listModels(), await h.auth.signOut(), h.auth.view());
    const exchange = tokenRequests(h)[0]!.form!;
    const secrets = ['access-token-1', 'access-token-2', 'refresh-token-1', 'refresh-token-2', 'auth-code-0123456789', exchange.get('code_verifier')!, h.nonce(), CLIENT_ID, SUB, HOST_UUID];
    // Every ID token issued, too.
    secrets.push(...h.idTokens);
    expect(h.idTokens.length).toBeGreaterThan(0);
    const text = outward(h, results);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    // At rest: nothing in plaintext.
    const file = h.memory.text('/user-data/agent-chatgpt-credentials.json')!;
    for (const secret of ['refresh-token', 'access-token', CLIENT_ID, SUB, EMAIL]) expect(file).not.toContain(secret);
  });
});

describe('chatgpt security review (Tasks 1–2)', () => {
  test('chatgpt-id-token-checks (no nonce at sign-in)', async () => {
    const h = setup();
    h.server.claims = { nonce: undefined };
    expect(await h.signIn()).toEqual({ state: 'signed-out', acknowledged: false, error: 'id-token' });
  });

  test('chatgpt-id-token-clock-skew (a sign-in tolerates a clock minutes off)', async () => {
    const h = setup();
    h.server.claims = { iat: Math.floor(T0 / 1000) + 240 };
    expect(await h.signIn()).toMatchObject({ state: 'signed-in' });
  });

  test('chatgpt-refresh-id-token-time-only (new tokens and the last verified identity kept)', async () => {
    for (const claims of [{ iat: Math.floor((T0 + 3600_000) / 1000) + 3600 }, { exp: Math.floor(T0 / 1000) }, { nbf: Math.floor((T0 + 3600_000) / 1000) + 3600 }]) {
      const h = await signedIn();
      const before = ((await h.realStore.read()) as { tokens: { idToken: string } }).tokens.idToken;
      h.clock.now = T0 + 3600_000;
      h.server.token = () => h.tokenAnswer(false, { id_token: h.idToken({ nonce: undefined, ...claims }) });
      expect(await h.auth.withAccessToken((token) => token), JSON.stringify(claims)).toEqual({ ok: true, value: 'access-token-2' });
      expect(h.auth.view()).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: false });
      const stored = (await h.realStore.read()) as { tokens: { refreshToken: string; idToken: string }; account: { sub: string } };
      expect(stored.tokens.refreshToken).toBe('refresh-token-2');
      expect(stored.tokens.idToken).toBe(before);
      expect(stored.account.sub).toBe(SUB);
      expect(h.events).not.toContain('revoke');
    }
  });

  test('chatgpt-reconsent-revokes-the-previous-refresh-token', async () => {
    const h = await signedIn();
    expect(await h.signIn({ client_id: null }, { reconsent: true })).toMatchObject({ state: 'signed-in', planUsage: 'on' });
    await h.until(() => h.events.includes('revoke'), 'the revocation');
    const revokes = h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke);
    expect(revokes.map((r) => r.form!.get('token'))).toEqual(['refresh-token-1']);
    // Revoked only once the replacement is stored.
    expect(h.events.indexOf(`store ${CLIENT_ID} refresh-token-2`)).toBeLessThan(h.events.indexOf('revoke'));
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-2' });
  });

  test('chatgpt-no-sign-in-while-signing-out', async () => {
    const h = await signedIn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, init) => {
      if (url === CHATGPT_ENDPOINTS.revoke) await gate;
      return original(url, init);
    });
    const out = h.auth.signOut();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const opened = h.opened.length;
    expect(await h.auth.signIn()).toBe('failed');
    expect(h.opened).toHaveLength(opened);
    release();
    expect(await out).toBe('signed-out');
    expect(h.auth.view().state).toBe('signed-out');
    expect(await h.realStore.read()).toMatchObject({ tokens: null });
    // Once signed out, a sign-in starts again.
    expect(await h.auth.signIn()).toBe('started');
  });

  test("chatgpt-store-unreadable (a saved sign-in that can't be read is never overwritten)", async () => {
    const h = setup();
    expect(await h.realStore.write({ v: 1, clientId: CLIENT_ID, account: { sub: SUB, email: EMAIL }, tokens: null, expired: true, acknowledged: true })).toBe(true);
    const saved = h.memory.text('/user-data/agent-chatgpt-credentials.json');
    const read = h.store.read;
    h.store.read = async () => 'failed';
    await h.auth.load();
    expect(h.auth.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'store-unreadable' });
    expect(await h.auth.signIn()).toBe('failed');
    expect(h.opened).toEqual([]);
    expect(await h.auth.acknowledge()).toBe(false);
    expect(await h.auth.signOut()).toBe('signed-out');
    expect(h.memory.text('/user-data/agent-chatgpt-credentials.json')).toBe(saved);
    expect(h.events.filter((e) => e.startsWith('store '))).toEqual([]);
    // Readable again (the keychain unlocked): the next sign-in reads it and goes on from it.
    h.store.read = read;
    expect(await h.auth.signIn()).toBe('started');
    expect(new URL(h.opened[0]!).searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(h.auth.view()).toEqual({ state: 'pending', acknowledged: true });
  });

  test("chatgpt-store-unreadable (a saved sign-in the keychain can't open yet is never registered over)", async () => {
    const h = await signedIn();
    const saved = h.memory.text(CREDENTIALS_FILE);
    // A restart with no OS keychain available yet (the record is on disk).
    h.safe.state.available = false;
    const { createChatgptAuth } = await import('../service');
    const store = createChatgptStore({ safeStorage: h.safe.storage, fs: h.memory.fs, file: CREDENTIALS_FILE, platform: 'linux', tempSuffix: () => 'restart' });
    const again = createChatgptAuth({ ...h.deps, store });
    await again.load();
    expect(again.view()).toEqual({ state: 'signed-out', acknowledged: false, error: 'store-unreadable' });
    const opened = h.opened.length;
    expect(await again.signIn()).toBe('failed');
    expect(await again.acknowledge()).toBe(false);
    expect(h.opened).toHaveLength(opened);
    expect(h.memory.text(CREDENTIALS_FILE)).toBe(saved);
    // The keychain is back: the sign-in reads the record first and goes on from it.
    h.safe.state.available = true;
    expect(await again.signIn()).toBe('started');
    const url = new URL(h.opened.at(-1)!);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.has('agent_name_hint')).toBe(false);
    expect(await h.redirect({ client_id: null })).toBe(303);
    await h.until(() => again.view().state !== 'pending', 'the sign-in to finish');
    await again.dispose();
    expect(again.view()).toEqual({ state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: false });
    expect(await store.read()).toMatchObject({ clientId: CLIENT_ID, account: { sub: SUB }, tokens: { refreshToken: 'refresh-token-2' } });
    // The replaced refresh token is not left alive.
    expect(h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.revoke).map((r) => r.form!.get('token'))).toEqual(['refresh-token-1']);
  });

  test('chatgpt-refresh-backoff (a failed refresh is not retried on every request)', async () => {
    const offline = () => {
      throw new TypeError('offline');
    };
    // Expired: failing, without a refresh request per call until the back-off has passed.
    const h = await signedIn();
    h.server.token = offline;
    h.clock.now = T0 + 3600_000;
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'network' });
    expect(tokenRequests(h)).toHaveLength(2);
    for (let i = 0; i < 3; i++) expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: false, reason: 'network' });
    h.clock.now += CHATGPT_LIMITS.refreshBackoffMs - 1;
    expect(await h.auth.withAccessToken((token) => token, { rejected: 'access-token-1' })).toEqual({ ok: false, reason: 'network' });
    expect(tokenRequests(h)).toHaveLength(2);
    h.clock.now += 1;
    h.server.token = null;
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-2' });
    expect(tokenRequests(h)).toHaveLength(3);

    // Due but still valid: the current token while it lasts (never one the server just refused).
    const v = await signedIn();
    v.server.token = offline;
    v.clock.now = T0 + 3600_000 - 30_000;
    expect(await v.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-1' });
    for (let i = 0; i < 3; i++) expect(await v.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-1' });
    expect(await v.auth.withAccessToken((token) => token, { rejected: 'access-token-1' })).toEqual({ ok: false, reason: 'network' });
    expect(tokenRequests(v)).toHaveLength(2);
  });

  test('chatgpt-refresh-margin-and-earliest (earliest_refresh_at past expiry is clamped)', async () => {
    const h = setup();
    h.server.earliestRefreshAt = Math.floor((T0 + 2 * 3600_000) / 1000);
    await h.signIn();
    h.clock.now = T0 + 3600_000 - CHATGPT_REFRESH_MARGIN_MS;
    expect(await h.auth.withAccessToken((token) => token)).toEqual({ ok: true, value: 'access-token-2' });
  });

  test('chatgpt-plan-usage-from-granted-scope (no scope in the token answer: declined)', async () => {
    const h = setup();
    h.server.scope = undefined;
    expect(await h.signIn({ scope: CHATGPT_SCOPE })).toMatchObject({ state: 'signed-in', planUsage: 'declined' });
  });
});
