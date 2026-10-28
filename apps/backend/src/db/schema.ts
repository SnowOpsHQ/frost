import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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

/** better-auth model name → table, as its Drizzle adapter expects. */
export const authSchema = { user: users, session: sessions, account: accounts, verification: verifications };

/** Every table, for `drizzle(..., { schema })`. Later tasks add theirs here. */
export const schema = { users, sessions, accounts, verifications };
export type Schema = typeof schema;
