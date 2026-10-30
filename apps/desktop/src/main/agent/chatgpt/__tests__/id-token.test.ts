// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_ISSUER, CHATGPT_ID_TOKEN_ALG, CHATGPT_LIMITS.clockSkewMs,
// CHATGPT_LIMITS.jwksRefetchMs, CHATGPT_LIMITS.jwksTtlMs, CHATGPT_LIMITS.maxJwksKeys),
// specs/agent-chatgpt.schema.ts (ChatgptIdTokenHeaderSchema, ChatgptIdTokenClaimsSchema, ChatgptJwkSchema)
// Acceptance: specs/agent-chatgpt.feature.md (ID token) · plan docs/plans/agent-chatgpt-plan.md, Protocol
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CHATGPT_ISSUER, CHATGPT_LIMITS } from '@app/specs/agent-chatgpt.spec';
import { createJwks, verifyIdToken, type IdTokenExpectation } from '../id-token';
import { CLIENT_ID, KEY, makeKey, OTHER_KEY, signJwt, SUB, T0, type SigningKey } from './harness';

const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
const NONCE = 'nonce-0123456789';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwksServer(initial: () => unknown) {
  const clock = { now: T0 };
  const server = { document: initial, fetches: 0, fail: false };
  const jwks = createJwks({
    url: JWKS_URL,
    now: () => clock.now,
    fetch: async (url) => {
      expect(url).toBe(JWKS_URL);
      server.fetches += 1;
      if (server.fail) throw new TypeError('offline');
      return new Response(JSON.stringify(server.document()), { status: 200 });
    },
  });
  return { jwks, clock, server };
}

const claims = (extra: Record<string, unknown> = {}) => ({ iss: CHATGPT_ISSUER, sub: SUB, aud: CLIENT_ID, nonce: NONCE, iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600, ...extra });
const expect_ = (now = T0, nonce: string | null = NONCE): IdTokenExpectation => ({ issuer: CHATGPT_ISSUER, clientId: CLIENT_ID, nonce, now });

describe('chatgpt ID token', () => {
  test('chatgpt-id-token-alg (none and HS256 are refused)', async () => {
    const { jwks, server } = jwksServer(() => ({ keys: [KEY.jwk] }));
    const payload = b64(claims());
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`;
    // `none` with an empty signature, and with a real RS256 signature under a lying header.
    expect(await verifyIdToken(none, expect_(), jwks)).toEqual({ ok: false, failure: 'malformed' });
    expect(await verifyIdToken(signJwt(claims(), KEY, { alg: 'none', kid: KEY.kid }), expect_(), jwks)).toEqual({ ok: false, failure: 'malformed' });
    // HS256 keyed with the public key's modulus (the classic confusion): refused before any key is used.
    const head = `${b64({ alg: 'HS256', kid: KEY.kid })}.${payload}`;
    const { createHmac } = await import('node:crypto');
    const hs = `${head}.${createHmac('sha256', String(KEY.jwk.n)).update(head).digest('base64url')}`;
    expect(await verifyIdToken(hs, expect_(), jwks)).toEqual({ ok: false, failure: 'malformed' });
    expect(server.fetches).toBe(0);
    // The real thing passes.
    expect(await verifyIdToken(signJwt(claims()), expect_(), jwks)).toMatchObject({ ok: true, claims: { sub: SUB } });
  });

  test('chatgpt-id-token-clock-skew (exp, iat and nbf within CHATGPT_LIMITS.clockSkewMs)', async () => {
    expect(CHATGPT_LIMITS.clockSkewMs).toBe(300_000);
    const { jwks } = jwksServer(() => ({ keys: [KEY.jwk] }));
    const t = Math.floor(T0 / 1000);
    const ok = async (extra: Record<string, unknown>) => (await verifyIdToken(signJwt(claims(extra)), expect_(), jwks)).ok;
    // A clock four minutes off either way is fine.
    expect(await ok({ iat: t + 240 })).toBe(true);
    expect(await ok({ exp: t - 240 })).toBe(true);
    expect(await ok({ nbf: t + 240 })).toBe(true);
    // Past the skew: refused on time.
    expect(await verifyIdToken(signJwt(claims({ iat: t + 360 })), expect_(), jwks)).toEqual({ ok: false, failure: 'not-yet-valid' });
    expect(await verifyIdToken(signJwt(claims({ nbf: t + 360 })), expect_(), jwks)).toEqual({ ok: false, failure: 'not-yet-valid' });
    expect(await verifyIdToken(signJwt(claims({ exp: t - 360 })), expect_(), jwks)).toEqual({ ok: false, failure: 'expired' });
  });

  test('chatgpt-id-token-nonce (a sign-in needs the attempt nonce; a missing one is refused)', async () => {
    const { jwks } = jwksServer(() => ({ keys: [KEY.jwk] }));
    expect(await verifyIdToken(signJwt(claims({ nonce: undefined })), expect_(), jwks)).toEqual({ ok: false, failure: 'nonce' });
    expect(await verifyIdToken(signJwt(claims({ nonce: '' })), expect_(), jwks)).toEqual({ ok: false, failure: 'nonce' });
    // A refresh's ID token is checked without one.
    expect((await verifyIdToken(signJwt(claims({ nonce: undefined })), expect_(T0, null), jwks)).ok).toBe(true);
  });

  test('chatgpt-jwks-unknown-kid (fetched again, at most once a jwksRefetchMs)', async () => {
    const rotated = makeKey('key-3');
    let keys = [KEY.jwk];
    const { jwks, clock, server } = jwksServer(() => ({ keys }));
    expect((await verifyIdToken(signJwt(claims()), expect_(), jwks)).ok).toBe(true);
    expect(server.fetches).toBe(1);
    // A token naming a key the cache doesn't have: one refetch, then none within the window.
    const token = signJwt(claims(), rotated);
    expect(await verifyIdToken(token, expect_(clock.now + 1), jwks)).toEqual({ ok: false, failure: 'signature' });
    expect(server.fetches).toBe(1);
    clock.now += CHATGPT_LIMITS.jwksRefetchMs;
    expect(await verifyIdToken(token, expect_(clock.now), jwks)).toEqual({ ok: false, failure: 'signature' });
    expect(server.fetches).toBe(2);
    for (let i = 0; i < 5; i++) await verifyIdToken(token, expect_(clock.now), jwks);
    expect(server.fetches).toBe(2);
    // The issuer publishes it: accepted after the next window.
    keys = [KEY.jwk, rotated.jwk];
    clock.now += CHATGPT_LIMITS.jwksRefetchMs;
    expect((await verifyIdToken(signJwt(claims({ iat: Math.floor(clock.now / 1000), exp: Math.floor(clock.now / 1000) + 3600 }), rotated), expect_(clock.now), jwks)).ok).toBe(true);
    expect(server.fetches).toBe(3);
  });

  test('chatgpt-jwks-ttl (a fetched document is trusted for jwksTtlMs, then fetched again)', async () => {
    let keys: unknown[] = [KEY.jwk];
    const { jwks, clock, server } = jwksServer(() => ({ keys }));
    const at = (ms: number) => signJwt(claims({ iat: Math.floor(ms / 1000), exp: Math.floor(ms / 1000) + 3600 }));
    expect((await verifyIdToken(at(clock.now), expect_(clock.now), jwks)).ok).toBe(true);
    // The issuer rotates KEY out; within the TTL the cache still has it.
    keys = [OTHER_KEY.jwk];
    clock.now = T0 + CHATGPT_LIMITS.jwksTtlMs - 1;
    expect((await verifyIdToken(at(clock.now), expect_(clock.now), jwks)).ok).toBe(true);
    expect(server.fetches).toBe(1);
    // Past it, the document is fetched again and the rotated-out key is no longer accepted.
    clock.now = T0 + CHATGPT_LIMITS.jwksTtlMs;
    expect(await verifyIdToken(at(clock.now), expect_(clock.now), jwks)).toEqual({ ok: false, failure: 'signature' });
    expect(server.fetches).toBe(2);
    // A stale document that can't be fetched again is not used.
    keys = [KEY.jwk];
    clock.now += CHATGPT_LIMITS.jwksTtlMs;
    server.fail = true;
    expect(await verifyIdToken(at(clock.now), expect_(clock.now), jwks)).toEqual({ ok: false, failure: 'keys-unavailable' });
    // ...and a failed fetch is not retried on every token.
    await verifyIdToken(at(clock.now), expect_(clock.now), jwks);
    expect(server.fetches).toBe(3);
  });

  test('chatgpt-jwks-key-filter (encryption keys, weak keys and other types are skipped)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const weak: SigningKey = { kid: 'weak', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'weak', use: 'sig', alg: 'RS256' } };
    const enc = { ...KEY.jwk, use: 'enc' };
    const { jwks } = jwksServer(() => ({ keys: [enc, weak.jwk, { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'AA', y: 'AA' }, { ...OTHER_KEY.jwk, alg: 'RS512' }] }));
    // KEY is published only for encryption: its signatures are not accepted.
    expect(await verifyIdToken(signJwt(claims(), KEY), expect_(), jwks)).toEqual({ ok: false, failure: 'signature' });
    expect(await verifyIdToken(signJwt(claims(), weak), expect_(), jwks)).toEqual({ ok: false, failure: 'signature' });
    expect(await verifyIdToken(signJwt(claims(), OTHER_KEY), expect_(), jwks)).toEqual({ ok: false, failure: 'signature' });
    // A well-formed RS256 signature over the same bytes with a 1024-bit key is still refused.
    const head = `${b64({ alg: 'RS256', kid: 'weak' })}.${b64(claims())}`;
    expect(await verifyIdToken(`${head}.${sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`, expect_(), jwks)).toEqual({ ok: false, failure: 'signature' });
  });
});
