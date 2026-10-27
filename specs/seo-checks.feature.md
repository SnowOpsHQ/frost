# Feature: link status, sitemap and hreflang reciprocity checks

Spec: `specs/seo-checks.spec.ts` (`LINK_CHECK_LIMITS`, `CHECK_FETCH_OUTCOMES`, `HEAD_FALLBACK_STATUSES`,
`LINK_STATUS_KINDS`, `LINK_BROKEN_REASONS`, `LINK_SKIP_REASONS`, `LINK_ROBOTS_AGENT`, `CHECK_RUN_STATUSES`,
`CHECKS_PUSH_INTERVAL_MS`, `MAX_PENDING_CHECK_WATCHES`, `SITEMAP_NAMESPACE`, `SITEMAP_LIMITS`,
`SITEMAP_ERROR_KINDS`, `SITEMAP_INVALID_ERRORS`, `LASTMOD_FUTURE_SLACK_MS`, `HREFLANG_CHECK_LIMITS`,
`RECIPROCITY_STATUSES`, `NO_RETURN_STATUSES`, `CHECKS_VISIBILITY_NOTICE`, `CHECKS_ANALYSIS_TIMEOUT_MS`,
`CHECKS_RULE_SPECS`), `specs/seo-checks.schema.ts` (`ChecksJobSchema`, `ChecksContextSchema`, the
`checks.*` inputs), `specs/seo-snapshot.spec.ts` (`PageContext.checks`), `specs/seo-sidebar.spec.ts`
(`HIGHLIGHT_MODES`: `broken`) and `specs/seo-indexability.spec.ts` (`HREFLANG_RECIPROCITY_CHECKED`).
Phase 2.5 Task 7; review focus `link-checks-are-bounded`. Each line maps to one named test.

## Decisions
- **Every check is the user's.** Nothing is fetched until "Check links", "Check sitemaps" or "Check
  return links" is pressed (or its command-palette action runs), for the active tab's ready audit.
  The links come from main's own audit of the tab, never from the chrome.
- **One door to the network.** Every request goes through `CheckFetch` (`main/seo/checks-fetch.ts`),
  a thin mapping onto the shared bounded fetcher (`seo/fetcher.ts`, `fetcher.spec.ts`) and its rules
  (browse session, `credentials: 'omit'`, no session cookies, no referrer, `no-store`, `http(s)` only,
  manual redirects each checked before they are followed, at most 5, never to a private host unless
  the page is on one, a body cap, one deadline). The checks use the fetcher's `checks` lane, per-origin
  queues of their own (`CHECKS_FETCHER_LIMITS`: 2 at once, 250 ms apart), so an audit's robots.txt and
  served HTML never wait behind a link check. The fetcher's outcomes map onto `CHECK_FETCH_OUTCOMES`
  (`busy`, a full queue, is `unreachable`). The `User-Agent` is frost's own, or the tab's render
  profile's (printable ASCII only).
- **Bounded by construction** (`link-checks-are-bounded`). At most `maxLinks` (500) unique targets per
  run; per origin 2 in flight and 250 ms between starts; 6 in flight in all; 10 s per link. A private
  host (literal: `localhost`, RFC 1918, link-local, loopback, unique-local IPv6) is never asked from a
  public page, nor followed to by a redirect.
- **HEAD, then GET.** HEAD first; a 405 or 501 means the server does not do HEAD: the link is asked
  again with GET, its body read to 16 KB and the connection aborted, and every later link to that
  origin goes straight to GET.
- **Same-origin links robots.txt disallows (for Googlebot) are reported `blocked`, not fetched.** The
  page origin's robots.txt comes from main's cache; it is matched in the worker. Only a fetched file
  blocks: an unavailable robots.txt allows everything.
- **Results stream, and are cached.** Progress is pushed at most every 200 ms (a version that wakes the
  `checks.watch` long-poll); definite HTTP answers are cached per URL for the session (Clear Browsing
  Data forgets them). A new document, an in-page move to another URL or a closed tab cancels the
  tab's runs and aborts their requests; Stop ends a run and keeps what it found.
- **Servers' answers are parsed in a worker.** Sitemaps, alternates' heads and robots.txt matches run
  in a `worker_threads` worker of the checks' own (the analysis bundle, `CHECKS_ANALYSIS_TIMEOUT_MS`),
  so a 50 MB sitemap never holds an audit back. Sitemaps are read with `saxes` (ISC, a streaming,
  non-validating XML parser): any `<!DOCTYPE>` stops the parse (`dtd-refused`), so no DTD is read and
  no entity is defined or expanded (no XXE, no billion laughs); an undefined entity is `malformed`.
  gzip (by its magic bytes) is inflated up to 50 MB and then stopped (`too-large`); a download is read
  to 50 MB; a `Content-Encoding: gzip` answer is inflated by Chromium as it streams and capped the same.
- **Sitemaps.** robots.txt's `Sitemap:` lines (at most 10), else `/sitemap.xml`. Indexes are followed to
  depth 2, at most 20 files and 50,000 URLs per run. Reported: files read, URL count, errors, whether
  the page is listed, `lastmod` that is not a W3C Datetime or is more than a day in the future.
- **hreflang reciprocity.** Each distinct alternate other than the page (at most 20) is fetched (1 MiB,
  10 s); the worker reads its head's `<link rel="alternate" hreflang>` (stopping where the head ends)
  and its `Link` header, and says whether it lists this page (its URL or canonical) back with one of
  the values the page gives itself.
- **Visible to the sites.** Every surface shows `CHECKS_VISIBILITY_NOTICE`.
- **Rules score only finished runs** (`done`, or `stopped`). A finished run re-scores the audit (the
  active tab at once, keeping its audit on screen).

## Classification (`packages/seo-core/src/__tests__/checks.test.ts`)
- `link-target-key` — a target is its `href` without its fragment; a non-`http(s)` one has none.
- `link-classification` — 2xx ok / redirect, 4xx–5xx broken, no answer broken with why, a private redirect skipped, an abort no result.
- `head-fallback-statuses` — 405 and 501 ask again with GET; other statuses do not.
- `lastmod-w3c-datetime` — the six W3C Datetime forms pass; other forms and impossible dates are invalid.
- `lastmod-future` — later than a day from now is in the future; time zones count.
- `head-hreflang-bounded-read` — `<link rel=alternate hreflang>` in the head only: comments, raw text and the body are skipped; capped.
- `hreflang-targets-capped` — distinct alternates other than the page, at most 20, and the page's own values.
- `hreflang-reciprocity` — reciprocal, wrong language, missing return; the canonical counts as the page.
- `checks-context-of-finished-runs` — only done or stopped runs count; broken and internal redirects summarised.

## Rules (one named test per rule; an unchecked page passes all → `checks-rules-pass-unchecked`)
- `links-broken` · `links-internal-redirect` · `sitemap-page-not-listed` · `sitemap-unreachable` · `hreflang-no-return-link`

## Scheduler (`apps/desktop/src/main/seo/__tests__/checks-scheduler.test.ts`)
- `link-checks-are-bounded` — at most 2 in flight per origin and 6 in all, 250 ms between starts per origin; an abort starts nothing more and settles once the running ones have.
- `scheduler-survives-throwing-tasks` — a task that throws counts as done.

## Fetcher (`apps/desktop/src/main/seo/__tests__/checks-fetch.test.ts`)
- `check-fetch-outcomes-map` — every check outcome is one of the shared fetcher's.
- `check-fetch-follows-checked-redirects` — at most `maxRedirects`, each resolved and checked; `no-location` and non-`http(s)` stop it.
- `check-fetch-refuses-private-redirects` — a redirect to (or a target on) a private host is not requested unless the page is on one.
- `check-fetch-caps-body` — GET reads up to `maxBytes`, then cancels; HEAD reads nothing.
- `check-fetch-deadline-and-abort` — a hop that never answers times out; an abort answers `aborted`.
- `check-fetch-sends-method-agent-and-reads-headers` — the method and a printable user agent reach the hop; every `Link` header is read, past the fetcher's default header cap.
- `check-fetch-uses-the-given-fetcher` — every request goes through the fetcher it is given (main's `checks` lane) with the page and caps; a full queue (`busy`) is `unreachable`.
- The lanes themselves: `audit-never-waits-behind-a-link-check` in `fetcher.test.ts` (`seo-javascript.feature.md`, Bounded fetcher).

## Link checks (`apps/desktop/src/main/seo/__tests__/checks-links.test.ts`)
- `link-plan-dedupes-and-skips` — each target once, non-`http(s)` and private ones skipped, past 500 over the cap.
- `link-plan-private-page` — a private page's private links are checked.
- `head-get-fallback` — HEAD 405 → GET with a 16 KB body cap; the origin then goes straight to GET.
  HEAD 403 or 404 → GET too, the GET trusted, the origin not remembered (Phase 2.5 Task 2 review).

## Worker parsing (`apps/desktop/src/main/seo/__tests__/checks-analyse.test.ts`)
- `sitemap-urlset-listed` — URLs counted, the page found (fragment aside), `lastmod` problems counted.
- `sitemap-index-children` — an index's `<sitemap>` locations, at most 20.
- `sitemap-dtd-refused` — a DOCTYPE stops the parse.
- `sitemap-entity-bomb` — a billion-laughs file is refused, and an undefined entity is malformed, quickly.
- `sitemap-depth-capped` — 40,000 nested elements stop past `maxXmlDepth` (16), fast (`malformed`).
- `sitemap-listed-by-canonical-and-root` — the canonical matches; the root with or without its slash
  is one URL, other paths keep theirs.
- `sitemap-gzip-bomb-capped` — gzip is inflated to 50 MB at most, then `too-large`.
- `sitemap-wrong-namespace` — another namespace is an error; another root is not a sitemap; broken XML is malformed.
- `sitemap-url-budget` — past the run's budget it stops with `too-many-urls`.
- `alternate-return-links` — head and `Link` header annotations, resolved against the alternate.
- `robots-job-blocks-and-lists-sitemaps` — Googlebot's verdict per URL; only a fetched file blocks.
- `checks-job-validated` — anything not a `ChecksJobSchema` job is `invalid-job`.

## Runs (`apps/desktop/src/main/seo/__tests__/checks.test.ts`)
- `checks-need-active-ready-tab` — no run without the active tab's ready audit of its URL.
- `link-run-streams-results` — results arrive in link order; the state's version wakes `watch`.
- `link-run-robots-blocked` — disallowed same-origin links are `blocked` and not fetched.
- `link-run-cached` — a later document's run reuses definite answers, per URL and user agent;
  "Check again" on the same page asks afresh.
- `link-run-temporary-not-cached` — 429 and 503 are `temporary`: never cached, never broken.
- `clear-browsing-data-cancels-checks` — Clear Browsing Data cancels running checks (their requests aborted).
- `sitemap-listed-unknown-when-incomplete` — a failed file or a cap hit leaves "listed" unknown
  (`null`, "Couldn’t check every sitemap") unless the page was found; `sitemap-page-not-listed` then passes.
- `sitemap-matches-the-canonical` — the page's effective canonical counts as the page.
- `sitemap-run-byte-budget` — at most `maxRunBytes` downloaded per run; the rest `over-budget`.
- `sitemap-long-page-url-cannot-run` — a page URL past 2,048 characters fails the run, nothing requested.
- `link-run-total-cap` — 600 targets: 500 fetched, 100 over the cap (`link-checks-are-bounded`).
- `link-run-private-refused` — a public page's links to 127.0.0.1 are never fetched (`link-checks-are-bounded`).
- `checks-cancel-on-navigation` — a new document or another in-page URL cancels and aborts every request (`link-checks-are-bounded`).
- `checks-stop-keeps-results` — Stop keeps what was found and re-scores.
- `sitemap-run-follows-index` — robots.txt's sitemaps, an index to depth 2, listed or not, too deep reported.
- `sitemap-run-fallback-and-errors` — no Sitemap line: `/sitemap.xml`; when it is not there it is
  `not-found` (information, not `sitemap-unreachable`).
- `hreflang-run-statuses` — reciprocal, missing return, unreachable, private skipped.
- `checks-context-and-broken` — `contextFor` only for the same document and URL; the broken highlight's targets.

## Router (`packages/ipc-contract/src/__tests__/checks-router.test.ts`)
- `checks-procedures-enforce-sender` — every `checks.*` procedure rejects a foreign sender before the service.
- `checks-inputs-validated` — tab ids, versions and check kinds are validated; extra keys refused.
- `checks-without-service-fail-closed` — no service: a masked internal error.
- `checks-watch-long-polls` — answers at once when newer, else on the next push.

## Panels and palette (`apps/desktop/src/renderer/__tests__/checks-view.test.ts`, `checks-palette.test.ts`)
- `checks-view-labels` — status chips, tones and run summaries.
- `checks-view-result-index` — a row finds its result by target.
- `palette-checks-actions` — Check links / sitemaps / hreflang open their panel and start; Stop only while running.

## Highlight (`apps/desktop/src/main/seo/__tests__/checks-highlight.test.ts`)
- `highlight-broken-mode` — `broken` outlines only the listed targets (fragment aside).

## End to end (`apps/desktop/e2e/seo-checks.e2e.ts`)
- `link-check-statuses-e2e` — OK, redirect, 404 and HEAD-405-then-GET links show their statuses; Broken only; broken highlight draws.
- `link-check-private-refused-e2e` — a public-looking page's links to 127.0.0.1, and to a public
  name that resolves to it, are skipped and never requested.
- `sitemap-index-e2e` — an index → sitemaps → listed, and not listed for another page.
- `sitemap-gzip-bomb-e2e` — a gzip bomb sitemap stays bounded (too large) and the app keeps working.
- `hreflang-reciprocity-e2e` — a reciprocal and a non-reciprocal alternate.
- `checks-send-no-cookies-e2e` — the page's cookie is never sent with a check's requests.
- `link-check-cancel-on-navigation-e2e` — navigating mid-run cancels it: no more requests.
