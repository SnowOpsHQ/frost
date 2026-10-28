# @app/backend

frost's account API: web sign-in (email and password, magic links) and the session the desktop
reads. Hono + [better-auth](https://www.better-auth.com) + Drizzle on Postgres. Phase 4
(`docs/plans/phase-4-accounts-telemetry.md`); behaviour in `specs/account-backend.feature.md`, the
answers the desktop parses in `specs/account-api.schema.ts`.

> **Never deploy from this repo.** The backend runs locally and in tests only. No hosting config,
> credential or DSN lives here; a deployment is set up elsewhere, with its own secrets.

## Run locally

```sh
cp apps/backend/.env.example apps/backend/.env   # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
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
| `EMAIL_TRANSPORT` | `console` | `console` prints emails; development only, refused when `NODE_ENV=production`. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `8787` | Listen port. |
| `CLIENT_IP_HEADER` | unset | Only behind a reverse proxy: the header it sets with the client IP (e.g. `x-forwarded-for`). Unset → the TCP peer address, and any client-sent IP header is ignored. Never set it without a proxy in front: clients could then choose their rate-limit key. |
| `TRUSTED_PROXIES` | unset | With `CLIENT_IP_HEADER`: comma-separated proxy IPs/CIDRs skipped when walking a forwarded chain. Without it, only a single-value header is trusted. |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |

`BETTER_AUTH_TELEMETRY`, `BETTER_AUTH_TELEMETRY_ENDPOINT` and `BETTER_AUTH_TELEMETRY_DEBUG` must
not be set (better-auth would turn its telemetry back on); startup refuses them. Later tasks add
`ENTITLEMENT_SIGNING_KEY` and `ENTITLEMENT_KEY_ID` (Task 2).

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{ status: 'ok' }`; 503 `{ error: 'unavailable' }` when the database does not answer. |
| `GET /v1/session` | `SessionResponse` for a signed-in web session cookie (or, from Task 3, a desktop bearer); 401 `{ error: 'unauthorized' }` otherwise. `no-store`. |
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
header goes to `AppDeps.verifyBearer` (desktop tokens, Task 3; without a verifier every bearer is
refused, and so is one whose verifier throws), otherwise the better-auth session cookie. A presented
but invalid credential is 401 and never falls through to another. On an unsafe method (`POST` …)
the cookie counts only for a same-origin request (`Origin`, else `Sec-Fetch-Site`); desktop write
routes should take `[bearerResolver(verify)]` alone. `createAppParts(deps)` answers the app, the
better-auth instance and the resolver list. A new route uses the same chain:

```ts
app.get('/v1/something', requirePrincipal(resolvers), (c) => c.json(answerFor(c.get('principal').user)));
```

## Database and migrations

The schema is written by hand in `src/db/schema.ts` (better-auth's `user`, `session`, `account` and
`verification` models, as `users`, `sessions`, `accounts`, `verifications`). Migrations are plain SQL
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
memory transport (`createMemoryTransport()`).

## Logging

Nothing logs a password, token, cookie or database URL. The one exception is the console email
transport, which prints sign-in and verification links: it exists for local development and is
refused in production. Unhandled errors (better-auth rethrows them, `onAPIError.throw`) log their
name and route only: a driver error's message carries the query's parameters. better-auth's own log
lines keep only the first line of the message, with addresses and token-like strings masked, and
drop their extra arguments (`src/log.ts`).
