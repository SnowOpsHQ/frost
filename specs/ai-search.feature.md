# Feature: `run_ai_search` via provider APIs (main)

Spec: `specs/ai-search.spec.ts` (`AI_SEARCH_ENGINES`, `AI_SEARCH_VIAS`, `AI_SEARCH_API_PROVIDER`,
`AI_SEARCH_ENGINE_LABELS`, `AI_SEARCH_MODELS`, `aiSearchRequestBody`, `AI_SEARCH_LIMITS`,
`AI_SEARCH_UNAVAILABLE_REASONS`, `AI_SEARCH_VIA_KEY(engine)`, `AI_SEARCH_DEFAULT_ENGINE_KEY`,
`aiSearchVia`, `resolveAiSearch`), `specs/ai-search.schema.ts` (provider response schemas,
`AiAnswerJobSchema`, `AiAnswerParsedSchema`, `AiAnswerSchema`), `specs/agent-search-tools.spec.ts`
(`completeToolInput(toolName, input, tabUrl, context?)`, `invokeTimeAnswer`),
`specs/agent-session.spec.ts` (`runAiSearchApprovalNote`), `packages/ai-skills` (`runAiSearchTool`'s
optional `engine`, `runAiSearchApprovedInputSchema`, `AiSearchQuery.engine` / `via`,
`AiSearchAnswer.engine` / `via` / `note`). Phase 12 Task 8 (`docs/plans/phase-12-big-bets.md`,
Decisions 3 (K-C1), 4 and 8; the lead's L5 gate in "As built"). Task 9 adds the AI answers view and
its storage to this file. Each line maps to one named test.

Code: `apps/desktop/src/main/ai-search/` (`api.ts` the fixed requests, `parse.ts` the worker-side
parse, `parser.ts` the worker client, `service.ts` the context and the approved call, `index.ts`
the wiring), `apps/desktop/src/main/agent/ports/ai-search-adapter.ts`, the broker
(`agent/approvals.ts`), the runner (`agent/tools/runner.ts`), the search tool
(`agent/tools/search-tools.ts`), the card's note (`agent/session.ts`), the SERP worker's `ai-answer`
job (`serp/serp-worker.ts`).

## Decisions
- **The model names an engine at most; the via is the user's.** `completeToolInput` drops any `via`
  in the model's input and fills `engine` (named, else the default engine setting when usable, else
  the first usable of `AI_SEARCH_ENGINES`) and `via` (that engine's setting now) before the broker
  parses, shows and hashes the call with `runAiSearchApprovedInputSchema`. The runner re-parses
  `run_ai_search` with the same schema and the search tool forwards `engine` and `via` to the port.
- **Usable** means: the engine has an API provider (`google-ai-mode` has none in this phase), the
  provider's legal gate is open (`AI_SEARCH_PROVIDER_AVAILABLE` through `legalGates.isOpen`), its key
  is set, and the engine's via setting is not `off`. As shipped both gates are closed, so every call
  is answered `not-available` (`LEGAL_GATE_NOTE`) as data when it arrives: no card, nothing read or
  sent. A gate open with no key (or switched off): `none-set-up`.
- **What is approved is what runs.** At run time the service resolves the approved engine's via
  again; a different one (switched off, key cleared, gate closed) answers `setting-changed`, which the
  tool answers `expired`, and nothing is sent.
- **Bounded.** `act`, never grantable, asks every call. At most `maxCallsPerTurn` (2) calls per turn
  and one per engine every `perEngineCooldownMs` (20 s) across turns, counted as a call is handed to
  the port (given back on `setting-changed`). Council review: main's service claims the engine's slot
  as a call arrives, before anything is awaited, and holds it until the call ends, so a second call to
  that engine while one is still running answers `cooldown` too, however long the first takes; the
  clock is given back whenever nothing was sent. The request body is fixed but for the query and the
  provider's first allowlisted model (`aiSearchRequestBody`). The tool takes no locale (no body sends
  one). The
  answer's text is parsed in a SERP worker of its own (`ai-answer` job): size and depth checked
  before `JSON.parse`, strict capped schemas, text made inert and cut to `maxAnswerChars`, citations
  `http(s)` only, deduplicated, at most `maxCitations`. Main never parses a provider's JSON.
- **Untrusted.** The answer reaches the model only inside the untrusted wrapper
  (`SEARCH_TOOL_SOURCES.run_ai_search`, `search:ai-answer`). A provider's own error text is never
  passed on (fixed messages only).
- **K-C1.** Perplexity (Sonar: `citations`, `search_results`) and OpenAI Responses (`url_citation`
  annotations) both return structured citations: neither provider is dropped.
- **Stop and deadline (Task 8 review).** The call's signal (Stop, or the tool's
  `AI_SEARCH_TOOL_TIMEOUT_MS`: a full turn queue + the client's `timeoutMs` + `parseTimeoutMs` + 5 s)
  reaches `dataApiRequest` (`signal`: checked after the turn and before counting, it ends a turn's
  wait and aborts the fetch: `aborted`). Once the provider's turn comes the setting is asked again
  (`beforeSend`: `cancelled` → `setting-changed` → `expired`), before any key is read. An aborted call
  tells no `onAnswer` listener.
- **Before the card (Task 8 review).** The model's input is checked with the model-facing schema
  first (an engine outside `AI_SEARCH_ENGINES`, a locale, an unknown key: `invalid-input`), and a call
  past `maxCallsPerTurn` pending, running or run calls of the turn is answered `capped` as data.
- **Credentials and totals (Task 8 review).** A citation URL with a user name or password is dropped
  (worker and tool). `answerTruncated` and `citationsTotal` come from the worker through the service to
  the tool.
- **Storage.** Nothing is stored in Task 8; the service's `onAnswer` hook hands each `AiAnswer` to
  Task 9's `ai_answers`.

## Resolving (`apps/desktop/src/main/ai-search/__tests__/ai-search.test.ts`)
- **Scenario: run-ai-search-default-engine** — no engine: the default setting, else the first
  usable; a named engine is kept; `completeToolInput` writes both into the input.
- **Scenario: ai-search-unavailable-explained** — engine off (`engine-off`), `google-ai-mode`
  (`no-api`), the named engine gated off (`not-available`), nothing usable (`none-set-up` /
  `not-available`), each in frost's words; the settings keys.

## Requests and answers (`ai-search.test.ts`)
- **Scenario: ai-api-request-body-built-by-main** — only the query and an allowlisted model vary;
  through Task 1's client the one allowlisted URL, Bearer key inside the closure, no key in the outcome.
- **Scenario: ai-api-parse-is-bounded** — too large, too deep, not JSON, odd types, past `maxItems`,
  empty: refused; unknown fields unread; the text inert and cut.
- **Scenario: ai-api-maps-citations** — Perplexity's source list and OpenAI's URL citations →
  `{ url, title }`, `http(s)` only, none with a user name or password, deduplicated, at most
  `maxCitations` (the total kept).
- **Scenario: ai-answer-parse-runs-in-a-worker-of-its-own** — `{ id, kind: 'ai-answer', job }` to the
  worker; a silent worker fails the job at the deadline and is terminated.
- **Scenario: ai-search-service-answers-the-approved-engine** — the provider of the approved engine,
  the note, one valid `AiAnswer` to `onAnswer`; with gates closed no key is looked up.
- **Scenario: run-ai-search-setting-changed-sends-nothing** — via switched off, key gone, or no
  approved engine and via: `setting-changed`, nothing sent.
- **Scenario: run-ai-search-timeout-covers-the-wait-the-request-and-the-parse** — `AI_SEARCH_TOOL_TIMEOUT_MS`.
- **Scenario: run-ai-search-stop-while-waiting-sends-nothing** — Stop while the call waits for the
  provider's turn: rejected, never sent, no listener told; an aborted signal is `aborted` at the client.
- **Scenario: run-ai-search-setting-changed-while-waiting-sends-nothing** — switched off during the
  wait: `setting-changed`, nothing read or sent.
- **Scenario: run-ai-search-aborted-in-flight-tells-no-listener** — aborted after the answer: no
  listener; aborted in flight: the fetch is aborted (`aborted`).
- **Scenario: run-ai-search-totals-come-from-the-source** — 35 citations: 20 kept, `citationsTotal` 35
  through the service and the tool; a cut answer says `answerTruncated` throughout.
- **Scenario: ai-search-service-withholds-provider-words** — a refusal or an unreadable answer is a
  fixed message; nothing reaches `onAnswer`.

## Approvals and run time (`apps/desktop/src/main/agent/__tests__/ai-search-agent.test.ts`)
- **Scenario: ai-search-gated-off-never-asks** — the shipped gates (`false`): `not-available` with
  `LEGAL_GATE_NOTE` as data, no card, no key read, nothing sent; an unwired broker the same.
- **Scenario: run-ai-search-none-set-up-never-asks** — a gate open, no key: `none-set-up` as data, no
  card; `google-ai-mode` named: `no-api`; a context that fails to load counts as none.
- **Scenario: run-ai-search-asks-every-call** — usable: each call asks; allow-always refused; no grant.
- **Scenario: run-ai-search-approval-shows-query-engine-and-via** — the card's input and hash hold the
  completed `engine` and `via`; the note is `runAiSearchApprovalNote` (engine label, own key, billed,
  sent as shown).
- **Scenario: run-ai-search-model-cannot-choose-via** — a `via` is refused by the model-facing schema;
  `completeToolInput` drops one and sets the setting's; the broker's card holds the setting's; an
  engine outside `AI_SEARCH_ENGINES`, a locale or an unknown key is `invalid-input` (gated off too).
- **Scenario: run-ai-search-approved-input-reaches-the-port** — broker → runner → search tool → port:
  the port receives the approved `engine` and `via`; never `invalid-input`.
- **Scenario: run-ai-search-runs-what-was-approved** — the via setting changed after approval:
  `expired`, nothing sent; unchanged, the approved engine answers, wrapped untrusted.
- **Scenario: run-ai-search-capped-per-turn-and-engine** — with two cards pending or run, a third call
  in the turn is answered `capped` before any card (a denied one frees its place); the search tool's
  own cap holds too; the same engine within 20 s across turns: `cooldown`; nothing sent for either.
- **Scenario: ai-search-one-call-in-flight-per-engine** (council review) — two overlapping calls to one
  engine (agent and agent, or agent and the AI answers view) send once; the other answers `cooldown`,
  also when the first is still running past 20 s; another engine is not held back; a call that sent
  nothing gives the clock back.
- **Scenario: ai-search-result-is-untrusted** — wrapped, source `search:ai-answer`; citations
  `http(s)` only and deduplicated on the way to the model too.

## Settings (`packages/db/src/__tests__/settings.test.ts`)
- **Scenario: ai-search-settings-read-from-app-settings** — unset reads `null`; stored values read
  back; a tampered value (`tab`, an unknown engine) reads as unset.

## End to end (`apps/desktop/e2e/ai-answers.e2e.ts`; plan Task 11)
Over the built app: the agent is the scripted model (`--frost-e2e-agent-script=<file>`), Perplexity and
OpenAI web search are `apps/desktop/e2e/fake-data-api.ts` (answers from
`apps/desktop/e2e/ai-answer-fixtures.ts`) through the data API seam, their gates opened with
`--frost-e2e-open-gates=perplexity,openai-search`, keys pasted in Settings › Data sources (on Linux
the stand-in keychain `apps/desktop/e2e/fake-keychain.cjs`; see `data-sources.feature.md`, End to end).
The gated-off case runs in `data-sources.e2e.ts` (data-sources-gated-off-in-the-real-app).
- **Scenario: ai-search-agent-call-approved-end-to-end** — the model calls `run_ai_search` with a query
  and no engine: the card's exact input is `{ query, engine: 'perplexity', via: 'api' }` (the default
  resolved), its note `runAiSearchApprovalNote('perplexity', 'api')`, no "Always allow", nothing sent
  yet; after "Allow once" one `POST /v1/sonar` carries `aiSearchRequestBody` for the query and the
  user's Bearer key; the tool card is done with the answer and its citations shown as text (no
  element made from the answer's markup). The untrusted wrapper the model reads (`search:ai-answer`)
  is unit-tested (ai-search-result-is-untrusted): the card previews the data only, and its untrusted
  chip is for MCP tools.
