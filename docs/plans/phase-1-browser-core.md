# Phase 1 — Browser Core Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven (a fresh implementer per task, a
> fresh reviewer before the next). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 0 shell into a usable, hardened browser: browser chrome (tab strip, toolbar,
address bar), real web pages in `WebContentsView`s on their own session partition, navigation guards
for browsed content, per-origin permission prompts, and a local browser-session database that
restores tabs.

**Architecture:** The app window keeps loading the React UI from `app://app` (the *chrome*). Each tab
is a `WebContentsView` created by an allowlisted factory, attached to the app window's `contentView`
and positioned over the page area the chrome reports. Tab views have **no preload** and run on the
`persist:frost-browser` partition, separate from the app UI's default session. Main owns all browser
state in a `BrowserController`; the chrome reads it and drives it only through typed, sender-guarded
tRPC procedures. Main pushes nothing: the chrome long-polls `browser.watch`, which resolves when the
state version advances, so the single `app:trpc` invoke channel stays the only IPC path.

**Tech Stack:** As Phase 0, plus `WebContentsView` (Electron 45), libSQL + Drizzle (Task 5).

**Spec:** `docs/design/IMPLEMENTATION-PLAN.md` §3 (security model) and §4 (Phase 1 deliverable).
UI direction: `docs/ui-reference/README.md` (direction only; frost's look is its own).

## Spec-Driven Development protocol

As Phase 0: every task first authors or updates a machine-checkable artifact under `specs/` (typed
constants/Zod in `specs/*.spec.ts`, acceptance lists in `specs/*.feature.md`). Each feature-file
scenario maps 1:1 to a named test that cites it. Reviewers check spec↔test↔code agreement.

## Global Constraints

Everything in Phase 0's Global Constraints and `CONTRIBUTING.md` still holds, plus:
- Tab views are created only by an allowlisted factory (`semgrep/webcontents-factory.yml`) with
  `sandbox`, `contextIsolation`, `webSecurity` explicitly `true`, `nodeIntegration` explicitly
  `false`, **no `preload`**, and `partition: BROWSE_PARTITION`.
- Browsed content never reaches IPC: no bridge in tab views, and `enforceSender` already rejects
  views embedded in an app window (`not-window-contents`); a test pins this.
- Browsed content never loads `app://`: the browse session has no `app` protocol handler, and the
  request guard keeps refusing `app://` from non-app WebContents.
- The app-wide WebContents guard classifies each WebContents at creation by session: browse-session
  contents get the *browse guard*, everything else keeps the Phase 0 app pin. Unknown sessions fail
  closed to the app pin.
- The chrome's CSP is unchanged (no `'unsafe-inline'`). Style with bundled CSS classes, never
  `style=` attributes.
- Renderer UI is frost's own design: no third-party markup, CSS, icons, or assets. Icons are inline
  SVG components we draw.

## Review Focus

Inputs the spec implies but the happy-path tests don't exercise; each line's test is added to the
owning task.
- **Address-bar input that looks like a non-web URL** (`javascript:alert(1)`, `file:///etc/passwd`,
  `app://app/`, `data:text/html,…`, `chrome://gpu`): must become a search, never a navigation to that
  scheme — Task 1 (`non-web-input-becomes-search`).
- **A browsed page calling into IPC** (no bridge; and a forged `ipcRenderer` path is impossible
  because the view has no preload): `window.frostIpc` is undefined in a tab, and the tab's
  WebContents is rejected as `not-window-contents` — Task 1 (`tab-has-no-ipc`).
- **A browsed page navigating itself to a non-web scheme** (`location = 'file:///…'`,
  `app://app/`): dropped — Task 3 (`page-cannot-navigate-to-non-web-scheme`).
- **`window.open` from a page without a user gesture**: no new tab — Task 3
  (`popup-without-gesture-is-blocked`).
- **A permission request from a subframe of another origin**: prompted for (and remembered against)
  the requesting origin, not the top-level page's — Task 4 (`prompt-names-requesting-origin`).
- **A restored tab whose stored URL is no longer browsable** (tampered DB row `file:///…`): skipped
  on restore — Task 5 (`restore-skips-non-browsable-urls`).

---

### Task 1: Browser chrome + a single page view

**Files:**
- Create: `specs/browser.spec.ts` (`BROWSE_PARTITION = 'persist:frost-browser'`,
  `BROWSABLE_SCHEMES = ['http:', 'https:']`, `SEARCH_URL_TEMPLATE` (Google, `{q}` placeholder),
  `BrowserState`/`TabState` Zod schemas, `WATCH_TIMEOUT_MS = 25_000`, `TAB_VIEW_WEB_PREFERENCES`),
  `specs/address-bar.feature.md`, `specs/browser-chrome.feature.md`
- Create: `apps/desktop/src/main/browser/{address,controller,guard}.ts`
- Modify: `apps/desktop/src/main/window.ts` (add `createTabView()` factory), `security/register.ts`
  (classify by session), `index.ts` (wire controller)
- Modify: `packages/ipc-contract/src/router.ts` (+ a `BrowserService` interface the router calls,
  supplied by main through the IPC context)
- Modify: `apps/desktop/src/renderer/` (chrome UI: toolbar + address bar + page area + status bar,
  `styles.css`)
- Test: `apps/desktop/src/main/browser/__tests__/*.test.ts`, `packages/ipc-contract` router tests,
  `apps/desktop/e2e/browser.e2e.ts`

**Interfaces:**
- `resolveAddressInput(input: string): { kind: 'url' | 'search'; url: string } | null` — pure;
  `null` for empty/whitespace input (a no-op).
- `createTabView(): WebContentsView` — allowlisted factory; prefs equal `TAB_VIEW_WEB_PREFERENCES`.
- `BrowserService` (in `@app/ipc-contract`): `navigate(input)`, `back()`, `forward()`, `reload()`,
  `stop()`, `setPageBounds(rect)`, `getState()`, `watch(sinceVersion): Promise<BrowserState>`.
- Procedures (each `publicProcedure.use(enforceSender)` first, Zod-validated input):
  `browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`, `browser.stop`,
  `browser.setPageBounds`, `browser.watch` (resolves when `version > sinceVersion` or after
  `WATCH_TIMEOUT_MS` with the current state).

- [ ] **Step 1 (spec):** `address-bar.feature.md` — `example.com` → `https://example.com/`;
  `localhost:5173` and `127.0.0.1:8080/x` → `http://…`; explicit `http://`/`https://` kept;
  `hello world` → search; non-web inputs (Review Focus list) → search; empty/whitespace → no-op.
  `browser-chrome.feature.md` — typing a URL + Enter loads it in the page view; the address bar shows
  the committed URL and the window title the page title; back/forward/reload/stop enable and act
  correctly; the page view tracks the page-area bounds on resize; an empty tab shows frost's start
  view (page view hidden); `tab-has-no-ipc`; tab cannot load `app://`.
- [ ] **Step 2: failing tests** — unit tests for `resolveAddressInput` (every scenario), the factory's
  prefs (`toEqual(TAB_VIEW_WEB_PREFERENCES)`, partition, no preload), the session-classified guard,
  router procedures (sender rejection first, Zod rejects malformed input, `watch` timing with fake
  timers); e2e `browser.e2e.ts` against a loopback server.
- [ ] **Step 3: run → FAIL.**
- [ ] **Step 4: implement.** Keep the existing `data-testid="ping"` element (Phase 0 e2e) as a
  status-bar connection indicator. Chrome layout: toolbar (back, forward, reload/stop, address bar),
  page area (measured with `ResizeObserver`, reported via `browser.setPageBounds`), status bar.
- [ ] **Step 5: run unit + e2e + Semgrep + Electronegativity → PASS.**
- [ ] **Step 6: commit** — `feat(browser): browser chrome with address bar and a hardened page view`.

### Task 2: Tabs

**Files:** extend `specs/browser.spec.ts` (`MAX_TABS`), create `specs/tabs.feature.md`; modify the
controller, router (`browser.newTab`, `browser.closeTab`, `browser.activateTab`), and renderer (tab
strip). Test: unit + `e2e/tabs.e2e.ts`.

- [ ] **Step 1 (spec):** new tab (button, Cmd/Ctrl+T) opens an empty tab and focuses the address bar;
  close (button, Cmd/Ctrl+W) destroys its view (`webContents.close()`), activating the neighbour;
  closing the last tab leaves one empty tab (window stays open); switching shows exactly one view;
  tab titles/favicons-free labels and loading indicator; `MAX_TABS` enforced.
- [ ] **Steps 2–5:** red → green as above; menu accelerators via the app menu, not renderer key hooks.
- [ ] **Step 6: commit** — `feat(browser): tabs`.

### Task 3: Browsed-content navigation guards

**Files:** `specs/browse-guard.feature.md`; modify `browser/guard.ts`. Test: unit + `e2e/browse-guard.e2e.ts`.

- [ ] **Step 1 (spec):** main-frame and subframe navigations and redirects allowed only to
  `BROWSABLE_SCHEMES` (+ `about:blank`); a non-web scheme (`mailto:`, `vscode:` …) on a real gesture
  goes through the Phase 0 `openExternal` allowlist flow, else dropped;
  `window.open`/`target=_blank` with a gesture → new background tab for browsable URLs, without a
  gesture → blocked; `<webview>` refused; downloads cancelled with a status-bar notice (Phase 1 has
  no download manager); certificate errors are refused (never `callback(true)`) and the chrome shows
  an error state; a crashed renderer (`render-process-gone`) shows a reload state.
- [ ] **Steps 2–5:** red → green, including every Review Focus item owned by this task.
- [ ] **Step 6: commit** — `feat(security): browsed-content navigation guards`.

### Task 4: Permission prompts

**Files:** `specs/permissions.spec.ts` (`PROMPTABLE_PERMISSIONS` — e.g. `geolocation`,
`notifications`, `media`, `clipboard-read`; everything else denied without a prompt),
`specs/permissions.feature.md`; `browser/permissions.ts`; router `browser.answerPermission`; renderer
prompt bar. Test: unit + `e2e/permissions.e2e.ts`.

- [ ] **Step 1 (spec):** browse-session requests for a promptable permission show a prompt naming the
  *requesting* origin; Allow/Block answers it and is remembered per (origin, permission) for the
  session; dismissing, closing the tab, or navigating away denies; non-promptable permissions are
  denied silently; the app UI's default session stays deny-all (Phase 0).
- [ ] **Steps 2–5:** red → green.
- [ ] **Step 6: commit** — `feat(browser): per-origin permission prompts`.

### Task 5: Local browser-session database

**Files:** `packages/db` (`@app/db`: Drizzle schema + migrations on libSQL — tables `browser_tabs`,
`recent_visits`, `site_permissions`), `specs/browser-session-db.feature.md`; wire into main
(`app.getPath('userData')`). Test: `packages/db` unit tests (in-memory libSQL) + `e2e/session-restore.e2e.ts`.

- [ ] **Step 1 (spec):** open tabs (URL, order, active) persist and restore on relaunch;
  `restore-skips-non-browsable-urls`; visits are recorded (url, title, count, last visit) for
  committed browsable navigations only; remembered permission decisions persist; the DB file lives in
  `userData`; migrations run at startup and are forward-only.
- [ ] **Steps 2–5:** red → green. The packaged app must still pass `verify:mac` (native libSQL binary
  inside the ASAR-integrity build: unpack it if required, and keep the fuses).
- [ ] **Step 6: commit** — `feat(db): local browser-session store with tab restore`.

### Task 6: Release check

- [ ] Rebuild and package on macOS; `pnpm verify:mac` passes; the full e2e suite passes on macOS and
  Linux; screenshots of the chrome with a page loaded attached to the PR (not committed).
- [ ] Update `apps/desktop/README.md` (what the app does now) and this plan's checkboxes.
- [ ] **Commit** — `docs: phase 1 browser core`.

## Self-review notes
- **Deliverable coverage (design §4 Phase 1):** tabbed browsing → Tasks 1–2; address bar → 1;
  session partition → 1; navigation guards → 3; permission prompts → 4; local browser-session DB → 5.
- **Security model (design §3):** every WebContentsView hardened explicitly (1); deny-by-default
  permissions with per-origin prompts (4); `window.open` allowlist + gesture kept and extended to
  tabs (3); the app frame stays pinned to `app://` (1, guard classification).
- **Out of scope:** SEO sidebar (Phase 2), new-tab widgets, downloads manager, history UI, bookmarks.
