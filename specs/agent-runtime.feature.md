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
  overwritten with `undefined` where it is writable, and reported where it is not). Its providers
  get a placeholder key and a proxied `fetch` that sends `fetch.request` to main and streams the
  `fetch.*` answers into a `Response`. The proxied fetch drops credential headers (`authorization`,
  `proxy-authorization`, `x-api-key`, `api-key`, `cookie`) and refuses, locally, a body over
  `maxRequestBodyBytes`, a method other than `GET` and `POST`, and a body it cannot send as is.
- **Main decides tools.** Each offered tool's `execute` posts `tool.invoke` and waits for the
  matching `tool.result`. A failed result reaches the model as the tool's output
  `{ error: code, message }`; Stop rejects a pending call. Only the chat's `allowedTools` that are
  in frost's catalogue are offered (MCP tools come with Task 10). Tool calls run one at a time.
- **One turn per chat id.** A second `chat.start` for a running chat id is dropped; `chat.stop`
  aborts that turn, which then finishes `aborted`. The turn's finish reason is the model's, or
  `step-limit` when it still asked for tools after `MAX_TOOL_STEPS` steps; usage is summed over the
  steps. A failure answers `chat.error` with a short message: no stack, no request or response
  detail.

## Transport (`apps/agent-runtime/src/__tests__/transport.test.ts`)
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
- **Scenario: proxy-fetch-refuses-locally** — a body over `maxRequestBodyBytes`, a `PUT` and a
  stream body are refused without posting anything.

## Providers (`provider.test.ts`)
- **Scenario: provider-endpoints-match-allowlist** — for each route, a model's streamed request
  goes to exactly the route's `MODEL_REQUESTS` URL with its method, passes `isAllowedModelRequest`,
  and carries no credential header.
- **Scenario: provider-refuses-other-models** — a model not allowed on the route is refused.

## Chat loop (`chat.test.ts`, scripted `MockLanguageModelV4`)
- **Scenario: chat-streams-text** — text deltas arrive as `chat.delta`, then `chat.finish` with
  `stop`, one step and the usage mapped.
- **Scenario: chat-delta-split** — a delta over `maxDeltaChars` is posted in pieces within it.
- **Scenario: chat-tool-call-round-trip** — a scripted tool call posts `chat.tool-call` and
  `tool.invoke` with the parsed input; the `tool.result` reaches the model's second call as the
  tool's output, and the second step's text streams.
- **Scenario: chat-denied-tool-continues** — a `denied` result reaches the model as
  `{ error: 'denied', message }` and the turn continues.
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
- **Scenario: runtime-ready** — starting the runtime posts `ready` with `AGENT_PROTOCOL_VERSION`.
- **Scenario: runtime-one-turn-per-chat** — a second `chat.start` for a running chat id is dropped.
- **Scenario: runtime-model-factory** — the injected model factory gets the route, the model id and
  the proxied fetch; a factory that throws answers `chat.error`.

## No network (`no-network.test.ts`)
- **Scenario: runtime-has-no-network** — no non-test source of `apps/agent-runtime/src` imports
  `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram`, `node:dns`,
  `node:child_process`, `node:worker_threads`, `node:cluster`, `node:fs`, `node:vm`, `electron`,
  `ws`, `undici` or any other module outside an allowlist (`ai`, the three providers, `zod`,
  `@app/specs`, `@app/ai-skills` and its own files).
