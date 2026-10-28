import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins/magic-link';
import { AUTH_BASE_PATH, EMAIL_VERIFICATION_TTL_SECONDS, MAGIC_LINK_TTL_SECONDS, PASSWORD_LIMITS } from '@app/specs/account-api.schema';
import type { Database } from './db/client';
import { authSchema } from './db/schema';
import type { EmailTransport } from './email';

// better-auth: web sign-in with email and password, and magic links (spec
// `account-backend.feature.md`, Decisions). Its endpoints are mounted under `AUTH_BASE_PATH`.

export interface AuthConfig {
  /** `BETTER_AUTH_SECRET`: signs cookies and verification tokens. */
  readonly secret: string;
  /** `BETTER_AUTH_URL`: the public base URL (links in emails point here; its origin is trusted). */
  readonly baseURL: string;
  /** Extra origins allowed to POST to the auth endpoints (the base URL's origin always is). */
  readonly trustedOrigins?: readonly string[] | undefined;
}

export interface AuthDeps {
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly email: EmailTransport;
}

export function createAuth({ db, auth, email }: AuthDeps) {
  return betterAuth({
    appName: 'frost',
    baseURL: auth.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: auth.secret,
    trustedOrigins: [new URL(auth.baseURL).origin, ...(auth.trustedOrigins ?? [])],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    // better-auth's anonymous usage telemetry: never on.
    telemetry: { enabled: false },
    advanced: { cookiePrefix: 'frost' },
    emailAndPassword: {
      enabled: true,
      // An address is proven before its password signs in (account pre-hijacking).
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_LIMITS.minLength,
      maxPasswordLength: PASSWORD_LIMITS.maxLength,
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
      sendVerificationEmail: ({ user, url }) =>
        email.send({
          to: user.email,
          subject: 'Confirm your email for frost',
          text: `Confirm this address to finish creating your frost account:\n\n${url}\n\nThe link expires in ${EMAIL_VERIFICATION_TTL_SECONDS / 60} minutes. If you did not sign up, ignore this email.`,
        }),
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
