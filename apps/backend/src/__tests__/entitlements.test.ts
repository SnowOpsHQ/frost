import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { AUTH_SECRET_MIN_LENGTH, ErrorResponseSchema, SESSION_PATH } from '@app/specs/account-api.schema';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_CLAIMS_VERSION,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_KEYS_PATH,
  ENTITLEMENT_TTL_SECONDS,
  ENTITLEMENTS_PATH,
  EntitlementClaimsSchema,
  EntitlementHeaderSchema,
  EntitlementJwksSchema,
  EntitlementsResponseSchema,
  FEATURE_FLAGS,
  PLAN_FEATURES,
  type EntitlementClaims,
  type EntitlementJwks,
} from '@app/specs/entitlements-snapshot.spec';
import { runCli } from '../cli';
import { queryRows } from '../db/client';
import { EntitlementKeyError, generateEntitlementKey, loadEntitlementSigner } from '../entitlements';
import { EnvError, parseEnv } from '../env';
import { createTestBackend, signedInWithPassword, testSigningEnv, TEST_KEY_ID, type TestBackend } from './helpers';

// Acceptance: specs/entitlements.feature.md (Backend).

let backend: TestBackend | undefined;
afterEach(async () => {
  await backend?.close();
  backend = undefined;
});

async function open(overrides?: Parameters<typeof createTestBackend>[0]): Promise<TestBackend> {
  backend = await createTestBackend(overrides);
  return backend;
}

async function jwksOf(b: TestBackend): Promise<EntitlementJwks> {
  const res = await b.request(ENTITLEMENT_KEYS_PATH);
  expect(res.status).toBe(200);
  return EntitlementJwksSchema.parse(await res.json());
}

async function snapshotFor(b: TestBackend, cookie: string): Promise<string> {
  const res = await b.request(ENTITLEMENTS_PATH, { headers: { cookie } });
  expect(res.status).toBe(200);
  return EntitlementsResponseSchema.parse(await res.json()).snapshot;
}

/** Verifies `snapshot` with the backend's published JWKS, as the desktop will. */
async function verified(b: TestBackend, snapshot: string): Promise<EntitlementClaims> {
  const { payload } = await jwtVerify(snapshot, createLocalJWKSet(await jwksOf(b)), {
    algorithms: [ENTITLEMENT_ALG],
    issuer: ENTITLEMENT_ISSUER,
    audience: ENTITLEMENT_AUDIENCE,
    typ: ENTITLEMENT_JWS_TYPE,
  });
  return EntitlementClaimsSchema.parse(payload);
}

async function grant(b: TestBackend, email: string, plan: string): Promise<void> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(['grant', email, plan], { db: b.database.db, out: (t) => out.push(t), err: (t) => err.push(t) });
  if (code !== 0) throw new Error(`grant failed: ${err.join('')}`);
}

async function userId(b: TestBackend, email: string): Promise<string> {
  const rows = await queryRows<{ id: string }>(b.database.db, sql`SELECT id FROM users WHERE email = ${email}`);
  const id = rows[0]?.id;
  if (!id) throw new Error('no such user');
  return id;
}

const VALID_SECRET = 's'.repeat(AUTH_SECRET_MIN_LENGTH);

describe('snapshots', () => {
  it('snapshot-verifies-with-published-key', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const snapshot = await snapshotFor(b, cookie);
    const claims = await verified(b, snapshot);
    expect(claims.email).toBe('alice@example.com');
    // A different key's JWKS does not verify it.
    const other = await generateEntitlementKey(TEST_KEY_ID);
    await expect(compactVerify(snapshot, createLocalJWKSet(other.jwks))).rejects.toThrow();
  });

  it('snapshot-header', async () => {
    const b = await open();
    const snapshot = await snapshotFor(b, await signedInWithPassword(b));
    const header = decodeProtectedHeader(snapshot);
    expect(header).toEqual({ alg: 'EdDSA', kid: TEST_KEY_ID, typ: ENTITLEMENT_JWS_TYPE });
    expect(EntitlementHeaderSchema.parse(header)).toEqual(header);
  });

  it('snapshot-claims', async () => {
    const b = await open();
    const before = Math.floor(Date.now() / 1000);
    const snapshot = await snapshotFor(b, await signedInWithPassword(b));
    const after = Math.ceil(Date.now() / 1000);
    const claims = await verified(b, snapshot);
    expect(claims.iss).toBe(ENTITLEMENT_ISSUER);
    expect(claims.aud).toBe(ENTITLEMENT_AUDIENCE);
    expect(claims.sub).toBe(await userId(b, 'alice@example.com'));
    expect(claims.email).toBe('alice@example.com');
    expect(claims.ver).toBe(ENTITLEMENT_CLAIMS_VERSION);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp - claims.iat).toBe(ENTITLEMENT_TTL_SECONDS);
  });

  it('default-plan-is-free', async () => {
    const b = await open();
    const claims = await verified(b, await snapshotFor(b, await signedInWithPassword(b)));
    expect(claims.plan).toBe('free');
    // frost is free and open source (2026-10-29): the default plan carries every flag.
    expect(claims.features).toEqual([...FEATURE_FLAGS]);
    expect(claims.features).toEqual([...PLAN_FEATURES.free]);
  });

  it('granted-pro-in-next-snapshot', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    await grant(b, 'alice@example.com', 'pro');
    const pro = await verified(b, await snapshotFor(b, cookie));
    expect(pro.plan).toBe('pro');
    expect(pro.features).toEqual([...PLAN_FEATURES.pro]);
    expect(pro.features).toEqual(['ai-agent', 'search-console', 'sync']);
    await grant(b, 'alice@example.com', 'free');
    const free = await verified(b, await snapshotFor(b, cookie));
    expect(free.plan).toBe('free');
    expect(free.features).toEqual(['ai-agent', 'search-console', 'sync']);
  });

  it('entitlements-401-without-credentials', async () => {
    const b = await open();
    for (const headers of [{}, { authorization: 'Bearer not-a-token' }] as Record<string, string>[]) {
      const res = await b.request(ENTITLEMENTS_PATH, { headers });
      expect(res.status).toBe(401);
      expect(ErrorResponseSchema.parse(await res.json())).toEqual({ error: 'unauthorized' });
    }
  });

  it('entitlements-bearer-principal', async () => {
    // Task 3's desktop tokens plug in through `verifyBearer`; this one stands in for them.
    let id = '';
    const b = await open({
      verifyBearer: (token) => Promise.resolve(token === 'desktop-token-1' && id ? { user: { id, email: 'alice@example.com', name: 'Alice' } } : null),
    });
    await signedInWithPassword(b);
    id = await userId(b, 'alice@example.com');
    await grant(b, 'alice@example.com', 'pro');
    const res = await b.request(ENTITLEMENTS_PATH, { headers: { authorization: 'Bearer desktop-token-1' } });
    expect(res.status).toBe(200);
    const claims = await verified(b, EntitlementsResponseSchema.parse(await res.json()).snapshot);
    expect(claims.sub).toBe(id);
    expect(claims.plan).toBe('pro');
    expect((await b.request(ENTITLEMENTS_PATH, { headers: { authorization: 'Bearer desktop-token-2' } })).status).toBe(401);
  });

  it('entitlements-no-store', async () => {
    const b = await open();
    const res = await b.request(ENTITLEMENTS_PATH, { headers: { cookie: await signedInWithPassword(b) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(EntitlementsResponseSchema.safeParse(await res.json()).success).toBe(true);
  });
});

describe('keys', () => {
  it('jwks-publishes-public-keys-only', async () => {
    const old = await generateEntitlementKey('old-key');
    const signingKey = await generateEntitlementKey(TEST_KEY_ID);
    const b = await open({ signingKey, publicKeys: JSON.stringify(old.jwks) });
    expect(b.signingKey).toBe(signingKey);
    const res = await b.request(ENTITLEMENT_KEYS_PATH);
    expect(res.status).toBe(200);
    const text = await res.text();
    const jwks = EntitlementJwksSchema.parse(JSON.parse(text));
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['old-key', TEST_KEY_ID]);
    expect(text).not.toContain('"d"');
    expect(text).not.toContain(signingKey.privateJwk.d);
    expect(text).not.toContain(old.privateJwk.d);
    // The published signing key is the signing key's public half.
    expect(jwks.keys.find((k) => k.kid === TEST_KEY_ID)?.x).toBe(signingKey.privateJwk.x);
  });

  it('private-key-never-in-answers', async () => {
    const b = await open();
    const d = b.signingKey.privateJwk.d;
    const cookie = await signedInWithPassword(b);
    const answers = [
      await b.request(ENTITLEMENT_KEYS_PATH),
      await b.request(ENTITLEMENTS_PATH, { headers: { cookie } }),
      await b.request(ENTITLEMENTS_PATH),
      await b.request(ENTITLEMENTS_PATH, { headers: { authorization: 'Bearer nope' } }),
      await b.request(SESSION_PATH, { headers: { cookie } }),
      await b.request('/v1/nothing-here'),
    ];
    // The 500 path: signing works, but the plan lookup fails; neither the answer nor any log line
    // carries the key.
    await b.database.db.execute(sql.raw('ALTER TABLE entitlements RENAME COLUMN plan TO plan_renamed'));
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
    const failed = await b.request(ENTITLEMENTS_PATH, { headers: { cookie } });
    spy.mockRestore();
    expect(failed.status).toBe(500);
    answers.push(failed);
    expect(`${printed.join('\n')}\n${b.logs.join('\n')}`).not.toContain(d);
    for (const res of answers) {
      const text = await res.text();
      expect(text).not.toContain(d);
      for (const [, value] of res.headers) expect(value).not.toContain(d);
      // The snapshot's header and payload, decoded.
      for (const segment of text.match(/[A-Za-z0-9_-]{20,}/g) ?? []) {
        expect(Buffer.from(segment, 'base64url').toString('latin1')).not.toContain(d);
      }
    }
  });

  it('malformed-signing-key-refused', async () => {
    const { ENTITLEMENT_SIGNING_KEY: good } = testSigningEnv();
    const goodJwk = JSON.parse(good) as Record<string, string>;
    const rsa = JSON.stringify(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }));
    const ec = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));
    const x25519 = JSON.stringify(generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }));
    const { d: _d, ...publicOnly } = goodJwk;
    const cases = [
      'not json at all {',
      rsa,
      ec,
      x25519,
      JSON.stringify(publicOnly),
      JSON.stringify({ ...goodJwk, kid: 'some-other-kid' }),
      JSON.stringify({ ...goodJwk, d: 'short' }),
    ];
    for (const key of cases) {
      let error: unknown;
      try {
        parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET, ENTITLEMENT_SIGNING_KEY: key, ENTITLEMENT_KEY_ID: TEST_KEY_ID });
      } catch (e) {
        error = e;
      }
      expect(error, key.slice(0, 20)).toBeInstanceOf(EnvError);
      const message = (error as Error).message;
      expect(message).toMatch(/ENTITLEMENT_SIGNING_KEY/);
      expect(message).not.toContain(key);
      for (const value of Object.values(JSON.parse(key.startsWith('{') ? key : '{}') as Record<string, string>)) {
        if (typeof value === 'string' && value.length >= 20) expect(message).not.toContain(value);
      }
    }
    expect(() => parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET })).toThrow(/ENTITLEMENT_SIGNING_KEY is required/);
    expect(() => parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET, ENTITLEMENT_SIGNING_KEY: good })).toThrow(/ENTITLEMENT_KEY_ID/);

    // Well-formed, but `d` belongs to another key: the loader refuses it before anything is signed.
    const other = JSON.parse(testSigningEnv().ENTITLEMENT_SIGNING_KEY) as Record<string, string>;
    const mismatched = JSON.stringify({ ...goodJwk, d: other.d });
    expect(() => parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET, ENTITLEMENT_SIGNING_KEY: mismatched, ENTITLEMENT_KEY_ID: TEST_KEY_ID })).not.toThrow();
    const failure = await loadEntitlementSigner({ signingKey: mismatched, keyId: TEST_KEY_ID }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(EntitlementKeyError);
    expect((failure as Error).message).toMatch(/ENTITLEMENT_SIGNING_KEY/);
    expect((failure as Error).message).not.toContain(other.d);
    expect((failure as Error).message).not.toContain(goodJwk.x);
  });

  it('rotation-keys-validated', async () => {
    const env = { BETTER_AUTH_SECRET: VALID_SECRET, ...testSigningEnv() };
    const old = await generateEntitlementKey('old-key');
    const withPrivate = JSON.stringify({ keys: [old.privateJwk] });
    const repeated = JSON.stringify({ keys: [old.jwks.keys[0], old.jwks.keys[0]] });
    const clash = JSON.stringify({ keys: [{ ...old.jwks.keys[0], kid: TEST_KEY_ID }] });
    for (const publicKeys of ['nope', withPrivate, repeated, clash]) {
      let error: unknown;
      try {
        parseEnv({ ...env, ENTITLEMENT_PUBLIC_KEYS: publicKeys });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EnvError);
      expect((error as Error).message).toMatch(/ENTITLEMENT_PUBLIC_KEYS/);
      expect((error as Error).message).not.toContain(old.privateJwk.d);
    }
    expect(parseEnv({ ...env, ENTITLEMENT_PUBLIC_KEYS: JSON.stringify(old.jwks) }).ENTITLEMENT_PUBLIC_KEYS).toBe(JSON.stringify(old.jwks));
  });

  it('entitlements-table-migrated', async () => {
    const b = await open();
    await signedInWithPassword(b);
    const id = await userId(b, 'alice@example.com');
    await grant(b, 'alice@example.com', 'pro');
    const count = async () => (await queryRows<{ n: number }>(b.database.db, sql`SELECT count(*)::int AS n FROM entitlements WHERE user_id = ${id}`))[0]?.n;
    expect(await count()).toBe(1);
    await expect(b.database.db.execute(sql`UPDATE entitlements SET plan = 'gold' WHERE user_id = ${id}`)).rejects.toThrow();
    await b.database.db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    expect(await count()).toBe(0);
  });
});
