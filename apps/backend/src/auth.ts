import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins/magic-link';
import {
  ACCOUNT_USER_LIMITS,
  AUTH_BASE_PATH,
  AUTH_RATE_LIMITS,
  AUTH_ROUTES,
  EMAIL_VERIFICATION_TTL_SECONDS,
  MAGIC_LINK_TTL_SECONDS,
  PASSWORD_LIMITS,
} from '@app/specs/account-api.schema';
import type { Database } from './db/client';
import { authSchema } from './db/schema';
import type { EmailTransport } from './email';
import { createRedactingLogger, type LogSink } from './log';
import { createMemoryRateLimitStorage, type RateLimitStorage } from './rate-limit';

// better-auth: web sign-in with email and password, and magic links (spec
// `account-backend.feature.md`, Decisions). Its endpoints are mounted under `AUTH_BASE_PATH`.

/** The request header better-auth reads the client IP from when the backend sets it itself. */
export const CLIENT_IP_HEADER = 'x-frost-client-ip';

export interface AuthConfig {
  /** `BETTER_AUTH_SECRET`: signs cookies and verification tokens. */
  readonly secret: string;
  /** `BETTER_AUTH_URL`: the public base URL (links in emails point here; its origin is trusted). */
  readonly baseURL: string;
  /** Extra origins allowed to POST to the auth endpoints (the base URL's origin always is). */
  readonly trustedOrigins?: readonly string[] | undefined;
}

/**
 * Where the client IP (rate limiting, session records) comes from. `peer`: the TCP peer, which the
 * app writes into `CLIENT_IP_HEADER` itself, replacing anything the client sent. `header`: a header
 * a trusted reverse proxy sets (`CLIENT_IP_HEADER` env), its chain walked past `trustedProxies`.
 */
export type ClientIpConfig =
  | { readonly kind: 'peer' }
  | { readonly kind: 'header'; readonly header: string; readonly trustedProxies?: readonly string[] | undefined };

export interface AuthDeps {
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly email: EmailTransport;
  readonly clientIp: ClientIpConfig;
  /** Rate-limit counters; one in-memory store per app by default. */
  readonly rateLimitStorage?: RateLimitStorage | undefined;
  /** Where better-auth's (redacted) log lines go; stderr by default. */
  readonly logSink?: LogSink | undefined;
}

/** Refuses user fields over `ACCOUNT_USER_LIMITS`, so `/v1/session` can always answer its schema. */
function assertUserFields(data: { readonly name?: unknown; readonly email?: unknown }): void {
  const tooLong = (value: unknown, max: number) => typeof value === 'string' && value.length > max;
  if (tooLong(data.name, ACCOUNT_USER_LIMITS.maxNameChars) || tooLong(data.email, ACCOUNT_USER_LIMITS.maxEmailChars)) {
    throw new APIError('BAD_REQUEST', { message: 'Name or email is too long', code: 'FIELD_TOO_LONG' });
  }
}

export function createAuth({ db, auth, email, clientIp, rateLimitStorage, logSink }: AuthDeps) {
  const route = (r: keyof typeof AUTH_ROUTES) => AUTH_ROUTES[r];
  return betterAuth({
    appName: 'frost',
    baseURL: auth.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: auth.secret,
    trustedOrigins: [new URL(auth.baseURL).origin, ...(auth.trustedOrigins ?? [])],
    // Multi-step writes (user + credential account) commit together; works on PGlite and node-postgres.
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
    // better-auth's anonymous usage telemetry: never on (env.ts also refuses its env overrides).
    telemetry: { enabled: false },
    // Unexpected errors (a driver error carries the query's parameters: hashes, tokens, emails) are
    // rethrown to Hono's onError, which logs the error's name only; better-auth's own APIErrors
    // still become their normal responses.
    onAPIError: { throw: true },
    logger: createRedactingLogger(logSink),
    rateLimit: {
      enabled: true,
      window: AUTH_RATE_LIMITS.default.window,
      max: AUTH_RATE_LIMITS.default.max,
      customStorage: rateLimitStorage ?? createMemoryRateLimitStorage(),
      customRules: {
        [route('signInEmail')]: AUTH_RATE_LIMITS.signIn,
        [route('signUpEmail')]: AUTH_RATE_LIMITS.signUp,
        [route('signInMagicLink')]: AUTH_RATE_LIMITS.magicLink,
        [route('verifyMagicLink')]: AUTH_RATE_LIMITS.magicLink,
      },
    },
    advanced: {
      cookiePrefix: 'frost',
      // Explicit: better-auth turns its origin and callbackURL checks off by default under
      // NODE_ENV=test, which would let the tests pass without the protections production has.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress:
        clientIp.kind === 'peer'
          ? { ipAddressHeaders: [CLIENT_IP_HEADER] }
          : { ipAddressHeaders: [clientIp.header], ...(clientIp.trustedProxies?.length ? { trustedProxies: [...clientIp.trustedProxies] } : {}) },
    },
    emailAndPassword: {
      enabled: true,
      // An address is proven before its password signs in (account pre-hijacking).
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_LIMITS.minLength,
      maxPasswordLength: PASSWORD_LIMITS.maxLength,
    },
    emailVerification: {
      sendOnSignUp: true,
      // Deliberately off: the verification link is a stateless, reusable-until-expiry token, so it
      // only proves the address; signing in takes the password (or a single-use magic link).
      autoSignInAfterVerification: false,
      expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
      sendVerificationEmail: ({ user, url }) =>
        email.send({
          to: user.email,
          subject: 'Confirm your email for frost',
          text: `Confirm this address to finish creating your frost account:\n\n${url}\n\nThe link expires in ${EMAIL_VERIFICATION_TTL_SECONDS / 60} minutes. If you did not sign up, ignore this email.`,
        }),
    },
    databaseHooks: {
      user: {
        create: { before: (user) => Promise.resolve(assertUserFields(user)) },
        update: { before: (user) => Promise.resolve(assertUserFields(user)) },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: 'hashed',
        sendMagicLink: ({ email: to, url }) =>
          email.send({
            to,
            subject: 'Sign in to frost',
            text: `Open this link to sign in to frost:\n\n${url}\n\nIt works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes. If you did not ask for it, ignore this email.`,
          }),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
