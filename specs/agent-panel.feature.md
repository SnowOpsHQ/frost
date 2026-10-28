# Feature: The agent panel (renderer)

Spec: `specs/agent-panel.spec.ts` (`AGENT_PANEL_WIDTH`, `AGENT_RAIL_WIDTH`, `AGENT_PANEL_STORAGE_KEY`,
`AGENT_PALETTE_*_ID`, the words: routes, models, key slots, `AGENT_KEY_PROTECTION_MESSAGES`,
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
  closed and remembers open / closed (`AGENT_PANEL_STORAGE_KEY`). A new approval request opens it.
- **Toggle.** The rail's button and the palette's "Toggle AI agent" (plus "AI agent settings" and
  "New AI agent chat"). No keyboard shortcut: shortcuts are main's menu table, not the panel's.
- **State.** The panel renders main's `AgentState` only, long-polled over `agent.watch` with backoff
  on error, stopped on unmount. Intents go over the sender-guarded `agent.*` procedures, each with a
  safe fallback on an IPC failure.
- **Inert text.** Model text, page text and tool output are React text children only (no HTML, no
  Markdown); tool output sits in a `<pre>` under "untrusted data, shown as text".
- **Approvals.** One card at a time: main's oldest pending request, keyed by its id (never
  reordered under the pointer), "N more waiting" behind it. Allow buttons are disabled for
  `APPROVAL_ENABLE_DELAY_MS` after the card appears (and again after the window regains focus, and
  while the tab's fullscreen page covers the chrome: the permission bar's arming, with this delay).
  Deny and Escape always work. "Always allow on this site" only when `grantable`. The card shows the
  page and the whole input; `execute_javascript` its exact code in a scrollable monospace block and
  `EXECUTE_JS_APPROVAL_NOTE`.
- **Keys.** A key field per slot is a password input the panel never keeps in state: Save reads it,
  empties it before the call, and shows main's answer. A slot says only "Key saved" / "No key".
  Protection and isolation are said plainly, and a file sandbox is never claimed when the runtime
  reports none.

## View model (`renderer/__tests__/agent-view.test.ts`)
- **Scenario: agent-panel-starts-closed** — only a stored `'1'` opens it.
- **Scenario: tool-card-status-and-tone** — each status's label and tone; output kept verbatim.
- **Scenario: approval-titles-per-tool** — navigate, click, execute_javascript, MCP, read tools.
- **Scenario: approval-card-shows-whole-input-and-code** — input in full, code as code, queued count.
- **Scenario: always-allow-only-when-grantable**, **answer-messages**, **set-key-messages**.
- **Scenario: context-meter** — tokens against the window with a percentage; tokens only without one.
- **Scenario: setup-checklist-and-protection-wording**, **isolation-wording-is-honest**.
- **Scenario: model-and-route-options**, **composer-keys**, **chat-helpers**.

## Components (`renderer/__tests__/agent-components.test.ts`, jsdom)
- **Scenario: tool-output-renders-as-text** — markup in the output stays text; no element is made.
- **Scenario: approval-buttons-arm-after-delay**, **approval-covered-stays-disarmed**.
- **Scenario: approval-escape-denies-and-no-always-unless-grantable**.
- **Scenario: settings-key-field-never-keeps-the-key** — password input, emptied, never in the DOM.
- **Scenario: composer-enter-sends-shift-enter-does-not** — and Stop replaces Send while running.

## Wiring
- **Scenario: agent-watch-hook-backs-off-and-stops** (`agent-state-hook.test.ts`).
- **Scenario: agent-palette-actions** (`agent-palette.test.ts`).
- **Scenario: agent-styles-are-delimited** (`src/__tests__/agent-styles.test.ts`) — every `.agent`
  rule in `agent.css`; no inline style or HTML injection in the panel; no Zod schema imported.

## End to end (`apps/desktop/e2e/agent.e2e.ts`, scripted model seam)
- **Scenario: agent-approval-flow** — a scripted navigate shows the card with the destination's
  origin; Allow once is disabled for the delay; allowed, the tab navigates and the scripted text
  streams in; the context meter shows the step's tokens.
- **Scenario: agent-approval-deny** — denied: no navigation, the card says Denied, the chat goes on.
- **Scenario: agent-stop** — Stop during an approval: the card expires and the turn ends.
- **Scenario: agent-execute-js-asks-every-time** — each run asks, with the full code and the note;
  Escape denies.
- **Scenario: agent-settings-never-shows-key** — a password field; Save answers honestly
  (`no-keychain` with `--password-store=basic` on Linux); the key is in no text, markup or value.
- **Scenario: agent-renders-tool-output-as-text** — page text that looks like markup shows
  literally; no element is made and nothing runs.
