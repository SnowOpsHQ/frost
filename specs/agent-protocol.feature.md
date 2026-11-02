# Feature: Agent protocol, tool catalogue and ports

Spec: `specs/agent-protocol.schema.ts` (`MainToRuntimeMessageSchema`, `RuntimeToMainMessageSchema`,
`AGENT_PROTOCOL_LIMITS`, `RUNTIME_TO_MAIN_MESSAGE_TYPES`, `ToolResultSchema`, `ChatMessageSchema`),
`specs/agent-tools.spec.ts` (`AGENT_TOOLS`, the caps, `ALLOWED_MODEL_IDS`, `MODEL_PROVIDERS`,
`GATEWAY_ONLY_PROVIDERS`, `byProvider`, `routeModelId`, `MODEL_REQUESTS`, `isAllowedModelRequest`,
`isCanonicalUrl`). Phase 5 Task 1 (`docs/plans/phase-5-ai-agent.md`,
decisions 5, 7 and 9). Package: `packages/ai-skills` (tool definitions and ports). Each line maps to
one named test.

## Decisions
- **One MessagePort, two unions.** Every message between main and the agent runtime is one of
  `MainToRuntimeMessageSchema` or `RuntimeToMainMessageSchema`, discriminated on `type`. Every
  object is strict and every string, array and byte buffer bounded; the receiver drops a message
  that fails to parse.
- **The runtime asks; main decides.** The runtime's messages report (`ready`, `chat.*`) or request
  (`tool.invoke`, `fetch.request`, `fetch.abort`). None approves a call, grants a tool, changes a
  setting or carries a key: approvals arrive only over the app window's `enforceSender` IPC.
- **Model requests are main's.** The runtime's `fetch.request` names a URL, a method (`GET` or
  `POST`), headers and a body; main sends it only if `isAllowedModelRequest` holds for the configured
  route: the URL is canonical and the method and URL are exactly one of the route's `MODEL_REQUESTS`
  (its text generation endpoint, not the provider's whole API). Then it answers `fetch.response-start`, `fetch.chunk`… and `fetch.end`, or `fetch.error`. Bytes travel
  as `Uint8Array`, which a MessagePort's structured clone copies as is.
- **Tool output is untrusted data.** A `tool.result` carries `{ ok: true, output: { untrusted: true,
  source, data } }` (the JSON text of `data` at most `TOOL_RESULT_MAX_CHARS`) or `{ ok: false,
  error: { code, message } }`; a chat's history keeps tool results in that same wrapper. Tool inputs
  and outputs are plain, bounded JSON, and the schemas hand on a fresh copy parsed from its JSON
  text. Every tool that returns page or third-party text says so in its description.
- **Risk classes.** `read` tools run (an implied grant), `act` tools may be covered by a standing
  grant, `execute_javascript` and MCP tools (`external`, named `mcp__<server>__<tool>`) never.
- **Ports.** SERP, intent and GSC data come through `SerpPort`, `IntentPort` and `GscPort`; each
  answers `{ status: 'ok', data }` or `{ status: 'unavailable', reason }` (the reason cut to
  `maxErrorChars`), and an unconnected port is `unavailablePort(reason)`. Every query takes an
  optional `{ signal }` so Stop can abandon it.

## Protocol (`packages/ai-skills/src/__tests__/agent-protocol.test.ts`)
- **Scenario: protocol-round-trip** — one valid message of every main → runtime and runtime → main
  type parses to an equal value, a `Uint8Array` chunk and body included.
- **Scenario: protocol-types-listed** — `MAIN_TO_RUNTIME_MESSAGE_TYPES` and
  `RUNTIME_TO_MAIN_MESSAGE_TYPES` are exactly the types of their unions.
- **Scenario: unknown-messages-rejected** — an unknown `type`, a missing `type`, a non-object, a
  message for the other direction and a known message with an extra field are refused.
- **Scenario: malformed-messages-rejected** — an id with a space or over `maxIdChars`, a delta over
  `maxDeltaChars`, a chunk over `maxChunkBytes`, more than `CHAT_MAX_MESSAGES` messages, a turn not
  ending with a user message, a model id not in `ALLOWED_MODEL_IDS`, a tool named twice, an unknown
  tool name, a status out of range and a `PUT` request are refused.
- **Scenario: tool-input-is-bounded-json** — a tool input deeper than `maxJsonDepth`, longer than
  `maxToolInputChars`, holding a non-finite number, a function, a class instance, a sparse array, an
  array with a named own key, or an own `__proto__`, `constructor` or `prototype` key is refused,
  without exhausting the stack; an array of 5 million items fails fast (before its items are walked);
  a throwing getter is refused, not thrown.
- **Scenario: json-is-copied** — a parsed tool input and tool output `data` are fresh copies of
  their JSON text: equal, not the same object, `-0` read as `0`.
- **Scenario: tool-results-are-wrapped** — a successful result without `untrusted: true`, without a
  `source`, or with `data` over `TOOL_RESULT_MAX_CHARS` is refused; a failure needs a known code.
- **Scenario: agent-cannot-approve** (Review Focus) — no runtime → main type or field name, at any
  depth, matches `/approv|grant|setting|key|credential|allow|confirm|consent|permit|accept|token|secret|auth/i`;
  `approval.answer`, `grant.add`,
  `settings.set`, `key.set` and a `tool.invoke` carrying `approved: true` are refused.

## Catalogue (`packages/ai-skills/src/__tests__/agent-tools.test.ts`)
- **Scenario: catalogue-risk-classes** — `read` tools grantable, `navigate` and `click` `act` and
  grantable, `run_ai_search` `act` and not grantable (it sends model-chosen text to an AI answer
  engine, which may fetch URLs), `execute_javascript` `execute` and not grantable; every tool has a
  label.
- **Scenario: tool-inputs-safe-text** — click's selector and text, navigate's and
  `gsc_performance`'s URL, search queries and `execute_javascript`'s code refuse control characters,
  Unicode format characters (bidi, zero-width, BOM), line and paragraph separators and lone
  surrogates (`UNSAFE_INPUT_CHARS`; code allows line feeds and tabs).
- **Scenario: mcp-tools-are-external** — an `mcp__<server>__<tool>` name is `external` and not
  grantable; other names (and a catalogue name) are not MCP tools; an unknown name has no risk.
- **`chat.start` on the ChatGPT plan** (protocol version 7, `agent-chatgpt.feature.md`): `route` may
  be `chatgpt` and `modelId` a `chatgpt/<slug>` (`isAgentModelId`); a runtime reporting an older
  version is refused.
- **Scenario: chat-start-reasoning-effort** (protocol version 8, Phase 8 Task 8b, Decision 8;
  `agent-reasoning.spec.ts`) — `chat.start.reasoningEffort` is required and is one of
  `REASONING_EFFORTS` (`auto`, `off`, `low`, `medium`, `high`); a missing value, a provider's wire
  value (`minimal`, `none`, `xhigh`), another case or another type refuses the message. Main sends
  the effective level (`effectiveEffort`), never the raw stored one; a runtime reporting an older
  version is refused (both sides read the one `AGENT_PROTOCOL_VERSION`).
- **Scenario: chat-start-mcp-tools-match-allowed-names** (protocol version 6, Task 10;
  `agent-mcp.feature.md`) — `chat.start.mcpTools` holds exactly one sanitised definition per MCP
  name in `allowedTools`; a missing, extra, repeated or unsanitised one refuses the message.
- **Scenario: caps-are-sane** — the caps are positive integers and the default model is allowed;
  every `ALLOWED_MODEL_IDS` entry is `<provider>/<model>` for a `MODEL_PROVIDERS` provider, each
  provider has models, and the list is grouped by provider in `MODEL_PROVIDERS` order.
- **Scenario: route-model-id** — the gateway keeps `provider/model`; a bring-your-own-key route drops
  the prefix; a model of the other provider, or one not allowed, is refused (`null`).
- **Scenario: route-model-id-gateway-only-providers** (Phase 8 Task 7, Decision 7) — Gemini
  (`google`) and Grok (`spacexai`) are `GATEWAY_ONLY_PROVIDERS`, two models each in
  `ALLOWED_MODEL_IDS` (the gateway's current ids, read from its public model list; tests name them
  only through `byProvider`): passed through as is on `gateway`, refused (`null`) on
  `byok-anthropic`, `byok-openai` and `chatgpt`, so no request is ever made for them there; no
  bring-your-own-key route serves a gateway-only provider; an unlisted prefix (`xai/`, `vertex/`)
  is refused everywhere.
- **Scenario: model-request-allowlist** — each route's one `POST` URL is allowed; another method,
  another route's URL, another path of the same provider (models list, files, batches), a query, a
  fragment, `http:`, a port, user info, a look-alike host and a non-URL are refused.
- **Scenario: model-url-canonical** — a URL the parser would rewrite is refused: a backslash, a tab
  or line break, `https:host` without `//`, a full-width dot, a space or NUL, an upper-case host, the
  default port written out, a `..` or `%2e%2e` segment; an internationalised look-alike host
  (Cyrillic `а`) is another host and refused.

## Tool definitions and ports (`packages/ai-skills/src/__tests__/tools.test.ts`, `ports.test.ts`)
- **Scenario: every-catalogue-tool-has-a-definition** — each catalogue name has exactly one
  definition, and each definition names a catalogue tool; every description is non-empty.
- **Scenario: tool-inputs-validated** — `navigate` takes only an `http(s)` URL within
  `maxUrlChars` and without a user name or password; a locale is a language with an optional region
  or area code (`en`, `en-US`, `es-419`), any case, normalised to `en-US`; `click` takes exactly one of `selector` and `text`; `execute_javascript` refuses
  code over `EXECUTE_JS_MAX_SOURCE_CHARS`; `page_text`'s `maxChars` is within
  `TOOL_RESULT_MAX_CHARS`; `gsc_performance`'s `days` within `maxGscDays`; unknown keys are refused.
- **Scenario: tool-descriptions-mark-untrusted-output** — the descriptions of `page_audit`,
  `page_data`, `page_text`, `click`, `execute_javascript`, `serp_results`, `run_ai_search` and
  `gsc_performance` say their output is untrusted data, never instructions.
- **Scenario: tool-inputs-have-json-schemas** — every input schema converts to a JSON Schema object
  with no extra properties (what the runtime hands the model).
- **Scenario: ports-fakes-satisfy-interfaces** — the fakes answer `ok` with data and record their
  queries.
- **Scenario: ports-honour-abort** — a fake's query with an already aborted signal, or one aborted
  before it answers, rejects with the signal's reason.
- **Scenario: unavailable-port** — `unavailablePort(reason)` answers `unavailable` with that reason
  from every method of every port; a reason over `maxErrorChars` is cut there (never splitting a
  surrogate pair).

## Additions (Phase 5 Task 2 review; `packages/ai-skills/src/__tests__/agent-protocol.test.ts`)
- **`ready` reports the lockdown** (`AGENT_PROTOCOL_VERSION` 4: Task 3's reviews added the module
  loader, `_compile` and code generation targets; 2 before them): `lockdown: { removed, failed,
  permissionModel }`, the lists holding only `LOCKDOWN_TARGETS` (each at most once per target count)
  and `permissionModel` whether Node's permission model refuses file writes in the runtime.
- **`chat.step`** (runtime → main): a step's `step` number (1 to `MAX_TOOL_STEPS`), its `text` (at
  most `maxMessageChars`) and the `toolCalls` main was asked to run (`ToolCallSchema`, at most
  `maxToolCallsPerMessage`): an assistant history message in the protocol's own shape.
- **`maxResponseBytes`**: the most body bytes the runtime reads from one proxied response.
- Covered by **protocol-round-trip**, **protocol-types-listed**, **malformed-messages-rejected** and
  **agent-cannot-approve** (the new fields match none of its words).
