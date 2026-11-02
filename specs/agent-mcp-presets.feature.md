# MCP presets catalogue — acceptance

Phase 8 Task 10 (Decision 9; SL-066 / SL-085). Values and pure functions:
`agent-mcp-presets.spec.ts`. The servers themselves: `agent-mcp.feature.md` (unchanged). Each
scenario names the test that checks it.

## Decisions
- **Presets are data, and only fill the form.** A preset is a row in `MCP_PRESETS`: id, name,
  category, a one-line description in frost's words, the transport, the URL (or a command and its
  arguments), the environment variable names it needs, how the token is obtained, and the vendor's
  setup page. Nothing in the catalogue is contacted: not at startup, not when the catalogue is shown
  or a preset chosen, not in tests. There is no hosted catalogue and no logo (clean-room).
- **A preset holds no secret.** It has no token and no environment value, and pre-fills neither.
  The form starts from `presetDraft(preset)`; the user presses "Add server" (nothing is saved
  before), pastes the token afterwards into the saved server's write-only token field (keychain),
  and presses Start.
- **A server from a preset is a server like any other.** Saved stopped and off, labelled
  "Untrusted", every tool call asks, never grantable; a command server starts only through main's
  native dialog, every time (`agent-mcp.feature.md`).
- **Verified, and only what frost's client can use.** Each preset was checked on 2026-10-30 against
  the vendor's own documentation (the table in the spec's header): Streamable HTTP, an `https:`
  URL on a public host, and an `Authorization: Bearer` token path that needs no OAuth. Candidates
  that sign in with OAuth only, need another header, could not be verified, or whose terms don't
  clearly allow a third-party client like frost's (`terms`: Ahrefs) are listed in
  `MCP_DEFERRED_PRESETS` with the reason.
- **Chips only for categories with a preset.** A category every candidate of which is deferred
  (SEO data, for now) stays a valid category for the deferred list but shows no chip
  (`mcpPresetCategoriesInUse`).
- **Command presets are deferred** until Open question 10 shows a pinned `npx -y pkg@x.y.z` starting
  under frost's command-server rules on macOS, Linux and Windows. The rules for one stay checked:
  an exact top-level version (no range, tag, URL or integrity form), and a description that says
  its own dependencies are not pinned.
- **Setup guides open in the system browser** through the app window's existing open handler
  (`target="_blank"` link; scheme allowlist and the click's gesture, `resolveExternalOpen`).

## Catalogue data (`apps/desktop/src/main/agent/__tests__/mcp-presets.test.ts`)
- **Scenario: mcp-presets-valid** — every preset passes `mcpPresetProblems` (only the allowed
  fields; id, name, category, words); every `url` passes `parseMcpServerUrl` unchanged and has no
  query; every command `isMcpCommand`, every argument `isMcpArg`, every environment name
  `isMcpEnvName` (not reserved); every `docsUrl` is allowed by main's `resolveExternalOpen` on a
  gesture (and refused without one); every category has a label, and every chip category holds a
  shipped preset; the deferred list names a reason for each candidate (Ahrefs: `terms`) and none
  of them is also a preset.
- **Scenario: mcp-presets-pin-versions** — a command preset's package argument is `name@x.y.z` or
  `@scope/name@x.y.z`; no version, a range, a tag such as `@latest`, a URL, a path, a git or `file:`
  spec and an integrity form are refused.
- **Scenario: mcp-presets-hold-no-secret** — no preset has a token or value field, no text looks
  like a credential, no URL carries a query or user name, and `presetDraft` gives no token and no
  environment value (names only).
- **Scenario: mcp-command-presets-say-dependencies-unpinned** — a command preset whose description
  lacks `MCP_PRESET_UNPINNED_SENTENCE` is refused; every shipped command preset has it.
- **Scenario: mcp-preset-draft-saves-through-the-normal-path** — each preset's draft passes
  `AgentSaveMcpServerInputSchema` (the router's input); main saves it stopped, off and with no
  token, contacting nothing; the token is set through `setToken` like a typed server's; the request
  frost sends after Start carries it as `Bearer`; a command-shaped draft still waits for main's
  start dialog, with the exact command line.
- **Scenario: mcp-presets-unique-ids-and-names** — ids and names are unique, and differ from every
  deferred candidate's name.
- **Scenario: mcp-presets-filter** — `filterPresets` matches every word of the query in the name,
  description, category label or id (case and width folded), within one category or all; a
  category with no shipped preset keeps nothing.

## Settings (`apps/desktop/src/renderer/__tests__/agent-mcp.test.ts`)
- **Scenario: mcp-catalogue-search-and-categories** — "Add from catalogue" opens the sheet: a
  search field, an "All" chip and one chip per category that holds a shipped preset, and one row
  per preset with its category,
  description, token hint and a "Setup guide" link (`href` the preset's `docsUrl`,
  `target="_blank"`, `rel="noreferrer"`); typing narrows the rows, a chip keeps one category, and no
  match says so.
- **Scenario: mcp-preset-fills-the-form** — choosing a preset closes the sheet and fills the add
  form (name, kind, address; or command, arguments, network, variable names with empty values);
  nothing is saved and no token is set until the user presses "Add server", which sends
  `presetDraft(preset)` exactly; the form says the server is untrusted and shows the token hint.
  Editing the address or the command, or switching the kind, clears that note (the form is no
  longer the preset's).

## End to end (`apps/desktop/e2e/agent.e2e.ts`, Phase 8 Task 11)
- **Scenario: agent-mcp-preset-fills-form** — choose an HTTP preset: the form is filled, the
  server is saved stopped and untrusted. Nothing is contacted: the test records every request on
  main's `agent-mcp` session (`AGENT_MCP_PARTITION`) through `session.webRequest.onBeforeRequest`,
  set with `app.evaluate` before the preset is chosen, and asserts the log is empty.
