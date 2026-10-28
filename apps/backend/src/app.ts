import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { AUTH_BASE_PATH, HEALTH_PATH, SESSION_PATH, type ErrorResponse, type HealthResponse, type SessionResponse } from '@app/specs/account-api.schema';
import { createAuth, type AuthConfig } from './auth';
import type { Database } from './db/client';
import type { EmailTransport } from './email';
import { bearerResolver, requirePrincipal, webSessionResolver, type BearerVerifier, type PrincipalEnv, type PrincipalResolver } from './principal';

// The backend's HTTP app (spec `account-backend.feature.md`). Everything it needs comes in `deps`,
// so tests build one per case on an in-memory database and drive it with `app.request()`.

export interface AppDeps {
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly email: EmailTransport;
  /** Desktop bearer tokens (Task 3). Without one, a request with a bearer is refused. */
  readonly verifyBearer?: BearerVerifier | undefined;
}

export type AppEnv = PrincipalEnv;

const errorBody = (error: ErrorResponse['error']): ErrorResponse => ({ error });

export function createApp(deps: AppDeps) {
  const auth = createAuth(deps);
  /** Asked in order by every authenticated route: a bearer first, then the web session cookie. */
  const resolvers: readonly PrincipalResolver[] = [bearerResolver(deps.verifyBearer), webSessionResolver(auth)];

  const app = new Hono<AppEnv>();
  app.use(secureHeaders({ crossOriginResourcePolicy: 'same-origin', referrerPolicy: 'no-referrer' }));
  app.use('/v1/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw));

  app.get(HEALTH_PATH, async (c) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
    } catch {
      return c.json(errorBody('unavailable'), 503);
    }
    return c.json({ status: 'ok' } satisfies HealthResponse);
  });

  app.get(SESSION_PATH, requirePrincipal(resolvers), (c) => {
    const { user, expiresAt } = c.get('principal');
    const body: SessionResponse = { user, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) };
    return c.json(body);
  });

  app.notFound((c) => c.json(errorBody('not_found'), 404));
  app.onError((error, c) => {
    // The name only: a driver's message can carry a query and its parameters.
    console.error(`[backend] unhandled ${error.name} on ${c.req.method} ${c.req.routePath}`);
    return c.json(errorBody('internal'), 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
