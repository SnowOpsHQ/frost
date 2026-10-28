# Feature: SERP, intent, AI search and GSC tools over ports (main)

Spec: `specs/agent-search-tools.spec.ts` (`SEARCH_TOOL_NAMES`, `SEARCH_TOOL_TIMEOUT_MS`,
`SEARCH_TOOL_LIMITS`, `SEARCH_TOOL_SOURCES`, `PORT_NOT_CONNECTED_REASONS`, `GSC_NO_PAGE_REASON`),
`specs/agent-tools.spec.ts` (`AGENT_TOOL_INPUT_LIMITS.defaultGscDays`), the ports in
`packages/ai-skills/src/ports.ts`. Phase 5 Task 8 (`docs/plans/phase-5-ai-agent.md`, decision 4).
Code: `apps/desktop/src/main/agent/tools/search-tools.ts` (the handlers, called by `runner.ts`),
`apps/desktop/src/main/agent/ports/` (defaults and the adapters the lead fills in after Phases 3
and 4 merge), `service.ts` (`ports`, `entitlements`). Each line maps to one named test.

## Decisions
- **One handler per tool, over its port.** `serp_results` → `SerpPort.results`, `run_ai_search` →
  `SerpPort.aiSearch`, `search_intent` → `IntentPort.classify`, `gsc_performance` →
  `GscPort.performance` (its `url` is the chat tab's page without its fragment when the model gives
  none; `days` defaults to `defaultGscDays`). Each query gets a signal aborted when the chat stops
  or after `SEARCH_TOOL_TIMEOUT_MS`.
- **What the model reads is bounded.** The top results, citations and queries
  (`SEARCH_TOOL_LIMITS`), each list with its total; text cleaned of control and invisible
  characters and cut; numbers finite or `null`; an intent outside `SEARCH_INTENTS` dropped. A port
  answer that isn't the port's shape fails the call.
- **Unavailable is explained.** A port's `unavailable` answer reaches the model as data
  `{ unavailable: <reason> }` (inside the untrusted wrapper; the broker's error messages stay
  fixed). With no port at all the tool fails `unavailable`. Main wires
  `unavailablePort(PORT_NOT_CONNECTED_REASONS.…)` for each port until the lead passes adapters.
- **`run_ai_search` runs only with the user's approval** (`act`, never grantable): the handler
  refuses any other `via`.

## Handlers (`apps/desktop/src/main/agent/__tests__/search-tools.test.ts`)
- **Scenario: search-tools-unavailable-without-a-port** — each tool fails `unavailable` with no
  port; with the default ports each answers `{ unavailable: <its reason> }`.
- **Scenario: search-tools-map-the-fakes** — each tool maps the fake port's answer, with the
  query it was given (`url` and `days` defaults for GSC).
- **Scenario: search-tools-explain-unavailable** — a port's reason, cleaned and capped, as data.
- **Scenario: search-tools-cap-results** — long lists cut to their limits with totals; long text
  cut; bad numbers `null`; unknown intents dropped; malformed answers fail.
- **Scenario: search-tools-abort-propagates** — Stop aborts the port's signal and fails the call; a
  port that never answers times out and its signal is aborted.
- **Scenario: search-tools-gsc-needs-a-page** — no `url` and no web page in the tab: data with
  `GSC_NO_PAGE_REASON`, and the port is not asked.
- **Scenario: run-ai-search-needs-approval** — `via` other than `approval` is refused.

## Wiring (`apps/desktop/src/main/agent/__tests__/agent-ports.test.ts`)
- **Scenario: agent-ports-default-to-not-connected** — `resolveAgentPorts()` answers
  `unavailable` with `PORT_NOT_CONNECTED_REASONS`; a given port is used as is.
- **Scenario: agent-port-adapters-are-thin** — an adapter over a read service maps its data to
  `ok`, a missing answer and a thrown error to `unavailable`, and passes the signal on.
- **Scenario: agent-search-tools-through-the-broker** — a scripted turn calls `serp_results` and
  the model's history holds the wrapped, mapped answer.
