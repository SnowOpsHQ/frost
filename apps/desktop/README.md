# @app/desktop

The frost Electron app (main, preload, renderer), packaged with Electron Forge. As of Phase 2 it is a
usable, hardened browser with a docked SEO sidebar that audits the page you are on and gives it a
health score. The agent comes in a later phase (`docs/design/IMPLEMENTATION-PLAN.md` §4).

## What it does

### Browser (Phase 1)
- **Tabs.** A tab strip with new / close / switch (click, middle-click to close, Cmd/Ctrl+1…9,
  Ctrl+Tab), up to 50 tabs; each tab is its own `WebContentsView` with its own history. A page that
  calls `window.close()` closes its tab; the window always keeps at least one tab.
- **Address bar.** URLs, scheme-less hosts (`example.com`, `localhost:5173`) and searches (Google);
  anything that is not `http(s)` becomes a search, never a navigation. Back, forward, reload / stop,
  a lock or not-secure badge, and a status bar (loading, connection, notices, page zoom).
- **Page commands.** Reload (Cmd/Ctrl+R, F5), Hard Reload (Shift+Cmd/Ctrl+R), Back / Forward (Cmd+[ /
  Cmd+] on macOS, Alt+Left / Alt+Right elsewhere), Zoom In / Out / Actual Size (Cmd/Ctrl + `=` `-`
  `0`, per host), Stop (Esc while loading). A right-click menu in pages: Back / Forward / Reload,
  Open Link / Image in New Tab, Copy Link / Image Address, Cut / Copy / Paste / Select All, and
  Search Google for the selection.
- **Error and crash panels.** A failed load (unreachable, offline, refused certificate …) or a
  crashed renderer shows frost's own panel with Try again / Reload; a refused certificate offers no
  way to proceed. A hung page is reported in the status bar.
- **Permission prompts.** Notifications, geolocation, camera / microphone and clipboard-read ask
  in a bar under the toolbar, naming the requesting origin (and the site embedding it). Allow lasts
  for this run; Block is remembered. Everything else is denied without asking. HTML fullscreen is
  allowed, with a notice; Esc always leaves it.
- **Session restore.** Open tabs come back on relaunch (the active one loads at once, the others
  when first shown); visits and Block decisions are kept in a local SQLite database in the profile.
  **Clear Browsing Data…** (File menu; the app menu on macOS) clears visits, permission decisions,
  site storage and cache, and the SEO auditor's cached robots.txt answers and recorded responses,
  after a confirmation.
- One frost per profile: launching it again shows the running window.

### SEO sidebar (Phase 2)
The sidebar docks right of the page: a panel (360 px) and, at the window's edge, a rail with one
button per panel and a pass / warn / error dot for each. The page area shrinks to make room; in a
narrow window the page keeps its minimum width and the panel narrows instead. Toggle it with the
toolbar button, View › SEO Sidebar or Cmd/Ctrl+Shift+S (reserved: pages never see it); collapsing
hides the panel and keeps the rail, and the open / closed state is remembered. Acceptance:
`specs/seo-sidebar.feature.md` and the feature files named below.

**When it audits.** Only the active tab, after its page loads and after in-page route changes
(`pushState`), debounced (`AUDIT_DEBOUNCE_MS`, at most `AUDIT_MAX_WAIT_MS` under a route-change
storm); a `#fragment` change keeps the current audit. A background tab is audited when it is shown,
if its audit is missing or stale. An audit is only ever shown against the URL it was taken for.
While it runs the panel shows a skeleton; a page that cannot be audited (busy past
`EXTRACT_TIMEOUT_MS`, invalid data, a crash, a load error) shows why, with **Retry**; an empty tab
shows a hint. Inputs that arrive later (robots.txt, the speed measurement, an accessibility check)
never hold the audit up: it is shown at once and re-scored, once, when they settle.

**Health score.** 0–100, from the rule catalog (`specs/seo-rules.spec.ts`: 101 rules in 18
categories, frost's own ids, wording and thresholds). Each failing rule counts once, however many
elements fail it, and takes its severity's share of what is left of the score (error 20 %,
warning 7 %, info 1 %: one error is 80, one warning 93, both 74). Bands: Good from 90, Needs work from 60,
Poor below. A page that is not indexable (a generic or Googlebot `noindex` in a meta tag or
`X-Robots-Tag`, robots.txt blocking Googlebot, a 4xx or 5xx status) scores at most 59 and its score
card says **Not indexable**, with the reasons. Every panel follows one pattern: its verdict, its
ranked issues (each expands to why it matters, how to fix it, and the facts and samples behind it),
then the details.

The panels, in rail order:
- **Overview.** The score ring and band, error / warning / info counts, the top five issues ("Show
  all" for the rest), a search-result preview, and the checks by category.
- **On-Page** (`seo-rules.feature.md`). Title and meta description with their lengths against
  frost's ranges, URL, canonical, meta robots, `lang`, viewport, the heading outline (with a toggle
  that outlines the headings on the page), word count (`Intl.Segmenter`, so CJK and Thai text count
  properly), and link and image summaries.
- **Links** (`seo-panels.feature.md`). Internal / external / other, nofollow / sponsored / ugc counts;
  type, rel and text filters; each link's anchor text, rel flags, target and href. **Copy as CSV**
  (the rows shown, with a spreadsheet-formula guard), Open in new tab, Copy URL, and a highlight mode
  that outlines links on the page by type. At most 1,000 links are listed, with the page's total.
- **Images** (`seo-panels.feature.md`). Alt state, source, declared `width` / `height`, rendered and
  file sizes (the file size follows `srcset`), lazy loading in the first screen, and filters; the
  rules flag missing alt, long alt, missing dimensions, oversized files (more than twice the
  rendered size) and lazy images in the first viewport.
- **Social** (`seo-panels.feature.md`). A large-image (Open Graph) card and a summary (Twitter card)
  preview drawn by frost from the tags, each value labelled with the tag it came from, the image's
  URL and declared size beside a placeholder (the image itself is never loaded), and every Open
  Graph and Twitter card field.
- **Schema** (`seo-schema.feature.md`). JSON-LD, microdata and RDFa Lite read into one tree, a card
  per JSON-LD block (valid, invalid JSON with the error's line and column, or too large) with Tree /
  Raw views and **Copy JSON**, and issues on the node they belong to: `@context` / `@type`, and
  frost's own required and recommended properties for common types (Organization, WebSite,
  BreadcrumbList, Article, Product, FAQPage, LocalBusiness, Event, Recipe, VideoObject and their
  parts), URL, date and duration values. `@id` references stay references (no cycles).
- **Indexability** (`seo-indexability.feature.md`). A combined verdict (Indexable, Indexable but
  canonicalised elsewhere, Not indexable, or pending while robots.txt is fetched) from the HTTP
  status, meta robots, `X-Robots-Tag`, the canonical (`<link>` or `Link` header) and robots.txt. Cards
  for the HTTP response (status, redirect chain, the headers frost keeps), robots directives, the
  canonical, robots.txt (how the fetch went, the verdict and matching rule for Googlebot, Bingbot and
  `*`, sitemaps, Open / View robots.txt) and hreflang (from `<head>` and `Link` headers: language,
  script and region codes, self-reference, `x-default`).
- **Speed** (`seo-speed.feature.md`). LCP, CLS, INP, FCP and TTFB from `web-vitals`, each against
  the published Core Web Vitals bands (poor is a warning, needs improvement info); navigation timing;
  requests and bytes by type; the largest requests; hosts and the third-party share (by registrable
  domain); DOM size. Rules also cover page weight, request count, DOM size, render-blocking scripts
  in `<head>` and uncompressed text. While the panel is open it polls for live values (every second,
  pausing after 120 polls) and labels whether it shows Live or At audit time values; the score
  always uses the audit's measurement. **Re-measure** reloads the page.
- **Compliance** (`seo-compliance.feature.md`). Security: a verdict (Secure, Needs attention, Not
  secure, or Local page for loopback hosts), HTTPS, mixed content (read from the page's markup;
  active is an error, passive a warning; `upgrade-insecure-requests` is honoured), and a header table
  (CSP, HSTS, X-Content-Type-Options, frame protection, Referrer-Policy, Permissions-Policy, plus
  meta CSP and referrer) with frost's reading of each; without the document's headers they are
  "Unknown", never a failure. Accessibility: **Run accessibility check** runs `axe-core` (WCAG 2.0 /
  2.1 / 2.2 A and AA plus best practices, no frames) with a 10 s cap, then groups violations by
  impact, each with its description, help URL and elements as text selectors. Only critical and
  serious violations score (one warning each), and only after a check ran on that document.

## Security model (summary)
The details, each with its named tests, are in `specs/*.feature.md`.
- **Two kinds of WebContents.** The chrome (the React UI) is served from `app://app` with a strict
  CSP and Trusted Types, and talks to main only through the typed, sender-guarded tRPC channel
  (`packages/ipc-contract`; every procedure runs `enforceSender`). Tabs run on their own session
  partition (`persist:frost-browser`) with no preload, `sandbox`, `contextIsolation`, `webSecurity`
  on and `nodeIntegration` off, set explicitly by one allowlisted factory (`createTabView`); they
  have no IPC at all and can never load `app://` or `file:`.
- **Navigation guards.** Tabs navigate and redirect only to `http(s)` and `about:blank`; `mailto:`
  reaches `shell.openExternal` only on a real user gesture, from the tab's main frame, with no
  attachment keys. Popups become background tabs only on a gesture. `<webview>` is refused,
  downloads are cancelled (no download manager yet), certificate errors are always refused,
  JavaScript dialogs are off, and `beforeunload` cannot trap the user.
- **Permissions** are deny-by-default and scoped to (requesting origin, top-level origin); the
  prompt's buttons arm only after a delay, and not while a fullscreen page covers them.
- **Packaged builds** refuse remote debugging, and the Electron fuses (`PACKAGED_FUSES` in
  `specs/macos-package.spec.ts`) disable run-as-Node, `NODE_OPTIONS` and the Node inspector flags,
  and turn on cookie encryption, ASAR integrity validation and loading the app only from its ASAR.
- CI gates: Electronegativity, Semgrep (`ipc-sender-guard`, `webcontents-factory`) and the e2e
  suite (`specs/ci-gates.feature.md`).

### Audits
Everything the page hands over is untrusted.
- **Isolated worlds.** frost's scripts run in a tab only through `executeJavaScriptInIsolatedWorld`,
  never in the page's main world and never in the chrome: the extractor, its security read and the
  highlight overlay in `SEO_WORLD_ID`, `axe-core` in `A11Y_WORLD_ID`, `web-vitals` in
  `SPEED_WORLD_ID`. Each world has its own globals and prototypes, so a page that overrides
  `document.querySelectorAll`, `Array.prototype` or `JSON`, or defines its own `axe`, changes nothing
  there, and the page cannot see frost's globals. Both libraries are bundled into main as strings,
  unmodified, and never reach the chrome's bundle; in the speed world only the browser's own
  (trusted) `pageshow`, `visibilitychange` and `prerenderingchange` events reach listeners. frost
  never changes the page's DOM, CSP or globals, with one exception on request: highlight mode
  appends one host element to `<html>` holding its overlay in a closed shadow root styled through
  the CSSOM, removed on toggle off, navigation, tab switch, collapsing the sidebar or leaving its
  panel.
- **Bounded in the page.** The extractor caps every list and string while it reads, bounds element
  text reads and the word count, and stops at one deadline (`EXTRACT_BUDGET_MS`): a huge DOM gives
  a `partial` snapshot, not a hang. A run that has not answered within `EXTRACT_TIMEOUT_MS` is
  "audit unavailable".
- **Analysis worker.** Main does not validate or analyse page-derived data on its thread (it only
  checks sizes and shapes, bounded). The extractor's answer, the page's context (recorded response,
  robots.txt bytes, speed measurement, accessibility result) and live speed measurements go to one
  long-lived `worker_threads` worker (`seo/analysis-worker.ts`, its heap capped at 256 MB, no
  Electron APIs). It validates everything with strict, capped Zod
  schemas (`PageSnapshotSchema`, `PageContextSchema`, `PerformanceMeasurementSchema`,
  `AccessibilityResultSchema`) and runs `@app/seo-core`. Analyses run one at a time with a hard
  `ANALYSIS_TIMEOUT_MS`: past it the worker is terminated, that audit is unavailable
  (`analysis-timeout`) and the next analysis starts a fresh worker. Garbage is "audit unavailable",
  never a crash.
- **Inert page text.** Page-derived strings are React text only (`<bdi>`, bidi-isolated tooltips):
  no `innerHTML`, no `dangerouslySetInnerHTML`, no `style=` props, no `<a>`. Remote images are never
  loaded into the chrome (its CSP stays `img-src 'self' data:`). Page URLs open only through
  `browser.openBackgroundTab`, for `http(s)` URLs. The chrome has no clipboard access: Copy as CSV,
  Copy URL and Copy JSON are written by main from its own ready audit (`seo.copyLinksCsv`,
  `seo.copyUrl`, `seo.copySchemaJson`), never from a string the chrome sends.
- **Network.** Response metadata is observed on the browse session (observers only; no request
  waits for main), with allowlisted headers (no `Set-Cookie`), capped as it arrives. robots.txt is
  fetched by main with `net.request` on the browse session: no cookies or referrer, at most 5
  redirects checked hop by hop, `http(s)` only, never to a private host unless the page is on one,
  500 KiB, 5 s, cached per origin for 10 minutes. Every `seo.*` procedure runs `enforceSender`
  before parsing its input.

## Known limits
- **Lab data only.** Speed values are one visit in this tab on this machine, not field data; the
  panel and every rule say so. INP needs an interaction; LCP stops at the first input or scroll; a
  page loaded in a background tab gets no FCP, LCP or CLS (re-measure it); requests inside iframes
  are not counted; cross-origin responses without `Timing-Allow-Origin` have no size; a page that
  filled the browser's resource timing buffer before frost observed it may have lost some requests.
- **Wayland paint metrics.** Under native Wayland some compositors never report frame presentation,
  so Chromium records no paint timing: no FCP, LCP or CLS. frost detects this and says so; launch it
  with `--ozone-platform=x11` to measure them (the speed e2e suite does).
- **robots.txt requests are visible to sites.** frost requests `/robots.txt` from every origin it
  audits (at most once per 10 minutes), with the browse session's normal user agent and no cookies;
  it does not pose as a crawler, and a site's logs show the requests. The private-host check reads
  literal hosts only (no DNS), so a public name that resolves to a private address is not caught.
- **Zoom persistence.** Per-host zoom is kept by Electron in the browse partition's Chromium
  preferences: a zoomed host's level survives a relaunch and is not removed by Clear Browsing Data
  (resetting the host to 100 % removes it).
- **Highlight host.** While highlight mode is on, the page can see (and remove) its one host
  element, but not its contents; removing it turns the mode off.
- **Not checked.** hreflang reciprocity, JSON-LD context aliases, accessibility inside frames, and
  headers of a page restored from the back/forward cache or reached by `pushState` ("Unknown").
  An accessibility check that times out may leave the page's renderer busy for a while.
- No download manager (downloads are cancelled with a notice) and no find bar yet.

## Running, building, testing
From the repo root (`pnpm install` first):
- `pnpm --filter @app/desktop start` — dev run (Vite dev server; it overwrites `.vite/build` with a
  dev bundle, so run `build` again before the e2e).
- `pnpm --filter @app/desktop build` — `electron-forge package` for the host platform.
- `pnpm lint` / `pnpm test` — strict TypeScript and the Vitest suites of every package
  (`@app/seo-core`'s rules each have a passing and a failing fixture).
- `pnpm --filter @app/desktop test:e2e` — Playwright e2e against the unpackaged build, on loopback
  pages (run `build` first; needs a display, `xvfb-run` on a headless Linux).
- `pnpm --filter @app/desktop notices` — regenerates `THIRD_PARTY_NOTICES` from the installed
  packages' license files (a test fails when the committed copy is stale). Packaging ships it as
  `resources/THIRD_PARTY_NOTICES`.
- `pnpm security:electronegativity`, `pnpm security:semgrep` (needs `uv`) — the CI security gates.
- `pnpm make:mac` (on macOS) — `electron-forge make --platform darwin --arch arm64`
  (see [Building on a Mac](#building-on-a-mac)).
- `pnpm verify:mac` (on macOS, after `make:mac`) — checks the bundle id, arch, signature and
  entitlements, fuses, launch and debugging lockdown, and that the `.app` inside the published zip
  and dmg verifies too (`specs/macos-package.feature.md`). CI: `.github/workflows/macos.yml`.

If your shell exports `ELECTRON_RUN_AS_NODE` (some terminals and agent harnesses do), unset it for
manual launches (`env -u ELECTRON_RUN_AS_NODE …`); the e2e harness strips it itself.

## Source layout
- `src/main/` — the main process: `index.ts` (wiring), `browser/` (the browser controller and its
  parts, the navigation guard, permissions, address resolution, shortcuts, the context menu, the
  browse session's `webRequest` owner), `seo/` (the extractor, the auditor, the analysis worker and
  its client, robots.txt fetching, recorded responses, the speed and accessibility runners, the
  highlight overlay), `security/`, `protocol/` (`app://`), `menu.ts`, `session-store.ts`,
  `clear-browsing-data.ts`, `window.ts` (the window and tab-view factories).
- `src/preload/` — the chrome's preload: the IPC bridge only.
- `src/renderer/` — the chrome (React): `App.tsx` (layout), `components/` (`SeoSidebar.tsx` and one
  file per panel in `components/seo/`), `hooks/`, and pure helpers with unit tests.
- `e2e/` — Playwright suites (`harness.ts` launches the app; `helpers.ts` holds shared helpers).
- `vite.web-vitals.ts` (serves the `web-vitals` IIFE to main as a string),
  `third-party-notices.ts` and `THIRD_PARTY_NOTICES`.
- The audit engine itself is `packages/seo-core` (`@app/seo-core`): pure TypeScript, no Electron,
  DOM or Zod.

## Building on a Mac
Prerequisites:
- An Apple Silicon Mac (builds are arm64 only for now).
- Xcode Command Line Tools (`xcode-select --install`): `codesign`, plus the compiler node-gyp needs
  to build the DMG maker's native addons (`fs-xattr`, `macos-alias`).
- Python 3 (for node-gyp; the one the Command Line Tools ship is enough).
- Node ≥ 22.18 (`verify-mac-package.mjs` imports the `specs/*.ts` files with Node's built-in type
  stripping).
- pnpm 12.15.0 (`package.json#packageManager`). Without changing a global pnpm, prefix each
  command below with `npx -y pnpm@12.15.0` instead of `pnpm`.

From the repo root:

```sh
pnpm install
pnpm make:mac
pnpm verify:mac
```

Artifacts, under `apps/desktop/out/`:
- `frost-darwin-arm64/frost.app`
- `make/zip/darwin/arm64/frost-darwin-arm64-<version>.zip`
- `make/dmg/arm64/frost-<version>-arm64.dmg` (ULFO)

## macOS signing
By default the app is **ad-hoc signed**. A build made on your own Mac is not quarantined and opens
normally. A **downloaded** build (e.g. the `frost-macos-arm64` artifact of the macOS workflow, a zip
holding the `.zip` and the `.dmg` above) is quarantined, and Gatekeeper refuses it because it is not
notarized. macOS 15 and later no longer offer Control-click › Open; either:

- **(a)** remove the quarantine attribute before mounting the dmg:
  `xattr -d com.apple.quarantine ~/Downloads/frost-*.dmg` (or, after copying the app out,
  `xattr -dr com.apple.quarantine /Applications/frost.app`); or
- **(b)** try to open the app once, then go to System Settings › Privacy & Security and click
  **Open Anyway** (macOS asks once more to confirm).

Developer ID signing and notarization turn on only when **all four** variables are set when running
`make:mac`; otherwise none of them is used:

| Variable | Used for |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | `osxSign.identity`, e.g. `Developer ID Application: Name (TEAMID)` (in the keychain) |
| `APPLE_ID` | notarytool Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | notarytool app-specific password |
| `APPLE_TEAM_ID` | notarytool team id |

Real signing uses the hardened runtime with only `com.apple.security.cs.allow-jit`
(`MAC_ENTITLEMENTS` in `specs/macos-package.spec.ts`). It has not been exercised yet (no Developer
ID); CI never receives these secrets.

## Follow-ups
App icon (Electron's default for now), x64/universal builds, signing in CI, signed auto-update.
