# Data sources: keys and the data API client (Phase 12 Task 1)

Plan: `docs/plans/phase-12-big-bets.md` (Decision 4, Global constraints "Secrets" and "Third-party
requests", Threat model, Task 1, and the lead's legal-gate rulings in "As built"). Values:
`data-sources.spec.ts`; shapes: `data-sources.schema.ts`. Tests:
`apps/desktop/src/main/data-sources/__tests__/`, `packages/ipc-contract/src/__tests__/data-sources-router.test.ts`.

## Keys

Scenario: data-credentials-need-os-protection
  Given no OS keychain protects keys on this computer (`weak` or `unavailable`)
  When a key is set for any data source
  Then main answers `no-keychain` and nothing is written
  And a key stored earlier is not used (`no-keychain`)

Scenario: data-credentials-sealed-to-slot
  Given keys stored for SerpApi and Serper
  When the SerpApi blob is moved into the Serper slot of `data-credentials.json`
  Then Serper has no usable key and no request is sent with SerpApi's key

Scenario: dataforseo-needs-both-slots
  Given only the DataForSEO login is set
  Then DataForSEO `hasKey` is false and a request answers `no-key` before any fetch
  When the password is set on its own
  Then the login is still set and DataForSEO `hasKey` is true

Scenario: data-key-never-leaves-main
  Given a key is stored
  Then no view (`DataSourcesView`), IPC answer, log line or thrown error contains it
  And the renderer can only set a key, clear it and learn `hasKey`

## Requests

Scenario: data-api-allowlist
  When main is asked to send a request whose method, host, port, path or query is not in
  `DATA_API_REQUESTS` for that provider and purpose (or a header outside `DATA_API_REQUEST_HEADERS`)
  Then it answers `not-allowed` and no request is sent

Scenario: data-api-refuses-redirects
  When a provider answers with a redirect
  Then the request answers `redirect` and the redirect is not followed

Scenario: data-api-response-capped
  When a provider's body is `maxResponseBytes` + 1 bytes
  Then the request answers `too-large` and the body is not read further

Scenario: data-api-error-body-withheld
  When a provider answers a status outside 2xx
  Then the request answers `http-error` with the status, and no part of the body

Scenario: serpapi-key-never-in-a-logged-url
  Given a SerpApi key is stored
  When a SerpApi request is sent (its key in the `api_key` query parameter)
  Then the request is sent inside the credential store's `withKey` closure
  And no value `dataApiRequest` returns and no log line contains the key
  And the URL returned is the key-less URL

Scenario: data-api-spaced-per-provider
  When two requests to one provider follow each other
  Then the second starts at least `minIntervalMs` after the first

Scenario: data-api-e2e-seam-only-unpackaged
  Given `--frost-e2e-data-api=<file>` maps a provider to `http://127.0.0.1:<port>`
  When the build is unpackaged
  Then that provider's allowed requests go to the loopback base with the same method, path and query
  When the build is packaged
  Then the file is never read and the app refuses to start with the switch (`PACKAGED_FORBIDDEN_SWITCHES`)

## Legal gates

Scenario: legal-gates-open-only-by-switch-unpackaged
  Given the shipped constants (all closed)
  When `--frost-e2e-open-gates=serpapi,crawl,nope` is passed to an unpackaged build
  Then the `serpapi` and `crawl` gates are open, every other gate stays closed, and `nope` is ignored
  When the build is packaged
  Then every gate keeps its shipped value

Scenario: data-gates-ship-closed
  Given the shipped `SERP_API_VENDOR_AVAILABLE` and `AI_SEARCH_PROVIDER_AVAILABLE` (all `false`)
  When a key is set for any provider
  Then main answers `unavailable` and nothing is stored
  When a request is made to any provider
  Then main answers `unavailable` (`LEGAL_GATE_NOTE`) before reading a key or sending anything
  And clearing a key still works, and the view says `available: false`
