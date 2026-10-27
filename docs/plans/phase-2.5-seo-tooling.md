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
- A second bounded fetcher, sharing the robots.txt fetcher's rules, reads served HTML, link statuses
  and sitemaps.

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
    render-profile module and the devtools drawer's recorder.
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
- As built (`specs/render-profile.feature.md`, `specs/render-profile.spec.ts`):
  - presets: desktop, phone and tablet devices; frost's own, mobile, common crawler and capped custom
    user agents with matching client hints; offline, slow 3G, fast 3G, 4G;
  - CDP goes only through `render-profile-debugger.ts`, which enforces the method allowlist and is
    the one module the Semgrep rule `debugger-outside-allowlisted-modules` allows;
  - a profile stays with its tab across cross-origin navigation, is inherited by tabs it opens, and
    goes with the tab; "Pin to this site" keeps one per origin (`render_profile_pins`, migration
    `0003`), and Clear Browsing Data forgets the pins;
  - the editor bar has its own chrome grid row under the toolbar, so nothing is drawn over the tab's
    view; the tab badge, status chip and page-area frame show the profile, "Reload to apply" and Reset;
  - audits record the profile they ran under (Overview, Speed lab caveat).
- [x] Spec → red → green → commit `feat(browser): per-tab render profiles`

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
- As built (`specs/seo-content.feature.md`, `specs/seo-content.spec.ts`):
  - Content is its own rail item, after On-Page (the rail has ten panels);
  - the extractor keeps the visible text it already walks (capped, with block breaks), and the
    analysis worker builds `audit.content` from it; n-grams and readability are information only;
  - widths come from a character-width table generated in Electron
    (`apps/desktop/scripts/measure-snippet-font.mjs`) and committed as data;
  - `title-too-wide` (warning) and `meta-description-too-wide` (info) replace `title-too-long` and
    `meta-description-too-long`; the minimums became widths in the review (so CJK titles have a passing range);
  - target queries and drafts are stored locally per URL (migration `0004_seo_content_notes`,
    renumbered from `0003` at integration). Clear Browsing Data keeps them (the user's own work)
    unless its unchecked-by-default checkbox is ticked, and the panel and palette can delete all of them;
  - `content.*` procedures are `enforceSender`-first; Copy as HTML goes through main.
- [x] commit `feat(seo): content analysis and snippet editor`

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
- Decisions (`specs/command-palette.feature.md`, `specs/command-palette.spec.ts`):
  - the palette is a sheet at the top of the page column, and the page area below it shrinks: the
    tab's view (drawn above the chrome's DOM) is laid out below it through `browser.setPageBounds`;
  - other features add actions with one `registerPaletteActions(...)` call in their own file;
  - copies go through `seo.copyValue` (allowlisted keys, the shown audit only);
  - new `browser.pageCommand` / `focusPage` / `clearBrowsingData` procedures reach the menu-only
    commands;
  - "Open in" is offered only for public hosts and sends the URL without credentials or fragment.
- [x] commit `feat(chrome): command palette`

**Batch A integration (as built).**
- Merged into `phase-2.5/seo-tooling` in the order palette, render profiles, content.
- Chrome rows: tab strip, toolbar, permission prompt, render-profile editor bar, workspace, status
  bar. The palette's sheet sits at the top of the workspace's page column, above the page area.
  The page area's measured bounds (`setPageBounds`) leave room for all of them, and the
  render-profile frame insets the view within it.
- Render profiles and Content register their own palette actions (`render-profile-palette.ts`,
  `content-palette.ts`). Content owns its panel jump (`FEATURE_PANEL_JUMPS`).
- [x] commit `feat(chrome): palette actions for render profiles and content`

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
- [ ] commit `feat(seo): served vs rendered comparison`

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
- As built (`specs/devtools.feature.md`, `specs/devtools.spec.ts`, `specs/devtools.schema.ts`):
  - a band at the bottom of the page column (the page area shrinks above it through
    `setPageBounds`), sized by an SVG strut's `height` attribute, resizable from its top edge (mouse
    and keyboard), clamped to keep the page in view; open, height and tab per window in
    `localStorage`. Toggled by `Mod+Shift+D` (reserved in `before-input-event`), View › SEO Devtools
    and the palette (`devtools-palette.ts`); main bumps `BrowserState.devtoolsToggleSeq`;
  - recording decision: always on, from a new `observeRequests` subscriber of `web-request.ts`
    (observers only); full (2,000 per document) while any window has the drawer open
    (`devtools.setOpen`), otherwise a ring of the newest 100 plus the document request. "Preserve
    log" per tab; secret headers stored only as `•••`, other headers allowlisted, bodies never read;
  - robots.txt verdicts for the page origin's crawlable requests are decided in the analysis worker
    (a `robots` job) from the robots.txt fetcher's answer; the third-party flag reuses
    `isThirdParty`;
  - Redirects come from the response recorder, with each hop's key headers from the drawer's
    recorder; Console deduplicates and caps; Storage masks cookie values, Reveal lasts until the
    tab's next navigation (kept in main), "Clear this site's data" is confirmed in main's dialog and
    clears that origin from the browse partition. Per-origin storage usage is not shown (Electron
    has no cheap figure);
  - procedures `devtools.watch` (a version long-poll), `network`, `redirects`, `console`, `storage`,
    `revealCookie`, `clearSiteData`, `setOpen`, `setPreserveLog`, all `enforceSender`-first.
- [x] commit `feat(chrome): SEO devtools drawer`

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
- [ ] commit `feat(browser): find, reopen tab, history, search engines`

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
- [ ] commit `feat(seo): link status, sitemap and hreflang reciprocity checks`

### Task 8: Release check
- [ ] Mac `verify:mac`, full e2e on macOS and Linux, Mac screenshots of the new surfaces, README and
  plan "As built". Commit `docs: phase 2.5 seo tooling`

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
