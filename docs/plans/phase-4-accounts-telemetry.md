# Phase 4 — Accounts, Entitlements, Telemetry and Search Console Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then a failing named test, then the code, then one conventional commit), a fresh reviewer
> before the next task starts, and a whole-branch review at the end. Tasks that handle tokens,
> signatures or OAuth also get a security-focused review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** sign-in, plan gating and honest telemetry:
- a lean backend that signs users in and issues **signed** entitlement snapshots;
- desktop sign-in through the system browser, bound to a pending request and confirmed in the app;
- entitlements verified in main, with offline grace, failing closed to `free`;
- consent-gated telemetry that is **off by default** and does what its toggles say;
- a read-only Search Console connection with a page and site performance panel;
- a Settings view for all of it.

**Architecture.** Phases 0–2.5 hold. New in this phase:
- `apps/backend`: Hono + better-auth + Postgres through Drizzle. It runs locally and in tests only;
  tests use PGlite (in-process Postgres), so CI needs no database service.
- `packages/telemetry`: a consent gate in front of OpenTelemetry (traces) and Sentry (errors). Pure
  Node, no Electron import; main injects the transport.
- Main owns every token. Account and Search Console tokens are stored with `safeStorage` and never
  cross IPC; the chrome sees only state (`AccountState`, `GscStatus`, aggregated performance rows).
- New `enforceSender`-first routers: `account.*`, `gsc.*`, `telemetry.*`.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §3 (security model: "Deep-link login requires an in-app
  confirmation bound to a nonce/pending request"; signed entitlements) and §4 Phase 4.
- UI direction: `docs/ui-reference/README.md`.

## Decisions (design doc §6, made by the lead for this phase)
1. **Product intent: shippable.** Phase 4 is built properly, not as a stub.
2. **No billing in v1.** No Stripe. An entitlement carries a plan (`free` or `pro`) that the backend
   sets; an admin grants plans with the backend's CLI (`pnpm --filter @app/backend admin grant`).
3. **Backend: a lean custom API** (`apps/backend`, Hono + better-auth + Drizzle/Postgres), not a CMS.
4. **VPN: out of scope.**
5. **Nothing is deployed and no cloud resource is created.** The backend runs locally and in tests.
   No credential or DSN is committed; every endpoint and ID is injected (see Configuration).

Decisions this plan makes (each recorded again under As built if it changes):
- **Loopback sign-in, not a `frost://` deep link.** Main listens on `127.0.0.1:<random port>` only
  for the one pending request. A deep link can be fired by any web page or local process and needs
  OS registration per platform; a loopback redirect is bound to a port, a `state` nonce and a PKCE
  verifier that only main knows, and is the same mechanism Search Console's OAuth uses (one module).
  The in-app confirmation still applies: after the code exchange main shows "Sign in as
  alice@example.com?" in the Settings view, and nothing is stored or used until the user confirms.
- **Desktop tokens are the backend's own**, not better-auth web sessions: an opaque random token,
  stored SHA-256-hashed in Postgres, revocable, sent as `Authorization: Bearer`. better-auth owns
  the web sign-in (email and password, magic link) that the system browser uses.
- **Which plan includes which feature is server-side.** The client reads flags, never plans, so a
  plan can change its features without a desktop release. In v1: `free` → no flags; `pro` →
  `ai-agent`, `search-console`, `sync`.
- **Search Console is a `pro` feature** (`search-console`). Phase 4 gates it, which is the phase's
  own demonstration of plan gating. Moving it to `free` is a one-line server change.
- **Secrets need a real keychain.** `safeStorage` with Linux's `basic_text` backend (no keyring) is
  obfuscation, so frost keeps tokens in memory only for that run and says so in Settings.
- **No desktop database migrations.** Secrets and the telemetry consent are small files in
  `userData` (sync reads at startup; consent must be known before anything could be sent). The
  `0020`–`0029` migration range stays reserved for Phase 4 should a later change need a table.
- **Telemetry has no persistent identifier.** No install ID, user ID, machine name or IP. A span
  carries only allowlisted attributes; URLs and PII are stripped from every event.

## Configuration
Public, build-time values (baked into a build; never put a secret here) come from `FROST_PUBLIC_*`
environment variables at build time. An **unpackaged** build (dev, e2e) may also take them from the
environment at run time; a packaged build ignores the runtime environment for these. A value that is
missing disables its feature with an honest "not configured in this build" state.

| Variable | Used by | Meaning |
|---|---|---|
| `FROST_PUBLIC_API_BASE_URL` | desktop | The backend's base URL (`https:` required when packaged). |
| `FROST_PUBLIC_ENTITLEMENT_JWKS` | desktop | JSON JWKS of the Ed25519 public keys that sign snapshots (rotation: several `kid`s). |
| `FROST_PUBLIC_GSC_CLIENT_ID` | desktop | Google OAuth client ID (Desktop app type). |
| `FROST_PUBLIC_GSC_CLIENT_SECRET` | desktop | Google's installed-app "secret" (not confidential by Google's own definition; still never committed). |
| `FROST_PUBLIC_SENTRY_DSN` | desktop | Sentry DSN for error reports (only sent with consent). |
| `FROST_PUBLIC_OTEL_ENDPOINT` | desktop | OTLP/HTTP traces endpoint (only sent with consent). |
| `FROST_GSC_*_URL` (unpackaged only) | desktop e2e | Fake Google OAuth and GSC API endpoints. |
| `DATABASE_URL` | backend | Postgres URL; unset in dev → a local PGlite directory. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | backend | better-auth's secret and public base URL. |
| `ENTITLEMENT_SIGNING_KEY`, `ENTITLEMENT_KEY_ID` | backend | Ed25519 private JWK (server-side only) and its `kid`. |
| `EMAIL_TRANSPORT` | backend | `console` (dev default: magic links are printed) or a real transport later. |

`apps/backend/README.md` and `apps/backend/.env.example` document the backend's; `apps/desktop/README.md`
documents the desktop's.

## Global Constraints
Everything in the Phase 0–2.5 Global Constraints and `CONTRIBUTING.md` still holds, plus:
- **Tokens stay in main.** No procedure answers a token, code, verifier, refresh token or snapshot
  string. Each router test asserts that the serialized answers contain none of the fake secrets.
- **Logs never carry secrets.** Token-bearing values go through a redacting logger; tests assert it.
- **Outbound calls** from main use `net.fetch` with `credentials: 'omit'`, a timeout and no
  redirect following for token endpoints; the API base and Google endpoints are fixed per build.
- **The system browser opens only through `openExternalIfAllowed`** (scheme allowlist) on a live user
  gesture in the app window that asked. A missing gesture answers `needs-gesture` and opens nothing.
- **The loopback listener** binds `127.0.0.1` only, serves only `GET /callback` for one pending
  request, compares `state` in constant time, never reflects query values into its page (fixed HTML,
  `Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`), and closes on success, cancel, or after 10 minutes.
- **Fail closed.** A missing, unsigned, tampered, wrong-`kid`, wrong-audience, wrong-account or
  expired-beyond-grace snapshot is `free`. A verification error is never `pro`.
- **Telemetry defaults off** and nothing leaves the machine before consent; turning a toggle off
  drops what is queued and stops export at once (no final flush).
- **Search Console is read-only:** the only scope ever requested is
  `https://www.googleapis.com/auth/webmasters.readonly`.

## Review Focus
- **A website or another app cannot sign the user in to someone else's account** (login CSRF), nor
  steal the code: state + PKCE + loopback + in-app confirmation (Task 5, `sign-in-needs-confirmation`).
- **A snapshot cannot be forged or replayed past its life** (Task 4, `snapshot-fails-closed`,
  `clock-rollback-does-not-extend-grace`).
- **The renderer never sees a token** (Tasks 5 and 8, `answers-carry-no-secret`).
- **Telemetry UI matches behaviour** (Tasks 6 and 7, `nothing-sent-before-consent`,
  `off-stops-export-immediately`, `events-are-scrubbed`).
- **Search Console asks for read-only access only** (Task 8, `gsc-scope-is-read-only`).

---

### Task 1: Backend foundation — auth and session
- **Spec:** `specs/account-api.schema.ts` (route constants and Zod schemas of every backend answer
  the desktop reads: `SessionResponseSchema`, the error shape) and `specs/account-backend.feature.md`.
- **Build:** `apps/backend` (`@app/backend`): Hono app factory `createApp(deps)` (no listening in
  tests: `app.request()`), env parsing with Zod (`src/env.ts`), Drizzle Postgres schema for
  better-auth's tables, forward-only SQL migrations under `apps/backend/drizzle/` applied by a small
  migrator, better-auth with email and password and the magic-link plugin, an `EmailTransport`
  interface (`console` for dev; a memory transport in tests), `GET /v1/session` (desktop bearer,
  defined in Task 3; this task ships the route for web sessions and the bearer hook point),
  `GET /healthz`. `src/server.ts` runs it locally (`pnpm --filter @app/backend dev`, PGlite when no
  `DATABASE_URL`). `README.md`, `.env.example` (and a package `.gitignore` that keeps it tracked).
- **Failing tests:** `src/__tests__/auth.test.ts` on PGlite: sign up, sign in with password, wrong
  password refused, magic link sent through the transport and verifying it signs in, session
  endpoint answers the user for a signed-in cookie and 401 otherwise, env refuses a missing secret.
- **Turbo:** the package's `test` and `lint` scripts are picked up by `turbo run lint test build`.
- [x] commit `feat(backend): auth API with email/password and magic link`

### Task 2: Backend — signed entitlement snapshots and the admin CLI
- **Spec:** `specs/entitlements-snapshot.spec.ts`: `PLANS`, `FEATURE_FLAGS`, `PLAN_FEATURES`
  (server-side mapping), `ENTITLEMENT_ISSUER`, `ENTITLEMENT_AUDIENCE`, `ENTITLEMENT_JWS_TYPE`,
  `ENTITLEMENT_TTL_SECONDS` (3 days), `OFFLINE_GRACE_SECONDS` (7 days), `MAX_CLOCK_SKEW_SECONDS`,
  `EntitlementClaimsSchema` (`iss`, `aud`, `sub`, `email`, `plan`, `features`, `iat`, `exp`, `ver`);
  header `alg: EdDSA`, `kid`, `typ`. `specs/entitlements.feature.md`.
- **Build:** an `entitlements` table (user, plan, updated) with `free` as the default when absent;
  `GET /v1/entitlements` (desktop bearer) answering `{ snapshot }`, a compact JWS signed with the
  Ed25519 key from `ENTITLEMENT_SIGNING_KEY` (tests generate an ephemeral key);
  `GET /.well-known/frost-entitlement-keys` (the public JWKS); `src/cli.ts` (`admin`):
  `migrate`, `keygen` (prints the private JWK for the server env and the public JWKS for
  `FROST_PUBLIC_ENTITLEMENT_JWKS`), `grant <email> <free|pro>`, `show <email>`.
- **Failing tests:** `entitlements.test.ts`: the snapshot verifies with the public key and carries
  the plan's flags; a granted `pro` shows up in the next snapshot; the private key never appears in
  any response; `kid` matches; CLI `grant` changes the plan; a malformed signing key refuses startup.
- [x] commit `feat(backend): signed entitlement snapshots and admin CLI`

### Task 3: Backend — desktop authorization (loopback + PKCE)
- **Spec:** extend `specs/account-api.schema.ts` (`DESKTOP_AUTHORIZE_PATH`, `DESKTOP_TOKEN_PATH`,
  `DesktopTokenRequestSchema`, `DesktopTokenResponseSchema`, `LOOPBACK_REDIRECT_PATTERN`,
  code and token lifetimes) and `specs/account-backend.feature.md` (Desktop authorization).
- **Build:** `GET /desktop/authorize` (validates `redirect_uri` is exactly
  `http://127.0.0.1:<port>/callback`, `state`, S256 `code_challenge`): signed out → frost's own sign-in
  page (password, magic link, sign-up); signed in → "Continue to frost as …" page. `POST` continue
  (same-origin only: `Origin`/`Sec-Fetch-Site` check) issues a one-time code (hashed, 2 minutes,
  bound to user, challenge and redirect) and redirects to the loopback. `POST /desktop/token` swaps
  code + verifier for a desktop token (hashed at rest, 30 days); `POST /v1/sign-out` revokes it;
  `/v1/session` and `/v1/entitlements` accept it. Pages have a strict CSP and escape every value.
- **Failing tests:** `desktop-auth.test.ts`: full flow; wrong verifier, reused code, expired code,
  other redirect, non-loopback redirect, missing state all refused; cross-site POST refused; revoked
  token is 401; pages escape a hostile email/state.
- [x] commit `feat(backend): desktop authorization with loopback redirect and PKCE`
- [ ] Security review of Tasks 1–3 before Task 4.

### Task 4: Desktop — entitlements core (verification, grace, `requireFeature`)
- **Spec:** `specs/entitlements-snapshot.spec.ts` (from Task 2) plus `specs/entitlements-client.feature.md`
  and `EntitlementsSchema` (what main and the chrome see: `plan`, `features`, `status`
  `none | active | grace | expired | invalid`, `expiresAtMs`, `graceEndsAtMs`) and
  `FEATURE_NOT_ENTITLED_CODE`; `specs/secret-store.spec.ts`.
- **Build (main, `apps/desktop/src/main/account/`):** `secret-store.ts` (named blobs in
  `userData/secrets/`, `safeStorage`-encrypted, atomic, `0600`; memory-only when encryption is
  unavailable or `basic_text`); `entitlements-verify.ts` (pure: JWS EdDSA only, `kid` from the
  embedded JWKS, `iss`/`aud`/`typ`, `sub` must equal the signed-in user, skew cap, offline grace
  only after a failed refresh for network reasons, a stored time high-water mark so moving the clock
  back never extends grace); `entitlements.ts` (`EntitlementsReader`: `current()`, `has(flag)`,
  `requireFeature(flag)`, `onChange`). **ipc-contract:** `requireFeature(flag)` middleware in
  `account-router.ts` (chained after `enforceSender`; `FORBIDDEN` with `FEATURE_NOT_ENTITLED_CODE`).
- **Failing tests:** `entitlements-verify.test.ts` (valid, tampered payload, tampered signature,
  `alg: none`, HS256 with the public key as secret, unknown `kid`, wrong audience, wrong `sub`, future
  `iat`, expired within/after grace, grace only when offline, clock rollback), `secret-store.test.ts`
  (fake `safeStorage`; `basic_text` → memory only; corrupt file → empty), a router test for
  `requireFeature`.
- [x] commit `feat(account): verified entitlements with offline grace and requireFeature`

### Task 5: Desktop — sign-in flow and the account router
- **Spec:** `specs/account-state.schema.ts` (`AccountStateSchema`: `unconfigured | signed-out |
  awaiting-browser | confirming | signed-in`, the user's email and name, `Entitlements`, keychain
  availability, `requestId` while confirming, version; no secret fields) and
  `specs/account-signin.feature.md`.
- **Build:** `main/account/config.ts` (build-time and unpackaged-runtime values; packaged requires
  `https:`), `loopback.ts` (shared with Task 8), `pkce.ts`, `api-client.ts` (`net.fetch`,
  timeouts, Zod-validated answers), `service.ts` (the flow: `signIn` with the window's gesture opens
  the authorize URL; the callback's code is exchanged; the session's email is shown for
  confirmation; `confirmSignIn(requestId)` stores the token and fetches entitlements;
  `cancelSignIn`; `signOut` revokes; refresh at start, every 6 hours and on demand).
  `packages/ipc-contract/src/account-service.ts` and `account-router.ts`: `account.watch`
  (long-poll), `signIn`, `confirmSignIn`, `cancelSignIn`, `signOut`, `refresh`, `entitlements`.
  Hub: `router.ts`/`services.ts` registrations and one service construction in `main/index.ts`.
- **Failing tests:** unit tests for the flow with a fake API and fake loopback (state mismatch,
  callback without a pending request, second callback, timeout, cancel, confirm with a stale
  `requestId`, sign-in without a gesture, sign-out revokes and drops to `free`); router test
  `answers-carry-no-secret`; e2e `account.e2e.ts` against an in-test fake backend
  (`e2e/fake-backend.ts`, ephemeral Ed25519 key): sign in, confirm, plan shows `pro`, restart keeps the
  account when a keychain is available, tampered stored snapshot reads `free`.
- [ ] commit `feat(account): desktop sign-in with loopback redirect and in-app confirmation`
- [ ] Security review of Tasks 4–5 before Task 6.

### Task 6: `packages/telemetry` — consent-gated OpenTelemetry and Sentry
- **Spec:** `specs/telemetry-privacy.spec.ts` (`TELEMETRY_CHANNELS` `usage | errors`,
  `DEFAULT_CONSENT` both off, `SPAN_ATTRIBUTE_ALLOWLIST`, scrub patterns: URLs, emails, IPv4/IPv6,
  home-directory paths, query strings, long hex/base64 tokens) and `specs/telemetry.feature.md`.
- **Build:** `@app/telemetry`: `createTelemetry({ consent, resource, otel: { endpoint, send },
  sentry: { dsn, send }, appRoot, redact })` → `span(name, attrs, fn)`, `captureException(error,
  hint)`, `setConsent(channel, on)`, `consent()`, `configured()`, `flush({ timeoutMs })`,
  `shutdown({ timeoutMs })` (deadlines `TELEMETRY_LIMITS.flushTimeoutMs` / `shutdownTimeoutMs`; at
  shutdown's deadline the rest is dropped and requests in flight aborted). Spans from
  `@opentelemetry/sdk-trace`'s `TracerProvider` (explicit resource, no detectors) feeding frost's own
  gated batching processor (drops when off; turning off discards the queue without flushing and
  starts a new consent epoch, so a span begun before is dropped) and its own OTLP/HTTP JSON writer,
  sent through the injected `send`. Sentry through a minimal `@sentry/core` `Client` with no
  integrations, every `dataCollection` category off (Sentry 11's replacement for `sendDefaultPii`),
  no breadcrumbs or client reports and a private scope; a `beforeSend` that returns `null` without
  consent and otherwise rebuilds the event from the allowlists, scrubbed; and a transport that
  re-checks consent at send time and sends only `event` items `beforeSend` rebuilt. Scrubbing
  (`SCRUB_RULES`, linear-time, input cut to `maxScrubInputChars` first) removes URLs, emails,
  tokens, IDs, IPs, home and other absolute paths and bare host names, plus the machine's names. No
  Electron import.
- **Failing tests:** with fake transports: `nothing-sent-before-consent`,
  `off-stops-export-immediately` (queued spans and events are dropped), `on-again-resumes`,
  `events-are-scrubbed` (URL, email, path, token in messages, stack frames and attributes), only
  allowlisted span attributes leave, no identifier in the resource.
- [x] commit `feat(telemetry): consent-gated OpenTelemetry and Sentry`

### Task 7: Desktop — telemetry wiring, consent store and router
- **Spec:** `specs/telemetry-consent.schema.ts` (`TelemetryStateSchema`: consent per channel,
  whether this build has each endpoint; `SetConsentInputSchema`; `RendererErrorInputSchema` with
  caps) and `specs/telemetry.feature.md` (Desktop).
- **Build:** `main/telemetry/consent-store.ts` (`userData/telemetry-consent.json`, read sync before
  any window; corrupt → defaults), `main/telemetry/install.ts` (creates `@app/telemetry` with
  `net.fetch` transports, main `uncaughtException`/`unhandledRejection` capture, an `app.start`
  span), `packages/ipc-contract/src/telemetry-router.ts` (`telemetry.state`, `setConsent`,
  `reportError`, rate-limited). Hub registrations.
- **Failing tests:** unit tests for the store and the router; e2e `telemetry.e2e.ts` with a fake
  OTLP collector and a fake Sentry endpoint: nothing arrives with defaults; enabling sends; disabling
  stops at once; a renderer error with a URL arrives scrubbed.
- [ ] commit `feat(telemetry): consent store, settings procedures and main wiring`

### Task 8: Desktop — Search Console connection and read API
- **Spec:** `specs/gsc.schema.ts` (`GSC_SCOPE`, `GscStatusSchema`, `GscPropertySchema`,
  `GscPerformanceQuerySchema`, `GscPerformanceAnswerSchema`, `GscQueriesAnswerSchema`, the
  unavailable reasons) and `specs/gsc.feature.md`.
- **Build:** `main/gsc/oauth.ts` (authorization code + PKCE S256 over the shared loopback, scope
  `webmasters.readonly` only, refresh token via the secret store, access token in memory, revoke on
  disconnect), `main/gsc/api.ts` (sites list, `searchAnalytics/query`, Zod-validated, quota and 401
  handling), `main/gsc/properties.ts` (property for a URL: longest URL-prefix property, else the
  domain property), `main/gsc/service.ts` (cache, entitlement gate `search-console`).
  `packages/ipc-contract/src/gsc-service.ts` (the typed read API for Phase 5) and `gsc-router.ts`
  (`gsc.status`, `connect`, `disconnect`, `properties`, `performance`, `topQueries`).
- **Failing tests:** unit tests with a fake OAuth server and a fake GSC API (`e2e/fake-google.ts`
  shared with e2e): `gsc-scope-is-read-only`, PKCE and state checked, refresh on 401, disconnect
  revokes and deletes, property matching, not-entitled refused, `answers-carry-no-secret`.
- [ ] commit `feat(gsc): read-only Search Console connection and performance API`
- [ ] Security review of Task 8 before Task 9.

### Task 9: Settings view
- **Spec:** `specs/account-settings.feature.md`.
- **Build (renderer):** `settings-view.tsx` (a sheet over the page column like History, opened from
  the palette — "Settings", "Sign in", "Search Console" — and Mod+, through the menu), sections in
  `account-view.ts`, `settings-telemetry.tsx`, `settings-gsc.tsx`: account (sign in, the in-app
  confirmation, sign out, plan and features, keychain notice), telemetry (two toggles with plain
  descriptions of what is sent, "not configured in this build"), Search Console (connect,
  disconnect, connected account, plan requirement). Own CSS file. Hub: one `App.tsx` slot.
- **Failing tests:** unit tests for the view models; e2e `settings.e2e.ts`: sign in through the
  view against the fake backend (confirmation shown and required), toggles persist across restart and
  reflect main's state, Search Console connect and disconnect against the fakes.
- [ ] commit `feat(settings): account, plan, telemetry and Search Console settings`

### Task 10: Search Console performance panel
- **Spec:** `specs/gsc-panel.feature.md`.
- **Build:** a `search-console` rail panel (hub: `SEO_PANELS`, the icon and the panel switch) in
  `gsc-view.ts`/`GscPanel.tsx`: clicks, impressions, CTR and position over time for the current URL
  and for its property (toggle), 7/28/90-day range, totals, a frost-drawn SVG chart (attributes, not
  `style=`), states for signed out, not `pro`, not connected, no matching property, no data, error.
  Palette jump.
- **Failing tests:** unit tests for the chart's scales and the view model; e2e `gsc-panel.e2e.ts`
  with the fakes: totals and chart for the page and the property, gating messages.
- [ ] commit `feat(gsc): page and site performance panel`

### Task 11: Docs and release check
- README status, `apps/desktop/README.md` (configuration, known limits), this plan's As built.
- Whole-branch review and a final security review; fixes as `fix(...)` commits.
- [ ] commit `docs: phase 4 accounts, entitlements, telemetry and Search Console`

## Interfaces for other phases
Stable and Zod-typed; changing one is a breaking change that needs the owning phase's review.

- **Entitlements (main):** `apps/desktop/src/main/account/entitlements.ts`
  - `EntitlementsReader.current(): Entitlements` (`specs/entitlements-snapshot.spec.ts`
    `EntitlementsSchema`), `has(flag: FeatureFlag): boolean`, `requireFeature(flag)` (throws
    `FeatureNotEntitledError`), `onChange(listener): () => void`.
  - Flags (`FEATURE_FLAGS`): `ai-agent`, `search-console`, `sync`. Unknown flags in a snapshot are
    ignored, so the server can add one before the client knows it.
- **Entitlements (IPC):** `requireFeature(flag)` middleware from `@app/ipc-contract`
  (`account-router.ts`), used as `publicProcedure.use(enforceSender).use(requireFeature('ai-agent'))`;
  it rejects with `FORBIDDEN` and `FEATURE_NOT_ENTITLED_CODE`. `account.entitlements` answers the
  current `Entitlements` to the chrome.
- **Search Console read API:** `packages/ipc-contract/src/gsc-service.ts` `GscService`
  (`status()`, `properties()`, `propertyFor(url)`, `performance(query)`, `topQueries(query)`), Zod
  schemas in `specs/gsc.schema.ts`; every answer is `{ status: 'ok', … }` or
  `{ status: 'unavailable', reason }` and never throws. Main's instance is
  `createGscService(...)` in `apps/desktop/src/main/gsc/service.ts`; the Phase 5 agent tool calls it
  in main (it is gated on `search-console` itself).
- **Telemetry:** `@app/telemetry` `span(name, attrs, fn)` and `captureException(error)`; only
  `SPAN_ATTRIBUTE_ALLOWLIST` keys are exported, so a phase adds its attribute keys there.

## As built
(Filled in at Task 11.)
