import { createMiddleware } from 'hono/factory';
import type { AccountUser } from '@app/specs/account-api.schema';
import type { Auth } from './auth';

// "Who is this request?" for every authenticated route (spec `account-backend.feature.md`,
// Decisions). A route asks a chain of resolvers; the first that recognises a credential decides.
// A credential that is presented but invalid is a refusal, never a fall-through to the next one, so
// a bad desktop token cannot be rescued by a browser cookie riding along.
//
// Desktop bearer tokens (`desktop-auth.ts` `desktopTokenVerifier`) are the default `verifyBearer`;
// a route that needs a user uses `requirePrincipal(resolvers)` and reads `c.get('principal')`.

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
  | { readonly kind: 'absent' }
  /** The credential could not be checked now (the verifier failed): neither valid nor refused. */
  | { readonly kind: 'unavailable' };

export type PrincipalResolver = (request: Request) => Promise<Resolution>;

const ABSENT: Resolution = { kind: 'absent' };
const REJECTED: Resolution = { kind: 'rejected' };
const UNAVAILABLE: Resolution = { kind: 'unavailable' };

/** RFC 6750 `b64token`, bounded; the scheme is case-insensitive. */
const BEARER = /^bearer +([A-Za-z0-9\-._~+/]{1,512}=*)$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The bearer token of `Authorization: Bearer …`: `undefined` without the header, `null` when it is malformed or another scheme. */
export function bearerToken(request: Request): string | null | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

/**
 * `Authorization: Bearer …` through `verify`. Without a verifier every presented bearer is refused.
 * A verifier that throws (the database is down) is `unavailable`, not a refusal: a 401 would end the
 * desktop's session, while a 503 is a network failure to it, with offline grace (logged by error
 * name only).
 */
export function bearerResolver(verify: BearerVerifier | undefined): PrincipalResolver {
  return async (request) => {
    const token = bearerToken(request);
    if (token === undefined) return ABSENT;
    if (!token || !verify) return REJECTED;
    let principal: Principal | null;
    try {
      principal = await verify(token);
    } catch (error) {
      console.error(`[backend] bearer verification failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return UNAVAILABLE;
    }
    return principal ? { kind: 'principal', principal } : REJECTED;
  };
}

/** A browser request from `origin` itself: its `Origin`, else `Sec-Fetch-Site`; neither → not. */
export function isSameOrigin(request: Request, origin: string): boolean {
  const sent = request.headers.get('origin');
  if (sent !== null) return sent === origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * better-auth's web session cookie. For an unsafe method (anything but GET/HEAD/OPTIONS) the cookie
 * counts only on a same-origin request (`isSameOrigin` with the base URL's origin), so a cross-site
 * form cannot ride it. Desktop write routes take the bearer resolver alone.
 */
export function webSessionResolver(auth: Auth, origin: string): PrincipalResolver {
  return async (request) => {
    const found = await auth.api.getSession({ headers: request.headers });
    if (!found) return ABSENT;
    if (!SAFE_METHODS.has(request.method.toUpperCase()) && !isSameOrigin(request, origin)) return REJECTED;
    return { kind: 'principal', principal: { user: toAccountUser(found.user), expiresAt: found.session.expiresAt } };
  };
}

/** The first resolver's answer that is not `absent`: a principal, `null` (refused or none), or `'unavailable'`. */
export async function resolvePrincipal(resolvers: readonly PrincipalResolver[], request: Request): Promise<Principal | null | 'unavailable'> {
  for (const resolve of resolvers) {
    const resolution = await resolve(request);
    if (resolution.kind === 'principal') return resolution.principal;
    if (resolution.kind === 'rejected') return null;
    if (resolution.kind === 'unavailable') return 'unavailable';
  }
  return null;
}

export interface PrincipalEnv {
  Variables: { principal: Principal };
}

/**
 * 401 `{ error: 'unauthorized' }` unless a resolver answers a principal (then `c.get('principal')`);
 * 503 `{ error: 'unavailable' }` when the credential could not be checked.
 */
export function requirePrincipal(resolvers: readonly PrincipalResolver[]) {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    const principal = await resolvePrincipal(resolvers, c.req.raw);
    if (principal === 'unavailable') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'unavailable' }, 503);
    }
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
