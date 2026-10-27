# Feature: SEO devtools drawer

Spec: `specs/devtools.spec.ts` (`DEVTOOLS_TOGGLE_SHORTCUT`, `DEVTOOLS_STORAGE_KEYS`,
`DEVTOOLS_HEIGHT`, `DEVTOOLS_TABS`, `NETWORK_LIMITS`, `NETWORK_TYPE_OF`, `CRAWLABLE_TYPES`,
`SECRET_HEADERS`, `REQUEST_HEADER_ALLOWLIST`, `RESPONSE_HEADER_KEEP`, `REDIRECT_KEY_HEADERS`,
`CONSOLE_LIMITS`, `COOKIE_LIMITS`, `CLEAR_SITE_DATA`, `ISSUE_SORT_KEYS`),
`specs/devtools.schema.ts` (the `devtools.*` inputs, `RobotsVerdictJobSchema`) and
`specs/browser.spec.ts` (`BrowserState.devtoolsToggleSeq`). Phase 2.5 Task 5. Each line maps to one
named test.

## Decisions
- **A band under the page area.** The tab's view is a native `WebContentsView` drawn above the
  chrome's DOM, so the drawer, like the palette's sheet, takes a band of the chrome: a row under the
  workspace (the page column and the SEO sidebar, since the Batch B integration), so the page area
  above it shrinks, and the chrome reports the smaller area through the existing
  `browser.setPageBounds`. Its height is set by an SVG strut's `height` attribute (never `style=`:
  strict CSP), clamped to `DEVTOOLS_HEIGHT` in the chrome and by `max-height` in the CSS. It is
  resized by dragging its top edge (a `separator`, also Arrow / Page Up and Down). Open, height and
  the last tab are kept per window in the chrome's `localStorage` (`DEVTOOLS_STORAGE_KEYS`).
- **Toggling is main's, the state is the chrome's.** `Mod+Shift+D` is reserved in
  `before-input-event` of every tab and of the chrome (consumed, so a page can neither see nor
  block it); View › SEO Devtools has it as its accelerator; the palette has "Toggle SEO devtools"
  and one "Show devtools: …" action per tab. Main bumps `devtoolsToggleSeq`; the chrome toggles.
- **Read-only by design.** No script runs in the page for the drawer and no DOM is edited. The one
  write is "Clear this site's data", which main confirms in its own dialog (Cancel is the default).
- **Data only through `devtools.*`.** Every procedure is `enforceSender`-first and Zod-validated:
  `watch` (a long-poll on the tab's devtools version), `network`, `requestHeaders`, `redirects`,
  `console`, `storage`, `revealCookie`, `clearSiteData`, `setOpen` and `setPreserveLog`. A combined
  state long-poll was rejected: the network log is large, so the chrome waits on a small version and
  fetches only the tab it shows (no sooner than `DEVTOOLS_REFRESH_MIN_MS` apart). They serve only
  the active tab (`DEVTOOLS_TAB_SCOPE`): any other id answers `no-tab`.
- **A light list, headers on demand** (review). `devtools.network` answers rows without headers,
  only those changed since the chrome's cursor (`since`), at most `maxRowsPerAnswer` at a time, with
  the keys removed since; the chrome merges them. A row's headers come from `devtools.requestHeaders`
  when the user opens it. A watch evicted by a newer one answers `DEVTOOLS_WATCH_EVICTED`; the
  chrome backs off (`DEVTOOLS_WATCH_BACKOFF_MS`) after any answer without news.
- **Bounded in bytes** (review). Beside the row caps, a tab's log keeps at most `tabBudgetBytes`
  and all logs together `globalBudgetBytes` (2 bytes per kept UTF-16 unit, plus per-entry and
  per-header overheads); what does not fit is not kept and is counted (`overBudget`), and the Network
  tab says so. A response keeps at most `maxHeadersPerMessage` (16) headers.
- **Reset on commit** (review). The network log, the console and the Reveals reset when a
  main-frame navigation commits another document (`did-navigate`), not when one starts: a `204`, a
  download or a cancelled navigation wipes nothing. The committing request's entries (and what was
  sent after its response started) move into the new document. Each Reveal is stamped with the
  committed document it was asked in; a stale stamp shows nothing.
- **Recording: always on, small while closed** (`NETWORK_LIMITS`). The recorder is a subscriber of
  the browse session's one `webRequest` owner (`browser/web-request.ts`, `observeRequests`), with
  observers only (`onSendHeaders`, `onBeforeRedirect`, `onResponseStarted`, `onCompleted`,
  `onErrorOccurred`; no blocking listener, so no request waits for main). With the drawer open in
  any window (`devtools.setOpen`) each document keeps its first 2,000 requests; with it closed
  everywhere a tab keeps a ring of the newest 100 plus its main-frame request, so opening the drawer
  after a load still shows the document and the latest requests, and says how many it let go.
  Rejected: recording only while open (the load that made you open the drawer would be lost) and a
  full log for every tab (memory for nothing).
- **Secrets never stored.** `SECRET_HEADERS` (`Authorization`, `Proxy-Authorization`, `Cookie`,
  `Set-Cookie`) are kept only as `MASKED_VALUE`, with no Reveal; other headers are allowlisted
  (`REQUEST_HEADER_ALLOWLIST`, `RESPONSE_HEADER_KEEP`), the rest only counted. Bodies are never read
  (`uploadData` is ignored and no response body is reachable from these observers).
- **robots.txt verdicts in the worker.** For the page's own origin, crawlable types only
  (`CRAWLABLE_TYPES`), from the robots.txt fetcher's cache (the file the audit read; fetched through
  it if the cache has none), matched for Googlebot in the analysis worker (`kind: 'robots'` jobs, at
  most `ROBOTS_VERDICT_BATCH` URLs, under its timeout), never on main's thread.
- **Redirects from the response recorder.** The trace is Phase 2's committed main-frame response
  (`seo/responses.ts`): hops, statuses and the final status, with each hop's
  `REDIRECT_KEY_HEADERS` from the drawer's own recorder where it saw them.
- **Console as inert text.** `console-message` events of the current document, deduplicated by
  level, text, source and line with a count, capped (`CONSOLE_LIMITS`).
- **Cookies masked; Reveal per cookie, per document.** Main keeps which cookies were revealed for
  the tab, stamped with its committed document, and forgets that on its next committed cross-document
  navigation, on Clear this site's data and when the tab closes; `devtools.storage` answers `value: null` for every other cookie. Storage usage is
  not shown (`STORAGE_USAGE_NOTE`): Electron has no cheap per-origin figure.
- **Issues from the shown audit.** The chrome's own audit (the sidebar's), every finding in one
  table sortable by severity, rule and category; clicking a row opens the SEO sidebar on the most
  specific panel after Overview that covers the finding's category (the one with the fewest
  categories; `ISSUE_FALLBACK_PANEL` otherwise).

## Request observers (`main/browser/__tests__/web-request-requests.test.ts`)
- **Scenario: request-observers-share-the-session-listeners** — `observeRequests` installs one
  listener per event (`onSendHeaders`, `onBeforeRedirect`, `onResponseStarted`, `onCompleted`,
  `onErrorOccurred`) for every resource type, re-installing the main-frame ones; main-frame
  observers still see only `mainFrame` events; no blocking listener is registered; one observer
  throwing never keeps an event from the others.

## Network log (`main/devtools/__tests__/network-log.test.ts`)
- **Scenario: devtools-masks-secrets** — `Authorization`, `Proxy-Authorization`, `Cookie` and
  `Set-Cookie` are stored only as `MASKED_VALUE` (any case, any value); nothing in the log holds
  their values; `uploadData` and any body-like field of the events are never kept.
- **Scenario: network-headers-allowlisted** — only allowlisted request and response headers keep a
  value (cut to `maxHeaderValueChars`, at most `maxHeadersPerMessage`); the others are counted.
- **Scenario: network-entry-fields** — method, URL cut to `maxUrlChars`, type (`NETWORK_TYPE_OF`),
  status, `Content-Length` size, start and duration, cache flag, redirect target, failure text.
- **Scenario: network-third-party-flag** — a request to another registrable domain than the page's
  is third-party; a subdomain of the page's is not.
- **Scenario: network-log-caps-per-document** — with the drawer open a document keeps its first
  `maxPerDocument` requests and counts the rest.
- **Scenario: network-log-ring-while-closed** — with the drawer closed a tab keeps the newest
  `closedRingSize` requests plus its main-frame request, counting the ones let go.
- **Scenario: network-log-resets-on-commit** — a committed cross-document navigation starts a new
  log, keeping the committing request (and its hops) and what was sent after its response started;
  late events of the old document's requests are not listed.
- **Scenario: network-log-survives-uncommitted-navigation** — a main-frame request that never
  commits (a `204`) leaves the log, and the console, as they were.
- **Scenario: network-log-byte-budgets** — a tab keeps at most `tabBudgetBytes` and all tabs
  `globalBudgetBytes`; requests that do not fit are counted (`overBudget.entries`, `bytes`), headers
  that do not fit are left off (`headersDropped`), and removed entries give their bytes back.
- **Scenario: network-log-hostile-server-bounded** — 2,000 requests, each with long URLs and 32
  long `link` headers (a 98 MB log before the fix), stay within the tab budget, rows and headers
  together.
- **Scenario: network-rows-incremental** — rows carry no headers; a cursor answers only the rows
  changed since and the keys removed since; a cursor from before a reset (or too old) gets a full
  answer, as does any cursor from before the tab's log started over (Clear Browsing Data, the tab
  forgotten or let go past `maxTrackedTabs`), also once new requests are in it; answers are paged at
  `maxRowsPerAnswer`.
- **Scenario: network-headers-on-demand** — one row's headers, masked as stored; `gone` for an
  unknown key.
- **Scenario: network-preserve-log** — with "Preserve log" on for a tab, earlier documents stay (at
  most `maxPreserved`, oldest first out); other tabs are unaffected; it is per tab and session-only.
- **Scenario: network-log-tabs-bounded** — at most `maxTrackedTabs` tabs are recorded; a destroyed
  tab's log is forgotten.

## Robots verdicts (`main/devtools/__tests__/robots-verdicts.test.ts`)
- **Scenario: robots-verdicts-in-worker** — the worker job validates its input
  (`RobotsVerdictJobSchema`), decides each URL for Googlebot (blocked / allowed), treats the
  allow-all outcomes as allowed and the unknown ones as unknown, and answers `invalid` for a bad job.
- **Scenario: robots-verdicts-same-origin-crawlable-only** — the service asks the worker only for
  the page origin's crawlable requests, in one batch at a time; others are `not-checked`; without a
  robots.txt answer they are `unknown`.

## Console (`main/devtools/__tests__/console-log.test.ts`)
- **Scenario: console-dedupes-and-caps** — identical messages are one entry with a count; at most
  `maxEntries` distinct entries (later new ones counted); text and source cut to their caps.
- **Scenario: console-resets-on-commit** — a committed cross-document navigation starts over.

## Storage (`main/devtools/__tests__/storage.test.ts`)
- **Scenario: cookies-masked-by-default** — every cookie of the tab's URL is listed (at most
  `maxCookies`) with its name, domain, path, expiry and flags, and `value: null`.
- **Scenario: cookie-reveal-lifecycle** — Reveal answers `true` and the next `storage` shows that
  cookie's value (capped) only; an unknown cookie or a non-web page answers `false`; the tab's next
  committed cross-document navigation, Clear this site's data and closing the tab mask it again.
- **Scenario: cookie-reveal-stamped-with-commit** — a Reveal asked while a navigation is in flight
  (the commit lands while main reads the cookie store) does not show in the new document.
- **Scenario: clear-site-data-confirms** — main asks first; Cancel clears nothing (`cancelled`);
  confirmed, the origin's data is cleared from the browse partition (`CLEAR_SITE_DATA.dataTypes`,
  that origin only) and reveals are forgotten (`cleared`); a tab without a web page is `refused`
  without asking.
- **Scenario: clear-site-data-one-dialog-per-origin** — while a dialog is up, a request for the same
  origin shares its answer and one for another origin answers `busy` (nothing asked, nothing
  cleared).

## Service (`main/devtools/__tests__/service.test.ts`)
- **Scenario: devtools-watch-wakes-on-change** — `watch` answers at once for an older version, else
  on the tab's next change (a request, a console message, a reveal), or with the current version when
  aborted; at most `MAX_PENDING_DEVTOOLS_WATCHES` wait.
- **Scenario: devtools-watch-eviction-marker** — a waiter pushed out by a newer one answers
  `DEVTOOLS_WATCH_EVICTED`, never a version.
- **Scenario: devtools-active-tab-only** — every procedure answers `no-tab` (`watch`: version 0,
  `revealCookie` `false`, `clearSiteData` `refused`) for an open tab that is not the active one.
- **Scenario: devtools-redirect-trace** — the trace is the recorder's committed response: hops with
  status, location and their key headers, the final status and headers; `none` without a response.
- **Scenario: devtools-clear-browsing-data** — Clear Browsing Data (`clear`) forgets every tab's
  requests, console and cookie reveals, and moves the version of each tab that had any on, waking its
  `watch`: an open drawer asks again and the cursor it holds gets a full answer (no rows), also after
  the next requests, so nothing cleared stays on screen.
- **Scenario: devtools-open-switches-capture** — `setOpen` from any live window turns full capture
  on; closing it (or the window going away) turns it off.

## Router (`packages/ipc-contract/src/__tests__/devtools-router.test.ts`)
- **Scenario: devtools-procedures-enforce-sender** — every `devtools.*` procedure rejects a foreign
  sender before validation or the service, and fails closed without the service.
- **Scenario: devtools-inputs-validated** — unknown keys, bad ids and over-long values are rejected
  before the service is called.
- **Scenario: devtools-procedures-call-the-service** — each procedure (with `requestHeaders`) passes its input (and, for
  `setOpen`, the sender's window) to the service and answers what it answers; `watch` times out
  with the current version.

## Shortcut, menu, controller
- **Scenario: devtools-shortcut-matches** (`shortcuts` tests) — `Mod+Shift+D` (key-down and key-up)
  is the toggle; `Mod+D`, `Mod+Alt+Shift+D` and the other modifier are not.
- **Scenario: devtools-menu-item** (`menu` tests) — View › SEO Devtools, `CmdOrCtrl+Shift+D`, calls
  `toggleDevtools` on every platform.
- **Scenario: controller-toggles-devtools** (`controller` tests) — the shortcut from a tab or the
  chrome is consumed and bumps `devtoolsToggleSeq` once per key-down; the menu's `toggleDevtools`
  too; nothing without a window.

## Chrome helpers (`renderer/__tests__/devtools-view.test.ts`, `devtools-palette.test.ts`)
- **Scenario: drawer-height-clamped** — the stored height parses or falls back to the default;
  dragging and keys clamp it to `[min, column − pageMinVisible]`.
- **Scenario: drawer-state-from-storage** — open, height and tab read back from storage, with
  defaults for missing or bad values.
- **Scenario: network-filters** — type, third-party only, failed only (a failure or a status from
  400) and a case-insensitive text search over the URL and method, combined.
- **Scenario: watch-backs-off-without-news** — the chrome's watch loop waits
  `DEVTOOLS_WATCH_BACKOFF_MS` after an evicted, unchanged or failed answer and refreshes at once
  (within `DEVTOOLS_REFRESH_MIN_MS`) after a new version.
- **Scenario: network-rows-merge** — the chrome's merge of an incremental answer: a full answer
  replaces, rows replace by key, removed keys go, the order is by key.
- **Scenario: waterfall-geometry** — each row's bar starts and spans in proportion to the log's
  time range (SVG user units), a pending one runs to the end, a zero span is still visible.
- **Scenario: issues-sorted** — by severity (errors first), rule or category, either direction,
  stable.
- **Scenario: issue-jumps-to-panel** — a finding's category opens the most specific covering panel
  after Overview (`seo-sidebar.spec.ts` `SEO_PANELS`), else `ISSUE_FALLBACK_PANEL`.
- **Scenario: devtools-palette-actions** — "Toggle SEO devtools" and one "Show devtools: …" per tab
  are registered and ask the drawer to toggle or open on that tab.
- **Scenario: devtools-styles-are-delimited** (`devtools-styles` test) — the drawer's CSS is one
  delimited `/* Devtools drawer */` section and the drawer's components never use `style=`.

## End to end (`e2e/devtools.e2e.ts`, loopback)
- **Scenario: drawer-toggles-and-page-shrinks** — the shortcut, the menu item, the palette and the
  close button toggle the drawer; while open the tab's view ends where the drawer's band starts (and
  moves with a keyboard resize), and the open state is stored; closed, the view has its height back.
- **Scenario: network-lists-requests-and-filters** — the page's document, script, stylesheet and
  image requests are listed with status and type; the type, third-party and failed filters and the
  search narrow the list; robots.txt marks a disallowed script as blocked.
- **Scenario: network-masks-authorization** — a request sent with an `Authorization` header shows
  it as `•••`, and the secret appears nowhere in the chrome.
- **Scenario: network-log-survives-uncommitted-navigation** (e2e) — navigating to a `204` keeps the
  page, its network log and its console.
- **Scenario: redirects-show-the-chain** — a 301 → 302 → 200 chain lists both hops with their
  status and `Location`, then the final 200.
- **Scenario: console-dedupes-messages** — the same message logged three times is one row ×3.
- **Scenario: cookies-masked-reveal-resets** — cookies are listed with masked values; Reveal shows
  one; a navigation masks it again.
- **Scenario: clear-site-data-asks** — with main's dialog answering Cancel the cookies stay; with
  OK they are gone.
- **Scenario: issues-jump-to-panel** — clicking an issue opens the SEO sidebar on its panel.
- **Scenario: devtools-shortcut-not-swallowed** — a page that cancels every key still cannot keep
  `Mod+Shift+D` from toggling the drawer, and never sees it.
