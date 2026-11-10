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

Scenario: dataforseo-login-refuses-a-colon (council review)
  When a DataForSEO login holding `:` is set (RFC 7617 forbids it in a Basic user-id)
  Then `normalizeDataSecret` refuses it, `setKey` answers `invalid`, and neither half is stored
  And a password may hold `:`

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

Scenario: data-api-signal-and-before-send (Phase 12 Task 8 review; tested in `main/ai-search/__tests__/ai-search.test.ts`)
  Given a caller passes `signal` and `beforeSend`
  When the signal aborts while the request waits for its turn, while its key is opened, or in flight
  Then it answers `aborted`, ends the wait at once, aborts the fetch, and sends nothing not yet sent
  And the signal is checked again with nothing awaited before the fetch (council review), and the
  fetch's own controller starts aborted if the signal already fired, so a Stop at any earlier await
  sends nothing and counts nothing (`data-api-stop-while-counting-never-sends-after-the-stop`)
  When `beforeSend` answers false once the turn is granted
  Then it answers `cancelled` before any key is read, and nothing is sent

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
  Then that provider's count for the current UTC month goes up by one, as the request is handed to
  the fetch (council review: counted only once sent; the count is never awaited before the fetch)
  And it counts whatever the answer is (2xx, an error status, a redirect, a timeout, a network failure)
  When a request is refused before sending (`unavailable`, `busy`, `no-key`, `no-keychain`,
  `key-failed`, `not-allowed`), or stopped (`aborted`) before it is handed to the fetch
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

## Check via API (Task 4)

Plan: Task 4, Decision 7 (API results become ordinary readings in Phase 10's store), Decision 4
(nothing spends in the background). Values: `data-sources.spec.ts` (`DATA_CHECK_REFUSALS`,
`DATA_CHECK_SEARCH_RESULTS`, `DATA_CHECK_STOP_REFUSALS`, `DATA_CHECK_TEXT`), shapes:
`data-sources.schema.ts` (`DataCheckPlanInputSchema`, `DataCheckPlanSchema`,
`DataCheckProjectInputSchema`, `DataCheckProjectAnswerSchema`). Main:
`apps/desktop/src/main/data-sources/project-check.ts`; tests:
`apps/desktop/src/main/data-sources/__tests__/project-check.test.ts`,
`packages/ipc-contract/src/__tests__/data-sources-router.test.ts`, the renderer's
`apps/desktop/src/renderer/__tests__/rankings-components.test.ts` and
`apps/desktop/src/renderer/__tests__/data-sources-palette.test.ts`.

- **The vendor** is main's, re-read at every call: `resolveDataSerpProvider(stored, choices)` over
  the vendors offered (legal gate open and every slot set). No SERP vendor gate open is `unavailable`
  (`LEGAL_GATE_NOTE`); gates open but no vendor with a key is `no-key` ("Add a key in Settings › Data
  sources."); vendors offered but none chosen is `no-provider` ("Choose a provider in Settings › Data
  sources."). The renderer never decides: it reads `dataSources.checkPlan`.
- **Confirm first.** `dataSources.checkPlan({ projectId, searchIds? })` answers the vendor and the
  number of requests a check would send (one per saved search of the live project, or of the listed
  ones), or why none would. The renderer shows "This sends N requests to <provider>." and
  `DATA_SPEND_NOTE` and calls `dataSources.checkProjectSearches({ projectId, searchIds?, provider,
  requests })` only on the user's Send. Main plans again and refuses `changed` when the vendor or the
  count is not what the user confirmed (what was shown is what runs).
- **Running.** One check at a time (`busy`). The searches go one after another through Task 3's
  `checkSearchViaApi` (the client spaces them, `minIntervalMs`). Each answered snapshot is written with
  `appendApiReading`: `source = 'serp-api'`, `capture_id` `NULL`, `page_url` the vendor's canonical SERP
  request URL (`serpApiReadingPageUrl`: how the rank table names the vendor), `filters` `{}`, the search
  key `searchKeyOf(params, {})` (the saved search's own key, so the tab captures' series), the
  snapshot's status and pack version, `observed_at` the time it was stored. No location in this task:
  the readings' `SearchParams` never carry `location`.
- **Failures.** A search whose check fails (`SERP_API_OUTCOMES`) or whose write is refused is
  reported for that search; the readings already written stay, and the next search is still sent.
  After a client refusal that would refuse every request alike (`DATA_CHECK_STOP_REFUSALS`:
  `unavailable`, `no-key`, `no-keychain`, `key-failed`) the rest are `skipped`, never sent.
- **Afterwards** the project's retention policy is enforced (as after a capture run's end), when
  at least one reading was written.
- **Nothing on a timer.** Only the procedure starts a check: no timer, no schedule, no startup work.

Scenario: api-check-gated-off-refuses
  Given the shipped `SERP_API_VENDOR_AVAILABLE` (all `false`) and a stored SerpApi key
  When the renderer asks `checkPlan` and `checkProjectSearches` for a project with saved searches
  Then both answer `unavailable` with `LEGAL_GATE_NOTE`, and no request is sent and no reading written

Scenario: api-check-is-user-initiated
  Given the check service is set up with an open gate and a key
  When time passes (fake timers) and nothing calls the procedure
  Then no request is sent; only `checkProjectSearches` sends one

Scenario: api-check-says-the-count-first
  Given a project with three saved searches and SerpApi chosen
  Then `checkPlan` answers SerpApi and 3 requests, sending nothing
  And the Rankings view shows "This sends 3 requests to SerpApi." with `DATA_SPEND_NOTE` before
  anything is sent, and Cancel sends nothing
  When the confirmed vendor or count is not main's any more
  Then main answers `changed` and sends nothing

Scenario: api-check-joins-the-tab-series
  Given a project with three saved searches, one of them also captured in a tab
  When the user checks them via SerpApi
  Then three readings are stored, one per search, each with `source = 'serp-api'`, no capture,
  the saved search's key (the same key as the tab capture's reading), and no `location`
  And the rank table shows the API point in the same row as the tab capture's

Scenario: api-check-partial-failure
  Given three saved searches and a vendor that answers an error for the second
  When the user checks them
  Then the first and third readings are stored, the second is reported `failed` with its outcome
  And a client refusal for every request (`no-key`) stops the rest (`skipped`)

Scenario: api-check-palette-command
  Given main's view says a vendor is available with a key (`dataSources.serpProvider`)
  Then the palette offers "Check searches via <provider>" (the project last opened), and it opens that
  project's Rankings view on the same confirm; otherwise it is not offered

## End to end (`apps/desktop/e2e/data-sources.e2e.ts`; plan Task 11)

Over the built app, loopback only. `apps/desktop/e2e/fake-data-api.ts` stands in for every provider
(SerpApi, DataForSEO, Serper, Perplexity, OpenAI web search) on `127.0.0.1`, reached through the
unpackaged-only seam (`--frost-e2e-data-api=<file>`, every provider named); it answers synthetic JSON
(SerpApi from the unit fixture `serp/__tests__/fixtures/serp-api/serpapi.json` with per-query organic
results) and records every request as it arrived. Gates are opened only with the unpackaged-only
`--frost-e2e-open-gates=serpapi,serper`. Playwright's Electron loader always appends
`--password-store=basic`, so on Linux a stand-in keychain (`apps/desktop/e2e/fake-keychain.cjs`,
required in main before the app through `launchApp`'s `mainPreload`) makes `safeStorage` report a
secret service (`v11` blobs, the text masked); macOS and Windows use their own. Saved searches are
never visited: the check asks the fake SerpApi.

Scenario: data-sources-gated-off-in-the-real-app
  Given the app launched with no gates switch, no seam and no stand-in keychain (as shipped)
  Then every Settings › Data sources row is disabled with `LEGAL_GATE_NOTE` (fields, Save), and
  `dataSources.status` says no provider is available
  And for a project with a saved search `dataSources.checkPlan` answers `unavailable`, the Rankings
  view has no "Check via API" (nor its reason), and the palette offers no "Check searches via …"
  And the AI answers view's Ask is disabled with `LEGAL_GATE_NOTE`, each API engine says it, and
  `aiAnswers.run` answers `unavailable`

Scenario: data-sources-key-set-never-shown
  Given the SerpApi and Serper gates open
  When the user pastes a key in each row and presses Save
  Then the field is emptied, the row says "Key set", and main reports `os` protection and `hasKey`
  And no key is in the page, in any field or in main's view, and nothing was sent
  When two vendors are offered and none is chosen, the user chooses SerpApi in "Check via API uses"
  Then main's `serpProvider` is SerpApi, and its usage reads 0 this month

Scenario: data-sources-check-via-api-joins-the-series
  Given a project (site set) with three saved searches (Google, us/en, desktop) and no readings
  When the user presses "Check via API"
  Then it asks first ("This sends 3 requests to SerpApi." and `DATA_SPEND_NOTE`) and nothing is sent
  When the user sends
  Then the fake SerpApi gets exactly three `GET /search.json`, one per search, each with the key
  once in `api_key` and the search's own `engine`, `q`, `gl`, `hl`, `google_domain` and `device`
  And the view says "Checked 3 searches via SerpApi."
  And each reading lands in its saved search's row (same search key, no new row), ranked where the
  vendor put the site, marked "SerpApi API", and the search's series shows that point and source

Scenario: data-sources-usage-counts-each-search
  Then Settings shows SerpApi "This month: 3" (one per search) and Serper 0, as `dataSources.usage` says
  And the app's log names the key-less URL only (`data api: serpapi GET https://serpapi.com/search.json 200`),
  never a key or `api_key`
  And no key is in the page, main's answers, or any file of the profile (database and WAL included)
