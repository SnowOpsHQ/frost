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
- **The record travels with the snapshot.** The auditor collects the page's context (the record and
  the robots.txt fetch) while the extractor runs, waits for it at most `CONTEXT_TIMEOUT_MS` after
  the extraction answered, and posts it to the analysis worker beside the extractor's answer. The
  worker validates it with `PageContextSchema` (strict, every cap, the header names an enum), so a
  bad context is `invalid-snapshot` like a bad snapshot; the snapshot schema stays strict, so the
  page can never supply a context of its own. The audit's rules read `snapshot + context`.
- **robots.txt is fetched by main, bounded** (review focus `robots-fetch-is-bounded`): only
  `<page origin>/robots.txt` of an `http(s)` page, through the browse session with Electron's
  `net.request` (`credentials: 'omit'`, `useSessionCookies: false`: no cookies, no auth prompt; no
  referrer; `cache: 'no-store'`). `net.fetch` / `session.fetch` were the first choice, but with
  `redirect: 'manual'` they reject instead of answering the 3xx, so every redirect could not be
  checked; `net.request` with `redirect: 'manual'` reports each redirect and frost aborts it and
  requests the next hop itself, after checking it: at most `maxRedirects` (5) hops, each `http(s)`
  (another origin is fine, as crawlers do), never a request to anything else. The body is read up
  to `maxBytes` (500 KiB = 512 000 bytes: RFC 9309's minimum, and Google's documented limit; the
  rest is ignored) and the whole fetch has one `timeoutMs` (5 s) deadline. Answers are cached per
  origin for `cacheTtlMs` (10 min), failures for `failureTtlMs` (1 min), at most `maxCacheEntries`
  origins; concurrent requests for an origin share one fetch.
- **Status semantics** (`ROBOTS_FETCH_OUTCOMES`, RFC 9309 §2.3.1 and common crawler practice): 2xx is
  parsed; 4xx (but 429) means there is no robots.txt, so everything may be crawled, and so do more
  than five redirects; 5xx, 429, a network error, a timeout or a redirect to a non-web address is
  "unknown": crawlers then assume everything is disallowed, so each bot's verdict is Unknown and
  `robots-txt-unreachable` fails. 3xx is followed.
- **frost's own robots.txt parser** (`@app/seo-core`, written from RFC 9309, run in the worker): CR /
  LF / CRLF line ends, a BOM dropped, `#` comments, case-insensitive keys, groups of consecutive
  `user-agent` lines (a `user-agent` after any other record, a rule, a `sitemap` line or a key frost
  does not read such as `crawl-delay`, starts the next group, as common crawlers do; rules before
  any group are ignored; `sitemap` lines belong to none), product tokens matched case-insensitively (the leading
  letters, `-` and `_` of the value), a crawler's own groups merged, else the `*` groups, else no
  group; `*` wildcards and a final `$`; percent-encoding normalised on both sides (an encoded
  unreserved character decoded, other escapes uppercased, non-ASCII UTF-8 encoded); the longest
  matching rule wins and Allow wins a tie; `/robots.txt` is always allowed; lines over
  `maxLineChars` are ignored. Verdicts are given for `ROBOTS_AGENTS` (Googlebot, Bingbot, `*`).
- **One "Not indexable".** `NOT_INDEXABLE_RULES` (robots meta noindex, X-Robots-Tag noindex,
  robots.txt blocking Googlebot, a 4xx or 5xx status) all cap the score at `NOINDEX_SCORE_CAP` and
  make the audit `indexable: false`; the verdict lists one frost sentence per reason (the Overview
  card shows the same reasons). Otherwise a canonical (the `<link>`, else the HTTP `Link` header)
  naming another URL makes the verdict "Indexable, but canonicalised elsewhere"; else "Indexable".
- **hreflang** is read from `<head>` (`link[rel~=alternate][hreflang]`, the extractor, capped) and
  from HTTP `Link` headers (`rel="alternate"; hreflang=…`, parsed in the worker by frost's RFC 8288
  scanner, capped), validated against frost's own ISO 639-1 / ISO 3166-1 tables (an optional
  four-letter script allowed; `Intl.getCanonicalLocales` accepts any well-formed tag, so it is not
  used). Reciprocity (return links) needs fetching every alternate and is out of scope.
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
- **Scenario: robots-user-agent-after-rules-starts-a-group** — so does one after `crawl-delay` or
  `sitemap`; blank lines do not split agents.
- **Scenario: robots-rules-before-any-group-are-ignored**
- **Scenario: robots-matching-groups-merge** — a crawler's groups merge; its own replace `*`.
- **Scenario: robots-product-token-matching** — `Googlebot/2.1` is Googlebot's; `Googlebot-News` is not.
- **Scenario: robots-no-group-allows-everything**
- **Scenario: robots-directives-are-case-insensitive** — keys are; paths are not.
- **Scenario: robots-comments-bom-and-line-endings**
- **Scenario: robots-longest-match-wins-allow-on-tie**
- **Scenario: robots-wildcards-and-end-anchor** — RFC 9309's matching examples, rewritten.
- **Scenario: robots-percent-encoding-is-normalised**
- **Scenario: robots-matches-path-and-query-of-url**
- **Scenario: robots-txt-itself-is-always-allowed**
- **Scenario: robots-sitemaps-are-listed-outside-groups** — capped at `maxSitemaps`, all counted.
- **Scenario: robots-size-limits-hold** — over-long lines ignored; a 500 KiB file parses and matches fast.

## Headers, hreflang, rules and verdict (`packages/seo-core/src/__tests__/indexability.test.ts`)
- **Scenario: x-robots-tag-parses-agents-and-directives** — `googlebot: noindex`, valued directives.
- **Scenario: link-header-parses-rfc-8288** — quoted commas, first `rel` wins, capped, linear.
- **Scenario: hreflang-code-tables** / **hreflang-codes-validate** — `en-UK`, `en_US`, `eng` invalid.
- **Scenario: clean-context-passes-every-indexability-rule** — and with nothing collected.
- One scenario per rule, each with a passing and a failing snapshot: **http-status-redirect**,
  **http-status-client-error**, **http-status-server-error**, **http-redirect-chain** (internal hops
  not counted), **x-robots-noindex** (bot-specific forms), **x-robots-nofollow**,
  **robots-txt-blocks-googlebot**, **robots-txt-blocks-all**, **robots-txt-unreachable**,
  **robots-txt-no-sitemap**, **canonical-elsewhere** (HTML or header), **canonical-header-conflict**,
  **hreflang-invalid-code**, **hreflang-missing-self** (the canonical counts), **hreflang-no-x-default**,
  **hreflang-duplicate**, **hreflang-relative-url**.
- **Scenario: verdict-indexable**, **verdict-not-indexable-caps-the-score** (each of
  `NOT_INDEXABLE_RULES`, with its reason), **verdict-canonicalised**, **robots-report-for-the-panel**,
  **http-report-for-the-panel**.

## Main (`apps/desktop/src/main/seo/__tests__/indexability.test.ts`)
- **Scenario: web-request-observers-compose** — one Electron listener per event, every observer
  called, one throwing never stops the others.
- **Scenario: response-recorded-with-redirects-and-headers** — allowlist only (never `Set-Cookie`).
- **Scenario: response-headers-are-capped**, **response-from-cache-or-restored**,
  **response-in-page-url-has-none**, **response-attributed-to-its-tab-only**,
  **response-not-committed-is-not-the-document**, **response-tracks-tabs-through-their-contents**.
- **Scenario: robots-fetch-origin-only** — and never for a non-`http(s)` page.
- **Scenario: robots-fetch-status-semantics**, **robots-fetch-follows-bounded-redirects**,
  **robots-fetch-never-leaves-http**, **robots-fetch-caps-the-body**, **robots-fetch-times-out**,
  **robots-fetch-is-cached-and-deduplicated**, **robots-net-hop-sends-no-cookies-and-follows-nothing**.
- **Scenario: analysis-validates-the-context** — a bad context is `invalid-snapshot`; the snapshot
  cannot carry one.
- **Scenario: auditor-hands-the-context-to-the-worker**, **auditor-waits-for-a-slow-context-then-goes-without**,
  **auditor-drops-a-context-for-a-page-that-moved-on**.
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
- **Scenario: robots-fetch-is-bounded-e2e** — a huge robots.txt is cut at 500 KiB, one that
  redirects to a non-web address and one that never answers each end bounded (`bad-redirect`,
  `timeout`), and the page's audit still completes.
- **Scenario: hreflang-errors-e2e** — invalid codes, a duplicate, a relative URL, no self-reference.
- **Scenario: robots-fetch-sends-no-cookies-e2e** — the origin set a cookie; its robots.txt request carries none.
