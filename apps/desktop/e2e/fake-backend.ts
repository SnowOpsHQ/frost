// Test-only: an in-process stand-in for the account backend's desktop surface (`specs/account-api.schema.ts`,
// Desktop authorization; `specs/entitlements-snapshot.spec.ts`), on 127.0.0.1. Its signing key is an
// ephemeral Ed25519 key made per run; nothing is ever committed. `/desktop/authorize` signs nobody in:
// it answers 303 to the loopback at once with a fresh code (the browser and its sign-in pages are not
// what these tests are about).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import {
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_TOKEN_PATH,
  DesktopAuthorizeQuerySchema,
  DesktopTokenRequestSchema,
  SESSION_PATH,
  SIGN_OUT_PATH,
  type AccountUser,
} from '@app/specs/account-api.schema';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_CLAIMS_VERSION,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_KEY_CURVE,
  ENTITLEMENT_TTL_SECONDS,
  ENTITLEMENTS_PATH,
  PLAN_FEATURES,
  type EntitlementJwks,
} from '@app/specs/entitlements-snapshot.spec';

/**
 * - `ok`: answers like the backend.
 * - `down`: session and entitlements answer 503 (a network failure to the desktop).
 * - `tampered`: entitlements answer a snapshot whose payload was changed after signing.
 */
export type FakeBackendMode = 'ok' | 'down' | 'tampered';

export interface FakeBackend {
  readonly origin: string;
  /** The public keys (`FROST_PUBLIC_ENTITLEMENT_JWKS`). */
  readonly jwks: EntitlementJwks;
  readonly user: AccountUser;
  mode: FakeBackendMode;
  /** Every code and token handed out, and every token revoked, in order. */
  readonly codes: string[];
  readonly tokens: string[];
  readonly revoked: string[];
  /** The authorize requests' `code_challenge`s, in order. */
  readonly challenges: string[];
  close(): Promise<void>;
}

const DAY_MS = 86_400_000;
const b64url = (value: string) => Buffer.from(value).toString('base64url');

export async function startFakeBackend(user: AccountUser = { id: 'user-e2e-1', email: 'dana@example.com', name: 'Dana' }): Promise<FakeBackend> {
  const kid = 'e2e-key-1';
  const { privateKey, publicKey } = await generateKeyPair(ENTITLEMENT_ALG, { crv: ENTITLEMENT_KEY_CURVE, extractable: true });
  const { x } = await exportJWK(publicKey);
  if (typeof x !== 'string') throw new Error('fake backend: no public key');
  const jwks: EntitlementJwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' }] };

  /** Pending codes: their challenge and redirect. */
  const pendingCodes = new Map<string, { challenge: string; redirectUri: string }>();
  const live = new Set<string>();

  const snapshot = async (): Promise<string> => {
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ENTITLEMENT_ISSUER,
      aud: ENTITLEMENT_AUDIENCE,
      sub: user.id,
      email: user.email,
      plan: 'pro',
      features: [...PLAN_FEATURES.pro],
      iat,
      exp: iat + ENTITLEMENT_TTL_SECONDS,
      ver: ENTITLEMENT_CLAIMS_VERSION,
    };
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({ alg: ENTITLEMENT_ALG, kid, typ: ENTITLEMENT_JWS_TYPE }).sign(privateKey);
    if (backend.mode !== 'tampered') return jws;
    const [header, , signature] = jws.split('.');
    return `${header}.${b64url(JSON.stringify({ ...claims, exp: claims.exp + 365 * 86_400 }))}.${signature}`;
  };

  const bearer = (req: IncomingMessage): string | null => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match?.[1] ?? null;
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
      req.on('error', reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === DESKTOP_AUTHORIZE_PATH) {
      const query = DesktopAuthorizeQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return void res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
      const code = randomBytes(32).toString('base64url');
      pendingCodes.set(code, { challenge: query.data.code_challenge, redirectUri: query.data.redirect_uri });
      backend.codes.push(code);
      backend.challenges.push(query.data.code_challenge);
      const location = `${query.data.redirect_uri}?${new URLSearchParams({ code, state: query.data.state }).toString()}`;
      return void res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }).end();
    }
    if (req.method === 'POST' && url.pathname === DESKTOP_TOKEN_PATH) {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: 'invalid_request' });
      }
      const parsed = DesktopTokenRequestSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: 'invalid_request' });
      const pending = pendingCodes.get(parsed.data.code);
      pendingCodes.delete(parsed.data.code);
      const challenge = createHash('sha256').update(parsed.data.code_verifier, 'ascii').digest('base64url');
      if (!pending || pending.redirectUri !== parsed.data.redirect_uri || pending.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
      const token = `frost_dt_${randomBytes(32).toString('base64url')}`;
      live.add(token);
      backend.tokens.push(token);
      return json(res, 200, { token, expiresAt: Date.now() + 30 * DAY_MS, user });
    }
    if (req.method === 'POST' && url.pathname === SIGN_OUT_PATH) {
      const token = bearer(req);
      if (!token) return json(res, 401, { error: 'unauthorized' });
      live.delete(token);
      backend.revoked.push(token);
      return void res.writeHead(204).end();
    }
    if (req.method === 'GET' && (url.pathname === SESSION_PATH || url.pathname === ENTITLEMENTS_PATH)) {
      if (backend.mode === 'down') return json(res, 503, { error: 'unavailable' });
      const token = bearer(req);
      if (!token || !live.has(token)) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === SESSION_PATH) return json(res, 200, { user });
      return json(res, 200, { snapshot: await snapshot() });
    }
    json(res, 404, { error: 'not_found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const backend: FakeBackend = {
    origin: `http://127.0.0.1:${port}`,
    jwks,
    user,
    mode: 'ok',
    codes: [],
    tokens: [],
    revoked: [],
    challenges: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return backend;
}
