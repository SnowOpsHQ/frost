# Feature: read-only Search Console connection and performance API

Spec: `specs/gsc.spec.ts` (Zod-free: `GSC_SCOPE`, `GSC_CONFIG_ENV`, `GSC_ENDPOINTS`, `GSC_ENDPOINT_ENV`,
`GSC_AUTH_FIXED_PARAMS`, `GSC_LIMITS`, `GSC_CACHE_TTL_MS`, `GSC_ERRORS`, `GSC_CONNECT_RESULTS`,
`GSC_PROPERTY_KINDS`, `GSC_PERMISSION_LEVELS`, `GSC_QUERY_SCOPES`, `GSC_RANGE_DAYS`, `GSC_DATA_LAG_DAYS`,
`gscDateRange`, `GSC_UNAVAILABLE_REASONS`) and `specs/gsc.schema.ts` (`GscStatusSchema`,
`GscPropertySchema`, `GscPerformanceQuerySchema`, `GscPerformanceAnswerSchema`, `GscQueriesAnswerSchema`,
`GscPropertiesAnswerSchema`, `GscPropertyForAnswerSchema`, the inputs, Google's answer schemas), with the
shared loopback and PKCE of `specs/account-state.schema.ts` / `account-api.schema.ts` and the `gsc` blob of
`specs/secret-store.spec.ts`. Phase 4 Task 8. Review focus: "Search Console asks for read-only access
only" (`gsc-scope-is-read-only`) and "The renderer never sees a token" (`answers-carry-no-secret`). Each
line maps to one named test.

## Decisions
- **Read-only, and nothing else.** The consent URL asks for exactly `GSC_SCOPE`
  (`webmasters.readonly`): no `openid`/`email` (so Google names no account and the status says only
  "connected"), never `include_granted_scopes`. A token answer whose `scope` is missing or grants
  anything else is refused: its tokens are revoked and nothing is stored (`scope-refused`). A refresh
  answer that names another scope ends the connection the same way.
- **OAuth 2.0 for installed apps** with the account's loopback listener (`account/loopback.ts`) and PKCE
  (`account/pkce.ts`): `connect(windowId)` spends a live user gesture in that app window (else
  `needs-gesture`, nothing opened), starts a listener bound to the request's `state`, and opens the
  consent URL (`GSC_AUTH_PARAMS`, `access_type=offline`, `prompt=consent`) with `openExternalIfAllowed`.
  The callback's code is exchanged with the verifier (and the installed-app client secret, which Google
  does not treat as confidential). One connect at a time: a new one replaces the pending one;
  `cancelConnect` drops it. A callback with an OAuth `error` is `cancelled`.
- **Tokens stay in main.** The refresh token lives in the secret store's `gsc` blob (memory-only
  without a real keychain); the access token only in memory, with its expiry (refreshed
  `GSC_ACCESS_TOKEN_SKEW_MS` early, one refresh at a time). An API 401 forgets the access token,
  refreshes once and retries once; a second 401 is `auth-expired`. A refresh refused with
  `invalid_grant` ends the connection (blob deleted, error `auth-expired`). `disconnect` deletes the blob
  at once and revokes the refresh token at Google's revoke endpoint (best effort; a quit waits for it at
  most `GSC_QUIT_REVOKE_TIMEOUT_MS`).
- **Gated on `search-console`** (a `pro` feature): every read answers `not-entitled`, and `connect`
  answers `not-entitled`, before anything is sent. The gate is the account service's `entitlements()`
  (`none` unless signed in). `disconnect` always works.
- **The read API never throws.** Every answer is `{ status: 'ok', … }` or `{ status: 'unavailable',
  reason }` (`GSC_UNAVAILABLE_REASONS`), checked in this order: `unconfigured`, `not-entitled`,
  `not-connected`, then the input (`not-a-web-page` for a non-`http(s)` URL, `invalid` otherwise), then
  the property (`no-property`), then Google (`auth-expired`, `quota`, `network`, `invalid`).
- **Which property.** The longest URL-prefix property whose scheme and host (with port) equal the URL's
  and whose path is a prefix of the URL's; else the most specific domain property whose domain is the
  URL's host or a parent of it (any scheme or port). `siteUnverifiedUser` properties read no data and are
  ignored. A 403 on a query (no permission any more) is `no-property` and drops the cached list.
- **Queries.** Ranges of `GSC_RANGE_DAYS` end on today's UTC date minus `GSC_DATA_LAG_DAYS` (Search
  Console's data lag), both ends inclusive. `page` scope filters `page equals <url without fragment>`;
  `property` scope has no filter. Performance asks `dimensions: ['date']`, top queries
  `dimensions: ['query']` with `rowLimit` `GSC_LIMITS.maxTopQueries`; both `type: 'web'`,
  `dataState: 'final'`. Rows outside the range are dropped; totals are computed from the rows.
- **Cache.** The property list and each answer are kept `GSC_CACHE_TTL_MS` per key (at most
  `GSC_LIMITS.maxCacheEntries`); only `ok` answers are kept; a disconnect or a new connection clears it,
  and a read that finishes after that keeps nothing.
- **Outbound calls** use `net.fetch` with `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`,
  a timeout (`GSC_LIMITS.timeoutMs`) and a body cap (`GSC_LIMITS.maxBodyBytes`); Google's answers are
  parsed with `Google*Schema` and rebuilt, and every answer is validated against its strict schema.
- **Configuration.** `GSC_CONFIG_ENV` (client ID and secret) baked in at build time; Google's endpoints
  are fixed. Only an unpackaged build with neither value baked in reads them from the run-time
  environment, and only such a build reads the `GSC_ENDPOINT_ENV` fakes (`https:`, or `http:` on
  loopback). Anything missing or malformed is `unconfigured`.
- **Logs carry no secret:** fixed messages through the account's redactor, plus Google's token shapes
  and every token, code, verifier, `state` and the client secret seen in the run.

## Spec schema (`apps/desktop/src/main/gsc/__tests__/gsc-spec.test.ts`)
- `gsc-scope-constant-is-read-only` — `GSC_SCOPE` is exactly the `webmasters.readonly` scope, and the fixed consent parameters ask for it alone (S256, offline, consent).
- `status-schema-has-no-secret-fields` — a status with a token, code, email or any other member is refused; `connected` and `connecting` are never both set; an unconfigured status is never connected.
- `answers-are-ok-or-unavailable` — each answer schema takes an `ok` answer or `{ status: 'unavailable', reason }` with a known reason, and refuses an extra member, an unknown reason or rows over the caps.
- `query-schema-is-strict` — the performance query needs an `http(s)` URL, a known scope and 7, 28 or 90 days; extra members are refused.
- `property-schema-ties-kind-to-prefix` — `domain` exactly for `sc-domain:` site URLs; a URL-prefix property is an `http(s)` URL.
- `date-range-ends-two-days-ago-utc` — `gscDateRange(days, now)` ends on today's UTC date minus two days and spans `days` days inclusive (month and year boundaries, any time of day).

## Configuration (`apps/desktop/src/main/gsc/__tests__/config.test.ts`)
- `gsc-config-missing-is-unconfigured` — no client ID, or no client secret, is `null`.
- `gsc-config-baked-uses-google-endpoints` — a build with a value baked in uses Google's endpoints and ignores every run-time value (client and `FROST_GSC_*`), packaged or not.
- `gsc-config-runtime-only-unpackaged-unbaked` — only an unpackaged build with nothing baked in reads the run-time client and endpoint overrides; a packaged one never does.
- `gsc-config-endpoint-overrides-validated` — an override must be `https:` or loopback `http:` without credentials, query or fragment; a refused one leaves Search Console unconfigured.
- `gsc-config-malformed-client-refused` — a client ID or secret outside its pattern is unconfigured.

## Properties (`apps/desktop/src/main/gsc/__tests__/properties.test.ts`)
- `property-url-prefix-longest-wins` — of several URL-prefix properties covering the URL, the longest.
- `property-scheme-and-host-exact` — `http:` vs `https:`, `www.` vs bare, another port, and a look-alike host do not match a URL-prefix property.
- `property-domain-covers-subdomains-and-schemes` — a domain property covers its host and every subdomain over both schemes and any port, but not a look-alike suffix; the most specific domain wins.
- `property-url-prefix-before-domain` — a matching URL-prefix property is chosen over a domain property.
- `property-unverified-ignored` — `siteUnverifiedUser` properties never match and are not listed.
- `property-non-web-url-none` — a non-`http(s)` URL matches nothing.
- `property-list-from-sites` — Google's site entries become sorted, de-duplicated `GscProperty` values (kind from the prefix), unknown permissions and malformed URLs dropped, capped.

## Google API (`apps/desktop/src/main/gsc/__tests__/api.test.ts`)
- `api-requests-omit-credentials` — every call is `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`, with a timeout signal and the token only in `Authorization: Bearer`.
- `api-encodes-site-url` — the site URL is one `encodeURIComponent`-encoded path segment (URL-prefix and domain).
- `api-query-bodies-page-vs-property` — page scope filters `page equals` the URL without its fragment; property scope has no filter; date and query dimensions, row limits, `type: 'web'`, `dataState: 'final'`.
- `api-maps-failures` — 401 is `auth`; 429 and a 403 with a quota reason are `quota`; another 403 is `forbidden`; no answer, a timeout, 408 and 5xx are `network`; another status, non-JSON, an over-long body or a schema mismatch is `invalid`.
- `api-validates-answers` — the sites and query answers are parsed with their schemas; an empty answer is no rows.

## Connection (`apps/desktop/src/main/gsc/__tests__/oauth.test.ts`; fake Google `e2e/fake-google.ts`, real loopback)
- `gsc-scope-is-read-only` — the consent URL has exactly `GSC_AUTH_PARAMS`, its scope exactly `GSC_SCOPE`; a token answer granting another scope too (or none) is refused, its tokens revoked, nothing stored (`scope-refused`).
- `connect-without-gesture-opens-nothing` — without a live gesture in the asking window `connect` answers `needs-gesture`, starts no listener, opens nothing, sends nothing.
- `pkce-s256-and-state-checked` — the fake Google checks the verifier against the S256 challenge; a forged `state` is 400 at the listener and nothing is exchanged; the right one completes.
- `connect-stores-refresh-token-only` — after the exchange the `gsc` blob holds the refresh token (and the scope) only; the access token is in memory; the status is connected.
- `connect-cancelled-denied-or-replaced` — an OAuth `error` is `cancelled`; `cancelConnect` closes the listener; a second `connect` replaces the first, and a late exchange of the first is revoked.
- `connect-without-refresh-token-fails` — a token answer without a refresh token is `exchange-failed` and its access token revoked.
- `refresh-on-expiry` — an expired access token is refreshed with the stored refresh token (one refresh for concurrent callers).
- `refresh-invalid-grant-disconnects` — a refresh refused with `invalid_grant` deletes the blob: not connected, error `auth-expired`.
- `disconnect-revokes-and-deletes-blob` — `disconnect` deletes the blob, revokes the refresh token at the revoke endpoint, and is not connected; a second `disconnect` answers `false`.
- `stored-connection-restores` — a stored blob starts connected; a malformed one is discarded.
- `logs-carry-no-secret` — across the whole flow no log line carries a token, code, verifier, `state` or the client secret.

## Service (`apps/desktop/src/main/gsc/__tests__/service.test.ts`)
- `not-entitled-refused-before-network` — without `search-console` every read answers `not-entitled` and `connect` answers `not-entitled`, with no request to Google.
- `unconfigured-and-not-connected` — no client: `unconfigured` everywhere; configured but not connected: `not-connected`.
- `not-a-web-page-and-invalid` — a non-`http(s)` URL is `not-a-web-page`; any other malformed query is `invalid`.
- `performance-page-vs-property-bodies` — page scope sends the `page equals` filter for the URL without its fragment; property scope sends none; both over the computed range, to the matched property.
- `performance-rows-and-totals` — rows are the range's dates in order (outside rows dropped); totals sum clicks and impressions with CTR and the impression-weighted position.
- `top-queries-capped` — top queries keep Google's order, capped at `GSC_LIMITS.maxTopQueries`, query text cut.
- `no-property` — no verified property for the URL (or a 403 on its query) is `no-property`.
- `refresh-once-on-401` — an API 401 refreshes the token and retries once; a second 401 is `auth-expired`.
- `quota-and-network-mapping` — 429 and quota 403s are `quota`; an unreachable API is `network`; a malformed answer `invalid`.
- `cache-15-minutes-cleared-on-disconnect` — a repeated read within `GSC_CACHE_TTL_MS` sends nothing; after it, or after a disconnect, it asks again.
- `never-throws` — a fetch that throws, a store that throws and garbage inputs still answer `unavailable`.
- `status-watch-long-polls` — `watch` answers at once when newer, else on the next change (connect, disconnect, entitlement change).
- `dispose-awaits-revocation` — `dispose` drops a pending connect and answers the revocations still running; nothing to wait for answers `null`.

## Router (`packages/ipc-contract/src/__tests__/gsc-router.test.ts`)
- `gsc-procedures-enforce-sender` — every `gsc.*` procedure refuses a foreign sender before the service is reached, and is the right type.
- `connect-passes-window-id` — `gsc.connect` hands the service the sender's window ID and answers its `GscConnectResult`.
- `gsc-inputs-validated` — malformed watch and query inputs are `BAD_REQUEST` before the service is reached.
- `gsc-outputs-are-strict` — a service answer with an extra member (a token) or an invalid shape is a masked internal error.
- `gsc-watch-long-polls` — `gsc.watch` long-polls on `sinceVersion` and releases its waiter after `WATCH_TIMEOUT_MS`.
- `gsc-without-service-fail-closed` — without `services.gsc` every procedure is a masked internal error.
- `answers-carry-no-secret` — no answer of any procedure carries the fake tokens or codes.

## End to end (`apps/desktop/e2e/gsc.e2e.ts`; fake backend (pro) and fake Google)
- `gsc-connect-needs-gesture` — signed in as `pro`, `gsc.connect` without a click answers `needs-gesture` and opens nothing.
- `gsc-connect-read-only-and-performance` — with a real click `connect` opens the read-only consent URL; following it as the browser connects; `gsc.performance` for a page on the loopback test site answers the fake rows for its URL-prefix property, and `gsc.topQueries` the fake queries; no answer carries a token or code.
- `gsc-disconnect-revokes` — `gsc.disconnect` makes the fake see the revocation; reads answer `not-connected`.
