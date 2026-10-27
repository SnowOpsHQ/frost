# Feature: Command palette

Spec: `specs/command-palette.spec.ts` (`COMMAND_PALETTE_SHORTCUT`, `PALETTE_RETURN_FOCUS`,
`PALETTE_SHEET_HEIGHT`, `PALETTE_GROUPS`, the recent list, `COPY_VALUE_KEYS`, `OPEN_IN_TEMPLATES`,
`SITE_FILES`, the registration API), `specs/command-palette.schema.ts` (`SeoCopyValueInputSchema`,
`PageCommandInputSchema`), `specs/tabs.spec.ts` (`RESERVED_TAB_SHORTCUTS['command-palette']`) and
`specs/browser.spec.ts` (`BrowserState.commandPalette`). Phase 2.5 Task 4. Each line maps to one
named test.

## Decisions
- **Opening is main's.** Mod+K is a reserved tab shortcut: every tab's and the chrome's
  `before-input-event` takes it before the page sees it and consumes it, and View › Command
  Palette… has it as its accelerator (the menu item for the mouse). Main records where focus was
  (`page` if the active tab's page had it, else `chrome`), focuses the chrome and bumps
  `commandPalette.seq`; the chrome opens the palette (or closes it, if it is open). While the active
  tab is in HTML fullscreen nothing opens (its view covers the window; Esc leaves fullscreen first).
- **Not covered by the page: the palette takes a band of the page area.** A tab's view is a native
  `WebContentsView` drawn above the chrome's DOM, so an overlay in the DOM would be hidden behind
  the page. Rejected: hiding the view (the page the commands are about disappears), a second view
  for the palette (another `app://` WebContents and IPC sender to secure), and a captured image of
  the page behind a dimmed overlay (moves page pixels into the chrome and needs `img-src blob:`).
  Chosen: while open, the palette is a sheet `PALETTE_SHEET_HEIGHT` px high at the top of the page
  column (at least `PALETTE_PAGE_MIN_VISIBLE` px of the page stays in view in a short window), and
  the page area below shrinks. The chrome reports the smaller area through the existing
  `browser.setPageBounds`, exactly as the SEO sidebar does sideways, so main lays the view out
  below the sheet and no part of the view can ever overlap it. The sheet's height does not change
  while typing, so the page is resized once on open and once on close (it sees an ordinary
  viewport resize, as when the sidebar toggles).
- **One action registry.** Every action has an id, a label, a group, keywords, an availability
  predicate (from the active tab, the browser state, the shown audit and the sidebar) and a
  handler that calls existing tRPC procedures or chrome-side commands. Other features register
  their own actions with one call (`registerPaletteActions`, see `command-palette.spec.ts`); the
  built-ins are registered the same way. Unavailable actions are not listed.
- **Search is frost's own fuzzy matcher**: case- and accent-insensitive; every word of the query
  must match the label or a keyword, as a prefix, a substring or a subsequence (consecutive and
  word-start characters score higher, gaps and long labels lower); a word that matches the label
  always outranks one that matches only a keyword (label scores sit in a band above every keyword
  score); the matched characters are highlighted. Recent actions come first with an empty query
  and get a small boost with one. Recents live in the chrome's `localStorage`, capped.
- **Copies are written by main from the shown audit.** `seo.copyValue({ tabId, audit, key })`
  (`enforceSender` first, Zod, `key` from `COPY_VALUE_KEYS`) writes the value main's ready audit
  holds, only if it is the audit the chrome shows; JSON-LD blocks use the Schema panel's
  `seo.copySchemaJson`. A copy action is offered only when its value exists, and its row previews
  the value as inert text.
- **"Open in" is a fixed `https:` table** (`OPEN_IN_TEMPLATES`): fixed origin and path, the page
  URL (without credentials or fragment) only as one URL-encoded query value. Main builds and opens
  it (`browser.openTool({ tool })`): from the table and the active tab's own URL, refusing a page
  whose main-frame response came from a non-public IP address (the webRequest `ip` the response
  recorder keeps), since a public-looking name can resolve to a LAN host. Offered only for public
  host names (`isPublicHost`, `open-in.spec.ts`). Each row's label ends with the destination host
  (matched, highlighted, read out); the first use of each host asks once, as an inline palette step,
  and the answer is kept in the chrome's `localStorage` (a preference: Clear Browsing Data leaves
  it); a page URL with a query string says the query is sent too. The site's own robots.txt and
  sitemap.xml (`SITE_FILES`) are opened on the active tab's own origin
  (`browser.openBackgroundTab`).
- **The selection follows the action, not the row.** The active option is kept as an action id and
  found again in each new list (a page can change the list under it: `pushState` toggles "Go
  back"); only when that action is gone does the first row become active. Enter runs exactly the
  action shown selected.
- **It never opens invisible or under the page.** In a page column shorter than
  `PALETTE_SHEET_MIN_HEIGHT` it does not open (the status line says why); when the active tab enters
  HTML fullscreen while it is open, it closes without restoring focus to the hidden chrome. A held
  Mod+K toggles once (auto-repeat ignored).
- **Commands the chrome could not reach before** get small procedures: `browser.pageCommand`
  (zoom in / out / reset, hard reload … exactly as the menu runs them), `browser.focusPage`
  (returns focus to the page) and `browser.clearBrowsingData` (the menu's Clear Browsing Data…,
  which still asks first in main's own dialog). All `enforceSender` first.
- **Keyboard.** ARIA combobox (the search box) controlling a listbox (`aria-activedescendant`), in a
  labelled dialog. ↑/↓ and Tab/Shift+Tab move (wrapping), PageUp/PageDown jump, Enter runs, Esc
  closes; focus stays in the search box. Closing (Esc, Mod+K again, a click outside) puts focus back
  where it was; commands that move focus themselves (new tab, close tab, a panel jump) keep theirs.
- **No network.** The palette makes no requests: no web suggestions, no remote icons
  (`PALETTE_WEB_SUGGESTIONS = false`). Icons are frost's own inline SVG; styling is `styles.css`.

## Shortcut and controller (`apps/desktop/src/main/browser/__tests__/command-palette.test.ts`, fakes)
- **Scenario: shortcut-matcher-follows-spec** (`shortcuts.test.ts`) — Mod+K maps to
  `command-palette` on every platform, like every `RESERVED_TAB_SHORTCUTS` entry.
- **Scenario: palette-shortcut-is-reserved** — Mod+K from the chrome's and a tab's
  `before-input-event` is consumed (key-down and key-up), bumps `commandPalette.seq` once per press,
  focuses the chrome, and records `returnFocus`: `page` when the tab's page had focus, else `chrome`.
- **Scenario: palette-shortcut-ignores-auto-repeat** — an auto-repeated Mod+K key-down
  (`isAutoRepeat`) is consumed and changes nothing.
- **Scenario: open-tool-builds-from-the-table-and-the-active-tab** — `openTool(id)` opens
  `openInUrl(template, active tab URL)` in a background tab right of the active one and answers its
  id; no web page → `no-page`; a non-public name → `not-public`; the tab limit → `not-opened`.
- **Scenario: open-tool-refuses-private-addresses** — when the document's recorded response address
  is private, loopback, link-local or otherwise not public → `private-address` and no tab opens; a
  public or unrecorded address opens.
- **Scenario: response-recorder-keeps-the-address** (`command-palette.test.ts`) — the committed
  response keeps its webRequest `ip`, kept across in-page navigations, dropped with a new document
  without one, a forgotten tab or Clear Browsing Data.
- **Scenario: palette-not-opened-in-fullscreen** — while the active tab is in HTML fullscreen the key
  is still consumed, and `seq` does not change.
- **Scenario: palette-menu-item** (`menu.test.ts`) — View › Command Palette… (`COMMAND_PALETTE_MENU_ID`)
  has the `CmdOrCtrl+K` accelerator and opens the palette.
- **Scenario: focus-page-focuses-the-shown-page** — `focusPage` focuses the active tab's page when it
  shows one and answers `true`; an empty tab, an error panel or no window answer `false`.
- **Scenario: page-command-and-clear-data-run-like-the-menu** — `runPageCommand` zooms the active
  tab like the menu; `clearBrowsingData` calls the injected action (the confirming one), and is a
  no-op without it.
- **Scenario: copy-value-only-from-the-shown-audit** — `seo.copyValue` writes `copyValueOf(audit,
  key)` of the tab's ready audit through main's clipboard; nothing for another audit (URL or
  `takenAt`), a pending one, an unknown tab or a key without a value.

## Copy values (`packages/seo-core/src/__tests__/copy-values.test.ts`)
- **Scenario: copy-value-of-each-key** — each `COPY_VALUE_KEYS` key reads its documented value.
- **Scenario: copy-value-missing-is-null** — no title, no description, no H1 (or an empty one), no
  robots meta, no recorded status: `null`; the HTTP `Link` canonical when the HTML has none.

## Router (`packages/ipc-contract/src/__tests__/palette-router.test.ts`)
- **Scenario: palette-procedures-reject-foreign-sender-first** — `seo.copyValue`,
  `browser.pageCommand`, `browser.focusPage` and `browser.clearBrowsingData` reject a foreign sender
  before reading input, and call nothing.
- **Scenario: copy-value-validates-input** — a key outside `COPY_VALUE_KEYS`, a missing or malformed
  audit, extra fields, or a text to copy are `BAD_REQUEST`, and call nothing.
- **Scenario: page-command-validates-input** — only `PAGE_COMMANDS`, no extra fields.
- **Scenario: open-tool-validates-input** — only `OPEN_IN_TEMPLATES` ids; a URL, an extra field or a
  site file id is `BAD_REQUEST`; it calls `openTool` and answers its result.
- **Scenario: palette-procedures-call-service** — each calls its service method and answers what it
  answers (`null` for the commands without an answer).

## Registry, matcher and recents (`apps/desktop/src/renderer/palette/__tests__/*.test.ts`)
- **Scenario: registry-registers-and-unregisters** — `register` lists the actions in registration
  order; the function it answers removes exactly them.
- **Scenario: registry-rejects-bad-or-duplicate-ids** — an id that breaks
  `PALETTE_ACTION_ID_PATTERN`, is too long, or is already registered, an unknown group or an empty
  label throws at registration; a dynamic source's bad or duplicate ids are dropped.
- **Scenario: registry-resolves-dynamic-sources** — a function source is asked with the context
  each time.
- **Scenario: availability-filters-and-never-throws** — unavailable actions are left out; a predicate
  or source that throws leaves out only its own actions.
- **Scenario: matcher-prefers-prefix-and-word-starts** — prefix > word-start > substring >
  subsequence; shorter labels win ties.
- **Scenario: matcher-subsequence-and-indices** — a scattered query matches as a subsequence and
  reports the label characters it matched.
- **Scenario: matcher-all-words-must-match** — every word must match the label or a keyword.
- **Scenario: matcher-uses-keywords-below-labels** — a keyword match ranks below a label match and
  highlights nothing.
- **Scenario: matcher-label-always-beats-keyword** — the weakest label match (a scattered
  subsequence in a long label) outranks the strongest keyword match (an exact keyword).
- **Scenario: selection-follows-the-action-id** (`keys.test.ts`) — the active index is the active
  id's place in the new list; an id that is gone (or none) gives the first row; an empty list none.
- **Scenario: matcher-folds-case-and-accents** — `ZOOM`, `zóom` and `zoom` match alike.
- **Scenario: matcher-is-bounded** — a query over `PALETTE_QUERY_MAX_CHARS` is cut; a long label
  scores without blowing up.
- **Scenario: ranking-recents-first-on-empty-query** — with no query, the available recents come
  first (most recent first), then every group in `PALETTE_GROUPS` order.
- **Scenario: ranking-recent-boost** — with a query a recent action gets `PALETTE_RECENT_BOOST`, but a
  clearly better match still ranks first.
- **Scenario: recents-parse-defensively** — malformed JSON, non-arrays, non-strings, bad ids,
  duplicates and entries past `PALETTE_RECENT_MAX` are dropped.
- **Scenario: recents-push-dedupes-and-caps** — running an action moves it to the front, capped.

## Open in (`open-in.test.ts`)
- **Scenario: open-in-templates-are-fixed-https-origins** — every template's origin is `https:` with a
  host and nothing else, its path absolute, and no template text has a placeholder.
- **Scenario: open-in-url-only-in-query-encoded** — the built URL is the template's origin and path,
  its fixed params and the page URL as the one `urlParam` value, percent-encoded in the raw string
  and decoding back to the page URL.
- **Scenario: open-in-host-never-page-controlled** — hostile page URLs (`@` userinfo, `#@`, encoded
  slashes, `?url=` of their own, IDN, IPv6) never change the built URL's origin, path or keys.
- **Scenario: open-in-strips-credentials-and-fragment** — user name, password and fragment are
  removed from the page URL sent.
- **Scenario: open-in-only-for-public-hosts** — `localhost`, loopback, private and link-local
  addresses, single-label and `.local` / `.internal` / `.lan` / `.home.arpa` names, non-`http(s)`
  URLs and results over `ADDRESS_INPUT_MAX_LENGTH` give `null`.
- **Scenario: public-host-probes** — every non-public IPv4 block (`NON_PUBLIC_IPV4_BLOCKS`: its first
  and last address, and both neighbours outside it), IPv6 forms (unspecified, loopback,
  IPv4-compatible, IPv4-mapped and NAT64 of private IPv4 addresses, discard, documentation, unique
  local, link-local, site-local, multicast) and name suffixes (`NON_PUBLIC_NAME_SUFFIXES`) are not
  public; public neighbours are. `isPublicAddress` reads Chromium's `ip` text, bracketed or not.
- **Scenario: open-in-rejects-malformed-templates** — a template whose path or origin would put the
  URL on another host, scheme or path builds nothing.
- **Scenario: open-in-label-names-the-host** — `openInLabel` is the description, ` — ` and the host;
  `sendsQuery` is true exactly when the URL sent has a query string.
- **Scenario: consent-remembers-hosts** (`consent.test.ts`) — granted hosts are kept (deduplicated,
  capped at `OPEN_IN_CONSENT_MAX`, malformed storage ignored, storage errors swallowed).
- **Scenario: sheet-sizes-match-styles** (`apps/desktop/src/__tests__/palette-styles.test.ts`) —
  `styles.css` declares `PALETTE_SHEET_HEIGHT`, `PALETTE_PAGE_MIN_VISIBLE` and
  `PALETTE_SHEET_MIN_HEIGHT`, and the sheet's height is built from them.
- **Scenario: palette-fits-and-closes-for-fullscreen** (`layout.test.ts`) — `paletteFits` is false
  below `PALETTE_SHEET_MIN_HEIGHT`; `closesForFullscreen` is true for a tab in either fullscreen phase.
- **Scenario: site-files-use-the-page-origin** — robots.txt and sitemap.xml are built on the page's
  own origin (scheme and port kept), never another host.

## Built-in actions (`builtins.test.ts`)
- **Scenario: builtins-cover-the-plan** — a jump per `SEO_PANELS` panel (but `FEATURE_PANEL_JUMPS`,
  whose feature registers its own), show / hide the sidebar, the
  highlight modes and off, re-audit, the accessibility check, new / close / next / previous tab,
  reload, hard reload, stop, back, forward, zoom in / out / reset, Clear Browsing Data, a copy per
  `COPY_VALUE_KEYS`, one per JSON-LD block, one per `OPEN_IN_TEMPLATES` and `SITE_FILES` entry.
- **Scenario: availability-follows-state** — back / forward follow `canGoBack` / `canGoForward`;
  stop only while loading; zoom reset only off 100 %; next / previous only with two tabs; page and
  audit actions only for a tab showing a web page with a ready audit; show / hide by the sidebar.
- **Scenario: copy-actions-need-a-value** — a copy action is offered only for a ready audit whose
  value exists, and previews it (cut to `PALETTE_DETAIL_MAX_CHARS`).
- **Scenario: handlers-call-procedures** — each handler calls its procedure with the active tab and
  the shown audit's ref (copy), the built URL (open in), the command (page), and answers a status line.
- **Scenario: open-in-asks-once-per-host** — an "Open in" action for a host not yet granted has a
  confirmation step (`OPEN_IN_CONSENT_MESSAGE` with its host, `OPEN_IN_QUERY_NOTE` when the URL has a
  query); accepting it grants that host (and only it); a granted host has none.
- **Scenario: open-in-calls-main-and-reports-refusals** — the handler calls `openTool(id)`, never
  with a URL, and says `OPEN_TOOL_REFUSAL_MESSAGES[reason]` for a refusal.
- **Scenario: highlight-opens-the-owning-panel** — a highlight action opens `HIGHLIGHT_PANELS[mode]`
  first, so the chrome does not turn the overlay off again.
- **Scenario: palette-keys** (`keys.test.ts`) — ↑/↓, Tab/Shift+Tab wrap; PageUp/PageDown jump and
  clamp; Enter runs the active option; Esc closes; other keys are the search box's.
- **Scenario: shortcut-labels-per-platform** — `Mod+Shift+R` reads `⇧⌘R` on macOS and
  `Ctrl+Shift+R` elsewhere.

## End to end (`apps/desktop/e2e/command-palette.e2e.ts`)
- **Scenario: palette-opens-with-mod-k-even-from-a-greedy-page** — Mod+K from a page that cancels
  every keydown opens the palette with the search box focused, and the page never sees the key;
  Mod+K again closes it; the menu item opens it too.
- **Scenario: palette-sits-above-the-page-view** — while open, the palette is visible, and the
  attached view's bounds start below it (never overlapping it); closing gives the view back the
  whole page area.
- **Scenario: palette-search-runs-a-panel-jump** — typing filters to the panel, Enter opens the
  sidebar on it, and the palette is gone.
- **Scenario: palette-copy-writes-main-clipboard** — "Copy title" puts the audit's title on the
  system clipboard (read in main), and a status line says so.
- **Scenario: palette-open-in-asks-first-and-opens** — on a page with a public name and no recorded
  private address (served in the test by a browse-session protocol handler), the "Open in" row names
  its host; running it asks first (with the query note for a URL with a query); Back sends nothing;
  confirming opens one background tab whose request is the expected `https:` URL (requests to the
  tool's host are cancelled in the test), the active tab staying active; the same host is not asked
  again. The site's robots.txt opens on the page's own origin.
- **Scenario: palette-open-in-refuses-a-private-page** — a public-looking name that resolved to a
  loopback address: confirming opens nothing and the status line says why.
- **Scenario: palette-selection-survives-list-changes** — with "Zoom in" selected, the page's
  `pushState` adds "Go back" above it; the selection stays on "Zoom in" and Enter zooms.
- **Scenario: palette-closes-when-the-page-goes-fullscreen** — the page enters HTML fullscreen
  while the palette is open: the palette closes and nothing in the chrome takes focus.
- **Scenario: palette-clear-browsing-data-asks-once** — with main's message box answering Cancel,
  the palette's Clear Browsing Data… asks exactly once and clears nothing (a site cookie stays);
  answering Clear clears it, and the granted "Open in" hosts are still remembered.
- **Scenario: palette-esc-closes-and-restores-focus** — Esc closes it; focus is back in the page it
  was opened from (or the address bar it was opened from).
- **Scenario: palette-makes-no-network-requests** — typing and browsing the list requests nothing:
  neither the chrome nor the site sees a request.
- **Scenario: palette-runs-a-render-profile** — a feature's registered action: "Render as Googlebot
  smartphone" sets that profile on the active tab (badge, status chip, and after a reload the page
  sees the crawler's user agent); "Reset render profile" is offered then, and restores the defaults.

## Feature actions
Features register their own actions with `registerPaletteActions` in their own renderer files:
- render profiles (`render-profile-palette.ts`, from `components/RenderProfile.tsx`;
  `render-profile.feature.md`, Command palette);
- the Content panel (`content-palette.ts`, from `components/seo/Content.tsx`;
  `seo-content.feature.md`, Command palette).
