# Feature: AI answers view and storage

Spec: `specs/ai-answers.spec.ts` (`AI_ANSWERS_TABLES`, `AI_ANSWERS_MIGRATION_IDS`, `AI_ANSWER_ORIGINS`,
`AI_ANSWERS_LIMITS`, `AI_ANSWER_RETENTIONS`, `DEFAULT_AI_ANSWER_RETENTION`, `AI_ANSWER_RETENTION_KEY`,
`aiAnswerRetentionCutoff`, `AI_ANSWERS_RUN_REFUSALS`, `aiAnswersRunRefusalOf`, `AI_SEARCH_SETTING_RESULTS`,
`AI_ANSWERS_VIEW_TEXT`), `specs/ai-answers.schema.ts` (`AiAnswerRecordSchema`, `AiAnswerSummarySchema`,
`AiAnswersViewSchema`, the inputs and answers), Task 8's `specs/ai-search.spec.ts` (engines, vias, the
settings keys, `resolveAiSearch`) and `ai-search.schema.ts` (`AiAnswerSchema`, `AiCitationSchema`).
Phase 12 Task 9 (`docs/plans/phase-12-big-bets.md`, Decision 9; the lead's L5 gate in "As built").
Each line maps to one named test.

Code: `packages/db/src/ai-answers{,-schema,-migrations}.ts` (`0242_ai_answers`),
`apps/desktop/src/main/ai-answers/` (`service.ts` storage wiring, the view and its run; `index.ts`
the composition), Task 8's `main/ai-search/service.ts` (`answer`: the view's run, told to no listener),
`packages/ipc-contract/src/ai-answers-{router,service}.ts`, the renderer's
`components/ai-answers/{AiAnswers,AiAnswer}.tsx`, `ai-answers-view.ts`, `ai-answers-palette.ts` and
`ai-answers.css`.

## Decisions
- **What is kept.** Every answer that reaches main (the agent's approved `run_ai_search`, through Task
  8's `onAnswer`; the view's own run) is stored once in `ai_answers`: the query, engine, via, provider,
  the answer text (≤ `maxAnswerChars`), the citations (JSON, ≤ 20), the cited registrable domains, the
  chat id (nullable: `null` in this build, as the tool's port carries none), where it came from
  (`origin`: `agent` | `view`) and when. `CHECK`s hold the engine, via, provider and origin lists and
  every size. A row that is not a well-formed answer reads as none.
- **Retention** (`AI_ANSWER_RETENTION_KEY` in `app_settings`): `off | 7d | 30d | forever`, default
  `30d`. `off`: nothing is stored (choosing it deletes what was kept). Main purges on every write, at
  start-up, daily while frost runs (`AI_ANSWER_PURGE_INTERVAL_MS`, an unref'd interval cleared on
  `will-quit`, as the chats' prune) and when the setting changes; at most `maxStored` rows whatever the setting. Device-local:
  `ai_answers` is not in `SYNC_TABLES`. An answer inside a chat follows the chat's retention; the view
  says so.
- **The view's run is a user action:** no approval card. It goes through Task 8's service
  (`AiSearchService.answer`): the same `resolveAiSearch`, legal gate, fixed body, client caps and
  worker parse. While the engine's provider gate is closed (as shipped) main answers `unavailable`
  with `LEGAL_GATE_NOTE` and sends nothing. One view run at a time (`busy`). The renderer shows the
  cost note (`DATA_SPEND_NOTE`) and asks before it calls.
- **One per-engine clock (lead ruling).** One call per engine every `perEngineCooldownMs`, for the
  agent's calls and the view's runs together, kept by Task 8's service (`send`): set just before the
  request is handed to the client, given back when the client sent nothing (gate, queue, key,
  allowlist, or the setting changed while it waited). The agent's per-turn cap stays in the broker and
  the search tool, which no longer keeps a per-engine clock of its own.
- **Settings.** The view writes Task 8's settings: each engine's via (`api` | `off`) and the default
  engine. `off` is never gated; `api` or a default engine whose provider is gated off answers
  `unavailable`; `google-ai-mode` has no API (`no-api`).
- **Shown inert.** The answer and every citation are React text: no `innerHTML`, no markdown. Links
  are not clickable: "Open in tab" sends an `http(s)` URL through the address bar's path
  (`browser.navigate`); a URL with a username or password is never openable and is shown without them
  (defence in depth: Task 8's parse drops them). A retention that deletes now (shorter, or `off`)
  asks first, as Delete all does. A run's answer that was not stored says why ("Shown, not kept" only
  when the retention is `off`). Cited domains are grouped by `registrableDomain`; the watched domain (by
  default the active tab's) is highlighted. Engines are text labels only; `chatgpt` reads "OpenAI web
  search — may differ from the ChatGPT app". Gated engines are disabled with `LEGAL_GATE_NOTE`.
- **Phase 9 independence.** Nothing under Phase 9's AI-readiness score imports `ai-answers*` or
  `main/ai-search/**`.

## Storage (`packages/db/src/__tests__/ai-answers.test.ts`)
- **Scenario: ai-answers-migration-creates-table** — `0242` after the site crawl's list and before
  `0243`; the columns, `CHECK`s and index; refused rows.
- **Scenario: ai-answers-retention-purges** — the default `30d`; `7d`, `30d` and `forever` cutoffs on
  write and on purge; `off` stores nothing and deletes what was kept; at most `maxStored`.
- **Scenario: ai-answers-rows-checked** — an invalid answer is refused; a tampered row reads as none
  and is skipped in a list; paging newest first.
- **Scenario: ai-answers-not-synced** — `ai_answers` is not in `SYNC_TABLES`.
- **Scenario: ai-search-settings-written** — each engine's via and the default engine, read back by
  `aiSearchSettings`; anything else writes nothing; `null` clears the default.

## Main (`apps/desktop/src/main/ai-answers/__tests__/ai-answers.test.ts`)
- **Scenario: ai-answers-stored-from-agent-and-view** — an approved agent call (through `onAnswer`) and
  a view run both appear, with their sources and domains; Delete all empties the table.
- **Scenario: ai-answers-view-runs-without-approval-card** — the view's run sends through the service
  at once (no broker, no card), with the resolved engine and via; `onAnswer` is not told (stored once).
- **Scenario: ai-answers-gated-off-run-refuses** — the shipped gates (`false`): `unavailable` with
  `LEGAL_GATE_NOTE`, nothing sent, no key read, nothing stored; the view says no engine is available.
- **Scenario: ai-answers-run-bounded** — a second run while one is in flight: `busy`; the same engine
  within 20 s: `cooldown`; nothing sent for either; a refused answer stores nothing; one clock for the
  agent's call and the view's run; given back when the client sent nothing (`cancelled`).
- **Scenario: ai-answers-retention-at-start-up** — start-up purges; retention `off` keeps nothing.
- **Scenario: ai-answers-purged-daily** — fake timers: the daily purge deletes what aged out with no
  write; `dispose` clears the interval; a second `start` adds none.
- **Scenario: ai-search-settings-setters** — via and default engine written; gated `api` and default:
  `unavailable`; `off` never gated; `google-ai-mode`: `no-api`.

## Router (`packages/ipc-contract/src/__tests__/ai-answers-router.test.ts`)
- **Scenario: ai-answers-router-enforces-sender** — every `aiAnswers.*` procedure refuses another
  sender and fails closed without the service.
- **Scenario: ai-answers-router-inputs-bounded** — bad inputs are refused before the service.
- **Scenario: ai-answers-router-answers-are-checked** — strict answers: an extra field fails.

## Renderer (`apps/desktop/src/renderer/__tests__/ai-answers-view.test.ts`)
- **Scenario: ai-answers-text-inert** — the answer's markup and markdown are shown as text.
- **Scenario: ai-answers-links-open-in-tab-only** — no anchor; "Open in tab" only for `http(s)` without a
  username or password (shown without them), through the address bar's path.
- **Scenario: ai-answers-cited-domains-grouped** — by registrable domain, counted.
- **Scenario: ai-answers-watched-domain-highlighted** — the watched domain's citations and group marked.
- **Scenario: ai-answers-view-shows-cost-note-first** — Ask shows the cost note and Send; only Send
  calls `run`.
- **Scenario: ai-answers-gated-providers-disabled** — main's view says unavailable: engines disabled
  with `LEGAL_GATE_NOTE`, Ask disabled.
- **Scenario: ai-answers-delete-asks-first** — Delete and Delete all each ask first; a shorter retention
  or `off` asks first too (a longer one is saved at once).
- **Scenario: ai-answers-retention-change-deletes** — which retention changes delete now.
- **Scenario: ai-answers-kept-status** — "Shown, not kept" only with retention `off`; otherwise it could
  not be kept; an unkept answer has no Delete.
- **Scenario: ai-answers-palette** — "Ask AI engines…" and "Show AI answers".

## Independence (`apps/desktop/src/__tests__/phase-9-independence.test.ts`)
- **Scenario: phase-9-score-does-not-read-ai-answers** — an import-graph walk from Phase 9's
  AI-readiness modules reaches no `ai-answers*` module, no `specs/ai-search.*`, nothing under
  `main/ai-search/` or `main/data-sources/`, and not the shared `serp-worker.ts` (not a seed; why is in
  the test), and none of
  them names the `ai_answers` table.
