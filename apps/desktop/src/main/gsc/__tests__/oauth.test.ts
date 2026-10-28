// Spec: specs/gsc.spec.ts (GSC_SCOPE, GSC_AUTH_PARAMS, GSC_AUTH_FIXED_PARAMS, GSC_ACCESS_TOKEN_SKEW_MS, GSC_ERRORS),
// specs/account-api.schema.ts (LOOPBACK_REDIRECT_PATTERN), specs/secret-store.spec.ts ('gsc')
// Acceptance: specs/gsc.feature.md (Connection) · review focus "Search Console asks for read-only access only"
// · plan Global Constraints "Tokens stay in main", "Logs never carry secrets", "The system browser opens only …"
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LOOPBACK_REDIRECT_PATTERN } from '@app/specs/account-api.schema';
import { GSC_ACCESS_TOKEN_SKEW_MS, GSC_AUTH_FIXED_PARAMS, GSC_AUTH_PARAMS, GSC_SCOPE } from '@app/specs/gsc.spec';
import { FAKE_GSC_CLIENT_ID, FAKE_GSC_CLIENT_SECRET } from '../../../../e2e/fake-google';
import { challengeOf } from '../../account/pkce';
import { createGscAuth, GSC_SECRET, type GscAuth, type GscAuthDeps } from '../oauth';
import { createHarness, memoryStore, OTHER_WINDOW_ID, WINDOW_ID, type Harness } from './harness';

let h: Harness;
let changes = 0;

beforeEach(async () => {
  h = await createHarness();
  changes = 0;
});
afterEach(async () => {
  await h.close();
});

const authWith = (overrides: Partial<GscAuthDeps> = {}): GscAuth =>
  createGscAuth({
    config: h.config,
    fetch: h.fetch,
    store: h.store,
    startLoopback: h.startLoopback,
    openInBrowser: h.openInBrowser,
    consumeGesture: h.consumeGesture,
    log: h.log,
    remember: () => undefined,
    onChange: () => void changes++,
    now: h.now,
    ...overrides,
  });

async function connect(auth: GscAuth): Promise<void> {
  h.grant();
  expect(await auth.connect(WINDOW_ID)).toBe('started');
  const { callback } = await h.follow();
  expect(callback.status).toBe(303);
  await auth.whenIdle();
}

describe('Search Console connection', () => {
  test('gsc-scope-is-read-only', async () => {
    const auth = authWith();
    h.grant();
    expect(await auth.connect(WINDOW_ID)).toBe('started');
    expect(auth.connecting()).toBe(true);
    expect(h.opened).toHaveLength(1);
    const url = new URL(h.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(h.google.endpoints.authUrl);
    expect([...url.searchParams.keys()].sort()).toEqual([...GSC_AUTH_PARAMS].sort());
    for (const name of GSC_AUTH_PARAMS) expect(url.searchParams.getAll(name), name).toHaveLength(1);
    expect(url.searchParams.get('scope')).toBe(GSC_SCOPE);
    for (const [name, value] of Object.entries(GSC_AUTH_FIXED_PARAMS)) expect(url.searchParams.get(name), name).toBe(value);
    expect(url.searchParams.get('client_id')).toBe(FAKE_GSC_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toMatch(LOOPBACK_REDIRECT_PATTERN);
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
    expect(h.opened[0]).not.toContain(FAKE_GSC_CLIENT_SECRET);
    await h.follow();
    await auth.whenIdle();
    expect(auth.connected()).toBe(true);

    // A grant of anything more than the read-only scope (or no scope at all) is refused and revoked.
    for (const grant of [`${GSC_SCOPE} https://www.googleapis.com/auth/webmasters`, `openid ${GSC_SCOPE}`, 'https://www.googleapis.com/auth/webmasters', '', null]) {
      const store = memoryStore();
      const refused = authWith({ store });
      h.google.grantScope = grant;
      await connect(refused);
      const refresh = h.google.refreshTokens.at(-1)!;
      expect(refused.connected(), String(grant)).toBe(false);
      expect(refused.error()).toBe('scope-refused');
      expect(store.read(GSC_SECRET)).toBeNull();
      await expect.poll(() => h.google.revoked.includes(refresh)).toBe(true);
      expect(await refused.accessToken()).toEqual({ ok: false, failure: 'not-connected' });
    }
  });

  test('connect-without-gesture-opens-nothing', async () => {
    const auth = authWith();
    expect(await auth.connect(WINDOW_ID)).toBe('needs-gesture');
    h.grant();
    expect(await auth.connect(OTHER_WINDOW_ID)).toBe('needs-gesture');
    expect(h.opened).toEqual([]);
    expect(h.loopbacks).toEqual([]);
    expect(h.fetched).toEqual([]);
    expect(h.google.requests).toEqual([]);
    expect(auth.connecting()).toBe(false);
    // The browser opener refuses without a gesture verdict too: the gesture is passed on.
    const refusing = authWith({ openInBrowser: (_url, gesture) => gesture && false });
    h.grant();
    expect(await refusing.connect(WINDOW_ID)).toBe('browser-failed');
    expect(refusing.error()).toBe('browser-failed');
    await h.loopbacks.at(-1)!.closed;
  });

  test('pkce-s256-and-state-checked', async () => {
    const auth = authWith();
    h.grant();
    expect(await auth.connect(WINDOW_ID)).toBe('started');
    const consentUrl = new URL(h.opened[0]!);
    const consent = await fetch(consentUrl, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    const callbackUrl = new URL(consent.headers.get('location')!);
    const forged = new URL(callbackUrl);
    forged.searchParams.set('state', 'forged-state-0123456789abcdef');
    expect((await fetch(forged, { redirect: 'manual' })).status).toBe(400);
    const missing = new URL(callbackUrl);
    missing.searchParams.delete('state');
    expect((await fetch(missing, { redirect: 'manual' })).status).toBe(400);
    expect(h.google.tokenRequests).toEqual([]);
    expect(auth.connecting()).toBe(true);
    expect((await fetch(callbackUrl, { redirect: 'manual' })).status).toBe(303);
    await auth.whenIdle();
    expect(auth.connected()).toBe(true);
    // The fake checked S256(verifier) against the challenge; the verifier went only to the token endpoint.
    const [exchange] = h.google.tokenRequests;
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('code')).toBe(h.google.codes[0]);
    expect(exchange?.get('redirect_uri')).toBe(consentUrl.searchParams.get('redirect_uri'));
    expect(exchange?.get('client_id')).toBe(FAKE_GSC_CLIENT_ID);
    expect(exchange?.get('client_secret')).toBe(FAKE_GSC_CLIENT_SECRET);
    const verifier = exchange?.get('code_verifier') ?? '';
    expect(h.google.verifiers).toEqual([verifier]);
    expect(challengeOf(verifier)).toBe(consentUrl.searchParams.get('code_challenge'));
    expect(h.opened[0]).not.toContain(verifier);
  });

  test('connect-stores-refresh-token-only', async () => {
    const auth = authWith();
    await connect(auth);
    expect(auth.connected()).toBe(true);
    expect(auth.connecting()).toBe(false);
    expect(auth.error()).toBeNull();
    const blob = h.store.read(GSC_SECRET)!;
    expect(JSON.parse(blob)).toEqual({ v: 1, refreshToken: h.google.refreshTokens[0], scope: GSC_SCOPE });
    expect(blob).not.toContain(h.google.accessTokens[0]!);
    // The access token is kept in memory: no new token request.
    expect(await auth.accessToken()).toEqual({ ok: true, token: h.google.accessTokens[0] });
    expect(h.google.tokenRequests).toHaveLength(1);
    expect(changes).toBeGreaterThanOrEqual(2);
    // Connected: another connect is refused without spending a gesture or opening anything.
    h.grant();
    expect(await auth.connect(WINDOW_ID)).toBe('already-connected');
    expect(h.opened).toHaveLength(1);
  });

  test('connect-cancelled-denied-or-replaced', async () => {
    // The browser reports the consent as refused.
    h.google.consentError = 'access_denied';
    const denied = authWith({ store: memoryStore() });
    await connect(denied);
    expect(denied.connected()).toBe(false);
    expect(denied.connecting()).toBe(false);
    expect(denied.error()).toBe('cancelled');
    expect(h.google.tokenRequests).toEqual([]);
    h.google.consentError = null;

    // Cancelled in the app: the listener is closed.
    const cancelled = authWith({ store: memoryStore() });
    h.grant();
    expect(await cancelled.connect(WINDOW_ID)).toBe('started');
    expect(cancelled.cancelConnect()).toBe(true);
    await h.loopbacks.at(-1)!.closed;
    expect(cancelled.connecting()).toBe(false);
    expect(cancelled.error()).toBeNull();
    expect(cancelled.cancelConnect()).toBe(false);

    // Replaced while the first one's code is being exchanged: what that exchange got is revoked.
    const auth = authWith();
    const release = h.hold('token');
    h.grant();
    expect(await auth.connect(WINDOW_ID)).toBe('started');
    const first = h.opened.at(-1)!;
    await h.follow(first);
    h.grant();
    expect(await auth.connect(WINDOW_ID)).toBe('started');
    const second = h.opened.at(-1)!;
    expect(second).not.toBe(first);
    release();
    await auth.whenIdle();
    const late = h.google.refreshTokens.at(-1)!;
    await expect.poll(() => h.google.revoked.includes(late)).toBe(true);
    expect(auth.connected()).toBe(false);
    expect(auth.connecting()).toBe(true);
    await h.follow(second);
    await auth.whenIdle();
    expect(auth.connected()).toBe(true);
    expect(JSON.parse(h.store.read(GSC_SECRET)!).refreshToken).toBe(h.google.refreshTokens.at(-1));
    expect(h.google.refreshTokens.at(-1)).not.toBe(late);
  });

  test('connect-without-refresh-token-fails', async () => {
    h.google.issueRefreshToken = false;
    const auth = authWith();
    await connect(auth);
    expect(auth.connected()).toBe(false);
    expect(auth.error()).toBe('exchange-failed');
    expect(h.store.read(GSC_SECRET)).toBeNull();
    await expect.poll(() => h.google.revoked.includes(h.google.accessTokens[0]!)).toBe(true);
  });

  test('refresh-on-expiry', async () => {
    const auth = authWith();
    await connect(auth);
    const ttlMs = h.google.accessTokenTtlSeconds * 1000;
    h.clock.now += ttlMs - GSC_ACCESS_TOKEN_SKEW_MS - 1;
    expect(await auth.accessToken()).toEqual({ ok: true, token: h.google.accessTokens[0] });
    h.clock.now += 2;
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toEqual({ ok: true, token: h.google.accessTokens[1] });
    expect(b).toEqual(a);
    expect(h.google.tokenRequests).toHaveLength(2);
    const refresh = h.google.tokenRequests[1]!;
    expect(Object.fromEntries(refresh)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: h.google.refreshTokens[0],
      client_id: FAKE_GSC_CLIENT_ID,
      client_secret: FAKE_GSC_CLIENT_SECRET,
    });
    // An access token the API refused is not used again.
    auth.rejectAccessToken(h.google.accessTokens[1]!);
    expect(await auth.accessToken()).toEqual({ ok: true, token: h.google.accessTokens[2] });
    // A refresh that answers another scope ends the connection (and revokes).
    h.google.grantScope = `${GSC_SCOPE} https://www.googleapis.com/auth/webmasters`;
    auth.rejectAccessToken(h.google.accessTokens[2]!);
    expect(await auth.accessToken()).toEqual({ ok: false, failure: 'auth-expired' });
    expect(auth.connected()).toBe(false);
    expect(auth.error()).toBe('scope-refused');
    await expect.poll(() => h.google.revoked.includes(h.google.refreshTokens[0]!)).toBe(true);
  });

  test('refresh-invalid-grant-disconnects', async () => {
    const auth = authWith();
    await connect(auth);
    h.google.revokeRefreshTokens();
    h.clock.now += h.google.accessTokenTtlSeconds * 1000;
    expect(await auth.accessToken()).toEqual({ ok: false, failure: 'auth-expired' });
    expect(auth.connected()).toBe(false);
    expect(auth.error()).toBe('auth-expired');
    expect(h.store.read(GSC_SECRET)).toBeNull();
    expect(await auth.accessToken()).toEqual({ ok: false, failure: 'not-connected' });
    // Unreachable Google is not the end of the connection.
    const store = memoryStore();
    store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: 'stored-refresh-token-1', scope: GSC_SCOPE }));
    const offline = authWith({ fetch: () => Promise.reject(new TypeError('fetch failed')), store });
    expect(await offline.accessToken()).toEqual({ ok: false, failure: 'network' });
    expect(offline.connected()).toBe(true);
    expect(store.read(GSC_SECRET)).not.toBeNull();
  });

  test('disconnect-revokes-and-deletes-blob', async () => {
    const auth = authWith();
    await connect(auth);
    const refresh = h.google.refreshTokens[0]!;
    expect(await auth.disconnect()).toBe(true);
    expect(h.google.revoked).toEqual([refresh]);
    expect(h.store.read(GSC_SECRET)).toBeNull();
    expect(auth.connected()).toBe(false);
    expect(auth.error()).toBeNull();
    expect(await auth.accessToken()).toEqual({ ok: false, failure: 'not-connected' });
    expect(await auth.disconnect()).toBe(false);
    // A revocation that fails still disconnects (best effort).
    const store = memoryStore();
    store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: 'stored-refresh-token-1', scope: GSC_SCOPE }));
    const stored = authWith({ fetch: () => Promise.reject(new TypeError('fetch failed')), store });
    expect(await stored.disconnect()).toBe(true);
    expect(store.read(GSC_SECRET)).toBeNull();
    expect(stored.connected()).toBe(false);
  });

  test('stored-connection-restores', async () => {
    const store = memoryStore();
    store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: 'stored-refresh-token-1', scope: GSC_SCOPE }));
    expect(authWith({ store }).connected()).toBe(true);
    for (const bad of ['not json', '{}', JSON.stringify({ v: 2, refreshToken: 'x', scope: GSC_SCOPE }), JSON.stringify({ v: 1, refreshToken: 'x', scope: 'https://www.googleapis.com/auth/webmasters' }), JSON.stringify({ v: 1, refreshToken: 'x', scope: GSC_SCOPE, accessToken: 'y' })]) {
      const broken = memoryStore();
      broken.write(GSC_SECRET, bad);
      expect(authWith({ store: broken }).connected(), bad).toBe(false);
      expect(broken.read(GSC_SECRET), bad).toBeNull();
    }
  });

  test('logs-carry-no-secret', async () => {
    const auth = authWith();
    await connect(auth);
    h.clock.now += h.google.accessTokenTtlSeconds * 1000;
    expect((await auth.accessToken()).ok).toBe(true);
    h.google.grantScope = `${GSC_SCOPE} openid`;
    const refused = authWith({ store: memoryStore() });
    await connect(refused);
    h.google.grantScope = GSC_SCOPE;
    h.google.revokeRefreshTokens();
    h.clock.now += h.google.accessTokenTtlSeconds * 1000;
    await auth.accessToken();
    const again = authWith({ store: memoryStore() });
    await connect(again);
    await again.disconnect();
    expect(h.logs.length).toBeGreaterThan(3);
    const text = h.logs.join('\n');
    const states = h.google.authRequests.map((q) => q.get('state')!);
    const challenges = h.google.authRequests.map((q) => q.get('code_challenge')!);
    for (const secret of [...h.google.codes, ...h.google.accessTokens, ...h.google.refreshTokens, ...h.google.verifiers, ...states, ...challenges, FAKE_GSC_CLIENT_SECRET]) {
      expect(text).not.toContain(secret);
    }
  });
});
