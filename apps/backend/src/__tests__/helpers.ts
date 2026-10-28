import { generateKeyPairSync } from 'node:crypto';
import { AUTH_BASE_PATH, AUTH_ROUTES } from '@app/specs/account-api.schema';
import { createAppParts, type AppDeps } from '../app';
import { openMemoryDatabase, type DatabaseHandle } from '../db/client';
import { migrate } from '../db/migrate';
import { createMemoryTransport, type MemoryTransport } from '../email';
import { generateEntitlementKey, loadEntitlementSigner, type GeneratedEntitlementKey } from '../entitlements';

export const BASE_URL = 'http://127.0.0.1:8787';
export const TEST_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
/** The TCP peer every test request comes from, unless it sets `TEST_PEER_HEADER`. */
export const DEFAULT_PEER = '203.0.113.10';
export const TEST_KEY_ID = 'test-key-1';

/**
 * A freshly generated Ed25519 private JWK (JSON) and its `kid`, as the environment carries them.
 * Synchronous (node:crypto), for `parseEnv` tests; generated at run time, never committed.
 */
export function testSigningEnv(kid = TEST_KEY_ID): { ENTITLEMENT_SIGNING_KEY: string; ENTITLEMENT_KEY_ID: string } {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  return { ENTITLEMENT_SIGNING_KEY: JSON.stringify({ ...jwk, kid }), ENTITLEMENT_KEY_ID: kid };
}
/** Test-only stand-in for the socket address (the real server reads the socket). */
export const TEST_PEER_HEADER = 'x-test-peer';

type Parts = ReturnType<typeof createAppParts>;

export interface TestBackend {
  readonly app: Parts['app'];
  readonly auth: Parts['auth'];
  readonly resolvers: Parts['resolvers'];
  readonly email: MemoryTransport;
  readonly database: DatabaseHandle;
  /** The ephemeral entitlement signing key this backend was built with (private JWK included). */
  readonly signingKey: GeneratedEntitlementKey;
  /** better-auth's (redacted) log lines. */
  readonly logs: string[];
  /** `app.request` against the configured base URL, with a same-origin `Origin` on writes. */
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** A backend on a fresh in-memory PGlite with every migration applied and a memory email transport. */
export async function createTestBackend(overrides: Partial<Pick<AppDeps, 'verifyBearer' | 'healthTimeoutMs' | 'entitlementSigner'>> = {}): Promise<TestBackend> {
  const database = await openMemoryDatabase();
  await migrate(database.db);
  const email = createMemoryTransport();
  const signingKey = await generateEntitlementKey(TEST_KEY_ID);
  const entitlementSigner = await loadEntitlementSigner({ signingKey: signingKey.privateJwkJson, keyId: signingKey.kid });
  const logs: string[] = [];
  const { app, auth, resolvers } = createAppParts({
    db: database.db,
    auth: { secret: TEST_SECRET, baseURL: BASE_URL },
    email,
    clientIp: { kind: 'peer', address: (c) => c.req.header(TEST_PEER_HEADER) ?? DEFAULT_PEER },
    logSink: (line) => logs.push(line),
    entitlementSigner,
    ...overrides,
  });
  let closed = false;
  return {
    app,
    auth,
    resolvers,
    email,
    database,
    signingKey,
    logs,
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      const method = (init.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && !headers.has('origin')) headers.set('origin', BASE_URL);
      return Promise.resolve(app.request(new URL(path, BASE_URL).toString(), { ...init, headers }));
    },
    async close() {
      if (closed) return;
      closed = true;
      await database.close();
    },
  };
}

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/** The `Cookie` header a browser would send back after `res` (expired/cleared cookies dropped). */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((line) => !/max-age=0\b/i.test(line))
    .map((line) => line.split(';', 1)[0] ?? '')
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ');
}

/** The first http(s) URL in a message body. */
export function linkIn(text: string): string {
  const match = /https?:\/\/[^\s"'<>]+/.exec(text);
  if (!match) throw new Error('no link in message');
  return match[0];
}

export const PASSWORD = 'correct horse battery staple';

export const authPath = (route: keyof typeof AUTH_ROUTES): string => `${AUTH_BASE_PATH}${AUTH_ROUTES[route]}`;

export function signUp(b: TestBackend, email = 'alice@example.com', name = 'Alice', password = PASSWORD): Promise<Response> {
  return b.request(authPath('signUpEmail'), jsonPost({ email, password, name }));
}

/** Follows the newest verification link sent to `email`. */
export async function verifyEmail(b: TestBackend, email: string): Promise<void> {
  const verification = b.email.messages.filter((m) => m.to === email && m.text.includes(AUTH_ROUTES.verifyEmail)).at(-1);
  if (!verification) throw new Error('no verification email');
  const verified = await b.request(linkIn(verification.text));
  if (verified.status >= 400) throw new Error(`verification failed: ${verified.status}`);
}

/** Sign up, follow the verification link, sign in with the password; answers the session cookie. */
export async function signedInWithPassword(b: TestBackend, email = 'alice@example.com'): Promise<string> {
  const res = await signUp(b, email);
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  await verifyEmail(b, email);
  const signIn = await b.request(authPath('signInEmail'), jsonPost({ email, password: PASSWORD }));
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status}`);
  const cookie = cookieFrom(signIn);
  if (cookie === '') throw new Error('no session cookie');
  return cookie;
}
