# Feature: account backend — web sign-in and session

Spec: `specs/account-api.schema.ts` (`AUTH_BASE_PATH`, `AUTH_ROUTES`, `AUTH_ENDPOINT_METHODS`,
`SESSION_PATH`, `HEALTH_PATH`, `PASSWORD_LIMITS`, `ACCOUNT_USER_LIMITS`, `MAGIC_LINK_TTL_SECONDS`,
`EMAIL_VERIFICATION_TTL_SECONDS`, `AUTH_RATE_LIMITS`, `AUTH_SECRET_MIN_LENGTH`, `ACCOUNT_API_ERRORS`,
`ErrorResponseSchema`, `AccountUserSchema`, `SessionResponseSchema`, `HealthResponseSchema`). Phase 4 Task 1 (`docs/plans/phase-4-accounts-telemetry.md`). Each line maps
to one named test.

## Decisions
- **A lean API.** `apps/backend` is a Hono app built by `createApp(deps)`; tests drive it with
  `app.request()` and never open a port. `src/server.ts` serves it on `127.0.0.1` for local runs.
  Nothing is deployed from this repo.
- **better-auth owns web sign-in**: email and password, and magic links, under `AUTH_BASE_PATH`,
  stored through its Drizzle adapter in Postgres (PGlite in tests and in dev without `DATABASE_URL`),
  multi-step writes in one transaction. Only `AUTH_ENDPOINT_METHODS` are served; every other path under
  `AUTH_BASE_PATH` is 404. Its anonymous usage telemetry is off, and the environment switches that
  would turn it back on refuse startup. Its origin and callback-URL checks are switched on explicitly
  (better-auth turns them off under `NODE_ENV=test`), so tests run with production's protections.
- **An email address is proven before a password signs in.** Sign-up sends a verification link and
  creates no session; password sign-in is refused until the address is verified. A magic link proves
  the address by itself (better-auth then drops any unproven password a squatter set beforehand).
- **Magic links are single-use and short-lived** (`MAGIC_LINK_TTL_SECONDS`), stored hashed, and
  consumed by the `GET` that follows them. **Verification links** are stateless signed tokens: not
  stored, valid until `EMAIL_VERIFICATION_TTL_SECONDS` runs out, and they verify the address only
  (auto sign-in after verification stays off). Callback URLs must be on a trusted origin.
- **Cross-site writes are refused.** A `POST` to an auth endpoint whose `Origin` is not trusted, or
  that a browser marks `Sec-Fetch-Site: cross-site`, is 403 before better-auth sees it; better-auth's
  own origin check then covers cookie-bearing writes (including a foreign `Referer`).
- **Rate limits per client IP** (`AUTH_RATE_LIMITS`, 429 with `X-Retry-After`), in every environment,
  with counters per app. The client IP is the TCP peer, which the app writes into its own header and
  a client cannot set; behind a reverse proxy it is the proxy's header (`CLIENT_IP_HEADER`), its chain
  walked past `TRUSTED_PROXIES`.
- **Accounts are bounded** (`ACCOUNT_USER_LIMITS`) on create and update, and `/v1/session` parses its
  own answer against `SessionResponseSchema`, so it never answers what the desktop would refuse.
- **Email is abstract** (`EmailTransport.send({ to, subject, text, html? })`). `console` prints the
  message, link included, and is for local development only: `NODE_ENV=production` refuses it. Tests
  use an in-memory transport. Nothing else logs a password, token or link: unexpected errors reach the
  app's handler, which logs their name only, and better-auth's logger keeps a message's first line
  with addresses and token-like strings masked, dropping its extra arguments.
- **One door for "who is this".** `/v1/session` (and every later authenticated route) asks a chain of
  principal resolvers: an `Authorization: Bearer` header goes to the bearer verifier (Task 3's desktop
  tokens; without one, a bearer is refused; a verifier that throws refuses too; the scheme is
  case-insensitive), otherwise the better-auth web session cookie. A presented but invalid credential
  is 401; it never falls through to another credential. On an unsafe method the cookie counts only for
  a same-origin request (`Origin`, else `Sec-Fetch-Site`); desktop write routes use the bearer alone.
- **Errors are codes.** The backend's own routes answer `{ error }` with an `ACCOUNT_API_ERRORS` code;
  no stack, query or value is ever reflected. Answers are `Cache-Control: no-store`. better-auth's JSON
  answers drop the session `token` (the cookie carries it).
- **A bounded database.** The node-postgres pool has connect, statement and query timeouts and logs a
  pool error by name; `/healthz` answers 503 when the database fails or does not answer in 3 s.
- **Forward-only migrations.** Ordered SQL files in `apps/backend/drizzle/`, applied in one transaction
  under an advisory lock and recorded with a checksum; an applied file that changed refuses to start.

## Environment (`apps/backend/src/__tests__/auth.test.ts`)
- `env-refuses-missing-secret` — no `BETTER_AUTH_SECRET` refuses startup; the error names the variable.
- `env-refuses-short-secret` — a secret shorter than `AUTH_SECRET_MIN_LENGTH` refuses startup; the error never echoes the value.
- `env-defaults` — no `DATABASE_URL` means a local PGlite directory; `console` email, port 8787, `127.0.0.1`.
- `env-refuses-console-email-in-production` — `EMAIL_TRANSPORT=console` with `NODE_ENV=production` refuses startup.
- `env-production-needs-https-and-postgres` — in production `BETTER_AUTH_URL` must be `https://` and `DATABASE_URL` is required.
- `env-auth-url-is-a-bare-origin` — a `BETTER_AUTH_URL` with a path, query, fragment or credentials refuses startup.
- `env-refuses-telemetry-overrides` — `BETTER_AUTH_TELEMETRY`, `…_ENDPOINT` or `…_DEBUG` set refuses startup.
- `env-client-ip` — `CLIENT_IP_HEADER` (a header name) and `TRUSTED_PROXIES` (comma-separated) parse; unset means the TCP peer.

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

## Hardening (`apps/backend/src/__tests__/auth-hardening.test.ts`)
- `magic-link-drops-squatter-password` — an unverified password someone set on the address is removed when its owner signs in by magic link.
- `duplicate-sign-up-is-generic` — signing up an existing address answers like a new one, and its password never becomes the account's.
- `cross-origin-auth-post-refused` — a write from another `Origin`, a `Sec-Fetch-Site: cross-site` fetch, and a cookie-bearing write with a foreign `Referer` are 403.
- `foreign-callback-refused` — a magic link asked for, or followed, with a callback on another origin is 403 and signs nobody in.
- `sign-in-rate-limited` — the sign-in after `AUTH_RATE_LIMITS.signIn.max` in a window is 429; a client-sent IP header changes nothing; another peer is not locked out.
- `user-fields-bounded` — a name or email over `ACCOUNT_USER_LIMITS` is refused at sign-up.
- `auth-endpoints-allowlisted` — better-auth endpoints outside `AUTH_ENDPOINT_METHODS` (or with another method) are 404.
- `auth-answers-carry-no-session-token` — sign-in and get-session answers carry no session token.
- `db-errors-not-logged` — a failing query answers 500 `internal`; nothing logged carries the email, name, hash or query parameters.
- `session-answer-validated` — a principal that would break `SessionResponseSchema` answers 500 `internal`, not the bad body.
- `bearer-verifier-errors-and-scheme` — a throwing verifier is 401; `bearer`/`BEARER` are accepted.
- `cookie-on-unsafe-method-needs-same-origin` — on `POST` the cookie counts with a same-origin `Origin` or `Sec-Fetch-Site`, not with none or another site.
- `healthz-503-when-db-closed` — `/healthz` answers 503 `unavailable` once the database is closed.

## Migrations (`apps/backend/src/__tests__/migrate.test.ts`)
- `migrations-apply-in-order` — every file in `drizzle/` applies in name order and creates better-auth's tables.
- `migrations-are-idempotent` — a second run applies nothing.
- `migration-edit-refused` — an applied migration whose SQL changed refuses to migrate.
- `migration-missing-refused` — an applied migration missing from the build refuses to migrate.
- `migration-out-of-order-refused` — a new migration numbered before the latest applied one refuses, and applies nothing.
