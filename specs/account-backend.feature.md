# Feature: account backend — web sign-in and session

Spec: `specs/account-api.schema.ts` (`AUTH_BASE_PATH`, `AUTH_ROUTES`, `SESSION_PATH`, `HEALTH_PATH`,
`PASSWORD_LIMITS`, `MAGIC_LINK_TTL_SECONDS`, `EMAIL_VERIFICATION_TTL_SECONDS`, `AUTH_SECRET_MIN_LENGTH`,
`ACCOUNT_API_ERRORS`, `ErrorResponseSchema`, `AccountUserSchema`, `SessionResponseSchema`,
`HealthResponseSchema`). Phase 4 Task 1 (`docs/plans/phase-4-accounts-telemetry.md`). Each line maps
to one named test.

## Decisions
- **A lean API.** `apps/backend` is a Hono app built by `createApp(deps)`; tests drive it with
  `app.request()` and never open a port. `src/server.ts` serves it on `127.0.0.1` for local runs.
  Nothing is deployed from this repo.
- **better-auth owns web sign-in**: email and password, and magic links, under `AUTH_BASE_PATH`,
  stored through its Drizzle adapter in Postgres (PGlite in tests and in dev without `DATABASE_URL`).
  Its anonymous usage telemetry is turned off.
- **An email address is proven before a password signs in.** Sign-up sends a verification link and
  creates no session; password sign-in is refused until the address is verified. A magic link proves
  the address by itself (better-auth then drops any unproven password a squatter set beforehand).
- **Links are single-use and short-lived**, stored hashed: magic links `MAGIC_LINK_TTL_SECONDS`,
  verification links `EMAIL_VERIFICATION_TTL_SECONDS`.
- **Email is abstract** (`EmailTransport.send({ to, subject, text, html? })`). `console` prints the
  message, link included, and is for local development only: `NODE_ENV=production` refuses it. Tests
  use an in-memory transport. Nothing else logs a password, token or link.
- **One door for "who is this".** `/v1/session` (and every later authenticated route) asks a chain of
  principal resolvers: an `Authorization: Bearer` header goes to the bearer verifier (Task 3's desktop
  tokens; without one, a bearer is refused), otherwise the better-auth web session cookie. A presented
  but invalid credential is 401; it never falls through to another credential.
- **Errors are codes.** The backend's own routes answer `{ error }` with an `ACCOUNT_API_ERRORS` code;
  no stack, query or value is ever reflected. Answers are `Cache-Control: no-store`.
- **Forward-only migrations.** Ordered SQL files in `apps/backend/drizzle/`, applied in one transaction
  under an advisory lock and recorded with a checksum; an applied file that changed refuses to start.

## Environment (`apps/backend/src/__tests__/auth.test.ts`)
- `env-refuses-missing-secret` — no `BETTER_AUTH_SECRET` refuses startup; the error names the variable.
- `env-refuses-short-secret` — a secret shorter than `AUTH_SECRET_MIN_LENGTH` refuses startup; the error never echoes the value.
- `env-defaults` — no `DATABASE_URL` means a local PGlite directory; `console` email, port 8787, `127.0.0.1`.
- `env-refuses-console-email-in-production` — `EMAIL_TRANSPORT=console` with `NODE_ENV=production` refuses startup.

## Sign-in (`apps/backend/src/__tests__/auth.test.ts`)
- `sign-up-with-password` — creates the account, sends a verification link through the transport, and sets no session.
- `sign-in-with-password` — after the address is verified, the password signs in and sets a session cookie.
- `unverified-password-sign-in-refused` — before verification the right password is refused.
- `wrong-password-refused` — a wrong password is refused with no session cookie, the same way as an unknown email.
- `magic-link-signs-in` — the link goes through the transport; following it signs in (a new address gets an account).
- `magic-link-single-use` — a followed link does not sign in a second time.
- `console-transport-prints-link` — the dev transport writes the recipient, subject and text (with the link) to its sink.

## Session (`apps/backend/src/__tests__/auth.test.ts`)
- `session-answers-signed-in-user` — a signed-in web session cookie answers `SessionResponse` with the user and its expiry.
- `session-401-without-credentials` — no cookie and no bearer is 401 `{ error: 'unauthorized' }`.
- `session-401-after-sign-out` — a signed-out cookie is 401.
- `session-bearer-hook` — a bearer is refused without a verifier; with one, its user answers; an invalid bearer never falls back to the cookie.
- `answers-match-spec` — `/healthz`, `/v1/session` and error answers validate against the spec's schemas.
- `answers-carry-no-secret` — the session answer carries no session token, password or hash; it is `no-store`.
- `unknown-route-404` — an unknown path answers 404 `{ error: 'not_found' }`.

## Migrations (`apps/backend/src/__tests__/migrate.test.ts`)
- `migrations-apply-in-order` — every file in `drizzle/` applies in name order and creates better-auth's tables.
- `migrations-are-idempotent` — a second run applies nothing.
- `migration-edit-refused` — an applied migration whose SQL changed refuses to migrate.
