# @app/desktop

The frost Electron app (main, preload, renderer), packaged with Electron Forge. As of Phase 3 it is
a usable, hardened browser with a docked SEO sidebar that audits the page you are on and gives it a
health score. Around the audit sit the day-to-day SEO tools: render profiles, a served-vs-rendered
comparison, content and snippet tools, a command palette, a devtools drawer, and link, sitemap and
hreflang checks. Phase 3 adds:
- a SERP panel that reads the search result pages you load;
- an optional on-device intent classifier;
- a Visibility panel that fetches a page as search and AI crawlers do.

Phase 4 adds a frost account with plans, opt-in telemetry and a read-only Search Console
panel, set up in a Settings view.

The agent comes in a later phase (`docs/design/IMPLEMENTATION-PLAN.md` §4).

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
  served HTML, devtools logs and link-check answers (running checks are cancelled), and the SERP
  readings and intent answers (a running probe run is cancelled). It keeps the Content panel's
  target queries and snippet drafts unless its checkbox (unchecked by default) is ticked. It keeps
  preferences (the search engine, the "Open in" hosts you allowed), the downloaded intent model and
  an installed selector pack.
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
- **SERP** and **Visibility** (Phase 3, below). They have no rail dot: a dot is an audit verdict,
  and these panels show observations.

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

### SERP, intent and indexability (Phase 3)
Acceptance: `serp-panels.feature.md` and the feature files named below; how it was built:
`docs/plans/phase-3-serp-intent.md`.

- **SERP panel** (`serp-overlay.feature.md`). On a Google, Bing or DuckDuckGo web result page you
  loaded in a tab, the panel shows:
  - the tab's search parameters: engine, query, country (`gl`), language (`hl`), the device from
    the tab's render profile, and the page. They are always visible, and each tab keeps its own;
  - the intent chip: the query's intent (informational, navigational, commercial or transactional)
    with its confidence, or **Enable on-device intent** while the model is missing;
  - the page's composition, as a bar and a count per result type (organic results, ads, featured
    snippets, related questions, videos, images, knowledge panels, shopping, related searches …);
  - page-1 ownership: the organic results grouped by registrable domain, with count, share and
    positions. Ads are not counted, and a subdomain of a shared host (`alice.github.io`) is its own
    owner;
  - the results list;
  - **Outline features on the page**: each block's box with its type label, drawn in the tab and
    following scrolling. It is removed on navigation, a tab switch, toggling it off or leaving the
    panel;
  - the selector pack's version, and **Check for selector updates**.

  On any other page it says "Not a search result page". When the pack's selectors do not match
  the layout, it says "Couldn't read this layout" with the reason and the update action, and never
  guesses. The panel renders without waiting for the audit.
- **Selector packs** (`serp-selector-pack.feature.md`). What frost reads on a result page is data,
  not code: for each engine, its hosts, paths, URL parameters and the CSS selectors of each result
  block. A fixed reader frost ships applies them.
  - A pack is signed: a detached Ed25519 signature over its exact bytes, checked against the public
    key the app embeds before the pack is parsed.
  - The app ships one (version 1) and verifies it at every start. If it fails, SERP reading is off
    (`disabled`); frost never reads with an unsigned pack.
  - "Check for selector updates" installs a remote pack only if its signature verifies, it parses,
    and its version is higher. An installed pack is verified again at every start.
- **On-device intent** (`intent-classifier.feature.md`). **Enable on-device intent** (the SERP panel
  or the palette) first states what it downloads: the all-MiniLM-L6-v2 sentence-embedding model by
  sentence-transformers (Apache-2.0), 23.3 MB with its vocabulary, from `huggingface.co`, once.
  - Only after you confirm is the model downloaded, checked against its pinned sha256 and stored in
    the profile. It is hashed again every time it is loaded.
  - Queries are classified on this computer, in a utility process running ONNX Runtime on the CPU,
    and never leave it. The answer is the label nearest frost's own example queries, nudged by plain
    cues ("buy", "near me", "vs", "login", a bare domain), with its probability as the confidence.
- **Visibility panel** (`visibility-probes.feature.md`). **Run visibility probes** fetches the active
  tab's URL once as each of six agents: frost's own browser (the baseline), Googlebot smartphone,
  Bingbot, GPTBot, ClaudeBot and PerplexityBot.
  - A table has a column per agent and a row per fact: HTTP status, redirects and final URL, the
    robots.txt verdict for the agent's token, meta robots and `X-Robots-Tag` (general and
    agent-specific), effective `noindex`, canonical, word count, size and visible-text similarity.
    Differences from the browser are marked.
  - robots.txt is reported, not obeyed. The AI crawlers' meta robots and `X-Robots-Tag` rows are
    labelled frost's model, as their operators document only their robots.txt tokens.
  - **Stop** keeps what was found. A new document, an in-page move to another URL, closing the tab
    or Clear Browsing Data cancels the run.
  - A query box classifies any query you type, on this computer only.
- **Palette.** Open SERP panel, Open Visibility panel, Outline SERP features / Hide SERP outlines,
  Check for selector updates, Enable on-device intent (with the same prompt, inline), and Run /
  Stop visibility probes (with the disclosure, inline).

**Security model.**
- **Isolated SERP world.** The reader and the outlines run only in the tab's isolated SERP world
  (`SERP_WORLD_ID`), never the page's main world. The reader is one fixed function, given the
  pack's layout as JSON arguments; a selector is never spliced into code.
  - The reader takes its DOM methods from its own world's prototypes, so the page cannot clobber
    them.
  - An invalid selector fails closed (`bad-selector`).
  - Its work is capped in results, text, nodes visited and time.
- **The SERP workers.** The reader's answer is validated and analysed in a `worker_threads` worker
  of the SERP's own (`serp-analysis.cjs`, capped heap, hard deadline, no Electron APIs). The probes'
  bodies, headers and robots.txt are parsed in a second instance of the same bundle.
- **Outlines** are one host element holding a closed shadow root styled through the CSSOM, as the
  Phase 2 highlight is.
- **The intent utility process** is least privilege, though not an OS sandbox (see Known limits):
  - it gets no Electron API beyond `process.parentPort`, no `execArgv`, and an explicit environment
    of one variable; Electron adds only what its runtime needs. An empty environment would inherit
    main's whole environment in Electron 45;
  - main reads and verifies the model and vocabulary and posts their bytes, so the process never
    opens a file or socket;
  - every message either way is Zod-validated, and a malformed one is dropped;
  - a hang or crash ends the request as unavailable and restarts the process, with a backoff.

  `--frost-intent-selftest` (used by `verify:mac`) loads ONNX Runtime in the packaged app's utility
  process, checks the environment is isolated, and exits. It runs on a throwaway profile.
- **Packaged builds** also refuse the three Phase 3 e2e seams: `--frost-e2e-serp-pack-key`,
  `--frost-e2e-serp-pack-url` and `--frost-e2e-intent-fake`.

**For maintainers: signing a selector pack.** `pnpm sign:selectors <pack.json>` writes
`<pack.json>.sig`.
- It reads the path of the Ed25519 private key (PKCS8 PEM) from `FROST_SERP_SIGNING_KEY`, and
  refuses to run without it. The key is kept outside the repo, in the maintainers' private key
  store, and a key path inside the repo is refused.
- It checks the new signature before writing it and says whether its key is one the app embeds.
- `pnpm sign:selectors --verify <pack.json>` checks a signature.
- A pack's bytes are kept exact in git (`.gitattributes`).
- To publish an update, attach `serp-selectors.json` and its `.sig` to a GitHub release, with a
  higher `version`.

### Account, telemetry and Search Console (Phase 4)
Acceptance: the feature files named below; how it was built:
`docs/plans/phase-4-accounts-telemetry.md`; the account API: `apps/backend/README.md`. A build that
lacks a value says "not configured in this build" for that feature and sends nothing for it (see
[Configuration](#configuration)).

- **Settings** (`account-settings.feature.md`). A sheet over the page column, like History (the
  page is laid out zero-high while it shows, and the find bar is hidden). Sections: Account, Search
  Console, Telemetry. Opened from the menu's **Settings…** (Mod+,; the macOS app menu, elsewhere the
  end of Edit) and the palette: "Settings", "Sign in to frost" (while signed out), "Search Console
  settings", "Telemetry settings". It shows only what main answers: "Loading…" until then, and a
  failed read is retried with backoff.
- **Sign-in** (`account-signin.feature.md`; the backend's side: `account-backend.feature.md`).
  - **Sign in** (a real click) opens the backend's sign-in page in the system browser. Main listens
    on `127.0.0.1:<random port>/callback` for that one request, with a `state` and a PKCE verifier
    only it knows. Without a live click in that window nothing opens.
  - The page offers password sign-in, an emailed sign-in link and sign-up (the address must be
    verified first). Once signed in (within the last 10 minutes), it asks "Continue to frost as …"
    and shows a short code (`XXXX-XXXX`, from the request's PKCE challenge); Settings shows the same
    code while it waits. Continue ends the browser's session: one sign-in yields one code.
  - Back in the app, Settings asks **"Sign in as …?"**. Nothing is stored and no plan applies until
    **Confirm sign-in** is clicked in the window that started it. The button takes no click for a
    second after it appears and after the window regains focus. Cancel, Close or Esc drop the
    request and revoke the token already exchanged.
  - Sign out revokes the token at the backend and drops to `free`. Without a real keychain the
    account lasts for this run only (Settings says so), and quitting revokes its token.
- **Plan gating** (`entitlements-client.feature.md`). The backend signs a snapshot of the account's
  plan and features (`free`: none; `pro`: `ai-agent`, `search-console`, `sync`). Main verifies it
  against the public keys baked into the build (EdDSA only, the right `kid`, issuer, audience and
  account) and gates on its feature flags, never on the plan name.
  - A snapshot lives 3 days. Main refreshes at start, every 6 hours and on Settings' Refresh (at
    most once per 30 s).
  - When a refresh fails for a network reason, 7 days of offline grace follow the snapshot's
    expiry; Settings shows the grace's end. A refused session signs out; a snapshot that does not
    verify is `free`.
  - Setting the clock back neither revives an expired snapshot nor extends grace: main keeps a
    time high-water mark with the snapshot.
- **Telemetry** (`telemetry.feature.md`). Two switches, both **off by default**; nothing leaves the
  machine before you turn one on (a real click: a page cannot turn it on), and turning one off drops
  what is queued at once (no final flush).
  - **Usage** sends OpenTelemetry traces (OTLP/HTTP JSON). For now that is one `app.start` span:
    your platform, whether startup worked and how long it took. Only allowlisted attributes leave
    (`SPAN_ATTRIBUTE_ALLOWLIST`); the resource is frost's name, version and OS type.
  - **Errors** sends Sentry error events: main's uncaught exceptions and unhandled rejections, and
    the app window's errors (at most 10 a minute). Each event is rebuilt from an allowlist, with no
    user, request, host name, breadcrumbs or tags; stack frames are relative to the app.
  - **Scrubbing.** Every string that leaves loses URLs, emails, IP addresses, host names, absolute
    paths, tokens and IDs, and the machine's host and login names (`SCRUB_RULES`).
  - **No identifier.** No install ID, user ID or machine name. Requests carry `user-agent:
    frost-telemetry`, no language and no cookies; the receiving server still sees your IP address,
    as with any request. Settings lists what each switch sends in plain words, and says "for this
    run only" if the choice could not be saved.
  - Crashes behave as before: Electron's error dialog stays.
- **Search Console** (`gsc.feature.md`), a Pro feature. **Connect** in Settings (a real click)
  opens Google's consent page for read-only access (`webmasters.readonly`, nothing else; a wider or
  missing grant is refused and revoked). The refresh token is kept in the keychain, the access
  token in memory only. The connection belongs to the frost account that made it: another account
  never reads with it, and signing in as a different account revokes it. **Disconnect** deletes it
  and revokes it at Google. Settings shows "Connected", with no Google account name (frost asks
  Google for none).
- **Search Console panel** (`gsc-panel.feature.md`). A rail panel (no status dot, no
  rerun button or audit footer) for the active tab's page or its whole property, over 7, 28 or 90
  days: clicks, impressions, CTR and average position, a frost-drawn chart of one metric, and the
  top 25 queries. The property is the longest URL-prefix property that matches, else the domain
  property. The chart ends at the last day Google answered, and the panel says how far its data
  lags. Signed out, not Pro, not connected, no matching property, no data and each error have their
  own words, and their buttons open Settings. It reads only while it shows, never on a timer; main
  caches answers for 15 minutes.

### Change intelligence (Phase 6)
Acceptance: `changes-capture.feature.md`, `changes-diff.feature.md`, `changes-panel.feature.md`,
`screenshot.feature.md`, `projects.feature.md`, `retention.feature.md`, `inspector.feature.md` and
`capture-db.feature.md`; how it was built, with the database schema:
`docs/plans/phase-6-change-intelligence.md`.

- **Changes panel** (a rail item after Visibility). It shows the current page's history, newest
  first.
  - **Capture now** records the page from its settled audit plus a region read. Captures go into
    the project chosen in the panel's picker: the first project listing the page, else Unfiled.
  - A capture identical to the page's latest version adds a capture of that version, not a new
    version.
  - Versions are kept per **lane**: the URL with its render profile and search parameters. A phone
    capture never diffs against a desktop one, and the panel shows the lanes as chips.
  - On a search results page, a capture records the SERP panel's search parameters (engine, query,
    `gl`, `hl`, device, page); on any other page it records none.
  - The **diff** between two versions of a lane is grouped by region: head, HTTP, structured data,
    main content, navigation, header, sidebar, footer, elsewhere on the page, and audit. Text edits
    show word-level changes, every value is inert text, and truncated or partial captures say so.
  - What is compared: title, meta description, canonical, robots meta and `X-Robots-Tag`, lang,
    viewport, Open Graph, hreflang, HTTP status, indexable, headings, links, text blocks and word
    counts per region, structured-data types and JSON-LD blocks, image totals, and the audit's
    findings and score.
  - Rules whose result depends on timing or on optional checks are left out (page speed,
    accessibility, served HTML, link/sitemap checks), so an unchanged page stays one version.
- **Screenshots** (from the Changes panel or the palette).
  - **Viewport.**
  - **Select area:** drag on the page, Esc to cancel.
  - **Full page:** the page is scrolled and the captures are stitched. The page can see the
    scrolling, and the scroll position is restored.
  - Each records the render profile and search parameters. The gallery shows thumbnails, a preview,
    Reveal in folder and Copy image.
  - Files are PNGs named by their SHA-256 under `<userData>/frost-captures/screenshots/`, with the
    directory `0700` and files `0600`, never named by anything the page or the chrome supplies.
- **Projects** (a sheet over the page area, from the Changes panel or the palette).
  - A project holds pages and searches (engine, query, country, language, device: desktop, mobile or
    tablet), and an optional render profile. A search is stored as the parameters the SERP panel
    reads from its URL, so a run's capture of it and a capture you take of the same results page
    share a lane.
  - **Capture now** visits each target in a tab of its own, one at a time, with optional viewport
    screenshots and visible progress. It waits while you are on another tab; Cancel, or closing its
    tab, stops it. Quitting stops it too, and its tab is not restored next launch.
  - A site's pinned render profile still applies in the run's tabs, and the capture records the
    profile in effect.
  - Deleting a project asks first, and purges its captures and screenshots.
- **Retention** (in the project view).
  - Keep everything (the default), keep the last N versions of each page, or keep N days. Each page
    always keeps its newest version.
  - The policy is applied after captures into the project (at most once a day, and at the end of
    each run) and at startup. Each application is recorded in the purge log.
  - **Purge now** shows what it would remove, asks in main's dialog, and reports the bytes actually
    freed.
  - **Usage** is measured: stored bytes of captures and diffs, screenshot files by `lstat` (missing
    files counted), the database file, and what is shared with another project.
  - **Compact** runs `VACUUM`; deleted data frees space in the file only after it.
  - Clear Browsing Data leaves change intelligence alone: retention and Purge now are its deletion
    path.
- **Inspector panel.** A read-only, lazily expanded DOM tree with keyboard tree navigation.
  - **Pick element** outlines what is under the pointer; a click selects it, Esc cancels.
  - A node's details: attributes, box, a few computed styles, its landmark region, and SEO facts
    for headings, links, images and meta.
  - Hovering a row outlines it on the page.

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
- **Packaged builds** refuse remote debugging, `--host-resolver-rules` and the e2e suite's switches
  (public hosts and, since Phase 3, the SERP pack key and URL and the intent fake;
  `PACKAGED_FORBIDDEN_SWITCHES`), and the Electron fuses (`PACKAGED_FUSES` in
  `specs/macos-package.spec.ts`) disable run-as-Node, `NODE_OPTIONS` and the Node inspector flags,
  and turn on cookie encryption, ASAR integrity validation and loading the app only from its ASAR.
- **Tokens stay in main** (Phase 4). The account's desktop token, the entitlement snapshot and
  Search Console's tokens live in main, in `userData/secrets/` encrypted with `safeStorage`'s
  asynchronous API (`specs/secret-store.spec.ts`; memory-only without a real keychain). No
  procedure answers a token, code, verifier, `state` or snapshot: the chrome sees `AccountState`,
  `GscStatus` and aggregated rows, and main's logs go through a redactor. The system browser opens
  only through `openExternalIfAllowed`, on a live click in the window that asked.
- CI gates: Electronegativity, Semgrep (`ipc-sender-guard`, `webcontents-factory`,
  `debugger-allowlist`) and the e2e suite (`specs/ci-gates.feature.md`).

- **Change intelligence (Phase 6).**
  - **Append-only:** SQLite triggers refuse `UPDATE`, `DELETE` and `REPLACE` on captured rows
    (versions, captures, diffs, screenshots) and on the purge log. A row is deleted only after an
    immutable tombstone of a recorded purge names it, and a purged id can never be inserted again.
  - **What the triggers cover:** frost's own code and any SQL that respects the schema; anyone who
    can write the file can drop them.
  - **Isolated worlds:** the capture's region read (`CAPTURE_WORLD_ID`, 1600), the screenshot
    scroll and area selector (1601) and the inspector (1602) each run only in their own world. The
    selector and picker accept only trusted input, draw in a closed shadow root and are always
    removed; while picking, a cover keeps clicks away from the page and its frames.
  - **Screenshot files** are written through a no-follow directory handle, checked after the rename,
    and guarded by a per-hash lock against purges. The startup orphan sweep deletes only
    hash-named files that no row references, and skips an in-memory or fresh database.

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
- **Selector pack updates**, only on "Check for selector updates": the pack and its `.sig` (a
  second try of both if the release moved in between), from the latest GitHub release's asset
  `serp-selectors.json`. `https:` only, 256 KB, 10 s.
- **The intent model**, only after you confirm **Enable on-device intent**: the model (about 23 MB)
  and its vocabulary (about 230 KB) from `huggingface.co`, at a pinned revision, through its
  redirects to Hugging Face's download host. `https:` only, capped at the pinned sizes, frost's own
  user agent.
- **Visibility probes**, only on "Run visibility probes": one `GET` of the page per agent, at most
  6 calls and 24 requests with redirects (3 each), 2 at once, 5 MB and 10 s each. Each sends the
  agent's user agent string from your network. robots.txt comes from frost's cache, asked once per
  origin an agent ended on.
- frost never requests a search engine by itself: the SERP panel reads only result pages you
  loaded, and a project's **Capture now** loads its saved searches only when you start it (one
  ordinary tab visit per search, like typing it).
- **DNS lookups** of each of those requests' host names, before every hop (see below).
- **The account API** (Phase 4, only in a build configured for it): the session and the signed
  entitlements at start, every 6 hours and on Refresh, the token exchange after a sign-in and the
  revocation at sign-out. `net.fetch` with no cookies, no cache, no redirects and a timeout.
- **Google** (only while Search Console is connected, and only for a Pro account): the token
  endpoints, the property list and Search Analytics queries while the panel shows (cached 15
  minutes), and the revocation at disconnect.
- **Telemetry** (only with its switch on, and only to the endpoint baked into the build): see
  Telemetry above.
- **Tabs you ask for:** an "Open in" tool (sent the page URL, after you allowed its host once), the
  site's robots.txt or sitemap.xml from the palette, and searches with the chosen engine are
  ordinary browse-session tabs.

The chrome itself requests nothing: no favicons, remote images, palette suggestions or telemetry
(its error reports go through main, and only with consent).

All the fetched requests go through **one bounded fetcher** in main (`seo/fetcher.ts`,
`specs/fetcher.spec.ts`), never the chrome or a worker:
- the browse session (its proxy and certificate checks) with cookies and credentials omitted, no
  referrer, and nothing read from or written to the HTTP cache; a `Set-Cookie` in an answer never
  reaches the session's cookies;
- `http(s)` only; redirects one hop at a time, each checked before frost requests it, at most 5;
- a body cap and one deadline per call (queue wait included);
- per-origin queues: 2 requests at once, a minimum gap between starts, at most 1,000 waiting.

Main runs it in **three lanes** over the same hop and rules, each with its own per-origin queues:
- `audit` (robots.txt and the served HTML, 200 ms apart);
- `checks` (the user-started checks, 250 ms apart);
- the SERP lane (Phase 3: probes, pack updates and the model download, with the `checks` lane's
  limits).

An audit's requests never wait behind a 500-link check, and a probe never waits behind a link
check. The cost is that a site can see every lane at once (up to 6 requests in flight). Repeated
`X-Robots-Tag` headers are kept apart for the probes (`separateHeaders`); other repeated headers are
joined.

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
  palette (the Settings view does not offer it yet).
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
- **SERP, intent and probes (Phase 3).**
  - **Web results of Google, Bing and DuckDuckGo only.**
  - The bundled selectors were written from public knowledge of the engines' markup and tested on
    frost's own synthetic pages, not checked against live result pages. A layout they miss shows
    "Couldn't read this layout", never a guess.
  - No remote pack is published yet, so "Check for selector updates" reports the update source as
    unreachable until a maintainer publishes `serp-selectors.json` and its `.sig` as a GitHub
    release asset. Packs are checked only when you ask; there are no scheduled checks.
  - **A user agent is not a crawler.** Probes come from your network and IP address, the page is not
    rendered the way the crawler renders it, and nothing proves the request is the real bot, so sites
    that verify bots may answer the real crawler differently. Crawler user agents from your address
    can also trip a site's bot protection.
  - **No OS sandbox for the intent process.** Electron cannot apply Chromium's OS sandbox to a Node
    utility process: its isolation is by design (bytes in, an explicit environment, no file,
    network or Electron imports in its code), not by the OS.
  - **`app.asar.unpacked` is outside ASAR integrity.** ONNX Runtime's native binding and library
    cannot load from the archive. The app's code signature and the macOS bundle seal vouch for
    them, not the ASAR integrity check.
  - Clear Browsing Data keeps the downloaded intent model and an installed selector pack.
  - Repeated response headers are joined into one value, except `X-Robots-Tag` in the probes.
  - The DNS-rebinding window above applies to the SERP lane's requests too.
- **Keychain.** Linux without a keyring (`basic_text`) is memory-only: the account and a Search
  Console connection last for the run, and quitting revokes them. Under Playwright Linux is always
  memory-only (its loader adds `--password-store=basic`), so the e2e branches that restart with a
  stored account or tamper with a stored blob run on macOS only (its mock keychain persists).
- **Search Console account.** The status says "Connected" with no Google account name, and connect
  has no in-app confirmation of which Google account was chosen: frost asks Google for no identity.
- **Gating is client-side.** Main gates on a verified snapshot, but a modified client can skip any
  check of its own. A paid feature that runs on a server must be enforced there.
- **Offline grace after a downgrade.** A client that cannot reach the backend keeps a Pro snapshot
  for its life plus grace (3 + 7 days) after the plan changed. Restoring an old `entitlements` blob
  and setting the clock back into its life can replay that snapshot until its expiry (accepted
  risk, `entitlements-client.feature.md`).
- **Error reports are pattern-scrubbed.** URLs, hosts, emails, paths, tokens, IDs and the machine's
  names are removed; free text a message quotes (a tab's title, typed text) is kept, cut to length.
- **Search Console queries are untrusted text.** Anyone can make a search that shows up as a query;
  the panel renders them inert, and anything that reads them (the Phase 5 agent) must treat them as
  attacker-controlled.
- **Not deployed.** The account API runs locally and in tests only; its `console` email transport
  prints sign-in links and is for development (production refuses it). No real email transport
  exists yet.
- **`app.isPackaged` is name-based.** It only looks at the executable's name. The public build
  configuration does not rely on it (a baked-in value pins the build), but the pre-existing e2e
  public-hosts switch (`E2E_PUBLIC_HOSTS_SWITCH`) and the remote-debugging refusal still do.

- **Change intelligence (Phase 6).**
  - **Full-page screenshots** repeat fixed and sticky elements in each segment, lazy content appears
    as the page scrolls, and encoding a 16,384 px tall shot takes up to about half a second on
    main's thread.
  - **What the page can see:** pointer events while you select an area or pick an element, the
    overlay's host element, and the scroll of a full-page shot.
  - **Capture now** works in a visible tab, one target at a time. A search engine may show a
    consent page or a challenge instead of results, and that is what gets captured. A page that
    redirects itself by script after it first loads counts as the tab moving away, and its target
    fails.
  - **Search parameters:** saved searches are read with the bundled selector pack, not an updated
    one. A result page's lane follows its canonical search URL, so the engine's tracking parameters
    never split a search.
  - **Region read and inspector:** neither enters shadow roots or iframes (a click inside one picks
    its host or frame).
  - **Capture time and versions:** a capture cut short by its deadline whose text differs can still
    make a new version.
  - **Screenshots and profiles:** a screenshot's profile does not record whether it was only
    partly in effect (captures do).
  - **Screenshot files** are not synced, and a file removed by hand shows as missing and is never
    re-created.
  - **Disk space** freed by deletion returns to the disk only after Compact.

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
  `resources/THIRD_PARTY_NOTICES`. Since Phase 3 it covers ONNX Runtime: `onnxruntime-node` and
  `onnxruntime-common` (MIT; the licence is taken from upstream, as the packages ship none) and ONNX
  Runtime's own third-party notices (`licenses/`). The intent model is downloaded, not shipped; its
  Apache-2.0 attribution is in the enable prompt.
- `pnpm sign:selectors` (from the repo root) — signs or verifies a selector pack (maintainers; see
  [SERP, intent and indexability](#serp-intent-and-indexability-phase-3)).
- `pnpm security:electronegativity`, `pnpm security:semgrep` (needs `uv`) — the CI security gates.
- `pnpm make:mac` (on macOS) — `electron-forge make --platform darwin --arch arm64`
  (see [Building on a Mac](#building-on-a-mac)).
- `pnpm verify:mac` (on macOS, after `make:mac`) — checks the bundle id, arch, signature and
  entitlements, fuses, launch and debugging lockdown, that the intent runtime is unpacked and loads
  in the packaged utility process (`intent-runtime-loads`, the self-test), and that the `.app`
  inside the published zip and dmg verifies too (`specs/macos-package.feature.md`). CI: `.github/workflows/macos.yml`.

If your shell exports `ELECTRON_RUN_AS_NODE` (some terminals and agent harnesses do), unset it for
manual launches (`env -u ELECTRON_RUN_AS_NODE …`); the e2e harness strips it itself.

E2E configuration notes:
- The harness also strips every inherited `FROST_PUBLIC_*`, `FROST_GSC_*` and `FROST_TELEMETRY_*`
  variable from the app's environment before a suite applies its own, so a value your shell exports
  never points a suite at another backend, collector or Google endpoint.
- That covers the **run-time** environment only. Values set in the environment of `build`, or in
  `apps/desktop/.env`, `.env.local`, `.env.production` …, are read by Vite (`envPrefix` `FROST_PUBLIC_`)
  and **baked into the bundle**. A build with any `FROST_PUBLIC_*` value baked in is pinned to its
  baked configuration as a whole (`specs/build-config.spec.ts`): it ignores the run-time environment,
  including the suites' fakes, so the account, telemetry and Search Console suites fail against it.
  Build for the e2e with no `FROST_PUBLIC_*` variable set and no such `.env*` file.

## Configuration
Phase 4's endpoints and keys are public build values (never a secret: anything in a build can be
read out of it). None is committed; a build without one leaves its feature "not configured in this
build" and sends nothing for it.

| Variable | Feature | Meaning |
|---|---|---|
| `FROST_PUBLIC_API_BASE_URL` | Account | The account API's origin (no path, query or credentials). |
| `FROST_PUBLIC_ENTITLEMENT_JWKS` | Account | JSON JWKS of the Ed25519 public keys that sign snapshots (`admin keygen` prints it; several `kid`s during a rotation). |
| `FROST_PUBLIC_GSC_CLIENT_ID` | Search Console | Google OAuth client ID (Desktop app type). |
| `FROST_PUBLIC_GSC_CLIENT_SECRET` | Search Console | That client's installed-app "secret" (not confidential by Google's own definition; never logged or committed). |
| `FROST_PUBLIC_SENTRY_DSN` | Telemetry, errors | Sentry DSN for error events. |
| `FROST_PUBLIC_OTEL_ENDPOINT` | Telemetry, usage | OTLP/HTTP traces endpoint. |
| `FROST_GSC_AUTH_URL`, `FROST_GSC_TOKEN_URL`, `FROST_GSC_REVOKE_URL`, `FROST_GSC_API_BASE` | e2e only | Fake Google consent, token and revoke endpoints and API base (`https:`, or `http:` on `127.0.0.1` / `localhost`). |
| `FROST_TELEMETRY_EXPORT_DELAY_MS` | e2e only | Span batch delay (holds the startup span in the queue). |

The rule (`specs/build-config.spec.ts`, `runtimeOverridesAllowed`):
- Values are baked in at build time (Vite, `envPrefix` `FROST_PUBLIC_` in `vite.main.config.ts`).
- **If any `FROST_PUBLIC_*` value is baked in, the run-time environment is read for none of them**,
  nor for the e2e-only values: a build made with real values is pinned to them as a whole, and
  talks to Google's fixed endpoints.
- Only an **unpackaged** build with **nothing** baked in (dev, e2e) reads them all from its run-time
  environment.
- A packaged build requires `https:` for the API base, the DSN and the OTLP endpoint. Unpackaged also
  accepts `http:` on `127.0.0.1` (and `localhost` for the API base).
- Vite reads `FROST_PUBLIC_*` from the build's environment **and** from `apps/desktop/.env`,
  `.env.local`, `.env.production` …, so a stray `.env*` file pins a build too (see the e2e notes
  above). Keep those files out of the repo.

### Running against the local backend
The backend's own steps are in `apps/backend/README.md` (Run locally). In short:

```sh
cp apps/backend/.env.example apps/backend/.env         # set BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm --filter @app/backend admin keygen                # server lines into apps/backend/.env;
                                                       # keep FROST_PUBLIC_ENTITLEMENT_JWKS for the desktop
set -a; . apps/backend/.env; set +a
pnpm --filter @app/backend dev                         # http://127.0.0.1:8787
```

Then, with nothing `FROST_PUBLIC_*` set and no `apps/desktop/.env*` file, build once and launch the
unpackaged app with the configuration in its environment:

```sh
pnpm --filter @app/desktop build
env -u ELECTRON_RUN_AS_NODE \
  FROST_PUBLIC_API_BASE_URL=http://127.0.0.1:8787 \
  FROST_PUBLIC_ENTITLEMENT_JWKS='{"keys":[…]}' \
  pnpm --filter @app/desktop exec electron .
```

(`pnpm --filter @app/desktop start` with the same variables exported works too, but bakes them into
the dev bundle; run `build` again with none set before the e2e.)

In frost, open Settings and **Sign in**. In the browser, create an account, open the verification
link the backend prints to its console, sign in, check the code and **Continue**; back in frost,
**Confirm sign-in**. The plan is `free`. To make it `pro`:

```sh
pnpm --filter @app/backend admin grant alice@example.com pro
```

then **Refresh** in Settings. With PGlite (no `DATABASE_URL`) stop `dev` before an `admin` command
and start it again after: PGlite is one process's database. Search Console also needs
`FROST_PUBLIC_GSC_CLIENT_ID` and `FROST_PUBLIC_GSC_CLIENT_SECRET` from a Google OAuth client of the
Desktop app type, and telemetry an endpoint and a DSN of your own.

## Source layout
- `src/main/` — the main process: `index.ts` (wiring), `browser/` (the browser controller and its
  parts, the navigation guard, permissions, address resolution, shortcuts, the context menu, the
  browse session's `webRequest` owner, render profiles and their debugger, find, history and
  reopened tabs), `seo/` (the extractor, the auditor, the analysis worker and its client, the
  bounded fetcher, robots.txt fetching, the served HTML and its parse, the link, sitemap and
  hreflang checks, recorded responses, the speed and accessibility runners, the highlight overlay,
  content notes), `devtools/` (the drawer's network and console logs, storage, robots.txt verdicts
  and its service), `serp/` (the selector pack's verify and store and the bundled `packs/`, engine
  detection, the reader script, the SERP worker and its analysis, the service, outlines, the
  probes and their parse, `setup.ts`), `intent/` (the classifier, the model store, the utility
  process host, the self-test, `setup.ts`), `account/` (configuration, the secret store, the
  loopback listener, PKCE, the API client, entitlements, sign-in, quit holds), `gsc/` (Search
  Console's OAuth, API client, property matching and service), `telemetry/` (the consent store and
  the wiring of `@app/telemetry`), `changes/` (Phase 6: the region read, the capture snapshot and
  service, load times, projects, the capture run, retention and purges), `screenshots/` (stitching,
  the page scripts, capture, imaging, the file store and the service), `inspector/` (the page
  script and the service), `security/`, `protocol/` (`app://`), `menu.ts`,
  `session-store.ts`, `clear-browsing-data.ts`, `window.ts` (the window and tab-view factories).
- `src/workers/intent/` — the intent utility process: its entry, the message handling, frost's
  WordPiece tokenizer, the embedding, the prototype queries, the keyword fake and the self-test
  model.
- `src/preload/` — the chrome's preload: the IPC bridge only.
- `src/renderer/` — the chrome (React): `App.tsx` (layout), `components/` (`SeoSidebar.tsx` and one
  file per panel in `components/seo/`, the drawer's tabs in `components/devtools/`, the palette,
  find bar, History and render-profile views; `seo/Serp.tsx` and `seo/Visibility.tsx` since
  Phase 3, `seo/GscPanel.tsx` since Phase 4; `changes/` for Phase 6's Changes, Screenshots,
  Projects, Retention and Inspector), the Settings sheet (`settings-*.tsx`, with `account-view.ts`
  and the other `settings-*` view models), `palette/` (the action registry, matcher, built-ins and
  "Open in" consent), each feature's `*-palette.ts` actions, `hooks/` (`useSerp.ts` among them), and
  pure helpers with unit tests (`serp-view.ts`, `visibility-view.ts` and `gsc-view.ts` among them).
- `e2e/` — Playwright suites (`harness.ts` launches the app; `helpers.ts` holds shared helpers;
  `fake-backend.ts`, `fake-google.ts` and `fake-telemetry.ts` are the Phase 4 suites' in-test fakes).
- `vite.web-vitals.ts` (serves the `web-vitals` IIFE to main as a string), `vite.intent.config.ts`
  (the intent worker's build, `onnxruntime-node` external), `intent-runtime.ts` (the packaging hook
  that copies ONNX Runtime's files for the target, and the unpack glob),
  `third-party-notices.ts`, `licenses/` and `THIRD_PARTY_NOTICES`; `scripts/measure-snippet-font.mjs` (builds the
  snippet width table, run in Electron) and `scripts/verify-mac-package.mjs`.
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
