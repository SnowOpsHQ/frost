# Feature: Agent chat sessions, the agent IPC and the e2e seam (main)

Spec: `specs/agent-session.spec.ts` (`AgentState` and its views, `MODEL_CONTEXT_WINDOWS`,
`CHAT_TEXT_MAX_CHARS`, `CHAT_TITLE_MAX_CHARS`, `MAX_CHATS_KEPT_IN_MEMORY`, `MAX_DISPLAY_ENTRIES`,
`AGENT_DELTA_COALESCE_MS`, `AGENT_WATCH_TIMEOUT_MS`, `MAX_PENDING_AGENT_WATCHES`,
`APPROVAL_ENABLE_DELAY_MS`, `EXECUTE_JS_APPROVAL_NOTE`, `AGENT_SEND_RESULTS`,
`AGENT_SET_KEY_RESULTS`, `AGENT_ANSWER_RESULTS`, `AGENT_NOTICE_MESSAGES`, `AGENT_E2E_SCRIPT_SWITCH`,
`AGENT_E2E_SCRIPT_ENV`, `AGENT_E2E_SCRIPT_MAX_CHARS`), `specs/agent-ipc.schema.ts` (the `agent.*`
inputs), `specs/agent-e2e-script.schema.ts` (`AgentE2eScriptSchema`), `specs/agent-protocol.schema.ts`
(`chat.start`, `chat.step` with `usage`, `CHAT_BUSY_MESSAGE`), `specs/security-policy.spec.ts`
(`PACKAGED_FORBIDDEN_SWITCHES`). Phase 5 Task 6a (`docs/plans/phase-5-ai-agent.md`, decisions 7–9;
threat model rows "A page or a tab's renderer answers an approval", "A key leaks to the renderer").
Code: `apps/desktop/src/main/agent/` (`session.ts`, `system-prompt.ts`, `service.ts`, `wire.ts`,
`e2e-seam.ts`; `approvals.ts` `onResult`; `host.ts` `e2eAgentScript`),
`packages/ipc-contract/src/agent-router.ts`, `agent-service.ts`, `apps/agent-runtime/src/scripted-model.ts`.
Each line maps to one named test.

## Decisions
- **One turn at a time, app-wide.** `send` refuses (`busy`, a notice; nothing queued) while any turn
  runs, from the moment it is called (the key check and the runtime's start are awaited inside the
  turn). A chat is bound to the tab that was active when its first message was sent.
- **Setup before a turn.** The agent must be entitled (`agent`), the selected route must have a key
  (`setup-needed` otherwise; with the e2e seam on, no key is needed), and the runtime must start
  (lazily, on the first message). A refused send changes no chat.
- **The history is main's.** What a turn sends is built only from what main knows: the user's
  messages, each `chat.step` (text and the calls main was asked to run), and the results main's
  broker sent (`onResult`). A step is reported after its calls were answered, so a result waits for
  its step; a result that comes after its step (Stop: the broker expires the call as the turn ends)
  is appended while only results follow that step. A call with no result is left to the runtime,
  which reads it as aborted. A turn sends at most `CHAT_MAX_MESSAGES`, starting at a user message.
- **The busy reply is not a failure.** The runtime answers `CHAT_BUSY_MESSAGE` to a `chat.start` for
  a chat it is still running; before any output of the new turn that reply takes the user's message
  back and raises `busy`. Any other `chat.error` (the host's crash message included) ends the turn
  and shows as the chat's error.
- **The state is a view.** `AgentState` is rebuilt per version: setup (route, model, which keys are
  set as booleans, the key protection, the runtime's status and failure, the isolation said plainly
  from the runtime's own lockdown report), chat summaries, the selected chat (entries, tool cards
  with bounded input and output previews, error, usage, the context meter), the **oldest** pending
  approval and how many wait behind it, a notice, the read-tools setting and the grants count. It
  never holds a key; tool output is preview text only (inert in the panel).
- **The meter.** `usage` is the last turn's tokens summed over its steps (`chat.finish`);
  `contextTokens` is the last completed step's input plus output (`chat.step.usage`, protocol 5),
  against `MODEL_CONTEXT_WINDOWS[modelId]` (`null`: no published figure; no percentage).
- **Watch.** Every change raises `version`; streaming text is published at most every
  `AGENT_DELTA_COALESCE_MS`. `agent.watch` long-polls as `browser.watch` does.
- **IPC.** Every `agent.*` procedure is `publicProcedure.use(enforceSender).use(requireAgent)` with a
  strict, bounded input. Each answer is checked against its fixed set before it leaves; `setKey`'s
  input is the only place a key crosses IPC (renderer → main) and no answer or error echoes it.
- **E2e seam.** Unpackaged only: `--frost-e2e-agent-script=<file>` names a JSON script main reads
  once, validates and hands to the runtime in `AGENT_E2E_SCRIPT_ENV`; the runtime plays it as its
  model and makes no model request. A packaged build refuses to start with the switch, and neither
  reads the file nor passes the variable.

## Session (`apps/desktop/src/main/agent/__tests__/session.test.ts`: real host, broker and runtime; scripted model)
- **Scenario: session-turn-streams-to-state** — a send posts `chat.start` with the system prompt,
  the configured model and route, every catalogue tool and the user's message; deltas, steps, tool
  cards (status from the broker, output preview from main's result) and the finish land in the
  state; usage, context tokens and window show.
- **Scenario: session-deltas-stream-before-the-step** — a step's text streams before its call is
  answered; the approval shows; answering it runs the call and the card ends `done`; a second
  answer is `unknown`.
- **Scenario: session-history-across-turns** — over three turns (a denied navigate, a click stopped
  during its approval), each `chat.start` carries exactly the history so far: calls paired with
  main's `denied` and `expired` results, in order.
- **Scenario: session-one-turn-at-a-time** — a second send while one is starting or running is
  `busy`, with a notice, and adds nothing.
- **Scenario: session-crash-fails-the-turn** — the runtime exiting mid-turn ends it with the host's
  crash message as the chat's error; no approval is left.
- **Scenario: session-setup-needed-without-key** — with no key for the route, a send is
  `setup-needed` (no chat, no fork); `setKey` makes `setup.ready` true and a send starts; `clearKey`
  makes it false again.
- **Scenario: session-scripted-needs-no-key** — with the seam on, a send starts without a key.
- **Scenario: session-not-entitled** — without the `agent` entitlement a send is `not-entitled`.
- **Scenario: session-state-never-holds-a-key** — every published state, the logs and every message
  to the runtime are free of the keys set through the service.
- **Scenario: session-new-select-delete** — new, select and delete chats; a deleted chat's id is
  `unknown-chat`.
- **Scenario: session-delete-running-chat-stops-it** — deleting a running chat stops its turn.
- **Scenario: session-model-change** — `setModel` stores a valid pair and refuses another; the
  allowed models follow the route.

## State and watch (`session-state.test.ts`: fake deps)
- **Scenario: watch-coalesces-deltas** — three deltas within `AGENT_DELTA_COALESCE_MS` publish once;
  a step publishes at once with any pending text.
- **Scenario: watch-long-poll** — newer answers at once, an abort answers the current state, and one
  watch past `MAX_PENDING_AGENT_WATCHES` answers the oldest early.
- **Scenario: busy-reply-is-not-a-failure** — the busy reply before output takes the message back
  and raises `busy`; after output, and any other error, shows as the chat's error.
- **Scenario: crash-backstop-when-host-forgets-the-chat** — a host that stops without failing the
  chat still ends the turn with the crash message.
- **Scenario: host-refuses-start** — a refused `chat.start` or a runtime that won't start answers
  `unavailable` and leaves no chat.
- **Scenario: approval-view-is-oldest-with-queued-count** — the oldest request, field for field, with
  `EXECUTE_JS_APPROVAL_NOTE` for `execute_javascript`, and the count behind it.
- **Scenario: chats-kept-in-memory-are-bounded** — past `MAX_CHATS_KEPT_IN_MEMORY` the least recently
  used idle chat goes.
- **Scenario: invalid-and-unknown-sends** — empty text, an unknown chat, no tab: refused, nothing sent.
- **Scenario: model-context-windows-cover-allowed-models**, **chat-title**, **history-window**,
  **attach-tool-result**, **isolation-view-is-honest**,
  **system-prompt-is-stable-and-says-tool-output-is-untrusted** — the helpers.

## Broker results (`approvals.test.ts`)
- **Scenario: broker-reports-results-it-sent** — `onResult` hears each `tool.result` the host
  accepted (ran, denied, refused for an unknown chat), and none it refused.

## Router (`packages/ipc-contract/src/__tests__/agent-router.test.ts`)
- **Scenario: agent-procedures-enforce-sender** — every `agent.*` procedure refuses a foreign origin
  and a non-window sender before the service is touched; without the service, a masked error.
- **Scenario: agent-inputs-are-bounded** — malformed, unbounded or extra-field inputs are
  `BAD_REQUEST` and never reach the service.
- **Scenario: agent-procedures-call-service** — each procedure calls the service with its input; an
  answer outside its fixed set is replaced.
- **Scenario: agent-set-key-answer-has-no-key** — `setKey` answers only a fixed result; a refused
  input's error over the transport holds no part of the key.
- **Scenario: agent-watch-timeout-matches-browser-watch**, **agent-watch-returns-immediately-when-newer**,
  **agent-watch-resolves-on-change**, **agent-watch-times-out-with-current-state**,
  **agent-watch-clamps-future-version** — the long-poll.

## E2e seam and wiring (`e2e-seam.test.ts`, `service.test.ts`; runtime: `agent-runtime.feature.md`, Scripted model)
- **Scenario: e2e-seam-reads-a-valid-script-unpackaged** — a valid file is read and canonicalised;
  an invalid, too long or missing one leaves the seam off.
- **Scenario: e2e-seam-refused-when-packaged** — a packaged build never reads the file and refuses
  to start with the switch.
- **Scenario: e2e-seam-reaches-the-runtime-env-unpackaged-only** — the script reaches the runtime's
  environment only unpackaged; without one the environment is `NODE_ENV` alone.
- **Scenario: service-starts-lazily-and-disposes-on-quit** — nothing forks before the first message;
  the seam's script plays; quitting disposes the session and the runtime.
- **Scenario: service-packaged-ignores-the-e2e-script** — packaged, the switch is ignored and a key
  is needed.
