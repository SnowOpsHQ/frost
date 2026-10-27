# Feature: page commands and the page context menu

Spec: `specs/page-commands.spec.ts` (`PAGE_COMMANDS`, `RESERVED_PAGE_SHORTCUTS`,
`UNRESERVED_PAGE_SHORTCUTS`, `ZOOM_FACTORS`, `DEFAULT_ZOOM`, `CONTEXT_MENU_LABELS`,
`CONTEXT_MENU_SEARCH_LABEL`, `CONTEXT_MENU_SELECTION_MAX`; Zod-free) and `specs/browser.spec.ts`
(`TabStateSchema.zoom`, `SEARCH_URL_TEMPLATE`, `ADDRESS_INPUT_MAX_LENGTH`). Builds on
`tabs.feature.md` (reserved shortcuts, the application menu) and `browser-chrome.feature.md`.
Phase 1 usable-browser gaps. Each scenario maps to one named test.

## Behaviour
- **Commands** act on the active tab, from the application menu or a shortcut: Reload, Hard Reload
  (`reloadIgnoringCache`), Stop, Back, Forward, Zoom In, Zoom Out, Actual Size. With no page
  (an empty tab) they do nothing; with no window they do nothing. A crashed or errored tab reloads
  as the panels' Reload / Try again do (`browse-guard.feature.md`).
- **Shortcuts.** `RESERVED_PAGE_SHORTCUTS` are taken in `before-input-event` from every tab's and
  the chrome's WebContents and consumed, exactly like the tab shortcuts; they are also the menu's
  accelerators. `UNRESERVED_PAGE_SHORTCUTS` are not taken: Cmd+Left / Cmd+Right (macOS) are hidden
  menu accelerators, so a text field in the page keeps them; Esc stops a loading, non-fullscreen
  tab from its `before-input-event` without consuming the key. In HTML fullscreen Esc only leaves
  fullscreen (and never stops the load).
- **Application menu.** A **View** menu: Reload (`CmdOrCtrl+R`, F5 hidden), Hard Reload
  (`CmdOrCtrl+Shift+R`), Stop (shows Esc, not registered as an accelerator), Zoom In
  (`CmdOrCtrl+=`; `CmdOrCtrl+Plus` and the keypad hidden), Zoom Out (`CmdOrCtrl+-`), Actual Size
  (`CmdOrCtrl+0`). A **History** menu: Back and Forward (`Cmd+[` / `Cmd+]` on macOS, with hidden
  `Cmd+Left` / `Cmd+Right`; `Alt+Left` / `Alt+Right` elsewhere). None of them reloads, zooms or
  inspects the chrome page itself.
- **Zoom** steps through `ZOOM_FACTORS` (from the factor the tab has now: the next one up or down),
  clamped at 25 % and 500 %; Actual Size is `DEFAULT_ZOOM`. It is per host (Chromium's host zoom
  map): every open tab on the host follows, and their state is re-read after a zoom. `TabState.zoom`
  is the tab's factor; the status bar shows it as a percentage while it is not 100 %.
  **Known limit:** Electron keeps that map in the browse partition's Chromium `Preferences` file
  (`partition.per_host_zoom_levels`, host names), so a zoomed host's level survives a relaunch and
  is not removed by Clear Browsing Data (Electron 45 has no API to list or clear it). Resetting a
  host to 100 % removes its entry.
- **Context menu.** A right-click (any `context-menu` event) in a shown tab's page pops up a native
  menu from main (`Menu.popup`, on the app window), built by a pure function of the event's params
  and the tab's history flags:
  - a link with an `http(s)` URL: **Open Link in New Tab** (a background tab next to this one, like
    a gesture-backed popup: no opener, no referrer) and **Copy Link Address**; a `mailto:` link:
    Copy Link Address only; any other link (e.g. `javascript:`): nothing;
  - an image (`mediaType: 'image'`) with an `http(s)` source: **Open Image in New Tab** and **Copy
    Image Address** (a `data:` or `blob:` image: nothing);
  - an editable field, or a selection: **Cut**, **Copy**, **Paste**, **Select All**, each enabled by
    the event's `editFlags`; a non-empty selection also **Search Google for “…”**
    (`CONTEXT_MENU_SEARCH_LABEL`), searching in a new background tab;
  - none of these (a plain page): **Back**, **Forward** (enabled by the tab's history) and
    **Reload**.
  Groups are separated; nothing else is offered (no Inspect Element, no Save As). Every label is
  frost's own (`CONTEXT_MENU_LABELS`) except the selection quoted in the search item, which is
  cleaned and cut (`CONTEXT_MENU_SEARCH_LABEL`) and is only ever used as a search query.

## Shortcut matching (`apps/desktop/src/main/browser/__tests__/shortcuts.test.ts`)
- **Scenario: page-shortcut-matcher-follows-spec** — `matchPageShortcut(input, platform)` maps
  every `RESERVED_PAGE_SHORTCUTS` entry to its command on macOS and Linux/Windows (key-down and
  key-up), `mac:` entries only on macOS and `other:` entries only off it; extra or missing
  modifiers, `UNRESERVED_PAGE_SHORTCUTS`, plain Esc and the tab shortcuts answer `null`.

## Zoom (`apps/desktop/src/main/browser/__tests__/zoom.test.ts`)
- **Scenario: zoom-steps-through-factors** — `stepZoom(factor, direction)`: in and out move to the
  neighbouring `ZOOM_FACTORS` entry (from a factor between two entries, to the next one in that
  direction), clamped at both ends; reset is `DEFAULT_ZOOM`.

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`, "page commands")
- **Scenario: page-commands-act-on-active-tab** — `runPageCommand`: reload → `reload()`, hard
  reload → `reloadIgnoringCache()`, back / forward → `navigationHistory.goBack/goForward` (only
  when possible), stop → `stop()` only while loading and not fullscreen; all on the active tab only,
  and no-ops on an empty tab.
- **Scenario: zoom-commands-set-zoom-and-state** — zoom in / out / reset set the active tab's zoom
  factor by `stepZoom`, the tab's `zoom` follows (bumping the version), and other tabs' `zoom` is
  re-read (the same host follows in Chromium); an empty tab is a no-op.
- **Scenario: page-shortcuts-are-reserved** — a reserved page shortcut arriving as
  `before-input-event` on a tab's or the chrome's WebContents runs once and is `preventDefault`ed
  (its key-up too).
- **Scenario: esc-stops-loading-without-consuming** — Esc (key-down, no modifiers) on a loading,
  non-fullscreen tab calls `stop()` and is not `preventDefault`ed; on a tab that is not loading,
  with a modifier, or on a fullscreen tab (where it leaves fullscreen) it does not stop.
- **Scenario: context-menu-event-reaches-handler** — a tab's `context-menu` event hands its params,
  the tab's WebContents, the window and the tab's history flags to the injected `contextMenu`; a
  closed tab's event does not.

## Context menu template (`apps/desktop/src/main/browser/__tests__/context-menu.test.ts`)
- **Scenario: context-menu-plain-page** — no link, image, selection or editable: Back, Forward
  (enabled by `canGoBack` / `canGoForward`), Reload; clicking each runs that command.
- **Scenario: context-menu-web-link** — an `http(s)` link: Open Link in New Tab (opens the link
  URL in a background tab) and Copy Link Address (writes it to the clipboard); no Back/Forward.
- **Scenario: context-menu-other-links** — `mailto:`: Copy Link Address only; `javascript:`,
  `file:`, `data:` and unparseable links: no link items.
- **Scenario: context-menu-image** — an `http(s)` image: Open Image in New Tab and Copy Image
  Address (its `srcURL`); a `data:` / `blob:` image: no image items; a linked image gets both groups.
- **Scenario: context-menu-editing** — editable or a selection: Cut, Copy, Paste, Select All,
  enabled exactly by `editFlags`, each calling that edit command.
- **Scenario: context-menu-search-selection** — a selection adds the search item: its label is
  `CONTEXT_MENU_SEARCH_LABEL` with the cleaned selection, cut to `CONTEXT_MENU_SELECTION_MAX`
  with an ellipsis, `&` doubled, no control or bidi characters; clicking opens
  `SEARCH_URL_TEMPLATE` with the whole cleaned selection as `q` (capped at
  `ADDRESS_INPUT_MAX_LENGTH`); a whitespace-only selection has no search item.
- **Scenario: context-menu-labels-are-frost-own** — over a set of hostile params (labels-like link
  text, titles, alt text, filenames, misspellings and suggestions), every label is a
  `CONTEXT_MENU_LABELS` value or the search label; no item is an inspect or save item.

## Menu (`apps/desktop/src/main/__tests__/menu.test.ts`)
- **Scenario: menu-page-commands** — the View and History items have the accelerators above and
  call `runPageCommand` with their command; Stop does not register Esc; the hidden alternates are
  hidden and (macOS) work while hidden.

## Renderer (`apps/desktop/src/renderer/__tests__/zoom-label.test.ts`)
- **Scenario: status-bar-shows-zoom** — `zoomLabel(factor)`: `null` at 100 %, else the rounded
  percentage (`'110%'`, `'33%'`, `'500%'`).

## End to end (`apps/desktop/e2e/page-commands.e2e.ts`, real Electron, loopback pages)
- **Scenario: page-shortcuts-e2e** — with a page that swallows every keydown focused, real key
  input (`sendInputEvent`) for the platform's Back / Forward / Reload / Hard Reload / Zoom In,
  Zoom Out and Actual Size keys acts on the tab (history moves, the page is requested again, the
  zoom factor and the status bar's percentage change and reset) and the page never sees them.
- **Scenario: esc-stops-loading-e2e** — Esc sent to a tab whose page is still loading stops it
  (the tab stops loading, the slow response never commits), and the page saw the Esc.
- **Scenario: context-menu-open-link-in-new-tab-e2e** — a real right-click on a link
  (`sendInputEvent`) builds the menu from the event's params (main's `Menu.popup` is stubbed, so
  no native menu shows): the items are Open Link in New Tab and Copy Link Address; clicking Open
  Link in New Tab opens the link in a background tab right of this one.
- **Scenario: context-menu-search-e2e** — after selecting page text, a right-click on it offers
  Copy, Select All and the search item with the cleaned, cut selection; clicking it opens the
  search URL for the selection in a background tab.
