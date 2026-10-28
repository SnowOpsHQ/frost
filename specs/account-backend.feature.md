# Feature: account backend — web sign-in and session

Spec: `specs/account-api.schema.ts` (`AUTH_BASE_PATH`, `AUTH_ROUTES`, `AUTH_ENDPOINT_METHODS`,
`SESSION_PATH`, `HEALTH_PATH`, `PASSWORD_LIMITS`, `ACCOUNT_USER_LIMITS`, `MAGIC_LINK_TTL_SECONDS`,
`EMAIL_VERIFICATION_TTL_SECONDS`, `AUTH_RATE_LIMITS`, `AUTH_SECRET_MIN_LENGTH`, `ACCOUNT_API_ERRORS`,
`ErrorResponseSchema`, `AccountUserSchema`, `SessionResponseSchema`, `HealthResponseSchema`; for
desktop authorization `DESKTOP_AUTHORIZE_PATH`, `DESKTOP_TOKEN_PATH`, `DESKTOP_PAGE_PATHS`,
`SIGN_OUT_PATH`, `LOOPBACK_REDIRECT_PATTERN`, `DESKTOP_STATE_LIMITS`, `CODE_VERIFIER_PATTERN`,
`DESKTOP_CODE_TTL_SECONDS`, `DESKTOP_TOKEN_TTL_DAYS`, `DESKTOP_RECENT_AUTH_SECONDS`, `DESKTOP_RATE_LIMITS`,
`requestFingerprint`, `REQUEST_FINGERPRINT_PATTERN`,
`DesktopAuthorizeQuerySchema`, `DesktopTokenRequestSchema`, `DesktopTokenResponseSchema`). Phase 4
Tasks 1 and 3 (`docs/plans/phase-4-accounts-telemetry.md`). Each line maps to one named test.

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
- `env-trusted-proxies-validated` — a `TRUSTED_PROXIES` entry that is not an IP or `IP/<digits>` within the family's bits (`10.0.0.1/`, `10.0.0.1/33`, `10.0.0.1/x`, a name) refuses startup, naming the variable.

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

## Desktop authorization — decisions
- **Loopback redirect + PKCE, OAuth's names.** The desktop opens `GET DESKTOP_AUTHORIZE_PATH` with
  `redirect_uri`, `state`, `code_challenge` and `code_challenge_method=S256` in the system browser.
  `redirect_uri` must be exactly `http://127.0.0.1:<1024-65535>/callback` (`LOOPBACK_REDIRECT_PATTERN`,
  an exact string match: no `localhost`, no `[::1]`, no `https`, no other path, query or fragment);
  `state` is 16 to 128 unreserved characters; the challenge is S256 only. Each parameter appears once.
  Anything invalid answers a plain 400 page that names no value and never redirects.
- **frost's own pages.** Signed out, the page offers password sign-in, a magic link and sign-up; each
  form posts same-origin to a `DESKTOP_PAGE_PATHS` route that calls the matching better-auth endpoint
  through its handler (so its rate limits and origin checks apply) and comes back to the authorize
  URL. Magic links and verification links carry the authorize URL as their callback, so following one
  lands on the same request. Sign-up says "check your email"; a password signs in only once the
  address is verified. Signed in (web cookie, verified address) **recently** (the session was created
  within `DESKTOP_RECENT_AUTH_SECONDS`), the page says "Continue to frost as <email>", with Continue
  and "Not you? Sign out"; an older session gets the sign-in page again for this request.
- **Another local program cannot ride a signed-in browser.** Any program can listen on a loopback port
  and open an authorize request of its own. So Continue needs a recent sign-in, issuing a code ends
  the web session (better-auth's session is revoked and its cookie cleared, so the next desktop
  request needs real credentials), and the Continue page shows `requestFingerprint(code_challenge)`
  ("Check that frost shows the same code: XXXX-XXXX. If you didn't just choose Sign in in frost, close
  this page."), which the app shows too while it waits.
- **Pages are inert.** Hand-written HTML with no script; every interpolated value is escaped.
  `Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; form-action 'self' [the loopback
  origin, on the Continue page only]; frame-ancestors 'none'; base-uri 'none'`, `X-Frame-Options:
  DENY`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. `Referrer-Policy: same-origin`,
  not `no-referrer`: under `no-referrer` a browser sends `Origin: null` on a form `POST`, which would
  defeat the same-origin check below; `same-origin` still sends nothing to another origin (the loopback
  redirect carries no `Referer`). The Continue page lists the loopback origin in `form-action` because
  browsers apply `form-action` to the redirect that follows the form.
- **Continue is a same-origin `POST` with the web session.** `POST DESKTOP_AUTHORIZE_PATH` needs
  `Origin` equal to the API origin and, when present, `Sec-Fetch-Site: same-origin`; anything else is
  403 and issues nothing. It re-validates the parameters, then issues a one-time code (32 random bytes,
  base64url) stored as its SHA-256 with the user, the challenge and the `redirect_uri`, valid
  `DESKTOP_CODE_TTL_SECONDS`, and answers 303 to `redirect_uri?code=…&state=…`. Without a session it
  answers 303 back to the authorize page.
- **The exchange.** `POST DESKTOP_TOKEN_PATH` takes JSON (`DesktopTokenRequestSchema`), no cookies.
  The code is consumed atomically (`UPDATE … WHERE consumed_at IS NULL RETURNING`) before anything else
  is checked, so a wrong verifier or redirect burns it too. Then: unexpired, `redirect_uri` equal,
  `BASE64URL(SHA-256(code_verifier))` equal to the challenge (constant-time). A code presented a second
  time revokes the token issued from it (RFC 6749 §4.1.2), also when both arrive at once: the replay
  marks the code `replayed_at`, and the winner re-reads that mark after storing its token and revokes
  it if set. Every failure is 400 `invalid_grant` (a
  malformed body `invalid_request`); `DESKTOP_RATE_LIMITS.token` per client IP. Success mints a desktop
  token (`frost_dt_` + 32 random bytes), stored as its SHA-256, valid `DESKTOP_TOKEN_TTL_DAYS`,
  answered as `DesktopTokenResponse`, `no-store`.
- **Rate-limit keys.** The desktop endpoints key on the client IP as better-auth does: IPv6 grouped by
  /64, an IPv4-mapped IPv6 address as its IPv4. `TRUSTED_PROXIES` entries are an IP or `IP/<digits>`
  within the family's bits; anything else refuses startup.
- **The desktop's callback** answers `Referrer-Policy: no-referrer`, loads no subresources, and
  redirects to a code-free URL on the listener (Task 5; documented in the spec).
- **Desktop tokens are bearers.** `SESSION_PATH` and `/v1/entitlements` accept them through the bearer
  resolver; unknown, expired, revoked, or of an unverified account is 401. `SIGN_OUT_PATH` takes the
  bearer alone (a cookie is ignored), revokes it and answers 204 every time for a well-formed bearer.
  Only hashes are stored: the database never holds a raw code or token (a `CHECK` allows only 64 hex
  characters).

## Desktop authorization (`apps/backend/src/__tests__/desktop-auth.test.ts`)
- `loopback-redirect-pattern` — exactly `http://127.0.0.1:<1024-65535>/callback`; `localhost`, `[::1]`, `https`, another path, a query, a trailing slash, user info or a port with a leading zero do not match.
- `authorize-refuses-bad-redirect` — a non-loopback, `localhost`, `https` or other-path `redirect_uri` answers a 400 page with no `Location`.
- `authorize-refuses-bad-params` — a missing, short, oversized or non-unreserved `state`, a malformed challenge, `plain`, or a repeated parameter answers a 400 page with no `Location`.
- `authorize-signed-out-shows-sign-in` — signed out, the page has the password, magic-link and sign-up forms, each posting to its `DESKTOP_PAGE_PATHS` route with the authorize parameters.
- `authorize-signed-in-shows-continue` — with a recent web session the page says "Continue to frost as <email>" with Continue and "Not you? Sign out".
- `continue-shows-fingerprint` — the Continue page shows `requestFingerprint(code_challenge)` with the "Check that frost shows the same code" copy; `request-fingerprint` — the spec function is `XXXX-XXXX` in Crockford base32 of SHA-256(challenge)'s first 40 bits, deterministic, and refuses a non-challenge.
- `continue-needs-recent-sign-in` — a session older than `DESKTOP_RECENT_AUTH_SECONDS` gets the sign-in page (GET) or 303 back to it (Continue) and no code; signing in again on the page allows Continue.
- `continue-ends-web-session` — once the code is issued the web session is revoked and its cookie cleared; the same cookie cannot Continue again.
- `pages-carry-security-headers` — every page (sign-in, continue, error, check-email) has the CSP, `X-Frame-Options: DENY`, `no-store`, `Referrer-Policy: same-origin` and no script.
- `pages-escape-hostile-values` — a hostile email on the continue page and in a re-shown form is escaped; a hostile `state` is refused and not reflected.
- `sign-up-shows-check-email` — the sign-up form shows "check your email"; the password is refused with a message until the address is verified, then signs in and returns to the authorize URL.
- `magic-link-round-trip` — a magic link asked for on the page lands back on the authorize page, signed in, showing Continue.
- `page-sign-out` — "Not you? Sign out" ends the web session and returns to the sign-in page.
- `page-forms-need-same-origin` — the sign-in, sign-up, magic-link and sign-out forms from another origin are 403.
- `continue-issues-code` — Continue answers 303 to `redirect_uri?code&state`; the stored code is its hash, bound to the user, challenge and redirect, expiring in `DESKTOP_CODE_TTL_SECONDS`.
- `continue-refuses-cross-site` — Continue with another `Origin`, `Origin: null`, no `Origin`, or `Sec-Fetch-Site: cross-site` is 403 and issues no code.
- `continue-needs-web-session` — Continue without a session answers 303 back to the authorize page and issues no code.
- `desktop-full-flow` — sign up, verify, sign in on the page, Continue, exchange: the token answers `/v1/session` and `/v1/entitlements` as that user.
- `token-wrong-verifier-refused` — a wrong verifier is `invalid_grant` and burns the code.
- `token-reused-code-refused` — a code's second exchange is `invalid_grant` and revokes the token the first one issued.
- `token-concurrent-replay-revokes` — two exchanges of one code at once: at most one succeeds, and any token issued for it ends up revoked.
- `token-expired-code-refused` — a code older than `DESKTOP_CODE_TTL_SECONDS` is `invalid_grant`.
- `token-other-redirect-refused` — a `redirect_uri` other than the authorize request's is `invalid_grant`.
- `token-malformed-request` — not JSON, another grant type, or a short verifier is 400 `invalid_request`; answers are `no-store`.
- `token-rate-limited` — the exchange after `DESKTOP_RATE_LIMITS.token.max` in a window is 429 `rate_limited` with `Retry-After`.
- `client-ip-groups-ipv6` — rate-limit keys group IPv6 by /64 and map `::ffff:a.b.c.d` to IPv4 (peer and proxy header alike); two peers in one /64 share the exchange's bucket.
- `tokens-stored-hashed` — neither the raw code nor the raw token is anywhere in the database.
- `bearer-expired-or-revoked-401` — a desktop token past `DESKTOP_TOKEN_TTL_DAYS`, or revoked, is 401 on `/v1/session` and `/v1/entitlements`.
- `sign-out-revokes-idempotent` — `SIGN_OUT_PATH` revokes the bearer (then 401) and answers 204 again for the same token; without a bearer, or with only a cookie, it is 401.

## Admin CLI database (`apps/backend/src/__tests__/cli.test.ts`)
The CLI's other scenarios are in `specs/entitlements.feature.md` (Admin CLI); every exit code is an
exact `CLI_EXIT` value.
- `cli-database-env-production` — `parseDatabaseEnv` applies the production rule: `NODE_ENV=production` without `DATABASE_URL` refuses, naming the variable.
- `cli-database-target` — the CLI prints its target to stderr: the PGlite directory, or `Postgres <host>` with no user, password or database URL.
- `cli-keygen-exit-codes` — a malformed `kid` exits `CLI_EXIT.usage`; any other keygen failure exits `CLI_EXIT.failed`.
- `cli-revoke` — `revoke <email>` revokes every desktop token of the account and deletes its web sessions (both then 401), reporting the counts; an unknown account exits `CLI_EXIT.failed`.
