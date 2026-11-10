# Feature: Help, keyboard shortcuts, What's New and the setup checklist

Spec: `specs/help.spec.ts` (`HELP_MENU`, `HELP_URLS`, `KEYBOARD_SHORTCUTS`, `SHORTCUTS_SHORTCUT`,
`WINDOW_SHORTCUTS`, `HELP_SHEETS`, `HELP_OPEN_RESULTS`, `HELP_PALETTE_ACTIONS`,
`WHATS_NEW_SEEN_SETTING_KEY`, `SETUP_CHECKLIST_ITEMS`, `SETUP_CHECKLIST_STORAGE_KEY`) and
`specs/whats-new.schema.ts` (`ReleaseNotesSchema`, the `help.*` procedures' schemas). Phase 11 Task 11
(SL-005, SL-117, SL-118, SL-126; plan Decisions 14–15). Each line maps to one named test.

## Decisions
- **No network.** Help opens two fixed pages of frost's repository (`HELP_URLS`: the README and a new
  issue) in the system browser, only through `resolveExternalOpen` (allowlisted `https:`, a user
  gesture: a menu click, or a click or key in the asking window for the palette), with nothing
  attached (no query string, no app or system data). What's New reads notes bundled into the main
  build; nothing is fetched. The setup checklist reads state the chrome already reads.
- **One shortcuts table.** `KEYBOARD_SHORTCUTS` is built from the features' own shortcut constants;
  only Close Window and Quit, which no feature names, are new (`WINDOW_SHORTCUTS`). The menu test
  checks it both ways, per platform.
- **Mod+/ is an accelerator only** (like `HISTORY_SHORTCUT`): not reserved in `before-input-event`,
  so a focused page's own Mod+/ (an editor's comment toggle) keeps it. No other frost shortcut,
  reserved key or chrome key handler uses it.
- **What's New after a version change.** `app_settings` keeps the version last shown
  (`WHATS_NEW_SEEN_SETTING_KEY`). A first run (nothing stored) records the running version and shows
  nothing; a run whose version differs from the stored one, and whose bundled notes list the running
  version, shows What's New once (the first chrome to ask takes it) and records the version.
- **Bundled, schema-checked notes.** `apps/desktop/release-notes.json` is imported into the main
  bundle by Vite (no file read at runtime, so a packaged build needs nothing on disk) and checked with
  `ReleaseNotesSchema` at startup (invalid notes: What's New lists nothing) and in a test. A release
  link, if any, is a page under `https://github.com/SnowOpsHQ/frost/` with no query or fragment; the
  chrome asks for it by version, never by URL.
- **Help's own router.** `help.*` lives in `packages/ipc-contract/src/help-router.ts` (every
  procedure `enforceSender` first, inputs and answers schema-checked), registered with one line.
- **Easy to append.** `HELP_MENU.items` is a list with groups; Task 12 appends Export Diagnostics….

## Menu (`apps/desktop/src/main/__tests__/menu.test.ts`)
- **Scenario: help-menu-items** — on every platform the last top-level menu is Help (`role: 'help'`)
  with `HELP_MENU.items` in order and a separator between groups; Keyboard Shortcuts has
  `CmdOrCtrl+/`; each item's click calls its command (shortcuts / What's New in the window the menu
  acted on; a link with its `HelpLink`).
- **Scenario: every-menu-accelerator-is-listed** — every accelerator the template sets (hidden
  alternates included), read in spec notation, is a key of `KEYBOARD_SHORTCUTS` on that platform.
- **Scenario: every-listed-shortcut-exists** — every key `KEYBOARD_SHORTCUTS` lists for a platform is
  an accelerator of that platform's template (macOS Quit: the app menu role's own Cmd+Q), and no two
  listed shortcuts share a key.

## Links (`apps/desktop/src/main/help/__tests__/help-links.test.ts`)
- **Scenario: help-links-go-through-resolve-external-open** — each `HELP_URLS` page is allowlisted
  by `resolveExternalOpen` with a gesture and refused without; `openLink` with a gesture opens exactly
  that URL (`shell.openExternal`), without one opens nothing and answers `needs-gesture`; a release
  link opens only a bundled release's checked page, else `unavailable`; a link the policy refuses is
  never opened; the asking window's gesture is spent only once the request names a page to open.

## Release notes (`apps/desktop/src/main/help/__tests__/release-notes.test.ts`)
- **Scenario: release-notes-valid-and-current-version-present** — the bundled notes pass
  `ReleaseNotesSchema` and list `apps/desktop/package.json`'s version; the schema refuses a link off
  frost's repository, a query string, an item over 200 characters, more than 10 items, 51 releases and
  a repeated version.
- **Scenario: release-notes-bundled-not-read-from-disk** — `main/help` imports the JSON statically and
  never reads a file (no `fs`, `readFile` or path to the notes at runtime).
- **Scenario: whats-new-once-after-version-change** — first run: records the version, shows nothing;
  same version: nothing; another stored version: shows once, then records the running one; a version
  with no notes: nothing; a failed read: nothing; a stored value that is not a version (read as `''`)
  counts as another version: shown once, the running version recorded; a running version that is not
  a version (`app.getVersion()`) turns What's New off: nothing read, stored or shown, and
  `currentVersion` is `null`.

## Router (`packages/ipc-contract/src/__tests__/help-router.test.ts`)
- **Scenario: help-router-enforces-sender** — every `help.*` procedure refuses a non-app sender
  before its service is called; without the service it fails closed.
- **Scenario: help-router-validates** — `openLink` takes only `help`, `issue` or `release` with a
  version (never a URL); `watch` takes `sinceSeq`; the sender's window is passed to `watch` and
  `openLink`; answers are schema-checked (a service answer outside the schema is refused).

## Chrome
- **Scenario: whats-new-shown-once-across-remounts** (`renderer/__tests__/whats-new-view.test.ts`) —
  `help.takeWhatsNew` is asked once per chrome (a module-level promise), even when the sheet mounts,
  unmounts and mounts again (StrictMode); a `true` answer shows What's New once, after the active tab
  stopped loading (a restored tab's new document never closes it before it was seen); a later new
  document closes it like the other sheets; a later mount does not show it again.
- **Help sheets, one at a time** (e2e `help-shortcuts-sheet`) — opening a Help sheet closes Settings
  (unless a sign-in waits for its confirmation there: the Help sheet then stays shut), Projects, the
  screenshot editor and History; any of those opening closes it; another tab or a new document in
  this one closes it.
- **The screenshot editor is one of the sheets** (whole-branch review; `screenshot-editor-one-sheet-at-a-time`
  in `renderer/__tests__/screenshot-editor-sheets.test.ts` and `e2e/screenshots.e2e.ts`) — opening it
  closes Settings (unless a sign-in waits there: the editor then stays shut), Projects, History and
  the Help sheets; any of those opening closes it. Projects tells the others on every open request,
  the first one after start included (`onProjectsOpened`; `projects-open-requests-are-told-from-the-first`).
- **Scenario: setup-checklist-done-states** (`renderer/__tests__/start-view.test.ts`) — the new-tab page
  lists `SETUP_CHECKLIST_ITEMS`; agent ready, Search Console connected, a project besides Unfiled, and
  the stored privacy / shortcuts marks show as done; each item's button opens where it is done.
- **Scenario: setup-checklist-dismiss** (`start-view.test.ts`) — Hide this checklist stores
  `dismissed` and the checklist is gone on every later new tab; when every item is done it is gone too.
- **Scenario: setup-checklist-storage-tolerant** (`start-view.test.ts`) — a missing, malformed or
  unreachable `SETUP_CHECKLIST_STORAGE_KEY` reads as nothing done and not dismissed.

## End to end (`apps/desktop/e2e/browser-polish.e2e.ts`)
- **Scenario: help-shortcuts-sheet** — Help › Keyboard Shortcuts opens the sheet listing every group;
  Esc closes it; the palette's "Keyboard shortcuts" opens it too; History, Settings and a page load
  close it, and it closes History and Settings; Help › frost Help and Report an Issue hand exactly
  `HELP_URLS.help` / `HELP_URLS.issue` to a stubbed `shell.openExternal`.
- **Scenario: whats-new-after-version-change** — a first launch shows no What's New; after the
  stored version is changed, the next launch shows it with the running version's notes; closed, the
  launch after shows nothing.
- **Scenario: setup-checklist** — a fresh profile's new tab lists the five items, none done; Show
  shortcuts opens the shortcuts sheet and marks that item done; Hide this checklist removes it from
  later new tabs.
