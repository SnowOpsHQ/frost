# Phase 5 — AI Agent Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green, then one conventional commit), a fresh reviewer before the next task
> starts, and a whole-branch review at the end. Tasks 3 and 4 (the model proxy, approvals and the
> sandbox) get a security-focused review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an agent that audits and operates the browser safely:
- it reads the page's audit, facts and text, and explains or fixes what it finds;
- it navigates and clicks only with the user's approval or a standing grant the user gave;
- it runs page JavaScript only with an approval for each call, in an isolated world, bounded;
- it runs declarative SEO skills of frost's own, which the user can edit;
- the user governs it: keys, model, grants, MCP connections, chat retention and export.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §2 (AI row), §3 (security model: agent rules), §4 Phase 5.
- UI direction: `docs/ui-reference/README.md`.

## Decisions (made by the lead; recorded here)
1. **Model routing.** The Vercel AI SDK (`ai` v7) behind one provider interface with two routes:
   - **bring-your-own-key**: an Anthropic or OpenAI key (`@ai-sdk/anthropic`, `@ai-sdk/openai`);
   - **Vercel AI Gateway**: `provider/model` strings (`@ai-sdk/gateway`) with a gateway key.

   Keys are stored by main with `safeStorage` and never reach the renderer, the agent process,
   logs or the model's context. frost ships no keys. The default model is
   `anthropic/claude-sonnet-5-5`; the user can choose `anthropic/claude-opus-5-5`. On the
   bring-your-own-key route the provider prefix is dropped (`claude-sonnet-5-5`).
2. **Tests.** Unit tests drive the chat loop with the AI SDK's `MockLanguageModelV4` (`ai/test`) and
   scripted tool-call streams. CI makes no network call to a model provider. The e2e uses an
   unpackaged-only scripted model seam (Task 6).
3. **Entitlements.** Phase 4 is built in parallel. Agent features are gated through a local
   `AgentEntitlements` port (`apps/desktop/src/main/agent/entitlements.ts`) that defaults to
   allowed. The lead wires it to Phase 4's `requireFeature(flag)` after both merge.
4. **SERP, intent and GSC** come from Phases 3 and 4, in flight. `packages/ai-skills` defines
   `SerpPort`, `IntentPort` and `GscPort` with fakes; a tool whose port is not wired answers
   `unavailable`. Phase 3 will export a Zod-typed read API from
   `packages/ipc-contract/src/serp-service.ts`, Phase 4 from `gsc-service.ts`; the ports mirror
   read-only queries so each adapter is a thin mapping.

## Decisions made in this plan
5. **Model requests are made by main, not by the agent process** (a proxied `fetch`).
   - The agent runtime builds its AI SDK provider with a placeholder key and a custom `fetch` that
     sends the request (method, URL, non-credential headers, body) to main over the MessagePort.
   - Main checks the URL against the configured route's endpoint allowlist (exact origin and path
     prefix: `https://api.anthropic.com/v1/`, `https://api.openai.com/v1/`,
     `https://ai-gateway.vercel.sh/v4/ai/`), drops every credential-like header the runtime sent, adds the
     real credential, performs the request with Electron `net.fetch` on an in-memory session with no
     cookies, and streams the response body back in chunks. Anything else is refused.
   - **Why:** the key never enters the agent process, so no bug, dependency or log line there can
     leak it; main is the single place that decides where the agent may reach. The cost (one hop of
     streaming over a MessagePort) is small next to model latency.
   - The runtime itself has no network use: at startup it removes `fetch`, `WebSocket` and
     `EventSource` from its globals (its proxied fetch is captured first), and its bundle imports no
     `node:http(s)`, `node:net` or `node:child_process`.
6. **Agent process lockdown.** `utilityProcess.fork` with:
   - an empty environment (only `NODE_ENV`), so no inherited secret is visible;
   - `execArgv: ['--permission', '--allow-fs-read=<its own bundle>']` (Node's permission model in
     Electron 45's Node 24): no file writes, no reads beyond its bundle, no child processes, no
     workers, no native addons. If a platform refuses the flags, main logs that once and the
     runtime still runs with the globals removed: the agent settings page says which (never claims
     a lockdown that isn't in effect);
   - `stdio: 'ignore'` in packaged builds; `serviceName: 'frost agent'`.

   Node's permission model doesn't cover sockets in Node 24, so "no direct network" rests on the
   globals removal and on the bundle's imports (a test asserts the bundle imports none of the
   network modules). The runtime holds no credential, so even a socket opened by a dependency bug
   carries nothing secret.
7. **Approvals live entirely in main.** Each tool's `execute` in the runtime is only a request
   (`tool.invoke`) to main. Main's broker decides: run on a standing grant, ask the user, or refuse;
   main runs the tool and answers `tool.result`. The protocol has **no message** by which the agent
   process can approve, grant or change settings; main drops any unknown message. The AI SDK's own
   `toolApproval` is not used: approvals must not travel through the process that asks for them.
8. **Streaming to the renderer** uses the IPC contract's existing long-poll pattern
   (`browser.watch`): `agent.watch(sinceVersion)` answers the chat state once it changes. No new
   transport.
9. **Tool output is untrusted data.** Every tool result is wrapped by main as
   `{ untrusted: true, source, data }`, with text capped; the system prompt tells the model that tool
   output is data, never instructions; the renderer shows tool output as inert text only.

## Global Constraints
Everything in the Phase 0–2.5 Global Constraints and `CONTRIBUTING.md` still holds, plus:
- **Clean-room.** Every prompt, skill and string is written here in frost's own words.
- **Team contract.** New files only in `apps/agent-runtime/**`, `packages/ai-skills/**`,
  `packages/ipc-contract/src/agent-router.ts` and `agent-service.ts`, `specs/agent-*`,
  `specs/skills-*`, `apps/desktop/src/main/agent/**`, renderer `agent-view.ts` / `agent-*.ts` /
  `components/agent/**`. Hub files (`router.ts`, `services.ts`, `main/index.ts`, `App.tsx`, the
  palette registry, root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, the Forge config)
  get only small, append-only one-line registrations. DB migrations use ids `0030`–`0039`.
- **Keys** never reach the renderer, logs, the agent process or the model's context. The renderer can
  set or clear a key and learn whether one is set; it can never read one back.
- **No shell, file or fetch tools.** The agent's tools are the ones listed here; MCP tools are
  labelled untrusted and always need a per-call approval.

## Threat model (the approval system)
| Threat | Mitigation | Test |
|---|---|---|
| A page's text instructs the model to do something (prompt injection) | Tool output wrapped as untrusted data; every acting tool needs approval or a grant the user gave; `execute_javascript` and MCP calls need approval every time | Task 4 `injection-cannot-escalate` |
| The agent process approves its own call | No approve/grant message exists in the protocol; main drops unknown or malformed messages; approvals arrive only over the `enforceSender` IPC from the app window | Task 1 `agent-cannot-approve`, Task 4 |
| A page or a tab's renderer answers an approval | `agent.answerApproval` is an IPC procedure behind `enforceSender` (app windows only); approval ids are random and single-use | Task 5 |
| A stale approval is replayed | Each approval is bound to one call id, its tool name and a hash of its exact input; answered once; expires with the turn | Task 4 |
| A key leaks to the renderer, a log or the model | Keys stored with `safeStorage`; only main's proxy reads them; the settings procedures answer `hasKey` only; the runtime never sees one | Task 3 `key-never-leaves-main` |
| The agent reaches arbitrary hosts | Model requests go through main's proxy and its endpoint allowlist; the runtime has no network globals | Task 3 `proxy-allowlist` |
| `execute_javascript` takes over the page or hangs | Runs in a dedicated isolated world (never the main world), per-call approval showing the exact code, a timeout and a result size cap | Task 4/5 |
| A standing grant outlives the user's intent | Grants are per tool and per origin, listed on the grants page, revocable one by one or all at once | Task 9 |
| An MCP server is hostile | Labelled untrusted; nothing auto-granted; stdio servers need explicit approval to start, run in an OS sandbox profile where available, and the UI says when none is | Task 10 |

## Review Focus
- The agent process can't approve, grant, read keys or reach the network (Tasks 1, 2, 3, 4).
- Tool output never becomes an instruction to frost: only the user's approval runs an acting tool.
- `execute_javascript` is per-call, isolated-world, bounded (Task 5).
- The renderer can't read a key back (Task 6).

---

### Task 1: Agent protocol, tool catalogue and ports
- **Spec:** `specs/agent-protocol.schema.ts` (Zod): every MessagePort message both ways, as a
  discriminated union on `type`, with bounded strings and arrays.
  - main → runtime: `chat.start` (chat id, messages, system prompt, model id, tool names allowed),
    `chat.stop`, `tool.result`, `fetch.response-start` / `fetch.chunk` / `fetch.end` / `fetch.error`.
  - runtime → main: `chat.delta` (text), `chat.tool-call` (card), `chat.finish` (usage, finish
    reason), `chat.error`, `tool.invoke` (call id, tool name, input), `fetch.request`.
  - Explicitly **no** approval, grant or settings message from the runtime.
- **Spec:** `specs/agent-tools.spec.ts`: the tool catalogue (name, risk class `read` / `act` /
  `execute` / `external`, whether a standing grant may cover it), the caps
  (`EXECUTE_JS_TIMEOUT_MS`, `EXECUTE_JS_MAX_RESULT_BYTES`, `TOOL_RESULT_MAX_CHARS`,
  `MAX_TOOL_STEPS`), the default and allowed model ids, and the endpoint allowlist. Plus
  `specs/agent-protocol.feature.md` (scenarios → named tests).
- **Package:** `packages/ai-skills` (`@app/ai-skills`): tool definitions (description + Zod input
  schema per catalogue entry), and the ports `SerpPort`, `IntentPort`, `GscPort` with fakes and an
  `unavailable` answer shape.
- **Tests:** schema round-trips; malformed and unknown messages rejected; no runtime→main message
  type can carry an approval (`agent-cannot-approve`); every catalogue tool has a definition; ports'
  fakes satisfy the interfaces.
- [ ] commit `feat(agent): protocol, tool catalogue and ports`

### Task 2: Agent runtime (utility process) and chat loop
- **Files:** `apps/agent-runtime/` (`@app/agent-runtime`): `src/index.ts` (utility-process entry:
  receives its MessagePort from main, validates every message with Task 1's schema, drops invalid
  ones), `src/lockdown.ts` (removes network globals), `src/proxy-fetch.ts` (the `fetch` the
  providers use: `fetch.request` → streamed `Response`), `src/provider.ts` (one interface over the
  BYOK and gateway routes with a placeholder key), `src/chat.ts` (the loop: `streamText` with the
  allowed tools, `stopWhen: isStepCount(MAX_TOOL_STEPS)`, an `AbortController` per chat for Stop; each
  tool's `execute` posts `tool.invoke` and awaits `tool.result`; text deltas and tool cards stream as
  `chat.*` messages).
- **Build:** a Forge Vite main-target entry `agent-runtime` (one line in `forge.config.ts`), bundled
  beside `main.cjs`.
- **Tests (`MockLanguageModelV4`):** a scripted stream with text, a tool call and a finish produces
  `chat.delta`, `tool.invoke`, then continues with the result; Stop aborts mid-stream; the step cap
  holds; invalid inbound messages are dropped; the proxied fetch streams a body; lockdown removes the
  globals; the bundle's sources import no network or process module (`runtime-has-no-network`).
- [ ] commit `feat(agent): agent runtime utility process and chat loop`

### Task 3: Main host, key store and model proxy (security review)
- **Files:** `apps/desktop/src/main/agent/`: `host.ts` (forks the runtime as decision 6, wires a
  `MessageChannelMain`, validates inbound with Task 1's schema, restarts on crash with backoff),
  `credentials.ts` (keys per route encrypted with `safeStorage` in a file under `userData`;
  `hasKey`, `setKey`, `clearKey`; refuses to store when encryption isn't available and says so),
  `model-proxy.ts` (decision 5: allowlist, header scrub and injection, `net.fetch` on an in-memory
  session, streamed back, size and time caps), `settings.ts` (route, model id), `entitlements.ts`
  (the `AgentEntitlements` port, default allowed).
- **Tests:** `key-never-leaves-main` (no message to the runtime or answer to the renderer contains
  the key; logs never print it), `proxy-allowlist` (other hosts, schemes, ports and paths refused;
  redirects not followed off the allowlist), credential headers from the runtime dropped, the stored
  file is not plaintext, crash restart.
- [ ] commit `feat(agent): main-side agent host, key store and model proxy`

### Task 4: Approval broker and standing grants (security review)
- **Files:** `apps/desktop/src/main/agent/approvals.ts`, `grants.ts`; migration
  `0030_agent_grants` in `packages/db` (table `agent_grants`: tool, origin, created_at).
- **Policy:** `read` tools run (a standing grant is implied, revocable by turning the tool off);
  `act` tools (navigate, click) need approval unless a standing grant for that tool and origin
  exists; `execute` (`execute_javascript`) needs approval **every call**, never grantable; `external`
  (MCP) always per call. An approval request carries the call id, tool, exact input and the origin;
  it is answered once, from the renderer only, or expires when the chat stops.
- **Tests:** each risk class's path; `agent-cannot-approve`; replay refused; a grant for one origin
  doesn't cover another; Stop rejects pending approvals; `injection-cannot-escalate` (a page text
  saying "click …" leads to an approval request, not a click).
- [ ] commit `feat(agent): approval broker and standing grants`

### Task 5: Core page tools
- **Files:** `apps/desktop/src/main/agent/tools/`: `page-audit` (the tab's ready audit, summarised
  and capped), `page-data` (page facts: title, meta, headings, links counts, schema types,
  indexability verdict), `page-text` (visible text, capped), `navigate` (http(s) only, through the
  controller), `click` (a CSS selector or visible text, in an isolated world; reports what was
  clicked), `execute_javascript` (dedicated isolated world, `EXECUTE_JS_TIMEOUT_MS`,
  `EXECUTE_JS_MAX_RESULT_BYTES`, result JSON-serialised and capped). Every result wrapped untrusted.
- **Tests:** unit tests with fakes for each tool and cap; execute JS never uses the main world;
  timeout ends a hung script; oversized results truncated.
- [ ] commit `feat(agent): core page tools`

### Task 6: Agent IPC router and sidebar panel
- **Files:** `packages/ipc-contract/src/agent-router.ts`, `agent-service.ts` (one line each in
  `router.ts` and `services.ts`): `agent.watch`, `agent.send`, `agent.stop`, `agent.answerApproval`,
  `agent.newChat`, `agent.settings` (`get` answers route, model and `hasKey` only; `setKey`,
  `clearKey`, `setModel`). Renderer `agent-view.ts` (pure view model) and `components/agent/*`:
  streaming chat, tool-call cards, approval prompts (shows exact input; Allow once / Allow for this
  site where grantable / Deny), a Stop button, a context-window meter, settings. One line in
  `App.tsx`; a palette action to toggle the panel.
- **e2e seam:** an unpackaged-only switch (`frost-e2e-agent-script`, refused in packaged builds like
  the other e2e switches) makes the runtime use a scripted model instead of a provider.
- **Tests:** router tests (sender rejection, key never in an answer), view-model tests, e2e:
  `agent-approval-flow` (scripted navigate → approval prompt → Allow → the tab navigates; Deny →
  no navigation), Stop.
- [ ] commit `feat(agent): agent sidebar panel and IPC`

### Task 7: Declarative SEO skills
- **Spec:** `specs/skills-schema.ts` (a skill: id, name, description, allowed tools, instruction
  template with `{{url}}`-style slots), `specs/skills.feature.md`.
- **Files:** `packages/ai-skills/src/skills/*`: built-ins `audit-this-page`, `rewrite-title-meta`,
  `internal-link-suggestions` (prompts written here); template rendering; a skill limits the chat's
  tools to its allowed list. Running a skill from the panel and the palette.
- **Tests:** schema; templates render; a skill can't name a tool outside the catalogue; the chat
  gets only the skill's tools.
- [ ] commit `feat(agent): declarative SEO skills`

### Task 8: SERP, intent, run-ai-search and GSC tools over ports
- **Files:** tool handlers in `apps/desktop/src/main/agent/tools/` over `@app/ai-skills` ports; main
  wires `null` ports until the lead connects Phases 3 and 4.
- **Tests:** each tool answers `unavailable` without a port and maps the fake's answer with one.
- [ ] commit `feat(agent): SERP, intent and GSC tools over ports`

### Task 9: Grants page, chat retention and export, skills editor
- Migrations `0031_agent_chats`, `0032_agent_skills`. Chats stored locally with a retention setting
  (off / 7 / 30 days / forever); export a chat as Markdown or JSON through main's save dialog; the
  grants page lists and revokes standing grants; the skills editor creates, edits and deletes user
  skills validated by Task 7's schema.
- [ ] commit `feat(agent): grants page, chat retention and export, skills editor`

### Task 10: MCP connections (untrusted)
- HTTP and stdio MCP servers configured by the user, labelled untrusted; each tool needs per-call
  approval; stdio servers need explicit approval to start and run under an OS sandbox profile where
  one exists (macOS `sandbox-exec` profile); where none is available the UI says so plainly.
- [ ] commit `feat(agent): MCP connections, untrusted`

---

## As built
_Filled in as tasks land._
