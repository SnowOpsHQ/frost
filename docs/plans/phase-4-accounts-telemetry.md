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
  obfuscation, so frost keeps tokens in memory only for that run and says so in Settings. The store
  uses `safeStorage`'s asynchronous API (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
  `decryptStringAsync`): the synchronous calls are deprecated in Electron 45, and on Linux
  `isEncryptionAvailable()` can answer false where the asynchronous encryptor works.
- **No desktop database migrations.** Secrets and the telemetry consent are small files in
  `userData` (read at startup, before the first window: secrets asynchronously after `ready`, the
  consent synchronously since it must be known before anything could be sent). The
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
| `FROST_TELEMETRY_EXPORT_DELAY_MS` (unpackaged only) | desktop e2e | Span batch delay for tests (holds the startup span in the queue). |
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
- [x] Review fixes: commit `fix(backend): address auth review findings`

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
- [x] Review fixes: in Task 3's commit ("Task 2 follow-ups")

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
- [x] Security review of Tasks 1–3 before Task 4.
- [x] Review fixes: commit `fix(backend): address desktop authorization review findings`

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
- [x] Review fixes: commit `fix(account): address entitlements review findings`

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
- [x] commit `feat(account): desktop sign-in with loopback redirect and in-app confirmation`
- [x] Security review of Tasks 4–5 before Task 6.
- [x] Review fixes: commit `fix(account): address sign-in review findings`

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
- [x] Review fixes: commit `fix(telemetry): address telemetry review findings`

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
- [x] commit `feat(telemetry): consent store, settings procedures and main wiring`
- [x] Review fixes: commit `fix(telemetry): address desktop telemetry review findings`

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
- [x] commit `feat(gsc): read-only Search Console connection and performance API`
- [x] Security review of Task 8 before Task 9.
- [x] Review fixes: commit `fix(gsc): address Search Console review findings`

### Task 9: Settings view
- **Spec:** `specs/account-settings.feature.md`.
- **Build (renderer):** `settings-view.tsx` (a sheet over the page column like History, opened from
  the palette — "Settings", "Sign in", "Search Console" — and Mod+, through the menu), sections in
  `account-view.ts`, `settings-telemetry.tsx`, `settings-gsc.tsx`: account (sign in, the in-app
  confirmation, sign out, plan and features, keychain notice), telemetry (two toggles with plain
  descriptions of what is sent, "not configured in this build"), Search Console (connect,
  disconnect, "Connected" without a Google account name (by design: frost asks Google for none), plan
  requirement). Own CSS file. Hub: one `App.tsx` slot; the menu's requests are the account's
  `account.settingsWatch` (`main/account/settings-requests.ts`).
- **Failing tests:** unit tests for the view models; e2e `settings.e2e.ts`: sign in through the
  view against the fake backend (confirmation shown and required), toggles persist across restart and
  reflect main's state, Search Console connect and disconnect against the fakes.
- [x] commit `feat(settings): account, plan, telemetry and Search Console settings`
- [x] Review fixes: commit `fix(settings): address settings review findings`

### Task 10: Search Console performance panel
- **Spec:** `specs/gsc-panel.feature.md`.
- **Build:** a `search-console` rail panel (hub: `SEO_PANELS`, the icon and the panel switch) in
  `gsc-view.ts`/`GscPanel.tsx`: clicks, impressions, CTR and position over time for the current URL
  and for its property (toggle), 7/28/90-day range, totals, a frost-drawn SVG chart (attributes, not
  `style=`), states for signed out, not `pro`, not connected, no matching property, no data, error.
  Palette jump.
- **Failing tests:** unit tests for the chart's scales and the view model; e2e `gsc-panel.e2e.ts`
  with the fakes: totals and chart for the page and the property, gating messages.
- [x] commit `feat(gsc): page and site performance panel`
- [x] commit `test(e2e): count rail items from SEO_PANELS only`
- [x] Review fixes: commit `fix(gsc): address performance panel review findings`

### Task 11: Docs and release check
- README status, `apps/desktop/README.md` (configuration, known limits), this plan's As built.
- Whole-branch review and a final security review; fixes as `fix(...)` commits.
- [x] Whole-branch and final security review fixes: commits
  `fix(telemetry): scrub desktop and Google token shapes whole`,
  `fix(account): share the redactor and the quit hold`,
  `fix(account): one non-null entitlements gate for main`,
  `fix(account): use safeStorage's asynchronous API for secrets`,
  `fix(account): revoke a memory-only account's token at quit`,
  `fix(main): fall back to unconfigured account, Search Console and telemetry`,
  `fix(telemetry): need a user gesture to turn consent on; throttle account refresh`
- [x] e2e fixes (test seams only, no behaviour change): commits
  `fix(e2e): take the launch-time and fast-answer races out of two suites`,
  `fix(e2e): strip inherited frost configuration from the app's environment`,
  `test(e2e): count only the fake Google's own paths in the connect gesture test`
- [x] README and plan "As built": commit `docs: phase 4 accounts, entitlements, telemetry and Search Console`

## Interfaces for other phases
Stable and Zod-typed; changing one is a breaking change that needs the owning phase's review.

- **Entitlements (main):** the one gate is `createAccountMain(...).entitlements`
  (`apps/desktop/src/main/account/main.ts`; the reader is built by `entitlementsReaderOf(service)` in
  `apps/desktop/src/main/account/entitlements.ts`). It is never `null`: an `EntitlementsReader`
  - `current(): Entitlements` (`specs/entitlements-snapshot.spec.ts` `EntitlementsSchema`): `none`
    unless an account is signed in (confirmed) and the held snapshot's `sub` is that account's user ID;
  - `has(flag: FeatureFlag): boolean`; `requireFeature(flag: FeatureFlag): void` (throws
    `FeatureNotEntitledError`, `code` `FEATURE_NOT_ENTITLED_CODE`);
  - `onChange(listener: (entitlements: Entitlements) => void): () => void`: fires whenever what
    `current()` answers changes (sign-in, sign-out, a session that ended, a new or refused snapshot,
    time passing); answers the unsubscribe.
  - Unconfigured (or an account that could not start): a reader that always answers `none`. The
    store's own controller (`createEntitlements`) is private to the account; gate on the reader only.
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
  `createGscMain(account).service` (`apps/desktop/src/main/gsc/main.ts`; `gsc` in `main/index.ts`),
  built by `createGscService(...)` in `apps/desktop/src/main/gsc/service.ts`; the Phase 5 agent tool
  calls it in main (it is gated on `search-console` itself). `GscIpcService` adds the chrome's
  `watch`, `connect`, `cancelConnect` and `disconnect`.
- **Build configuration:** `specs/build-config.spec.ts` is the one rule for every public build value
  (`PUBLIC_CONFIG_ENV`: the account's, telemetry's and Search Console's): `bakedAny(buildTime)` and
  `runtimeOverridesAllowed(isPackaged, buildTime)`. If any value is baked in, the run-time environment
  is read for none of them; only an unpackaged build with nothing baked in reads them at run time. A
  phase that adds a `FROST_PUBLIC_*` value adds it to `PUBLIC_CONFIG_ENV` (through its module's `*_CONFIG_ENV`).
- **Telemetry:** `@app/telemetry` `span(name, attrs, fn)` and `captureException(error)`; only
  `SPAN_ATTRIBUTE_ALLOWLIST` keys are exported, so a phase adds its attribute keys there. Main's
  instance is the `TelemetryHandle` from `createTelemetryMain(started).telemetry`
  (`apps/desktop/src/main/telemetry/install.ts`; `telemetryMain` in `main/index.ts`); consent changes only
  through `telemetry.setConsent`.

## As built

Tasks 1–10 are implemented and reviewed, each followed by a review-fix commit (Task 2's are in
Task 3's), and the whole branch had a review and a final security review whose fixes are listed under
Task 11. What the app does now is in `apps/desktop/README.md` (Account, telemetry and Search Console;
Configuration; Known limits) and the backend in `apps/backend/README.md`; each behaviour, with its
named tests, is in the feature file named under each task below. Where the build departs from or adds
to the plan:

### Across the phase
- **Architecture.** As planned, plus:
  - main's three Phase 4 parts are `account/`, `gsc/` and `telemetry/` under
    `apps/desktop/src/main/`, each with one Electron-facing `main.ts` over pure modules;
  - Search Console reuses the account's loopback listener, PKCE, secret store, gesture tracker,
    redactor and quit hold, and gates on the account's entitlements reader;
  - the routers are `account.*` (with `settingsWatch`), `telemetry.*` and `gsc.*` (with `watch` and
    `cancelConnect`), all `enforceSender`-first with strict outputs.
- **One configuration rule** (`specs/build-config.spec.ts`, from the Task 5 and 8 reviews). The plan
  let an unpackaged build read any value at run time. As built, if any `FROST_PUBLIC_*` value
  (`PUBLIC_CONFIG_ENV`: the account's, telemetry's and Search Console's) is baked in, the run-time
  environment is read for none of them, nor for the e2e-only `FROST_GSC_*` and
  `FROST_TELEMETRY_EXPORT_DELAY_MS`. Only an unpackaged build with nothing baked in (dev, e2e) reads
  them at run time. `app.isPackaged` only checks the executable's name, so a renamed installed app
  would otherwise swap the snapshot keys or the authorize page. `account/build-config.ts`
  (`buildTimePublicEnv`) is the one place the build's values are read. The fakes are
  `FROST_GSC_AUTH_URL`, `FROST_GSC_TOKEN_URL`, `FROST_GSC_REVOKE_URL` and `FROST_GSC_API_BASE`.
- **One entitlements gate** (whole-branch review). `createAccountMain(...).entitlements` is a
  non-null `EntitlementsReader` over the account service (`entitlementsReaderOf`): `none` unless an
  account is signed in and the snapshot's `sub` is its user ID; `noEntitlementsReader()` when
  unconfigured. The store's controller (`createEntitlements`) is private to the account.
- **Asynchronous `safeStorage`** (whole-branch review). The secret store uses
  `isAsyncEncryptionAvailable` (bounded by `KEYCHAIN_CHECK_TIMEOUT_MS`), `encryptStringAsync` and
  `decryptStringAsync`, and re-writes a blob that answers `shouldReEncrypt`. A write is read back at
  once and the disk follows through one ordered queue. The account, entitlements and Search Console
  load their blobs asynchronously at creation, after `ready` and before the first window.
- **Quit holds.** `account/quit.ts` `holdQuitFor` holds `will-quit` only while there is work (token
  revocations, the secret store's queue, telemetry's bounded shutdown, Search Console's revocation),
  each capped (`QUIT_REVOKE_TIMEOUT_MS`, `GSC_QUIT_REVOKE_TIMEOUT_MS`, `shutdownTimeoutMs`), and quits
  again once; the holders never fight. A memory-only account's token and a memory-only Search
  Console refresh token are revoked at quit (they cannot be used after the run).
- **Startup fallbacks** (whole-branch review). `createAccountMain`, `createGscMain` and
  `createTelemetryMain` never throw: any exception answers an unconfigured service (a memory-only
  store, a `none` reader, telemetry off), logged with a fixed message, so the first window always
  opens (`startup-fallback.test.ts`).
- **Shared watch stores in the chrome.** One `account.watch`, one `gsc.watch` and one
  `account.settingsWatch` long-poll for the whole chrome (`settings-hooks.ts` over
  `createWatchStore` in `settings-store.ts`), with `SETTINGS_RETRY` backoff; Settings and the
  Search Console panel read the same stores.
- **Telemetry's requests** replace `net.fetch`'s detailed `user-agent` and the locale
  (`TELEMETRY_REQUEST_HEADERS`: `user-agent: frost-telemetry`, empty `accept-language`); the rest
  are Chromium's transport headers, listed in `telemetry.feature.md`.
- **Redaction.** One redactor (`account/redact.ts`) for the account and Search Console, which also
  keeps the client secret and refresh tokens outside its recent-values cap. `@app/telemetry`'s
  `SCRUB_RULES` gained the desktop token (`frost_dt_`) and Google's token, code and client-secret
  shapes, matched whole (whole-branch review).
- **Hub changes** (each kept to a line or a slot):
  - `packages/ipc-contract`: `router.ts` (three routers), `services.ts` (three services),
    `index.ts` (exports, `requireFeature`);
  - `main/index.ts`: `createTelemetryMain(started)` before any window, then `createAccountMain()` and
    `createGscMain(account)` after `ready`, three services lines, `telemetryMain.useGestures(...)`,
    and `...account.menu` in `installAppMenu`;
  - `main/menu.ts`: the **Settings…** item (`SETTINGS_MENU`, Mod+,; the macOS app menu, elsewhere the
    end of Edit);
  - `vite.main.config.ts`: `envPrefix: ['VITE_', 'FROST_PUBLIC_']`;
  - `renderer/App.tsx`: the `SettingsSlot`; `renderer/main.tsx`: the renderer error reporter's import;
  - `SEO_PANELS` (`search-console`, no categories), `PANEL_ICONS` and the panel switch in
    `SeoSidebar.tsx`, the palette's `PALETTE_ICON_NAMES` and `ICONS`;
  - `seo-view.ts` `railStatuses` skips a panel with no categories, and `SeoSidebar.tsx` hides the
    rerun button and the "Audited …" footer on such a panel. This applies to any panel without
    categories, so a Phase 3 or 6 panel without rules gets the same;
  - `FEATURE_PANEL_JUMPS` (`specs/command-palette.spec.ts`) is now one entry per line, append-only;
  - `security/gesture.ts`: `openExternalIfAllowed` logs a fixed message, not the error (it can carry
    the URL); the Electronegativity baseline's source line follows;
  - `e2e/harness.ts`: an `env` option on `launchApp`, and `childEnv` strips inherited
    `FROST_PUBLIC_*`, `FROST_GSC_*` and `FROST_TELEMETRY_*` before applying it;
    `e2e/seo-sidebar.e2e.ts` drops its hard-coded rail count (the line above checks `SEO_PANELS`);
  - `third-party-notices.ts` expands npm's GitHub repository shorthand; `THIRD_PARTY_NOTICES` lists
    `jose`, the OpenTelemetry packages and `@sentry/core`; `pnpm-workspace.yaml` adds `esbuild: false`
    to `allowBuilds` (via `tsx`).
- **No desktop migrations.** As planned: the `0020`–`0029` range stays reserved. The backend has
  four (`0001_auth` to `0004_desktop_code_replay`).

### Task 1: backend foundation
`specs/account-api.schema.ts`, `specs/account-backend.feature.md`.
- **Email verification is required** before a password signs in; sign-up for an address that exists
  answers like a new one; auto sign-in after verification is off. Signing in by magic link removes a
  password set before the address was proven.
- **Endpoint allowlist** (review): only `AUTH_ENDPOINT_METHODS` of better-auth answer; everything
  else under `/api/auth/*` is 404, and JSON answers never carry the session token.
- **Rate limits** (review): `AUTH_RATE_LIMITS` per client IP in every environment, keyed on the TCP
  peer unless `CLIENT_IP_HEADER` and `TRUSTED_PROXIES` say a proxy sets it.
- **Origin checks forced on** (review): better-auth turns its origin and `callbackURL` checks off
  under `NODE_ENV=test`, so they are enabled explicitly, and the app refuses cross-site `POST`s too.
- Also from the review: errors log their name and route only; better-auth's log keeps a redacted
  first line; `BETTER_AUTH_URL` must be a bare origin; production requires `DATABASE_URL`;
  better-auth's telemetry env overrides refuse startup; Postgres pool timeouts and a `/healthz` 503;
  better-auth pinned to 1.7.14.

### Task 2: signed entitlement snapshots and the admin CLI
`specs/entitlements-snapshot.spec.ts`, `specs/entitlements.feature.md`.
- **The signing key is validated at startup:** not JSON, not Ed25519, no `d`, another `kid`, or a
  `d` that does not match its `x` refuses to start, without echoing the key.
- **`kid` defaults to the key's RFC 7638 thumbprint** (`admin keygen [kid]`).
- `ENTITLEMENT_PUBLIC_KEYS` publishes old public keys during a rotation (a `d` or a repeated `kid`
  refuses startup); the rotation order is in `apps/backend/README.md`.
- Added in Task 3's commit: `admin revoke <email>` (every desktop token, unexchanged codes, every web
  session); the CLI applies the production `DATABASE_URL` rule and prints its target (never the URL)
  to stderr.

### Task 3: desktop authorization
`specs/account-api.schema.ts` (Desktop authorization), `specs/account-backend.feature.md`.
- **Recent authentication** (security review): Continue needs a web session created within
  `DESKTOP_RECENT_AUTH_SECONDS` (10 minutes); an older one gets the sign-in page again. A browser
  that is merely still signed in is not enough for another local program to get a token.
- **The web session ends when a code is issued** (revoked, cookie cleared): one sign-in, one code.
- **Request fingerprint** (security review): `requestFingerprint(code_challenge)` (SHA-256, 40 bits,
  Crockford base32, `XXXX-XXXX`) on the Continue page and in the app, so the user can match them.
- **`Referrer-Policy: same-origin`** on the pages, not `no-referrer`: under `no-referrer` browsers
  send `Origin: null` on a form `POST`, which defeats the same-origin check. Continue's `form-action`
  lists the loopback origin, since browsers check it on the redirect.
- **Replay revokes** (review): a code presented again revokes the token it issued, also when both
  exchanges run at once (`replayed_at`, migration `0004`).
- Desktop rate limits key IPv6 by its /64 and IPv4-mapped addresses as IPv4; `TRUSTED_PROXIES`
  entries are validated. The desktop's callback contract (no-referrer, no subresources, 303 to a
  code-free URL) is in the spec.

### Task 4: entitlements core
`specs/entitlements-client.feature.md`, `specs/entitlements-snapshot.spec.ts`, `specs/secret-store.spec.ts`.
- **Naming:** `expiresAtMs` and `graceEndsAtMs` (the plan's `expiresAt`/`graceEndsAt`), tied to the
  status by the schema (`none` and `invalid` carry nulls).
- **The high-water mark** (review). Status is computed at `max(now, highWater, iat)`. A verified
  `iat` raises the mark fully; a clock reading raises it only up to `CLOCK_MARK_HORIZON_MS` past the
  latest verified `iat`, and a newer verified `iat` supersedes what clock readings added. So a clock
  set back revives nothing main has seen, and a clock that jumped to 2099 and came back does not lock
  out the next snapshot. The mark is stored with the snapshot, in the same blob.
- **Bounded future `iat`** (review): up to `MAX_FUTURE_IAT_SECONDS` (one TTL) ahead is signed
  server time from a slow client clock, accepted and judged from `iat`; further is `invalid`.
- **Accepted residual risk:** restoring an old `entitlements` blob and setting the clock back into
  its snapshot's life replays that snapshot until its `exp` (bounded by the TTL, ended by the next
  answered refresh).
- **Secret store** (review): created only after `ready` (`isReady()`); a blob that does not decrypt
  is kept until the keychain has worked in the run (a locked keyring does not sign the user out).
  Made asynchronous by the whole-branch review (see Across the phase).
- `onChange` notifications are queued, so listeners never see changes out of order.

### Task 5: sign-in flow and the account router
`specs/account-state.schema.ts`, `specs/account-signin.feature.md`.
- **Host check:** the listener answers only `Host: 127.0.0.1:<port>` (a DNS-rebound name is 400); at most
  `LOOPBACK_MAX_CONNECTIONS`, idle requests closed after `LOOPBACK_REQUEST_TIMEOUT_MS` (review).
- **The confirmation needs a gesture in the starting window** (security review): `confirmSignIn`
  takes the sender's `windowId` and a live click in the window that started the request.
- **Refresh throttle** (final security review): the chrome's `account.refresh` reaches the service at
  most once per `ACCOUNT_REFRESH_MIN_INTERVAL_MS` (30 s); main's own refreshes are not throttled.
- A refresh in flight is keyed by its token, so it is never handed to the next account (review).
- Main-only `userId()` and `onChange()` on the service, added for Search Console's account binding
  (Task 8 review); not on the IPC `AccountService`.
- `account.state` joined the planned procedures; the e2e fake backend's plan is switchable (Task 10).

### Task 6: `packages/telemetry`
`specs/telemetry-privacy.spec.ts`, `specs/telemetry.feature.md`.
- **Its own batch processor and OTLP JSON.** The SDK's `BatchSpanProcessor` cannot drop its queue
  without exporting it, so `src/otel.ts` batches spans itself and writes OTLP/HTTP JSON directly;
  spans still come from `@opentelemetry/sdk-trace`'s `TracerProvider`.
- **Sentry 11's `dataCollection`**, every category off, replaces `sendDefaultPii`; the transport sends
  only `event` items `beforeSend` rebuilt in the current consent epoch.
- **Scrubbing** (review): linear-time rules, input cut to `maxScrubInputChars` first; a host-name rule
  (`ONE_DOT_HOST_TLDS`, `HOST_FILE_EXTENSIONS`) and an absolute-path rule; the machine's names
  redacted (short ones as whole words only).
- **Deadlines** (review): `flush` and `shutdown` take `timeoutMs`; at shutdown's deadline the rest is
  dropped and requests in flight aborted. Spans and events carry the consent epoch they began in.
- `otel.exportDelayMs` (bounded by `maxExportDelayMs`) lets the e2e hold a batch.

### Task 7: desktop telemetry wiring
`specs/telemetry-consent.schema.ts`, `specs/telemetry-consent.spec.ts`, `specs/telemetry.feature.md` (Desktop).
- **Crash behaviour preserved:** main observes with `uncaughtExceptionMonitor` (Electron's dialog
  stays), and its `unhandledRejection` listener re-emits Node's warning, since a listener would
  silence it.
- **`persisted`** (review): a consent write that fails removes the file (or overwrites it all off),
  and the state says `persisted: false` ("for this run only") until a write succeeds.
- **Turning consent on needs a gesture** (final security review): a live click in the sender's
  window, through the account's tracker (`useGestures`); off never needs one.
- **Request headers** (review): `TELEMETRY_REQUEST_HEADERS`; the e2e plants the machine's names, the
  checkout path and a cookie for the collector and checks none arrives.
- The consent file is size-checked with `stat` before reading; `app.start` has no `error` outcome
  (a startup that never completes is never sent). `FROST_TELEMETRY_EXPORT_DELAY_MS` (e2e only)
  holds the startup span in the queue.

### Task 8: Search Console connection and read API
`specs/gsc.spec.ts` (Zod-free, for the renderer), `specs/gsc.schema.ts`, `specs/gsc.feature.md`.
- **Account-bound connection** (security review): the `gsc` blob carries the frost user ID; another
  account (or none) never reads with it or sends its tokens; a different account's sign-in revokes
  and deletes it; the same account signing back in keeps it. A read whose connection changed while it
  waited answers `not-connected`.
- **Scope refused:** a token answer whose `scope` is missing or wider is revoked and nothing stored.
- **Token bucket** (`GSC_RATE_LIMIT`, 10 per second, burst 20; a call without a token answers
  `quota`), **coalescing** of identical reads in flight, and **backoff** after a failed refresh
  (`GSC_REFRESH_BACKOFF`, 1 s doubling to 5 minutes).
- **Memory-only** refresh tokens (or a failed write) are reported and revoked at quit; a quit waits
  for an exchange in flight.
- `gsc.watch` and `gsc.cancelConnect` joined the planned procedures; a 403 on a query is
  `no-property` and drops the cached list. `specs/build-config.spec.ts` was born in this review.

### Task 9: Settings view
`specs/account-settings.feature.md`, `specs/account-settings.spec.ts`, `specs/account-settings.schema.ts`.
- **`account.settingsWatch`** (review): the menu's requests are a counter per app window, served by
  `main/account/settings-requests.ts`, not `BrowserState`; `main/index.ts` only gains
  `...account.menu`.
- **Arming delay** (review): "Confirm sign-in" sits after Cancel in the confirmation card and is
  inert (`aria-disabled` plus a guard) for `SETTINGS_CONFIRM_ARM_MS` (1 s) after it appears and
  after the window regains focus; the question is focused when it appears, and a sign-in that
  reaches `confirming` opens Settings by itself.
- Close or Esc while a confirmation waits cancel the sign-in; History and page changes do not hide
  it. Section order: Account, Search Console, Telemetry. A fourth palette action, "Telemetry
  settings", joined the three planned.
- Telemetry's copy is derived from `SPAN_ATTRIBUTE_ALLOWLIST` and the scrub rules
  (`SPAN_ATTRIBUTE_WORDS`, `SCRUB_RULE_WORDS`) and says the receiving server sees the IP address.

### Task 10: Search Console performance panel
`specs/gsc-panel.feature.md`, `specs/gsc-panel.spec.ts`.
- **The chart ends at the last answered day** (review): days after it have no value (final data can
  lag more than two days), gaps inside the answered span count as 0, and the totals say "Through
  <last>". CTR and position break their line on a missing day.
- **Panels without rules:** no rail dot, no rerun button, no "Audited …" footer (see Hub changes).
- Reads are debounced (`GSC_READ_DEBOUNCE_MS`); Retry reads at once; a scope or range change keeps
  the last data shown, dimmed. Position ticks are even from 1; CTR below 1 % has two decimals; a
  rate's best day needs `GSC_RATE_HIGHLIGHT_MIN_IMPRESSIONS`.
- The panel also shows the top queries, and distinguishes loading, unconfigured, a Pro snapshot that
  expired or failed verification and `auth-expired` (Reconnect in Settings).

## Integration notes
For the lead merging Phases 3–7. Expected conflicts and how to resolve them:
- **`packages/ipc-contract/src/router.ts` and `services.ts`:** keep every phase's routers and
  services; Phase 4 adds `account`, `telemetry` and `gsc`.
- **`apps/desktop/src/main/index.ts`, the services block:** keep every line. Order matters for Phase
  4: `createTelemetryMain(started)` before any window; `createAccountMain()` after `ready` and before
  the first window; `createGscMain(account)` after it.
- **`renderer/App.tsx`:** keep every slot (`SettingsSlot` sits after `HistoryView`).
- **`SEO_PANELS`, `PANEL_ICONS`, the palette icon maps** (`PALETTE_ICON_NAMES`, `ICONS`): keep every
  phase's entries.
- **`FEATURE_PANEL_JUMPS`:** now one entry per line; keep every line.
- **`seo-view.ts` `railStatuses`:** another phase may make the identical change (skip a panel with
  no categories); take one copy. The `SeoSidebar.tsx` rerun and footer hiding covers every such
  panel.
- **`e2e/seo-sidebar.e2e.ts`:** keep the deletion of the hard-coded rail count; the line above
  checks `SEO_PANELS.length`.
- **`e2e/harness.ts`:** Phase 7 deletes `UPDATE_FEED_ENV` from the child environment; keep both,
  with Phase 7's delete inside `childEnv` before `options.env` is applied.
- **`pnpm-lock.yaml`:** take main's and run `pnpm install`. **`THIRD_PARTY_NOTICES`:** regenerate
  (`pnpm --filter @app/desktop notices`).

Beyond the conflicts:
- **Phase 7's `FROST_UPDATE_FEED_URL`** is read at run time and does not follow
  `specs/build-config.spec.ts`. A public build value should join `PUBLIC_CONFIG_ENV` (or at least
  be read only when `runtimeOverridesAllowed`), so a baked build is pinned as a whole.
- **Phase 5's credential store** also uses asynchronous `safeStorage`. Align on one secret store
  (`account/secret-store.ts`, `specs/secret-store.spec.ts`: add a name to `SECRET_NAMES`) rather than
  two with different keychain rules.
- **Phase 5's `AgentEntitlements`:** wire it to `createAccountMain(...).entitlements` (the reader;
  `ai-agent` flag), and its `GscPort` to `GscService` (`gsc.service` in `main/index.ts`). Treat
  Search Console query strings as untrusted text in prompts.

## Credentials and config the owner must supply
None is committed, and keys belong outside the repo (a secret manager, an untracked `.env`):
- a Google OAuth client of the Desktop app type: `FROST_PUBLIC_GSC_CLIENT_ID` and
  `FROST_PUBLIC_GSC_CLIENT_SECRET`;
- an Ed25519 signing key from `admin keygen`: `ENTITLEMENT_KEY_ID` and `ENTITLEMENT_SIGNING_KEY` kept
  in a secret manager, its public JWKS as `FROST_PUBLIC_ENTITLEMENT_JWKS`;
- `BETTER_AUTH_SECRET` (32+ characters) and the backend's public `BETTER_AUTH_URL` (`https://`);
- a Postgres `DATABASE_URL`;
- a real email transport: none exists yet, and production refuses `console`;
- a Sentry DSN (`FROST_PUBLIC_SENTRY_DSN`) and an OTLP traces endpoint (`FROST_PUBLIC_OTEL_ENDPOINT`);
- the public API base URL (`FROST_PUBLIC_API_BASE_URL`, `https://`).
