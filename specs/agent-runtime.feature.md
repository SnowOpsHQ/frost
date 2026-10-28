# Feature: Agent runtime (utility process) and chat loop

Spec: `specs/agent-protocol.schema.ts` (`MainToRuntimeMessageSchema`, `RuntimeToMainMessageSchema`,
`AGENT_PROTOCOL_LIMITS`, `AGENT_PROTOCOL_VERSION`, `CHAT_FINISH_REASONS`), `specs/agent-tools.spec.ts`
(`MAX_TOOL_STEPS`, `routeModelId`, `MODEL_REQUESTS`, `isAllowedModelRequest`). Phase 5 Task 2
(`docs/plans/phase-5-ai-agent.md`, decisions 5–7). Package: `apps/agent-runtime`
(`@app/agent-runtime`). Each line maps to one named test.

## Decisions
- **One port, validated both ways.** The runtime receives one `MessagePort` from main (the first
  `process.parentPort` message that carries one). Every inbound message is parsed with
  `MainToRuntimeMessageSchema`; one that fails is dropped and counted, never echoed or logged.
  Every outbound message is parsed with `RuntimeToMainMessageSchema` before it is posted, in every
  build: the cost is small next to a model's latency, and main never sees a malformed message from
  a runtime bug. An outbound message that fails is dropped and counted, and its sender learns so.
- **No network, no credential.** At startup the runtime deletes `fetch`, `WebSocket`,
  `EventSource`, `XMLHttpRequest` and `WebSocketStream` from its globals (a non-configurable one is
  overwritten with `undefined` where it is writable, and reported where it is not). Once its
  modules have loaded, and before it binds its port, it also removes `process.getBuiltinModule`,
  `process.binding`, `process._linkedBinding` and `process.dlopen`: a dependency could otherwise
  load a builtin (`node:dns`, `node:module` → `createRequire`) around the bundle's imports. It
  then stops module loading (`Module._load`, `Module.prototype.require` and
  `Module.prototype._compile` replaced with functions that throw, `process.mainModule` removed) and code generation from strings (`eval`, `Function`
  and the async, generator and async generator function constructors replaced with functions that
  throw `EvalError`; Electron 45 ignores `--disallow-code-generation-from-strings` in a utility
  process, verified). It
  reports all of it in `ready.lockdown` (`LOCKDOWN_TARGETS`), with whether Node's permission model
  is in effect. The chat loop also replaces the AI SDK's URL download with one that refuses.
  Its providers
  get a placeholder key and a proxied `fetch` that sends `fetch.request` to main and streams the
  `fetch.*` answers into a `Response`. The proxied fetch drops credential headers (`authorization`,
  `proxy-authorization`, `x-api-key`, `api-key`, `cookie`) and refuses, locally, a body over
  `maxRequestBodyBytes`, a method other than `GET` and `POST`, and a body it cannot send as is. It
  stops reading a response at `maxResponseBytes` (`too-large`, and `fetch.abort` to main), drops a
  status text a `Response` cannot carry, and fails a head it cannot build as `network`, so every
  request settles. A failed proxied request is never retried by the AI SDK (main decides about
  retries); an HTTP error the provider reports retryable (429, 5xx) is retried once.
- **OpenAI keeps nothing.** Every turn passes `providerOptions.openai.store = false` (the
  bring-your-own-key route and OpenAI models on the gateway).
- **Main decides tools.** Each offered tool's `execute` posts `tool.invoke` and waits for the
  matching `tool.result`. A failed result reaches the model as an error output (`error-json`)
  `{ error: code, message }`; Stop rejects a pending call. Only the chat's `allowedTools` that are
  in frost's catalogue are offered (MCP tools come with Task 10). Tool calls run one at a time.
- **History pairs up.** Converting the protocol's history, each assistant tool call without a
  result right after it gets an `error-json` result `{ error: 'aborted', message }` (Stop during an
  approval), and a tool result with no matching call just before it is dropped: providers refuse
  both. Each step's output is posted as `chat.step` (text and the calls main was asked to run);
  a call the SDK rejected is left out with its error, so main's history pairs up.
- **One turn per chat id.** A second `chat.start` for a running chat id answers `chat.error`
  (busy) and changes nothing; `chat.stop`
  aborts that turn, which then finishes `aborted`. The turn's finish reason is the model's, or
  `step-limit` when it still asked for tools after `MAX_TOOL_STEPS` steps; usage is summed over the
  steps. A failure answers `chat.error` with a short message: no stack, no request or response
  detail.

## Transport (`apps/agent-runtime/src/__tests__/transport.test.ts`)
- **Scenario: listener-errors-contained** — a listener that throws neither stops the others nor
  escapes the port's message handler.
- **Scenario: invalid-inbound-dropped** — a non-object, an unknown type, a runtime → main type and a
  known message with an extra field are dropped and counted; nothing is posted back and nothing
  throws.
- **Scenario: outbound-validated** — an outbound message that fails `RuntimeToMainMessageSchema` is
  not posted, is counted, and its send answers `false`.
- **Scenario: parent-port-binding** — the first `parentPort` message carrying a port is bound: its
  messages reach the runtime, posts go out on it, and it is started.

## Lockdown (`lockdown.test.ts`)
- **Scenario: lockdown-removes-network-globals** — `fetch`, `WebSocket`, `EventSource`,
  `XMLHttpRequest` (and `WebSocketStream`) are gone from the target; a non-configurable writable one
  is overwritten; a non-configurable read-only one is reported as not removed.
- **Scenario: lockdown-real-globals** — on the real `globalThis`, `fetch` and `WebSocket` are gone
  after lockdown (restored after the test).
- **Scenario: lockdown-process-builtins** — `getBuiltinModule`, `binding`, `_linkedBinding` and
  `dlopen` are gone from the target process object; a dependency's optional `getBuiltinModule?.()`
  finds nothing.
- **Scenario: lockdown-module-loader** — `Module._load`, `Module.prototype.require` and
  `Module.prototype._compile` (found through `process.mainModule`) throw, and `process.mainModule` is gone; without a main module nothing is
  reported.
- **Scenario: lockdown-code-generation** — in a separate realm, `eval`, `Function`, `new Function`
  and every function prototype's `constructor` throw; `instanceof Function` and
  `(function () {}).constructor === Function` still hold; a `Function` probe answers "no eval".
- **Scenario: jitless-zod** — the package entry's first import puts Zod in `jitless` mode
  (`globalThis.__zod_globalConfig`, the object Zod keeps) before any schema is built: Zod decides
  per schema, at build time, whether to compile a parser with `new Function`, which the lockdown
  then refuses (the real utility process failed every parse until this was in place).
- **Scenario: lockdown-report** — the report lists what was removed and what failed, and
  `permissionModel` is true only when a permission model refuses file writes.

## Proxied fetch (`proxy-fetch.test.ts`)
- **Scenario: proxy-fetch-streams-body** — a `fetch` posts `fetch.request` (URL, method, header
  pairs, body); `fetch.response-start`, chunks and `fetch.end` read back as a `Response` with that
  status, headers and body.
- **Scenario: proxy-fetch-strips-credentials** — `authorization`, `x-api-key` and the other
  credential headers are not in the posted request.
- **Scenario: proxy-fetch-abort** — aborting the signal posts `fetch.abort`, rejects a pending
  head and errors a body being read.
- **Scenario: proxy-fetch-error** — `fetch.error` before the head rejects the `fetch`; after it,
  errors the body.
- **Scenario: proxy-fetch-bad-head** — a status text with a line break or a character above
  U+00FF is dropped; a head a `Response` cannot be built from fails the `fetch` as `network`.
- **Scenario: proxy-fetch-response-cap** — a body past `maxResponseBytes` errors `too-large` and
  posts `fetch.abort`; the abort listener is detached once a request ends or fails.
- **Scenario: proxy-fetch-abort-before-post** — a signal aborted while the body is being read
  posts nothing.
- **Scenario: proxy-fetch-refuses-locally** — a body over `maxRequestBodyBytes`, a `PUT` and a
  stream body are refused without posting anything.

## Providers (`provider.test.ts`)
- **Scenario: provider-endpoints-match-allowlist** — for each route, a model's streamed request
  goes to exactly the route's `MODEL_REQUESTS` URL with its method, passes `isAllowedModelRequest`,
  and carries no credential header.
- **Scenario: provider-refuses-other-models** — a model not allowed on the route is refused.
- **Scenario: provider-proxy-errors-not-retried** — a refused proxied request (on every route,
  the gateway included) is sent once.
- **Scenario: provider-output-capped** — every route's request asks for at most `MAX_OUTPUT_TOKENS`
  (`max_tokens`, `max_output_tokens`, `maxOutputTokens`): the turn passes `maxOutputTokens`, since
  a provider's default can be its model's maximum and main's proxy refuses an uncapped request.
- **Scenario: provider-openai-store-off** — the OpenAI request (bring-your-own-key, and an OpenAI
  model on the gateway) carries `store: false`.

## Chat loop (`chat.test.ts`, scripted `MockLanguageModelV4`)
- **Scenario: chat-streams-text** — text deltas arrive as `chat.delta`, then `chat.finish` with
  `stop`, one step and the usage mapped.
- **Scenario: chat-delta-split** — a delta over `maxDeltaChars` is posted in pieces within it.
- **Scenario: chat-tool-call-round-trip** — a scripted tool call posts `chat.tool-call` and
  `tool.invoke` with the parsed input; the `tool.result` reaches the model's second call as the
  tool's output, and the second step's text streams.
- **Scenario: chat-denied-tool-continues** — a `denied` result reaches the model as an
  `error-json` output `{ error: 'denied', message }` and the turn continues.
- **Scenario: chat-unanswered-call-synthesized** — an assistant tool call with no result in the
  history reaches the model with an `error-json` `{ error: 'aborted' }` result.
- **Scenario: chat-orphan-result-dropped** — a tool result with no matching call before it is not
  sent to the model.
- **Scenario: chat-step-posted** — each step posts `chat.step` with its text and the calls main
  was asked to run; a call to a tool not offered is left out; a step cut by Stop is still posted.
- **Scenario: chat-no-download** — the AI SDK's URL download is replaced by one that refuses.
- **Scenario: chat-stop-aborts** — `chat.stop` while a tool call waits rejects it and finishes the
  turn `aborted`.
- **Scenario: chat-step-limit** — a model that keeps calling tools stops after `MAX_TOOL_STEPS`
  steps and finishes `step-limit`.
- **Scenario: chat-offers-allowed-tools-only** — a catalogue tool not in `allowedTools` is not
  offered to the model.
- **Scenario: chat-history-converted** — the protocol's history (user, assistant with tool calls,
  tool results) reaches the model as messages, with the system prompt.
- **Scenario: chat-error-bounded** — a provider failure answers `chat.error` with a short message
  holding no request or response detail.

## Runtime (`runtime.test.ts`)
- **Scenario: runtime-ready** — starting the runtime posts `ready` with `AGENT_PROTOCOL_VERSION`
  and the lockdown report it was given.
- **Scenario: runtime-one-turn-per-chat** — a second `chat.start` for a running chat id answers
  `chat.error` (busy) and the running turn goes on.
- **Scenario: runtime-model-factory** — the injected model factory gets the route, the model id and
  the proxied fetch; a factory that throws answers `chat.error`.

## No network (`no-network.test.ts`)
- **Scenario: runtime-has-no-network** — no non-test source of `apps/agent-runtime/src` imports
  `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram`, `node:dns`,
  `node:child_process`, `node:worker_threads`, `node:cluster`, `node:fs`, `node:vm`, `electron`,
  `ws`, `undici` or any other module outside an allowlist (`ai`, the three providers, `zod`,
  `@app/specs`, `@app/ai-skills` and its own files), and no source names `getBuiltinModule`,
  `createRequire`, `process.binding`, `_linkedBinding` or `dlopen` except `lockdown.ts`, which
  removes them. The test reads the runtime's own sources only: third-party code in the bundle is
  not scanned by a test (the lockdown covers what it can reach).
