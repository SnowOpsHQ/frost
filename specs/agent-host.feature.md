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
  server-side, and main's own credential header. The URL sent is the allowlist's string.
- **The key stays in main's proxy.** Keys are stored per slot (`anthropic`, `openai`, `gateway`),
  encrypted with `safeStorage`, in one 0600 file written atomically. Only `withKey` sees a key, for
  the duration of one call, and only the proxy is given it; the settings page gets a view with no
  `withKey`. Keys never appear in a message to the runtime, a log line, an error or an answer.
  It uses `safeStorage`'s asynchronous API (Electron 45 deprecates the synchronous one, whose
  `isEncryptionAvailable()` answers `false` on Linux where the asynchronous encryptor works). With
  no encryption the store refuses (`unavailable`); on Linux the encryptor's output says which key it
  used: `v11` (the desktop's secret service) is `os`, `v10` (Chromium's fixed key: no secret
  service, or `--password-store=basic`) is `weak`: stored, and said so. `getSelectedStorageBackend`
  is not used: on Electron 45 it reports `basic_text` while the asynchronous encryptor still finds
  a secret service.
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
  base64) and was written to a temporary 0600 file, then renamed over the old one.
- **Scenario: credentials-only-withkey-returns-key** — `hasKey`, `setKey`, `clearKey` and
  `protection` never answer the key; `withKey` runs its closure with it; the settings view has no
  `withKey`.
- **Scenario: credentials-key-validated** — a key is trimmed; one too short, too long, or with a
  space or non-ASCII character is refused (`invalid`) and nothing is written.
- **Scenario: credentials-protection** — `unavailable` (no encryption: `setKey` refuses, nothing
  written), `weak` (Linux, `v10` data), `os` otherwise; encryption that goes away is reported again.
- **Scenario: credentials-re-encrypted-when-asked** — when decryption answers `shouldReEncrypt`, the
  key is stored again under the encryptor's current key before the closure runs.
- **Scenario: credentials-clear** — `clearKey` removes one slot and leaves the others.
- **Scenario: credentials-tampered-file** — an unreadable or tampered file stores nothing, never
  throws, and a blob that fails to decrypt makes `withKey` answer `failed` (no key).

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
- **Scenario: proxy-openai-store-required** — an OpenAI body without `store: false` (and an
  OpenAI model on the gateway without `providerOptions.openai.store: false`) is refused.
- **Scenario: proxy-accepts-real-provider-requests** — the requests the installed providers send
  through the runtime (each route and allowed model, a history with tool calls and results) pass
  the header filter and the body check unchanged in meaning.

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
- **Scenario: proxy-refusal-logged-without-detail** — a refusal logs one line with its reason code
  and no URL query, header or body.

## Key isolation (`key-never-leaves-main.test.ts`)
- **Scenario: key-never-leaves-main** — the real runtime (in-process, on fake ports) runs a turn
  through the host and proxy to a scripted Anthropic stream: the reply streams back, and the key
  appears only in the header handed to the fake fetch: not in any message to or from the runtime,
  any answer of the agent's public API, any log line or console output, or the credentials file.

## Entitlements (`entitlements.test.ts`)
- **Scenario: entitlements-default-allowed** — the default port allows `agent`, `agent.skills` and
  `agent.mcp`.
