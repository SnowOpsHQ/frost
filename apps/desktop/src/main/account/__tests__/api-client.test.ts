// Spec: specs/account-api.schema.ts (DESKTOP_AUTHORIZE_PATH, DESKTOP_TOKEN_PATH, SESSION_PATH, SIGN_OUT_PATH,
// DesktopAuthorizeQuerySchema, DesktopTokenRequestSchema), specs/entitlements-snapshot.spec.ts (ENTITLEMENTS_PATH),
// specs/account-state.schema.ts (ACCOUNT_API_TIMEOUT_MS, ACCOUNT_API_MAX_BODY_BYTES)
// Acceptance: specs/account-signin.feature.md (API client) · plan Global Constraint "Outbound calls"
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_TOKEN_PATH,
  DesktopAuthorizeQuerySchema,
  DesktopTokenRequestSchema,
  SESSION_PATH,
  SIGN_OUT_PATH,
} from '@app/specs/account-api.schema';
import { ACCOUNT_API_MAX_BODY_BYTES, ACCOUNT_API_TIMEOUT_MS } from '@app/specs/account-state.schema';
import { ENTITLEMENTS_PATH } from '@app/specs/entitlements-snapshot.spec';
import { authorizeUrl, createAccountApi, type FetchLike } from '../api-client';

const BASE = 'https://api.example.com';
const TOKEN = `frost_dt_${'T'.repeat(43)}`;
const CODE = 'C'.repeat(43);
const VERIFIER = 'v'.repeat(64);
const REDIRECT = 'http://127.0.0.1:50123/callback';
const USER = { id: 'user-1', email: 'dana@example.com', name: 'Dana' };
const SNAPSHOT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  });
  return { fetch, calls };
}

afterEach(() => vi.useRealTimers());

describe('account api client', () => {
  test('authorize-url-shape', () => {
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const url = new URL(authorizeUrl(BASE, { redirectUri: REDIRECT, state: 'state-0123456789abcdef', challenge }));
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}${DESKTOP_AUTHORIZE_PATH}`);
    expect([...url.searchParams.keys()].sort()).toEqual(['code_challenge', 'code_challenge_method', 'redirect_uri', 'state']);
    expect(DesktopAuthorizeQuerySchema.parse(Object.fromEntries(url.searchParams))).toEqual({
      redirect_uri: REDIRECT,
      state: 'state-0123456789abcdef',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(url.hash).toBe('');
  });

  test('api-requests-omit-credentials', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith(DESKTOP_TOKEN_PATH)) return json(200, { token: TOKEN, expiresAt: 2_000_000_000_000, user: USER });
      if (url.endsWith(SESSION_PATH)) return json(200, { user: USER });
      if (url.endsWith(ENTITLEMENTS_PATH)) return json(200, { snapshot: SNAPSHOT });
      return new Response(null, { status: 204 });
    });
    const api = createAccountApi({ apiBase: BASE, fetch });
    await api.exchange({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT });
    await api.session(TOKEN);
    await api.entitlements(TOKEN);
    await api.signOut(TOKEN);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', `${BASE}${DESKTOP_TOKEN_PATH}`],
      ['GET', `${BASE}${SESSION_PATH}`],
      ['GET', `${BASE}${ENTITLEMENTS_PATH}`],
      ['POST', `${BASE}${SIGN_OUT_PATH}`],
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init.headers).get('cookie')).toBeNull();
    }
    const [exchange, ...bearer] = calls;
    expect(new Headers(exchange!.init.headers).get('authorization')).toBeNull();
    expect(new Headers(exchange!.init.headers).get('content-type')).toBe('application/json');
    expect(DesktopTokenRequestSchema.strict().parse(JSON.parse(String(exchange!.init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    for (const { init, url } of bearer) {
      expect(new Headers(init.headers).get('authorization'), url).toBe(`Bearer ${TOKEN}`);
      expect(init.body ?? null).toBeNull();
    }
    expect(JSON.stringify(calls.map((c) => c.url))).not.toContain(TOKEN);
  });

  test('api-maps-failures', async () => {
    const cases: [string, () => Response | Promise<Response>, 'network' | 'auth' | 'invalid'][] = [
      ['rejected', () => Promise.reject(new TypeError('fetch failed')), 'network'],
      ['408', () => json(408, { error: 'x' }), 'network'],
      ['429', () => json(429, { error: 'rate_limited' }), 'network'],
      ['500', () => json(500, { error: 'internal' }), 'network'],
      ['503', () => json(503, { error: 'unavailable' }), 'network'],
      ['401', () => json(401, { error: 'unauthorized' }), 'auth'],
      ['400', () => json(400, { error: 'invalid_grant' }), 'invalid'],
      ['403', () => json(403, { error: 'forbidden' }), 'invalid'],
      ['302', () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }), 'invalid'],
      ['not json', () => new Response('<html>', { status: 200 }), 'invalid'],
      ['wrong shape', () => json(200, { user: { id: 'x' } }), 'invalid'],
      ['too long', () => new Response(`{"user":${JSON.stringify(USER)},"pad":"${'x'.repeat(ACCOUNT_API_MAX_BODY_BYTES)}"}`, { status: 200 }), 'invalid'],
    ];
    for (const [name, answer, failure] of cases) {
      const api = createAccountApi({ apiBase: BASE, fetch: fakeFetch(answer).fetch });
      expect(await api.session(TOKEN), name).toEqual({ ok: false, failure });
    }
    // The exchange maps its refusals the same way (`invalid_grant` is `invalid`, never `auth`).
    const refused = createAccountApi({ apiBase: BASE, fetch: fakeFetch(() => json(400, { error: 'invalid_grant' })).fetch });
    expect(await refused.exchange({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT })).toEqual({ ok: false, failure: 'invalid' });
  });

  test('api-times-out', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const api = createAccountApi({ apiBase: BASE, fetch });
    const pending = api.entitlements(TOKEN);
    await vi.advanceTimersByTimeAsync(ACCOUNT_API_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, failure: 'network' });
  });

  test('api-validates-answers', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith(DESKTOP_TOKEN_PATH)) return json(200, { token: TOKEN, expiresAt: 2_000_000_000_000, user: { ...USER, extra: 1 }, more: true });
      if (url.endsWith(SESSION_PATH)) return json(200, { user: { ...USER, name: null }, expiresAt: '2026-11-01T00:00:00.000Z' });
      if (url.endsWith(ENTITLEMENTS_PATH)) return json(200, { snapshot: SNAPSHOT, extra: 'x' });
      return new Response(null, { status: 204 });
    });
    const api = createAccountApi({ apiBase: BASE, fetch });
    expect(await api.exchange({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT })).toEqual({ ok: true, value: { token: TOKEN, expiresAt: 2_000_000_000_000, user: USER } });
    expect(await api.session(TOKEN)).toEqual({ ok: true, value: { user: { ...USER, name: null }, expiresAt: '2026-11-01T00:00:00.000Z' } });
    expect(await api.entitlements(TOKEN)).toEqual({ ok: true, value: { snapshot: SNAPSHOT } });
    expect(await api.signOut(TOKEN)).toEqual({ ok: true, value: null });
    // A token that is not a desktop token is not accepted.
    const odd = createAccountApi({ apiBase: BASE, fetch: fakeFetch(() => json(200, { token: 'abc', expiresAt: 1, user: USER })).fetch });
    expect(await odd.exchange({ code: CODE, verifier: VERIFIER, redirectUri: REDIRECT })).toEqual({ ok: false, failure: 'invalid' });
  });
});
