# Phase 11 — Practitioner tooling Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. **Security-focused review:** Task 4 (web-storage script, HAR), Task 5 (page and
> served source in the chrome), Task 6 (CDP allowlist, a blocking listener on the browse session,
> the CSS-off script), Task 7 (pixels from the chrome into the screenshot store), Task 9 (the agent
> broker reading other tabs) and Task 12 (diagnostics export). Do not commit unless the lead asks.
> Steps use checkbox (`- [ ]`) syntax.

**Goal** (what a user can do when this phase ships):
- Outline **internal** or **external** links only, **lazy images**, a **keyphrase** from the Content
  panel's n-grams, or **everything at once** on the page.
- Copy **24 page values** (clean URL, root domain, headings outline, OG/Twitter tags, canonical and
  hreflang markup, response headers, JSON-LD …) and copy **images, missing-alt, headings and speed**
  tables as CSV, from panels, the palette and the page's context menu.
- See a fuller **result preview**: site name, a favicon placeholder, schema breadcrumb, date and
  rating, plus Top Stories, Video and Recipe variants; copy the page's JSON-LD or a suggested one.
- **Export the network log** as HAR or CSV (stated in the file: no bodies), view a site's
  **local and session storage**, **search the Inspector** and read the **served and rendered source**.
- **Annotate a screenshot** (arrow, box, text, crop) and save it as a new screenshot; the original stays.
- Turn **CSS off**, **cookies off**, or **override browser geolocation** for a tab (tab-local
  emulation beside its render profile).
- **Search, rename and archive** agent chats, and **@-attach other tabs** to a chat.
- **Resize** the SEO sidebar and agent panes, **pin/unpin** sidebar panels, set **history retention**,
  filter history by project with change counts, and clear it by time range.
- Use a **Help** menu, a **keyboard shortcuts** screen, **What's New**, a **setup checklist** on the
  new-tab page, and **Export Diagnostics…** to attach to a bug report.

**Spec sources**
- `docs/research/serplens-gap-analysis.md`: §2 rows SL-001, 005, 007, 011, 013, 014, 022, 047, 048,
  051, 053, 054, 056, 057, 058, 100, 106, 107, 116, 117, 118, 125, 126, 130; §3.2 backlog #6, #7, #8,
  #10, #13, #14, #18; §3.3 Wave 4; §6 Uncertainties. The competitor audit
  (`serplens-surfaces-and-features.md`) is a requirement source only (clean-room).
- Existing specs this phase extends: `seo-sidebar.spec.ts` (`HIGHLIGHT_MODES`, `HIGHLIGHT_PANELS`,
  `HIGHLIGHT_STYLES`, `SIDEBAR_PANEL_WIDTH`, `LINKS_CSV_COLUMNS`, `CSV_FORMULA_PREFIXES`),
  `seo-snapshot.spec.ts` (`SeoHighlightInputSchema`), `seo-limits.spec.ts`,
  `command-palette.spec.ts` (`COPY_VALUE_KEYS`, `COPY_VALUE_LABELS`), `page-commands.spec.ts`
  (`CONTEXT_MENU_LABELS`), `seo-content.spec.ts` (snippet section), `devtools.spec.ts` /
  `devtools.schema.ts` (`NETWORK_LIMITS`, `SECRET_HEADERS`, `StorageAnswer`, `STORAGE_USAGE_NOTE`),
  `inspector.spec.ts` / `inspector.schema.ts`, `seo-javascript.spec.ts` (`SERVED_FETCH_LIMITS`),
  `render-profile.spec.ts` / `render-profile.schema.spec.ts` (`RenderProfile`,
  `RENDER_PROFILE_CDP_METHODS`), `screenshot.spec.ts` / `screenshot.schema.ts`, `capture-db.spec.ts`,
  `agent-data.spec.ts`, `agent-ipc.schema.ts`, `agent-session.spec.ts`, `agent-tools.spec.ts`,
  `agent-page-tools.spec.ts` (`NON_AGENT_WORLD_IDS`),
  `agent-protocol.schema.ts` (`AGENT_PROTOCOL_VERSION`), `agent-panel.spec.ts`,
  `browser-polish.spec.ts` (history), `account-settings.spec.ts` (`SETTINGS_SECTIONS`),
  `telemetry-privacy.spec.ts` (scrubbing), `ci-gates.feature.md`, `semgrep/debugger-allowlist.yml`.
- Depends on `docs/plans/phase-8-ai-complete.md` Task 2 (`planTextHighlight`, mode `sentences`)
  and on the `AGENT_PROTOCOL_VERSION` bumps of Phases 8 and 9; see Dependencies.

## Where the gap analysis is inaccurate against the code (plan against the code)
- **SL-053 "no breadcrumb":** the snippet editor already draws a URL breadcrumb (`breadcrumb()` in
  `renderer/content-view.ts`, used by `SnippetEditor.tsx`) and a neutral `SiteGlyph`; `og:site_name` is
  already extracted (`seo-core/src/social.ts`, `siteName`). Missing: a schema-derived trail and
  showing a site name, date or rating.
- **§3.3 "`M/seo/` (highlight, copy)":** the copy procedures are on the browser controller's SEO
  service (`main/browser/controller.ts`: `copyLinksCsv`, `copyValue`, `copySchemaJson`) and the
  `seo` router lives in the hub `packages/ipc-contract/src/router.ts`, not under `main/seo/`.
- **#13 "add cookie blocking to the CDP allowlist":** no allowlisted-style CDP method stops a tab's
  HTTP cookies. `Emulation.setDocumentCookieDisabled` covers `document.cookie` only; the `Fetch`
  domain would read every request (an observing domain, which `RENDER_PROFILE_CDP_METHODS` forbids).
  There is also **no CDP switch for "CSS off"** without enabling the `DOM`/`CSS` domains. And
  `browser/web-request.ts` states that no blocking listener is installed on the browse session.
- **"update the Semgrep debugger-allowlist rule":** the rule allowlists **modules**, not methods;
  the method list is `RENDER_PROFILE_CDP_METHODS`. Adding methods needs no new module in the rule.
- **SL-106/116:** `recent_visits` keeps one row per URL (its last visit), so "clear by date range"
  can only act on last-visit time.
- **Page-integrity statements live in the specs, not the READMEs:** `devtools.spec.ts` (header: the
  drawer "never runs script in a page and never edits a page's DOM"), `devtools.feature.md` ("Read-only
  by design. No script runs in the page for the drawer …") and `STORAGE_USAGE_NOTE`; the gap
  analysis §5 "Page integrity" row repeats them. Tasks 4 and 6 reword them as spec work.

## Decisions
1. **All new copies and CSVs are written by main from data main holds** (the existing
   `seo.copyLinksCsv` pattern): from the tab's ready audit the panel shows (`SeoAuditRefSchema`;
   stale → nothing written), through Electron's `clipboard` in main, CSV cells through `csvCell` and
   `CSV_FORMULA_PREFIXES`. `sameAudit` (today a local function in `controller.ts`) moves to a new
   shared `main/seo/audit-ref.ts`. The native **context menu** has no chrome ref: main builds it from
   the tab's ready audit at the click and remembers that audit's `takenAt`; an item runs only if the
   tab's ready audit still has that `takenAt` (else nothing is written). The **speed CSV** exports
   the audit's own `performance` report (bound by the audit ref like the rest; `null` → nothing);
   exporting the live measurement is cut. The new CSV procedures live in a **new router** `seoExport`
   (`packages/ipc-contract/src/seo-export-router.ts`), registered with one line, not in the hub's
   `seoRouter`. *Rejected:* the chrome building CSV and writing the clipboard (it has no clipboard
   permission, and main would trust a chrome string). Independent of Phase 10's rank CSV (lead ruling).
2. **Copy values grow from 7 to 24**, all from the ready audit through `copyValueOf`
   (`seo-core/src/copy-values.ts`); nothing is fetched again. New keys (append-only):
   `clean-url`, `origin`, `root-domain` (`registrableDomain`), `title-with-url`, `h1-with-url`,
   `headings-outline`, `og-tags`, `twitter-tags`, `word-count`, `canonical-html`, `hreflang-html`,
   `x-robots-tag`, `response-headers` (the audit's kept headers, secrets masked), `sitemaps` (the
   robots.txt `Sitemap:` lines the audit read), `all-schema-json`, `internal-urls`, `external-urls`.
   Markup values are escaped exactly as `content.copySnippetHtml` escapes. *Rejected:* "all response
   headers" (the audit keeps an allowlist only).
   **Backlink shortcuts (gap analysis §4 Backlinks (a), SL-012; lead ruling):** the palette's "Open
   in" table (`OPEN_IN_TEMPLATES`, `specs/command-palette.spec.ts`) gains entries for the public
   backlink pages of Ahrefs, Semrush and Majestic. They are data only: a fixed `https:` origin, path
   and URL parameter on the existing `browser.openTool` / `openInUrl` path, with its per-host
   first-use consent and refusals unchanged; names only, no logos (clean-room). Each entry ships only
   if, at implementation time, the vendor's public page takes the page or domain as a URL parameter
   (verified by hand, recorded in the spec comment); one that needs a sign-in or a path-embedded URL
   is left out with that reason. Backlink data itself stays with Phase 8's MCP presets.
3. **Highlights reuse Phase 8's text-range painter (lead ruling).** New `HIGHLIGHT_MODES` (append):
   `internal`, `external`, `lazy-images`, `keyphrase`, `all` (links + headings + images). Box modes
   reuse `planHighlight`; `internal` and `external` reuse the existing `HIGHLIGHT_STYLES` link kinds
   and keep today's rule that a `nofollow` link draws as `nofollow` (an internal nofollow link shows,
   as `nofollow`, under `internal`). `keyphrase` reuses Phase 8's `planTextHighlight` (in
   `main/seo/highlight.ts`), extended with an "every whole-word occurrence, capped" option, never a
   second painter. As with `sentences`, **main supplies the text to find**: the chrome names a phrase,
   main accepts it only if it is one of the tab's ready audit's n-grams (`audit.content`) or the
   page's stored target query, else `false`. *Rejected:* wrapping matches in `<mark>` (changes the
   page's DOM); painting any string the chrome sends.
4. **SERP preview facts are a pure function of the audit** (`seo-core`, new
   `content/serp-preview.ts`): site name (WebSite `name` → `og:site_name` → host), breadcrumb (first
   BreadcrumbList trail → today's URL breadcrumb), date (Article family `datePublished` →
   `dateModified` from the schema report → `article:published_time`), rating (AggregateRating),
   video and recipe facts. The audit does not read `article:published_time` today: Task 3 appends
   `article:published_time` and `article:modified_time` to `SOCIAL_TAGS` (`seo-limits.spec.ts`),
   which the extractor and the snapshot schema follow; `changes/snapshot.ts` picks named keys, so
   change-tracking identity is unchanged.
   Favicon stays a frost-drawn placeholder (no remote fetch, as `SOCIAL_REMOTE_IMAGES = false`). Rich
   variants (Top Stories, Video, Recipe) are frost's own text cards, labelled as approximations.
   Editor toggles and a site-name override are **session-only**; drafts still store title and
   description only (no migration). "Copy JSON-LD" writes either the page's own blocks that fed the
   preview or a **suggested** minimal JSON-LD main builds from validated fields (`<` written as
   `<`). *Rejected:* storing preview extras per draft (a new column for a cosmetic choice; deferred).
5. **Network export is HAR 1.2 or CSV, saved by main** in its own save dialog (the
   `agent/dialogs.ts` pattern), active tab only (`DEVTOOLS_TAB_SCOPE`). Built from the log as kept:
   rows and headers exactly as stored (allowlisted, `SECRET_HEADERS` masked `•••`), **never a body**
   (none is ever read). The HAR's `log.comment` and each entry's `response.content.comment` say so, and
   the log comment states `dropped` / `notKept` / `overBudget`. **Known sensitive parameters are
   redacted, best effort** (lead rulings). One function (`redactExportUrl`, `devtools/url-redact.ts`)
   runs over **every URL the export carries**, each named in the spec (`EXPORT_URL_PLACES`): the
   request URL (HAR `request.url`, CSV URL), HAR `request.queryString[]` (rebuilt from the redacted
   URL, so it restates only redacted values), `redirectTo` / HAR `response.redirectURL`, the page URL
   (HAR `pages[].title`), and the URL values of the kept `referer` request header and the `location`
   and `link` response headers (every `<…>` URL in a `link` value). What it does:
   - drops URL user info and the **fragment** (`#access_token=…` and the like never leave);
   - replaces with `REDACTED_VALUE` the value of a query parameter whose name is on the denylist
     (`EXPORT_REDACTED_QUERY_PARAMS`: `token`, `access_token`, `id_token`, `refresh_token`, `key`,
     `api_key`, `apikey`, `access_key`, `client_key`, `x-api-key`, `x-amz-credential`,
     `x-amz-signature`, `code`, `state`, `session`, `sessionid`, `sid`, `auth`, `password`, `passwd`,
     `secret`, `signature`, `sig`, `csrf`, `xsrf`, `nonce`, `otp`, `ticket`, `credential`, `email`)
     or whose lower-cased name contains a fragment of `EXPORT_REDACT_NAME_FRAGMENTS` (`token`,
     `secret`, `session`, `auth`, `pass`, `key`, `csrf`, `xsrf`, `nonce`, `credential`, `signature`),
     **whatever the value's length**;
   - replaces any value that, **after percent-decoding**, contains an email-shaped part, or is a
     long opaque run (≥ 32 base64/hex characters) or JWT-shaped (`EXPORT_REDACT_VALUE_PATTERNS`).

   It is a heuristic: a secret under an unknown name, or in a path segment (`/reset/<token>`, webhook
   paths), is not caught. So frost never claims the file "contains no secrets": the HAR `log.comment`,
   the CSV's first line and the Export menu all say `EXPORT_URLS_REDACTED_NOTE` ("Known sensitive
   URL parameters were redacted, best effort. Review the file before you share it."). The name
   fragments also catch some ordinary parameters (`keyword`, `author`, `passage`, `state=open`);
   the Export menu's hint says some harmless values may be redacted too (`ordinary-params-kept`
   documents which are kept). *Rejected:*
   reading bodies through the CDP `Network` domain (observing; outside the allowlist; memory);
   exporting URLs as recorded with only a disclosure; redacting path segments (too many false positives).
6. **Local/session storage is read by a read-only isolated-world script** in a new world
   `DEVTOOLS_STORAGE_WORLD_ID = 1_700`, top frame only, and only when the Storage tab's Refresh (or
   its opening) asks. By default it returns **key names and value sizes only**; a value crosses into
   main only for one key the user explicitly reveals (a second call reading that key alone), stamped
   with the tab's document like cookie reveals, and is never kept (each answer reads again, as
   cookie values). The same script reads `navigator.storage.estimate()`, so `STORAGE_USAGE_NOTE` is
   replaced by a number. Read-only: no edit or delete ("Clear this site's data" exists). This
   contradicts the drawer's "no script runs in the page" invariant, which Task 4 rewords as spec
   work under its security review. *Rejected:* CDP `DOMStorage` (observing domain); returning every
   value for main to mask (up to 2 × 500 × 4 KB of secrets in main per refresh); editing values.
7. **Inspector search and sources.** Search (text or CSS selector) runs in `INSPECTOR_WORLD_ID`,
   answers `NodePath`s, bounded. **Rendered source** = the document's doctype + `outerHTML`,
   serialised in that world, capped. **Served source** = the analysis worker decodes the bytes it
   already parses (`served-parse.ts`) and returns capped text with the parse; main still never
   decodes. Phase 12's crawl job parses with `ServedParseInput.skipExtraText: true` (Phase 12 Task
   6b), so crawl results carry no `sourceText`. Both are shown as inert text lines; "Copy source" is written by main. *Cut:* a source
   Diff view (the JavaScript panel's field diff covers the SEO-relevant differences).
8. **The extras are tab-local emulation, not part of `RenderProfile` (lead ruling).** CSS off,
   cookies off and geolocation are a separate per-tab value, `TabOverrides` (new, in
   `render-profile.spec.ts`; `TabOverridesSchema` in `render-profile.schema.spec.ts`), held by main
   for the tab and shown in `TabState`. They are **not** in `RenderProfile` / `RenderProfileSchema`,
   so they never reach pins, project profiles, `laneKeyFor` (`changes/snapshot.ts`), `storableProfile`
   (`db/values.ts`), captures or sync in this phase: an older install syncing a project never sees an
   unknown field, and existing lane keys are untouched by construction. They end when the tab closes
   and are not pinned to a site.
   - **One merged command list per tab** (lead ruling). `render-profile.ts` owns, per tab, a single
     list built from the effective profile **and** the `TabOverrides` and sends it whole through
     `ProfileDebugger.send`, so the debugger's child-frame share (`childFrameCommands`) and its
     re-attach after a Chromium-initiated detach always restore **both**. `apply()` and Reset
     (`clear()`) detach only when the profile is default **and** the overrides are default; a profile
     change re-sends the merged list (overrides kept), and an overrides change re-sends it too
     (profile kept). `tab-overrides.ts` holds state and asks `render-profile.ts` to re-apply; it never
     talks to the debugger itself.
   - **Naming.** `render-profile.ts` already uses `emulation` for the viewport fit
     (`RenderFit['emulation']`, `entry.emulation`, `sameEmulation`, the `{ emulation }` option of
     `renderProfileCommands`). The new value is therefore `TabOverrides`, held as
     `entry.tabOverrides` and passed as a `tabOverrides` option, never `emulation`.
   - **The two guards that stop an overrides-only tab today** change: `apply()`'s
     `if (!effective) { detach }` branch (`render-profile.ts:175-176`) and the `!entry.effective` early
     return in the Chromium-detach handler (`:149`) both become "neither a profile nor overrides".
   - **The audit stamp is a separate field** (lead ruling). Main records the tab's `TabOverrides`
     with **every** audit, whether or not a render profile is set, in its own WeakMap next to the
     `withAuditProfiles` one, read by `overridesOf(audit): TabOverrides`, a second member of the
     `AuditProfiles` interface beside `profileOf` (`render-profile-audits.ts:11-16`).
     `renderProfile`, `AuditRenderProfile`, `auditProfile()`, `recordedProfile` and `laneKeyFor` are
     unchanged, so a capture's lane is never touched by the stamp.
   - **How the stamp reaches its consumers.** `overridesOf` is a main-side WeakMap lookup, so the
     stamp travels on the ready `seo.getAudit` answer, the same way `renderProfile` does: the ready
     variant of `SeoAuditResponse` (`packages/seo-core/src/types.ts:121`) gains one optional field,
     `tabOverrides?: TabOverrides` (type from `render-profile.spec.ts`, imported like
     `AuditRenderProfile` at `types.ts:1`; the doc comment at `:114-118` names it). The controller
     fills it in `seo.getAudit` at `controller.ts:1092`, beside `renderProfile`:
     `tabOverrides: auditProfiles?.overridesOf(response.audit)`. Absent means all off (every audit
     this build takes records one). The changes service reads it from `tabs.getAudit(tabId)`
     (`changes/service.ts:31`) and the renderer reads it from the response it already passes to
     `AuditProfileNote` (`SeoSidebar.tsx`, the
     `<AuditProfileNote renderProfile={response.renderProfile ?? null} />` line; its line number moves
     with uncommitted sidebar work, so it is cited by content).
   - **Capture refuses on the stamp, the live state or the document marker:** Capture now refuses
     with `tab-emulation-on` when the stamp on the audit being captured (`response.tabOverrides`)
     **or** the tab's live overrides show any override on, **or** the tab's document carries the
     "loaded under overrides" marker (below). Message (new in `changes.spec.ts`
     `CAPTURE_REFUSAL_MESSAGES`): "This tab has CSS, cookies or location changed. Set them back to
     normal, reload the page, then capture it." Both halves are needed:
     - *Stamp:* overrides turned off after the audit do not let that audit be captured (reloading
       re-audits under the normal state).
     - *Live:* `captureTab` (`changes/service.ts:166`) does not use only the audit. After
       `readyTab` it extracts the regions from the live page (`deps.extract(contents)`, `:195`), and
       `regions.ts:105-107` decides membership by `checkVisibility()` and computed `display`, which
       CSS off changes. Switching CSS off after a clean audit does not re-audit, and `readyTab`
       (`:150`) only checks `takenAt <= loadedAt`. Without the live half, a clean audit plus regions
       read from a stylesheet-less page would land in the normal profile's lane (the lane key
       ignores overrides), and the next normal capture would diff against it as spurious region
       changes.
     The live value comes through the service's existing `tabs` dependency: `ChangesTabs`
     (`changes/service.ts:27-34`) gains the same narrow optional member as `ScreenshotTabs`,
     `overridesOn?(tabId): boolean`, absent means off (the fake at `changes/__tests__/service.test.ts:73-78`
     keeps compiling). `changesTabs()` (`changes/service.ts:373-387`, called from
     `changes-main.ts:34`) fills it from `browser.getState().tabs`'s public `TabState.tabOverrides`.
     The check runs in `readyTab`, so it is made both before the extraction and again after it
     (`:205`), and an override turned on during the extraction is refused too.
   - **The document marker ("loaded under overrides").** Neither the stamp nor the live state shows
     a document that **loaded** under an override after the override is turned off and the auditor
     re-runs without a reload (cookies off → reload → cookies on → re-audit: the page was served
     and built without cookies, yet stamp and live both read off). So `tab-overrides.ts` keeps a
     per-tab, per-document marker, `loadedUnderOverrides`: **set** when a main-frame document loads
     (commits, or is still loading) while any override is on; **cleared only** by a later main-frame
     navigation to a new document during which **no override was on at any point between the
     navigation's start and its completion**. An override on at the navigation's start and turned
     off before it completes keeps the marker set. **Setting wins:** when the two rules meet (an
     override seen anywhere in that window), the marker is set, never cleared. Same-document
     navigations neither set nor clear it; turning overrides off never clears it. It is public as
     `TabState.loadedUnderOverrides` (`browser.spec.ts`), and `overridesOn?(tabId)` (both
     `ChangesTabs` and `ScreenshotTabs`) answers `true` while any override is on **or** the marker
     is set. Capture and screenshots refuse while it is set; the message already says "reload the
     page".
   - **Screenshots refuse on the live state and the document marker** (lead ruling, amended): a
     screenshot reads the live page, so `screenshots.take` refuses with `tab-emulation-on`
     (`SCREENSHOT_REFUSALS` and its `SCREENSHOT_REFUSAL_MESSAGES` entry) while the tab's overrides
     are on now or its document was loaded under overrides, never on the audit stamp. The screenshot
     service learns this through one narrow, optional member added to its existing `ScreenshotTabs`
     dependency (`screenshots/service.ts:42-48`), `overridesOn?(tabId): boolean`, never through the
     audits; absent (older fakes) means off. `screenshotTabs()` (`screenshots/service.ts:401-410`,
     called from `screenshots/electron.ts:35`) fills it from `browser.getState().tabs` the same way
     it already derives `renderProfileOf`.
   - **An override changed mid-capture is refused before anything is stored.** The live and marker
     checks are made at moments; a toggle between them (CSS off during a full-page screenshot's
     scroll-and-stitch) would slip through. So `tab-overrides.ts` keeps a per-tab **override
     revision**, a counter raised on every change of the tab's overrides (each `tabOverrides.set`)
     and every time the marker is set. A screenshot, and Capture now, records the revision when it
     starts and, just before persisting, refuses with `tab-emulation-on` (nothing stored, no file
     kept) if the revision changed or the marker got set since. Both services read it through one
     more narrow optional member of their `tabs` dependency, `overridesRevision?(tabId): number`
     (absent: no revision check, as older fakes), filled from `TabState.overridesRevision`.
   - **Project runs** open their own tabs with default overrides (overrides are only ever set by
     the user on a tab), so their captures and their `screenshots.take` calls
     (`projects-main.ts`) are never refused; a test pins it.
   - Audits show the overrides in the profile note (`AuditProfileNote`) from the ready answer's
     `tabOverrides` (the stamp above); `SeoSidebar.tsx` passes it with `renderProfile`.
     Making them part of a synced profile is deferred (it needs a sync schema bump).
   *Rejected:* optional fields on `RenderProfile` (an older install's strict `RenderProfileSchema`
   makes `storableProfile` drop the whole synced profile).
   - **Geolocation:** `Emulation.setGeolocationOverride` / `Emulation.clearGeolocationOverride` join
     `RENDER_PROFILE_CDP_METHODS` (tab and child frames; workers none). The page still needs frost's
     geolocation permission prompt. Browser geolocation only, **not** search/IP location (Phase 12);
     no timezone or locale override (scope cut).
   - **Cookies off:** `Emulation.setDocumentCookieDisabled` (allowlisted) **plus** HTTP cookie
     stripping by a new `browser/cookie-block.ts` that owns a blocking `onBeforeSendHeaders` /
     `onHeadersReceived` pair **on the tab's own session** (`contents.session`, never a
     `fromPartition(BROWSE_PARTITION)` lookup), **registered per session only while at least one tab
     of that session has cookies off** and acting only on those tabs' `webContentsId`s (removes
     `Cookie`, `Set-Cookie`). Cookies off applies to **every browse-class session** (lead ruling):
     today that is only the browse session; after Phase 12 Task 10a, a location tab's proxy
     partition too, whose registry lists `cookie-block.ts` as a consumer. This amends
     `web-request.ts`'s "no blocking listener" rule to "none unless a tab of that session has
     cookies off". A session's pair is removed when its last cookies-off tab closes or turns it off. Electron
     filters cannot select a `webContentsId`, so while the pair is registered **every** request of
     every tab passes through main (answered at once for other tabs); the switch's hint says
     "Slightly slows loading in all tabs while on", and the spec states it.
     On an error inside a listener the request passes through unchanged and the error is logged
     (fail-open; why, in Task 6 Green and Risks), and the hint says so.
     *Rejected:* CDP `Fetch` (reads every request), clearing cookies (the partition is shared by
     all tabs), `document.cookie` only (crawlers send no cookies; a half switch misleads).
     *Fallback:* if the spike shows header edits do not take effect in Electron 45, cookies off is
     dropped (not shipped as `document.cookie` only).
   - **CSS off:** a script in a new world `TAB_OVERRIDES_WORLD_ID = 1_701` sets `disabled` on every
     stylesheet and adopted sheet of the **top frame** and watches for new ones; inline `style`
     attributes and frames' styles stay. Isolated worlds run with JavaScript off
     (`render-profile.feature.md`, verified), so it works under that switch too (tested). The page
     can observe it, and the badge says "CSS off (stylesheets)". *Rejected:* CDP `CSS`/`DOM` domains
     (observing); blocking stylesheet requests (inline `<style>` survives and it needs a blocking
     `onBeforeRequest`). It is a stated, user-requested exception to the page-integrity statements
     (the spec sentences listed under "Where the gap analysis is inaccurate"), written into
     `render-profile.feature.md` as spec work under Task 6's security review. If the review rejects
     the exception, CSS off is dropped (Open question 1).
   - *Geolocation fallback:* if the override does not reach `getCurrentPosition` after frost's
     permission Allow in Electron 45, geolocation is dropped.
9. **Screenshot editor: the chrome draws only an overlay; main composites.** The editor works on the
   preview image; on Save the chrome renders the annotation layer alone (transparent PNG, sized to
   the crop in source pixels, no page pixels) and sends it with the op list. Main reads the source
   by hash, decodes both, checks sizes, alpha-composites (pure TS over the BGRA bitmap), crops,
   encodes, writes a **new** hash-named file and a **new** `ci_screenshots` row (same project, page,
   profile, search params, kind; `capture_id` null), plus a **local-only** `screenshot_edits` row
   (migration `0231`) linking it to its source. The source file and row never change.
   *Rejected:* the chrome sending the full composited PNG (needs the full-resolution source in the
   chrome, up to `maxPngBytes`, past `maxImageDataUrlChars`); main drawing everything (no text
   rasteriser in main without a canvas or an extra WebContents); a new `ScreenshotKind` (a CHECK
   rebuild of an append-only, synced table; `SYNC_TABLES` is exactly nine `ci_*` tables).
10. **Chat history (owned here; Phase 8 owns the skills UI).** Search over titles and user/assistant
    text in main (≤ `MAX_STORED_CHATS`, so a bounded scan, no FTS table); rename (a user title is
    never overwritten by the automatic one); archive hides a chat from the default list. Retention
    and the 50-chat cap still apply to archived chats. Migration `0230` adds two columns.
    *Rejected:* FTS5 (one more table to purge for ≤ 50 chats); archive exempt from retention
    (would keep page text longer than the user's retention choice).
11. **@-attached tabs are references read through the broker.** The user attaches up to
    `MAX_CHAT_ATTACHMENTS` (3) open web tabs to a chat; the model reads one only through a new
    catalogue tool `read_attached_tab({ ref, part: 'audit' | 'text' })` (risk `read`, grantable like
    the read tools). Main's broker resolves the ref, refuses one not attached to this chat, answers
    `expired` when the tab closed or left the URL it was attached at (fragment aside), applies the
    read-tool approval rules (always asks on non-public pages), and wraps output untrusted
    (`page:<origin>`). The system prompt names refs and origins only, never page titles. Attachments
    live in memory only.
    - **Background tabs:** `auditor.ts` audits only the active tab, so `part: 'audit'` serves the
      attached tab's last ready audit **only if its URL equals the attach URL**; otherwise it answers
      the data `{ status: 'not-ready' }` with "Ask the user to switch to that tab so frost can audit
      it" (no approval card). `part: 'text'` runs the existing page-text reader on the attached tab's
      own WebContents (in `AGENT_PAGE_WORLD_ID`, whether shown or not), with the `isExpectedPage`
      check against the attach URL.
    - **Grants and private origins** (`grantOriginFor`, `canGrant`, the private-origin check in
      `approvals.ts`) are computed from the **attached tab's** origin, never the chat tab's; the
      approval card names that origin.
    - **Cap:** `MAX_ATTACHED_READS_PER_TURN` (2 per attachment), a spec constant with a test.
    *Rejected:* pasting attached page text into the user message (untrusted text in the user role);
    letting every page tool take any tab id (the model could read any open tab, signed-in mail included).
12. **Panes and pins are chrome preferences** (`localStorage` on `app://app`, like
    `SIDEBAR_STORAGE_KEY`): drag or keyboard resize, clamped so the page keeps `PAGE_MIN_WIDTH`;
    Overview is always pinned; unpinned panels move into a "More panels" rail menu whose dot is the
    worst status it holds, and an open unpinned panel shows on the rail while open.
13. **History:** retention in `app_settings` (`forever` default, so nothing is deleted by surprise;
    `90d`, `30d`, `7d`), "Keep visits to project pages" on by default; clear by range (last hour, day,
    week, month) on `last_visit_at`; a project filter and per-URL change counts from
    `ci_project_pages` and `ci_versions` (same database file). No migration.
14. **Help and support with no network:** a Help menu (frost Help and Report an Issue open fixed
    `https://github.com/SnowOpsHQ/frost` URLs in the system browser on a menu click, through
    `resolveExternalOpen`, no data attached), a shortcuts screen from one table tested against the
    menu template, What's New from a schema-checked `release-notes.json` imported into the main
    bundle (no file read at runtime), and **Export Diagnostics…** (its own task): versions, platform,
    feature booleans and a bounded ring of main's own warnings/errors scrubbed with telemetry's
    scrubber, shown in a sheet for review, then saved by main. Never sent anywhere.
15. **Setup checklist on the new-tab page**, derived from state the chrome already reads (agent
    ready, Search Console connected, a project besides Unfiled, privacy settings opened, shortcuts
    opened); dismissible. No news or widgets (nothing remote on the new-tab page).
16. **Scope cuts and drops** (conflicts with existing specs, stated):
    - **SL-107 change-tracking exclusions — dropped.** Nothing captures automatically (scheduled or
      automatic capture is out of scope, `phase-6` plan), so an excluded-URL list has nothing to
      exclude; editable ignored parameters would change `laneKeyFor`, split lanes, and differ between
      synced devices. Revisit with Phase 10's opt-in "capture while open" timer.
    - **SL-125 "copy installation ID" — dropped:** frost keeps no install ID
      (`telemetry-privacy.spec.ts`). **"Reset session data"** — Help points to the existing Clear
      Browsing Data… instead of a second reset.
    - **SL-117 release feed** — bundled notes instead of a fetched feed. **SL-005 news/widgets** — dropped.
    - **SL-047** Diff source view, **SL-048** body search, copy-as-cURL and Response/Timing/Initiator
      tabs — cut. **SL-100** pen, circle and zoom — cut (arrow, box outline/filled, text, crop, undo/redo ship).
    - Geolocation does not change search location, timezone or locale (Phase 12 owns locations).
17. **World ids:** Phase 11 reserves `1_700`–`1_709` (`1_700` storage reader, `1_701` CSS off).
    Both join `NON_AGENT_WORLD_IDS` (`specs/agent-page-tools.spec.ts:44`), together with Phase 6's
    `1_601` (`SCREENSHOT_WORLD_ID`) and `1_602` (`INSPECTOR_WORLD_ID`), which are missing from it
    today; the existing `agent-worlds-distinct` test (`main/agent/__tests__/page-tools.test.ts`)
    keeps the agent's worlds out of the list.
    Phase 12's deferred AI-tab reader proposal reserves `1_302`; no overlap.
18. **Migrations go in one new file appended at the end (lead ruling).** `0230_agent_chat_lifecycle`
    and `0231_screenshot_edits` live in a new `packages/db/src/phase11-migrations.ts`
    (`PHASE11_MIGRATIONS`), spread **last** in `MIGRATIONS` (after `CHANGE_INTEL_MIGRATIONS` and the
    `0200`/`0210`/`0220` blocks of Phases 8–10), so `migrations-are-forward-only` (strictly
    increasing ids) holds and a fresh database applies them in id order. Not in
    `agent-chats-migrations.ts` (spread before `0032`). Merge-order rule: blocks sit in `MIGRATIONS` in
    id order. If a higher block (Phase 12's `0240`) merges before this phase, this phase rebases and
    puts `...PHASE11_MIGRATIONS` **before** that block (still after `0229`) so the array stays strictly
    increasing; the lead may instead relax the test. A database that already applied `0240` then
    applies `0230`/`0231` later, which the runner allows (it applies every id not yet recorded).
    - **Test fixture ids are above every real id** (lead ruling): Phase 8 Task 5 (the first phase
      with an id above `0101`) renames `0100_test_extra`, `0100_broken` and `0101_broken` in
      `migrations.test.ts` and `driver.test.ts` to `9000_test_extra`, `9000_broken` and
      `9001_broken` (below the existing `9999_from_the_future`). This phase only **checks** it in
      Tasks 7 and 8: the test-only ids are `9000_`/`9001_`, and `migrations-are-forward-only` and the
      `recordedIds` expectations pass with `0230`/`0231` last.

## Dependencies on other phases
- **Phase 8 lands first** (numeric order). Task 2 here needs Phase 8 Task 2's `planTextHighlight`,
  its `sentences` mode and `MAX_TEXT_HIGHLIGHT_*` limits; `HIGHLIGHT_MODES` edits are append-only.
- **Shared version constants:** Task 9 adds a tool name, which changes what `ToolNameSchema`
  (`agent-protocol.schema.ts`) accepts, so it bumps `AGENT_PROTOCOL_VERSION` to **current + 1 at
  merge time**. Phases 8, 9 and 11 all bump it and land in numeric order, so this phase rebases on
  Phases 8 and 9 and bumps once more (no hard-coded number; the repo is at `7` today). The same
  rule applies to any other shared version constant this phase touches.
- **Migrations:** Decision 18 (appended after the `0200`–`0229` blocks).
- `agent-tools.spec.ts` catalogue, `agent-proxy.spec.ts` and `seo-sidebar.spec.ts` are append-only
  here (Phases 8–10 edit them too).
- `cookie-block.ts` registers on the tab's own session (browse-class after Phase 12 Task 10a), so
  cookies off reaches Phase 12's location tabs; Phase 12 Task 10a lists it as a registry consumer and
  tests it (`cookie-block-per-browse-class-session`, `cookie-block-on-a-location-tab`).

## Global constraints
Everything in the Phase 0–7 Global Constraints and `CONTRIBUTING.md` still holds, plus:
- **IPC:** every new procedure is in `packages/ipc-contract`, starts `publicProcedure.use(enforceSender)`,
  and validates input with a Zod schema under `specs/`. Answers are schema-checked and bounded.
- **Page scripts** run only in isolated worlds (`SEO_WORLD_ID`, `INSPECTOR_WORLD_ID`,
  `AGENT_PAGE_WORLD_ID`, new `1_700`, `1_701`), are self-contained, and read only. The two
  exceptions are stated: the highlight overlay in its closed shadow root (existing), and CSS off
  toggling stylesheet `disabled` while the user asks for it. The drawer's storage reader is the one
  drawer script, run only on the Storage tab's Refresh. Every script answer is checked; the page can
  answer anything.
- **CDP** only in `render-profile-debugger.ts`, only `RENDER_PROFILE_CDP_METHODS` (plus the two
  session methods); no observing domain; only the two `Target` events are read.
- **Blocking webRequest listeners on browse-class sessions** (today the browse session) only in
  `browser/cookie-block.ts`, only on a session one of whose tabs has cookies off; a new Semgrep rule enforces the module allowlist and runs in the root
  `security:semgrep:test` / `:scan` scripts.
- **Untrusted text:** storage values, sources, search matches, copy values, preview facts, attached
  tab content and page titles are rendered as React text (`<bdi dir="auto">`), never `innerHTML`;
  agent reads are wrapped `{ untrusted: true, source, data }`.
- **Main writes clipboard and files** from data it holds, never a string from the chrome. The one
  input of bytes from the chrome (the screenshot overlay) is size-capped, decoded, dimension-checked
  and composited; it is never stored as sent.
- **Secrets:** no new secret. Exports and diagnostics never contain a `SECRET_HEADERS` value, a
  cookie or storage value (revealed or not), a key from frost's keychain, or a file path.
  **Exported URLs** (every place Decision 5 names, the `referer` and `location` header values
  included) have known sensitive parameters redacted, **best effort**: frost does not claim a
  network export holds no token or email, and the file header says so. Diagnostics carry no URL at all.
- **External links** (Help, Report an Issue, What's New release links) open only through
  `resolveExternalOpen` (`security/policy.ts`, `external-url.feature.md`): allowlisted `https:`, on
  a user gesture.
- **No network in CI tests**; e2e uses loopback pages and fakes, and stubs main's dialogs with
  `app.evaluate` (as `devtools.e2e.ts` does). No feature here fetches anything new. No new e2e seam
  is planned; one, if needed, follows `agent/e2e-seam.ts` and is refused in packaged builds.
- **Migrations:** only ids `0230`–`0239`: `0230_agent_chat_lifecycle`, `0231_screenshot_edits`,
  both in `phase11-migrations.ts` appended last (Decision 18); `0232`–`0239` unused.
- **Clean-room:** every label, prompt, preview card and help text in frost's own words.

## Team contract
- **New files only in:** `specs/seo-exports.*`, `specs/help.spec.ts`, `specs/diagnostics.spec.ts`,
  `specs/whats-new.schema.ts`, `specs/agent-attach.feature.md`; `packages/seo-core/src/exports.ts`,
  `content/serp-preview.ts`; `packages/ipc-contract/src/{seo-export,help}-router.ts` and `-service.ts`;
  `apps/desktop/src/main/seo/{exports,audit-ref}.ts`, `devtools/{network-export,web-storage,url-redact}.ts`,
  `browser/{cookie-block,css-off,tab-overrides}.ts`, `screenshots/{edit,composite}.ts`,
  `packages/db/src/phase11-migrations.ts`, `packages/ipc-contract/src/tab-overrides-router.ts`,
  `agent/tools/attached-tabs.ts`, `help/**`, `diagnostics/**`; renderer `components/seo/SerpPreviewVariants.tsx`,
  `components/changes/ScreenshotEditor.tsx`, `screenshot-editor.ts`, `components/{ShortcutsView,WhatsNewView,DiagnosticsView,SetupChecklist}.tsx`,
  `settings-history.tsx`, `export-palette.ts`, `help-palette.ts`, `sidebar-layout.ts`;
  `apps/desktop/release-notes.json`; `semgrep/webrequest-blocking-allowlist.yml` (+ fixture);
  tests beside their modules; e2e additions in the existing `*.e2e.ts` files.
- **Hub files get one-line registrations only:** `apps/desktop/src/main/index.ts`,
  `packages/ipc-contract/src/router.ts` (`seoExport`, `tabOverrides`, `help`; plus the one-argument
  change to the `setHighlight` call, Task 2) and `services.ts`, `App.tsx`, the palette registry,
  `packages/db/src/migrations.ts` (`...PHASE11_MIGRATIONS` as the **last** spread), root config
  (root `package.json` `security:semgrep:test` / `:scan`: the new rule and fixture, Task 6).
- **Shared, earlier-phase files are edited append-only** (new constants, keys, procedures; nothing
  renamed): the specs listed under Spec sources, `menu.ts`, `context-menu.ts`, `controller.ts`,
  `content-router.ts`, `devtools-router.ts`, `inspector-router.ts`, `changes-router.ts`,
  `agent-router.ts`, `polish-router.ts`.

---

## Tasks

### Task 1: Copy values and CSV exports (SL-013, SL-130)
**Purpose:** Decisions 1–2.
- [ ] **Spec:**
  - `specs/command-palette.spec.ts`: append the 17 keys of Decision 2 to `COPY_VALUE_KEYS`, a label
    each in `COPY_VALUE_LABELS`, `COPY_VALUE_MAX_CHARS` (1 000 000), and the format of each
    multi-line value (outline indented by level, `name: value` lines, one URL per line).
  - New `specs/seo-exports.spec.ts`: `SEO_EXPORT_KINDS = ['images', 'headings', 'speed']`,
    `IMAGES_CSV_COLUMNS` (URL, Alt, Alt missing, Width, Height, Declared size, Loading, In first
    viewport, Oversized), `HEADINGS_CSV_COLUMNS` (Level, Text, Order), `SPEED_CSV_COLUMNS` (section,
    metric/type, value, band; from `audit.performance`) — images take an `IMAGE_FILTERS` value, so
    `missing-alt` is the missing-alt CSV. `specs/seo-exports.schema.ts`: `SeoExportInputSchema`
    (`tabId`, `audit` (`SeoAuditRefSchema`), `kind`, `filter?`). `specs/seo-exports.feature.md`:
    scenarios below, including the context menu's staleness rule (Decision 1).
  - `specs/page-commands.spec.ts`: `CONTEXT_MENU_LABELS` += `copy-seo` ("Copy SEO Data") submenu
    holding the four most used values and the three CSVs.
  - `specs/command-palette.spec.ts`: append the backlink entries to `OPEN_IN_TEMPLATES` (Decision 2;
    `OPEN_IN_TEMPLATE_IDS` grows with them); `specs/command-palette.feature.md`: one scenario.
- [ ] **Red:**
  - `packages/seo-core/src/__tests__/copy-values.test.ts`: `copy-value-<key>` for each new key,
    `copy-value-absent-is-null`, `canonical-html-escaped`, `response-headers-masked`.
  - New `packages/seo-core/src/__tests__/exports.test.ts`: `images-csv-columns-and-filter`,
    `missing-alt-csv`, `headings-csv-order`, `speed-csv-from-audit-performance`, `csv-formula-guard`.
  - New `apps/desktop/src/main/seo/__tests__/exports.test.ts`: `export-from-shown-audit-only`
    (stale ref, other tab, no audit → nothing written), `speed-csv-null-performance-writes-nothing`,
    `writes-through-main-clipboard`.
  - New `packages/ipc-contract/src/__tests__/seo-export-router.test.ts`: `enforces-sender`, `input-bounded`.
  - `main/browser/__tests__/context-menu.test.ts`: `context-menu-copy-seo-submenu-on-web-pages-only`,
    `context-menu-copy-skips-when-audit-changed-since-the-menu-opened`.
  - `renderer/palette/__tests__/builtins.test.ts` iterates `COPY_VALUE_KEYS` (grows unchanged).
  - `renderer/palette/__tests__/open-in.test.ts` and `main/browser/__tests__/command-palette.test.ts`:
    `open-in-backlink-entries-are-fixed-https-templates` (each new entry's origin is `https://` plus
    a fixed host, the page URL goes only in its `urlParam`, and the first use asks consent for its
    host like the existing entries).
- [ ] **Green:** `packages/seo-core/src/copy-values.ts`, new `exports.ts` (reusing `csvCell`),
  `index.ts`; new `main/seo/audit-ref.ts` (`sameAudit` moved out of `controller.ts`), new
  `main/seo/exports.ts` (service over `audits.response`); `context-menu.ts` submenu; new
  `seo-export-router.ts` / `seo-export-service.ts`; `router.ts`, `services.ts` one line; renderer
  buttons in `Images.tsx`, `OnPage.tsx` (headings), `Speed.tsx`; new `export-palette.ts`.
- **Acceptance:** each value and CSV matches its spec; nothing copies from a stale audit; a cell
  starting `=` gets `'`.
- **Risks:** very large outlines or header lists (capped). Sizing: at the upper bound (~2 days).

### Task 2: Highlights — internal, external, lazy images, keyphrase, all (SL-011, SL-022)
**Purpose:** Decision 3. **Needs Phase 8 Task 2 merged.**
- [ ] **Spec:** `specs/seo-sidebar.spec.ts` (append): `HIGHLIGHT_MODES` += `internal`, `external`,
  `lazy-images`, `keyphrase`, `all`; `HIGHLIGHT_PANELS`: `internal`/`external` → `links`,
  `lazy-images` → `images`, `keyphrase` → `content`, `all` → `overview`; `HIGHLIGHT_STYLES` +=
  `lazy`, `lazy-first-viewport`, `keyphrase` (`internal`/`external`/`nofollow` reused).
  `specs/seo-snapshot.spec.ts`: `SeoHighlightInputSchema` += `phrase` (required exactly for
  `keyphrase`, 1–100 chars, one line). `specs/seo-limits.spec.ts`: `MAX_KEYPHRASE_MATCHES` (500).
  `specs/browser.spec.ts`: `TabState.highlightPhrase: string | null`. `specs/seo-panels.feature.md`,
  `seo-content.feature.md`: scenarios.
- [ ] **Red:** `main/seo/__tests__/highlight.test.ts`: `plan-internal-external-only`,
  `plan-internal-shows-nofollow-as-nofollow`, `plan-lazy-images-marks-first-viewport`,
  `plan-all-combines`, `plan-text-highlight-every-occurrence-capped` (Phase 8's planner with the new
  option), `keyphrase-whole-words-only`; `main/seo/__tests__/panels.test.ts`:
  `keyphrase-must-be-an-audit-ngram` (other phrase → `false`), `keyphrase-resets-on-navigation`;
  `main/seo/__tests__/extract-dom.test.ts`: `keyphrase-highlight-leaves-page-untouched`; renderer
  `content-view.test.ts`: n-gram row toggle.
- [ ] **Green:** `main/seo/highlight.ts` (modes; `planTextHighlight` option), `highlights.ts`
  (phrase check against the ready audit), `controller.ts` `setHighlight(tabId, mode, phrase)`,
  `router.ts` one-argument change; renderer `Links.tsx`, `Images.tsx`, `Content.tsx` (n-gram rows),
  `Overview.tsx`.
- **E2E** (`seo-panels.e2e.ts`, `seo-content.e2e.ts`): `highlight-external-only`,
  `highlight-lazy-images`, `highlight-keyphrase-from-ngram`.
- **Risks:** text-node walks on huge pages (bounded by `HIGHLIGHT_BUDGET_MS`); word boundaries for
  CJK follow the n-gram segmentation (`Intl.Segmenter`).

### Task 3: SERP preview completeness (SL-053, SL-054)
**Purpose:** Decision 4.
- [ ] **Spec:** `specs/seo-limits.spec.ts`: `SOCIAL_TAGS` += `article:published_time`,
  `article:modified_time` (the extractor, `seo-snapshot.spec.ts` snapshot schema and seo-core read
  them like the other social tags; `changes/snapshot.ts` picks named keys, so capture identity is
  unchanged). `specs/seo-content.spec.ts` (append): `SERP_PREVIEW_VARIANTS = ['standard',
  'top-stories', 'video', 'recipe']`, `SERP_PREVIEW_LIMITS` (site name ≤ 60 chars, ≤ 5 crumbs of ≤ 40),
  the fact source orders of Decision 4, `SERP_PREVIEW_NOTE` ("frost's drawing; engines decide which
  rich results show"), `SNIPPET_JSONLD_SOURCES = ['page', 'suggested']` and the suggested shape
  (`@graph` of WebSite, BreadcrumbList, WebPage with `datePublished`). Breadcrumb and site-name
  widths use the existing table at `SNIPPET_FONT.descriptionPx` with approximate budgets documented
  like `SNIPPET_BUDGETS_PX`. `specs/seo-content.schema.ts`: `CopyPreviewJsonLdInputSchema`
  (`tabId`, `audit`, `source`, `fields?` bounded). `seo-content.feature.md`: scenarios.
- [ ] **Red:** new `packages/seo-core/src/__tests__/serp-preview.test.ts`:
  `site-name-prefers-website-schema`, `site-name-falls-back-to-og-then-host`,
  `breadcrumb-from-breadcrumblist`, `breadcrumb-falls-back-to-url`, `date-from-article-schema`,
  `date-falls-back-to-article-published-time`, `rating-from-aggregate`, `video-and-recipe-facts`,
  `invalid-dates-and-ratings-ignored`, `suggested-jsonld-escapes-lt`; `packages/seo-core` social
  tests: `article-time-tags-read`; `main/seo/__tests__/content-service.test.ts`:
  `copy-jsonld-page-blocks`, `copy-jsonld-stale-audit-writes-nothing`; renderer
  `content-view.test.ts`: `preview-variant-cards`.
- [ ] **Green:** `specs/seo-limits.spec.ts` follow-through in `main/seo/extract.ts` and the snapshot
  schema; new `seo-core/src/content/serp-preview.ts`; `main/seo/content-notes.ts`
  (`copyPreviewJsonLd`); `content-router.ts`, `content-service.ts`; renderer `SnippetEditor.tsx`
  (site name, monogram placeholder, crumbs, date, rating, toggles), new `SerpPreviewVariants.tsx`,
  `content-view.ts`.
- **E2E** (`seo-content.e2e.ts`): `serp-preview-schema-facts-and-variants`, `copy-jsonld`.
- **Risks:** layouts change; the note and "Open in Rich Results Test" (existing) keep expectations honest.

### Task 4: Devtools — network export and web storage (SL-048, SL-051) — security review
**Purpose:** Decisions 5–6.
- [ ] **Spec (invariant rewording, under this task's security review):** `devtools.spec.ts` header
  ("read-only by design: it never runs script in a page and never edits a page's DOM") and
  `devtools.feature.md` "Read-only by design. No script runs in the page for the drawer …" become:
  the drawer never edits a page's DOM, and runs one script only, the read-only storage reader in
  `DEVTOOLS_STORAGE_WORLD_ID`, only when the Storage tab is opened or refreshed and for a Reveal.
  `STORAGE_USAGE_NOTE` is reworded (usage now comes from `navigator.storage.estimate()`).
- [ ] **Spec (new):** `specs/devtools.spec.ts`: `NETWORK_EXPORT_FORMATS = ['har', 'csv']`,
  `NETWORK_CSV_COLUMNS`, `HAR_NO_BODY_COMMENT`, `EXPORT_URLS_REDACTED_NOTE` (HAR `log.comment`, the
  CSV's first line and the Export menu: "best effort", never "contains no secrets"),
  `EXPORT_URL_PLACES` (`request.url`, `request.queryString`, `response.redirectURL` / `redirectTo`,
  `page`, `header:referer`, `header:location`, `header:link` (each `<…>` URL in the value)),
  `EXPORT_REDACTED_QUERY_PARAMS` (the Decision 5
  denylist), `EXPORT_REDACT_NAME_FRAGMENTS` (Decision 5), `EXPORT_REDACT_VALUE_PATTERNS`
  (email-shaped after percent-decoding; opaque runs of ≥ 32 base64/hex characters; JWT-shaped),
  `REDACTED_VALUE`, `HAR_CREATOR`, `NETWORK_EXPORT_RESULTS = ['saved', 'cancelled', 'empty',
  'failed']`, default file name; `DEVTOOLS_STORAGE_WORLD_ID = 1_700` (added to
  `NON_AGENT_WORLD_IDS` in `specs/agent-page-tools.spec.ts:44`, with the missing `1_601` and
  `1_602`; Decision 17), `WEB_STORAGE_AREAS = ['local',
  'session']`, `WEB_STORAGE_LIMITS = { maxKeys: 500, maxKeyChars: 256, maxValueChars: 4_096,
  scriptTimeoutMs: 2_000 }`, `StorageAnswer` += `webStorage` (per area: items `{ key, size, value:
  string | null }` where `value` is non-null only for the one revealed key, or `unavailable` with a
  reason) and `usage`/`quota` (numbers or `null`). `specs/devtools.schema.ts`:
  `ExportNetworkInputSchema`, `RevealStorageItemInputSchema` (`tabId`, `area`, `key`),
  `WebStorageKeysAnswerSchema`, `WebStorageValueAnswerSchema`, `HarLogSchema` (the subset frost
  writes). `devtools.feature.md`: scenarios.
- [ ] **Red:** new `main/devtools/__tests__/network-export.test.ts`: `har-has-no-bodies-and-says-so`,
  `har-masks-secret-headers`, `har-redacts-sensitive-query-params`, `har-querystring-array-redacted`,
  `har-redirect-url-redacted`, `har-redacts-referer-and-location-headers`, `har-redacts-link-header-urls`,
  `har-page-url-redacted`,
  `csv-redacts-sensitive-query-params`, `export-says-best-effort-redaction` (header text never claims
  "no secrets"), `har-matches-har-log-schema`, `har-comment-counts-dropped`,
  `csv-formula-guard`, `export-active-tab-only`, `cancelled-writes-nothing`; new
  `main/devtools/__tests__/url-redact.test.ts` (pure, one test per class): `denylisted-names`,
  `short-values-under-sensitive-names` (`csrf=ab12`, `nonce=7`, `access_key=x`), `name-fragments`
  (`x-api-key`, `client_secret`), `fragment-dropped` (`#access_token=…`), `user-info-dropped`,
  `percent-encoded-email-redacted` (`a%40b.example`), `email-inside-longer-value`,
  `long-opaque-and-jwt-values`, `ordinary-params-kept` (`q`, `page`, `utm_source`),
  `path-secrets-not-claimed` (documents the known gap); new `web-storage.test.ts`:
  `reads-in-storage-world-only`, `refresh-returns-keys-and-sizes-only`,
  `reveal-reads-one-key-and-keeps-nothing`, `reveal-stale-after-navigation`,
  `answer-validated-and-capped`, `opaque-origin-unavailable`, `script-timeout-unavailable`,
  `reader-runs-with-javascript-off`; `main/agent/__tests__/page-tools.test.ts` `agent-worlds-distinct`
  (existing, unchanged) passes with `1_601`, `1_602` and `1_700` in `NON_AGENT_WORLD_IDS`;
  `packages/ipc-contract/src/__tests__/devtools-router.test.ts`:
  `exportNetwork` and `revealStorageItem` enforce sender.
- [ ] **Green:** new `main/devtools/network-export.ts`, `url-redact.ts`, `web-storage.ts`;
  `devtools/service.ts`, `storage.ts`; `devtools-router.ts`, `devtools-service.ts`; renderer
  `NetworkPanel.tsx` (Export menu; the menu says URLs are redacted), `StoragePanel.tsx`
  (Local/Session sections with key and size, Reveal, Refresh, usage).
- **E2E** (`devtools.e2e.ts`, save dialog stubbed): `network-export-har-without-bodies-and-redacted`,
  `storage-shows-local-and-session-keys-masked`.
- **Risks:** a page can make storage reads slow (timeout → unavailable); the redaction is a
  heuristic (unknown names, path segments) and the file says so; HAR viewers' tolerance of
  body-less entries (Open question 5).

### Task 5: Inspector search and source views (SL-047) — security review
**Purpose:** Decision 7.
- [ ] **Spec:** `specs/inspector.spec.ts`: `INSPECTOR_SEARCH_MODES = ['text', 'selector']`,
  `INSPECTOR_SEARCH_LIMITS = { maxQueryChars: 200, maxResults: 200, maxNodesVisited: 50_000 }`,
  `INSPECTOR_SOURCE_KINDS = ['rendered', 'served']`, `INSPECTOR_SOURCE_MAX_CHARS` (2 000 000),
  `INSPECTOR_REFUSALS` += `invalid-selector`; answers `InspectorSearchAnswer`,
  `InspectorSourceAnswer` (served: `unavailable` with `ServedUnavailableReason`).
  `specs/inspector.schema.ts`: input/answer schemas incl. `InspectorCopySourceInputSchema`.
  `specs/seo-javascript.spec.ts`: `SERVED_SOURCE_MAX_CHARS`, `SERVED_SOURCE_KEEP` (4 documents,
  most recent); `seo-javascript.schema.ts`: the parse result's `sourceText`. Feature scenarios.
- [ ] **Red:** `main/inspector/__tests__/page-script.test.ts`: `search-text-finds-paths`,
  `search-selector-invalid-refused`, `search-capped`, `serialize-capped-and-truncated-flag`,
  `scripts-never-write-dom`; `service.test.ts`: `search-stale-doc-refused`,
  `served-source-unavailable-reason`, `copy-source-from-main`; `main/seo/__tests__/served.test.ts` (existing):
  `served-source-decoded-in-worker-and-capped`, `served-source-kept-for-four-documents`;
  renderer `inspector-view.test.ts`: `source-lines-are-text`;
  `packages/ipc-contract/src/__tests__/inspector-router.test.ts`: new procedures enforce sender.
- [ ] **Green:** `main/inspector/page-script.ts`, `service.ts`; `main/seo/served.ts`,
  `served-parse.ts`, `analysis-worker.ts`; `inspector-router.ts`; renderer
  `components/changes/Inspector.tsx` (search box, Tree / Rendered / Served toggle, line list with
  in-view find), `inspector-view.ts`.
- **E2E** (`inspector.e2e.ts`): `inspector-search-selects-node`, `rendered-and-served-source`.
- **Risks:** `outerHTML` of huge documents (cap + `scriptTimeoutMs`); worker memory for decoded text (`SERVED_SOURCE_KEEP`).

### Task 6: Tab overrides — CSS off, cookies off, geolocation (SL-007) — security review
**Purpose:** Decision 8 (tab-local; not in `RenderProfile`).
- [ ] **Spike first** (Open questions 1–3 and 10), recorded in `render-profile.feature.md` Known
  limits. It must show: `StyleSheet.disabled` from world `1_701` takes effect (also under JavaScript
  off); `Cookie` / `Set-Cookie` removal by the blocking pair actually takes effect, and the
  `onSendHeaders` observer (`web-request.ts` hub) sees the request **after** the edit (the Task 13
  e2e relies on it); `details.webContentsId` coverage; the geolocation override reaching
  `getCurrentPosition`. Each feature that fails its spike is dropped per Decision 8's fallbacks.
- [ ] **Spec (invariant wording, under this task's security review):** `render-profile.feature.md`
  gains a "Page writes" paragraph: CSS off is the one emulation that writes to the page (stylesheet
  `disabled`, top frame, observable by the page), on the user's request only; and the cookie-block
  exception to `web-request.ts`'s "no blocking listener on the browse session".
- [ ] **Spec (new):** `specs/render-profile.spec.ts`: `TabOverrides` (`cssDisabled`,
  `cookiesDisabled`, `geolocation: { latitude; longitude; accuracy } | null`),
  `DEFAULT_TAB_OVERRIDES`, `GEOLOCATION_LIMITS` (±90, ±180, accuracy 1–100 000 m, 5 decimals),
  `GEOLOCATION_PRESETS` (a few cities, frost-chosen rounded coordinates); `RENDER_PROFILE_CDP_METHODS`
  += `Emulation.setGeolocationOverride`, `Emulation.clearGeolocationOverride`,
  `Emulation.setDocumentCookieDisabled`; child-frame share; `TAB_OVERRIDES_WORLD_ID = 1_701` (added
  to `NON_AGENT_WORLD_IDS`, Decision 17);
  `COOKIE_BLOCK` rules; labels and badge text. `RenderProfile`, `RenderProfileSchema`,
  `sameRenderProfile` and `isDefaultRenderProfile` are **unchanged**. `render-profile.schema.spec.ts`:
  `TabOverridesSchema` (strict), `SetTabOverridesInputSchema`. `specs/browser.spec.ts`:
  `TabState.tabOverrides` and `TabState.loadedUnderOverrides` (the document marker, Decision 8:
  set when a document loads under any override, cleared only by a navigation with no override on
  at any point between its start and its completion; setting wins) and `TabState.overridesRevision`
  (the per-tab override revision, Decision 8: raised on every override change and every marker set);
  the audit stamp rule (`overridesOf(audit)`, a separate field present
  with or without a profile; `AuditRenderProfile` unchanged). **`packages/seo-core/src/types.ts`:**
  the ready variant of `SeoAuditResponse` (`:121`) gains `readonly tabOverrides?: TabOverrides`
  (absent: all off), with its doc comment (`:114-118`) and import (`:1`) updated. `specs/changes.spec.ts`:
  `CAPTURE_REFUSALS` (`:32`) += `tab-emulation-on` and its `CAPTURE_REFUSAL_MESSAGES` (`:36-45`)
  entry, "This tab has CSS, cookies or location changed. Set them back to normal, reload the page,
  then capture it." (`changes-view.test.ts:137` loops over every capture refusal); the rule
  "refused when the audit's stamp **or** the live tab shows an override on, **or** the document was
  loaded under overrides, **or** the override revision changed or the marker got set between the
  capture's start and its persistence"; `ChangesTabs.overridesOn?` documented (live overrides or the
  marker) and `ChangesTabs.overridesRevision?`. `specs/screenshot.spec.ts`: `SCREENSHOT_REFUSALS` +=
  `tab-emulation-on` **and** its `SCREENSHOT_REFUSAL_MESSAGES` entry (`changes-view.test.ts:236`
  loops over every refusal); `ScreenshotTabs.overridesOn?` documented (live overrides or the
  marker), `ScreenshotTabs.overridesRevision?` and the mid-capture rule (revision changed or marker
  set before persistence: refused, nothing stored). The merged
  command-list rule (Decision 8), the cookie-block latency note and its fail-open rule (Green,
  `cookie-block.ts`) go into `render-profile.feature.md`.
  `ci-gates.feature.md` (new rule). `semgrep/debugger-allowlist.yml`: message names the new methods'
  spec; a `ruleid` fixture for a geolocation `sendCommand` outside the module. New
  `semgrep/webrequest-blocking-allowlist.yml` + `semgrep/__fixtures__/webrequest-blocking-allowlist.ts`:
  `onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` only in `protocol/requests.ts`,
  `security/register.ts`, `update/fetch.ts`, `browser/cookie-block.ts`; its `paths.exclude` carries
  the same test-path excludes as `debugger-allowlist.yml` (`"__tests__/"`, `"*.test.ts"`,
  `/apps/desktop/src/test/`, `/apps/desktop/e2e/`), since tests and `src/test/electron-fake.ts`
  use these event names, and never excludes its own fixture. **Root `package.json`**
  (root-config one-liner each): `security:semgrep:test` gains
  `&& uvx semgrep@1.182.1 --test --metrics off --config semgrep/webrequest-blocking-allowlist.yml semgrep/__fixtures__/webrequest-blocking-allowlist.ts`,
  and `security:semgrep:scan` gains `--config semgrep/webrequest-blocking-allowlist.yml` (four rules in all).
- [ ] **Red:** `main/browser/__tests__/render-profile.test.ts`: `geolocation-to-tab-and-frames`,
  `cookies-off-sends-document-cookie-disabled`, `unlisted-method-still-refused`; new
  `main/browser/__tests__/tab-overrides.test.ts`: `emulation-is-tab-local-and-not-pinned`,
  `emulation-ends-with-the-tab`, `marker-set-when-a-document-loads-under-overrides` (any override
  on at commit or during the load), `marker-kept-when-overrides-turned-off` (and across
  same-document navigations), `marker-cleared-only-by-a-clean-navigation` (a new document that
  completes with every override off; one whose load saw an override keeps it),
  `marker-kept-when-override-on-at-navigation-start` (an override on when a navigation starts and
  turned off before it completes: the marker stays set; setting wins),
  `override-revision-raised-on-change-and-marker-set`; `main/browser/__tests__/render-profile.test.ts` (merged list, one
  test per case): `emulation-survives-profile-reset`, `emulation-applies-with-default-profile`
  (attaches although the profile is default), `profile-change-keeps-emulation-and-child-share`
  (a cross-site frame announced after the change gets both), `emulation-change-keeps-profile`,
  `reattach-restores-emulation` (a Chromium-initiated detach, run **with a default profile**),
  `detaches-only-when-both-default`, `entry-field-is-tabOverrides-not-emulation` (viewport fit
  unaffected); `main/browser/__tests__/render-profile-audit.test.ts`: `audit-stamps-emulation`,
  `audit-stamps-emulation-with-no-profile`, `audit-profile-unchanged-by-stamp`,
  `get-audit-carries-the-stamp` (the ready `seo.getAudit` answer carries `tabOverrides` from
  `overridesOf(audit)`, beside `renderProfile`, as the existing checks at `:66-85` do for the profile);
  `render-profile.schema.spec` tests:
  `render-profile-schema-rejects-emulation-fields` (strict, unchanged); new
  `main/changes/__tests__/lane-key.test.ts`: `lane-key-unchanged-by-emulation`;
  `main/changes/__tests__/service.test.ts` (its `ChangesTabs` fake, `:73-78`, gains the optional
  `overridesOn`; the stamp is set on `state.response`), the Capture guard's arms, one test each:
  `capture-refused-when-the-stamp-shows-an-override` (stamp CSS off, live all off: the "turned off
  after the audit" case; refused `tab-emulation-on`, `extract` never called),
  `capture-refused-when-overrides-turned-on-after-audit` (stamp all off, live CSS off: refused,
  `extract` never called, nothing stored), `capture-refused-when-overrides-turned-on-during-extraction`
  (live turns on inside `extract`: the second `readyTab` refuses, nothing stored),
  `capture-allowed-when-stamp-and-live-both-off` (default profile, both off: captured into the
  normal lane), `capture-refused-while-emulation-on` (default profile, stamp and live both CSS off),
  `capture-without-overridesOn-reads-live-as-off` (an older fake with no `overridesOn` captures as
  before), `capture-lane-unchanged-by-emulation-stamp`,
  `capture-refused-when-document-loaded-under-overrides` (cookies off → reload → cookies on →
  re-audit (the auditor reruns, no reload): stamp and live both off, the marker set, capture
  refused `tab-emulation-on`, `extract` never called; then reload → capture allowed),
  `capture-refused-when-overrides-revision-changes-before-persist` (the revision moves, or the
  marker gets set, after the capture started and before it is stored: refused `tab-emulation-on`,
  nothing stored);
  `main/changes/__tests__/capture-run.test.ts`: `project-run-capture-not-refused`;
  `main/screenshots/__tests__/service.test.ts` (fakes gain the
  optional `overridesOn`): `screenshot-refused-while-emulation-on` (live state),
  `screenshot-allowed-after-emulation-turned-off-with-stale-audit` (the document loaded with every
  override off, so no marker), `screenshot-refused-when-document-loaded-under-overrides` (the same
  sequence as the capture test: refused until a reload),
  `screenshot-refused-when-css-toggled-during-full-page` (CSS turned off, or on, while a full-page
  screenshot is being taken: the revision changed, so it is refused `tab-emulation-on` before
  persisting, no row and no file kept; likewise when the marker gets set mid-shot),
  `project-run-screenshot-not-refused`; new `cookie-block.test.ts`: `listener-always-answers`
  (every request gets its callback, also when the tab lookup or header edit throws, so no tab can
  hang), `listener-error-passes-request-unchanged-and-logs` (on a throw the callback gets `{}`, the
  request's headers are untouched, the error does not propagate out of the listener, and one log
  line names the listener and the error's code or name, never the URL or a header value),
  `strips-only-listed-tabs`, `registered-only-while-needed`, `removed-on-tab-close-and-switch-off`,
  `registers-on-the-tabs-own-session` (the pair goes on `contents.session` of the cookies-off tab;
  a second session in the test gets its own pair, removed with its last cookies-off tab),
  `other-tabs-and-default-session-untouched`, `subframe-requests-of-the-tab-stripped`; new
  `css-off.test.ts`: `world-1701-only`, `top-frame-only`, `new-stylesheets-disabled`,
  `off-reenables`, `works-with-javascript-off`; `main/agent/__tests__/page-tools.test.ts`
  `agent-worlds-distinct` (existing, unchanged) passes with `1_701` in `NON_AGENT_WORLD_IDS`;
  `pnpm security:semgrep:test`: the new fixture's
  `ruleid` lines fail the rule (a violation in a non-allowlisted module is reported) and `ok` lines pass.
- [ ] **Green:** new `browser/tab-overrides.ts` (per-tab state, the per-tab override revision, and
  the per-document `loadedUnderOverrides` marker from the tab's main-frame navigation events —
  whether any override was on at any point from a navigation's start to its completion; asks
  `render-profile.ts` to re-apply), `cookie-block.ts` (each listener body is `try`/`catch`/`finally`: the `catch` logs one
  line (listener name and the error's code or name only) and swallows the error, so nothing is
  rethrown into main; the `finally` always calls `callback`, with the edited headers on success and
  `{}` (the request or response passed through unchanged) on error. This is **fail-open**, chosen on
  purpose: Electron's filters cannot select a `webContentsId`, so the listener sees every tab's
  requests, and an error in the tab lookup cannot tell whether the request belongs to a cookies-off
  tab. Failing closed (cancelling, or stripping cookies) would break or log out tabs that never
  asked for cookies off, for the sake of a testing switch. Cookies off is an SEO testing aid ("see
  the page as a cookieless crawler"), not a privacy guarantee, and its UI hint already says some
  requests (service workers) keep cookies; the hint adds "if frost cannot apply it to a request,
  that request is sent as normal", and the log line records each such request), `css-off.ts`; `render-profile.ts` (owns the one merged per-tab
  command list as `entry.tabOverrides`; `apply()` and the detach handler's guard changed, `:149` and
  `:175-176`; `apply()` / `clear()` detach only when both are default), `render-profile-cdp.ts`
  (emulation commands, child-frame share of the merged list), `render-profile-debugger.ts` (no
  structural change: its frame share is already "the last whole list sent", now the merged one),
  `render-profile-audits.ts` (`overridesOf` on `AuditProfiles`, a separate WeakMap), `web-request.ts` (ownership comment),
  `packages/seo-core/src/types.ts` (the ready answer's optional `tabOverrides`),
  `controller.ts` (`seo.getAudit`, `:1092`: `tabOverrides: auditProfiles?.overridesOf(response.audit)`),
  `changes/service.ts` (`ChangesTabs.overridesOn?`; `readyTab` refuses `tab-emulation-on` on the
  stamp, the live state or the marker; `changesTabs()` fills `overridesOn` from
  `TabState.tabOverrides` and `TabState.loadedUnderOverrides`, and `overridesRevision` from
  `TabState.overridesRevision`; `captureTab` records the revision at its start and refuses before
  storing if it changed or the marker got set) and
  `screenshots/service.ts` (`ScreenshotTabs.overridesOn?` and `overridesRevision?`, the
  live-or-marker refusal, the same revision check before a screenshot is persisted,
  `screenshotTabs()` fills them the same way);
  new `packages/ipc-contract/src/tab-overrides-router.ts` (`tabOverrides.set`, `enforceSender`), `router.ts`
  one line; renderer `RenderProfile.tsx`, `render-profile-view.ts`, `AuditProfileNote.tsx` (gains a
  `tabOverrides` prop) and `SeoSidebar.tsx` (the `<AuditProfileNote ...>` line passes `response.tabOverrides`).
- **E2E** (`render-profile.e2e.ts`, loopback pages): `geolocation-override-after-permission-allow`,
  `cookies-off-sends-no-cookie-header`, `css-off-disables-stylesheets`, `capture-now-refused-with-emulation` (CSS turned off after a clean audit, the live arm),
  `screenshot-refused-with-emulation` (live), `emulation-survives-profile-reset`.
- **Risks:** service-worker requests carry no `webContentsId` and keep cookies (stated in the UI
  hint); every tab's requests pass through main while any tab has cookies off (Decision 8), so a
  listener that failed to answer would hang every tab (`listener-always-answers`). **Known limit:**
  the cookie-block listener fails open: a request whose header edit throws goes out with its
  cookies although the switch says off (logged; stated in the hint and in
  `render-profile.feature.md`). This is the chosen trade against breaking every tab (Green).

### Task 7: Screenshot annotation editor (SL-100) — security review
**Purpose:** Decision 9.
- [ ] **Spec:** `specs/screenshot.spec.ts`: `SCREENSHOT_EDIT_TOOLS = ['arrow', 'box', 'text', 'crop']`,
  `ScreenshotEditOp` (arrow, box `filled`, text ≤ 200 chars), `SCREENSHOT_EDIT_COLORS` (6),
  `SCREENSHOT_EDIT_LIMITS = { maxOps: 200, maxOverlayBytes: 8 MiB }`, `SCREENSHOT_EDIT_RESULTS =
  ['saved', 'no-source', 'invalid', 'too-large', 'store-failed']`, `ScreenshotEntry.editedFrom:
  string | null`. `specs/screenshot.schema.ts`: `SaveScreenshotEditInputSchema` (`sourceId`, `crop`
  in source px or `null`, `overlay` PNG `data:` URL, `ops`). `specs/capture-db.spec.ts`: the local
  `screenshot_edits` table (not in `SYNC_TABLES`). Feature scenarios in `screenshot.feature.md`.
- [ ] **Red:** new `main/screenshots/__tests__/edit.test.ts`: `overlay-must-match-crop-size`,
  `composite-alpha-over-source` (pure, no Electron), `source-unchanged-new-hash-and-row`,
  `oversize-overlay-refused`, `missing-or-changed-source-no-source`, `crop-outside-source-invalid`,
  `edit-row-links-source`; `packages/db/src/__tests__/migrations.test.ts`:
  `migrations-are-forward-only` still passes with `PHASE11_MIGRATIONS` last;
  **fixture-id check** (Decision 18): the test-only ids in `migrations.test.ts` and `driver.test.ts`
  are already `9000_test_extra`, `9000_broken`, `9001_broken` (Phase 8 Task 5), so the `recordedIds`
  expectations hold with `0231` spread last;
  `packages/db/src/__tests__/repository.test.ts`: `migration-0231`, `purge-removes-edit-rows`;
  `packages/ipc-contract/src/__tests__/screenshots-router.test.ts`: `saveEdit` enforces sender and
  bounds input; renderer new `screenshot-editor.test.ts`: undo/redo, ops bounded, overlay sized to crop.
- [ ] **Green:** new `main/screenshots/edit.ts`, `composite.ts`; `screenshots/service.ts`,
  `imaging.ts` (decode to bitmap); new `packages/db/src/phase11-migrations.ts` with
  `0231_screenshot_edits`, spread last in `migrations.ts` (Decision 18); `change-intel/purge.ts`
  cleanup; `changes-router.ts` (`screenshotsRouter.saveEdit`), `changes-service.ts`; renderer new
  `ScreenshotEditor.tsx`, `screenshot-editor.ts`, `Screenshots.tsx` (Edit).
- **E2E** (`screenshots.e2e.ts`): `annotate-crop-and-save-a-copy`.
- **Risks:** canvas limits on very tall crops (Open question 9); compositing a 64 M-pixel bitmap
  (only the overlay's non-transparent bounds are blended).

### Task 8: Chat history — search, rename, archive (SL-056, SL-057)
**Purpose:** Decision 10.
- [ ] **Spec:** `specs/agent-data.spec.ts`: `CHAT_LIST_FILTERS = ['active', 'archived']`,
  `CHAT_SEARCH_MAX_CHARS` (200), `CHAT_SEARCH_SNIPPET_CHARS` (120), rename rules (reuse
  `STORED_CHAT_TITLE_MAX_CHARS`, one line, trimmed); `specs/agent-ipc.schema.ts`:
  `AgentListChatsInputSchema`, `AgentRenameChatInputSchema`, `AgentArchiveChatInputSchema`;
  `specs/agent-session.spec.ts`: `AgentChatSummary.archived`, `match?`; `agent-data.feature.md`.
- [ ] **Red:** `packages/db/src/__tests__/agent-chats.test.ts`: `migration-0230-keeps-rows`,
  `user-title-survives-auto-title`, `archived-pruned-by-retention`, `cap-counts-archived`;
  `packages/db/src/__tests__/migrations.test.ts`: `migrations-are-forward-only` with `0230` last;
  **fixture-id check** (Decision 18): the test-only ids are already `9000_`/`9001_` (Phase 8 Task
  5);
  `main/agent/__tests__/session-data.test.ts`: `search-title-and-text`, `search-excludes-tool-output`,
  `retention-off-rename-in-memory`; `agent-router` tests; renderer `agent-view.test.ts`.
- [ ] **Green:** `packages/db/src/phase11-migrations.ts` (`0230_agent_chat_lifecycle`:
  `archived_at INTEGER`, `title_by_user INTEGER NOT NULL DEFAULT 0`; whichever of Tasks 7 and 8
  lands first creates the file and the `migrations.ts` spread), `agent-chats.ts`;
  `main/agent/chat-history.ts`, `session.ts`, `service.ts`; `agent-router.ts`, `agent-service.ts`;
  renderer `AgentChatList.tsx` (search, Active/Archived, rename inline, archive).
- **E2E** (`agent.e2e.ts`, scripted model): `chat-rename-archive-search`.

### Task 9: @-attach other tabs (SL-058) — security review
**Purpose:** Decision 11.
- [ ] **Spec:** `specs/agent-tools.spec.ts` (append): `read_attached_tab` (`read`, grantable), input
  `{ ref: 'tab-1' | 'tab-2' | 'tab-3', part: 'audit' | 'text' }`, `MAX_CHAT_ATTACHMENTS = 3`,
  `MAX_ATTACHED_READS_PER_TURN = 2` (per attachment), the `not-ready` answer text;
  `specs/agent-protocol.schema.ts`: `AGENT_PROTOCOL_VERSION` = **current + 1 at merge time**
  (after Phases 8 and 9's bumps); `specs/agent-ipc.schema.ts`: `AgentAttachTabInputSchema`,
  `AgentDetachTabInputSchema`, the attachable-tabs answer (tab id, cut title, origin; web tabs only);
  `specs/agent-session.spec.ts`: `AgentActiveChatView.attachments` (`ref`, `origin`, `title`,
  `state: 'ready' | 'changed' | 'closed'`); new `specs/agent-attach.feature.md`; the system-prompt
  sentence (refs and origins only).
- [ ] **Red:** new `main/agent/__tests__/attached-tabs.test.ts`: `ref-not-attached-refused`,
  `navigated-tab-expired`, `closed-tab-expired`, `attached-background-tab-audit-not-ready` (no ready
  audit, or one for another URL → `not-ready` data, no card), `attached-background-tab-audit-served-when-url-matches`,
  `attached-text-reads-the-attached-tab-with-expected-page-check`, `grant-origin-is-attached-tabs-origin`,
  `private-origin-check-uses-attached-tab`, `reads-capped-per-turn`, `output-wrapped-untrusted`,
  `private-page-always-asks`, `read-switch-off-asks`, `non-web-tab-not-attachable`, `at-most-three`,
  `system-prompt-has-no-page-title`; `approvals-end-to-end.test.ts`: `attached-text-cannot-escalate`
  (an attached page asking to navigate still needs approval); `agent-cannot-approve.test.ts`
  unchanged and passing; `provider-capture` on the `chatgpt` route: the new tool is inside the
  `frost` namespace; renderer composer `@` menu tests.
- [ ] **Green:** new `main/agent/tools/attached-tabs.ts`; `tools/runner.ts`, `tools/index.ts`
  (readers take a resolved tab), `session.ts`, `system-prompt.ts`, `approvals.ts` (origin from the
  attached tab); `packages/ai-skills/src/tools.ts`; `agent-router.ts`; renderer `AgentComposer.tsx`
  (`@` menu, chips), `AgentChat.tsx`.
- **E2E** (`agent.e2e.ts`, scripted model): `attach-second-tab-and-read-it`.
- **Risks:** MCP is untouched; a background tab's audit is often `not-ready` (stated to the model).

### Task 10: Workspace polish — resizable panes, panel pins, history (SL-001, SL-014, SL-106, SL-116)
**Purpose:** Decisions 12–13.
- [ ] **Spec:** `specs/seo-sidebar.spec.ts`: `SIDEBAR_PANEL_WIDTH_RANGE = { min: 300, max: 560,
  keyboardStep: 24 }`, `SIDEBAR_WIDTH_STORAGE_KEY`, `SIDEBAR_PINS_STORAGE_KEY`,
  `ALWAYS_PINNED_PANELS = ['overview']`, `MORE_PANELS_LABEL`; `seo-sidebar.feature.md` rewords
  "The rail lists `SEO_PANELS` in order" to the pinned ones. `specs/agent-panel.spec.ts`:
  `AGENT_PANEL_WIDTH_RANGE = { min: 320, max: 640, keyboardStep: 24 }`,
  `AGENT_PANEL_WIDTH_STORAGE_KEY`; shrink order on a narrow window (agent pane to its min, then the
  sidebar to its min, then today's narrowing) with a scenario.
  `specs/browser-polish.spec.ts`: `HISTORY_RETENTIONS`, `DEFAULT_HISTORY_RETENTION = 'forever'`,
  `HISTORY_RETENTION_SETTING_KEY`, `HISTORY_KEEP_PROJECT_PAGES_KEY`, `HISTORY_CLEAR_RANGES`,
  `CLEAR_HISTORY_RANGE` dialog (states one row per URL), history list input += `projectId`, answer
  += `changeCount`. `account-settings.spec.ts`: `SETTINGS_SECTIONS` += `history`.
- [ ] **Red:** new `renderer/__tests__/sidebar-layout.test.ts`: `width-clamped-to-page-min`,
  `narrow-window-shrinks-agent-pane-first`, `keyboard-resize-steps`, `pins-persist-overview-stays`,
  `more-shows-worst-status`, `jump-to-unpinned-panel-shows-it`; `packages/db/src/__tests__/history.test.ts`:
  `prune-keeps-project-pages`, `clear-range-on-last-visit`, `project-filter`, `change-count-from-versions`;
  `main/browser/__tests__/browser-polish.test.ts`: `retention-applied-at-start-and-daily`,
  `clear-range-confirms-in-main`; router tests; `renderer/__tests__/use-history-view.test.ts`
  (existing): project filter and change counts; new `renderer/__tests__/settings-history.test.ts`.
- [ ] **Green:** renderer `SeoSidebar.tsx`, `AgentPanel.tsx`, new `sidebar-layout.ts`, `styles.css`;
  `packages/db/src/history.ts`; `main/browser/history-service.ts`; `polish-router.ts`,
  `polish-services.ts`; `HistoryView.tsx`, `useHistoryView.ts`, new `settings-history.tsx`, `settings-view.tsx`.
- **E2E:** `seo-sidebar.e2e.ts` `drag-resize-moves-page-view`, `unpin-into-more`;
  `agent.e2e.ts` `agent-pane-resize`; `browser-polish.e2e.ts` `history-project-filter-and-clear-hour`.
- **Sizing:** at the upper bound (~2 days).

### Task 11: Help, shortcuts, What's New and setup checklist (SL-005, SL-117, SL-118, SL-126)
**Purpose:** Decisions 14 (without diagnostics) and 15.
- [ ] **Spec:** new `specs/help.spec.ts`: `HELP_MENU` (ids, labels, `role: 'help'`), `HELP_URLS`
  (README and new-issue URLs, fixed `https:`, opened through `resolveExternalOpen`),
  `KEYBOARD_SHORTCUTS` (groups built from existing shortcut constants, per-platform display),
  `SHORTCUTS_SHORTCUT = 'Mod+/'`, `SETUP_CHECKLIST_ITEMS`, `SETUP_CHECKLIST_STORAGE_KEY`,
  `WHATS_NEW_SEEN_SETTING_KEY`. New `specs/whats-new.schema.ts`: `ReleaseNotesSchema` (≤ 50
  releases; version, date, title, ≤ 10 items of ≤ 200 chars, optional release URL on
  `github.com/SnowOpsHQ/frost`). `help.feature.md`.
- [ ] **Red:** `main/__tests__/menu.test.ts`: `help-menu-items`, `every-menu-accelerator-is-listed`,
  `every-listed-shortcut-exists`; new `main/help/__tests__/help-links.test.ts`:
  `help-links-go-through-resolve-external-open` (allowlisted, gesture required, nothing opened
  otherwise); new `main/help/__tests__/release-notes.test.ts`:
  `release-notes-valid-and-current-version-present`, `release-notes-bundled-not-read-from-disk`;
  `help-router` tests; new `renderer/__tests__/start-view.test.ts` (checklist done states, dismiss).
- [ ] **Green:** `menu.ts` (Help submenu from new `main/help/menu.ts`), new `main/help/*`;
  `apps/desktop/release-notes.json`, imported as JSON into the main bundle (Vite) and validated with
  `ReleaseNotesSchema` at startup and in the test, so the packaged build needs no file on disk; new
  `help-router.ts` / `help-service.ts`; renderer `ShortcutsView.tsx`, `WhatsNewView.tsx`,
  `SetupChecklist.tsx`, `StartView.tsx`, `help-palette.ts`, `App.tsx` (one line per sheet).
- **E2E** (`browser-polish.e2e.ts`): `help-shortcuts-sheet`, `whats-new-after-version-change`,
  `setup-checklist`.

### Task 12: Export Diagnostics (SL-125) — security review
**Purpose:** Decision 14 (diagnostics).
- [ ] **Spec:** new `specs/diagnostics.spec.ts`: `DIAGNOSTICS_LOG_RING = { maxLines: 500,
  maxLineChars: 500 }`, `DIAGNOSTICS_FIELDS` (versions, platform, packaged, applied migration ids,
  feature booleans), the forbidden contents (URLs, page text, emails, keys, tokens, file paths, host
  or user names), `DIAGNOSTICS_RESULTS`; `HELP_MENU` += Export Diagnostics…; `diagnostics.feature.md`.
- [ ] **Red:** new `main/diagnostics/__tests__/report.test.ts`: `report-has-no-urls-emails-paths-or-keys`,
  `ring-capped-and-scrubbed` (telemetry's `createScrubber` + `machineLiterals`),
  `ring-keeps-warn-and-error-only`, `save-writes-what-main-built`, `cancelled-writes-nothing`;
  `help-router` tests for `diagnostics` / `saveDiagnostics`.
- [ ] **Green:** new `main/diagnostics/{log-ring,report}.ts` (ring installed at startup from
  `index.ts`, one line); `help-router.ts`; renderer `DiagnosticsView.tsx` (the report as text for
  review, then Save… in main's dialog).
- **E2E** (`settings.e2e.ts`, save dialog stubbed): `export-diagnostics-saves-reviewed-report`.
- **Risks:** a main log line carrying page data (scrubber + review of the ring's sources).

### Task 13: Phase e2e sweep, docs and gates
- [ ] Run every e2e file touched above together; add `render-profile.e2e.ts`
  `cookies-off-har-shows-no-cookie-header` (Tasks 4 + 6; relies on the Task 6 spike result that
  `onSendHeaders` sees post-edit headers) and `seo-panels.e2e.ts` `context-menu-copy-seo-data`
  (Tasks 1 + 2).
- [ ] Docs: `apps/desktop/README.md` (copy/export procedures and best-effort URL redaction;
  line 203's "no script runs in the page" reworded for the storage reader; CSS-off and cookie-block
  exceptions in the Security model), root `README.md` feature list;
  `ci-gates.feature.md`.
- [ ] Gates: `pnpm security:electronegativity` (baseline unchanged), `pnpm security:semgrep` (all
  four rules with their fixtures: `ipc-sender-guard`, `webcontents-factory`, `debugger-allowlist`,
  `webrequest-blocking-allowlist`), `pnpm test`, `pnpm test:e2e`.

---

## Open questions
| # | Question | How to resolve |
|---|---|---|
| 1 | Does setting `StyleSheet.disabled` from an isolated world take effect in Electron 45 (adopted sheets, shadow roots, JavaScript off)? Is the stated page-write exception acceptable? | Task 6 spike on a loopback page; Task 6's security reviewer keeps or drops CSS off. |
| 2 | Is `details.webContentsId` set on the browse session for subframe, worker and preload requests? Do `Cookie` / `Set-Cookie` edits take effect, and does the `onSendHeaders` observer see the edited request? | Task 6 spike logging a loopback server's received headers and the hub's observer; document what stays uncovered; drop cookies off if edits do not take effect. |
| 3 | Does `Emulation.setGeolocationOverride` answer `getCurrentPosition` after frost's permission Allow, with no network location provider, and in cross-site iframes? | Task 6 e2e spike; drop geolocation if not. |
| 4 | Does the storage reader run under JavaScript off (isolated worlds do for the extractor) and on pages with an opaque origin? | Task 4 test `reader-runs-with-javascript-off`; opaque origins answer `unavailable`. |
| 5 | Do HAR consumers (Chrome DevTools import, common viewers) accept entries with no body and `bodySize: -1`? | Manual import of a Task 4 export; record in `devtools.feature.md`. |
| 6 | Breadcrumb/site-name width budgets and rich-card layouts are approximations of engines that change. | Document as approximations (as `SNIPPET_BUDGETS_PX`); no vendor claim. |
| 7 | World ids `1_700`–`1_709`, `read_attached_tab` and the `AGENT_PROTOCOL_VERSION` bump against Phases 8–12. | The lead's final cross-plan review (after the per-plan reviews), before Tasks 2 and 9 start. |
| 8 | Which Help URL (README or a docs site)? | Owner decision; constant in `help.spec.ts`. |
| 9 | Canvas/OffscreenCanvas size limits for overlays of tall full-page crops. | Task 7 spike; fall back to overlay tiles if needed. |
| 10 | Verify the tab-local route: emulation never reaches `RenderProfileSchema`, pins, captures, screenshots or sync, and never silently drops. | Task 6 tests `render-profile-schema-rejects-emulation-fields`, `audit-stamps-emulation-with-no-profile`, `get-audit-carries-the-stamp`, `capture-refused-when-the-stamp-shows-an-override`, `capture-refused-when-overrides-turned-on-after-audit`, `capture-allowed-when-stamp-and-live-both-off`, `capture-lane-unchanged-by-emulation-stamp`, `capture-refused-when-document-loaded-under-overrides`, `screenshot-refused-while-emulation-on`, `screenshot-allowed-after-emulation-turned-off-with-stale-audit`, `screenshot-refused-when-document-loaded-under-overrides`, `capture-refused-when-overrides-revision-changes-before-persist`, `screenshot-refused-when-css-toggled-during-full-page`, `marker-kept-when-override-on-at-navigation-start`, `emulation-survives-profile-reset`, `reattach-restores-emulation` (`lane-key-unchanged-by-emulation` is only a trivially true regression guard). |
