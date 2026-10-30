# Feature: The agent panel (renderer)

Spec: `specs/agent-panel.spec.ts` (`AGENT_PANEL_WIDTH`, `AGENT_RAIL_WIDTH`, `AGENT_PANEL_STORAGE_KEY`,
`AGENT_PALETTE_*_ID`, the words: routes, models, model providers (`AGENT_MODEL_PROVIDER_LABELS`), key slots, `AGENT_KEY_PROTECTION_MESSAGES`,
`AGENT_SET_KEY_MESSAGES`, `AGENT_TOOL_STATUS_LABELS`, `AGENT_APPROVAL_BUTTONS`,
`AGENT_ANSWER_MESSAGES`), `specs/agent-session.spec.ts` (`AgentState`, `APPROVAL_ENABLE_DELAY_MS`,
`EXECUTE_JS_APPROVAL_NOTE`, `MODEL_CONTEXT_WINDOWS`, the seam's switch). Phase 5 Task 6b
(`docs/plans/phase-5-ai-agent.md`, decisions 8–9; Task 4's review on approval cards).
Code: `apps/desktop/src/renderer/agent-view.ts`, `agent-actions.ts`, `agent-palette.ts`,
`hooks/useAgentState.ts`, `components/agent/*` (styles: `components/agent/agent.css`). Each line maps
to one named test.

## Decisions
- **Layout.** The workspace row is page | agent | SEO sidebar (its panel, then its rail at the
  window's edge). Both panels may be open; each gives way before the page goes under
  `PAGE_MIN_WIDTH`, and the page area shrinks (its box is reported to main, so the tab's view never
  covers a panel). Collapsed, the agent is a rail `AGENT_RAIL_WIDTH` wide with its toggle (and a
  badge while a turn runs or an approval waits); open, a panel `AGENT_PANEL_WIDTH` wide. It starts
  closed and remembers the user's open / closed choice (`AGENT_PANEL_STORAGE_KEY`). A new approval
  request opens it for now without changing that choice.
- **Toggle.** The rail's button and the palette's "Toggle AI agent" (plus "AI agent settings" and
  "New AI agent chat"). No keyboard shortcut: shortcuts are main's menu table, not the panel's.
- **State.** The panel renders main's `AgentState` only, long-polled over `agent.watch` with backoff
  on error and a short pause after an answer that didn't advance the version (never a tight loop);
  unmounting aborts the poll in flight. Intents go over the sender-guarded `agent.*` procedures, each with a
  safe fallback on an IPC failure.
- **Inert text.** Model text, page text and tool output are React text children only (no HTML, no
  Markdown); tool output sits in a `<pre>` under "untrusted data, shown as text".
- **Approvals.** One card at a time: main's oldest pending request, keyed by its id (never
  reordered under the pointer), "N more waiting" behind it. Allow buttons are disabled for
  `APPROVAL_ENABLE_DELAY_MS` after the card appears (and again after the window regains focus, and
  while the tab's fullscreen page covers the chrome: the permission bar's arming, with this delay).
  Deny and Escape always work. "Always allow on this site" only when `grantable`. The card shows the
  page, `navigate`'s full destination ("Opens", bidi-isolated), the chat asking when it isn't the
  one on screen, and the whole input; `execute_javascript` its exact code in a scrollable monospace
  block that wraps (nothing hides past its right edge), a hint while more code lies below, and
  `EXECUTE_JS_APPROVAL_NOTE`.
- **Keys.** A key field per slot is a password input the panel never keeps in state: Save reads it,
  empties it before the call, and shows main's answer. A slot says only "Key saved" / "No key".
  Protection and isolation are said plainly, and a file sandbox is never claimed when the runtime
  reports none: "Agent process: network functions removed. File sandbox: not in effect" on
  Electron 45 (its network functions, not all network access; the cause is Electron, not the
  platform).

## View model (`renderer/__tests__/agent-view.test.ts`)
- **Scenario: agent-panel-starts-closed** — only a stored `'1'` opens it.
- **Scenario: tool-card-status-and-tone** — each status's label and tone; output kept verbatim.
- **Scenario: approval-titles-per-tool** — navigate, click, execute_javascript, MCP, read tools.
- **Scenario: approval-card-shows-whole-input-and-code** — input in full, code as code, queued count.
- **Scenario: approval-names-destination-and-asking-chat** — navigate's URL; another chat by title.
- **Scenario: always-allow-only-when-grantable**, **answer-messages**, **set-key-messages**.
- **Scenario: context-meter** — tokens against the window with a percentage; tokens only without one.
- **Scenario: setup-checklist-and-protection-wording**, **isolation-wording-is-honest**.
- **Scenario: model-and-route-options**, **composer-keys**, **chat-helpers**.
- **Scenario: model-options-grouped-by-provider** (Phase 8 Task 7) — the model select groups the
  catalogue's models by provider (`MODEL_PROVIDERS` order, `AGENT_MODEL_PROVIDER_LABELS`), the
  same choices as `modelOptions`; a key route shows only its provider's group (no Gemini or Grok
  model), and switching to one from a Gemini or Grok model picks its first model; on the gateway a
  Gemini or Grok model is kept; a ChatGPT account's models are one unlabelled group; no models, no
  group.
- **Scenario: reasoning-options-follow-the-model** (Phase 8 Task 9, Decision 8; `agent-view.test.ts`)
  — the reasoning select offers exactly `setup.reasoning.levels` (main's list for the selected
  model, `auto` first) under `AGENT_REASONING_LABELS`, and shows `setup.reasoning.effort`, the level
  the next turn sends (a stored level the model lacks already reads `auto`: the panel shows "Auto"
  where the stored one does not apply, and the stored one returns on a model that offers it). On an
  OpenAI model (`openai/*`) `off` reads "Minimal" (`AGENT_REASONING_OPENAI_OFF_LABEL`); on a Claude,
  Gemini or Grok model it reads "Off" where offered. Switching the model changes the offered levels
  at once, because they are read from the new setup. A value that is not a level is no choice.
- **Scenario: reasoning-auto-only-explained** (`agent-view.test.ts`, `agent-components.test.ts`) —
  when the model offers only `auto` (a Grok model; a ChatGPT model with no advertised levels) the
  select is disabled, shows Auto, and `AGENT_REASONING_UNAVAILABLE` is said beside it; with more
  levels the select is enabled and that sentence is absent. `AGENT_REASONING_HINT` is always one
  line under the select.

## Components (`renderer/__tests__/agent-components.test.ts`, jsdom)
- **Scenario: tool-output-renders-as-text** — markup in the output stays text; no element is made.
- **Scenario: approval-buttons-arm-after-delay**, **approval-covered-stays-disarmed**.
- **Scenario: approval-escape-denies-and-no-always-unless-grantable**.
- **Scenario: approval-code-hint-and-destination** — the hint while code overflows; the "Opens" line.
- **Scenario: agent-panel-swapped-approval-starts-disarmed** (`agent-panel.test.ts`) — the next
  request's card is disarmed for a whole delay.
- **Scenario: agent-panel-approval-opens-without-changing-the-preference** (`agent-panel.test.ts`).
- **Scenario: settings-key-field-never-keeps-the-key** — password input, emptied, never in the DOM.
- **Scenario: reasoning-select-sends-set-reasoning-effort** (Phase 8 Task 9; `agent-components.test.ts`)
  — choosing a level in the Reasoning select (under Model, labelled "Reasoning") calls
  `agentActions.setReasoningEffort(level)` once with that `REASONING_EFFORTS` value (never a label or
  a provider's value) and nothing else; a refused store shows "That choice could not be saved."; the
  select reflects main's state, not the click.
- **Scenario: composer-enter-sends-shift-enter-does-not** — and Stop replaces Send while running.

## Wiring
- **Scenario: agent-watch-hook-backs-off-and-stops**, **agent-watch-pauses-when-version-does-not-advance**
  (`agent-state-hook.test.ts`).
- **Scenario: agent-palette-actions** (`agent-palette.test.ts`).
- **Scenario: agent-styles-are-delimited** (`src/__tests__/agent-styles.test.ts`) — every `.agent`
  rule in `agent.css`; approved code wraps (`pre-wrap`); no inline style or HTML injection in the
  panel; no Zod schema imported.

## End to end (`apps/desktop/e2e/agent.e2e.ts`, scripted model seam)
- **Scenario: agent-approval-flow** — a scripted navigate shows the card with the destination's
  origin; Allow once is disabled for the delay; allowed, the tab navigates and the scripted text
  streams in; the context meter shows the step's tokens.
- **Scenario: agent-panel-keeps-the-page-view-clear** — open, the tab's view ends at the panel's left
  edge; collapsed, it widens again.
- **Scenario: agent-approval-deny** — denied: no navigation, the card says Denied, the chat goes on.
- **Scenario: agent-stop** — Stop during an approval: the card expires and the turn ends.
- **Scenario: agent-execute-js-asks-every-time** — each run asks, with the full code and the note;
  the next card starts disarmed; long code shows the hint and padded code wraps into view; Escape
  denies.
- **Scenario: agent-settings-never-shows-key** — a password field; Save answers honestly
  (`no-keychain` with `--password-store=basic` on Linux; elsewhere a stored key is cleared again);
  the key is in no text, markup or value.
- **Scenario: agent-renders-tool-output-as-text** — page text that looks like markup shows
  literally; no element is made and nothing runs.
- **Scenario: agent-model-and-reasoning-settings** (Phase 8 Task 9, end to end: `agent.e2e.ts`)
  — in the settings the model select lists the Gemini and Grok models under their provider
  headings on the gateway route; choosing a Gemini model offers Auto, Low, Medium and High (Gemini
  3.8 Flash: Auto, Low and High); choosing a Grok model leaves Auto, disabled, with the reason
  said; choosing Medium on a Gemini model is stored (the select still reads Medium after the state
  comes back) and, on switching to a Grok model, reads Auto while the stored level returns on a
  model that offers it.
