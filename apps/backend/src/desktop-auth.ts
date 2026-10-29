import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_CODE_TTL_SECONDS,
  DESKTOP_PAGE_PATHS,
  DESKTOP_RATE_LIMITS,
  DESKTOP_RECENT_AUTH_SECONDS,
  DESKTOP_TOKEN_PATH,
  DESKTOP_TOKEN_PATTERN,
  DESKTOP_TOKEN_TTL_DAYS,
  DesktopAuthorizeQuerySchema,
  DesktopTokenRequestSchema,
  DesktopTokenResponseSchema,
  PASSWORD_LIMITS,
  SIGN_OUT_PATH,
  type AccountApiError,
  type DesktopAuthorizeQuery,
  type ErrorResponse,
} from '@app/specs/account-api.schema';
import type { AppEnv, ClientIpSource } from './app';
import type { Auth } from './auth';
import { clientIpResolver, stampClientIp } from './client-ip';
import type { Database } from './db/client';
import { desktopCodes, desktopTokens, sessions, users } from './db/schema';
import { authorizePath, authorizeQuery, checkEmailPage, continuePage, errorPage, pageCsp, signInPage, type Page, type SignInSection } from './desktop-pages';
import { bearerToken, toAccountUser, type BearerVerifier } from './principal';
import type { RateLimitStorage } from './rate-limit';

// Desktop authorization: loopback redirect + PKCE (spec `account-backend.feature.md`, Desktop
// authorization; `account-api.schema.ts`). The browser signs in on frost's own pages and presses
// Continue, which redirects a one-time code to the desktop's loopback listener; the desktop swaps
// the code and its PKCE verifier for a desktop token, its bearer from then on. Codes and tokens are
// random, shown once, and stored only as SHA-256 hashes.

const DAY_MS = 86_400_000;
const TOKEN_PREFIX = 'frost_dt_';
/** `last_used_at` is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;
const PAGE_BODY_LIMIT = 16 * 1024;
const TOKEN_BODY_LIMIT = 8 * 1024;

/** SHA-256 hex: how a code or token is stored and looked up. */
export const secretHash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** RFC 7636 S256: `BASE64URL(SHA-256(ASCII(code_verifier)))`. */
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

function equalInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `Authorization: Bearer` desktop tokens for the principal chain: valid while unrevoked, unexpired, and the address verified. */
export function desktopTokenVerifier(db: Database, now: () => Date = () => new Date()): BearerVerifier {
  return async (token) => {
    if (!DESKTOP_TOKEN_PATTERN.test(token)) return null;
    const tokenHash = secretHash(token);
    const rows = await db
      .select({
        expiresAt: desktopTokens.expiresAt,
        revokedAt: desktopTokens.revokedAt,
        lastUsedAt: desktopTokens.lastUsedAt,
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerified: users.emailVerified,
      })
      .from(desktopTokens)
      .innerJoin(users, eq(users.id, desktopTokens.userId))
      .where(eq(desktopTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    const t = now();
    if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= t.getTime() || !row.emailVerified) return null;
    if (row.lastUsedAt === null || t.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
      await db.update(desktopTokens).set({ lastUsedAt: t }).where(eq(desktopTokens.tokenHash, tokenHash));
    }
    return { user: toAccountUser(row), expiresAt: row.expiresAt };
  };
}

export interface DesktopAuthDeps {
  readonly db: Database;
  readonly auth: Auth;
  /** The API's own origin (`BETTER_AUTH_URL`): the only `Origin` a page form may come from. */
  readonly origin: string;
  readonly clientIp: ClientIpSource;
  readonly rateLimitStorage: RateLimitStorage;
  readonly now: () => Date;
}

type AuthorizeRead = { readonly ok: true; readonly params: DesktopAuthorizeQuery } | { readonly ok: false; readonly reason: string };

const AUTHORIZE_KEYS = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const;

/** Fixed reasons (never a value from the request) per parameter. */
const AUTHORIZE_PROBLEMS: Readonly<Record<(typeof AUTHORIZE_KEYS)[number], string>> = {
  redirect_uri: 'The address it would return to is not the frost app on this computer.',
  state: 'Its check value is missing or malformed.',
  code_challenge: 'Its security challenge is missing or malformed.',
  code_challenge_method: 'Its security challenge is missing or malformed.',
};

/** The authorize parameters from a query or a form: each exactly once, valid against the spec. */
function readAuthorize(source: URLSearchParams): AuthorizeRead {
  const raw: Record<string, string> = {};
  for (const key of AUTHORIZE_KEYS) {
    const values = source.getAll(key);
    if (values.length !== 1) return { ok: false, reason: AUTHORIZE_PROBLEMS[key] };
    raw[key] = values[0] ?? '';
  }
  const parsed = DesktopAuthorizeQuerySchema.safeParse(raw);
  if (parsed.success) return { ok: true, params: parsed.data };
  const key = parsed.error.issues[0]?.path[0];
  return { ok: false, reason: typeof key === 'string' && key in AUTHORIZE_PROBLEMS ? AUTHORIZE_PROBLEMS[key as (typeof AUTHORIZE_KEYS)[number]] : AUTHORIZE_PROBLEMS.state };
}

function pageResponse(status: number, page: Page, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', pageCsp(page));
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(page.html, { status, headers });
}

const INVALID_TITLE = 'This sign-in request cannot be used';
const invalidRequest = (reason: string): Response => pageResponse(400, errorPage(INVALID_TITLE, reason));
const forbidden = (): Response =>
  pageResponse(403, errorPage('This form was not sent from frost', "frost only accepts this form from its own sign-in page. Nothing was changed."));
const tooLarge = (): Response => pageResponse(413, errorPage(INVALID_TITLE, 'The form was too large.'));

/** 303 to `location`, with the cookies better-auth set (a session, or its removal). */
function seeOther(location: string, cookiesFrom?: Response): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
  for (const line of cookiesFrom?.headers.getSetCookie() ?? []) headers.append('Set-Cookie', line);
  return new Response(null, { status: 303, headers });
}

const json = (status: number, error: AccountApiError, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error } satisfies ErrorResponse), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** better-auth's error `code`, if its answer has one (used to pick a fixed message, never shown). */
async function authErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

const TOO_MANY = 'Too many attempts. Wait a minute, then try again.';

export function registerDesktopAuth(app: Hono<AppEnv>, deps: DesktopAuthDeps): void {
  const { db, auth, origin, now, rateLimitStorage } = deps;
  const clientIpOf = clientIpResolver(deps.clientIp);

  /** Seconds to wait when `rule` is exhausted for this client, else `null`. */
  const overLimit = async (c: Context, name: keyof typeof DESKTOP_RATE_LIMITS): Promise<number | null> => {
    const rule = DESKTOP_RATE_LIMITS[name];
    const { allowed, retryAfter } = await rateLimitStorage.consume(`${clientIpOf(c)}|desktop:${name}`, rule);
    return allowed ? null : (retryAfter ?? rule.window);
  };

  /** A browser form from the API's own origin: `Origin` must be it; `Sec-Fetch-Site`, when sent, `same-origin`. */
  const fromOwnPage = (c: Context): boolean => {
    if (c.req.header('origin') !== origin) return false;
    const site = c.req.header('sec-fetch-site');
    return site === undefined || site === 'same-origin';
  };

  /** The web session, if the address behind it is verified. */
  const verifiedSession = async (headers: Headers) => {
    const found = await auth.api.getSession({ headers });
    return found?.user.emailVerified ? found : null;
  };

  /** Was this session created (signed in, or signed in again) within `DESKTOP_RECENT_AUTH_SECONDS`? */
  const isRecent = (session: { readonly createdAt: Date }): boolean =>
    now().getTime() - session.createdAt.getTime() <= DESKTOP_RECENT_AUTH_SECONDS * 1000;

  /**
   * One of better-auth's own endpoints, called through its handler as the browser would (so its
   * rate limits, origin and callback checks apply), with the browser's cookie, `Origin` and client IP.
   */
  const callAuth = (c: Context, route: keyof typeof AUTH_ROUTES, body: Record<string, unknown>): Promise<Response> => {
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const name of ['cookie', 'origin', 'user-agent']) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    if (deps.clientIp.kind === 'header') {
      const forwarded = c.req.header(deps.clientIp.header);
      if (forwarded !== undefined) headers.set(deps.clientIp.header, forwarded);
    }
    stampClientIp(headers, c, deps.clientIp);
    return auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${AUTH_ROUTES[route]}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  };

  /** An absolute authorize URL (better-auth's callbacks must be on a trusted origin). */
  const authorizeUrl = (params: DesktopAuthorizeQuery, extra?: Record<string, string>): string => `${origin}${DESKTOP_AUTHORIZE_PATH}?${authorizeQuery(params, extra)}`;

  /** The checks every page form shares; answers the form and its authorize parameters, or the refusal. */
  const readPageForm = async (c: Context): Promise<{ form: URLSearchParams; params: DesktopAuthorizeQuery } | Response> => {
    if (!fromOwnPage(c)) return forbidden();
    const type = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') return invalidRequest('The form could not be read.');
    const form = new URLSearchParams(await c.req.text());
    const read = readAuthorize(form);
    return read.ok ? { form, params: read.params } : invalidRequest(read.reason);
  };

  const pageLimit = bodyLimit({ maxSize: PAGE_BODY_LIMIT, onError: () => tooLarge() });
  for (const path of [DESKTOP_AUTHORIZE_PATH, ...Object.values(DESKTOP_PAGE_PATHS)]) app.use(path, pageLimit);

  // ---- The page -------------------------------------------------------------------------------

  app.get(DESKTOP_AUTHORIZE_PATH, async (c) => {
    const query = new URL(c.req.url).searchParams;
    const read = readAuthorize(query);
    if (!read.ok) return invalidRequest(read.reason);
    const session = await verifiedSession(c.req.raw.headers);
    if (session && isRecent(session.session)) return pageResponse(200, continuePage(read.params, session.user.email));
    // better-auth appends `error` (and its own `error_description`, never shown) when a link fails.
    const notice = query.has('error') ? 'link-failed' : query.get('notice') === 'verified' ? 'verified' : undefined;
    // Signed in, but not recently: this request needs a fresh sign-in (another local program could
    // otherwise get a token with one click on a browser that is merely still signed in).
    return pageResponse(200, signInPage({ params: read.params, notice, signedInAs: session?.user.email }));
  });

  // ---- Continue: issue a code -----------------------------------------------------------------

  app.post(DESKTOP_AUTHORIZE_PATH, async (c) => {
    const read = await readPageForm(c);
    if (read instanceof Response) return read;
    const { params } = read;
    const wait = await overLimit(c, 'authorize');
    if (wait !== null) return pageResponse(429, errorPage('Too many requests', TOO_MANY), new Headers({ 'Retry-After': String(wait) }));
    const session = await verifiedSession(c.req.raw.headers);
    if (!session || !isRecent(session.session)) return seeOther(authorizePath(params));

    const code = randomBytes(32).toString('base64url');
    const t = now();
    await db.delete(desktopCodes).where(lt(desktopCodes.expiresAt, t));
    await db.insert(desktopCodes).values({
      codeHash: secretHash(code),
      userId: session.user.id,
      codeChallenge: params.code_challenge,
      redirectUri: params.redirect_uri,
      createdAt: t,
      expiresAt: new Date(t.getTime() + DESKTOP_CODE_TTL_SECONDS * 1000),
    });
    // One session, one code: the web session ends here (better-auth revokes it and clears its cookie;
    // the row is deleted as well in case that call did not), so the next desktop sign-in needs real
    // credentials again.
    const signedOut = await callAuth(c, 'signOut', {});
    await db.delete(sessions).where(eq(sessions.id, session.session.id));
    // `redirect_uri` is exactly the loopback pattern (no query of its own).
    return seeOther(`${params.redirect_uri}?${new URLSearchParams({ code, state: params.state }).toString()}`, signedOut);
  });

  // ---- The sign-in forms ----------------------------------------------------------------------

  const signInProblem = (s: SignInSection, params: DesktopAuthorizeQuery, status: number, problem: string, typed: { email?: string; name?: string } = {}) =>
    pageResponse(status, signInPage({ params, section: s, problem, ...typed }));

  app.post(DESKTOP_PAGE_PATHS.signIn, async (c) => {
    const read = await readPageForm(c);
    if (read instanceof Response) return read;
    const { form, params } = read;
    const email = (form.get('email') ?? '').trim();
    const res = await callAuth(c, 'signInEmail', { email, password: form.get('password') ?? '' });
    if (res.ok) return seeOther(authorizePath(params), res);
    const code = await authErrorCode(res);
    if (res.status === 429) return signInProblem('password', params, 429, TOO_MANY, { email });
    if (res.status === 403 && code === 'EMAIL_NOT_VERIFIED') {
      return signInProblem('password', params, 403, 'Confirm your email first: open the link we sent when you created the account.', { email });
    }
    if (res.status === 401) return signInProblem('password', params, 401, 'The email or password is not right.', { email });
    return signInProblem('password', params, 400, 'Enter your email address and password, then try again.', { email });
  });

  app.post(DESKTOP_PAGE_PATHS.signUp, async (c) => {
    const read = await readPageForm(c);
    if (read instanceof Response) return read;
    const { form, params } = read;
    const email = (form.get('email') ?? '').trim();
    const name = (form.get('name') ?? '').trim();
    const password = form.get('password') ?? '';
    // The verification link comes back to this request, which then says the address is confirmed.
    const res = await callAuth(c, 'signUpEmail', { email, name, password, callbackURL: authorizeUrl(params, { notice: 'verified' }) });
    if (res.ok) return pageResponse(200, checkEmailPage(params, email, 'verify'));
    const code = await authErrorCode(res);
    if (res.status === 429) return signInProblem('sign-up', params, 429, TOO_MANY, { email, name });
    if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') {
      return signInProblem('sign-up', params, 400, `Choose a password of ${PASSWORD_LIMITS.minLength} to ${PASSWORD_LIMITS.maxLength} characters.`, { email, name });
    }
    return signInProblem('sign-up', params, 400, 'Check the name and email address, then try again.', { email, name });
  });

  app.post(DESKTOP_PAGE_PATHS.magicLink, async (c) => {
    const read = await readPageForm(c);
    if (read instanceof Response) return read;
    const { form, params } = read;
    const email = (form.get('email') ?? '').trim();
    // Followed, the link signs the browser in and lands back on this request; a failed one lands
    // here too, with `error` added.
    const back = authorizeUrl(params);
    const res = await callAuth(c, 'signInMagicLink', { email, callbackURL: back, newUserCallbackURL: back, errorCallbackURL: back });
    if (res.ok) return pageResponse(200, checkEmailPage(params, email, 'magic-link'));
    if (res.status === 429) return signInProblem('magic-link', params, 429, TOO_MANY, { email });
    return signInProblem('magic-link', params, 400, 'Check the email address, then try again.', { email });
  });

  app.post(DESKTOP_PAGE_PATHS.signOut, async (c) => {
    const read = await readPageForm(c);
    if (read instanceof Response) return read;
    // Signed out already is fine: either way the browser comes back to the sign-in page.
    const res = await callAuth(c, 'signOut', {});
    return seeOther(authorizePath(read.params), res);
  });

  // ---- The exchange ---------------------------------------------------------------------------

  app.use(DESKTOP_TOKEN_PATH, async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
  });

  app.post(
    DESKTOP_TOKEN_PATH,
    bodyLimit({ maxSize: TOKEN_BODY_LIMIT, onError: () => json(400, 'invalid_request') }),
    async (c) => {
      const wait = await overLimit(c, 'token');
      if (wait !== null) return json(429, 'rate_limited', { 'Retry-After': String(wait) });
      const type = (c.req.header('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (type !== 'application/json') return json(400, 'invalid_request');
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return json(400, 'invalid_request');
      }
      const parsed = DesktopTokenRequestSchema.safeParse(body);
      if (!parsed.success) return json(400, 'invalid_request');
      const request = parsed.data;

      const t = now();
      const codeHash = secretHash(request.code);
      // Consumed before anything else is checked: a wrong verifier or redirect burns the code too.
      const [row] = await db
        .update(desktopCodes)
        .set({ consumedAt: t })
        .where(and(eq(desktopCodes.codeHash, codeHash), isNull(desktopCodes.consumedAt)))
        .returning();
      const revokeIssued = () =>
        db
          .update(desktopTokens)
          .set({ revokedAt: t })
          .where(and(eq(desktopTokens.codeHash, codeHash), isNull(desktopTokens.revokedAt)));
      if (!row) {
        // Unknown, or presented again: whatever it issued is revoked (RFC 6749 §4.1.2). The mark
        // covers an exchange of the same code still running: it re-reads it after storing its token.
        await db.update(desktopCodes).set({ replayedAt: t }).where(and(eq(desktopCodes.codeHash, codeHash), isNull(desktopCodes.replayedAt)));
        await revokeIssued();
        return json(400, 'invalid_grant');
      }
      if (row.expiresAt.getTime() <= t.getTime()) return json(400, 'invalid_grant');
      if (!equalInConstantTime(row.redirectUri, request.redirect_uri)) return json(400, 'invalid_grant');
      if (!equalInConstantTime(pkceChallenge(request.code_verifier), row.codeChallenge)) return json(400, 'invalid_grant');
      const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
      if (!user?.emailVerified) return json(400, 'invalid_grant');

      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const expiresAt = new Date(t.getTime() + DESKTOP_TOKEN_TTL_DAYS * DAY_MS);
      // Housekeeping: this account's expired and revoked tokens are no longer needed.
      await db
        .delete(desktopTokens)
        .where(and(eq(desktopTokens.userId, user.id), or(lt(desktopTokens.expiresAt, t), isNotNull(desktopTokens.revokedAt))));
      await db.insert(desktopTokens).values({ tokenHash: secretHash(token), userId: user.id, codeHash, createdAt: t, expiresAt });
      // A replay that marked the code before this point may have revoked nothing yet; one after it
      // finds the token. Either way the token does not survive a replay.
      const [mark] = await db.select({ replayedAt: desktopCodes.replayedAt }).from(desktopCodes).where(eq(desktopCodes.codeHash, codeHash)).limit(1);
      if (mark?.replayedAt) {
        await revokeIssued();
        return json(400, 'invalid_grant');
      }
      return c.json(DesktopTokenResponseSchema.parse({ token, expiresAt: expiresAt.getTime(), user: toAccountUser(user) }));
    },
  );

  // ---- Sign-out (bearer only) -----------------------------------------------------------------

  app.post(SIGN_OUT_PATH, async (c) => {
    const token = bearerToken(c.req.raw);
    if (!token) return json(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="frost"' });
    // Idempotent: an unknown, expired or already revoked token answers the same.
    if (DESKTOP_TOKEN_PATTERN.test(token)) {
      await db
        .update(desktopTokens)
        .set({ revokedAt: now() })
        .where(and(eq(desktopTokens.tokenHash, secretHash(token)), isNull(desktopTokens.revokedAt)));
    }
    return c.body(null, 204);
  });
}
