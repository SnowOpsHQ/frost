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
| `BETTER_AUTH_URL` | `http://127.0.0.1:$PORT` | The public base URL; links in emails point here and its origin is trusted. Must be `https://` when `NODE_ENV=production`. |
| `DATABASE_URL` | unset | `postgres://` URL (node-postgres). Unset → PGlite in `PGLITE_DIR`. |
| `PGLITE_DIR` | `apps/backend/.data/pglite` | The dev PGlite directory. |
| `EMAIL_TRANSPORT` | `console` | `console` prints emails; development only, refused when `NODE_ENV=production`. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `8787` | Listen port. |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |

Later tasks add `ENTITLEMENT_SIGNING_KEY` and `ENTITLEMENT_KEY_ID` (Task 2).

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{ status: 'ok' }`; 503 `{ error: 'unavailable' }` when the database does not answer. |
| `GET /v1/session` | `SessionResponse` for a signed-in web session cookie (or, from Task 3, a desktop bearer); 401 `{ error: 'unauthorized' }` otherwise. `no-store`. |
| `GET\|POST /api/auth/*` | better-auth: `sign-up/email`, `sign-in/email`, `sign-in/magic-link`, `magic-link/verify`, `verify-email`, `sign-out`, … |

Sign-up sends a verification link; a password signs in only once the address is verified. Magic
links prove the address themselves, work once, expire after 10 minutes and are stored hashed.
better-auth's own telemetry is off.

### Authenticated routes and bearer tokens

`src/principal.ts` resolves "who is this request" through a chain: an `Authorization: Bearer`
header goes to `AppDeps.verifyBearer` (desktop tokens, Task 3; without a verifier every bearer is
refused), otherwise the better-auth session cookie. A presented but invalid credential is 401 and
never falls through to another. A new route uses the same chain:

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
refused in production. Unhandled errors log their name and route only.
