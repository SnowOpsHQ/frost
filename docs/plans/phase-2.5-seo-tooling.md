# Phase 2.5 — SEO Tooling Depth Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven. Tasks in the same batch touch
> mostly separate files and run in parallel in their own worktrees; an integrator merges each batch,
> then fresh reviewers check each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the day-to-day SEO toolkit around the Phase 2 audit:
- render a page the way a crawler or a slow phone would;
- see what depends on JavaScript;
- judge content and draft better snippets;
- drive everything from the keyboard;
- debug a page's network, redirects and console without leaving frost.

**Architecture:** Phase 2's architecture holds:
- page-facing scripts run only in isolated worlds;
- all page-derived analysis (Zod validation included) runs in the `worker_threads` analysis worker
  under its hard timeout;
- the chrome talks to main only through `enforceSender`-first tRPC procedures;
- page text is always inert.

New in this phase:
- Main drives a tab's emulation and network conditions through the tab's own
  `webContents.debugger` (Chrome DevTools Protocol in-process, no remote debugging port).
- A bounded fetcher, extracted from the robots.txt fetcher and shared with it, reads served HTML,
  link statuses and sitemaps.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §4 Phase 2.5.
- UI direction: `docs/ui-reference/README.md`.

## Spec-Driven Development protocol
As before:
- every task authors `specs/` artifacts first;
- each scenario has a named test that cites it;
- reviewers check spec↔test↔code agreement.

## Global Constraints
Everything in the Phase 0–2 Global Constraints and `CONTRIBUTING.md` still holds, plus the following.
- **Clean-room.** Behaviour is specified here in frost's own words, from SEO practice and public web
  standards. Nothing is copied from any other product's UI text, code, prompts or assets.
- **Debugger use is main-only and per tab.**
  - `webContents.debugger.attach()` is allowed only on browse-session tab WebContents, and only by the
    render-profile module and the devtools drawer's recorder (as built, the drawer needed none: see
    As built).
  - Only an allowlist of CDP methods may be sent.
  - The debugger is detached when the tab closes.
  - The packaged-build refusal of `--remote-debugging-*` is unchanged.
  - A Semgrep rule (new) flags `debugger.attach`/`sendCommand` outside those modules.
- **Fetching on the user's behalf.** Served HTML, link checks and sitemap reads all go through one
  bounded fetcher that applies the robots.txt fetcher's rules:
  - browse session, cookies omitted, no referrer;
  - http(s) only;
  - redirect cap;
  - private-address refusal unless the page itself is private;
  - size and time caps;
  - per-origin rate limit.

  Each surface says that sites can see these requests.
- **Values are masked by default.** Cookie and storage values in the devtools drawer are shown masked
  until the user reveals one. Request and response bodies are never captured. `Authorization`,
  `Cookie` and `Set-Cookie` headers are always masked.
- **No new remote calls from the chrome.** Command-palette web suggestions don't exist in this phase.
  "Open in external tool" builds only `https:` URLs from a fixed, reviewed template table and opens
  them as background tabs.

## Review Focus
- **A tab's render profile cannot leak into another tab or the app session.**
  - Profiles are scoped per tab, and are cleared on tab close unless pinned to the site.
  - The overridden state is always visible on the tab and in the status bar.
  - Task 1 (`render-profile-is-tab-scoped`).
- **A page cannot observe or defeat emulation beyond what the emulated environment itself exposes.**
  - The debugger session is invisible to the page.
  - A page cannot detach it.
  - Task 1 (`emulation-is-invisible-to-page`).
- **Served-HTML parsing is bounded and off the main thread.**
  - It is parsed in the worker.
  - The size and time caps apply.
  - Hostile markup (deep nesting, 50 MB) stays bounded.
  - Task 2 (`served-html-is-bounded`).
- **Devtools never exposes secrets by default.**
  - Masked cookies and auth headers.
  - Never bodies.
  - Task 5 (`devtools-masks-secrets`).
- **Link/sitemap checks cannot be turned into a request flood or a LAN probe.**
  - A per-origin rate limit and a total cap.
  - Private-address refusal.
  - Task 7 (`link-checks-are-bounded`).

---

### Batch A (parallel)

#### Task 1: Per-tab render profiles
- **Profile.** A profile combines:
  - a device preset: viewport, device-scale factor, touch, mobile flag;
  - a user agent: browser, mobile, common crawler user agents, or custom text with a length cap;
  - a network condition: offline, slow 3G, fast 3G, 4G, none;
  - switches: JavaScript off, cache off.
- **How it's applied.** Through CDP on the tab's own debugger:
  - `Emulation.setDeviceMetricsOverride` / `setTouchEmulationEnabled`;
  - `Network.setUserAgentOverride` (with matching UA client hints);
  - `Network.emulateNetworkConditions`;
  - `Emulation.setScriptExecutionDisabled`;
  - `Network.setCacheDisabled`.

  The chrome shows "Reload to apply" where a reload is needed.
- **Visibility.** The profile is shown on the tab, in the status bar and in the page area's frame.
  "Reset" is one click.
- **Scope and lifetime.** Profiles are tab-scoped by default. "Pin to this site" keeps a profile per
  origin, stored locally.
- **Recorded with audits.** Every audit records the profile it ran under. The Overview shows it, and
  the vitals' lab caveat names the profile.
- **Honesty note.** A crawler user agent doesn't reproduce a crawler's network origin or rendering
  service, so results may differ from what the real crawler sees.
- **Procedures.** `browser.setRenderProfile` and `browser.clearRenderProfile`, both
  `enforceSender`-first and Zod-validated.
- **Semgrep.** New rule `debugger-outside-allowlisted-modules`.
- **Tests.** Unit tests for the profile spec and the CDP command builder (allowlist). e2e:
  - mobile preset → the page sees the viewport width and the UA;
  - JavaScript off → a script-written marker is absent;
  - slow network → load is measurably slower;
  - profile scoped to its tab;
  - the page cannot detect the debugger;
  - reset restores defaults.
- [x] commit `feat(browser): per-tab render profiles`
- [x] Review fixes: commit `fix(browser): address render-profile review findings`

#### Task 3: Content analysis and snippet editor
- **Content panel.** A new rail item, or an On-Page sub-section; the implementer decides and documents
  it. It shows:
  - 1/2/3-word n-grams from the visible text (`Intl.Segmenter`, stop-words per language where frost
    ships a small list), with presence in the title, H1, meta description and URL;
  - a readability grade where a formula is valid for the page language (English Flesch reading ease,
    with a documented formula). Other languages show "not available";
  - an optional **target query** typed by the user, stored per URL locally, giving a checklist of term
    presence in the title, H1, URL, the first 100 words and headings.
- **Information, not targets.** n-gram density is never scored as pass/fail: nothing rewards keyword
  stuffing.
- **Pixel widths.** Title and description width against the result-snippet budget.
  - Desktop title ≈ 580 px at the snippet font size.
  - Description ≈ 920 px desktop, ≈ 680 px mobile.
  - These are spec constants with a source note.
  - Width comes from a character-width table generated at build time by measuring a common sans-serif
    with canvas in Electron and committed as data. The worker computes widths from the table.
  - New rules: title over budget (warning) and description over budget (info), which replace or
    augment the character-length rules. Document how they interact.
- **Snippet editor.**
  - Inputs: the current title and description, plus user-drafted variants.
  - Live desktop and mobile previews truncated at the pixel budget, with an ellipsis.
  - Variants are stored locally per URL (DB table).
  - "Copy as HTML" (`<title>` and `<meta name="description">`, HTML-escaped) goes through main.
  - The previews are drawn by frost; no favicon is fetched into the chrome (use a neutral glyph).
- **Tests.** Unit tests for n-grams (CJK, Thai, stop-words), readability, the width table and
  truncation, rules, the variant store, router and copy. e2e for the panel, the target query and the
  editor.
- [x] commit `feat(seo): content analysis and snippet editor`
- [x] Review fixes: commit `fix(seo): address content review findings`

#### Task 4: Command palette
- **Opening.** Cmd/Ctrl+K opens a palette over the chrome. The shortcut is reserved in
  `before-input-event` so pages can't swallow it, following the Phase 1 shortcut table.
- **Searching.** Fuzzy search over an **action registry**. Every action has an id, label, group,
  keywords, an availability predicate and a handler (a chrome-side or main procedure).
- **Built-in actions:**
  - jump to each SEO panel; toggle the sidebar;
  - highlight modes;
  - re-audit; run the accessibility check;
  - every tab and navigation command (new tab, close tab, reload, back/forward, zoom);
  - Clear Browsing Data;
  - copy actions for the current audit (title, meta description, canonical, H1, URL, robots, the
    status code, the JSON-LD block), written by main from the shown audit, as Phase 2 copy actions do;
  - "Open in" actions from a fixed `https:` template table: public validators and testers for rich
    results, mobile rendering, page speed, an archive lookup, and the robots.txt and sitemap of the
    site. Each opens as a background tab through `browser.openBackgroundTab`.
- **Keyboard.** Fully keyboard-driven (arrows, Enter, Esc), ARIA combobox/listbox, recent actions
  first.
- **Extensible.** Later tasks register their own actions; this task only provides the registry and
  the built-ins.
- **Tests.** Unit tests for the registry, the fuzzy matcher, the template table (`https:` only, the URL
  encoded, no page-controlled host) and availability. e2e: open, search, run a jump, run a copy, run
  "Open in", and the page can't block Cmd/Ctrl+K.
- [x] commit `feat(chrome): command palette`
- [x] Review fixes: commit `fix(chrome): address palette review findings`

**Batch A integration.** Merged into `phase-2.5/seo-tooling` in the order palette, render profiles,
content; render profiles and Content then registered their own palette actions.
- [x] commit `feat(chrome): palette actions for render profiles and content`
- [x] Merge fix: commit `fix(browser): palette tool tabs never inherit the render profile`

### Batch B (parallel, after Batch A is merged)

#### Task 2: Served HTML vs rendered DOM
- **Fetching.** The bounded fetcher (see Global Constraints; extract it from the robots.txt fetcher
  into `seo/fetcher.ts` and share it) fetches the page URL as served: cookies omitted, caps of about
  5 MB and 10 s, and the tab's render profile user agent when one is set.
- **Parsing.**
  - Parse in the **worker** with a spec-compliant HTML parser dependency (e.g. `parse5`, MIT),
    bounded by node count and depth.
  - Produce a snapshot of the same shape as the rendered snapshot, extracting the fields that make
    sense without layout: title, metas, robots, canonical, headings, links, structured data, word
    count, hreflang.
- **JavaScript panel.**
  - A per-field structural diff (only in served, only in rendered, changed).
  - A verdict: JS-independent / partly / heavily JS-dependent.
  - Rules: canonical, robots or title differs after JS (warning); main content (word count) mostly
    added by JS (info); links only present after rendering (info).
- **States:** pending, ready, served HTML unavailable (with the reason), identical.
- [x] commit `feat(seo): served vs rendered comparison`
- [x] Review fixes (with Task 7's): commit
  `fix(seo): address fetcher, served-html and checks review findings`

#### Task 5: SEO devtools drawer
- A drawer under the page area: resizable, toggled with Cmd/Ctrl+Shift+D, its state per window. Tabs:
  - **Network:** requests recorded from the browse-session `web-request.ts` owner for the active tab.
    Shows method, URL as text, type, status, size, timing waterfall, third-party flag, and robots.txt
    verdict for crawlable types. Filters and a cap (e.g. 2,000 per document). `Authorization`,
    `Cookie` and `Set-Cookie` are always masked, and bodies are never stored.
  - **Redirects:** the main-frame redirect trace from Phase 2's response recorder, with each hop's
    status and the headers that matter.
  - **Console:** the tab's console messages (`console-message` event), deduplicated with counts,
    capped, rendered as text.
  - **Storage:** cookies for the tab's origin (from the browse session; names visible, values masked
    with per-item reveal) and the origin's storage usage. Read-only: no editing or deleting from here
    except a "Clear this site's data" action that asks for confirmation.
  - **Issues:** every finding for the current audit in one sortable table, with its detail.
- The drawer is read-only by design: no script execution, no DOM editing.
- [x] commit `feat(chrome): SEO devtools drawer`
- [x] Review fixes: commit `fix(chrome): address devtools review findings`

#### Task 6: Browser polish
- **Find in page:** Cmd/Ctrl+F, using `webContents.findInPage`, with a find bar in the chrome, match
  count, next/previous, and Esc.
- **Reopen closed tab:** Cmd/Ctrl+Shift+T. Session-local stack, capped.
- **History view:** an app view listing `recent_visits` with search, open, delete one, and clear all
  (which reuses Clear Browsing Data's history part).
- **New-tab page:** the start view gains "Jump back in" (recent visits, local only). No remote content.
- **Search engine choice:** Google (default), Bing or DuckDuckGo in settings, plus prefix shortcuts in
  the address bar (`g `, `b `, `d `). `SEARCH_URL_TEMPLATE` becomes a table.
- Each item registers its command-palette actions.
- [x] commit `feat(browser): find, reopen tab, history, search engines`
- [x] Review fixes: commit `fix(browser): address browser polish review findings`

#### Task 7: Link status and sitemap checks
- **Link checks.**
  - "Check links" on the Links panel: HEAD (falling back to GET with a capped body) through the bounded
    fetcher.
  - Per-origin concurrency 2 and a rate limit, a total cap (e.g. 500 links), and private-address
    refusal.
  - Results: status, redirect target, broken, robots-blocked.
  - The broken-link highlight reuses the highlight overlay.
- **Sitemaps.**
  - From the robots.txt `Sitemap:` lines, or `/sitemap.xml`: fetch (capped, gzip supported), parse in
    the worker with an XML parser dependency, bounded, following sitemap indexes to a depth/total cap.
  - Report URL count, errors, whether the current URL is listed, and `lastmod` sanity.
- **hreflang reciprocity.** For the page's hreflang alternates (capped), fetch each alternate and check
  it links back.
- Every surface states that these requests are visible to the sites.
- [x] commit `feat(seo): link status, sitemap and hreflang reciprocity checks`
- [x] Review fixes (with Task 2's): commit
  `fix(seo): address fetcher, served-html and checks review findings`

**Batch B integration.** Merged into `phase-2.5/seo-tooling` in the order served vs rendered,
devtools drawer, browser polish, link and sitemap checks; the checks then moved onto the shared
bounded fetcher.
- [x] commit `refactor(seo): link and sitemap checks use the shared bounded fetcher`
- [x] commit `fix(chrome): Batch B integration consistency`

### Task 8: Release check
- [ ] Mac package `verify:mac`, full e2e on macOS and Linux, Mac screenshots of the new surfaces (the
  release check, run separately).
- [x] macOS e2e timing (found on a macOS run; no product change): commit
  `fix(e2e): macOS timing in the find, palette and reopen-tab suites`
- [x] README and plan "As built": commit `docs: phase 2.5 seo tooling`

## As built

Tasks 1–7 are implemented, reviewed and merged, each followed by a review-fix commit, and both
batches were integrated as noted above. What the app does now is in `apps/desktop/README.md`; each
behaviour, with its named tests, is in the feature file named under each task below. Where the build
departs from or adds to the plan:

### Across the phase
- **Chrome rows.** A tab's view is a native `WebContentsView` drawn above the chrome's DOM, so every
  new surface takes a band of the chrome and never overlaps the page. The rows are: tab strip,
  toolbar, permission prompt, render-profile editor bar, find bar, workspace (the page column, with
  the palette's sheet or the History sheet over the page area, and the SEO sidebar), devtools drawer,
  status bar. The page area's measured bounds (`browser.setPageBounds`) leave room for all of them,
  and the render-profile frame insets the view within it. The find bar and the drawer started as
  page-column rows (Tasks 5 and 6); the Batch B integration made the find bar a row above the
  workspace and the drawer a band under it (across the sidebar too), clamped against the workspace
  and itself.
- **Rail and catalog.** The rail has eleven panels: Overview, On-Page, Content, Links, Images,
  Social, Schema, Indexability, Page Speed, Compliance, JavaScript. The new `javascript` category is
  in `SEO_CATEGORIES` and the Overview's checks; Task 7's rules use the existing `links`,
  `indexability` and `hreflang` categories. The catalog has 111 rules in 19 categories: the two width
  rules replace the two character maximums, plus five `javascript` rules and five check rules.
- **Palette actions.** Each feature registers its own with one `registerPaletteActions(...)` call in
  its own renderer file (`render-profile-palette.ts`, `content-palette.ts`, `javascript-palette.ts`,
  `devtools-palette.ts`, `browser-polish-palette.ts`, `checks-palette.ts`). A feature that owns a
  panel owns its jump (`FEATURE_PANEL_JUMPS`), so the built-ins list no second one. All register
  together with no id offered twice (`palette-features-register-together`).
- **Reserved shortcuts** never collide on any platform (`reserved-shortcuts-never-collide`): Mod+K,
  Mod+F, Mod+L, Mod+T, Mod+Shift+T, Mod+Shift+S, Mod+Shift+D, Mod+R / Mod+Shift+R, and Mod+G /
  Mod+Shift+G while the find bar is open. Mod+Y (History) is a menu accelerator only.
- **The debugger has one module.** Only `browser/render-profile-debugger.ts` attaches, and the
  Semgrep rule `debugger-outside-allowlisted-modules` (`semgrep/debugger-allowlist.yml`) allows only
  it. The plan also allowed the devtools drawer's recorder; it needed no debugger (it observes
  `webRequest`), so it never joined. The rule is wider than planned: any use of a `debugger`
  property, an alias, a destructured binding (typed or not) or a reflective read is flagged.
- **One bounded fetcher, two lanes** (`specs/fetcher.spec.ts`). Task 2 extracted it from the
  robots.txt fetcher into `seo/fetcher.ts` (`createBoundedFetcher`, `netHop`, `isPrivateHost`);
  robots.txt keeps its cache and outcomes on top, unchanged. Task 7 was built on a temporary fetch
  adapter, and at integration `checks-fetch.ts` became a thin mapping onto the shared fetcher
  (`CHECK_FETCH_OUTCOMES`; a full queue, `busy`, is `unreachable`). Main runs the fetcher in two lanes
  over one hop:
  - `audit` (robots.txt and the served HTML, `FETCHER_LIMITS`);
  - `checks` (user-started checks, per-origin queues of their own, `CHECKS_FETCHER_LIMITS`).

  An audit's requests never wait behind a 500-link check (`audit-never-waits-behind-a-link-check`);
  a priority within one queue would not do, as it cannot take back a slot a running check holds for
  up to 10 s. The served HTML and the checks send the same render-profile user agent. The integration
  also fixed the body cap: a body that exactly fills it is `truncated` only if another chunk follows
  (a gzip bomb used to pass as a complete 50 MB sitemap).
- **One private-address check** (Task 2 review, `specs/private-address.spec.ts`), shared by the
  fetcher and the palette's "Open in", which first had checks of their own:
  - every reserved IPv4 and IPv6 range (carrier-grade NAT `100.64.0.0/10` included), IPv4-in-IPv6
    forms judged by their IPv4 address, local-only names, trailing dots;
  - names are resolved on the browse session before each hop (`netResolver`,
    `session.resolveHost`), and any private answer refuses the hop unless the page is on a private
    host. Phase 2 checked literal hosts only;
  - an e2e seam, `--frost-e2e-public-hosts`, exempts the loopback test sites' names in unpackaged
    builds. Packaged builds refuse it, and `--host-resolver-rules` (Task 4 review), in
    `PACKAGED_FORBIDDEN_SWITCHES`.
- **Three analysis workers of one bundle**, one job table (each kind with its refusal reason and
  payload):
  - the audits' worker: `audit`, `speed` and `robots` (the drawer's verdicts);
  - `served` in the served HTML's own worker (Task 2 review, `SERVED_PARSE_LIMITS.timeoutMs`,
    1.5 s), so a hostile page ended there never restarts the audits' worker;
  - `checks` in the checks' own worker (`CHECKS_ANALYSIS_TIMEOUT_MS`, 20 s), so a 50 MB sitemap
    never holds an audit back.
- **Local storage.** Migrations `0003` (`render_profile_pins`), `0004_seo_content_notes` (target
  queries and drafts; renumbered from `0003` at the Batch A integration, and it creates its tables
  only if missing, so a profile that ran the pre-merge build migrates) and `0005_app_settings` (the
  search engine). Clear Browsing Data also forgets the pins (in memory too), the closed-tab stack,
  the served HTML, the drawer's logs and reveals and the link-check cache, and cancels running
  checks. It keeps the content notes unless its new checkbox (unchecked by default) is ticked, and
  keeps preferences (the search engine, the "Open in" hosts allowed).

### Task 1: render profiles
`specs/render-profile.feature.md`, `specs/render-profile.spec.ts`, `specs/render-profile.schema.spec.ts`.
- **Presets:** desktop, phone and tablet devices; frost's own, mobile, Googlebot smartphone,
  Googlebot desktop, Bingbot and custom user agents (printable ASCII, capped, rejected rather than
  cut), with matching client hints (the engine's GREASE brand, built as Chromium does); offline,
  slow 3G, fast 3G and 4G; quick profiles for the editor bar's chips and the palette.
- **CDP:** only through `render-profile-debugger.ts`, which refuses non-browse WebContents itself
  and enforces the method allowlist (`RENDER_PROFILE_CDP_METHODS`, plus `Target.setAutoAttach` with
  fixed parameters and `Runtime.runIfWaitingForDebugger` for announced child sessions only,
  `isAllowedCdpCommand`). Commands are dispatched at once, never one awaited before the next, and a
  load main starts puts the profile into effect first, so its first request carries it.
- **Cross-site frames and workers** (review): auto-attach (paused start, flat sessions) on the tab
  and every child frame. A child frame gets every command but the viewport, a dedicated worker the
  user agent and cache switch. Each is resumed once its commands answered, or after
  `CHILD_RESUME_TIMEOUT_MS`: resuming earlier leaves a cross-site frame paused for good in
  Electron 45.
- **Lifetime:** a profile stays with its tab across cross-origin navigation and goes with the tab.
  Tabs the page opens, and pages the sidebar opens from the audited page
  (`browser.openBackgroundTab` with `inherit: true`), start with it; the palette's tools, help
  pages, robots.txt and sitemaps do not (the merge fix pinned this for `browser.openTool`).
  "Pin to this site" keeps one per committed origin (`render_profile_pins`); `setRenderProfile`'s
  `pin` is optional, so quick chips and the palette leave the site's pin alone, and Reset clears it.
- **Visible state:** the editor bar has its own chrome row under the toolbar; the tab badge, the
  status chip and the page-area frame show the profile, "Reload to apply" and Reset. Main lays the
  view out inside the frame (`fitRenderViewport`, scaled down, never up).
- **Audits** (review): the profile is taken when a run's extraction starts and kept with that run's
  audit (`render-profile-audits.ts`), so an audit still shown while a newer one runs keeps its own
  label (Overview, Speed lab caveat).

### Task 3: content analysis and snippet editor
`specs/seo-content.feature.md`, `specs/seo-content.spec.ts`, `specs/seo-content.schema.ts`.
- **Content is its own rail item**, after On-Page, not an On-Page sub-section: On-Page is already
  long, and the editor needs room. Its rail dot covers the `title`, `meta-description` and `content`
  rules.
- **In the worker:** the extractor keeps the visible text it already walks (capped, with a break
  wherever the nearest block ancestor changes), and the analysis worker builds `audit.content` from
  it. The chrome only matches the user's own text (the target query, a draft's width) against what
  the worker produced. n-grams and readability are information only.
- **Matching** (review): case folding follows the page language; phrases never span punctuation,
  two headings or two URL segments; words are capped at 64 code points.
- **Widths:** a character-width table generated in Electron
  (`apps/desktop/scripts/measure-snippet-font.mjs`) and committed as data; a missing character falls
  back per grapheme (emoji and flags one em, ZWJ sequences one glyph, marks by their class).
  `title-too-wide` (warning) and `meta-description-too-wide` (info) replace `title-too-long` and
  `meta-description-too-long`. The review made the minimums widths too, so a full-width (CJK) title
  has a passing range (about 15 to 29 characters).
- **Notes:** target queries and drafts are stored locally per URL (migration `0004`). Clear Browsing
  Data keeps them (the user's own work) unless its checkbox is ticked; the panel and the palette can
  delete all of them after main's confirmation.
- **Procedures:** `content.*`, `enforceSender`-first. Copy as HTML goes through main and strips C0
  and C1 controls and writes bidi controls as character references (review).

### Task 4: command palette
`specs/command-palette.feature.md`, `specs/command-palette.spec.ts`, `specs/command-palette.schema.ts`,
`specs/open-in.spec.ts`.
- **A sheet, not an overlay:** the palette is a sheet at the top of the page column, and the page
  area below it shrinks (`browser.setPageBounds`). Rejected: hiding the view, a second view for the
  palette, and a captured image of the page. It does not open in a page column shorter than its
  minimum sheet, closes without restoring focus when the page enters HTML fullscreen, and a held
  Mod+K toggles once (review).
- **Registry and matcher:** the selection is kept as an action id, so a page changing the list
  (`pushState` adding "Go back") never makes Enter run another action than the one shown (review);
  label matches sit in a band above every keyword match; recents live in the chrome's
  `localStorage`.
- **Procedures:** copies go through `seo.copyValue` (allowlisted keys, the shown audit only); new
  `browser.pageCommand`, `browser.focusPage` and `browser.clearBrowsingData` reach the menu-only
  commands.
- **"Open in"** (changed in the review; the plan had the chrome open the URL through
  `browser.openBackgroundTab`): main builds and opens the tool URL itself (`browser.openTool`,
  `enforceSender` first, a table id only). It is offered only for public host names, sends the URL
  without credentials or fragment, and refuses a page whose main-frame response came from a
  non-public IP address (the response recorder now keeps the webRequest `ip`). Each row's label
  names the destination host; the first use of a host asks once, inline, remembered in the chrome's
  `localStorage` (a preference Clear Browsing Data leaves), and a URL with a query string says the
  query is sent. The site's robots.txt and sitemap.xml still open through
  `browser.openBackgroundTab`, on the page's own origin.

### Task 2: served HTML vs rendered DOM
`specs/seo-javascript.feature.md`, `specs/seo-javascript.spec.ts`, `specs/seo-javascript.schema.ts`,
`specs/fetcher.spec.ts`, `specs/private-address.spec.ts`.
- **A later input of the audit:** the served HTML is the audit context's `served` input, kept per
  tab document, URL and user agent, with the tab's render-profile user agent when one is in effect.
  In-flight fetches are aborted on navigation, Fetch again and Clear Browsing Data, and Fetch again
  acts on the active tab only (review).
- **Parsing:** `parse5` in the served HTML's own worker, bounded by a counting tree adapter (nodes
  and depth); the review added an attribute cap in the tokenizer, `<template>` depth, and parsing
  without scripting under a JavaScript-off profile. A parse failure makes only the comparison
  unavailable.
- **Comparison:** the diff, the verdict and five `javascript` rules are in `@app/seo-core`
  (`javascriptReport`). The plan made a title change a warning; it is `info`, like content and links
  added by JavaScript, while canonical and robots changes are warnings. A partial served page is
  compared but checks no rule. Review: a fetch redirected elsewhere (a login page for a request
  without cookies) is `unavailable` / `redirected`, not compared; CSS-hidden headings are kept apart
  by the extractor and compared with the served ones, and H1s and canonicals compare as sets, so a
  static page with a hidden `<h1>` stays identical.
- **Panel:** JavaScript is its own rail panel (the last), with "Fetch again"
  (`javascript.refetchServed`) and two palette actions.

### Task 5: SEO devtools drawer
`specs/devtools.feature.md`, `specs/devtools.spec.ts`, `specs/devtools.schema.ts`.
- **Layout and toggle:** a band under the workspace (see Chrome rows), sized by an SVG strut's
  `height` attribute (never `style=`), resizable from its top edge (mouse and keyboard); open,
  height and tab per window in `localStorage`. Toggled by `Mod+Shift+D` (reserved), View › SEO
  Devtools and the palette; main bumps `BrowserState.devtoolsToggleSeq`.
- **Recording:** always on, from a new `observeRequests` subscriber of `web-request.ts` (observers
  only). Full (2,000 per document) while any window has the drawer open (`devtools.setOpen`),
  otherwise a ring of the newest 100 plus the document request; "Preserve log" per tab. Rejected:
  recording only while open (the load that made you open it would be lost) and a full log for every
  tab. Secret headers are stored only as `•••`, other headers are allowlisted, bodies are never read.
- **Byte budgets** (review): 4 MB per tab and 32 MB in all, headers at most half a tab's budget, 16
  response headers; what does not fit is counted and shown. `devtools.network` sends rows without
  headers, only those changed since the chrome's cursor (paged), and `devtools.requestHeaders`
  fetches one row's headers when it is opened.
- **Tabs:** robots.txt verdicts for the page origin's crawlable requests are decided in the audits'
  worker (`robots` jobs) from the robots.txt fetcher's answer, and the third-party flag reuses
  `isThirdParty`. Redirects come from the response recorder, with each hop's key headers from the
  drawer's recorder. Console deduplicates and caps. Storage masks cookie values; a Reveal lasts until
  the tab's next committed navigation, stamped with that document. "Clear this site's data" is
  confirmed in main's dialog, one at a time (a second origin answers `busy`), and clears that origin
  from the browse partition. Per-origin storage usage is not shown (planned; Electron has no cheap
  figure without running script in the page).
- **Lifecycle** (review): the log, the console and the Reveals reset when a navigation commits
  (`did-navigate`), not when one starts, so a `204` wipes nothing. An evicted watch answers `-1` and
  the chrome backs off.
- **Procedures:** `devtools.watch` (a version long-poll), `network`, `requestHeaders`, `redirects`,
  `console`, `storage`, `revealCookie`, `clearSiteData`, `setOpen`, `setPreserveLog`, all
  `enforceSender`-first and serving only the active tab.

### Task 6: browser polish
`specs/browser-polish.feature.md`, `specs/browser-polish.spec.ts`, `specs/browser-polish.schema.ts`.
- **Shortcuts:** Mod+F and Mod+Shift+T are new `RESERVED_TAB_SHORTCUTS` entries; Mod+G /
  Mod+Shift+G are reserved only while the active tab's find bar is open; Mod+Y is a menu
  accelerator only, as Ctrl+Y is redo in a page's text field on Linux and Windows.
- **Find:** main keeps each tab's bar (`find.ts`), runs `findInPage` and reports the active tab's
  in `BrowserState.find`; a new document closes it.
- **Reopen closed tab:** up to 20 tabs in memory (`history-closed-tabs.ts`), restoring the back /
  forward entries with `navigationHistory.restore` (URL and title only) and the tab's own render
  profile; a tab whose page closed itself reopens at its URL.
- **History:** a sheet that fills the page column (the view is laid out zero-high while it shows),
  keyset-paginated 100 at a time. "Clear all history" asks in main and clears the visits and the
  closed-tab stack, the history part Clear Browsing Data also clears.
- **New-tab page:** "Jump back in" shows up to 4 most-visited and 4 recent pages as frost-drawn
  monogram tiles.
- **Search engine:** chosen in the command palette ("Search with …"), not in settings: there is no
  settings view yet. Stored in `app_settings`; `SEARCH_ENGINES` is the typed table and
  `SEARCH_URL_TEMPLATE` stays as the default's. The `g ` / `b ` / `d ` prefixes always search, the
  context menu's search follows the engine, and lone surrogates become U+FFFD before encoding
  (review).
- **Procedures:** new `find.*`, `history.*` and `settings.*` routers (`polish-router.ts`), all
  `enforceSender`-first.

### Task 7: link status, sitemap and hreflang checks
`specs/seo-checks.feature.md`, `specs/seo-checks.spec.ts`, `specs/seo-checks.schema.ts`.
- **Runs:** every check is started by the user ("Check links", "Check sitemaps", "Check return
  links", or the palette) for the active tab's ready audit, and belongs to that tab's document and
  URL: a new document, an in-page move to another URL, a closed tab or Clear Browsing Data cancels
  it. Stop keeps what it found. Results stream through `checks.watch`.
- **Link checks:** HEAD, then GET (16 KB) on 405 / 501, and for that origin's later links; HEAD 403
  / 404 also ask again with GET, trusted for that link only (review). At most 500 unique targets, 2
  per origin 250 ms apart, 6 in all, 10 s per link. Private hosts (literal or resolved) are skipped
  from a public page. Same-origin links robots.txt disallows are reported `blocked`, not fetched.
  Definite HTTP answers are cached per URL and user agent for the session; 429 and 503 are
  `temporary`, never cached or broken; "Check again" asks afresh (review). A Status column, "Broken
  only" and a `broken` highlight mode.
- **Sitemaps:** robots.txt `Sitemap:` lines or `/sitemap.xml`; gzip; 50 MB a file and a per-run
  byte budget; indexes to depth 2, 20 files, 50,000 URLs. Parsed with `saxes` in the checks' worker:
  DTDs are refused and XML depth is capped. Review: "listed" is unknown when not every sitemap was
  read; the canonical counts as the page; a guessed `/sitemap.xml` that is not there is `not-found`
  (information, not `sitemap-unreachable`); a page URL past 2,048 characters fails the run.
- **hreflang reciprocity:** up to 20 alternates' heads and `Link` headers, read in the same worker.
- **Rules:** five (`links-broken`, `links-internal-redirect`, `sitemap-page-not-listed`,
  `sitemap-unreachable`, `hreflang-no-return-link`) read the finished runs from the page context;
  `controller.rescoreAudit` re-scores the audit when a run ends.
- **Procedures:** `checks.*`, `enforceSender`-first. `saxes`' upstream ISC license is in
  `THIRD_PARTY_NOTICES` (review).

### macOS e2e timing
None of the fixes were product bugs; each test raced something macOS (or a slower runner) does
later than Linux:
- the greedy-page tests (palette, find, devtools) now wait for the page's key listener, as the URL
  commits before its inline script runs;
- the find-bar layout test polls the view's top, since the view moves only once the chrome reports
  the new page area;
- the palette's fullscreen test leaves fullscreen with Esc, which main takes mid-transition: a
  page's `document.exitFullscreen()` asked for during the macOS enter animation never settles;
- the reopen-tab test goes Back once the restored page has loaded: Back within the first
  milliseconds of the history restore's own load can crash the renderer on macOS.

### Known limits
Listed in `apps/desktop/README.md`:
- frost's own requests (robots.txt, the served HTML, the checks) are visible to the sites; a
  crawler profile sends a crawler's user agent string, from your network.
- The private-address check cannot close the DNS-rebinding window between its lookup and the
  connection (`net.request` cannot be pinned to an address), and a proxy resolves names itself.
- Render profiles do not reach service or shared workers, and a cross-site frame's `screen`
  reports the machine's screen. Whether every override survives a renderer crash was not verified.
- A served fetch without cookies may be redirected (a login page): unavailable, not compared.
- The drawer never captures bodies, keeps only allowlisted headers (16 per response), keeps a small
  ring while closed, and shows no per-origin storage usage.
- Reopen restores URL, title and history only (no scroll or form state); on macOS, Back in the
  first milliseconds of the restore's load can crash the renderer.
- Find in page lets a page tell where a match is (scrolling, `beforematch`), never the text.
- Readability is English only; stop-words cover English, Spanish, French and German.
- The search engine is chosen in the palette until a settings view exists; Mod+Y is not reserved.

## Self-review notes
- **Covered:**
  - render profiles (1);
  - JavaScript dependency (2);
  - content and snippets (3);
  - palette (4);
  - devtools (5);
  - browser table stakes (6);
  - link, sitemap and hreflang checks (7).
- **Moved to other phases (design §4):**
  - SERP composition and search parameters → Phase 3;
  - Search Console → Phase 4;
  - agent customisation → Phase 5;
  - screenshots, projects and DOM inspector → Phase 6.
- **Out of scope:** web suggestions in the palette; AI search engines in the address bar; teams and
  API keys; themes.
