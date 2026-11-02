# Feature: URL Inspection in main

Spec: `specs/gsc-inspection.spec.ts` (Zod-free: `GSC_INSPECTION_VERDICTS`, `GSC_ROBOTS_TXT_STATES`,
`GSC_INDEXING_STATES`, `GSC_PAGE_FETCH_STATES`, `GSC_CRAWLED_AS`, `GSC_RICH_SEVERITIES`,
`GSC_INSPECTION_CODE_PATTERN`, `readGscInspectionCode`, `GSC_INSPECTION_LIMITS`, `GSC_INSPECTION_RATE`,
`GSC_INSPECTION_LINK_HOST`, `isGscInspectionLink`, `GSC_OPEN_LINK_RESULTS`), `specs/gsc-inspection.schema.ts`
(`GoogleInspectionResponseSchema`, `GscInspectionAnswerSchema`, `GscInspectInputSchema`,
`GscOpenInspectionLinkInputSchema`, `GscOpenLinkResultSchema`) and `specs/gsc.spec.ts`
(`GSC_ENDPOINTS.inspectionBase`, `GSC_ENDPOINT_ENV.inspectionBase`). Phase 9 Task 2 (security review:
a new Google endpoint, untrusted strings from it, an external open). Decisions 1, 2, 3 and 6 of the
phase plan. Each line maps to one named test. Task 4 builds the card on it.

## Decisions
- **Same connection, same scope.** URL Inspection accepts `webmasters.readonly`, so `GSC_SCOPE` does not
  change and nobody connects again. The call goes to a second host, `GSC_ENDPOINTS.inspectionBase`
  (`https://searchconsole.googleapis.com/v1`), through the same `send` (`credentials: 'omit'`,
  `redirect: 'error'`, a timeout, a capped body) with the access token only in `Authorization: Bearer`.
  The body is exactly `{ inspectionUrl, siteUrl }` (no `languageCode`). Unpackaged builds with nothing
  baked in may point it at a fake with `FROST_GSC_INSPECTION_BASE`, under the same rule as the other
  `FROST_GSC_*` overrides.
- **Only when asked.** `gsc.inspect` is a mutation (it spends quota) and nothing calls it on a page
  load. It answers like every read (`unconfigured`, `not-entitled`, `not-connected`, the input, the
  property, then Google's reasons), never throws, and validates its own input.
- **Its own rate.** Inspection calls draw from their own token bucket (`GSC_INSPECTION_RATE`, 1 a
  second, burst 3); Search Analytics and `sites` calls draw from `GSC_RATE_LIMIT`. Neither drains the
  other. Google's 429 (and a 403 with a quota reason) is `quota`, as is an empty bucket (nothing sent).
  No daily counter.
- **Cached per property and page.** An `ok` answer is kept `GSC_CACHE_TTL_MS` under
  `['inspect', siteUrl, url]` (cleared with the connection); `fresh: true` ("Inspect again") skips the
  cache and replaces the entry. A read whose connection changed while it waited answers
  `not-connected` and keeps nothing.
- **Untrusted text.** Strings from Google (coverage state, rich result types, item names, issue
  messages) are cut to `GSC_INSPECTION_LIMITS.maxTextChars`; at most `maxItems` items in all and
  `maxIssues` issues each. Canonicals are kept only as `http(s)` URLs within `GSC_LIMITS.maxUrlChars`;
  the last crawl only as an ISO time. Enums are read against frost's tables: anything else (Google's
  `PARTIAL`, `*_UNSPECIFIED`, a new code) is `unknown` with the raw code kept if it is code-shaped.
  `sitemap`, `referringUrls`, AMP and `mobileUsabilityResult` are dropped while parsing.
- **The link stays in main.** `inspectionResultLink` is kept only when it is
  `https://search.google.com/…` (`isGscInspectionLink`). `gsc.openInspectionLink({ url })` names the
  page: main spends the sender window's live gesture, takes the link from its own cached `ok` answer
  for that page, checks the host again and opens it with `openExternalIfAllowed`. Anything else is
  `needs-gesture` or `no-link`, and nothing opens. It never opens a URL the renderer named, and never
  calls Google.

## Inspection (`apps/desktop/src/main/gsc/__tests__/inspection.test.ts`; fake Google `e2e/fake-google.ts`)
- `inspect-request-shape` — `POST <inspectionBase>/urlInspection/index:inspect` with exactly `{ inspectionUrl, siteUrl }` (the page without its fragment, its property), a Bearer token only, `credentials: 'omit'`, `redirect: 'error'`.
- `inspect-uses-readonly-scope` — inspecting needs no new consent and no new grant; the scope stays `webmasters.readonly`.
- `inspect-maps-enums` — every known code maps to itself; `PARTIAL`, `*_UNSPECIFIED`, a new code and a malformed one are `unknown` (raw code kept only when code-shaped); an absent `crawledAs` is `null`.
- `inspect-caps-untrusted-strings` — coverage, types, names and messages are cut to `maxTextChars`; items and issues are capped; a non-`http(s)` canonical and an unparseable crawl time are `null`.
- `inspect-ignores-mobile-usability` — `mobileUsabilityResult`, `ampResult`, `sitemap` and `referringUrls` never reach the answer.
- `inspect-link-host-checked` — a link on any other host, scheme, port or with credentials is `null`.
- `inspect-rate-bucket-separate` — exhausting the inspection bucket answers `quota` unsent, and performance reads still work.
- `performance-reads-dont-drain-inspection` — exhausting `GSC_RATE_LIMIT` with reads leaves inspection working.
- `open-link-needs-gesture-and-cached-answer` — without a live gesture in the sender's window: `needs-gesture`; without a cached `ok` answer for the page, or when its link is not on `GSC_INSPECTION_LINK_HOST`: `no-link`; only the cached link is ever opened, never a URL the renderer named, and Google is not called.
- `inspect-cache-and-fresh` — a repeat within `GSC_CACHE_TTL_MS` sends nothing; `fresh: true` asks again and replaces the entry; after the TTL it asks again.
- `inspect-quota-429-and-403` — Google's 429 and a 403 with a quota reason are `quota`; another 403 is `no-property`.
- `inspect-connection-changed-mid-read` — an inspection waiting for Google while the connection is replaced answers `not-connected` and keeps nothing.

## Configuration (`apps/desktop/src/main/gsc/__tests__/config.test.ts`)
- `inspection-base-override-unpackaged-only` — `FROST_GSC_INSPECTION_BASE` replaces `inspectionBase` only in an unpackaged build with nothing baked in, and is validated like the other overrides.

## Router (`packages/ipc-contract/src/__tests__/gsc-router.test.ts`)
- `gsc-inspect-enforces-sender` — `gsc.inspect` and `gsc.openInspectionLink` are mutations that refuse a foreign sender before the service is reached; strict inputs; `openInspectionLink` hands the service the sender's window ID and the page URL.
- `gsc-inspect-output-strict` — an inspection answer or open result with an extra member (a token) or an invalid shape (an off-host link) is a masked internal error.
