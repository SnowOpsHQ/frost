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
   - Main checks the request against the configured route's allowlist (a canonical URL and an exact
     method and path: `POST https://api.anthropic.com/v1/messages`,
     `POST https://api.openai.com/v1/responses`,
     `POST https://ai-gateway.vercel.sh/v4/ai/language-model`), keeps only an allowlist of the
     runtime's headers (so every credential, cookie or proxy header it sent is dropped), checks the
     body (the configured model, no server-side tool, MCP server or file reference, OpenAI
     `store: false`), adds the real credential, performs the request with Electron's `fetch` on an
     in-memory session with no cookies and no redirects, and streams the response body back in
     chunks (an error status's body is withheld). Anything else is refused.
   - **Why:** the key never enters the agent process, so no bug, dependency or log line there can
     leak it; main is the single place that decides where the agent may reach. The cost (one hop of
     streaming over a MessagePort) is small next to model latency.
   - The runtime itself has no network use: at startup it removes `fetch`, `WebSocket` and
     `EventSource` from its globals (its proxied fetch is captured first), and its bundle imports no
     `node:http(s)`, `node:net` or `node:child_process`.
6. **Agent process lockdown.** `utilityProcess.fork` with:
   - an empty environment (only `NODE_ENV`), so no inherited secret is visible;
   - `execArgv: ['--permission', '--allow-fs-read=<its build directory>']`;
   - `stdio: 'ignore'` in packaged builds; `serviceName: 'frost agent'`.

   **What this does not give us (verified, Task 2):** Electron 45 does not enforce Node's
   permission model in a utility process: the flags show in `process.execArgv`, but file reads and
   writes elsewhere succeed and `process.permission` is undefined. So the agent process is **not**
   OS-sandboxed and **not** file-restricted on Electron 45. The flags stay (harmless, and in effect
   should a later Electron enforce them), and the runtime reports what is actually in effect in
   `ready.lockdown` (`permissionModel: false` today); main's host exposes that report and the agent
   settings page says "File sandbox: not in effect", never claiming one.

   **Stated plainly:** on Electron 45 the agent process runs unsandboxed, as the user. A
   code-execution bug in it or its dependencies could reach whatever the user can: their files,
   other processes, the OS keychain by other means, the network through a native path we have not
   closed. What we rely on instead:
   - **it holds no secret**: keys stay in main's proxy (decision 5), its environment is empty, and
     main stores a key only behind the OS keychain (`safeStorage` with a secret service; never
     Chromium's fixed-key fallback, which the agent process could decrypt offline or forge);
   - **no dynamic code**: after its modules load it stops module loading (`Module._load`,
     `Module.prototype.require`, `process.mainModule`) and code generation from strings (`eval`
     and the `Function` constructors; Electron 45 ignores `--disallow-code-generation-from-strings`
     there too), so an injected string can't become code through the usual paths;
   - **a narrow, validated protocol**: every message parsed both ways, none that approves, grants,
     changes a setting or carries a key; a flood of invalid or refused messages restarts it;
   - **no network of its own**: the network globals and builtin lookups are removed and its own
     sources import no network or process module; model requests are main's, for running turns
     only, within a per-turn budget, to one allowlisted URL per route, with checked bodies;
   - **main decides every action** (decision 7), and no agent tool touches the file system.

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
| A key leaks to the renderer, a log or the model | Keys stored with `safeStorage`, only behind the OS keychain (refused with Chromium's fixed key, which the unsandboxed agent process could decrypt); only main's proxy reads them; error bodies are withheld from the runtime; the settings procedures answer `hasKey` only; the runtime never sees one | Task 3 `key-never-leaves-main`, `credentials-weak-blob-never-used` |
| Code execution in the agent process (a dependency bug) | Not sandboxed on Electron 45: it runs as the user. It holds no secret, loads no module and generates no code from strings after startup, has no network globals, speaks only the validated protocol (floods restart it), and main decides every action and every model request | Task 2/3 lockdown tests, `host-flood-restarts` |
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
- [x] commit `feat(agent): protocol, tool catalogue and ports`

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
- [x] commit `feat(agent): agent runtime utility process and chat loop`

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
- [x] commit `feat(agent): main-side agent host, key store and model proxy`

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
- [x] commit `feat(agent): approval broker and standing grants`

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
- **Task 2.** `@app/agent-runtime` exports `startRuntime(port, { modelFactory?, newRequestId?,
  lockdown? })` and `runAgentRuntimeProcess(options)`: it removes the network globals and
  `process.getBuiltinModule` / `binding` / `_linkedBinding` / `dlopen` once its modules have loaded,
  then binds the first `parentPort` message carrying a port (`child.postMessage(null, [port])`) and
  reports the lockdown in `ready` (protocol version 2). The Forge build emits `agent-runtime.cjs`
  plus two chunks beside it (`runtime-entry-<hash>.cjs`, `token-<hash>.cjs`), so `--allow-fs-read`
  must cover `.vite/build`, not one file. What is checked: a test reads the runtime's own sources
  (no network, process or file module; no `getBuiltinModule`, `createRequire`, `dlopen`); the bundle
  was grepped by hand: its `require()` calls are `fs`, `os` and `path` (the gateway provider's OIDC
  helper, reached only without an API key), and the AI SDK's default URL download reaches
  `node:dns` and `node:module` → `createRequire(…)('undici')` through `process.getBuiltinModule`
  (removed at startup; the chat loop also passes a download that refuses). A failed proxied request
  is final (never retried by the SDK); HTTP 429 and 5xx are retried once (`maxRetries` 1).
  **For Task 3:** in Electron 45 a utility process forked with `execArgv: ['--permission',
  '--allow-fs-read=…']` lists the flags in `process.execArgv` but does not enforce them (file
  writes and reads elsewhere succeed; `process.permission` is undefined), so `ready.lockdown.permissionModel`
  is `false` there and the settings page must say so.
- **Task 3.** `apps/desktop/src/main/agent/index.ts` exports `createAgent({ electron:
  { utilityProcess, MessageChannelMain, safeStorage, session }, userData, buildDir: __dirname,
  packaged: app.isPackaged, log })` → `{ host, credentials, settings, proxy, entitlements, start(),
  dispose() }` (Task 6 wires it with one line). The rules (header allowlists, body checks, caps) are
  plain functions in `specs/agent-proxy.spec.ts`; acceptance `specs/agent-host.feature.md`. Facts it
  rests on, checked on Electron 45: `session.fetch` with `redirect: 'error'` rejects a 3xx
  ("Attempted to redirect, but redirect policy was 'error'"; `manual` rejects too), and with
  `credentials: 'omit'` sends and stores no cookie; `safeStorage`'s synchronous API is deprecated
  and on Linux its `isEncryptionAvailable()` answers `false` while the asynchronous encryptor
  works, so keys use the asynchronous API, and `weak` is decided from the encryptor's output (`v10`:
  Chromium's fixed key; `v11`: a secret service), not from `getSelectedStorageBackend()` (which said
  `basic_text` while a secret service was in use). Route and model live in `agent-settings.json`
  (the database's settings repository is typed per setting; no other phase's table changes). A
  throwaway smoke forked the built runtime through the host, ran a turn over the real proxy and
  `session.fetch` to a local HTTPS stand-in for the endpoint (the key arrived only as `x-api-key`,
  no cookie was stored, a redirect was refused), and a killed runtime was restarted and served the
  next turn.
- **Task 3 review.** The proxy sends the checked body re-serialized (a repeated key can't differ
  from what was checked); the body check is a nested allowlist built from the providers' real
  requests, reasoning and parallel tool calls included, and requires an output cap of at most
  `MAX_OUTPUT_TOKENS` (16384; the runtime now passes `maxOutputTokens`). Keys are stored only with
  `os` protection (`setKey` answers `no-keychain` otherwise; on Linux a blob must be `v11`). The
  host accepts model requests only for running turns (`MAX_MODEL_REQUESTS_PER_TURN` = 24 each),
  restarts a runtime that floods it (`misbehaved`), and refusal logs are coalesced. The runtime's
  lockdown now also stops module loading and code generation from strings (protocol version 3);
  Zod runs `jitless` in the runtime (set before any schema is built), since it would otherwise
  compile parsers with `new Function` after the lockdown. Verified in a real utility process.
- **Task 4.** Policy and constants are plain functions in `specs/agent-approvals.spec.ts` (`decide`,
  `grantOriginFor`, `approvalOriginFor`, `isGrantOrigin`, `canGrant`, `APPROVAL_TIMEOUT_MS` 5 min,
  `TOOL_ERROR_MESSAGES`); acceptance `specs/agent-approvals.feature.md`. `createAgent` now also takes
  `grantsStore` (`SessionStore.agentGrants`), `toolRunner` (Task 5; default answers `unavailable`)
  and `tabUrl(tabId)`, and returns `grants` and `approvals`; `start()` loads the grants first. The
  session manager (Task 6) calls `approvals.register(chatId, { tabId, allowedTools })` before each
  `chat.start` and `unregister(chatId)` on Stop; the broker also ends a turn itself on its
  `chat.finish` / `chat.error` (the host sends one when the runtime dies), so nothing waits on a
  finished turn. `answer(approvalId, 'allow-once' | 'allow-always' | 'deny')` is for Task 6's
  sender-guarded IPC only; it resolves once the decision is applied (an allowed call then runs on its
  own; its outcome shows in `activity()`). Choices: a repeated call id is dropped unanswered (a host
  strike), since answering it would race the first call's answer; every approved page tool
  (click, execute_javascript, and the page reads when read tools are off) re-checks that the tab
  still shows the approved origin; the request view carries `execute_javascript`'s code in full
  (the display input is cut at 4000 characters); runner errors carry only fixed messages, so a
  tool that wants to explain a miss returns it as data. Migration `0030_agent_grants` creates
  `agent_grants` and `agent_preferences` (the read-tools setting, key `read_tools_allowed`), appended
  to `MIGRATIONS` as `...AGENT_GRANTS_MIGRATIONS`; when Phase 6's `...CHANGE_INTEL_MIGRATIONS`
  (`0040`+) merges, ours must stay before it (ids strictly increase). `@app/desktop` now depends on
  `@app/ai-skills` (main re-parses each input with the tool's own schema); its lockfile entry was
  added by hand because `pnpm install` currently refuses the AI SDK entries under the
  minimum-release-age policy (fine once they age past it).
