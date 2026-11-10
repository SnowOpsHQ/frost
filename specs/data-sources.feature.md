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

## Usage counter (Task 2)

Tests: `apps/desktop/src/main/data-sources/__tests__/usage.test.ts`,
`packages/db/src/__tests__/data-usage.test.ts`.

Scenario: data-usage-migration-creates-table
  Given a database migrated to the latest id
  Then `0243_data_api_usage` is spread after the site crawl's `0240`/`0241`, in id order
  And `data_api_usage` has `provider`, `month` (`YYYY-MM`, UTC) and `requests`, keyed by (provider, month)
  And its `CHECK`s accept exactly `DATA_PROVIDERS` and well-formed months, and no negative count

Scenario: data-usage-counts-every-request
  When the client sends a request (it passed the gate, its turn, its key and the allowlist)
  Then that provider's count for the current UTC month goes up by one, before the fetch
  And it counts whatever the answer is (2xx, an error status, a redirect, a timeout, a network failure)
  When a request is refused before sending (`unavailable`, `busy`, `no-key`, `no-keychain`,
  `key-failed`, `not-allowed`)
  Then nothing is counted

Scenario: data-usage-keeps-twelve-months
  When a request is counted
  Then rows older than `DATA_USAGE_LIMITS.monthsKept` months (the current one included) are deleted

Scenario: data-usage-view
  When the renderer asks for `dataSources.usage`
  Then it gets this UTC month's and last month's counts per provider (0 when none), never a key

## Settings › Data sources (Task 2)

Tests: `apps/desktop/src/renderer/__tests__/settings-data-sources.test.ts`,
`apps/desktop/src/main/data-sources/__tests__/usage.test.ts` (the SERP vendor choice).

Scenario: settings-data-sources-rows
  Given Settings is open on "Data sources"
  Then the providers show in two groups, "Search results" (SerpApi, DataForSEO, Serper) and
  "AI search" (Perplexity, OpenAI web search), each a text label only (no logo or icon)
  And each row says "Key set" or "No key", and this month's and last month's request counts
  And the cost note `DATA_SPEND_NOTE` is shown
  And OpenAI web search says the agent's OpenAI key is not reused

Scenario: settings-data-sources-key-entry
  Given a provider whose legal gate is open and keys are protected (`os`)
  When the user pastes a key in its password field and presses Save
  Then the field is emptied at once, main stores the key, and the row says "Key set"
  And the key is never rendered again (no field, text or attribute holds it)
  And DataForSEO has a login and a password field, each saved on its own

Scenario: settings-data-sources-clear-asks-first
  When the user presses Clear on a row with a key
  Then the row asks first, and only "Remove key" clears it (Cancel leaves it set)

Scenario: settings-data-sources-weak-protection
  Given keys can't be protected here (`weak` or `unavailable`)
  Then each row says why and its fields and Save are disabled

Scenario: settings-data-sources-gated
  Given a provider whose legal gate is closed (`available: false`, as shipped)
  Then its row is disabled with `LEGAL_GATE_NOTE`
  And Clear stays enabled if a key is somehow set

Scenario: settings-data-sources-partial-dataforseo
  Given only the DataForSEO login is saved (`partial`: some but not all of its slots set)
  Then the row says "No key" and that only one of the login and password is saved
  And Clear is offered, and clears what was saved
  When a DataForSEO Save is answered `stored` while the row still has no key
  Then it says to add the other field ("Saved. Add the password too.")

Scenario: settings-data-sources-serp-choice
  Then "Check via API uses" lists only the vendors main offers (`choices`: open gate and key set)
  When exactly one vendor is offered and none is stored (or the stored one is no longer offered)
  Then that vendor is the one used (`resolveDataSerpProvider`, lead ruling)
  When the user picks one
  Then main stores it (`DATA_SERP_PROVIDER_KEY`), refusing a vendor whose gate is closed
  (`unavailable`) or that has no key (`no-key`)
