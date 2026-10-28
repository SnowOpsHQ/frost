# Feature: desktop sign-in and the account router

Spec: `specs/account-state.schema.ts` (`AccountStateSchema`, `ACCOUNT_STATUSES`, `ACCOUNT_ERRORS`,
`KEYCHAIN_MODES`, `ACCOUNT_CONFIG_ENV`, `UNPACKAGED_HTTP_API_HOSTS`, `SIGN_IN_TIMEOUT_MS`,
`CONFIRM_TIMEOUT_MS`, `ACCOUNT_REFRESH_INTERVAL_MS`, `ACCOUNT_API_TIMEOUT_MS`, `ACCOUNT_API_MAX_BODY_BYTES`,
`MAX_PENDING_ACCOUNT_WATCHES`, the `LOOPBACK_*` constants, `AccountWatchInputSchema`,
`AccountRequestInputSchema`, `SIGN_IN_RESULTS`) with the backend contract `specs/account-api.schema.ts`
(Desktop authorization, `requestFingerprint`) and `specs/entitlements-snapshot.spec.ts`. Phase 4 Task 5.
Review focus: "A website or another app cannot sign the user in to someone else's account" and "The
renderer never sees a token". Each line maps to one named test.

## Decisions
- **Loopback redirect, PKCE and an in-app confirmation.** `signIn` makes a request (ID, `state`,
  PKCE verifier and S256 challenge, `fingerprint = requestFingerprint(challenge)`), starts a loopback
  listener on `127.0.0.1:<random port ≥ 1024>/callback`, and opens the backend's authorize page with
  `openExternalIfAllowed`. The callback's `state` must match (constant time); its code is exchanged with
  the verifier, the token kept **in memory**, and `/v1/session` names the account: status `confirming`
  ("Sign in as …?"), the window that asked is focused. Only `confirmSignIn(requestId)` stores the token
  and fetches entitlements; `cancelSignIn` drops the request and revokes a token already exchanged. A
  page or another program that drives a sign-in cannot make main use an account the user did not
  confirm, and cannot read the code (it goes only to the listener, then the address bar is cleared by a 303).
- **A user gesture in the window that asked.** `signIn` consumes a live trusted activation
  (`USER_ACTIVATION_WINDOW_MS`, `trackUserGesture`) of the app window whose page called it (the IPC
  sender's `windowId`); without one it answers `needs-gesture` and opens nothing. Main tracks every app
  window's input itself (`browser-window-created`).
- **One request at a time.** A new `signIn` replaces the pending one (revoking its token if one was
  exchanged); a callback, exchange or answer that arrives for a replaced request is dropped (its token
  revoked).
- **The listener** (`loopback.ts`, reused by Search Console's OAuth) binds `LOOPBACK_HOST` only, serves
  only `GET LOOPBACK_CALLBACK_PATH` for one pending request (everything else 404), answers a wrong or
  repeated `state` 400 without ending the request, requires `Host: 127.0.0.1:<port>`, answers the first
  valid callback 303 to `LOOPBACK_DONE_PATH`, then serves that fixed page once and closes (or after
  `LOOPBACK_DONE_LINGER_MS`). It closes on cancel and after `SIGN_IN_TIMEOUT_MS`. Every answer carries
  `LOOPBACK_RESPONSE_HEADERS` (CSP `default-src 'none'`, `no-store`, `no-referrer`), loads nothing, and
  never reflects a query value.
- **Outbound calls** use `net.fetch` with `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`,
  a timeout (`ACCOUNT_API_TIMEOUT_MS`) and a body cap (`ACCOUNT_API_MAX_BODY_BYTES`); every answer is
  validated with the `account-api.schema.ts` / `entitlements-snapshot.spec.ts` schemas. Failures are
  `network` (no answer, timeout, 408, 429, 5xx), `auth` (401) or `invalid` (anything else).
- **Refresh** at start (when an account is stored), every `ACCOUNT_REFRESH_INTERVAL_MS` and on
  `refresh`: `/v1/session` then `/v1/entitlements`. A 401 drops the token and signs out
  (`markRefreshFailed('auth')`, error `session-ended`); a network failure keeps the account and allows
  offline grace (`markRefreshFailed('network')`); an answer that does not verify is `invalid` (free).
- **Configuration.** `ACCOUNT_CONFIG_ENV` from the build. One rule for every public value
  (`build-config.spec.ts`, `runtimeOverridesAllowed`): a build with any `FROST_PUBLIC_*` value baked in
  (the account's, telemetry's or Search Console's) never reads the run-time environment (for any of
  them); only an unpackaged build with nothing baked in does (dev, e2e). `app.isPackaged` only looks at the executable's name, so it is not the guard. Packaged requires an `https:` API base; unpackaged also allows `http:` on
  `UNPACKAGED_HTTP_API_HOSTS`. The base is an origin only. A missing or invalid base or JWKS is
  `unconfigured`: nothing is sent, `signIn` answers `unconfigured`.
- **Keychain.** The token lives in the secret store's `account` blob; memory-only (no real keychain)
  still signs in for this run and the state says `memory-only`. Such a token cannot be used after the
  run, so quitting revokes it (inside the quit hold, bounded by `QUIT_REVOKE_TIMEOUT_MS`): it does not
  stay valid on the backend for its 30 days.
- **Tokens stay in main; logs carry no secret.** No answer carries a token, code, verifier, `state`,
  snapshot or user ID (`AccountStateSchema` is strict; the router validates every output). The
  service's log goes through a redactor: fixed messages, and any token, code, verifier, `state`,
  snapshot or email that might still reach it is replaced.
- **Fails closed.** `entitlements` is `none` unless `signed-in`, so `requireFeature` never passes on a
  request that was not confirmed, nor on a snapshot left behind without an account.

## Spec schema (`apps/desktop/src/main/account/__tests__/account-state-spec.test.ts`)
- `state-schema-has-no-secret-fields` — a state with a `token`, `code`, `verifier`, `state`, `snapshot` or `userId` member is refused; the user carries only `email` and `name`.
- `state-schema-ties-fields-to-status` — `user`, `requestId` and `fingerprint` appear exactly in their statuses; a malformed fingerprint or request ID is refused.
- `state-schema-fails-closed` — a status other than `signed-in` carrying any entitlements but `none` is refused.
- `input-schemas-are-strict` — the watch and request inputs refuse extra members and malformed values.

## Configuration (`apps/desktop/src/main/account/__tests__/config.test.ts`)
- `config-missing-is-unconfigured` — no API base, or no JWKS, is `null` (unconfigured).
- `config-packaged-requires-https` — packaged: `http:` (even loopback) is refused; `https:` is accepted.
- `config-unpackaged-allows-loopback-http` — unpackaged: `http://127.0.0.1:<port>` and `http://localhost` are accepted, `http:` elsewhere refused.
- `config-runtime-env-only-unpackaged` — an unpackaged build with nothing baked in reads the run-time environment; a packaged one never does.
- `config-baked-build-ignores-runtime` — a build with either value baked in ignores the run-time environment for both, packaged or not (a renamed executable reads as unpackaged); so does a build with only another module's value baked in (telemetry's, Search Console's).
- `config-api-base-is-origin-only` — a path, query, fragment or credentials is refused; a trailing slash is dropped.
- `config-malformed-jwks-is-unconfigured` — a JWKS that is not JSON or not `EntitlementJwksSchema` is unconfigured.

## PKCE (`apps/desktop/src/main/account/__tests__/pkce.test.ts`)
- `pkce-verifier-shape` — the verifier matches `CODE_VERIFIER_PATTERN`, the state `DESKTOP_STATE_PATTERN` (within `DESKTOP_STATE_LIMITS`), the request ID `ACCOUNT_REQUEST_ID_PATTERN`; each call differs.
- `pkce-challenge-is-s256` — the challenge is RFC 7636's S256 (Appendix B's example) and matches `CODE_CHALLENGE_PATTERN`.

## Loopback listener (`apps/desktop/src/main/account/__tests__/loopback.test.ts`, real `node:http`)
- `loopback-binds-loopback-unprivileged-port` — it listens on `127.0.0.1` only, on a port in `LOOPBACK_PORT_RANGE`, and its redirect URI matches `LOOPBACK_REDIRECT_PATTERN`.
- `loopback-404-elsewhere` — another path, another method, `/done` before a callback, and a foreign `Host` answer 404 (400 for the host) with the fixed headers, and do not end the request.
- `loopback-wrong-state-400-keeps-waiting` — a missing, wrong or repeated `state` (or a repeated `code`) is 400 and the request still accepts the right one.
- `loopback-303-to-done-without-code` — the valid callback is 303 to `/done` (no query), with the fixed headers, and hands over the code.
- `loopback-done-page-is-fixed` — `/done` is the fixed HTML with the fixed headers, no subresources, and none of the query's values.
- `loopback-closes-after-success` — after `/done` is served the port is closed; a second callback before that is 404 and is not handed over.
- `loopback-limits-connections` — more than `LOOPBACK_MAX_CONNECTIONS` connections at once are refused, and a connection that does not send its request within the request timeout is closed; the listener still answers afterwards.
- `loopback-closes-without-done` — a browser that never asks for `/done` does not keep it open: it closes after the linger time.
- `loopback-oauth-error-is-a-callback` — a valid-state callback with `error` (and no code) is handed over as such and ends the request.
- `loopback-times-out` — with no valid callback, it closes after `timeoutMs` and reports the timeout once.
- `loopback-cancel-closes` — `close()` closes the port and reports nothing.

## API client (`apps/desktop/src/main/account/__tests__/api-client.test.ts`)
- `authorize-url-shape` — the authorize URL is the API base's `DESKTOP_AUTHORIZE_PATH` with exactly `redirect_uri`, `state`, `code_challenge` and `code_challenge_method=S256`, valid against `DesktopAuthorizeQuerySchema`.
- `api-requests-omit-credentials` — every call is `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`, with a timeout signal; the token only in `Authorization: Bearer`; the exchange body is `DesktopTokenRequestSchema` JSON.
- `api-maps-failures` — a rejected fetch, a timeout, 408, 429 and 5xx are `network`; 401 is `auth`; another status, a non-JSON body, an over-long body or an answer that fails its schema is `invalid`.
- `api-times-out` — a call with no answer within `ACCOUNT_API_TIMEOUT_MS` is aborted and reported as `network`.
- `api-validates-answers` — the token, session and entitlements answers are parsed with their schemas (unknown members stripped); sign-out accepts 204.

## The flow (`apps/desktop/src/main/account/__tests__/service.test.ts`; fake API, fake loopback, fake gesture)
- `sign-in-unconfigured` — without configuration the state is `unconfigured`, `signIn` answers `unconfigured`, nothing is opened, nothing is fetched.
- `sign-in-without-gesture-opens-nothing` — without a live gesture in the asking window (or with another window's) `signIn` answers `needs-gesture`, starts no listener and opens nothing.
- `sign-in-opens-authorize-url` — with a gesture: the listener starts with the request's `state`, the authorize URL (redirect, `state`, challenge of the verifier) is opened, the state is `awaiting-browser` with the request ID and `requestFingerprint(challenge)`.
- `sign-in-needs-confirmation` — after the callback the code is exchanged with the verifier and the session fetched: `confirming` with the user, the asking window focused; nothing is stored and entitlements stay `none` (no entitlements fetched) until confirmed.
- `state-mismatch-refused` — (real listener) a callback with a wrong `state` is 400, nothing is exchanged, and the request still completes with the right one.
- `callback-without-pending-ignored` — a callback for a request that was cancelled or replaced exchanges nothing.
- `second-callback-ignored` — a second callback for the same request exchanges nothing more.
- `browser-error-is-cancelled` — a callback with an OAuth `error` ends the request as `cancelled` without an exchange.
- `timeout-is-timed-out` — no callback within the listener's timeout: `signed-out` with `timed-out`; a confirmation not given within `CONFIRM_TIMEOUT_MS` is dropped, its token revoked.
- `new-sign-in-replaces-pending` — a second `signIn` closes the first listener; an exchange of the first that finishes late is revoked and does not change the state.
- `cancel-revokes-exchanged-token` — `cancelSignIn` while `confirming` revokes the exchanged token (`/v1/sign-out`), stores nothing, `signed-out`; a wrong request ID answers `false` and changes nothing.
- `confirm-stale-request-refused` — `confirmSignIn` with another, an old or a not-yet-exchanged request ID answers `false`, stores nothing.
- `confirm-needs-gesture-in-starting-window` — `confirmSignIn` from another window than the one that started the request, or without a live gesture in it, answers `false` and stores nothing; the request stays `confirming`.
- `confirm-stores-and-fetches-entitlements` — `confirmSignIn` stores the token in the `account` blob, fetches entitlements and calls `update(snapshot, user.id)`: `signed-in` with `pro`.
- `exchange-failures` — a refused code is `exchange-failed`, an unreachable backend `network`; a session for another user than the token's is refused and the token revoked.
- `sign-out-revokes-and-drops-to-free` — `signOut` revokes the token, deletes the `account` blob, clears entitlements: `signed-out`, `free`.
- `stored-account-restores-and-refreshes` — a stored account starts `signed-in` and refreshes at once, then every `ACCOUNT_REFRESH_INTERVAL_MS`, and on `refresh`; an expired or malformed stored account is dropped.
- `refresh-401-signs-out` — a 401 on refresh drops the token, `markRefreshFailed('auth')`, `signed-out` with `session-ended`.
- `refresh-not-reused-across-accounts` — a refresh still running for an account that signed out is not handed to the next account: its own refresh runs with its own token, and the late answer changes nothing.
- `revocations-awaited-on-dispose` — `dispose` drops a pending sign-in and answers its revocation (and a sign-out's) to wait for; nothing to wait for answers `null`.
- `refresh-network-keeps-grace` — a network failure keeps the account and calls `markRefreshFailed('network')`.
- `refresh-invalid-snapshot-is-free` — an entitlements answer that does not parse is `markRefreshFailed('invalid')`.
- `entitlements-none-unless-signed-in` — a snapshot held without a stored account is cleared at start; `entitlements()` is `none` while `confirming`.
- `user-id-for-main-only` — main's `userId()` is the confirmed account's ID (`null` while signed out or `confirming`), and `onChange` listeners are called after each change (Search Console binds its connection to that ID); neither is on the IPC `AccountService`.
- `memory-only-keychain-signs-in` — with a memory-only store sign-in works for the run and the state says `memory-only`.
- `memory-only-token-revoked-on-dispose` — with a memory-only store, `dispose()` (the quit) revokes the signed-in account's token and answers the revocation to hold the quit for; with a persistent store it revokes nothing (the token outlives the run).
- `watch-long-polls` — `watch` answers at once for an older version, else at the next change; aborting releases it; more than `MAX_PENDING_ACCOUNT_WATCHES` answer the oldest early.
- `logs-carry-no-secret` — across every path above, the log never contains the fake token, code, verifier, `state`, snapshot or email.

## Quitting (`apps/desktop/src/main/account/__tests__/quit.test.ts`, fake app)
- `quit-held-only-for-revocations` — with nothing to revoke (a memory-only account counts: its token is revoked at quit), `will-quit` passes; otherwise it is held until the revocations settle or `QUIT_REVOKE_TIMEOUT_MS` passes, then quits again once; another holder (telemetry) holding the same quit does not make it hang or quit twice.

## Gestures (`apps/desktop/src/main/account/__tests__/gestures.test.ts`)
- `gesture-per-app-window` — a window created after the tracker (and one that existed before) is tracked; a gesture is consumed once, only for its own window; a closed window has none.

## Router (`packages/ipc-contract/src/__tests__/account-router.test.ts`)
- `account-procedures-enforce-sender` — every `account.*` procedure refuses a foreign sender before the service is touched.
- `sign-in-passes-window-id` — `signIn` and `confirmSignIn` hand the service the sender's `windowId`; `signIn` answers its `SignInResult`.
- `account-watch-long-polls` — `watch` answers a newer state at once, else the next one, else the current after `WATCH_TIMEOUT_MS`.
- `account-outputs-are-strict` — a service answer outside `AccountStateSchema` / `SignInResultSchema` / boolean is a masked internal error.
- `answers-carry-no-secret` — the serialized answers of every account procedure contain none of the fake secrets.

## End to end (`apps/desktop/e2e/account.e2e.ts`, fake backend `apps/desktop/e2e/fake-backend.ts`)
- `account-sign-in-needs-gesture` — without a real click `signIn` answers `needs-gesture` and nothing is opened.
- `account-sign-in-confirm-is-pro` — a real click then `signIn` opens the authorize URL (observed, not opened); the test follows it as the browser (303 to the listener, 303 to `/done`, fixed headers); the app shows `confirming` with the email and the fingerprint of the URL's challenge; `confirmSignIn` without a click is refused, after a real click it gives `signed-in` with `pro` features.
- `account-restart-keeps-account-only-with-keychain` — on the same profile the account is kept after a restart with a persistent keychain, and gone with a memory-only one. (Under Playwright, Linux is always memory-only: its Electron loader appends `--password-store=basic`; macOS uses a mock keychain, which persists. The persistent restart is also covered by `stored-account-restores-and-refreshes`.)
- `account-tampered-snapshot-is-free` — a tampered snapshot from the server (and, with a persistent keychain, a tampered stored blob across a restart) reads `free`.
- `account-sign-out-revokes` — `signOut` revokes the token at the backend and reads `signed-out`, `free`.
