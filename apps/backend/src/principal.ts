import { createMiddleware } from 'hono/factory';
import type { AccountUser } from '@app/specs/account-api.schema';
import type { Auth } from './auth';

// "Who is this request?" for every authenticated route (spec `account-backend.feature.md`,
// Decisions). A route asks a chain of resolvers; the first that recognises a credential decides.
// A credential that is presented but invalid is a refusal, never a fall-through to the next one, so
// a bad desktop token cannot be rescued by a browser cookie riding along.
//
// Task 3 plugs desktop bearer tokens in through `AppDeps.verifyBearer`; a route that needs a user
// uses `requirePrincipal(resolvers)` and reads `c.get('principal')`.

/** The authenticated user and when the credential that proved it expires. */
export interface Principal {
  readonly user: AccountUser;
  readonly expiresAt?: Date | undefined;
}

/** Answers the principal for a bearer token, or `null` when the token is unknown, expired or revoked. */
export type BearerVerifier = (token: string) => Promise<Principal | null>;

export type Resolution =
  | { readonly kind: 'principal'; readonly principal: Principal }
  /** A credential of this kind was presented and is not valid. */
  | { readonly kind: 'rejected' }
  /** No credential of this kind: ask the next resolver. */
  | { readonly kind: 'absent' };

export type PrincipalResolver = (request: Request) => Promise<Resolution>;

const ABSENT: Resolution = { kind: 'absent' };
const REJECTED: Resolution = { kind: 'rejected' };
/** RFC 6750 `b64token`, bounded. */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]{1,512}=*)$/;

/** `Authorization: Bearer …` through `verify`. Without a verifier every presented bearer is refused. */
export function bearerResolver(verify: BearerVerifier | undefined): PrincipalResolver {
  return async (request) => {
    const header = request.headers.get('authorization');
    if (header === null) return ABSENT;
    const token = BEARER.exec(header)?.[1];
    if (!token || !verify) return REJECTED;
    const principal = await verify(token);
    return principal ? { kind: 'principal', principal } : REJECTED;
  };
}

/** better-auth's web session cookie. */
export function webSessionResolver(auth: Auth): PrincipalResolver {
  return async (request) => {
    const found = await auth.api.getSession({ headers: request.headers });
    if (!found) return ABSENT;
    return { kind: 'principal', principal: { user: toAccountUser(found.user), expiresAt: found.session.expiresAt } };
  };
}

export async function resolvePrincipal(resolvers: readonly PrincipalResolver[], request: Request): Promise<Principal | null> {
  for (const resolve of resolvers) {
    const resolution = await resolve(request);
    if (resolution.kind === 'principal') return resolution.principal;
    if (resolution.kind === 'rejected') return null;
  }
  return null;
}

export interface PrincipalEnv {
  Variables: { principal: Principal };
}

/** 401 `{ error: 'unauthorized' }` unless a resolver answers a principal (then `c.get('principal')`). */
export function requirePrincipal(resolvers: readonly PrincipalResolver[]) {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    const principal = await resolvePrincipal(resolvers, c.req.raw);
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer realm="frost"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('principal', principal);
    await next();
  });
}

/** better-auth's user → the spec's `AccountUser` (an empty name, as magic-link sign-up leaves it, is `null`). */
export function toAccountUser(user: { readonly id: string; readonly email: string; readonly name?: string | null }): AccountUser {
  const name = user.name?.trim() ?? '';
  return { id: user.id, email: user.email, name: name === '' ? null : name };
}
