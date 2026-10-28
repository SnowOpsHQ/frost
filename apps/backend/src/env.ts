import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AUTH_SECRET_MIN_LENGTH } from '@app/specs/account-api.schema';
import { ENTITLEMENT_KEY_ID_PATTERN } from '@app/specs/entitlements-snapshot.spec';
import { EMAIL_TRANSPORTS } from './email';
import { publicKeysProblem, signingKeyProblem } from './entitlements';

// The backend's environment (spec `account-backend.feature.md`, Environment; the table in
// `apps/backend/README.md`). Parsed once at startup; anything invalid refuses to start. Error
// messages name the variable and the rule, never the value (a secret or a URL with a password).

/** Where the dev database lives when `DATABASE_URL` is unset: `apps/backend/.data/pglite` (gitignored). */
export const DEFAULT_PGLITE_DIR = fileURLToPath(new URL('../.data/pglite', import.meta.url));
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

/** better-auth environment switches that would re-enable its telemetry; refused when set. */
export const TELEMETRY_OVERRIDES = ['BETTER_AUTH_TELEMETRY', 'BETTER_AUTH_TELEMETRY_ENDPOINT', 'BETTER_AUTH_TELEMETRY_DEBUG'] as const;

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

/** An empty value (`FOO=` in a `.env`) counts as unset. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const required = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);

const DATABASE_URL = optional(z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }));
const PGLITE_DIR = optional(z.string());

const telemetryOverrides = Object.fromEntries(
  TELEMETRY_OVERRIDES.map((name) => [name, optional(z.never({ error: 'must not be set (better-auth telemetry stays off)' }))]),
);

const EnvSchema = z
  .object({
    NODE_ENV: optional(z.enum(['development', 'test', 'production'], { error: 'must be development, test or production' })),
    DATABASE_URL,
    PGLITE_DIR,
    BETTER_AUTH_SECRET: z
      .string({ error: 'is required' })
      .min(AUTH_SECRET_MIN_LENGTH, { error: `must be at least ${AUTH_SECRET_MIN_LENGTH} characters` }),
    BETTER_AUTH_URL: optional(
      z
        .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
        .refine((value) => new URL(value).origin === value.replace(/\/+$/, ''), { error: 'must be a bare origin (scheme, host, port; no path, query or credentials)' }),
    ),
    EMAIL_TRANSPORT: optional(z.enum(EMAIL_TRANSPORTS, { error: `must be one of: ${EMAIL_TRANSPORTS.join(', ')}` })),
    HOST: optional(z.string().min(1)),
    PORT: optional(z.coerce.number({ error: 'must be a port number' }).int().min(1).max(65_535)),
    CLIENT_IP_HEADER: optional(z.string().regex(/^[a-z0-9-]{1,64}$/i, { error: 'must be a header name' })),
    TRUSTED_PROXIES: optional(z.string().max(2000)),
    // Checked as a key (JSON, Ed25519, private, matching kid) below; `entitlements.ts` proves the pair.
    ENTITLEMENT_SIGNING_KEY: required(z.string({ error: 'is required (a private Ed25519 JWK; `admin keygen` makes one)' }).max(4096, { error: 'is too long' })),
    ENTITLEMENT_KEY_ID: required(z.string({ error: 'is required' }).regex(ENTITLEMENT_KEY_ID_PATTERN, { error: `must match ${ENTITLEMENT_KEY_ID_PATTERN.source}` })),
    ENTITLEMENT_PUBLIC_KEYS: optional(z.string().max(65_536, { error: 'is too long' })),
    // better-auth ORs these with its `telemetry` option, so any of them could turn its telemetry on.
    ...telemetryOverrides,
  })
  .transform((raw) => {
    const PORT = raw.PORT ?? DEFAULT_PORT;
    return {
      NODE_ENV: raw.NODE_ENV ?? 'development',
      DATABASE_URL: raw.DATABASE_URL,
      PGLITE_DIR: resolve(raw.PGLITE_DIR ?? DEFAULT_PGLITE_DIR),
      BETTER_AUTH_SECRET: raw.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: (raw.BETTER_AUTH_URL ?? `http://${DEFAULT_HOST}:${PORT}`).replace(/\/+$/, ''),
      EMAIL_TRANSPORT: raw.EMAIL_TRANSPORT ?? 'console',
      HOST: raw.HOST ?? DEFAULT_HOST,
      PORT,
      CLIENT_IP_HEADER: raw.CLIENT_IP_HEADER?.toLowerCase(),
      TRUSTED_PROXIES: (raw.TRUSTED_PROXIES ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
      ENTITLEMENT_SIGNING_KEY: raw.ENTITLEMENT_SIGNING_KEY,
      ENTITLEMENT_KEY_ID: raw.ENTITLEMENT_KEY_ID,
      ENTITLEMENT_PUBLIC_KEYS: raw.ENTITLEMENT_PUBLIC_KEYS,
    } as const;
  })
  .superRefine((env, ctx) => {
    // Fixed phrases only: never the key, nor a parser message that could quote it.
    const keyProblem = signingKeyProblem(env.ENTITLEMENT_SIGNING_KEY, env.ENTITLEMENT_KEY_ID);
    if (keyProblem) ctx.addIssue({ code: 'custom', path: ['ENTITLEMENT_SIGNING_KEY'], message: keyProblem });
    const rotationProblem = env.ENTITLEMENT_PUBLIC_KEYS === undefined ? null : publicKeysProblem(env.ENTITLEMENT_PUBLIC_KEYS, env.ENTITLEMENT_KEY_ID);
    if (rotationProblem) ctx.addIssue({ code: 'custom', path: ['ENTITLEMENT_PUBLIC_KEYS'], message: rotationProblem });

    if (env.NODE_ENV !== 'production') return;
    if (env.EMAIL_TRANSPORT === 'console') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_TRANSPORT'], message: 'console prints sign-in links and is for development only' });
    }
    if (!env.BETTER_AUTH_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_URL'], message: 'must be https:// in production' });
    }
    if (!env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required in production (PGlite is for development)' });
    }
  });

export type Env = z.output<typeof EnvSchema>;

function envError(error: z.ZodError): EnvError {
  const problems = error.issues.map((issue) => `${issue.path.join('.') || '(environment)'} ${issue.message}`);
  return new EnvError(`Invalid backend environment:\n  ${problems.join('\n  ')}`);
}

/** Parses `source` (usually `process.env`); throws `EnvError` listing every invalid variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  throw envError(result.error);
}

const DatabaseEnvSchema = z.object({ DATABASE_URL, PGLITE_DIR }).transform((raw) => ({
  DATABASE_URL: raw.DATABASE_URL,
  PGLITE_DIR: resolve(raw.PGLITE_DIR ?? DEFAULT_PGLITE_DIR),
}));
export type DatabaseEnv = z.output<typeof DatabaseEnvSchema>;

/** Only the database variables (the admin CLI needs no auth secret or signing key). */
export function parseDatabaseEnv(source: Readonly<Record<string, string | undefined>>): DatabaseEnv {
  const result = DatabaseEnvSchema.safeParse(source);
  if (result.success) return result.data;
  throw envError(result.error);
}
