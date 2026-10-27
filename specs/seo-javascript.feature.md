# Feature: Served HTML vs the rendered DOM

Spec: `specs/fetcher.spec.ts` (the bounded fetcher: `FETCHER_LIMITS`, `FETCH_OUTCOMES`, the request
and result types), `specs/seo-javascript.spec.ts` (`SERVED_FETCH_LIMITS`, `SERVED_PARSE_LIMITS`, the
unavailable reasons, `JAVASCRIPT_STATES`, `JS_FIELDS`, `WORD_COUNT_TOLERANCE`, `JS_DIFF_LIMITS`,
`JS_VERDICT_THRESHOLDS`, `JAVASCRIPT_RULE_SPECS`), `specs/seo-javascript.schema.ts` (the served
snapshot, `ServedStateSchema`, `javascript.refetchServed`'s input), `specs/seo-rules.spec.ts` (the
`javascript` category) and `specs/seo-sidebar.spec.ts` (`SEO_PANELS`). Phase 2.5 Task 2; review focus
`served-html-is-bounded`. Each line maps to one named test.

## Decisions
- **One bounded fetcher, extracted from robots.txt's.** `apps/desktop/src/main/seo/fetcher.ts`
  (`createBoundedFetcher`, `netHop`, `isPrivateHost`) holds the rules every request on the user's
  behalf follows (`fetcher.spec.ts`). Main has one instance; robots.txt and the served HTML share its
  per-origin queues, and Task 7's checks use it too. robots.txt keeps its own cache and outcomes on
  top (`robots-fetch.ts`); its behaviour and tests are unchanged. The per-call deadline counts from the
  call (queue wait included), so a context input always settles within its own deadline.
- **A later input of the audit.** The served HTML is the `served` input of the page's context
  (`context-source.ts`): `pending` at first, analysed again when it settles. It is kept per tab
  document, URL (without its fragment) and user agent: a new document (`did-navigate`, reloads
  included) or Clear Browsing Data drops it, and "Fetch again" drops it for the tab's URL.
  `CONTEXT_TIMEOUT_MS` grows to cover the 10 s fetch and its parse.
- **The user agent is the tab's.** The tab's render profile user agent when it has one in effect
  (not `failed`); otherwise none is set, so the browse session sends frost's own.
- **Parsed in the worker, as its own job.** Main hands the bytes to the analysis worker as a `served`
  job (same queue and `ANALYSIS_TIMEOUT_MS` as audits): decoded there, parsed with `parse5` (MIT,
  scripting enabled, like the browser that rendered the page), bounded by a counting tree adapter
  (`maxNodes`, `maxDepth`). A parse that times out or fails makes only the comparison unavailable;
  the audit itself is never affected. The served state is validated again with the audit, on its own
  (an invalid one is `unavailable` / `invalid`).
- **The same reading, minus layout.** The served snapshot reads every field the extractor reads that
  needs no layout, with the same normalising and caps: titles, meta descriptions, robots metas (bot
  ones too), canonicals, `og:url`, lang, viewport, headings (all of them: there is no visibility
  check), links (resolved against `<base href>`, with rel, anchor text and kind), images (`src`,
  `alt`), JSON-LD blocks, head hreflang, and the body's word count (`Intl.Segmenter`, outside
  `script`, `style`, `noscript`, `template`, `svg`, `math`, `iframe`, `object` and `[hidden]`, as the
  extractor; CSS-hidden text counts in the served HTML only). `<noscript>` content is parsed as a
  fragment and reported apart (count, words, links).
- **Comparison in seo-core.** `javascriptReport` (in `runAudit`, so in the worker) compares field by
  field (`JS_FIELDS`), diffs links (set of resolved http(s) URLs), headings (level and text) and
  JSON-LD blocks (their JSON), and gives the verdict (`JS_VERDICT_THRESHOLDS`). A partial served
  snapshot (a parse cap, or the 5 MB cut) is compared but checks no rule.
- **A rail panel, "JavaScript"** (last), with its own `javascript` category, so On-Page does not
  repeat its rules. "Fetch again" is `javascript.refetchServed` (`enforceSender`-first); the palette
  gets "Open JavaScript panel" and "Fetch served HTML again".
- **Sites can see it.** The panel says so (`FETCH_DISCLOSURE`): frost requests each audited page a
  second time, with no cookies, and with the user agent named above.

## Bounded fetcher (`fetcher.test.ts`)
- **Scenario: fetcher-refuses-non-web** — `file:`, `data:`, `ftp:`, `javascript:` and unparsable URLs
  are `not-web` and never requested.
- **Scenario: fetcher-follows-bounded-redirects** — redirects are followed one hop at a time up to
  `maxRedirects` (another origin allowed), each in `chain`; one more is `too-many-redirects`; a bad
  `Location` is `bad-redirect`, none `no-location`, never requested.
- **Scenario: fetcher-refuses-private-unless-page-private** — a private first URL is
  `private-address` and a private hop `private-redirect` for a public page, never requested; both
  are allowed for a page on a private host.
- **Scenario: fetcher-caps-body-and-time** — the body is read up to `maxBytes` (`truncated`, the
  request cancelled); one deadline from the call ends a hop or body that never settles (`timeout`)
  and aborts the hop's signal.
- **Scenario: fetcher-reads-body-by-status** — `readBody` decides per status; `HEAD` never reads a
  body; only the `keepHeaders` headers are kept, lowercased and cut.
- **Scenario: fetcher-rate-limits-per-origin** — at most `perOriginConcurrency` run at once per
  origin, a start waits `perOriginIntervalMs` after the previous one there, other origins do not
  wait; the first request to an idle origin starts in the same tick.
- **Scenario: fetcher-queue-is-bounded** — past `maxQueuedPerOrigin` waiting, a request is `busy`
  and never requested; a caller's abort while queued or running is `aborted`.
- **Scenario: net-hop-sends-user-agent-and-no-cookies** — `netHop` asks `net.request` with the browse
  session, `credentials: 'omit'`, no session cookies, manual redirects, no cache and no referrer, and
  sets `User-Agent` / `Accept` only when given; it reports the response headers.
- **Scenario: robots-shares-the-fetcher** — robots.txt through a shared fetcher uses its queue (the
  Phase 2 robots tests in `indexability.test.ts` pass unchanged).

## Fetching (`served.test.ts`)
- **Scenario: served-fetch-request** — the page's URL without its fragment, `GET`, cookies off
  (through the fetcher), the `Accept` of `SERVED_ACCEPT`, `maxBytes` and `timeoutMs` of
  `SERVED_FETCH_LIMITS`, the user agent given (or none), body read only for a 2xx.
- **Scenario: served-is-cached-per-document** — one fetch per tab document, URL and user agent; another
  user agent or URL fetches again; `forget` (a new document), `drop` (Fetch again) and `clear` (Clear
  Browsing Data) fetch again; at most `maxCachedPerTab` per tab.
- **Scenario: served-never-fetches-non-web** — a non-`http(s)` page is `not-fetched`, nothing requested.
- **Scenario: served-states-of-failures** — a non-2xx is `http-status` (with the status), a non-HTML
  type `not-html`, each fetch failure its own reason, a parse failure or timeout `parse-failed` /
  `parse-timeout`; a ready state carries the fetch facts and validates (`ServedStateSchema`).

## Parsing (`served-parse.test.ts`)
- **Scenario: served-parse-reads-fields** — every field of the served snapshot is read as the
  extractor reads it (titles, descriptions, robots metas with bot names, canonicals, `og:url`, lang,
  viewport, headings, links with kind and anchor text fallbacks, `<base href>`, images, JSON-LD,
  head hreflang) and the snapshot validates (`ServedSnapshotSchema`).
- **Scenario: served-parse-word-count** — words in the body outside the skipped subtrees and
  `[hidden]`, counted with `Intl.Segmenter` (CJK too); `<noscript>` content is counted apart, with its
  links.
- **Scenario: served-parse-decodes** — a BOM, the header charset, a meta charset in the first
  `prescanBytes`, else UTF-8; an unknown label is UTF-8.
- **Scenario: served-html-is-bounded** — a document past `maxNodes` or `maxDepth` (100,000 nested
  `<div>`s, a flood of elements) stops at the cap, `partial`, within the parse time budget; garbage
  bytes and a non-web URL never throw.
- **Scenario: served-parse-runs-in-the-worker** — the analyzer's `served` job posts to the worker and
  maps its timeout to `parse-timeout` (`analysis.test.ts`).
- **Scenario: served-state-validated-on-its-own** — an invalid served state in the context makes the
  comparison `unavailable` / `invalid`, and the audit still runs (`analysis.test.ts`).

## Comparison and rules (`packages/seo-core/src/__tests__/javascript.test.ts`)
- **Scenario: js-report-states** — no served state is `unavailable` / `not-fetched`; `pending`,
  `unavailable` (with its reason and status) pass through; the same page is `identical`.
- **Scenario: js-diff-fields** — each `JS_FIELDS` field is `same`, `changed`, `only-served` or
  `only-rendered`; robots and hreflang compare as sets; word counts within `WORD_COUNT_TOLERANCE` are
  the same.
- **Scenario: js-diff-lists** — links added and removed (by URL, as a set, http(s) only), headings
  and JSON-LD blocks (by JSON, so formatting does not count) with counts, capped at `maxListItems`
  with totals.
- **Scenario: js-verdict-thresholds** — `heavily`, `partly` and `independent` at the documented
  thresholds.
- **Scenario: js-canonical-changed**, **js-robots-changed**, **js-title-changed**,
  **js-content-added**, **js-links-added** — each rule fails and passes on its condition; none fails
  on a pending, unavailable or partial comparison.

## Router (`javascript-router.test.ts`)
- **Scenario: javascript-refetch-is-guarded** — `javascript.refetchServed` checks the sender before
  anything, validates `{ tabId }` strictly, answers the service's boolean and fails closed without
  the service.

## Command palette (`javascript-palette.test.ts`)
- **Scenario: javascript-palette-actions** — "Open JavaScript panel" opens the panel (its own jump,
  `FEATURE_PANEL_JUMPS`); "Fetch served HTML again" is offered on a web page with a ready audit and
  calls `refetchServed`.

## End to end (`e2e/seo-javascript.e2e.ts`, loopback)
- **Scenario: js-injected-title-canonical-links** — a page whose title, canonical and links are
  added by JavaScript shows the diff (changed title, canonical only after rendering, links added) and
  the `js-canonical-changed` warning and `js-title-changed` / `js-links-added` notices.
- **Scenario: js-identical-page** — a static page shows "Identical".
- **Scenario: served-html-is-bounded** — a 50 MB page and a deeply nested page are compared on their
  first part (`partial`) or unavailable, and the app stays responsive.
- **Scenario: served-fetch-sends-no-cookies** — the page sets a cookie; the served fetch carries none.
- **Scenario: served-fetch-uses-profile-user-agent** — with a Googlebot render profile, the served
  fetch carries that user agent, and the panel says so.
