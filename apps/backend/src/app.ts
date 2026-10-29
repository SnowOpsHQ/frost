import { sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import {
  AUTH_BASE_PATH,
  AUTH_ENDPOINT_METHODS,
  DESKTOP_TOKEN_PATH,
  HEALTH_PATH,
  SESSION_PATH,
  SessionResponseSchema,
  type AccountApiError,
  type ErrorResponse,
  type HealthResponse,
} from '@app/specs/account-api.schema';
import { ENTITLEMENT_KEYS_PATH, ENTITLEMENTS_PATH, EntitlementsResponseSchema } from '@app/specs/entitlements-snapshot.spec';
import { createAuth, type AuthConfig } from './auth';
import { stampClientIp } from './client-ip';
import type { Database } from './db/client';
import { desktopTokenVerifier, registerDesktopAuth } from './desktop-auth';
import type { EmailTransport } from './email';
import { issueSnapshot, planFor, type EntitlementSigner } from './entitlements';
import type { LogSink } from './log';
import { bearerResolver, requirePrincipal, webSessionResolver, type BearerVerifier, type PrincipalEnv, type PrincipalResolver } from './principal';
import { createMemoryRateLimitStorage, type RateLimitStorage } from './rate-limit';

// The backend's HTTP app (spec `account-backend.feature.md`). Everything it needs comes in `deps`,
// so tests build one per case on an in-memory database and drive it with `app.request()`.

/**
 * Where a request's client IP comes from (rate limiting). `peer`: the TCP peer address, as the
 * server reads it from the socket (`server.ts`); `header`: a header set by a trusted reverse proxy.
 */
export type ClientIpSource =
  | { readonly kind: 'peer'; readonly address: (c: Context) => string | undefined }
  | { readonly kind: 'header'; readonly header: string; readonly trustedProxies?: readonly string[] | undefined };

export interface AppDeps {
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly email: EmailTransport;
  readonly clientIp: ClientIpSource;
  /** Signs entitlement snapshots (`loadEntitlementSigner`); its public JWKS is published. */
  readonly entitlementSigner: EntitlementSigner;
  /** Bearer tokens. Default: the desktop tokens in `desktop_tokens` (`desktopTokenVerifier`). Tests may stand in their own. */
  readonly verifyBearer?: BearerVerifier | undefined;
  /** Rate-limit counters for better-auth and the desktop endpoints; one in-memory store per app by default. */
  readonly rateLimitStorage?: RateLimitStorage | undefined;
  /** The clock for desktop codes and tokens (tests move it); `new Date()` by default. */
  readonly now?: (() => Date) | undefined;
  readonly logSink?: LogSink | undefined;
  /** How long `/healthz` waits for the database (default 3 s). */
  readonly healthTimeoutMs?: number | undefined;
}

export type AppEnv = PrincipalEnv;

const errorBody = (error: AccountApiError): ErrorResponse => ({ error });

/** better-auth JSON answers that carry the session token (the cookie already has it): `token` removed. */
async function withoutSessionToken(res: Response): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, res);
  }
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    delete record.token;
    const session = record.session;
    if (session !== null && typeof session === 'object') delete (session as Record<string, unknown>).token;
  }
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref());
}

/** The app with the pieces later routes and tests reuse: better-auth and the principal resolvers. */
/** The browser pages of desktop sign-in: everything under `/desktop/` except the JSON exchange. */
const isDesktopPage = (path: string): boolean => path.startsWith('/desktop/') && path !== DESKTOP_TOKEN_PATH;

export function createAppParts(deps: AppDeps) {
  const { clientIp } = deps;
  const now = deps.now ?? (() => new Date());
  const rateLimitStorage = deps.rateLimitStorage ?? createMemoryRateLimitStorage();
  const auth = createAuth({
    ...deps,
    rateLimitStorage,
    clientIp: clientIp.kind === 'peer' ? { kind: 'peer' } : { kind: 'header', header: clientIp.header, trustedProxies: clientIp.trustedProxies },
  });
  const origin = new URL(deps.auth.baseURL).origin;
  const trustedOrigins = new Set([origin, ...(deps.auth.trustedOrigins ?? [])]);
  const verifyBearer = deps.verifyBearer ?? desktopTokenVerifier(deps.db, now);
  /** Asked in order by every authenticated route: a bearer first, then the web session cookie. */
  const resolvers: readonly PrincipalResolver[] = [bearerResolver(verifyBearer), webSessionResolver(auth, origin)];

  const app = new Hono<AppEnv>();
  // Pages keep `Referrer-Policy: same-origin`: under `no-referrer` a browser sends `Origin: null` on
  // a form POST, and the desktop pages' forms must prove their origin. Nothing goes to other origins.
  const apiHeaders = secureHeaders({ crossOriginResourcePolicy: 'same-origin', referrerPolicy: 'no-referrer', xFrameOptions: 'DENY' });
  const pageHeaders = secureHeaders({ crossOriginResourcePolicy: 'same-origin', referrerPolicy: 'same-origin', xFrameOptions: 'DENY' });
  app.use((c, next) => (isDesktopPage(c.req.path) ? pageHeaders : apiHeaders)(c, next));
  app.use('/v1/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // better-auth, limited to `AUTH_ENDPOINT_METHODS`; every other path under the base is 404.
  const endpoints: Readonly<Record<string, string>> = AUTH_ENDPOINT_METHODS;
  app.all(`${AUTH_BASE_PATH}/*`, async (c) => {
    const path = c.req.path.slice(AUTH_BASE_PATH.length);
    if (!Object.hasOwn(endpoints, path) || endpoints[path] !== c.req.method) return c.json(errorBody('not_found'), 404);
    // A browser write from another site is refused outright (login CSRF, sign-up spam), on top of
    // better-auth's own checks. Clients that send neither header (curl, tests) are not browsers.
    if (c.req.method === 'POST') {
      const sentOrigin = c.req.header('origin');
      if ((sentOrigin !== undefined && !trustedOrigins.has(sentOrigin)) || c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json(errorBody('forbidden'), 403);
      }
    }
    let request = c.req.raw;
    if (clientIp.kind === 'peer') {
      // The client never chooses its own rate-limit key: whatever it sent is replaced.
      const headers = new Headers(request.headers);
      stampClientIp(headers, c, clientIp);
      request = new Request(request, { headers });
    }
    return withoutSessionToken(await auth.handler(request));
  });

  app.get(HEALTH_PATH, async (c) => {
    try {
      await Promise.race([deps.db.execute(sql`SELECT 1`), timeout(deps.healthTimeoutMs ?? 3000)]);
    } catch {
      return c.json(errorBody('unavailable'), 503);
    }
    return c.json({ status: 'ok' } satisfies HealthResponse);
  });

  app.get(SESSION_PATH, requirePrincipal(resolvers), (c) => {
    const { user, expiresAt } = c.get('principal');
    // Parsed, not just typed: an answer the desktop would refuse is a server error here instead.
    return c.json(SessionResponseSchema.parse({ user, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) }));
  });

  // Personal and short-lived: the account's plan and its features, signed (`no-store` via `/v1/*`).
  app.get(ENTITLEMENTS_PATH, requirePrincipal(resolvers), async (c) => {
    const { user } = c.get('principal');
    const snapshot = await issueSnapshot(deps.entitlementSigner, user, await planFor(deps.db, user.id));
    return c.json(EntitlementsResponseSchema.parse({ snapshot }));
  });

  // Desktop sign-in: the authorize pages, the code exchange and bearer sign-out (`desktop-auth.ts`).
  registerDesktopAuth(app, { db: deps.db, auth, origin, clientIp, rateLimitStorage, now });

  // Public keys only (validated against the spec's strict JWKS schema when the signer was loaded).
  const jwksBody = JSON.stringify(deps.entitlementSigner.jwks);
  app.get(ENTITLEMENT_KEYS_PATH, (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Content-Type', 'application/json');
    return c.body(jwksBody);
  });

  app.notFound((c) => c.json(errorBody('not_found'), 404));
  app.onError((error, c) => {
    // The name only: a driver's message can carry a query and its parameters.
    console.error(`[backend] unhandled ${error.name} on ${c.req.method} ${c.req.routePath}`);
    return c.json(errorBody('internal'), 500);
  });

  return { app, auth, resolvers };
}

export function createApp(deps: AppDeps) {
  return createAppParts(deps).app;
}

export type App = ReturnType<typeof createApp>;
