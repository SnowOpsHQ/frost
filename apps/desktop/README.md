# @app/desktop

The frost Electron app (main, preload, renderer), packaged with Electron Forge. As of Phase 2.5 it is
a usable, hardened browser with a docked SEO sidebar that audits the page you are on and gives it a
health score. Around the audit sit the day-to-day SEO tools: render profiles, a served-vs-rendered
comparison, content and snippet tools, a command palette, a devtools drawer, and link, sitemap and
hreflang checks. The agent comes in a later phase (`docs/design/IMPLEMENTATION-PLAN.md` §4).

## What it does

### Browser (Phase 1)
- **Tabs.** A tab strip with new / close / switch (click, middle-click to close, Cmd/Ctrl+1…9,
  Ctrl+Tab), up to 50 tabs; each tab is its own `WebContentsView` with its own history. A page that
  calls `window.close()` closes its tab; the window always keeps at least one tab.
- **Address bar.** URLs, scheme-less hosts (`example.com`, `localhost:5173`) and searches (the
  chosen search engine, see Phase 2.5); anything that is not `http(s)` becomes a search, never a
  navigation. Back, forward, reload / stop,
  a lock or not-secure badge, and a status bar (loading, connection, notices, page zoom).
- **Page commands.** Reload (Cmd/Ctrl+R, F5), Hard Reload (Shift+Cmd/Ctrl+R), Back / Forward (Cmd+[ /
  Cmd+] on macOS, Alt+Left / Alt+Right elsewhere), Zoom In / Out / Actual Size (Cmd/Ctrl + `=` `-`
  `0`, per host), Stop (Esc while loading). A right-click menu in pages: Back / Forward / Reload,
  Open Link / Image in New Tab, Copy Link / Image Address, Cut / Copy / Paste / Select All, and
  a search for the selection with the chosen engine.
- **Error and crash panels.** A failed load (unreachable, offline, refused certificate …) or a
  crashed renderer shows frost's own panel with Try again / Reload; a refused certificate offers no
  way to proceed. A hung page is reported in the status bar.
- **Permission prompts.** Notifications, geolocation, camera / microphone and clipboard-read ask
  in a bar under the toolbar, naming the requesting origin (and the site embedding it). Allow lasts
  for this run; Block is remembered. Everything else is denied without asking. HTML fullscreen is
  allowed, with a notice; Esc always leaves it.
- **Session restore.** Open tabs come back on relaunch (the active one loads at once, the others
  when first shown); visits and Block decisions are kept in a local SQLite database in the profile.
  **Clear Browsing Data…** (File menu; the app menu on macOS; the command palette) clears, after a
  confirmation: visits, permission decisions, site storage and cache, the render profiles pinned to
  sites, the recently closed tabs, and frost's cached robots.txt answers, recorded responses,
  served HTML, devtools logs and link-check answers (running checks are cancelled). It keeps the
  Content panel's target queries and snippet drafts unless its checkbox (unchecked by default) is
  ticked, and it keeps preferences (the search engine, the "Open in" hosts you allowed).
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

**Health score.** 0–100, from the rule catalog (`specs/seo-rules.spec.ts`: 111 rules in 19
categories since Phase 2.5, frost's own ids, wording and thresholds). Each failing rule counts once,
however many elements fail it, and takes its severity's share of what is left of the score (error
20 %, warning 7 %, info 1 %: one error is 80, one warning 93, both 74). Bands: Good from 90, Needs
work from 60, Poor below. A page that is not indexable (a generic or Googlebot `noindex` in a meta
tag or `X-Robots-Tag`, robots.txt blocking Googlebot, a 4xx or 5xx status) scores at most 59 and
its score card says **Not indexable**, with the reasons. Every panel follows one pattern: its verdict, its
ranked issues (each expands to why it matters, how to fix it, and the facts and samples behind it),
then the details.

The panels, in rail order:
- **Overview.** The score ring and band, error / warning / info counts, the top five issues ("Show
  all" for the rest), a search-result preview, the checks by category, and the render profile the
  audit ran under (Phase 2.5).
- **On-Page** (`seo-rules.feature.md`). Title and meta description with their lengths against
  frost's guide ranges ("too short" and "too long" are measured as widths since Phase 2.5), URL,
  canonical, meta robots, `lang`, viewport, the heading outline (with a toggle that outlines the
  headings on the page), word count (`Intl.Segmenter`, so CJK and Thai text count
  properly), and link and image summaries.
- **Content** (Phase 2.5, below).
- **Links** (`seo-panels.feature.md`). Internal / external / other, nofollow / sponsored / ugc counts;
  type, rel and text filters; each link's anchor text, rel flags, target and href. **Copy as CSV**
  (the rows shown, with a spreadsheet-formula guard), Open in new tab, Copy URL, and a highlight mode
  that outlines links on the page by type. At most 1,000 links are listed, with the page's total.
  **Check links** (Phase 2.5, below) adds a Status column, "Broken only" and a broken-link
  highlight.
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
  script and region codes, self-reference, `x-default`). **Check sitemaps** and **Check return
  links** (Phase 2.5, below) sit in the robots.txt and hreflang cards.
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
- **JavaScript** (Phase 2.5, below).

### SEO tooling (Phase 2.5)
Acceptance: the feature files named below; how it was built: `docs/plans/phase-2.5-seo-tooling.md`.

- **Render profiles** (`render-profile.feature.md`). The toolbar's render-profile button opens an
  editor bar under the toolbar: a device (desktop, phone, tablet), a user agent (frost's own, a
  mobile browser, Googlebot smartphone, Googlebot desktop, Bingbot, or custom printable text up to
  256 characters, with matching client hints), a network condition (offline, slow 3G, fast 3G, 4G),
  and JavaScript off and cache off switches, plus quick chips for common combinations.
  - With a device the page sees the device's width in CSS pixels whatever the window size (the
    view is scaled down to fit). Cross-site iframes get the profile too (all but the viewport), and
    dedicated workers its user agent and cache switch.
  - A profile is always visible: a badge on the tab, a chip in the status bar, and a frame around
    the page area with the profile, "Reload to apply" when the page on screen predates it, and
    **Reset** (one click; it also unpins the site).
  - It belongs to its tab: it stays across navigations, a tab the page opens (or a page the SEO
    sidebar opens from it) starts with it, and no other tab, the chrome or the app session is
    affected; tabs the palette's tools open do not inherit it. **Pin to this site** keeps a profile
    per origin, locally (at most 200; Clear Browsing Data forgets them).
  - Every audit records the profile it ran under (the Overview shows it, the Speed panel's lab-data
    caveat names it). A crawler user agent shows a note that the requests still come from your
    network and frost renders the page, so the real crawler may see something else.
- **Content panel and snippet editor** (`seo-content.feature.md`). A rail panel after On-Page with,
  in order:
  - the **snippet editor**: the page's title and description and your own drafts (up to 6 per URL,
    stored locally), with live desktop and mobile previews cut at the pixel budget (title 580 px,
    description 920 px desktop and 680 px mobile) with an ellipsis, drawn by frost with a neutral
    glyph (no favicon is fetched). Widths come from a character-width table measured at build time
    and committed as data; `title-too-wide` (warning) and `meta-description-too-wide` (info)
    replace the Phase 2 character maximums. **Copy as HTML** writes escaped `<title>` and
    `<meta name="description">` through main;
  - an optional **target query**, stored per URL, with a checklist of its terms in the title, H1,
    URL, the first 100 words and the headings;
  - the page's 1-, 2- and 3-word **n-grams** from its visible text (`Intl.Segmenter`, so CJK and
    Thai text is segmented; stop-words for English, Spanish, French and German), each marked present
    or not in the title, H1, meta description and URL. They are information only: no rule, score or
    colour depends on keyword density or the target query;
  - a **readability** grade (Flesch reading ease) for English pages; other languages say "not
    available".

  Target queries and drafts survive Clear Browsing Data unless its checkbox is ticked; **Delete all
  notes** (panel or palette) removes them after a confirmation.
- **Command palette** (`command-palette.feature.md`). Mod+K (reserved: a page can neither see nor
  block it) or View › Command Palette… opens a sheet at the top of the page column; the page area
  shrinks below it rather than being covered. frost's own fuzzy search runs over every action: panel
  jumps, sidebar and highlight modes, re-audit and the accessibility check, tab, navigation and zoom
  commands, Clear Browsing Data, copies of the shown audit's values (written by main), render
  profiles, content, devtools, find, history, search engines and the checks. It is fully keyboard
  driven (ARIA combobox and listbox) and lists recent actions first. **Open in** sends the page to a
  public tool from a fixed `https:` table (a rich-results test, mobile and desktop page-speed tests,
  an HTML validator, an archive lookup) as a background tab, or opens the site's own robots.txt or
  sitemap.xml. Each row names the destination host; the first use of each host asks once, inline,
  and says when the page URL's query string is sent too. It is offered only for pages on public host
  names, and main refuses a page whose response came from a non-public address. The palette itself
  makes no network requests.
- **JavaScript panel** (`seo-javascript.feature.md`). The last rail panel compares the page as
  served (a second, cookieless request for its HTML, with the tab's render-profile user agent if it
  has one, parsed with `parse5` in a worker) with the rendered DOM: a per-field diff (title,
  description, robots, canonical, `og:url`, lang, viewport, H1s, headings, links, images,
  structured data, word count, hreflang: only in served, only in rendered, or changed), a verdict
  (JavaScript-independent, partly or heavily JavaScript-dependent) and five rules (canonical or
  robots changed by JavaScript are warnings; a title changed, main content or links added by
  JavaScript are information). States: pending,
  ready, identical, or served HTML unavailable with the reason (a fetch redirected elsewhere, such
  as a login page, is unavailable rather than compared). **Fetch again** re-requests it. The panel
  says the site can see the request.
- **SEO devtools drawer** (`devtools.feature.md`). Mod+Shift+D (reserved), View › SEO Devtools or the
  palette opens a resizable band under the page area (open, height and tab kept per window). It is
  read-only: no script runs in the page and no DOM is edited.
  - **Network:** the active tab's requests (method, URL as text, type, status, size, a timing
    waterfall, a third-party flag, and a robots.txt verdict for the page origin's crawlable
    requests), with type, third-party, failed and text filters and "Preserve log". `Authorization`,
    `Proxy-Authorization`, `Cookie` and `Set-Cookie` are stored only as `•••`; other headers are
    allowlisted (the rest only counted) and fetched only when a row is opened; bodies are never read.
    Recording is always on but small while the drawer is closed everywhere (the newest 100 requests
    plus the document); open, a document keeps its first 2,000. The log is bounded in bytes (4 MB
    per tab, 32 MB in all); what does not fit is counted and shown.
  - **Redirects:** the main-frame redirect chain, each hop's status and key headers.
  - **Console:** the tab's console messages as text, deduplicated with counts, capped.
  - **Storage:** the tab's cookies with values masked until you reveal one (a reveal lasts until the
    tab's next committed navigation), and **Clear this site's data**, confirmed in main's dialog.
  - **Issues:** every finding of the shown audit in one sortable table; a row opens its panel.
- **Browser polish** (`browser-polish.feature.md`).
  - **Find in page:** Mod+F (reserved) opens a find bar above the page with a match count;
    Enter / Shift+Enter or Mod+G / Mod+Shift+G (reserved only while the bar is open) step; Esc
    closes it. Each tab keeps its own bar; a new document closes it.
  - **Reopen closed tab:** Mod+Shift+T (reserved), File › Reopen Closed Tab or the palette reopens
    the last closed tab where it was, with its back / forward entries and its render profile (up to
    20 closed tabs, in memory only).
  - **History:** History › Show All History (Mod+Y) or the palette shows a sheet over the page
    column with your visits by day, a search box, open, delete one, and "Clear all history" (asked
    in main; it also empties the closed-tab stack).
  - **New-tab page:** "Jump back in" shows up to 4 most-visited and 4 recent pages as frost-drawn
    monogram tiles (local visits only, nothing remote).
  - **Search engine:** Google (default), Bing or DuckDuckGo, chosen in the palette ("Search with …")
    and kept across launches; the `g `, `b ` and `d ` prefixes in the address bar always search
    that engine, and the context menu's search follows the choice.
- **Link, sitemap and hreflang checks** (`seo-checks.feature.md`). Nothing is requested until you
  ask, for the active tab's ready audit; every surface says the sites can see the requests.
  - **Check links** (Links panel): HEAD, then GET (16 KB) where a server refuses HEAD, for up to 500
    unique links, 2 at a time per origin and 250 ms apart, 6 in all, 10 s each. Results stream into
    a Status column (OK, redirect, broken, try again later for a 429 or 503, blocked by robots.txt
    for same-origin links, skipped) with "Broken only" and a broken-link highlight; definite answers
    are cached for the session.
  - **Check sitemaps** (Indexability): the robots.txt `Sitemap:` lines, else `/sitemap.xml`, gzip
    included, following sitemap indexes to depth 2 (at most 20 files and 50,000 URLs, 50 MB a
    file): files read, URL count, errors, whether this page is listed, and `lastmod` problems.
  - **Check return links** (the hreflang card): up to 20 alternates are fetched (1 MiB, 10 s each)
    and each is checked for a link back to this page, in its head or `Link` header.

  Stop keeps what was found; a new document, an in-page move to another URL or closing the tab
  cancels a run. Five rules (`links-broken`, `links-internal-redirect`, `sitemap-page-not-listed`,
  `sitemap-unreachable`, `hreflang-no-return-link`) score finished runs only.

## Security model (summary)
The details, each with its named tests, are in `specs/*.feature.md`.
- **Two kinds of WebContents.** The chrome (the React UI) is served from `app://app` with a strict
  CSP and Trusted Types, and talks to main only through the typed, sender-guarded tRPC channel
  (`packages/ipc-contract`; every procedure runs `enforceSender` before it reads its input, then a
  strict Zod schema). Tabs run on their own session partition (`persist:frost-browser`) with no
  preload, `sandbox`, `contextIsolation`, `webSecurity` on and `nodeIntegration` off, set explicitly
  by one allowlisted factory (`createTabView`); they have no IPC at all and can never load `app://`
  or `file:`.
- **Navigation guards.** Tabs navigate and redirect only to `http(s)` and `about:blank`; `mailto:`
  reaches `shell.openExternal` only on a real user gesture, from the tab's main frame, with no
  attachment keys. Popups become background tabs only on a gesture. `<webview>` is refused,
  downloads are cancelled (no download manager yet), certificate errors are always refused,
  JavaScript dialogs are off, and `beforeunload` cannot trap the user.
- **Permissions** are deny-by-default and scoped to (requesting origin, top-level origin); the
  prompt's buttons arm only after a delay, and not while a fullscreen page covers them.
- **Reserved shortcuts.** The tab and reload shortcuts, Mod+Shift+S (sidebar) and, since
  Phase 2.5, Mod+K (palette), Mod+F (find), Mod+Shift+T (reopen tab), Mod+Shift+D (devtools) and,
  while the find bar is open, Mod+G / Mod+Shift+G are taken in `before-input-event` of every tab
  and of the chrome, so a page can neither see nor block them; on every platform each is taken by
  exactly one handler.
- **Packaged builds** refuse remote debugging, `--host-resolver-rules`, the e2e suite's
  public-hosts switch and the update e2e switches (`PACKAGED_FORBIDDEN_SWITCHES`), and the Electron fuses (`PACKAGED_FUSES` in
  `specs/macos-package.spec.ts`) disable run-as-Node, `NODE_OPTIONS` and the Node inspector flags,
  and turn on cookie encryption, ASAR integrity validation and loading the app only from its ASAR.
- CI gates: Electronegativity, Semgrep (`ipc-sender-guard`, `webcontents-factory`,
  `debugger-allowlist`) and the e2e suite (`specs/ci-gates.feature.md`).

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
- **Analysis workers.** Main does not validate or analyse page-derived or server-sent data on its
  thread (it only checks sizes and shapes, bounded). It runs three `worker_threads` workers of one
  bundle (`seo/analysis-worker.ts`, each heap capped at 256 MB, no Electron APIs), each with a hard
  timeout past which it is terminated and the next job starts a fresh one:
  - the **audit** worker (`ANALYSIS_TIMEOUT_MS`): the extractor's answer, the page's context
    (recorded response, robots.txt bytes, speed measurement, accessibility result, the served HTML's
    snapshot, finished checks), live speed measurements and the drawer's robots.txt verdicts,
    validated with strict, capped Zod schemas, then `@app/seo-core`. Garbage is "audit
    unavailable" (`analysis-timeout` past the deadline), never a crash;
  - the **served HTML** worker (1.5 s): `parse5` with a counting tree adapter (at most 200,000
    nodes, depth 512, 256 attributes a tag), so a 50 MB or deeply nested page stays bounded; a
    failure makes only the comparison unavailable;
  - the **checks** worker (20 s): sitemaps with `saxes` (streaming, non-validating; any
    `<!DOCTYPE>` stops the parse, so no DTD or entity is ever read or expanded; gzip inflated to
    50 MB at most; XML depth 16), alternates' heads and robots.txt matches, so a large sitemap never
    holds an audit back.
- **Inert page text.** Page-derived strings are React text only (`<bdi>`, bidi-isolated tooltips):
  no `innerHTML`, no `dangerouslySetInnerHTML`, no `style=` props, no `<a>`; that covers the
  panels, the palette's previews, the drawer's URLs, headers and console messages, and History's
  rows. Remote images and favicons are never loaded into the chrome (its CSP stays
  `img-src 'self' data:`). Page URLs open only through `browser.openBackgroundTab`, for `http(s)`
  URLs. The chrome has no clipboard access: every copy (Copy as CSV, Copy URL, Copy JSON, the
  palette's copies, Copy as HTML) is written by main from its own ready audit or stored draft
  (`seo.copyLinksCsv`, `seo.copyUrl`, `seo.copySchemaJson`, `seo.copyValue`,
  `content.copySnippetHtml`), never from a string the chrome sends.
- **Response metadata.** Observed on the browse session through one `webRequest` owner (observers
  only; no request waits for main), with allowlisted headers (no `Set-Cookie`), capped as it
  arrives. The devtools drawer is another observer of the same owner: secret headers are kept only
  as `•••`, bodies are never read, and its log is bounded in rows and bytes.

### Render profiles: the per-tab debugger
- Main drives a profiled tab's emulation through that tab's own `webContents.debugger`: the Chrome
  DevTools Protocol in-process, with no remote-debugging port or switch (packaged builds still
  refuse those).
- Only `browser/render-profile-debugger.ts` touches a debugger. The Semgrep rule
  `debugger-outside-allowlisted-modules` (`semgrep/debugger-allowlist.yml`) flags any other use of
  a `debugger` property, an alias, a destructured binding or a reflective read of it.
- It attaches only to a browse-session tab's WebContents (any other is refused before a debugger is
  touched), only while the tab has a profile; Reset and closing the tab detach it.
- It sends only the CDP allowlist `RENDER_PROFILE_CDP_METHODS` (`Emulation.*` device metrics,
  touch and script switches; `Network.*` user agent, network conditions, cache and enable /
  disable), plus `Target.setAutoAttach` with fixed parameters and `Runtime.runIfWaitingForDebugger`
  for announced child sessions only (`isAllowedCdpCommand`). Anything else is refused before it
  reaches the debugger.
- The page cannot see or defeat it: no domain that observes the page is enabled,
  `navigator.webdriver` stays `false`, and no page API reaches the session, so navigating,
  reloading or crossing origins keeps it.

### Requests frost makes on your behalf
Besides the pages you open, frost requests only these, and **the sites can see every one of them in
their logs** (each surface says so):
- **robots.txt** of every origin it audits (at most once per 10 minutes, frost's own user agent).
  The drawer's robots.txt verdicts and the link checks' `blocked` reuse that answer.
- **The served HTML** of every audited page: a second `GET` of its URL (5 MB, 10 s), once per tab
  document, URL and user agent, with the tab's render-profile user agent when one is in effect.
- **Link, sitemap and hreflang checks**, only when you start them (see above), with the tab's
  render-profile user agent when one is in effect.
- **DNS lookups** of each of those requests' host names, before every hop (see below).
- **Tabs you ask for:** an "Open in" tool (sent the page URL, after you allowed its host once), the
  site's robots.txt or sitemap.xml from the palette, and searches with the chosen engine are
  ordinary browse-session tabs.

The chrome itself requests nothing: no favicons, remote images, palette suggestions or telemetry.

All the fetched requests go through **one bounded fetcher** in main (`seo/fetcher.ts`,
`specs/fetcher.spec.ts`), never the chrome or a worker:
- the browse session (its proxy and certificate checks) with cookies and credentials omitted, no
  referrer, and nothing read from or written to the HTTP cache; a `Set-Cookie` in an answer never
  reaches the session's cookies;
- `http(s)` only; redirects one hop at a time, each checked before frost requests it, at most 5;
- a body cap and one deadline per call (queue wait included);
- per-origin queues: 2 requests at once, a minimum gap between starts, at most 1,000 waiting.

Main runs it in **two lanes** over the same hop and rules, each with its own per-origin queues:
`audit` (robots.txt and the served HTML, 200 ms apart) and `checks` (the user-started checks,
250 ms apart). An audit's requests never wait behind a 500-link check; the cost is that a site can
see both lanes at once (up to 4 requests in flight).

**One private-address check** (`specs/private-address.spec.ts`) serves the fetcher and the
palette's "Open in". Not public:
- every reserved IPv4 and IPv6 range (carrier-grade NAT `100.64.0.0/10` included), with
  IPv4-in-IPv6 forms judged by their IPv4 address;
- `localhost`, single-label names and local-only suffixes (`.local`, `.internal`, `.lan`,
  `.home.arpa`, `.test` …), trailing dots ignored.

The fetcher refuses a private host, as the first URL or a redirect hop, unless the page the request
is for is itself on one (a dev server). A literal address is checked as written; a name is resolved
on the browse session before every hop, and refused if **any** address it resolves to is private.
"Open in" is offered only for public host names, and main also refuses a page whose response came
from a non-public IP address. Two gaps are documented (`fetcher.spec.ts`): `net.request` cannot be
pinned to the address checked, so a name whose answer changes between the check and the connection
(DNS rebinding, a TTL of zero) can still reach a private address in that window; and behind a
proxy, the proxy resolves the name itself.

## Updates
Acceptance: `specs/update-client.feature.md` (and `update-manifest.feature.md` for the signed
manifest).
- **Off unless a feed is configured.** No build ships a feed, and **no feed is hosted yet**, so every
  build today (dev, tests, packaged) makes no update request and shows nothing about updates (the
  command palette offers no update action either).
- **Pointing a build at a feed.** Set `FROST_UPDATE_FEED_URL` to an `https:` URL before starting
  frost (any build); unpackaged builds also take `--frost-update-feed=<url>` (which wins), and
  `http:` only to `127.0.0.1` / `[::1]`. The feed serves an envelope signed with
  `pnpm sign:update-manifest`; frost trusts only the public key compiled into it.
- **What happens.** With a feed, frost checks 30 s after start and then every 6 h (automatic checks
  can be turned off in the command palette: Turn Automatic Update Checks Off / On; Check for Updates
  checks once either way). A verified, newer offer shows a notice under the find bar's row (under the toolbar when no find bar is open): Release notes
  (plain text), Download, Skip this version (not for a required update) and Later. Nothing
  downloads until you click Download; the file is checked against its signed size and SHA-256 and
  deleted if it differs. Requests go through a separate in-memory session with no cookies, no
  referrer and only a `User-Agent: frost/<version> (update check)` header; the install ID that
  decides staged rollout stays on the device.
- **Unsigned builds install by hand.** frost has no code-signing certificates, so no build can
  update itself: once verified, the notice says "This build can't update itself: install it by
  hand" and **Show file** reveals the file in your file manager (frost never opens or runs it).

## Known limits
- **Lab data only.** Speed values are one visit in this tab on this machine, not field data; the
  panel and every rule say so. INP needs an interaction; LCP stops at the first input or scroll; a
  page loaded in a background tab gets no FCP, LCP or CLS (re-measure it); requests inside iframes
  are not counted; cross-origin responses without `Timing-Allow-Origin` have no size; a page that
  filled the browser's resource timing buffer before frost observed it may have lost some requests.
- **Wayland paint metrics.** Under native Wayland some compositors never report frame presentation,
  so Chromium records no paint timing: no FCP, LCP or CLS. frost detects this and says so; launch it
  with `--ozone-platform=x11` to measure them (the speed e2e suite does).
- **frost's own requests are visible to sites.** robots.txt (frost's own user agent), the served
  HTML (a second request for every audited page) and the checks are requested from the sites
  themselves, without cookies, and show in their logs. With a crawler render profile the served
  HTML and the checks send the crawler's user agent string, but from your network.
- **The DNS-rebinding window.** The private-address check resolves names before each hop, but a
  name whose answer changes between that check and the connection can still reach a private
  address, and a proxy resolves names itself (see Requests frost makes on your behalf).
- **What render profiles cannot reach.**
  - A crawler user agent only changes what the tab says it is: requests still come from your
    network and frost renders the page, so the real crawler may get different responses.
  - Service workers and shared workers belong to the site, not the tab: they keep frost's own user
    agent and network, can answer from their own Cache Storage whatever "cache off" says, and run
    whatever "JavaScript off" says, so a page a service worker controls may see some unemulated
    responses.
  - A cross-site frame is laid out at the size its parent gives it, but its `screen` reports the
    machine's own screen: the viewport override is refused on child targets.
  - `Sec-CH-UA-*` client-hint headers go only to `https:` origins (`navigator.userAgentData`
    reflects the profile everywhere). Whether every override survives a renderer crash was not
    verified.
- **Served HTML.** frost's request carries no cookies, so a signed-in page that sends it elsewhere
  (a login page) is "unavailable", not compared. A served page cut at 5 MB or a parse cap is
  compared but checks no rule, and CSS-hidden text counts in the served word count only.
- **Devtools drawer.** Bodies are never captured; headers outside the allowlist are only counted,
  and a response keeps at most 16. While the drawer is closed in every window a tab keeps only its
  newest 100 requests and its document; requests past the byte budgets are counted, not kept.
  Per-origin storage usage is not shown (Electron has no cheap figure without running script in the
  page).
- **Reopen closed tab.** URL, title and back / forward entries only: no scroll position or form
  state; a tab that closed itself (`window.close()`) reopens at its URL only. On macOS (Electron
  45), Back within the first milliseconds of a reopened tab's history-restore load can crash its
  renderer (not once the load is under way); the e2e suite waits for the restored page to load
  before going Back.
- **Find in page.** The find text never reaches the page, but a page can tell where a match is:
  that it was scrolled to one, or which `hidden=until-found` element matched (`beforematch`).
- **Shortcuts and settings.** Mod+Y (History) is a menu accelerator only, not reserved: Ctrl+Y is
  redo in a page's text field on Linux and Windows. The search engine is chosen in the command
  palette (there is no settings view yet).
- **Content.** Readability is English only; stop-word lists cover English, Spanish, French and
  German. Pixel widths come from one measured sans-serif table; the previews show where a result
  would cut, not a pixel-exact rendering. Target queries, drafts and the "Open in" hosts you allowed
  survive Clear Browsing Data (the notes unless its checkbox is ticked).
- **Zoom persistence.** Per-host zoom is kept by Electron in the browse partition's Chromium
  preferences: a zoomed host's level survives a relaunch and is not removed by Clear Browsing Data
  (resetting the host to 100 % removes it).
- **Highlight host.** While highlight mode is on, the page can see (and remove) its one host
  element, but not its contents; removing it turns the mode off.
- **Not checked.** JSON-LD context aliases, accessibility inside frames, and
  headers of a page restored from the back/forward cache or reached by `pushState` ("Unknown").
  An accessibility check that times out may leave the page's renderer busy for a while.
- No download manager (downloads are cancelled with a notice).

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
- `pnpm make:linux`, `pnpm verify:linux` (on Linux) — the AppImage, deb and zip for x64, and their
  checks (see [Building on Linux](#building-on-linux)). CI: `.github/workflows/linux-package.yml`.
- `pnpm make:win`, `pnpm verify:win` (on Windows) — the Squirrel installer and zip for x64, and
  their checks (see [Building on Windows](#building-on-windows)). CI: `.github/workflows/windows.yml`.

If your shell exports `ELECTRON_RUN_AS_NODE` (some terminals and agent harnesses do), unset it for
manual launches (`env -u ELECTRON_RUN_AS_NODE …`); the e2e harness strips it itself.

## Source layout
- `src/main/` — the main process: `index.ts` (wiring), `browser/` (the browser controller and its
  parts, the navigation guard, permissions, address resolution, shortcuts, the context menu, the
  browse session's `webRequest` owner, render profiles and their debugger, find, history and
  reopened tabs), `seo/` (the extractor, the auditor, the analysis worker and its client, the
  bounded fetcher, robots.txt fetching, the served HTML and its parse, the link, sitemap and
  hreflang checks, recorded responses, the speed and accessibility runners, the highlight overlay,
  content notes), `devtools/` (the drawer's network and console logs, storage, robots.txt verdicts
  and its service), `security/`, `protocol/` (`app://`), `menu.ts`, `session-store.ts`,
  `clear-browsing-data.ts`, `window.ts` (the window and tab-view factories).
- `src/preload/` — the chrome's preload: the IPC bridge only.
- `src/renderer/` — the chrome (React): `App.tsx` (layout), `components/` (`SeoSidebar.tsx` and one
  file per panel in `components/seo/`, the drawer's tabs in `components/devtools/`, the palette,
  find bar, History and render-profile views), `palette/` (the action registry, matcher, built-ins
  and "Open in" consent), each feature's `*-palette.ts` actions, `hooks/`, and pure helpers with
  unit tests.
- `e2e/` — Playwright suites (`harness.ts` launches the app; `helpers.ts` holds shared helpers).
- `vite.web-vitals.ts` (serves the `web-vitals` IIFE to main as a string),
  `third-party-notices.ts` and `THIRD_PARTY_NOTICES`; `scripts/measure-snippet-font.mjs` (builds the
  snippet width table, run in Electron), `scripts/verify-mac-package.mjs`, and
  `scripts/verify-linux-package.mjs` and `scripts/verify-windows-package.mjs` with the checks they
  share in `scripts/verify-package-common.mjs`.
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

## Building on Linux
Prerequisites: Node ≥ 22.18 and pnpm 12.15.0 (as above), `dpkg-deb` (the deb maker and the deb
checks; part of Debian and Ubuntu), `mksquashfs` (`squashfs-tools`, for the AppImage) and, for
`verify:linux`, `unzip` and a display (`xvfb-run -a` on a headless machine). `make:linux` downloads the
AppImage runtime pinned in `specs/linux-package.spec.ts`.

```sh
pnpm install
pnpm make:linux
pnpm verify:linux    # or: xvfb-run -a pnpm verify:linux
```

Artifacts, under `apps/desktop/out/`:
- `frost-linux-x64/` (the packaged tree; `frost` is the executable)
- `make/AppImage/x64/frost-<version>-x64.AppImage`
- `make/deb/x64/frost_<version>_amd64.deb` (installs to `/usr/lib/frost`, with `/usr/bin/frost`)
- `make/zip/linux/x64/frost-linux-x64-<version>.zip`

**The packages are unsigned.** frost has no Linux repository key: the deb is not served from an
apt repository and carries no signature, and the AppImage embeds none. The `frost-linux-x64`
artifact of the Linux package workflow is built and checked in CI; trust it as far as you trust that
run. The deb runs no maintainer scripts; its only setuid file is Chromium's `chrome-sandbox`, used
only where unprivileged user namespaces are unavailable.

`verify:linux` checks the fuses, the files in `resources/` and `app.asar`, launch and debugging
lockdown on the packaged tree, the deb's metadata and files, the AppImage's runtime and contents,
and the zip's contents (`specs/linux-package.feature.md`; CI uploads the AppImage and deb, not the
zip). Electron does not enforce ASAR integrity on Linux:
the fuse is on, but `app.asar` is not hash-checked at startup there (the check says so).

**The AppImage does not start on stock Ubuntu 23.10+ (24.04 included); use the deb there.**
AppArmor on those releases restricts unprivileged user namespaces, so Chromium's namespace sandbox
is unavailable, and its setuid fallback (`chrome-sandbox`) cannot work inside the AppImage's
`nosuid` mount (nor in the unzipped zip, where it is not setuid root). The deb is fine: it installs
`chrome-sandbox` setuid root. To run the AppImage there, either add an AppArmor profile that allows
`userns` for it, or allow unprivileged user namespaces system-wide with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. Never use `--no-sandbox`. The CI
job sets that sysctl before `verify:linux` (and launches the packaged tree, not the AppImage), so a
passing run does not mean the AppImage starts on a stock Ubuntu 24.04.

## Building on Windows
Prerequisites: Windows 10 or later (x64), Node ≥ 22.18 and pnpm 12.15.0 (as above). The Squirrel
maker's tools (NuGet, Squirrel, 7-Zip) come with the `electron-winstaller` package; `verify:win`
uses Windows' own `tar.exe` to read the zip and the `.nupkg`.

```sh
pnpm install
pnpm make:win
pnpm verify:win
```

Artifacts, under `apps/desktop/out/`:
- `frost-win32-x64/` (the packaged tree; `frost.exe` is the executable)
- `make/squirrel.windows/x64/frost-<version>-x64-setup.exe` (the installer), with
  `frost-<version>-full.nupkg` and `RELEASES` beside it
- `make/zip/win32/x64/frost-win32-x64-<version>.zip` (the packaged tree's contents, no top folder)

**The installer and the app are unsigned.** frost has no Authenticode certificate, so SmartScreen
warns before `Setup.exe` runs ("Windows protected your PC": More info › Run anyway). The
`frost-windows-x64` artifact of the Windows workflow is built and checked in CI; trust it as far as
you trust that run. `verify:win` fails if a signature ever appears, until the docs say otherwise.

`Setup.exe` installs per user into `%LocalAppData%\frost` (no administrator rights; there is no MSI)
and starts frost. Installing creates Start-menu and desktop shortcuts and uninstalling removes them:
frost handles Squirrel's install events by running Squirrel's `Update.exe` for the shortcuts only,
then exits (`src/main/update/squirrel-events.ts`). frost never asks `Update.exe` to update: an
update is installed by hand (see Updates). The zip
needs no installer: unzip it anywhere and run `frost.exe`.

`verify:win` checks the fuses, the files in `resources/` and `app.asar`, the ASAR integrity
resource in `frost.exe` (Electron checks `app.asar`'s header hash at startup on Windows) and that a
copy with a tampered header refuses to start, launch and debugging lockdown, that a Squirrel event
launch exits at once, the Squirrel artifacts
(the `RELEASES` hash and size, the app tree inside the `.nupkg`), the zip's contents and the absence
of signatures. Off Windows, `node apps/desktop/scripts/verify-windows-package.mjs --static` runs the
file checks against `pnpm --filter @app/desktop exec electron-forge package --platform win32 --arch x64`
output (no Wine needed); making the installer needs Windows.

## Follow-ups
App icon (Electron's default for now), x64/universal builds, signing in CI, a hosted update feed and
in-place updates (they need signed builds).
