# MCP connections (untrusted) — acceptance

Phase 5 Task 10. Values and pure functions: `agent-mcp.spec.ts`; schemas: `agent-mcp.schema.ts`;
protocol: `agent-protocol.schema.ts` (`chat.start.mcpTools`, version 6). Main:
`apps/desktop/src/main/agent/mcp/`. Each scenario names the test that checks it.

## Where it runs
MCP servers are privileged connections the user configures, so **main** owns them: it connects,
lists tools, calls them and maps their results. The agent process only sees the tool definitions
main puts in `chat.start` and the results main sends back (`tool.result`, wrapped untrusted). No
runtime message can start, add or define a server or a tool (`agent-cannot-approve`).

frost's own minimal client (`mcp/client.ts`) speaks JSON-RPC 2.0 for `initialize`,
`notifications/initialized`, `tools/list` and `tools/call` only; it declares no client capability,
answers a server's `ping` and refuses every other server request (`mcp-client-answers-ping-refuses-other-server-requests`).

## Client
- Scenario: handshake, paginated listing, JSON-RPC errors → `mcp-client-handshake-and-calls`
- Scenario: an unknown protocol revision is refused → `mcp-client-refuses-unknown-protocol-version`
- Scenario: a call past its timeout fails `timeout` and the server is told it was cancelled; a
  closed connection fails what is in flight → `mcp-client-timeout-and-close`

## HTTP servers
- Given an HTTP server's URL, Then it must be `https:` on a public host, with no user name,
  password or fragment → `mcp-http-url-https-public-only`, `mcp-procedures-bounded-inputs`
- Requests go out on main's in-memory `agent-mcp` session with `credentials: 'omit'`,
  `cache: 'no-store'` and `redirect: 'error'` (no redirect is followed, to any origin); the bearer
  token, if one is stored, is read for each request → `mcp-http-no-cookies-no-redirects-token-header`
- Before each request the host is resolved and refused if any address is private, or none
  → `mcp-http-private-address-refused`
- 401/403 → `unauthorized`; other errors → `http-status` (the status is shown); a redirect →
  `redirect`; a body that isn't JSON or an event stream → `protocol` → `mcp-http-statuses-and-redirects`
- A reply body, or an event stream, larger than `maxMessageBytes` fails `too-large`
  → `mcp-http-body-bounded`; an event stream is read until the reply arrives → `mcp-http-event-stream`

## Command servers
- A command is one program (a name on `PATH` without spaces, or an absolute path), never a shell
  string; arguments are one per line in the form, each passed as one argument
  → `mcp-command-rules`, `mcp-command-line-shown-exactly`
- It is spawned with `shell: false` (also on Windows), in its own process group on POSIX, in a
  fresh empty temporary folder, with only `PATH`, `HOME` (that folder) and the user's variables
  → `mcp-stdio-spawn-no-shell-minimal-env-cwd`, `mcp-stdio-launch-minimal-env-and-cwd`,
  `mcp-start-requires-the-dialog`, `mcp-env-minimal-and-values-from-secrets`
- The user's variables can't be `PATH`, `HOME`, `LD_*` or `DYLD_*`; their values are stored
  encrypted like the model keys (write-only) and travel in the environment, never in arguments
  → `mcp-command-rules`, `mcp-stdio-launch-minimal-env-and-cwd`
- Output lines are bounded (`too-large` ends it and stops the process group); stderr is drained and
  never shown → `mcp-stdio-lines-bounded`, `mcp-flood-ends-the-connection`
- A missing command fails `not-found` (and asks nothing) → `mcp-stdio-command-not-found-and-exit`,
  `mcp-command-not-found`

## Start
- Given a command server, When the user presses Start, Then main shows its native dialog every
  time: "Start an untrusted MCP server?", the exact command line, and the sandbox sentence; only
  "Start server" starts it (Cancel is the default) → `mcp-start-dialog-wording`, `mcp-start-requires-the-dialog`
- Nothing starts at launch or because a chat runs; a disabled server can't start
  → `mcp-start-requires-the-dialog`, `mcp-disabled-or-not-entitled-tools-absent`
- Stop ends it and removes its temporary folder → `mcp-start-requires-the-dialog`

## Sandboxes
- macOS (`/usr/bin/sandbox-exec`): a deny-by-default profile → `mcp-macos-profile-golden`
- Linux with bubblewrap: `/` read-only, empty `/tmp`, `/run` and home (the listed folders and the
  server's own folder put back), every namespace unshared (network only if allowed),
  `--die-with-parent`, `--new-session`, no capabilities → `mcp-bubblewrap-argv-golden`,
  `mcp-bubblewrap-network-and-home-command`
- Run for real on a machine with a working bubblewrap: the server can't read an unlisted file in
  the home folder, can't write outside its folder, has no network → `mcp-bubblewrap-contains-the-server`
- No launcher, or one that doesn't answer as expected: `none`, said plainly ("This server runs
  without a sandbox. It can do anything your user account can.") → `mcp-sandbox-fallback-reported-as-none`
- A launcher that fails is reported (`sandbox-failed`) and nothing else runs
  → `mcp-sandbox-launcher-failure-is-reported-not-bypassed`, `mcp-stdio-bubblewrap-status`

## Tools
- Names: `mcp__<serverId>__<tool>`, rewritten to `TOOL_NAME_PATTERN`, at most 64 per server;
  colliding names are dropped → `mcp-tool-names-sanitised`, `mcp-tool-name-collisions-dropped`
- Descriptions: cleaned, cut, prefixed "Untrusted tool from {server}: " → `mcp-description-prefixed-and-bounded`
- Input schemas reduced to a safe subset (`$ref`, combinators, `pattern`, huge enums and unknown
  keywords dropped; depth, size and node count capped) → `mcp-schema-keeps-the-safe-subset`,
  `mcp-schema-drops-refs-and-combinators`, `mcp-schema-caps-depth-and-size`,
  `mcp-schema-hostile-descriptions-and-keys`, `mcp-schema-root-is-an-object`,
  `mcp-schema-is-idempotent-and-checked`, `mcp-tools-sanitised-and-offered`

## Protocol
- `chat.start.mcpTools` carries one sanitised definition per MCP name in `allowedTools` and no
  other → `chat-start-mcp-tools-match-allowed-names`, `chat-start-mcp-tools-sanitised-and-bounded`,
  `mcp-name-without-definition-refused`
- The runtime builds them with `jsonSchema()`; `execute` is a `tool.invoke` → `mcp-tools-offered-with-their-schema`

## Chats
- A typed turn offers the tools of servers that are enabled and ready, with the `agent.mcp`
  entitlement; a skill never does → `mcp-tools-absent-for-skills-disabled-or-not-entitled`,
  `mcp-disabled-or-not-entitled-tools-absent`

## Calls
- Every call asks (`external`), is never grantable, and "Always allow" is refused
  → `mcp-asks-every-call`, `mcp-tool-asks-every-call-and-result-is-untrusted`
- Input is checked against the sanitised schema in main before the user is asked, and again before
  it is sent → `mcp-invalid-input-refused-before-asking`, `mcp-calls-validated-and-mapped`
- Only `via: 'approval'` runs → `mcp-calls-validated-and-mapped`
- Results: text parts only (others left out with a note), `isError` and JSON-RPC errors as
  `isError: true` data, wrapped untrusted and capped → `mcp-calls-validated-and-mapped`,
  `mcp-results-wrapped-and-bounded`

## Persistence and secrets
- `0033_agent_mcp_servers` stores the configuration, never a secret → `agent-mcp-migrate`,
  `agent-mcp-round-trip`, `agent-mcp-no-secret-columns`, `agent-mcp-refuse-out-of-bounds`
- Tokens are write-only; deleting a server forgets its secrets → `mcp-delete-forgets-secrets`,
  `mcp-procedures-answers-are-fixed-values`

## Router
- `agent.saveMcpServer`, `deleteMcpServer`, `setMcpServerEnabled`, `startMcpServer`,
  `stopMcpServer`, `setMcpToken`: `enforceSender` first, strict bounded inputs, answers from fixed
  sets → `agent-procedures-enforce-sender`, `agent-inputs-are-bounded`, `mcp-procedures-bounded-inputs`,
  `mcp-procedures-answers-are-fixed-values`

## Settings
- Every server says "Untrusted", its status, its sandbox sentence, its tool count and its last
  error as text; MCP tool cards carry "Untrusted"; the approval card says "Untrusted tool from
  {server}" → `mcp-settings-section`, `approval-titles-per-tool`

## End to end
- A command server configured in the settings, started (the native dialog answered in main), its
  tool called by the scripted model: the approval says "Untrusted tool from {server}", Allow once,
  the result text shows → `agent-mcp-tool-asks` (`apps/desktop/e2e/agent.e2e.ts`)
