# Agent — ChatGPT plan route (Sign in with ChatGPT) Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. Tasks 2 and 3 (tokens, the proxy) get a security-focused review. Do not commit
> unless the lead asks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a user with a ChatGPT Plus or Pro plan can sign in with ChatGPT in the agent's settings and
run the agent on their plan, instead of an API key. Everything else about the agent is unchanged:
the same chat loop (AI SDK in the runtime), the same tools, approvals, MCP, history and retention.

**Spec sources** (OpenAI, fetched 2026-10-29; copies in the lead's notes, not in the repo):
- Sign in with ChatGPT, open-source token sharing: `https://developers.openai.com/siwc` and
  `/siwc/token-sharing-open-source/{sign-in,models-and-inference,profiles-and-sessions,errors-and-recovery,preview-limitations,token-reference}`,
  `/siwc/ui-ux-guidelines`.
- Discovery: `https://auth.openai.com/.well-known/openid-configuration`.
- The devkit (`github.com/openai/sign-in-with-chatgpt-devkit`) is **reference only**: its licence is
  noncommercial and copyleft-incompatible with AGPL. Clean-room: read the protocol, write our own.

## Decisions (made by the lead; recorded here)
1. **Official flow, not Codex.** OpenAI's Codex docs: app-server authentication "has never been
   permitted for commercial or hosted services". Sign in with ChatGPT's token sharing is offered to
   "open-source tools and personal projects that run locally"; frost is open source (AGPL) and runs
   locally. If frost is ever offered as a paid or hosted service, join OpenAI's partner waitlist
   first. No Codex binary, no `chatgpt.com/backend-api`.
2. **A fourth model route, `chatgpt`.** It serves OpenAI models through the existing OpenAI path:
   the runtime's AI SDK `createOpenAI(...).responses(slug)` behind main's model proxy, to the one
   URL `https://api.openai.com/v1/responses`. Main injects `Authorization: Bearer <access token>`;
   the token never reaches the runtime, the renderer, logs or the model (as keys today).
3. **Tokens live in main**, in `main/agent/chatgpt/`, encrypted with `safeStorage` (the
   credentials store's rules: refuse without a keychain, 0600, atomic writes). The renderer sees
   only `{ state, email, planUsage }`.
4. **Tools are namespaced.** The route accepts function tools only inside a namespace. The runtime
   gives every tool `providerOptions.openai.namespace = { name: 'frost', description }` on this
   route (`@ai-sdk/openai` ≥ 4.0.104 groups them and round-trips the call's namespace).
5. **Models come from the account.** `GET https://api.openai.com/v1/models` with the token answers
   `{ models: [{ slug, display_name, visibility }] }`; frost lists `visibility === 'list'` in the
   server's order, refreshed on sign-in and account change. A ChatGPT model id is `chatgpt/<slug>`
   and is valid only while it is in the last list (persisted with the settings, so a restart
   without network keeps the choice).
6. **One account.** v1 keeps a single ChatGPT profile (sign out to switch). Multi-profile later.
7. **Required UI (OpenAI's UI/UX guidelines):** a "Continue with ChatGPT" button; a one-time
   "You're using your ChatGPT plan" notice with "Got it"; "Using ChatGPT plan" with a "Manage
   usage" link (`https://chatgpt.com/settings/usage`) near the composer while the route is active;
   at the usage limit, "Manage usage" as the primary action.

## Protocol (what main implements)
- **Host id:** generated once per install, `urn:uuid:<uuidv4>`, stored in `userData`
  (`agent-chatgpt-host.json`). Opaque; not a credential.
- **Authorize:** open `https://auth.openai.com/api/accounts/authorize` in the system browser with
  `response_type=code`, `client_id` (`dynamic_agent_client` on first registration, else the issued
  id), `agent_name_hint=frost` (first registration only), `ext_agent_host_id`, `redirect_uri`,
  `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
  `resource=https://api.openai.com/v1`, `state`, `nonce`, `code_challenge` (S256). Re-consent adds
  `prompt=consent`.
- **Redirect:** `http://127.0.0.1:<port>/auth/callback` (never `localhost`; only the port varies;
  the same string in authorize and token exchange). Reuse `main/account/loopback.ts` (path made a
  parameter) and `main/account/pkce.ts`.
- **Callback:** `code`, `state`, `scope`, and on first registration `client_id` (`oaiapp_…`). Check
  `state`; on a first registration without `client_id`, fail (`registration-incomplete`). Persist the
  issued `client_id` **before** the code exchange.
- **Token:** `POST https://auth.openai.com/api/accounts/oauth/token` (form): `grant_type=authorization_code`,
  `client_id`, `code`, `code_verifier`, `redirect_uri`, `resource`. Answer: `access_token`,
  `refresh_token`, `id_token`, `token_type`, `expires_in`, `scope`, `earliest_refresh_at`.
- **ID token:** RS256 against `https://auth.openai.com/.well-known/jwks.json` (Node `crypto`,
  JWK import; no new dependency), `iss = https://auth.openai.com`, `aud` = issued client id,
  `exp`, `nonce`, `azp` when present; a returning account's `sub` must match.
- **Plan usage** is on only when the granted `scope` contains `chatgpt.tokens.use.direct`.
  Signed in without it: `planUsage: 'declined'`, offer re-consent.
- **Refresh:** 60 s before expiry (not before `earliest_refresh_at`), serialized (rotating refresh
  tokens): `grant_type=refresh_token`, `client_id`, `refresh_token`, `resource` (no `scope`).
  `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused` → `state: 'expired'` (sign in again with the
  saved client id). A single 401 from Responses is not proof of revocation: refresh once, then fail.
- **Sign out:** `POST https://auth.openai.com/api/accounts/oauth/revoke` (`token=<refresh>`,
  `token_type_hint=refresh_token`, `client_id`), then forget tokens. Keep host id and client id.
- **Requests:** `Authorization: Bearer` only; no `openai-organization` / `openai-project`; redirects
  refused. Body: `store: false`, `stream: true`, `input` an array, no `role: 'system'` items; never
  `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`,
  `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`,
  `top_logprobs`, `top_p`, `truncation`, `user`, `previous_response_id`.
- **Errors → user-facing reasons:** `subscription_sharing_usage_limit_exceeded` (429) →
  `usage-limit` (show Manage usage); `subscription_sharing_usage_unavailable`,
  `subscription_sharing_user_unavailable` (503) → `plan-unavailable` (retry later);
  `subscription_sharing_user_not_eligible` (403) → `not-eligible`;
  `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` (403) →
  `plan-usage-off` (re-consent); `subscription_sharing_unsupported_capability` (400) → a bug report
  with `error.param`; refresh failures above → `signed-out`.

## Global constraints
- The phase-5 constraints hold: tokens never reach the renderer, logs, the runtime or the model's
  context; all IPC goes through `ipc-contract` with `enforceSender`; the proxy sends only allowlisted
  URLs, headers and body fields.
- Auth endpoints are fixed constants in `specs/agent-chatgpt.spec.ts`; main fetches them on its own
  session partition (`agent-chatgpt`, in memory), `redirect: 'error'`, `credentials: 'omit'`.
- Clean-room. Spec first, a failing test citing the spec, then code. Phase-5 team contract applies
  (new files under the agent paths; hub files get one-line registrations only).
- CI makes no call to OpenAI. Unit tests use a fake auth server and fake Responses; the e2e uses
  an unpackaged-only seam (below).

## Tasks
### Task 1 — Spec
- [ ] `specs/agent-chatgpt.feature.md`: sign-in, plan usage, refresh, sign-out, errors, UI, as above.
- [ ] `specs/agent-chatgpt.spec.ts`: endpoints, scope, resource, redirect path, host-id file,
  refresh margin, error-code → reason map, refresh-failure codes, usage URL, UI strings,
  `isChatgptModelId`, the stored-state Zod schema (no tokens in any renderer-facing type).
- [ ] Route additions: `MODEL_ROUTES` += `chatgpt` (`agent-tools.spec.ts`; `routeModelId` for
  `chatgpt/<slug>`), proxy rules (`agent-proxy.spec.ts`: `MODEL_REQUESTS`, header allowlist =
  `byok-openai`'s, `BODY_FIELDS` without the forbidden fields and with `store === false` and
  `stream === true` required, `mainRequestHeaders`), labels (`agent-panel.spec.ts`), IPC inputs
  (`agent-ipc.schema.ts`: `chatgptSignIn`, `chatgptCancel`, `chatgptSignOut`,
  `chatgptAcknowledge`), session view (`agent-session.spec.ts`: `AgentSetupView.chatgpt`).

### Task 2 — ChatGPT auth service (main) — security review
- [ ] `main/agent/chatgpt/{host-id,oauth,id-token,store,service}.ts` per Protocol. Injected deps
  (fetch, clock, safeStorage, fs, openExternal, loopback) so Vitest runs it with fakes.
- [ ] Tests: first registration persists client id before exchange; missing client id fails; state
  mismatch fails; ID token checks (bad sig / iss / aud / nonce / exp / sub change); declined scope;
  refresh margin + `earliest_refresh_at`; concurrent refreshes coalesce; rotation persisted;
  refresh-failure codes → expired; sign-out revokes then forgets; no token in any returned view.

### Task 3 — Route through the proxy — security review
- [ ] `model-proxy.ts`: for `chatgpt`, the credential is `chatgpt.withAccessToken(fn)` (refreshing as
  needed); on a 401 refresh once and retry once; map the error codes above to proxy refusals /
  session errors the panel can show.
- [ ] Models: `chatgpt.listModels()`; `session.ts` `allowedModels` for the route; settings accept a
  `chatgpt/<slug>` from the persisted list.
- [ ] Tests: proxy-rules (headers, forbidden fields, `store`/`stream`), token injection, 401 path,
  each error code, route switch mid-turn.

### Task 4 — Runtime
- [ ] `agent-runtime/src/provider.ts`: `chatgpt` → `createOpenAI({ apiKey: PLACEHOLDER, fetch }).responses(slug)`
  with `providerOptions.openai = { store: false }`; `chat.ts`: on this route every tool (frost and
  MCP) carries `providerOptions.openai.namespace = { name: 'frost', description }`, and no
  `maxOutputTokens` / `temperature` is sent.
- [ ] Tests: the captured request body (`provider-capture`) has a `namespace` tool group, `store:
  false`, `stream: true`, none of the forbidden fields; a namespaced function call round-trips.

### Task 5 — IPC and UI
- [ ] `agent-router.ts` procedures (Task 1 inputs) with `enforceSender`; the sign-in opens the
  system browser from main.
- [ ] `AgentSettings.tsx`: route option "ChatGPT plan"; signed out → "Continue with ChatGPT";
  pending → "Waiting for the browser…" + Cancel; signed in → email, plan usage on/declined
  (re-consent), Sign out. Model select from the account's list.
- [ ] Composer: "Using ChatGPT plan · Manage usage" while the route is active; first use shows the
  one-time notice ("Got it" → `chatgptAcknowledge`); usage-limit error shows "Manage usage" first.
- [ ] Renderer tests (`agent-view.test.ts` patterns).

### Task 6 — E2E
- [ ] Unpackaged-only seam `--frost-e2e-chatgpt=<file>` (refused when packaged, like the agent
  script seam) pointing the auth endpoints and Responses at a local fake server; `agent.e2e.ts`:
  sign in → model list → a turn with a tool call (namespaced) → usage-limit error shows Manage
  usage → sign out revokes.

## Open questions (verify live with a real Plus/Pro account before release)
- That top-level `namespace` tool groups from `@ai-sdk/openai` are accepted as-is (docs: "Group
  function/custom tools in namespaces").
- Whether `ext_agent_host_id` is accepted on every request (the devkit leaves it off by default).
- Free / Team / Enterprise eligibility (docs name Plus and Pro).
