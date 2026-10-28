# Feature: Approval broker and standing grants (main)

Spec: `specs/agent-approvals.spec.ts` (`decide`, `grantOriginFor`, `approvalOriginFor`,
`isGrantOrigin`, `canGrant`, `isTabBound`, `APPROVAL_TIMEOUT_MS`, `APPROVAL_DECISIONS`,
`TOOL_ACTIVITY_STATUSES`, `TOOL_ERROR_MESSAGES`, `APPROVAL_DISPLAY_MAX_CHARS`, `MAX_AGENT_GRANTS`,
`AGENT_GRANT_TABLES`, `READ_TOOLS_PREFERENCE_KEY`), `specs/agent-tools.spec.ts` (`AGENT_TOOLS`,
`toolRisk`, `isGrantable`, `isMcpToolName`, `TOOL_ERROR_CODES`, `TOOL_RESULT_MAX_CHARS`),
`specs/agent-protocol.schema.ts` (`tool.invoke`, `tool.result`, `ToolResultSchema`,
`UntrustedOutputSchema`). Phase 5 Task 4 (`docs/plans/phase-5-ai-agent.md`, decisions 7 and 9; threat
model rows "prompt injection", "The agent process approves its own call", "A stale approval is
replayed", "A standing grant outlives the user's intent").
Code: `apps/desktop/src/main/agent/` (`approvals.ts`, `grants.ts`, `tool-output.ts`, `index.ts`),
`packages/db/src/agent-grants*.ts`. Tests: `apps/desktop/src/main/agent/__tests__/`
(`approvals-policy.test.ts`, `approvals.test.ts`, `agent-cannot-approve.test.ts`,
`approvals-end-to-end.test.ts`, `grants.test.ts`, `tool-output.test.ts`) and `packages/db/src/__tests__/agent-grants.test.ts`. Each line maps to one
named test.

## Decisions
- **Main decides; only main answers.** The broker hears the runtime only through the host's
  `onToolInvoke` and answers only with `tool.result`. `answer(approvalId, decision)` is called by
  main's code alone (the panel's sender-guarded IPC, Task 6); no runtime message reaches it or the
  grants. Approval ids are random (`crypto.randomUUID`), so the runtime can't name one, and nothing
  would read it if it did.
- **A call is checked before the policy sees it.** The chat must be registered for a running turn
  (`register(chatId, { tabId, allowedTools })`), the tool in that turn's `allowedTools`, the call id
  new in the turn (a repeat is dropped unanswered, as a strike: answering it would race the first
  call's answer), the agent entitled (`agent`; `agent.mcp` too for MCP tools), and the input must
  match the tool's own strict schema from `@app/ai-skills`, re-parsed in main (MCP tools: bounded
  JSON until Task 10 brings each server's schema). The re-parsed input written out
  (`JSON.stringify`) is the call's canonical input: what the user sees, what is hashed and what runs.
- **Policy by risk class** (`decide`): `read` runs unless the user turned read tools off (then it
  asks); `act` runs only under a standing grant for (tool, origin) on a public origin, else asks;
  `execute` and `external` ask every call and are never grantable.
- **Origins.** A navigate grant is keyed to the destination's origin, a click grant to the origin of
  the page the chat's tab shows. A grant exists only for an `act` tool on a canonical public
  `http(s)` origin (`isGrantOrigin`: not localhost, a private or loopback literal, a single label or
  a reserved name); anything else always asks and never offers "allow always".
- **An approval is single-use and bound.** It names the chat, call id, tool, risk, origin, canonical
  input and its SHA-256, and expires after `APPROVAL_TIMEOUT_MS` or when the chat's turn ends
  (`unregister` on Stop, or the turn's `chat.finish` / `chat.error` from the host, which the host
  also sends when the runtime dies). It is taken out of the pending set before anything is awaited, so a second
  answer finds nothing. An approved call on the page (`PAGE_TOOLS`: click, execute_javascript, the
  page reads) runs only if the tab still shows the approved origin; otherwise it ends `expired`.
- **Output is untrusted data.** Every result is `{ untrusted: true, source, data }`, `data` capped at
  `TOOL_RESULT_MAX_CHARS` of JSON text (over it: `{ truncated, originalChars, json }` with the text
  cut), checked with `ToolResultSchema`. Errors carry only `TOOL_ERROR_MESSAGES`.
- **Grants are cached in main and written at once.** Revoking (one or all) and turning read tools off
  take effect before the write; a grant and read tools on only after it. Until the grants are loaded
  nothing is granted and read tools ask.

## Scenarios: policy (`approvals-policy.test.ts`)
- `policy-read-runs`: a read tool runs; with read tools off it asks.
- `policy-act-needs-grant`: an act tool runs only with a grant on a public origin.
- `policy-execute-and-external-always-ask`: `execute` and `external` ask whatever the context says.
- `grant-origin-navigate-destination`: navigate's grant origin is the destination's, not the tab's.
- `grant-origin-click-tab`: click's grant origin is the tab page's; other tools have none.
- `grant-origins-public-only`: `isGrantOrigin` and `canGrant` refuse private, loopback, non-canonical
  and non-`http(s)` origins and every tool but navigate and click.

## Scenarios: broker (`approvals.test.ts`)
- `read-tool-runs`: page_text runs at once and its output goes back wrapped untrusted.
- `read-tools-off-asks`: with read tools off, page_text asks; allow-always isn't offered.
- `act-asks-without-grant`: navigate with no grant asks; the request names the destination origin.
- `allow-once-runs-stored-input`: Allow once runs the stored canonical input, once; no grant is made.
- `allow-always-grants-this-origin-only`: Allow always stores (navigate, origin); the next navigate to
  that origin runs, one to another origin asks.
- `navigate-grant-keyed-to-destination`: a navigate grant for example.com, with the tab on
  example.com, doesn't let navigation to another site run.
- `click-grant-keyed-to-tab-origin`: a click grant covers clicks on the granted site's pages only.
- `private-origin-never-granted`: navigate to localhost or a private IP asks, offers no
  allow-always, refuses it, and a grant planted for it isn't used.
- `execute-asks-every-call`: execute_javascript asks each call, shows the exact code, refuses
  allow-always and still asks after it.
- `mcp-asks-every-call`: an MCP tool asks each call, refuses allow-always, is labelled untrusted.
- `deny-answers-denied`: Deny answers `denied`; nothing runs.
- `replay-refused`: a second answer of the same approval is `unknown`; the tool ran once.
- `timeout-expires`: an unanswered approval ends `expired` after `APPROVAL_TIMEOUT_MS`.
- `unregister-expires-and-aborts`: Stop (unregister) expires pending approvals and aborts running
  tools; a late result is never sent; answering afterwards is `unknown`.
- `turn-end-expires`: the turn's `chat.finish` or `chat.error` expires its approvals and aborts its
  tools, as `unregister` does; another chat's end changes nothing; a new turn starts clean.
- `input-reparsed-in-main`: extra fields, wrong types and over-long values are `invalid-input`; the
  runner never sees them; the canonical input is the schema's output.
- `call-refused-before-policy`: an unregistered chat, a tool not allowed in the turn, or a turn
  with the agent not entitled is `not-allowed`.
- `duplicate-call-id-dropped`: a repeated call id is dropped unanswered (a strike) and can't change
  or answer the first call.
- `click-origin-rechecked`: an approved click whose tab moved to another origin ends `expired`.
- `runner-errors-fixed-messages`: a runner's error code or throw becomes a fixed message; unknown
  codes are `failed`; the default runner answers `unavailable`.
- `pending-view`: the request view's fields, its truncated display input and `onChange`.
- `injection-cannot-escalate`: page text telling the model to click leads to an approval request,
  not a click.

## Scenarios: the runtime can't approve (`agent-cannot-approve.test.ts`)
- `agent-cannot-approve`: through the real host, the runtime sends every runtime → main type and
  made-up approval, grant and settings messages carrying the real approval id; nothing is approved,
  run or granted, and the request stays pending.

## Scenarios: end to end (`approvals-end-to-end.test.ts`)
- `injection-cannot-escalate-end-to-end`: with the real runtime, host and model proxy and a scripted
  model, page text telling the model to click is handed to the model wrapped untrusted; the click it
  then asks for waits for the user (a navigate grant on the site doesn't cover it); Deny reaches the
  model as `denied`, and nothing was clicked.

## Scenarios: output (`tool-output.test.ts`)
- `output-wrapped-and-capped`: output is wrapped untrusted; data over the cap is replaced by its cut
  JSON text and a flag, within the cap, never splitting a surrogate pair; non-JSON data is refused.

## Scenarios: grants (`grants.test.ts`, `packages/db` `agent-grants.test.ts`)
- `grants-before-load-restrictive`: before `load()`, nothing is granted and read tools ask.
- `grants-add-revoke`: add, has, list, revoke and revokeAll; changes notify listeners.
- `grants-refuse-ungrantable`: no grant for read, execute or MCP tools or a private origin.
- `grants-restrictive-first`: revoking and read tools off hold before the write; a failed write
  for a grant grants nothing.
- `grants-db-round-trip`: grants and the read-tools setting persist through `@app/db`.
- `agent-grants-migrate`: `0030_agent_grants` creates `AGENT_GRANT_TABLES` matching the schema.
- `agent-grants-round-trip`, `agent-grants-refuse-ungrantable`, `agent-grants-capped`,
  `read-tools-preference-round-trip`, `agent-grants-in-store`: the repository.
