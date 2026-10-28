import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AUTH_SECRET_MIN_LENGTH } from '@app/specs/account-api.schema';
import { EMAIL_TRANSPORTS } from './email';

// The backend's environment (spec `account-backend.feature.md`, Environment; the table in
// `apps/backend/README.md`). Parsed once at startup; anything invalid refuses to start. Error
// messages name the variable and the rule, never the value (a secret or a URL with a password).

/** Where the dev database lives when `DATABASE_URL` is unset: `apps/backend/.data/pglite` (gitignored). */
export const DEFAULT_PGLITE_DIR = fileURLToPath(new URL('../.data/pglite', import.meta.url));
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

/** An empty value (`FOO=` in a `.env`) counts as unset. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const EnvSchema = z
  .object({
    NODE_ENV: optional(z.enum(['development', 'test', 'production'], { error: 'must be development, test or production' })),
    DATABASE_URL: optional(z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' })),
    PGLITE_DIR: optional(z.string()),
    BETTER_AUTH_SECRET: z
      .string({ error: 'is required' })
      .min(AUTH_SECRET_MIN_LENGTH, { error: `must be at least ${AUTH_SECRET_MIN_LENGTH} characters` }),
    BETTER_AUTH_URL: optional(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })),
    EMAIL_TRANSPORT: optional(z.enum(EMAIL_TRANSPORTS, { error: `must be one of: ${EMAIL_TRANSPORTS.join(', ')}` })),
    HOST: optional(z.string().min(1)),
    PORT: optional(z.coerce.number({ error: 'must be a port number' }).int().min(1).max(65_535)),
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
    } as const;
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.EMAIL_TRANSPORT === 'console') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_TRANSPORT'], message: 'console prints sign-in links and is for development only' });
    }
    if (!env.BETTER_AUTH_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_URL'], message: 'must be https:// in production' });
    }
  });

export type Env = z.output<typeof EnvSchema>;

/** Parses `source` (usually `process.env`); throws `EnvError` listing every invalid variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(environment)'} ${issue.message}`);
  throw new EnvError(`Invalid backend environment:\n  ${problems.join('\n  ')}`);
}
