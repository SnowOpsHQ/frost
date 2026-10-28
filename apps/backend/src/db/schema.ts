import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { PLANS } from '@app/specs/entitlements-snapshot.spec';

// better-auth's core tables (user, session, account, verification), written by hand to match the
// fields its Drizzle adapter reads and writes. The SQL is `drizzle/0001_auth.sql`; a change here
// needs a new forward-only migration there (never an edit of an applied one).
//
// The JS property names are better-auth's field names (the adapter looks columns up by them); the
// SQL names are snake_case. `authSchema` maps better-auth's model names onto these tables.

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  ...timestamps,
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true, mode: 'date' }),
    scope: text('scope'),
    /** better-auth's scrypt hash for the `credential` provider; never answered by any route. */
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/**
 * An account's plan (`drizzle/0002_entitlements.sql`; spec `entitlements.feature.md`). No row means
 * `DEFAULT_PLAN` (`free`). Which features a plan includes is `PLAN_FEATURES`, not stored here. Set by
 * the admin CLI (`grant`); the database refuses a plan outside `PLANS`.
 */
export const entitlements = pgTable('entitlements', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  plan: text('plan', { enum: PLANS }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * One-time desktop authorization codes (`drizzle/0003_desktop_auth.sql`; spec
 * `account-backend.feature.md`, Desktop authorization). Keyed by the code's SHA-256 (hex); bound to
 * the user, the PKCE challenge and the loopback `redirect_uri`. `consumedAt` is set exactly once, by
 * the exchange; a code is good until `expiresAt` and only while unconsumed.
 */
export const desktopCodes = pgTable(
  'desktop_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeChallenge: text('code_challenge').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('desktop_codes_user_id_idx').on(t.userId), index('desktop_codes_expires_at_idx').on(t.expiresAt)],
);

/**
 * Desktop bearer tokens, keyed by the token's SHA-256 (hex). `codeHash` is the code it was issued
 * for (a replayed code revokes it). Valid while unrevoked and before `expiresAt`.
 */
export const desktopTokens = pgTable(
  'desktop_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('desktop_tokens_user_id_idx').on(t.userId), index('desktop_tokens_code_hash_idx').on(t.codeHash)],
);

/** better-auth model name → table, as its Drizzle adapter expects. */
export const authSchema = { user: users, session: sessions, account: accounts, verification: verifications };

/** Every table, for `drizzle(..., { schema })`. Later tasks add theirs here. */
export const schema = { users, sessions, accounts, verifications, entitlements, desktopCodes, desktopTokens };
export type Schema = typeof schema;
