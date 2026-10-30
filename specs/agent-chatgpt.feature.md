# Feature: The agent on the user's ChatGPT plan (Sign in with ChatGPT)

Spec: `specs/agent-chatgpt.spec.ts` (`CHATGPT_ENDPOINTS`, `CHATGPT_SCOPE`, `CHATGPT_PLAN_SCOPE`,
`CHATGPT_RESOURCE`, `CHATGPT_DYNAMIC_CLIENT_ID`, `CHATGPT_AGENT_NAME`, `CHATGPT_REDIRECT_PATH`,
`isChatgptRedirectUri`, `CHATGPT_HOST_ID_FILE`, `isChatgptHostId`, `CHATGPT_CREDENTIALS_FILE`,
`CHATGPT_PARTITION`, `CHATGPT_REFRESH_MARGIN_MS`, `CHATGPT_LIMITS`, `CHATGPT_ERROR_CODE_REASONS`,
`CHATGPT_REFRESH_FAILURE_CODES`, `isChatgptModelId`, `CHATGPT_TOOL_NAMESPACE`,
`CHATGPT_FORBIDDEN_BODY_FIELDS`, `ChatgptAccountView`, `planUsageOf`, `CHATGPT_USAGE_URL`,
`CHATGPT_UI`, the messages), `specs/agent-chatgpt.schema.ts` (`ChatgptStoredStateSchema`,
`ChatgptHostFileSchema`, `ChatgptTokenAnswerSchema`, `ChatgptTokenErrorSchema`,
`ChatgptCallbackSchema`, `ChatgptIdTokenClaimsSchema`, `ChatgptJwkSchema`,
`ChatgptModelEntrySchema`), and the route's additions to `agent-tools.spec.ts` (`MODEL_ROUTES`,
`KEY_ROUTES`, `AgentModelId`, `routeModelId`, `MODEL_REQUESTS.chatgpt`), `agent-proxy.spec.ts`
(`REQUEST_HEADER_ALLOWLIST.chatgpt`, `BODY_FIELDS.chatgpt`, `checkModelRequestBody`,
`routeCredentialSlot`), `agent-panel.spec.ts` (`AGENT_ROUTE_LABELS.chatgpt`),
`agent-ipc.schema.ts` (`AgentChatgptSignInInputSchema`, `AgentSetModelInputSchema`),
`agent-session.spec.ts` (`AgentSetupView.chatgpt`, `modelContextWindow`) and
`agent-protocol.schema.ts` (`chat.start`'s `modelId`).
Plan: `docs/plans/agent-chatgpt-plan.md` (decisions 1–7, Protocol). Code:
`apps/desktop/src/main/agent/chatgpt/` (`host-id.ts`, `oauth.ts`, `id-token.ts`, `store.ts`,
`service.ts`), `apps/desktop/src/main/account/loopback.ts` (`callbackPath`). Each line maps to one
named test.

## Decisions
- **The official flow only.** Sign in with ChatGPT's token sharing for open-source tools that run
  locally: the authorize page in the system browser, a loopback redirect, PKCE, the token endpoint,
  and `POST https://api.openai.com/v1/responses` for inference. No Codex binary, no ChatGPT backend
  API. Written clean-room from OpenAI's published protocol.
- **A fourth model route, `chatgpt`.** It serves OpenAI models from the account's own list, as
  `chatgpt/<slug>` ids. `ModelId` stays the closed catalogue union (`ALLOWED_MODEL_IDS`); a ChatGPT
  id is a `ChatgptModelId` (`` `chatgpt/${string}` ``, checked by `isChatgptModelId`), and
  `AgentModelId = ModelId | ChatgptModelId` is what settings, `chat.start`, chat records and the
  views carry. Catalogue records (`MODEL_CONTEXT_WINDOWS`, `AGENT_MODEL_LABELS`) stay keyed by
  `ModelId` and are read only after `isAllowedModelId`. `routeModelId('chatgpt', id)` is the slug of
  a well-formed ChatGPT id and `null` for anything else; no key route takes a ChatGPT id. Main
  further requires the slug to be in the account's last model list.
- **Tokens stay in main.** The access, refresh and ID tokens live only in main's ChatGPT service,
  encrypted at rest with `safeStorage` through the model keys' store (OS keychain only, mode 0600,
  atomic writes; a blob sealed to its slot). The renderer sees `ChatgptAccountView` only: state,
  email, plan usage, whether the one-time notice was dismissed, and why the last sign-in failed.
  No token, client id, host id or `sub` reaches the renderer, the runtime, a log or the model.
- **One account (v1).** One stored registration; sign out to switch. The issued client id and the
  verified `sub` are kept through sign-out and expiry, so the next sign-in reuses the registration
  and a returning sign-in must come back as the same account.
- **Host id.** `urn:uuid:<uuidv4>`, made once per install and written to `CHATGPT_HOST_ID_FILE`
  before the first sign-in; opaque, not a credential, sent as `ext_agent_host_id` on every
  authorize request.
- **Network.** Every auth and model-list request goes through an injected `fetch` (main passes the
  in-memory `CHATGPT_PARTITION` session's), with `redirect: 'error'`, `credentials: 'omit'`,
  `cache: 'no-store'`, a timeout (`CHATGPT_LIMITS.requestTimeoutMs`) and a capped body. Only the
  fixed endpoints are reached. CI makes no call to OpenAI: tests use a fake auth server.

## Sign-in (`apps/desktop/src/main/agent/chatgpt/__tests__/service.test.ts`)
- **Scenario: chatgpt-authorize-url** — the authorize URL is `CHATGPT_ENDPOINTS.authorize` with
  `response_type=code`, `client_id`, `redirect_uri` (`http://127.0.0.1:<port>/auth/callback`),
  `scope` (`CHATGPT_SCOPE`), `resource`, `state`, `nonce`, `code_challenge` (S256),
  `code_challenge_method=S256` and `ext_agent_host_id`; a first registration sends
  `client_id=dynamic_agent_client` and `agent_name_hint=frost`, a returning one its issued client id
  and no name hint; re-consent adds `prompt=consent`.
- **Scenario: chatgpt-host-id-persisted-before-sign-in** — the host id file is written (0600,
  atomically) before the browser opens, read back on later sign-ins and never changes.
- **Scenario: chatgpt-first-registration-persists-client-id-before-exchange** — the issued client
  id from the redirect is written to the store before the token request, and the exchange uses it
  (never `dynamic_agent_client`).
- **Scenario: chatgpt-missing-client-id-fails** — a first registration's redirect without an issued
  client id ends the sign-in `registration-incomplete`; no code is exchanged.
- **Scenario: chatgpt-returning-client-mismatch-fails** — a returning sign-in's redirect naming
  another client ends `client-mismatch`; no code is exchanged.
- **Scenario: chatgpt-state-mismatch-fails** — a redirect with the wrong `state` is refused by the
  listener; no code is exchanged and the sign-in stays pending.
- **Scenario: chatgpt-declined-in-browser** — `error=access_denied` ends the sign-in `declined`.
- **Scenario: chatgpt-code-exchange** — the token request is a form POST to
  `CHATGPT_ENDPOINTS.token` with `grant_type=authorization_code`, the issued `client_id`, `code`,
  `code_verifier`, the same `redirect_uri` and `resource`, sent with `redirect: 'error'` and
  `credentials: 'omit'`.
- **Scenario: chatgpt-id-token-checks** — an ID token with a bad signature, another issuer, another
  audience, another or no nonce, an `azp` naming another client, an `exp` in the past or an
  `iat` / `nbf` in the future (each past `CHATGPT_LIMITS.clockSkewMs`, 300 s) ends the sign-in
  `id-token`; nothing is stored and the new refresh token is revoked.
- **Scenario: chatgpt-id-token-clock-skew** — a sign-in whose ID token is a few minutes off the
  user's clock (`iat`, `nbf`, `exp` within 300 s) succeeds.
- **Scenario: chatgpt-reconsent-revokes-the-previous-refresh-token** — a sign-in that replaces held
  tokens (re-consent) stores the new ones, then revokes the replaced refresh token (best effort).
- **Scenario: chatgpt-no-sign-in-while-signing-out** — a sign-in asked for while a sign-out is
  revoking answers `failed` and opens no browser; a sign-out clears only the tokens it revoked.
- **Scenario: chatgpt-store-unreadable** — a stored sign-in that exists but can't be read (the
  keychain refused it) is never written over or removed: the view says `store-unreadable`, sign-in
  answers `failed` and opens no browser, the notice can't be dismissed, and sign-out writes nothing;
  once a later read succeeds (each sign-in reads again), the sign-in goes on from the stored record.
  A stored sign-in that can't be read because no OS keychain is available yet counts the same: once
  the keychain is back, the sign-in goes on from the stored record (its client id; the replaced
  refresh token revoked), never registering afresh over it. With no stored sign-in, nothing changes.
- **Scenario: chatgpt-account-mismatch** — a returning sign-in whose verified `sub` differs from the
  stored one ends `account-mismatch`; the stored sign-in is not replaced.
- **Scenario: chatgpt-use-different-account** — "Use a different account" (`signIn({ differentAccount })`;
  v1 keeps one account) first signs the held account out (its refresh token revoked before the
  browser opens), then forgets the registration (client id, account, notice flag; the host id
  stays), so the sign-in is a first registration (`dynamic_agent_client`, the name hint) and may
  come back as another account without `account-mismatch`; it works from an `account-mismatch`, and
  without a keychain answers `no-keychain` having revoked nothing.
- **Scenario: chatgpt-use-different-account (not revoked)** — when ChatGPT doesn't confirm the held
  account's revocation (every attempt fails), "Use a different account" stops: it answers
  `not-revoked`, opens no browser and forgets nothing (the tokens, client id, account and notice
  flag stay, so the account is still signed in), and the next try revokes again.
- **Scenario: chatgpt-sign-in-focuses-window** — a sign-in that succeeds brings the window it was
  started from to the front (`focusWindow(windowId)`, as the account sign-in does); a failed or
  cancelled one doesn't.
- **Scenario: chatgpt-sign-in-gesture** — the browser opener is told whether a spent user gesture
  backs the sign-in (`userGesture`); without one it is `false`.
- **Scenario: chatgpt-plan-usage-from-granted-scope** — plan usage is `on` only when the token
  answer's `scope` holds `chatgpt.tokens.use.direct`; a token answer with no `scope` is `declined`
  (the redirect's `scope` is never used); signed in without it the view says `declined` and no
  access token is handed out (`plan-usage-off`).
- **Scenario: chatgpt-no-keychain** — without OS keychain protection a sign-in answers
  `no-keychain` and opens no browser.
- **Scenario: chatgpt-cancel** — Cancel closes the listener and ends the sign-in `cancelled`.
  Cancelled while the new sign-in is being stored, it is still not kept: the previous record is
  stored again, the new refresh token is revoked, nothing is signed in and no window is focused.

## Tokens (`service.test.ts`)
- **Scenario: chatgpt-refresh-margin-and-earliest** — an access token is used as is until
  `CHATGPT_REFRESH_MARGIN_MS` before it expires, then refreshed (`grant_type=refresh_token`, the
  issued `client_id`, `refresh_token`, `resource`, no `scope`); not before `earliest_refresh_at`,
  which is read as at most `expiresAt - CHATGPT_REFRESH_MARGIN_MS`.
- **Scenario: chatgpt-refresh-backoff** — a refresh that fails without ending the sign-in (no
  answer, `5xx`, an unusable answer) is not tried again for `CHATGPT_LIMITS.refreshBackoffMs`:
  meanwhile the current access token is handed out while it lasts (never one just refused with a
  401), else the failure.
- **Scenario: chatgpt-refresh-id-token-time-only** — a refreshed ID token that fails only on time
  (`exp`, `iat`, `nbf`), like one whose keys can't be fetched, keeps the new tokens (the old refresh
  token is spent) and the last verified ID token and identity; any other failure, or another `sub`,
  ends the sign-in `expired` and revokes the new refresh token.
- **Scenario: chatgpt-refresh-coalesces** — concurrent callers needing a refresh share one refresh
  request.
- **Scenario: chatgpt-rotation-persisted** — the replacement refresh token is stored before the new
  access token is handed out; the next refresh sends it.
- **Scenario: chatgpt-refresh-failure-codes-expire** — each `CHATGPT_REFRESH_FAILURE_CODES` answer
  makes the state `expired`: tokens forgotten, client id, account and host id kept; a network
  failure or `5xx` keeps the tokens.
- **Scenario: chatgpt-sign-out-revokes-then-forgets** — sign-out POSTs `token=<refresh>`,
  `token_type_hint=refresh_token` and the `client_id` to `CHATGPT_ENDPOINTS.revoke` before the
  tokens are forgotten; the client id and host id stay; an unconfirmed revocation answers
  `not-revoked` and still forgets the tokens.
- **Scenario: chatgpt-models** — `listModels` GETs `CHATGPT_ENDPOINTS.models` with the access token
  and keeps entries with `visibility === 'list'` and a well-formed slug, in the server's order, as
  `chatgpt/<slug>` ids with their display names.
- **Scenario: chatgpt-models-large-list** — the list's body may run to `maxModelListBytes` (live
  answers carry per-model metadata well past `maxResponseBytes`); a longer one is refused unread.
- **Scenario: chatgpt-no-token-in-any-view** — every view, every answer and every log line is free
  of the access, refresh and ID tokens, the code and the verifier.

## ID token (`id-token.test.ts`)
- **Scenario: chatgpt-id-token-alg** — only `RS256`: `alg: none` (with or without a signature) and
  `HS256` (keyed with the public modulus) are refused before any key is used.
- **Scenario: chatgpt-id-token-nonce** — a sign-in's ID token must carry the attempt's nonce (a
  missing or empty one is refused); a refreshed ID token is checked without one.
- **Scenario: chatgpt-jwks-unknown-kid** — a token naming a key the cache doesn't hold fetches the
  JWKS again, at most once a `CHATGPT_LIMITS.jwksRefetchMs` (failed fetches included).
- **Scenario: chatgpt-jwks-ttl** — a fetched JWKS is trusted for `CHATGPT_LIMITS.jwksTtlMs` (24 h),
  then fetched again, so a key the issuer rotated out stops being accepted; a stale document that
  can't be fetched again is not used (`keys-unavailable`).
- **Scenario: chatgpt-jwks-key-filter** — keys published for encryption (`use: 'enc'`), with another
  `alg` or key type, or with a modulus under 2048 bits are skipped.

## Store and host id (`store.test.ts`, `host-id.test.ts`)
- **Scenario: chatgpt-store-round-trip** — the state written is read back; a tampered, foreign or
  unparsable blob reads as nothing; writes are atomic and 0600; without OS protection nothing is
  stored.
- **Scenario: chatgpt-host-id-format** — `urn:uuid:` and a lower-case v4 UUID; a tampered file is
  replaced by a new id.

## Route (`apps/desktop/src/main/agent/__tests__/chatgpt-spec.test.ts`)
- **Scenario: chatgpt-route-model-ids** — `routeModelId('chatgpt', 'chatgpt/<slug>')` is the slug;
  a catalogue id on `chatgpt`, a ChatGPT id on a key route, and malformed slugs are refused.
- **Scenario: chatgpt-route-endpoint** — `MODEL_REQUESTS.chatgpt` is exactly
  `POST CHATGPT_ENDPOINTS.responses`.
- **Scenario: chatgpt-route-headers** — the header allowlist is `byok-openai`'s; main adds
  `Authorization: Bearer <access token>` and the content type only.
- **Scenario: chatgpt-route-body** — `store: false` and `stream: true` are required; no
  `CHATGPT_FORBIDDEN_BODY_FIELDS`; no `system` message; every input item carries its identifying
  keys (a message its `role` and `content`); tools only in the `frost` namespace; `tool_choice`
  only a mode; a repeated key is checked (and sent) as its last value, and `__proto__` is refused
  as an unknown key at every level.
- **Scenario: chatgpt-route-body (never both)** — a body never passes both `byok-openai`'s and
  `chatgpt`'s checks, even with the same slug: the key route requires `max_output_tokens`, the plan
  forbids it (checked over every combination of the fields that differ).
- **Scenario: chatgpt-error-codes** — each documented code maps to its reason; any other code is
  `null`; the refresh-failure codes are exactly the documented six. `error.param` is kept only as a
  field path (`CHATGPT_ERROR_PARAM_PATTERN`: letters, digits, `_`, `.`, `[`, `]`, 128 at most).

## Through the proxy (Task 3: `model-proxy-chatgpt.test.ts`, `session-chatgpt.test.ts`, `chatgpt/__tests__/route.test.ts`, `settings.test.ts`)
- **Scenario: chatgpt-proxy-token-injection** — a `chatgpt` request goes to `CHATGPT_ENDPOINTS.responses`
  with the runtime's allowlisted headers, `content-type` and `Authorization: Bearer <access token>`
  only (no `openai-organization` / `openai-project`, no cookie), `redirect: 'error'`,
  `credentials: 'omit'`; the token never reaches the runtime or a log line.
- **Scenario: chatgpt-proxy-redirect-refused** — a redirect is refused (`redirect`), not followed.
- **Scenario: chatgpt-proxy-401-refresh-retry** — a `401` refreshes the token once (with the refused
  token as `rejected`) and sends the request once more; the runtime sees only the retry's answer;
  a second `401` goes to the runtime as a status (no body), with no third request.
- **Scenario: chatgpt-proxy-401-refresh-refused** — when that refresh is refused, the sign-in is
  `expired`, the request is refused (`no-key`, no strike) and `signed-out` is reported.
- **Scenario: chatgpt-proxy-error-codes** — an error answer's body is read in main (at most
  `CHATGPT_LIMITS.maxErrorBodyBytes`) and never passed on or logged; each documented `error.code`
  reports its reason (`chatgptAnswerFailure`; `unsupported` with a well-formed `error.param`); a
  direct-admission `{ detail }` reports by status (`401` after the retry → `plan-usage-off`, `403` →
  `not-eligible`, `503` → `plan-unavailable`); anything else (or an oversized, unparsable body) is an
  ordinary failure. The runtime gets the status and the allowlisted headers, as on the key routes.
- **Scenario: chatgpt-proxy-stream-failure** — a `response.failed` (or `error`) event with a
  documented code after streaming began is reported (`chatgptStreamFailure`); the stream reaches
  the runtime unchanged.
- **Scenario: chatgpt-proxy-plan-paused** — after `usage-limit`, `not-eligible`, `plan-usage-off`,
  `unsupported` or `signed-out`, no request goes out on the plan until no turn runs (`plan-paused`,
  no strike): the SDK's retry doesn't repeat it. A token failure that arrives after its request
  ended (aborted, timed out, the turn over) is neither reported nor pauses the next turn; a change
  of the account (sign-in, re-consent, sign-out: `ChatgptRoute.onAccountChange`) lifts the pause.
- **Scenario: chatgpt-proxy-401-refresh-retry (ended)** — a `401` for a request that already ended
  (aborted or timed out) is not retried and refreshes nothing.
- **Scenario: chatgpt-proxy-signed-out** — signed out (or expired), no request is sent and
  `signed-out` is reported; signed in without plan usage, `plan-usage-off`.
- **Scenario: chatgpt-proxy-model-listed** — a ChatGPT model the account's last list lacks is
  refused (`model`).
- **Scenario: chatgpt-proxy-route-switch-mid-turn** — `byok-openai` and `chatgpt` share one URL: a
  request shaped for the route a running turn began on (the user switched since) is refused as
  `model` (no strike) and never sent with the other route's credential; once no turn runs, the old
  route is forgotten. The route a turn began on is the settings' value before the change (the
  settings' `onChange` passes it), so a proxy made before the settings file was read still knows it.
- **Scenario: chatgpt-settings-model-list** — the account's last model list is kept in the settings
  file (`isChatgptModelView` entries, at most `maxModels`); `chatgpt/<slug>` is accepted only from
  it (`isUsableModelSettings`); a restart without network keeps the choice; a new list without the
  chosen model moves the choice to its first model. The file's size cap is derived from the list's
  bounds, so the largest list allowed is written and read back; a write over the cap is refused.
- **Scenario: chatgpt-models-refreshed** — the list is asked for when an account becomes signed in
  with plan usage on (or another account does) and once at start; a token refresh doesn't ask
  again; a failed list keeps the last one, and so does an empty one (or one nothing in survives
  the filter).
- **Scenario: chatgpt-account-change** — the route tells its listeners when the account's state,
  email or plan usage changes, not on a token refresh.
- **Scenario: chatgpt-route-ready** — a turn may start on the route only when signed in, plan usage
  is on and the chosen model is in the last list.
- **Scenario: chatgpt-session-setup** — `setup.chatgpt` is the account's view and models,
  `allowedModels` on the route are the listed ids, and `ready` follows the route.
- **Scenario: chatgpt-session-send** — a send on the route that isn't ready answers `setup-needed`;
  a ready one posts `chat.start` with the `chatgpt` route and the `chatgpt/<slug>` id.
- **Scenario: chatgpt-session-setup-messages** — that `setup-needed` notice says what the plan needs
  (`CHATGPT_SETUP_MESSAGES[chatgptSetupReason(account, models)]`), never the key routes' "Add a key":
  sign in (signed out), finish in the browser (pending), sign in again (expired), turn on plan usage
  (declined), no models listed yet, or choose a listed model.
- **Scenario: chatgpt-session-error** — a failure the proxy reports during a running turn on the
  route is what the chat shows when the turn fails: `error` is `chatgptFailureMessage(failure)` and
  `chatgptError` the failure (never the runtime's words); a failure reported with no turn running
  isn't kept; the next turn clears both.

## Router and wiring (Task 5: `packages/ipc-contract/src/__tests__/agent-router.test.ts`, `session-chatgpt.test.ts`, `chatgpt/__tests__/opener.test.ts`, `key-never-leaves-main.test.ts`)
- **Scenario: agent-chatgpt-procedures** — `agent.chatgptSignIn` (`AgentChatgptSignInInputSchema`:
  `reconsent`, `differentAccount`), `chatgptCancel`, `chatgptSignOut` and `chatgptAcknowledge` pass
  `enforceSender`; sign-in hands the service the sender's own window id (the session passes it on as
  `windowId`, the window a successful sign-in focuses); every answer is checked
  against its fixed set (`CHATGPT_SIGN_IN_RESULTS`, `CHATGPT_SIGN_OUT_RESULTS`, a boolean).
- **Scenario: chatgpt-session-sign-in-spends-the-gesture** — the session spends the sender window's
  live user gesture (main's per-window tracker, as Search Console's connect) before it calls
  `signIn`; without one it answers `needs-gesture` and nothing opens.
- **Scenario: chatgpt-browser-opener** — main opens only `isChatgptAuthorizeUrl` URLs (the authorize
  endpoint with a query), only when the sign-in spent a gesture, through the scheme-allowlisted opener.
- **Scenario: key-never-leaves-main (ChatGPT plan)** — signed in and running two turns on the plan
  (one after a refresh), the access, refresh and ID tokens and the code appear only in main's
  `Authorization` header: never in any panel state, the settings file, the chat record, a message
  to or from the runtime, a log line or the console; the sign-in's own file holds them sealed.
- **Scenario: proxy-accepts-real-provider-requests (MCP)** — on the plan the installed provider's
  request carries the MCP tools inside the `frost` namespace too, nothing at the top level.

## Runtime (Task 4: `apps/agent-runtime/src/__tests__/provider.test.ts`, `proxy-rules.test.ts`)
- **Scenario: provider-chatgpt-request** — on `chatgpt` the runtime builds the OpenAI provider's
  Responses model for the slug (placeholder key, proxied fetch) and sends: `store: false`,
  `stream: true`, every tool (frost's and MCP's) inside one `namespace` group named `frost`
  (`CHATGPT_TOOL_NAMESPACE`), `input` an array whose system prompt is a `developer` message (no
  `system` item), history function calls naming `namespace: 'frost'`, and none of
  `CHATGPT_FORBIDDEN_BODY_FIELDS` (no `max_output_tokens`, `temperature`, `top_p`); main's
  `checkModelRequestBody('chatgpt', …)` accepts it as sent. A namespaced function call the model
  makes round-trips: the next step's request carries it with its namespace and its output.
  A `401`/`403` the turn ends on is worded about the ChatGPT sign-in, not a key.
- **Scenario: proxy-accepts-real-provider-requests (chatgpt)** — the installed provider's first and
  second requests on the route pass main's rules, and a key route's rules refuse them.

## Panel (Task 5: `apps/desktop/src/renderer/__tests__/agent-chatgpt-view.test.ts`, `agent-chatgpt-components.test.ts`)
The renderer sees `ChatgptAccountView` and the account's model list only (never a token); every
word is `CHATGPT_UI` / the messages. A sign-in is a click: main spends that click's gesture.
- **Scenario: chatgpt-route-offered** — the route select offers every route, `chatgpt` as "ChatGPT plan".
- **Scenario: chatgpt-model-labels-from-account-list** — a ChatGPT model is named by the account
  list's `display_name`; one the list lacks shows its id.
- **Scenario: chatgpt-route-switch-picks-listed-model** — switching to the plan keeps a listed
  current model, else the list's first; leaving it picks a catalogue model again.
- **Scenario: chatgpt-route-preview-before-models** — picked before the account listed a model, the
  route is only previewed (its sign-in shown, nothing stored); once a list arrives, its first model
  is stored with the route.
- **Scenario: chatgpt-checklist-sign-in-line** — on the plan the checklist's key line is the
  sign-in's state (not signed in, waiting, signed in, plan usage off, sign-in ended).
- **Scenario: chatgpt-settings-signed-out** — "Continue with ChatGPT" (primary) and what the route is.
- **Scenario: chatgpt-settings-pending** — "Waiting for the browser…" and Cancel.
- **Scenario: chatgpt-settings-signed-in** — "Signed in as <email>", plan usage on, Sign out, "Use a
  different account".
- **Scenario: chatgpt-settings-plan-usage-declined** — the declined sentence and "Turn on plan
  usage" first (a re-consent sign-in).
- **Scenario: chatgpt-settings-expired** — the expired sentence, "Sign in again" first, "Use a
  different account".
- **Scenario: chatgpt-settings-sign-in-errors** — the last sign-in's failure in fixed copy
  (`store-unreadable` included); `account-mismatch` offers "Use a different account"
  (`differentAccount`).
- **Scenario: chatgpt-sign-in-and-out-answers** — `needs-gesture`, `no-keychain`, `browser-failed`,
  `failed`, `not-revoked` each have their sentence (a sign-in's `not-revoked`, from "Use a different
  account", is `CHATGPT_UI.switchNotRevoked`: nothing was switched).
- **Scenario: chatgpt-settings-no-token** — nothing beyond the view's fields is ever shown.
- **Scenario: chatgpt-settings-preview-then-store** / **chatgpt-settings-route-switch-with-models** /
  **chatgpt-settings-model-select-from-account** / **chatgpt-settings-pending-cancel** /
  **chatgpt-settings-actions** / **chatgpt-settings-needs-gesture** / **chatgpt-settings-error-states**
  — the settings component calls `chatgptSignIn` (`{}`, `{ reconsent }`, `{ differentAccount }`),
  `chatgptCancel`, `chatgptSignOut` and `setModel` only as above, and shows each answer.
- **Scenario: chatgpt-composer-in-use-and-notice** / **chatgpt-composer-line** — while the route is
  selected and the account is signed in with plan usage on, "Using ChatGPT plan · Manage usage" by
  the composer (never signed out, pending, expired, declined, or before the sign-in was read); "Manage usage" is a
  `target="_blank"` link to `CHATGPT_USAGE_URL` (the app window's open handler sends it to the
  system browser through the scheme allowlist, on the click's gesture).
- **Scenario: chatgpt-one-time-notice** — signed in with plan usage on and not yet dismissed: "You're
  using your ChatGPT plan" with "Got it" (`chatgptAcknowledge`, persisted by main).
- **Scenario: chatgpt-error-recovery** / **chatgpt-usage-limit-manage-usage-first** /
  **chatgpt-error-recoveries** — a turn's `chatgptError` shows `chatgptFailureMessage` (never the
  runtime's words) and its recovery: `usage-limit` "Manage usage" as the primary action under
  "Usage limit reached"; `plan-usage-off` "Turn on plan usage"; `signed-out` "Sign in again";
  `plan-unavailable`, `not-eligible` and `unsupported` (its param named) none.
- **Scenario: chatgpt-settings-cancel-while-busy** — Cancel works while another action's answer is
  still awaited (it is never held back by the busy guard).
- **Scenario: chatgpt-error-recovery-busy** — the banner's "Sign in again" / "Turn on plan usage" is
  disabled until the sign-in it asked for answers: a double click starts one sign-in.
- **Scenario: chatgpt-settings-live-region** — the account's state (who is signed in, the state's
  sentence, the last sign-in failure, an action's answer) is in one live region that is always
  rendered (`role="status"`), so signing in, expiring and errors are announced, not only "Waiting".
- **Scenario: chatgpt-settings-focus** — when the button that was clicked goes away (Continue →
  Cancel → Sign out; "Got it" removes the notice) and focus was left on nothing, focus moves to the
  section's first action ("Manage usage" by the composer once the notice is gone).
- **Scenario: chatgpt-settings-model-label** — the "Model" label names the model select; when the
  account has listed no model (a sentence instead of a select), it is a plain heading, not a label.

## Known limitations
- **One click can back two opens.** The ChatGPT sign-in spends the sender window's gesture from
  main's per-window tracker (`apps/desktop/src/main/account/gestures.ts`, shared with the account
  sign-in and Search Console's connect), while the app window's `window.open` handler
  (`apps/desktop/src/main/security/register.ts`, "Manage usage") reads its own tracker
  (`security/gesture.ts`). One click could therefore back both a `window.open` and a `chatgptSignIn`.
  Low risk: each opener still accepts only its own allowlisted URL (the authorize page with a query;
  the scheme-allowlisted external link), both are real user clicks in frost's own chrome, and the
  tracker's gesture is spent once, so a click can't open more than one sign-in. Unifying the two
  trackers is left for later.

## End to end (Task 6: `apps/desktop/src/main/agent/chatgpt/__tests__/e2e-seam.test.ts`, `apps/desktop/e2e/agent-chatgpt.e2e.ts`)
The seam: `specs/agent-chatgpt-e2e.schema.ts` (`CHATGPT_E2E_SWITCH`, `ChatgptE2eSeamSchema`,
`isChatgptE2eUrl`). In an unpackaged build started with `--frost-e2e-chatgpt=<file>`, the sign-in
service gets the file's `endpoints` (its `endpoints` dependency; `CHATGPT_ENDPOINTS` is unchanged),
the model proxy sends a plan request that passed every check to `endpoints.responses` (the runtime's
request is still checked against `MODEL_REQUESTS.chatgpt`), the authorize page is "opened" by an
HTTP `GET` in main that follows its redirect to the loopback callback (no browser), and
`store: 'memory'` keeps the sign-in in main's memory (CI without a keychain). The fake
(`apps/desktop/e2e/fake-chatgpt.ts`) is an OpenID-style issuer on `127.0.0.1`: an RS256 ID token
signed by a key made per run (`node:crypto`), a JWKS, the issued `client_id` on a first
registration's redirect, PKCE S256, code / refresh / revoke, `GET /v1/models` and a scripted
`POST /v1/responses` stream. CI makes no call to OpenAI.
- **Scenario: chatgpt-e2e-seam-unpackaged-only** — a packaged build never reads the seam and refuses
  to start with `--frost-e2e-chatgpt` (`PACKAGED_FORBIDDEN_SWITCHES`); unpackaged, a file that is
  missing, too long, not JSON or names any URL other than `http://127.0.0.1:<port>/…` turns the seam
  off (the real endpoints stay).
- **Scenario: chatgpt-e2e-browser** — the stand-in browser opens only the seam's authorize URL on a
  spent gesture, and follows exactly one redirect, only to `http://127.0.0.1:<port>/auth/callback`.
- **Scenario: chatgpt-e2e-proxy-destination** — under the seam a plan request goes to the fake's
  Responses URL; a request for any other URL is refused as before; without the seam it goes to
  `CHATGPT_ENDPOINTS.responses`.
- **Scenario: chatgpt-e2e-sign-in-turn** — a real click on "Continue with ChatGPT" signs in (first
  registration: `dynamic_agent_client`, then the issued client id), the settings say "Signed in as
  <email>", the model select lists the fake's `list` models, the one-time notice's "Got it" dismisses
  it, and a turn whose first response is a `frost`-namespaced `function_call` to `page_text` runs the
  tool and finishes with the second response's text. The fake saw `store: false`, `stream: true`,
  every tool in the `frost` namespace, `Authorization: Bearer <its access token>` and no API key; the
  access token is nowhere in the chrome's DOM.
- **Scenario: chatgpt-e2e-usage-limit** — a `subscription_sharing_usage_limit_exceeded` answer ends
  the turn with "Usage limit reached" and "Manage usage" as the primary action.
- **Scenario: chatgpt-e2e-sign-out-and-switch** — Sign out revokes the refresh token at the fake;
  "Use a different account" revokes, then registers again (`dynamic_agent_client`) and may come back
  as another account.
