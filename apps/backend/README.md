# @app/backend

frost's account API: web sign-in (email and password, magic links), desktop sign-in through the
system browser (loopback redirect + PKCE, then a revocable desktop token), the session the desktop
reads, and signed entitlement snapshots (which plan, which features). Hono + [better-auth](https://www.better-auth.com) + Drizzle on Postgres. Phase 4
(`docs/plans/phase-4-accounts-telemetry.md`); behaviour in `specs/account-backend.feature.md`, the
answers the desktop parses in `specs/account-api.schema.ts`; entitlements in
`specs/entitlements.feature.md` and `specs/entitlements-snapshot.spec.ts`.

> **Never deploy from this repo.** The backend runs locally and in tests only. No hosting config,
> credential or DSN lives here; a deployment is set up elsewhere, with its own secrets.

## Run locally

```sh
cp apps/backend/.env.example apps/backend/.env   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm --filter @app/backend admin keygen          # copy ENTITLEMENT_KEY_ID and ENTITLEMENT_SIGNING_KEY into .env
set -a; . apps/backend/.env; set +a
pnpm --filter @app/backend dev
```

`dev` runs `src/server.ts` with `tsx`. It listens on `http://127.0.0.1:8787`, applies pending
migrations at start, and with no `DATABASE_URL` keeps its data in a PGlite directory
(`apps/backend/.data/pglite`, gitignored). Sign-in emails go to the console transport, which prints
them, sign-in links included, to stdout.

## Environment

Parsed by `src/env.ts`; anything invalid refuses to start (the message names the variable, never its
value). An empty value counts as unset.

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_AUTH_SECRET` | (required) | At least 32 characters. Signs cookies and verification tokens. |
| `BETTER_AUTH_URL` | `http://127.0.0.1:$PORT` | The public base URL, a bare origin (no path or query); links in emails point here and its origin is trusted. Must be `https://` when `NODE_ENV=production`. |
| `DATABASE_URL` | unset | `postgres://` URL (node-postgres). Unset → PGlite in `PGLITE_DIR`. Required when `NODE_ENV=production`. |
| `PGLITE_DIR` | `apps/backend/.data/pglite` | The dev PGlite directory. |
| `EMAIL_TRANSPORT` | `console` | `console` prints emails; development only, refused when `NODE_ENV=production`. It is the only transport so far: a real one is still to be written before any deployment. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `8787` | Listen port. |
| `CLIENT_IP_HEADER` | unset | Only behind a reverse proxy: the header it sets with the client IP (e.g. `x-forwarded-for`). Unset → the TCP peer address, and any client-sent IP header is ignored. Never set it without a proxy in front: clients could then choose their rate-limit key. |
| `TRUSTED_PROXIES` | unset | With `CLIENT_IP_HEADER`: comma-separated proxy IPs/CIDRs skipped when walking a forwarded chain. Without it, only a single-value header is trusted. Each entry is an IP or `IP/<digits>` within its family (32 or 128 bits); anything else (`10.0.0.1/`, `10.0.0.1/33`, a host name) refuses startup. |
| `ENTITLEMENT_SIGNING_KEY` | (required) | The private Ed25519 JWK (JSON: `kty` `OKP`, `crv` `Ed25519`, `x`, `d`) that signs snapshots. Secret. Startup refuses a key that is not JSON, not Ed25519, has no `d`, has another `kid`, or whose `d` does not match its `x`; the message never shows the key. |
| `ENTITLEMENT_KEY_ID` | (required) | Its `kid` (`ENTITLEMENT_KEY_ID_PATTERN`), put in every snapshot's header. |
| `ENTITLEMENT_PUBLIC_KEYS` | unset | During a rotation: a JWKS (`{"keys":[…]}`) of old **public** keys still published next to the signing key. A private member (`d`) or a repeated `kid` refuses startup. |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |

`BETTER_AUTH_TELEMETRY`, `BETTER_AUTH_TELEMETRY_ENDPOINT` and `BETTER_AUTH_TELEMETRY_DEBUG` must
not be set (better-auth would turn its telemetry back on); startup refuses them.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{ status: 'ok' }`; 503 `{ error: 'unavailable' }` when the database does not answer. |
| `GET /v1/session` | `SessionResponse` for a desktop bearer token or a signed-in web session cookie (`expiresAt`: the credential's expiry); 401 `{ error: 'unauthorized' }` otherwise. `no-store`. |
| `GET /v1/entitlements` | `{ snapshot }` (`EntitlementsResponse`) for the same principals as `/v1/session`; 401 otherwise. `no-store`. |
| `POST /v1/sign-out` | Bearer only (a cookie is ignored): revokes that desktop token; 204 every time for a well-formed bearer (unknown, expired or already revoked included); 401 without one. |
| `GET /desktop/authorize` | The desktop sign-in page (HTML): sign-in forms when signed out, "Continue to frost as …" when signed in; a plain 400 page for invalid parameters. See [Desktop sign-in](#desktop-sign-in). |
| `POST /desktop/authorize` | Continue (same-origin form + web session): 303 to `redirect_uri?code=…&state=…`. |
| `POST /desktop/sign-in`, `/desktop/sign-up`, `/desktop/magic-link`, `/desktop/sign-out` | The page's own forms (same-origin only); each calls the matching better-auth endpoint and answers a page or 303 back to `/desktop/authorize`. |
| `POST /desktop/token` | JSON code + PKCE verifier → `DesktopTokenResponse` (`token`, `expiresAt` in ms, `user`); 400 `invalid_request` / `invalid_grant`, 429 `rate_limited`. `no-store`. |
| `GET /.well-known/frost-entitlement-keys` | The public JWKS (`EntitlementJwks`): the signing key's public half and any `ENTITLEMENT_PUBLIC_KEYS`. Never a `d`. `public, max-age=300`. |
| `/api/auth/*` | better-auth, only `AUTH_ENDPOINT_METHODS` (`specs/account-api.schema.ts`): `POST sign-up/email`, `POST sign-in/email`, `POST sign-in/magic-link`, `GET magic-link/verify`, `GET verify-email`, `GET get-session`, `POST sign-out`. Anything else is 404. JSON answers never carry the session token (the `HttpOnly` cookie does). |

- Sign-up sends a verification link; a password signs in only once the address is verified.
  Signing up an address that exists answers the same as a new one. Verification links are stateless
  signed tokens (not stored, valid for their hour, reusable until then); they prove the address and
  sign nobody in (auto sign-in after verification is off on purpose).
- Magic links prove the address themselves, are stored hashed, work once and expire after 10
  minutes. Signing in by magic link removes any password someone set on that address before it was
  proven. A link is consumed by the `GET` that follows it, so a mail scanner that prefetches links
  can use it up (the user asks for another). A link sent by an attacker for their own account could
  sign a victim's browser in to it (login CSRF); for the desktop this is answered by its in-app
  "Sign in as …?" confirmation (Task 5), which shows the account before anything is used.
- Callback URLs must be on a trusted origin. A `POST` from another `Origin`, or one a browser marks
  `Sec-Fetch-Site: cross-site`, is 403; better-auth checks cookie-bearing writes again.
- Rate limits per client IP (`AUTH_RATE_LIMITS`: sign-in 3 per 10 s, sign-up and magic links 5 per
  minute, everything else 100 per minute) answer 429 with `X-Retry-After`, in every environment. The
  counters are in memory, per process.
- Names (200) and emails (320 characters) are bounded when an account is created or changed.
- better-auth's own telemetry is off.

### Authenticated routes and bearer tokens

`src/principal.ts` resolves "who is this request" through a chain: an `Authorization: Bearer`
header goes to `AppDeps.verifyBearer` (by default `desktopTokenVerifier`: the desktop tokens in
`desktop_tokens`; tests may stand in their own; a verifier that throws refuses), otherwise the
better-auth session cookie. A presented
but invalid credential is 401 and never falls through to another. On an unsafe method (`POST` …)
the cookie counts only for a same-origin request (`Origin`, else `Sec-Fetch-Site`); desktop write
routes should take `[bearerResolver(verify)]` alone. `createAppParts(deps)` answers the app, the
better-auth instance and the resolver list. A new route uses the same chain:

```ts
app.get('/v1/something', requirePrincipal(resolvers), (c) => c.json(answerFor(c.get('principal').user)));
```

## Desktop sign-in

The desktop signs in through the system browser (RFC 8252 loopback redirect, RFC 7636 PKCE, OAuth's
parameter names). Contract and limits: `specs/account-api.schema.ts`; scenarios:
`specs/account-backend.feature.md` (Desktop authorization); code: `src/desktop-auth.ts` and
`src/desktop-pages.ts`.

1. The desktop listens on `http://127.0.0.1:<port>/callback`, makes a `state` (16–128 unreserved
   characters) and a PKCE verifier (43–128), and opens `GET /desktop/authorize?redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256`.
   `redirect_uri` must be exactly `http://127.0.0.1:<1024-65535>/callback` (`LOOPBACK_REDIRECT_PATTERN`):
   no `localhost`, no `[::1]` (the listener binds `127.0.0.1` only, so one spelling is accepted), no
   `https`, path, query or fragment. Each parameter appears once. Anything invalid is a plain 400 page
   that names no value and never redirects.
2. Signed out, the page offers password sign-in, "email me a sign-in link" and "create an account".
   Their forms post to `/desktop/sign-in` etc., which call better-auth's endpoints through its handler
   (its rate limits and origin checks apply). Magic links and verification links carry the authorize
   URL as their callback, so they land back on the same request; a failed link shows a fixed message.
   Sign-up says "check your email"; the password signs in once the address is verified.
3. Signed in **within the last 10 minutes** (`DESKTOP_RECENT_AUTH_SECONDS`: the better-auth session
   was created, by a sign-in or a new sign-in, that recently), the page says "Continue to frost as
   <email>" with Continue and "Not you? Sign out", and shows the request's fingerprint
   (`requestFingerprint(code_challenge)`, e.g. `1MMS-P7NN`: "Check that frost shows the same code: …
   If you didn't just choose Sign in in frost, close this page."); the app shows the same value while
   it waits. A browser signed in longer ago gets the sign-in page again for this request (its address
   filled in). Continue (`POST /desktop/authorize`) needs that recent web session and `Origin` equal to
   this API's origin (and `Sec-Fetch-Site: same-origin` when sent); it issues a one-time code (32
   random bytes, stored as its SHA-256, bound to the user, challenge and `redirect_uri`, 120 s), **ends
   the web session** (revoked, cookie cleared), and answers 303 to `redirect_uri?code=…&state=…`.
4. The desktop checks `state`, then `POST /desktop/token` (JSON, no cookies) with `grant_type:
   authorization_code`, `code`, `code_verifier`, `redirect_uri`. The code is consumed atomically first
   (so a wrong verifier or redirect burns it), then must be unexpired, for the same `redirect_uri`, and
   match `BASE64URL(SHA-256(code_verifier))` (constant-time). A code presented again revokes the token
   it issued, also when both exchanges run at once (the replay marks the code `replayed_at`; the first
   exchange re-reads the mark after storing its token). Every failure is 400 `{ error: 'invalid_grant' }` (a malformed body `invalid_request`); 10
   exchanges per minute per client IP (`DESKTOP_RATE_LIMITS`), then 429 `rate_limited` with
   `Retry-After`. Success: `{ token, expiresAt, user }`; the token (`frost_dt_…`) is stored as its
   SHA-256 and lasts 30 days.
5. The desktop sends `Authorization: Bearer <token>` to `/v1/session`, `/v1/entitlements` and
   `/v1/sign-out`. Expired, revoked or unknown is 401.

**The desktop's loopback callback** (Task 5) must answer `Referrer-Policy: no-referrer`, load no
subresources (no image, style or script from anywhere), and answer the code-bearing `GET /callback`
with a redirect to a code-free URL on the listener (e.g. `303` to `/done`), so the code stays out of
the address bar, the history and any `Referer`.

Rate limits on the desktop endpoints key on the client IP as better-auth's do: an IPv6 client by its
/64, an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its IPv4 (`src/ip.ts`).

The pages are hand-written HTML with no script; every value is escaped. Headers:
`Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
(the Continue page adds the loopback origin to `form-action`, because browsers check `form-action`
on the redirect that follows the form), `X-Frame-Options: DENY`, `Cache-Control: no-store`, and
`Referrer-Policy: same-origin`: under `no-referrer` a browser sends `Origin: null` on a form `POST`,
which would make the same-origin check impossible; `same-origin` still sends nothing to any other
origin, the loopback included. Only hashes of codes and tokens are stored (`drizzle/0003_desktop_auth.sql`,
a `CHECK` allows 64 hex characters only).

A page cannot tell which app opened it: a local program could start a request to its own loopback
port. Three things stand in its way: Continue needs a sign-in from the last 10 minutes and ends the
web session it used (a browser that is merely still signed in is not enough, and one sign-in yields
one code); the fingerprint lets the user match the page to the app; and the desktop asks again
("Sign in as …?") before it keeps anything.

## Entitlements

An account's plan is a row in `entitlements` (user, plan, updated); no row is `free`. Which features
a plan has is `PLAN_FEATURES` in the spec, applied when signing (`free` → none; `pro` → `ai-agent`,
`search-console`, `sync`); the desktop reads the flags, never the plan.

A snapshot is a compact JWS, header exactly `{ alg: 'EdDSA', kid, typ: 'frost-entitlement+jwt' }`,
claims `iss`, `aud` (`frost-desktop`), `sub` (user ID), `email`, `plan`, `features`, `iat`,
`exp = iat + 3 days`, `ver: 1`, validated against `EntitlementClaimsSchema` before signing
(`src/entitlements.ts`, `jose`). The desktop verifies it with the public keys baked into its build
(`FROST_PUBLIC_ENTITLEMENT_JWKS`) and gives 7 days of offline grace after `exp` (Task 4).

**Key rotation.** `admin keygen` a new key; first ship its public key in a desktop release, listed
next to the old one in `FROST_PUBLIC_ENTITLEMENT_JWKS`; only then switch the server to the new
`ENTITLEMENT_SIGNING_KEY`/`ENTITLEMENT_KEY_ID`, with the old public key in `ENTITLEMENT_PUBLIC_KEYS`.
Keep the old public key in desktop builds and in `ENTITLEMENT_PUBLIC_KEYS` until its last snapshot is
past its life and offline grace (3 + 7 days) and the builds that trust only it are gone.

## Admin CLI

```sh
pnpm --filter @app/backend admin help
pnpm --filter @app/backend admin migrate                  # apply pending migrations
pnpm --filter @app/backend admin keygen [kid]             # new signing key (stdout only)
pnpm --filter @app/backend admin grant alice@example.com pro
pnpm --filter @app/backend admin show alice@example.com
pnpm --filter @app/backend admin revoke alice@example.com # sign out everywhere
```

With PGlite (no `DATABASE_URL`), stop `dev` before a command that opens the database and start it
again after: a PGlite directory belongs to one process at a time.

`src/cli.ts` (run with `tsx`) reads only `DATABASE_URL` / `PGLITE_DIR` (and `NODE_ENV`: in
production `DATABASE_URL` is required, as for the server), and prints its target to stderr before a
command that opens the database (`admin: database: PGlite <dir>` or `admin: database: Postgres
<host:port>`, never the user, password or URL). `keygen` prints, labelled,
the server's `ENTITLEMENT_KEY_ID` and `ENTITLEMENT_SIGNING_KEY` (secret) and the desktop's
`FROST_PUBLIC_ENTITLEMENT_JWKS` (public), single-quoted for a `.env`; it writes no file. The `kid`
defaults to the key's RFC 7638 thumbprint. `grant` takes `free` or `pro`; the next snapshot carries
it (snapshots already issued stay valid until they expire, plus offline grace; `grant … free` says
so). `revoke` signs an account out everywhere: it revokes every desktop token, deletes unexchanged
desktop codes and ends every web session, printing the counts (snapshots already issued stay valid
until they expire). Exit codes (`CLI_EXIT`): 0 done; 1 a failure (an unknown account, or keygen/database errors); 2
a usage error (an unknown command or plan, a malformed `kid`), each with a message. Tests call
`runCli(argv, { db, out, err })` directly.

## Database and migrations

The schema is written by hand in `src/db/schema.ts` (better-auth's `user`, `session`, `account` and
`verification` models, as `users`, `sessions`, `accounts`, `verifications`; `entitlements`; and
`desktop_codes` and `desktop_tokens`). Migrations are plain SQL
files in `drizzle/`, named `NNNN_name.sql`, statements separated by `--> statement-breakpoint` lines.
`src/db/migrate.ts` (our own small runner, used for PGlite and node-postgres alike) applies pending
files in name order in one transaction under a Postgres advisory lock and records each in
`schema_migrations` with a SHA-256 of its SQL. It is **forward-only**: an applied file that changed or
disappeared, or a new file numbered before the latest applied one, refuses to migrate. To change the
schema, edit `schema.ts` and add the next numbered file.

Real Postgres goes through a node-postgres pool with a 5 s connect timeout, a 15 s statement
timeout (server and client side) and a name-only `error` listener; `/healthz` answers 503 when the
database errors or takes over 3 s.

## Testing

```sh
pnpm --filter @app/backend test   # vitest; in-memory PGlite per test, no network, no DB service
pnpm --filter @app/backend lint   # tsc --noEmit
```

Tests build the app with `createApp(deps)` and drive it with `app.request()`; emails go to the
memory transport (`createMemoryTransport()`). `AppDeps.now` (a clock the test moves) ages desktop
codes and tokens; desktop-sign-in tests drive the HTML pages by submitting their own forms.

## Logging

Nothing logs a password, token, desktop code, cookie, signing key or database URL. The one exception is the console email
transport, which prints sign-in and verification links: it exists for local development and is
refused in production. Unhandled errors (better-auth rethrows them, `onAPIError.throw`) log their
name and route only: a driver error's message carries the query's parameters. better-auth's own log
lines keep only the first line of the message, with addresses and token-like strings masked, and
drop their extra arguments (`src/log.ts`).
