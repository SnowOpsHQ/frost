# Feature: Agent host, key store and model proxy (main)

Spec: `specs/agent-proxy.spec.ts` (`AGENT_HOST_LIMITS`, `CREDENTIAL_SLOTS`, `normalizeKey`,
`AGENT_PROXY_LIMITS`, `REQUEST_HEADER_ALLOWLIST`, `filterRequestHeaders`, `mainRequestHeaders`,
`RESPONSE_HEADER_ALLOWLIST`, `filterResponseHeaders`, `BODY_FIELDS`, `checkModelRequestBody`),
`specs/agent-protocol.schema.ts`, `specs/agent-tools.spec.ts` (`MODEL_REQUESTS`,
`isAllowedModelRequest`, `routeModelId`). Phase 5 Task 3 (`docs/plans/phase-5-ai-agent.md`,
decisions 1, 3, 5 and 6; threat model rows "A key leaks" and "The agent reaches arbitrary hosts").
Code: `apps/desktop/src/main/agent/` (`host.ts`, `credentials.ts`, `model-proxy.ts`, `settings.ts`,
`entitlements.ts`, `index.ts`). Tests: `apps/desktop/src/main/agent/__tests__/`. Each line maps to
one named test.

## Decisions
- **Main decides, the runtime asks.** The route and model come from main's settings, never from
  the runtime's `chat.start` or `fetch.request`. A request goes out only for the configured route's
  one method and URL, with an allowlist of headers (credential, cookie, host, proxy, organisation
  and observability headers dropped by omission), a body naming the configured model and nothing
  server-side, and main's own credential header. The URL sent is the allowlist's string, and the
  body sent is the parsed, checked object written back out (`JSON.stringify`): a repeated key in
  the runtime's text can't make the provider read something other than what was checked. The body
  check is a nested allowlist (top-level fields, then each message's, block's, part's, tool's and
  provider options' keys, and which role may carry which block), built from what the installed
  providers emit, reasoning included; every request must cap its output at `MAX_OUTPUT_TOKENS`
  (the runtime sends it; the Anthropic provider's default is the model's maximum). Every allowed
  provider option has a value shape (enums, booleans, `store` only `false`); the gateway's
  Anthropic `thinking` is allowed only when its budget fits beside the output cap (the provider asks
  for `maxOutputTokens + budgetTokens`). A tool call's caller is passed back only as
  `{ type: 'direct' }` (the Anthropic provider returns a response's `caller` on the next step).
- **Requests only for turns.** The host hands a `fetch.request` to the proxy only while a chat main
  started is running, and at most `MAX_MODEL_REQUESTS_PER_TURN` per running turn; it refuses any
  other itself. The budget is shared by the turns running at once, on purpose: a `fetch.request`
  names no chat, and a chat id the runtime claimed would be its own word, so a split per chat would
  bound nothing the shared total doesn't. When the last turn ends, the proxy stops whatever is still in flight.
- **Floods restart the runtime.** Each dropped message and each refusal the runtime caused is a
  strike (not `no-key`, `key-unavailable`, a redirect, or a request for the route or model the user
  just switched away from); past
  `maxStrikesPerWindow` strikes, or `maxInboundPerWindow` messages, in a `floodWindowMs` window the
  host kills the runtime (`misbehaved`, a failure toward `maxConsecutiveFailures`, never reset by a
  long run) and starts another after the backoff. Refusal log lines are coalesced: one per reason
  per `logWindowMs`, the next one saying how many were left out.
- **The key stays in main's proxy.** Keys are stored per slot (`anthropic`, `openai`, `gateway`),
  encrypted with `safeStorage`, in one 0600 file written atomically. Only `withKey` sees a key, for
  the duration of one call, and only the proxy is given it; the settings page gets a view with no
  `withKey`. Keys never appear in a message to the runtime, a log line, an error or an answer.
  A key is stored and used only with `os` protection: the agent process runs unsandboxed as the
  user, so with Chromium's fixed key (`weak`) it could decrypt the file offline or plant a blob of
  its own; `setKey` answers `no-keychain` (the settings page says "no OS keychain available") and a
  stored key counts as absent. On Linux a blob must carry the secret service's `v11` tag. Each blob
  is bound to its slot (it encrypts `frost-agent-key/2`, the slot and the key; another slot's blob
  is refused, one from before the envelope counts as no key). A read error is not remembered and
  never leads to a write over the file; files are flushed before the rename, and the directory
  after it where the platform allows. It uses `safeStorage`'s asynchronous API (Electron 45 deprecates the synchronous one, whose
  `isEncryptionAvailable()` answers `false` on Linux where the asynchronous encryptor works). With
  no encryption the store refuses (`unavailable`); on Linux the encryptor's output says which key it
  used: `v11` (the desktop's secret service) is `os`, `v10` (Chromium's fixed key: no secret
  service, or `--password-store=basic`) is `weak`: stored, and said so. `getSelectedStorageBackend`
  is not used, not even as an extra "weak" signal: on Electron 45 it reports `basic_text` while the
  asynchronous encryptor still finds a secret service (verified on this project's Linux desktop:
  `v11` data under a `basic_text` backend), so it would refuse keys the keychain does protect.
- **No redirect, no cookie, bounded.** Requests use `redirect: 'error'` (Electron 45 rejects a 3xx
  with "Attempted to redirect, but redirect policy was 'error'"; `manual` rejects too, "Redirect
  was cancelled"), `credentials: 'omit'` (verified: no cookie sent or stored) on the in-memory
  `agent-model` session, an idle timeout, a total time cap, `maxResponseBytes`, at most
  `maxConcurrentRequests` at once, and one live request per id.
- **Honest lockdown.** Electron 45 does not enforce Node's permission model in a utility process.
  The host passes the flags anyway and reports the runtime's own `ready.lockdown`
  (`permissionModel: false` there), so the settings page can say "File sandbox: not in effect".
- **Settings in a file.** Route and model live in `agent-settings.json` in `userData`: the
  database's settings repository is typed per setting, and Phase 5 doesn't edit other phases'
  tables for two values.

## Host (`host.test.ts`)
- **Scenario: host-lazy-fork** — nothing is forked until `start()`; then the runtime is forked once
  from `<buildDir>/agent-runtime.cjs` with `serviceName: 'frost agent'`, an environment of
  `NODE_ENV` only, `--permission --allow-fs-read=<buildDir>`, `stdio` `ignore` when packaged and
  `inherit` otherwise, and `port2` is transferred with a `null` message.
- **Scenario: host-ready** — `ready` with `AGENT_PROTOCOL_VERSION` makes the status `ready`,
  resolves `start()` and exposes the lockdown report (`permissionModel` as reported).
- **Scenario: host-drops-invalid** — a non-object, an unknown type, a main → runtime type, an extra
  field, a message before `ready` and a second `ready` are dropped and counted; no listener sees one.
- **Scenario: host-chat-ids** — chat events and `tool.invoke` for a chat main never started are
  dropped; `chat.finish` / `chat.error` end a chat.
- **Scenario: host-fetch-needs-a-turn** — a `fetch.request` with no turn running, or past the
  running turns' `MAX_MODEL_REQUESTS_PER_TURN`, is answered `refused` by the host and never reaches
  the proxy; `fetch.abort` still does; once the turn ends, requests are refused again.
- **Scenario: host-flood-restarts** — `maxStrikesPerWindow` strikes in a window are tolerated, one
  more kills the runtime (`misbehaved`) and another starts after the backoff; more than
  `maxInboundPerWindow` messages in a window do too.
- **Scenario: host-send-validated** — a message that fails `MainToRuntimeMessageSchema`, or any
  message before `ready`, is not posted and `send` answers `false`; a second `chat.start` for a
  running chat is refused.
- **Scenario: host-ready-timeout-restarts** — no `ready` within `readyTimeoutMs` → the process is
  killed and forked again after the backoff.
- **Scenario: host-protocol-mismatch** — `ready` with another protocol version → killed, status
  `stopped`, failure `protocol-mismatch`, no restart; `start()` answers `false`.
- **Scenario: host-crash-fails-chats** — an exit while chats run answers each with `chat.error`
  (`AGENT_CRASHED_MESSAGE`) and restarts after a growing, capped backoff; after
  `maxConsecutiveFailures` it stops (`crashed`) until the next `start()`.
- **Scenario: host-dispose** — `dispose()` kills the runtime, cancels a pending restart and leaves
  it `stopped`; `start()` answers `false`.

## Credentials (`credentials.test.ts`)
- **Scenario: credentials-file-not-plaintext** — after `setKey` the file holds no key text (raw or
  base64) and was written to a temporary 0600 file, flushed, then renamed over the old one.
- **Scenario: credentials-only-withkey-returns-key** — `hasKey`, `setKey`, `clearKey` and
  `protection` never answer the key; `withKey` runs its closure with it; the settings view has no
  `withKey`.
- **Scenario: credentials-key-validated** — a key is trimmed; one too short, too long, or with a
  space or non-ASCII character is refused (`invalid`) and nothing is written.
- **Scenario: credentials-protection** — `unavailable` (no encryption) and `weak` (Linux, `v10`
  data) both make `setKey` answer `no-keychain` with nothing written; `os` otherwise; encryption
  that goes away is reported again.
- **Scenario: credentials-weak-blob-never-used** — on Linux a `v10` blob (planted) is never used;
  with `weak` protection even a good blob is not; on macOS the tag is not checked.
- **Scenario: credentials-bound-to-slot** — a blob moved into another slot is refused (`failed`,
  `hasKey` false); what is encrypted is the envelope with the slot.
- **Scenario: credentials-old-format-is-no-key** — a blob holding the bare key (before the
  envelope) is no key; setting the key again works.
- **Scenario: directory-sync-best-effort** (`durable.test.ts`) — the directory is flushed after a
  rename; a platform that refuses (EISDIR, EPERM) is ignored and the handle closed.
- **Scenario: credentials-read-error-not-cached** — a file that can't be read makes `setKey` and
  `clearKey` fail without writing (other slots survive); once readable it is read afresh.
- **Scenario: credentials-re-encrypted-when-asked** — when decryption answers `shouldReEncrypt`, the
  key is stored again under the encryptor's current key before the closure runs.
- **Scenario: credentials-clear** — `clearKey` removes one slot and leaves the others.
- **Scenario: credentials-tampered-file** — a tampered file stores nothing, never throws, and a blob
  that fails to decrypt makes `hasKey` false and `withKey` answer `failed` (no key).

## Settings (`settings.test.ts`)
- **Scenario: settings-defaults** — no file: `gateway` and `DEFAULT_MODEL_ID`.
- **Scenario: settings-validated** — a model the route doesn't serve, or an unknown route or model,
  is refused; a valid pair is written and read back.
- **Scenario: settings-tampered** — an invalid stored pair reads as the defaults.

## Proxy rules (`proxy-rules.test.ts`, pure)
- **Scenario: proxy-request-headers-allowlist** — per route, only allowlisted headers survive
  (credential, cookie, host, proxy, transfer, organisation, observability headers dropped); unknown
  `anthropic-beta` flags are dropped; a repeated name keeps its first value only.
- **Scenario: proxy-credential-injection** — `x-api-key` for Anthropic, `Authorization: Bearer`
  for OpenAI and the gateway (plus `ai-gateway-auth-method: api-key`), and `content-type` JSON.
- **Scenario: proxy-response-headers-filter** — only allowlisted response headers pass
  (`set-cookie`, organisation ids, encoding and length headers dropped); the status text is kept
  only when printable ASCII and short.
- **Scenario: proxy-body-model-mismatch** — another model in the body (or, on the gateway, in
  `ai-language-model-id`; or two such headers) is refused.
- **Scenario: proxy-server-tools-refused** — Anthropic server tools and `mcp_servers`, OpenAI tool
  types other than `function`, gateway `provider` tools and provider-executed calls are refused.
- **Scenario: proxy-files-and-state-refused** — image, document and file parts, `file_id`
  inputs, `item_reference`, `previous_response_id`, gateway `content` tool outputs and unknown
  provider options are refused.
- **Scenario: proxy-duplicate-keys-canonical** — with a repeated key (`tools`, `store`, `model`, a
  block's `type`, `providerOptions`) the last one is checked and the body answered is the parsed
  object written back out, with no trace of the other.
- **Scenario: proxy-nested-allowlist** — unknown keys in a message, block, part, tool or provider
  options (citations, a `caller` other than `{ type: 'direct' }`, `defer_loading`, `allowed_callers`, `input_examples`, an OpenAI
  item `id` or annotation, compaction blocks) are refused, as are blocks in the wrong role (a
  `tool_result` from the assistant, a `tool_use` or thinking from the user, a gateway `tool-result`
  outside a `tool` message).
- **Scenario: proxy-gateway-option-values** — gateway provider options outside their value shapes
  are refused; an Anthropic `thinking` budget that, added to `maxOutputTokens`, passes
  `MAX_OUTPUT_TOKENS` (1024 when none is given) is refused (`output-cap`).
- **Scenario: proxy-output-cap** — on every route the output cap must be an integer from 1 to
  `MAX_OUTPUT_TOKENS`; absent, larger or not an integer is refused (`output-cap`).
- **Scenario: proxy-openai-store-required** — an OpenAI body without `store: false` (and an
  OpenAI model on the gateway without `providerOptions.openai.store: false`) is refused.
- **Scenario: proxy-accepts-real-provider-requests** — the requests the installed providers send
  through the runtime (each route and allowed model, a history with tool calls and results, and a
  turn's second request carrying the first step's thinking and signature, redacted thinking,
  encrypted reasoning, item ids and two tool calls, one with Anthropic's `caller: { type: 'direct' }`,
  sent back on both Anthropic paths) pass the header filter and the body check, and the body
  answered is byte for byte the one the provider wrote.

## Model proxy (`model-proxy.test.ts`)
- **Scenario: proxy-allowlist** — other hosts, schemes, ports, paths, queries, fragments and
  methods, a non-canonical URL, and another route's URL are refused (`fetch.error` `refused`)
  without a fetch; the route is the settings', not the runtime's.
- **Scenario: proxy-redirect-not-followed** — the fetch is made with `redirect: 'error'`,
  `credentials: 'omit'`; a redirect rejection answers `refused`.
- **Scenario: proxy-streams-response** — the head (filtered headers, status), chunks of at most
  `maxChunkBytes` and `fetch.end` reach the runtime.
- **Scenario: proxy-error-body-withheld** — for a status of 400 or more the runtime gets the
  status, status text and allowlisted headers, then `fetch.end` with no body (an error body may
  quote the key, masked, or account ids; the providers read retries from the status and headers).
- **Scenario: proxy-no-key** — without a key for the route: `refused`, no fetch, state `no-key`.
- **Scenario: proxy-caps** — a body past `maxResponseBytes` ends `too-large`; no bytes for
  `idleTimeoutMs` ends `timeout`; a request past `maxConcurrentRequests` is refused; a duplicate
  live id is refused and the first request stopped.
- **Scenario: proxy-abort** — `fetch.abort` aborts the fetch's signal and nothing more is sent for
  that id; the runtime going away aborts every request.
- **Scenario: proxy-sends-the-checked-body** — a body with `"store":true,"store":false` goes out as
  the checked object (`"store":false` once).
- **Scenario: proxy-abort-before-settings-load** — a `fetch.abort` that arrives while the request
  waits for the settings to load stops it: no fetch, no answer.
- **Scenario: proxy-stops-when-no-turn-runs** — when the last running chat finishes or fails, the
  requests still in flight are aborted.
- **Scenario: proxy-refusals-strike-and-coalesce** — each refusal is a strike on the host; ten of
  one reason log one line, and the next window's line counts the nine left out.
- **Scenario: proxy-strikes-only-the-runtimes-refusals** — no key, a redirect, another route's
  endpoint after a route switch and a model switch strike nothing; an unknown endpoint or a server
  tool does.
- **Scenario: proxy-refusal-logged-without-detail** — a refusal logs one line with its reason code
  and no URL query, header or body.

## Key isolation (`key-never-leaves-main.test.ts`)
- **Scenario: key-never-leaves-main** — the real runtime (in-process, on fake ports) runs a turn
  through the host and proxy to a scripted Anthropic stream: the reply streams back, and the key
  appears only in the header handed to the fake fetch: not in any message to or from the runtime,
  any answer of the agent's public API, any log line, console or stdout/stderr output, or the
  credentials file (searched for the key, its base64 and its last 8 characters), through a normal
  turn, a 401 whose body quotes the key, a network error and a redirect whose texts quote it, a
  refusal, and a re-encryption; and a stored key that fails to decrypt sends nothing.

## Entitlements (`entitlements.test.ts`)
- **Scenario: entitlements-default-allowed** — the default port allows `agent`, `agent.skills` and
  `agent.mcp`.
- **Scenario: entitlements-follow-the-account** — wired to Phase 4's account, every agent feature
  maps to the `ai-agent` flag (`AGENT_FEATURE_FLAGS`): allowed while the verified snapshot grants
  it, refused when `requireFeature` throws (free, signed out, an unverified or expired snapshot).
  A build without the account system (`unconfigured`: no API base or entitlement keys baked in, as
  in development, the e2e suite or a self-built copy) has no plan to check and nowhere to get one:
  there every agent feature is allowed. Shipped builds are configured, so the plan applies.
