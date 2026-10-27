# Feature: indexability (Indexability panel)

Spec: `specs/seo-indexability.spec.ts` (`RESPONSE_HEADER_ALLOWLIST`, `RESPONSE_LIMITS`,
`RESPONSE_SOURCES`, `ROBOTS_FETCH_LIMITS`, `ROBOTS_FETCH_OUTCOMES`, `ROBOTS_AGENTS`,
`ROBOTS_PARSE_LIMITS`, the hreflang code tables, `INDEXABILITY_VERDICTS`), `specs/seo-snapshot.spec.ts`
(`HreflangLinkSchema`, `ResponseMetaSchema`, `RobotsFetchSchema`, `PageContextSchema`),
`specs/seo-limits.spec.ts` (`maxHreflang`, `maxHreflangChars`), `specs/seo-rules.spec.ts` (the
`indexability` and `hreflang` rules, `NOT_INDEXABLE_RULES`) and `specs/seo-sidebar.spec.ts` (the
Indexability panel). Phase 2 Task 4. Each line maps to one named test.

## Decisions
- **Response metadata comes from the browse session, attributed by `webContentsId`.** Electron keeps
  one listener per `webRequest` event per session (a second registration replaces the first), so the
  browse session's `onBeforeRedirect`, `onResponseStarted` and `onErrorOccurred` have one owner,
  `browser/web-request.ts`, which fans each event out to observers (`observeMainFrames`); the
  default session's `onBeforeRequest` (`protocol/requests.ts`) and `onHeadersReceived`
  (`security/register.ts`) are untouched. The filter is `types: ['mainFrame']` on `http(s)` URLs.
  Only observers are used (no `onHeadersReceived` on the browse session): no page request ever
  waits for main. `onResponseStarted` carries the status, the headers and `fromCache`, so
  `onCompleted` is not needed.
- **Main keeps only what the panel needs, capped as it arrives.** Per main-frame request: the
  redirect hops (at most `maxRedirects`, with their total; Chromium's own "Internal Redirect" hops,
  such as HSTS upgrades, are flagged) and, from the response, its status and the allowlisted headers
  (`RESPONSE_HEADER_ALLOWLIST`: every other header, `Set-Cookie` included, is dropped; values cut to
  `maxHeaderValueChars`, `maxValuesPerHeader` per name, `maxHeaders` in all). Nothing is parsed on
  main's thread. At most `maxPendingPerTab` requests per tab and `maxTrackedTabs` tabs are held.
- **The tab's `did-navigate` decides which response is the document's.** The newest recorded
  response whose URL (fragment aside) is the committed URL becomes the tab's record (`network`, or
  `cache` when Chromium answered from its HTTP cache: the cached status and headers). A response
  that never commits (a download, a 204, a cancelled navigation) is not the document. With no
  matching response (a page restored from the back/forward cache, the memory cache, or a tab
  committed before main listened) the record is `navigation`: `did-navigate`'s `httpResponseCode`
  as the status and "headers unavailable" in the panel (X-Robots-Tag and Link canonical rules then
  have nothing to read and pass). When the URL changed in place (`pushState`) the record is
  `in-page`: no response of its own, status unknown.
- **The record travels with the snapshot; the audit never waits for robots.txt.** The auditor
  starts collecting the page's context (the record, the robots.txt fetch and, Task 5, the speed
  measurement; each a named input, `seo/context-source.ts`) with the extraction
  and, once the extraction answered, posts what is known by then to the analysis worker beside the
  extractor's answer. A robots.txt still being fetched (the first audit on an origin) goes as
  `pending`: every other panel is ready at once, the robots.txt card says "Fetching robots.txt…" and
  the verdict is `pending` (unless another reason already makes the page not indexable). When the
  fetch settles, and every other input with it (within `CONTEXT_TIMEOUT_MS`), the same extraction
  is analysed again, once, if that run is still the tab's latest and the tab still shows its URL; the
  new audit replaces the first and bumps the tab's `auditVersion`. The first audit is shown at once
  only when no ready audit of the URL is on screen: a reload or a re-score keeps the shown one until
  the final one (or until the final context is given up on), so the score does not flicker. The worker validates the context with `PageContextSchema` (strict,
  every cap, the header names an enum), so a bad context is `invalid-snapshot` like a bad snapshot;
  the snapshot schema stays strict, so the page can never supply a context of its own. The audit's
  rules read `snapshot + context`.
- **robots.txt is fetched by main, bounded** (review focus `robots-fetch-is-bounded`): only
  `<page origin>/robots.txt` of an `http(s)` page, through the browse session with Electron's
  `net.request` (`credentials: 'omit'`, `useSessionCookies: false`: no cookies, no auth prompt; no
  referrer; `cache: 'no-store'`). `net.fetch` / `session.fetch` were the first choice, but with
  `redirect: 'manual'` they reject instead of answering the 3xx, so every redirect could not be
  checked; `net.request` with `redirect: 'manual'` reports each redirect and frost aborts it and
  requests the next hop itself, after checking it: at most `maxRedirects` (5) hops, each `http(s)`
  (another origin is fine, as crawlers do), never a request to anything else, and never to a private
  host (`isPrivateHost`: `localhost`, `*.localhost`, `*.local`, loopback, RFC 1918, link-local and
  `0.0.0.0/8` IPv4 literals, IPv6 loopback, unique-local and link-local literals and IPv4-mapped
  forms) unless the page's own origin is itself private (a dev server). Only literal hosts are
  checked, without DNS: a public name that resolves to a private address (DNS rebinding and the
  like) is not caught. The body is read up to `maxBytes` (500 KiB (512,000 bytes): RFC 9309's
  minimum, and Google's documented limit; the rest is ignored) and kept as bytes: main never
  decodes it. The whole fetch has one `timeoutMs` (5 s) deadline. Answers are cached per origin for
  `cacheTtlMs` (10 min), transient failures (`ROBOTS_TRANSIENT_OUTCOMES`) for `failureTtlMs`
  (1 min), at most `maxCacheEntries` origins; concurrent requests for an origin share one fetch.
  Clear Browsing Data forgets every cached answer and every recorded response.
- **A known, observable property.** frost requests `/robots.txt` from every origin it audits (once
  per `cacheTtlMs`), with the browse session's normal user agent and no cookies. It does not pose as
  a crawler, and a site's logs show the requests.
- **Status semantics** (`ROBOTS_FETCH_OUTCOMES`, RFC 9309 §2.3.1 and common crawler practice), each
  with its own label (`ROBOTS_OUTCOME_LABELS`): 2xx is parsed (`ok`); no robots.txt, so everything
  may be crawled (`ROBOTS_ALLOW_ALL_OUTCOMES`): a 4xx other than 401, 403 and 429 (`unavailable`),
  401 or 403 (`forbidden`), more than five redirects (`too-many-redirects`), a refused private hop
  (`private-redirect`); "unknown" (`ROBOTS_UNKNOWN_OUTCOMES`): 5xx or 429 (`server-error`), a network
  error (`unreachable`), `timeout`, a redirect to a non-web address (`bad-redirect`), a 3xx without a
  `Location` (`no-location`). For unknown, crawlers assume everything is disallowed, so each bot's
  verdict is Unknown and `robots-txt-unreachable` fails. 3xx with a usable `Location` is followed.
- **Bytes are decoded in the worker, without losing one** (`decodeRobotsBytes`): valid UTF-8
  becomes characters, and every byte outside a valid UTF-8 sequence becomes its `%XX`, so a Latin-1
  `Disallow: /caf\xE9` matches the URL path `/caf%E9`, as a crawler comparing bytes would.
- **frost's own robots.txt parser** (`@app/seo-core`, written from RFC 9309, run in the worker): CR /
  LF / CRLF line ends, a BOM dropped, `#` comments, case-insensitive keys, groups of `user-agent`
  lines and their rules (only a rule, `allow` / `disallow`, ends a group's agents: a `user-agent`
  after a rule starts the next group, while `sitemap` lines and keys frost does not read, such as
  `crawl-delay`, between agents keep them in one group, as RFC 9309 and the reference parser do; so
  `User-agent: x` / `Crawl-delay: 5` / `User-agent: *` gives x the `*` group's rules; rules before
  any group are ignored; `sitemap` lines belong to none), product tokens matched case-insensitively
  (the leading letters, `-` and `_` of the value; `*` alone is every crawler, `*foo` none), a crawler's own groups merged, else the `*` groups, else no
  group; `*` wildcards and a final `$`; percent-encoding normalised on both sides (an encoded
  unreserved character decoded, other escapes uppercased, non-ASCII UTF-8 encoded); the longest
  matching rule, measured in normalised octets, wins and Allow wins a tie; `/robots.txt` is always allowed; lines over
  `maxLineChars` are ignored. Verdicts are given for `ROBOTS_AGENTS` (Googlebot, Bingbot, `*`).
- **One "Not indexable".** `NOT_INDEXABLE_RULES` (robots meta noindex, X-Robots-Tag noindex,
  robots.txt blocking Googlebot, a 4xx or 5xx status) all cap the score at `NOINDEX_SCORE_CAP` and
  make the audit `indexable: false`; the verdict lists one frost sentence per reason (the Overview
  card shows the same reasons). Only the generic noindex and Googlebot's count
  (`NOINDEX_VERDICT_NAMES`), in the meta tags and the header alike: a `googlebot-news` or `bingbot`
  noindex is a warning naming the crawler (`robots-noindex-other-bot`,
  `x-robots-noindex-other-bot`), with no cap. Otherwise robots.txt still being fetched makes the
  verdict `pending` ("Checking robots.txt…"); then a canonical (the `<link>`, else the HTTP `Link`
  header) naming another URL makes it "Indexable, but canonicalised elsewhere"; else "Indexable".
- **hreflang** is read from `<head>` (`link[rel~=alternate][hreflang]`, the extractor, capped) and
  from HTTP `Link` headers (`rel="alternate"; hreflang=…`, parsed in the worker by frost's RFC 8288
  scanner, capped), validated against frost's own tables: ISO 639-1 languages, a script from
  `ISO_15924_COMMON` (the scripts pages commonly name; a rare one is reported invalid) and an ISO
  3166-1 alpha-2 or UN M.49 area region (`es-419`). `Intl.getCanonicalLocales` accepts any
  well-formed tag, so it is not used. Reciprocity (return links) needs fetching every alternate and is out of scope.
- **Panel.** A verdict card (the label, the reasons, five signals), the ranked issues of the
  `indexing`, `indexability` and `hreflang` categories, then cards for the HTTP response (status,
  redirect chain, source note, kept headers as text), robots directives (meta and X-Robots-Tag),
  the canonical (HTML and header), robots.txt (how the fetch went, each bot's verdict with its rule
  and group, sitemaps, "Open robots.txt", "View robots.txt" showing the text inert in a `<pre>` with
  invisible characters marked, at most `maxViewChars`) and hreflang (each annotation with its flags).
  "Open" buttons go through `browser.openBackgroundTab` (`http(s)` only, disabled otherwise). The
  panel draws its own icons (inline SVG), uses no `style=` and loads nothing.

## robots.txt parser (`packages/seo-core/src/__tests__/robots.test.ts`)
- **Scenario: robots-groups-and-consecutive-agents** — frost's rewrite of RFC 9309's example:
  consecutive agents share a group, an empty group of its own allows everything, others follow `*`.
- **Scenario: robots-user-agent-after-rules-starts-a-group** — blank lines do not split agents.
- **Scenario: robots-only-rules-end-an-agent-list** — `User-agent: Googlebot` / `Crawl-delay: 10` /
  `User-agent: Bingbot` / `Disallow: /` blocks Googlebot; a `Sitemap` line between agents keeps
  them together; a crawl-delay-only crawler before `*` follows the `*` rules.
- **Scenario: robots-rules-before-any-group-are-ignored**
- **Scenario: robots-matching-groups-merge** — a crawler's groups merge; its own replace `*`.
- **Scenario: robots-product-token-matching** — `Googlebot/2.1` is Googlebot's; `Googlebot-News` is
  not; `*foo` is not the global group.
- **Scenario: robots-no-group-allows-everything**
- **Scenario: robots-directives-are-case-insensitive** — keys are; paths are not.
- **Scenario: robots-comments-bom-and-line-endings**
- **Scenario: robots-longest-match-wins-allow-on-tie** — in normalised octets: `Allow: /ツ` beats
  `Disallow: /%E3%83` on `/ツ` (measuring the raw text turns it red).
- **Scenario: robots-wildcards-and-end-anchor** — RFC 9309's matching examples, rewritten.
- **Scenario: robots-percent-encoding-is-normalised**
- **Scenario: robots-bytes-decode-without-loss** — Latin-1 `/caf\xE9` is `/caf%E9`; overlong forms,
  surrogates and cut sequences stay bytes; linear.
- **Scenario: robots-matches-path-and-query-of-url**
- **Scenario: robots-txt-itself-is-always-allowed**
- **Scenario: robots-sitemaps-are-listed-outside-groups** — capped at `maxSitemaps`, all counted.
- **Scenario: robots-size-limits-hold** — over-long lines ignored; a 500 KiB file parses and matches fast.

## Headers, hreflang, rules and verdict (`packages/seo-core/src/__tests__/indexability.test.ts`)
- **Scenario: x-robots-tag-parses-agents-and-directives** — `googlebot: noindex`, valued directives.
- **Scenario: link-header-parses-rfc-8288** — quoted commas, first `rel` wins, capped, linear.
- **Scenario: hreflang-code-tables** / **hreflang-codes-validate** — `en-UK`, `en_US`, `eng`,
  `zh-Abcd` invalid; `zh-Hant-TW`, `es-419` valid.
- **Scenario: clean-context-passes-every-indexability-rule** — and with nothing collected.
- One scenario per rule, each with a passing and a failing snapshot: **http-status-redirect**,
  **http-status-client-error**, **http-status-server-error**, **http-redirect-chain** (internal hops
  not counted), **x-robots-noindex** (generic and googlebot), **x-robots-noindex-other-bot**
  (googlebot-news, bingbot), **x-robots-nofollow**,
  **robots-txt-blocks-googlebot**, **robots-txt-blocks-all**, **robots-txt-unreachable**,
  **robots-txt-no-sitemap**, **canonical-elsewhere** (HTML or header), **canonical-header-conflict**,
  **hreflang-invalid-code**, **hreflang-missing-self** (the canonical counts), **hreflang-no-x-default**,
  **hreflang-duplicate**, **hreflang-relative-url**.
- **Scenario: verdict-indexable**, **verdict-not-indexable-caps-the-score** (each of
  `NOT_INDEXABLE_RULES`, with its reason), **verdict-other-crawlers-do-not-cap**,
  **verdict-pending-while-robots-is-fetched**, **verdict-reads-non-utf8-robots**,
  **verdict-canonicalised**, **robots-report-for-the-panel**, **http-report-for-the-panel**.

## Main (`apps/desktop/src/main/seo/__tests__/indexability.test.ts`)
- **Scenario: web-request-observers-compose** — one Electron listener per event, every observer
  called, one throwing never stops the others.
- **Scenario: response-recorded-with-redirects-and-headers** — allowlist only (never `Set-Cookie`).
- **Scenario: response-headers-are-capped**, **response-from-cache-or-restored**,
  **response-in-page-url-has-none**, **response-attributed-to-its-tab-only**,
  **response-not-committed-is-not-the-document**, **response-tracks-tabs-through-their-contents**,
  **response-recorder-clears**.
- **Scenario: response-recorded-for-a-url-longer-than-it-holds** — its URL is kept cut to
  `maxUrlChars`, but it is matched by its whole URL (fragment aside), so its status and headers are
  not lost and another URL sharing those first characters is another page.
- **Scenario: robots-fetch-origin-only** — and never for a non-`http(s)` page.
- **Scenario: robots-fetch-status-semantics**, **robots-fetch-follows-bounded-redirects**,
  **robots-fetch-never-leaves-http**, **robots-fetch-refuses-private-redirects** (unless the page
  is on a private host), **robots-fetch-caps-the-body** (bytes kept as read), **robots-fetch-times-out**,
  **robots-fetch-is-cached-and-deduplicated**, **robots-fetch-peeks-and-clears**,
  **robots-net-hop-sends-no-cookies-and-follows-nothing**.
- **Scenario: analysis-validates-the-context** — a bad context is `invalid-snapshot`; the snapshot
  cannot carry one.
- **Scenario: auditor-hands-the-context-to-the-worker**, **auditor-does-not-wait-for-robots** (ready
  at once, analysed again when robots.txt settles, `auditVersion` bumped),
  **auditor-verdict-pending-until-robots**, **auditor-drops-late-robots-for-a-page-that-moved-on**
  (or a superseded run), **auditor-survives-a-broken-context-source**.
- Clear Browsing Data: **clear-clears-everything** (`clear-browsing-data.test.ts`) clears the robots.txt
  answers and recorded responses last.
- **Scenario: extractor-reads-head-hreflang**, **extractor-caps-hreflang**.

## Renderer helpers (`apps/desktop/src/renderer/__tests__/indexability-view.test.ts`)
- **Scenario: status-labels-and-tones**, **source-notes**, **robots-labels**, **hreflang-flag-labels**,
  **verdict-signals**.

## End to end (`apps/desktop/e2e/seo-indexability.e2e.ts`, loopback servers)
- **Scenario: indexable-page-e2e** — 200, robots.txt allows, a sitemap listed; the verdict is Indexable.
- **Scenario: x-robots-noindex-header-e2e** — `X-Robots-Tag: noindex`: Not indexable, the header shown.
- **Scenario: robots-disallow-e2e** — robots.txt blocks the page: Not indexable, the rule named;
  "View robots.txt" shows the file as text; "Open robots.txt" opens it in a background tab.
- **Scenario: redirect-chain-e2e** — 301 → 200: the hop and the final response are shown.
- **Scenario: not-found-e2e** — a 404 page: Not indexable, `404 Not Found`.
- **Scenario: robots-fetch-is-bounded-e2e** — a huge robots.txt is cut at 500 KiB (512,000 bytes),
  one that redirects to a non-web address and one that never answers each end bounded
  (`bad-redirect`, `timeout`); with the one that never answers, the other panels and the
  robots.txt card's "Fetching robots.txt…" show before it settles, then the verdict and "Timed out"
  follow.
- **Scenario: hreflang-errors-e2e** — invalid codes, a duplicate, a relative URL, no self-reference.
- **Scenario: robots-fetch-sends-no-cookies-e2e** — the origin set a cookie; its robots.txt request carries none.
