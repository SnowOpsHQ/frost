# Feature: SERP overlay

Spec: `specs/serp.spec.ts` (`SERP_WORLD_ID`, `SERP_READ_LIMITS`, `SERP_READ_TIMEOUT_MS`,
`SERP_ANALYSIS_TIMEOUT_MS`, `SERP_UNREADABLE_REASONS`, `SERP_READ_FAILURES`,
`SERP_UNREADABLE_MESSAGES`, `SERP_DEVICES`, `SERP_DEVICE_LABELS`, `SERP_DEVICE_OF_PRESET`,
`SERP_PARAM_LIMITS`, `SERP_FEATURE_TYPES`, `SERP_ANALYSIS_MAX_QUEUED`, `SERP_TRUNCATED_NOTE`,
`SERP_OWNER_SUFFIXES`), `specs/serp-search-params.schema.ts`
(`SearchParamsSchema`), `specs/serp-snapshot.schema.ts` (`SerpReadSchema`, `SerpSnapshotSchema`)
and the selector pack (`specs/serp-selector-pack.spec.ts`, `serp-selector-pack.schema.ts`). Phase 3
Task 3 (Reading and Analysis); Task 4 (Service, Outlines, Router and Setup) adds
`specs/serp-service.spec.ts` (`SERP_INPAGE_DEBOUNCE_MS`, `MAX_PENDING_SERP_WATCHES`,
`SERP_INTENT_CACHE_SIZE`, `SERP_OUTLINE_ACTIVE_POLL_MS`, `SERP_OUTLINE_LIMITS`, `SERP_OUTLINE_KEY`,
`SERP_OUTLINE_STYLES`) and `specs/serp-service.schema.ts` (`SerpStateSchema`, `IntentAnswerSchema`,
`PackStatusSchema`, `SerpTabStateSchema` and the router inputs); review focus
`serp-reader-is-bounded`. Each line maps to one named test.

## Decisions
- **Only pages the user loads.** frost reads a result page only when the user has loaded it in a
  tab; it never requests a search engine itself. Detection is the URL alone.
- **Detection is exact.** `http:` / `https:` only; the host one of an engine's `hosts` exactly
  (lowercase, a trailing dot ignored, the port ignored); the pathname one of its `paths` exactly; a
  query parameter present with a non-blank value. So `google.com/maps`, `bing.com/images/search`,
  `duckduckgo.com/?q=` and a subdomain of a listed host are not result pages. `html.duckduckgo.com`
  submits its form as a POST, so its result URL can carry no `q`: no query, no match.
- **Web results only.** A pack's `params.reject` names the parameters that make a URL another
  vertical (Google's `tbm` unless empty and `udm` unless 14; DuckDuckGo's `ia=news|images|videos|
  shopping|maps`): such a URL is not matched. `SearchParams` stays web-only, with no vertical field.
- **A canonical URL.** The recorded `url` is the engine host and path with the known parameters
  only (query, `gl`, `hl`, offset or page; by the pack's names, in that order): no session or
  tracking tokens, no port, no fragment. `offset` records the offset parameter as given (or
  `null`). Fields added to `SearchParamsSchema` later must be optional or nullable.
- **Search parameters by the pack's names.** The query is the first query name present with a
  non-blank value, whitespace collapsed, cut to `maxQueryChars`. `gl` and `hl` are the first of
  their names present with a well-formed value (letters, digits, `-`, `_`, at most
  `maxLocaleChars`), lowercased; otherwise `null`. The page is 1 unless the pack's page parameter
  holds a whole number: an offset counts from `offsetBase` in steps of `perPage` (Google's `start`
  from 0, Bing's `first` from 1), a page parameter is the number itself; the result is clamped to
  1 … `maxPage`. The device is the tab's render profile's (`SERP_DEVICE_OF_PRESET`: no emulation is
  `desktop`).
- **One fixed reader, the pack as JSON arguments.** `readSerp` is serialised with
  `String(readSerp)` and its arguments `JSON.stringify`'d (never a selector spliced into code), and
  runs only in the tab's isolated SERP world (`SERP_WORLD_ID`).
- **Fail closed, never guess.** Every selector in the layout is checked first (an invalid one:
  `bad-selector`); the `results` anchor must match (`no-container`); a `required` block that takes
  no result, or a page where no block takes any, is `no-results`. There is no heuristic fallback.
- **Its own world's DOM methods.** Every DOM method and getter the reader calls is taken at its
  start from its world's prototypes (walking from `document` and elements it creates) and called
  with `.call`: a `<form name="querySelector">` (which shadows `document.querySelector` in every
  world) or a form control named `closest` cannot stand in for one.
- **What is read.** Text only (text nodes, `script`/`style`/`noscript` skipped, whitespace
  collapsed, at most `maxTextReadChars` read and `maxTitleChars` kept) and the resolved `href` of an
  HTML link (`http:` / `https:`, at most `maxUrlChars`; an SVG link's animated `href` object, a
  `javascript:` link or an over-long one is no link). Organic results and ads need a link; any item
  needs a title or a link; a block that names a `title` takes no item without one (a sidebar holding
  only ads is not a knowledge panel). An item's box is its block's `box` element (its closest match
  inside the container, such as Google's result wrapper), else the item itself.
- **Precedence.** Blocks are read in pack order. An item is skipped when its closest match of
  another block's `container` lies inside this block's container (the most specific block wins,
  however many containers that block has), when its closest match of the block's `notInside` lies
  inside the container (a feature the pack does not read, such as a top-stories carousel, is never
  organic), or when it is, or is inside, an item already taken (pack order, then document order:
  nested matches count once).
- **Document order.** The items taken are sorted by document order (`compareDocumentPosition`);
  consecutive items of one block and container form one answered block, with the union of their
  boxes (document coordinates) when they have them.
- **Bounded** (review focus `serp-reader-is-bounded`). At most `maxContainersPerBlock` containers
  and `maxItemsPerBlock` items per block; everything taken is then sorted by document order and cut
  to `maxResults` results and `maxBlocks` blocks, so the bottom of the page goes first and a broad
  block above the results cannot starve them (past a cap: `truncated`; `organicCut` when organic
  results were cut, and the snapshot's `ownership.complete` is `false`, `SERP_TRUNCATED_NOTE`).
  At most `maxNodesVisited` node visits and `budgetMs` of time (past them: `timeout`, with what was
  read). Every DOM read is
  inside `try`/`catch`: an item that throws is skipped. The answer is validated again in the worker.
- **The analysis runs in a worker of its own.** `serp-analysis.cjs` (`worker_threads`, no Electron)
  validates the answer and the search parameters, assigns ranks, positions and feature slots,
  counts the composition and groups the organic results by registrable domain, then validates the
  snapshot. One job at a time, at most `SERP_ANALYSIS_MAX_QUEUED` waiting (one more drops the oldest
  waiting job, `timeout`); past `SERP_ANALYSIS_TIMEOUT_MS` the worker is terminated (`timeout`) and
  the next job spawns a new one; a crash is `invalid-answer`; a terminated worker's late answer is
  dropped; `dispose()` is final.
- **Click redirects are unwrapped in the worker.** The engine's `redirects` (host, path, parameter,
  `plain` or `bing-a1`) travel with the job and are validated there. A link through one is
  replaced by its destination (`redirected: true`) once the destination validates again as an
  `http:` / `https:` URL within `maxUrlChars`; one that does not keeps the link as read with no
  domain, so it never counts towards ownership. The reader itself never decodes anything.
- **Positions.** `rank` is a result's place among all results on the page; `position` counts organic
  results (1 … n) and, separately, ads; each feature block takes a `featureSlot` in document order.
  Positions are the page's own (page 2 starts at 1 again; `params.page` says which page).
- **Ownership.** The page's organic results by owner: a subdomain of a shared-hosting domain
  (`SERP_OWNER_SUFFIXES`: `alice.github.io`) is its own owner, otherwise the registrable domain.
  Count, share of the organic results, positions, best position; sorted by count, then best position. Ads are not counted (paid
  placements, and their links usually go through the engine's redirect).

## Detection (`apps/desktop/src/main/serp/__tests__/engines.test.ts`)
- `serp-params-per-engine` — Google `q`/`gl`/`hl`/`start` (page 3 at `start=20`), Bing `q`/`cc`/`setlang`/`first` (page 2 at `first=11`), DuckDuckGo `q`/`kl` (no `hl`, page 1); values lowercased; an engine's label and id; the URL kept.
- `serp-params-normalised` — the query collapsed, trimmed and capped; a blank `gl`/`hl` falls to the next name; a malformed or over-long one is `null`; a page that is not a whole number is 1; a huge one is clamped to `maxPage`; every result valid against `SearchParamsSchema`.
- `serp-non-serp-never-matched` — `google.com/maps`, `bing.com/images/search`, an empty or blank `q`, no `q`, a subdomain or a suffix of a listed host, a path prefix, `ftp:` / `file:` / `javascript:` URLs, a malformed or over-long URL are `null`; case and a trailing dot on the host still match.
- `serp-url-is-canonical` — the recorded URL keeps the engine host and path and the known parameters only, normalised, in order; session and tracking tokens, the port and the fragment are dropped, so two captures of one search share a URL.
- `serp-verticals-rejected` — Google `tbm=isch|vid|nws|shop` and `udm` other than 14, DuckDuckGo `ia=news|images|videos` are not matched; `udm=14`, an empty `tbm`, `ia=web` still are; `values` and `except` compare trimmed and lowercase.
- `serp-redirect-rules` — an engine's redirects for the worker, with hosts resolved to the engine's own when a rule names none.
- `serp-device-from-render-profile` — no emulation and the desktop preset are `desktop`, the phone `mobile`, the tablet `tablet`; the device is recorded in the parameters.

## Reading (`read-script.test.ts`, under jsdom, on synthetic fixtures in `__tests__/fixtures/`)
- `serp-reader-reads-fixtures` — on each engine's synthetic page the blocks come back in document order with their types, titles and links: Google's ads, featured snippet, organic results around related questions and videos, knowledge panel and related searches; Bing's ads, answer, organic and related searches; DuckDuckGo's ad and organic results.
- `serp-reader-dedupes-nested` — a featured snippet's link is not also organic; nested organic matches count once; an element two blocks match goes to the earlier block.
- `serp-reader-precedence-by-closest` — more feature containers than a block reads: their links are still never organic; two blocks sharing one container do not swallow each other.
- `serp-reader-title-required` — a sidebar holding only ads and products is not a knowledge panel.
- `serp-reader-caps-in-document-order` — 120 products above the results: the shopping block takes `maxItemsPerBlock`, every organic result is read; past `maxResults` the bottom is cut and `organicCut` set.
- `serp-reader-boxes` — an item's box is its block's `box` wrapper (else the item), in document coordinates; a block's box is the union of its items'.
- `serp-reader-resists-clobbering` — named forms and images shadowing `document`'s methods, and an element's own methods shadowed, change nothing; the reader's source reads no page object's property by name.
- `serp-unreadable-never-guesses` — a page without the results anchor is `no-container`; a page whose required block takes nothing (results present but in an unknown layout) is `no-results`, as is one where no block takes anything; nothing is guessed.
- `serp-reader-bad-selector` — an invalid `results`, `container`, `item`, `link`, `title`, `notInside` or `box` selector is `bad-selector`, before any page element is read.
- `serp-reader-time-budget` — a budget of 0 ms, or a node budget the page exceeds, is `timeout` with what was read; nothing past it is read.
- `serp-reader-is-bounded` — a hostile page (100,000 results, a megabyte title, DOM calls that throw, SVG and `javascript:` links, over-long URLs) gives an answer within `SERP_READ_LIMITS` that `SerpReadSchema` accepts, or `timeout`; it never throws.
- `serp-read-script-is-data` — the script embeds the layout and limits as JSON (a hostile selector string stays a string), and `runSerpRead` runs it once in `SERP_WORLD_ID`.
- `serp-bundled-pack-reads-fixtures` — the bundled, signed pack reads each engine's fixture into a ready snapshot (its wrapped links unwrapped: Google `/url`, Bing `/ck/a`, DuckDuckGo `/l/`; the engine never an owner), and the unreadable fixture as unreadable.

## Analysis (`serp-analyse.test.ts`, `serp-analyzer.test.ts`)
- `serp-analyse-positions` — ranks over all results; organic positions 1 … n and ad positions in their own count; feature slots in document order; composition counts every type and lists the features in order; the snapshot passes `SerpSnapshotSchema`.
- `serp-ownership-share` — organic results grouped by registrable domain (`www.` and subdomains together), with count, share, positions and best position, sorted by count then best position; ads and results without a domain are not counted; organic results cut by a cap make ownership incomplete.
- `serp-owner-suffixes` — subdomains of shared-hosting domains are separate owners (`alice.github.io`, `bob.blogspot.com`); the hosting domain itself, and ordinary hosts, by registrable domain.
- `serp-redirects-unwrapped` — Google `/url?q=` and `?url=`, Bing `/ck/a?u=a1…` (base64url UTF-8) and DuckDuckGo `/l/?uddg=` become their destination (`redirected`); a `javascript:` destination, bad base64, a missing `a1`, bytes that are not UTF-8 keep the link with no domain; another host or path is an ordinary link.
- `serp-analyse-unreadable` — a reader failure is `unreadable` with its reason and the parameters; garbage, an over-cap answer, invalid parameters, pack version or redirect rules are `invalid-answer`.
- `serp-analysis-in-worker` — jobs run one at a time in one worker, posted with their redirects; past `SERP_ANALYSIS_TIMEOUT_MS` the worker is terminated, the job is `timeout`, its late answer is dropped, and the next job spawns a new worker; a crash is `invalid-answer`; after `dispose()` jobs answer at once without a spawn; the worker's code imports no Electron.
- `serp-analysis-queue-is-bounded` — at most `SERP_ANALYSIS_MAX_QUEUED` jobs wait; more drop the oldest waiting ones (`timeout`), the rest run in order.
- `serp-worker-answers-each-job` — the worker entry answers `{ id, raw, params, packVersion, redirects }` with `{ id, result }` (garbage is `invalid-answer`) and drops a message without a numeric id.
- `serp-analysis-build-entry` — the Forge Vite build has the `serp-analysis` entry (`src/main/serp/serp-worker.ts`, the main config and target), so `.vite/build/serp-analysis.cjs` sits beside `main.cjs`.

## Service (`apps/desktop/src/main/serp/__tests__/service.test.ts`, with fakes)
Decisions: a tab's reading belongs to its WebContents, document (`documentSeq`), URL, device and the
pack's version, and is never answered for anything else. Reads start only on `did-finish-load`, on
an in-page move to another search once quiet for `SERP_INPAGE_DEBOUNCE_MS`, and when the state of a
loaded result page with no current reading is asked for; never for another page, never a request to
an engine. Intent is classified locally, only while the classifier is `ready`; only the user's
"Enable on-device intent" downloads the model, and only "Check for selector updates" requests a pack.
- `serp-service-reads-serp-loads` — a result page that finished loading is read once in its tab's page with the engine's layout and analysed with its parameters (`ready`, valid against `SerpTabStateSchema`); another page is `not-serp` and never read; an unknown tab is `not-serp` with no URL; a loading result page is `pending` with its parameters, read once it has loaded.
- `serp-service-state-per-tab` — two tabs keep their own readings (engine, query, device); a new document drops the tab's at once; a read that answers after its document went is dropped; a closed tab's reading goes; a render profile change (another device) reads the page again when next asked for.
- `serp-service-read-failures` — a reader that does not answer within `SERP_READ_TIMEOUT_MS` is `unreadable` (`timeout`, with the parameters) and never analysed; a reader that fails is `invalid-answer`; a layout it cannot read keeps its reason; an unreadable page is not read again on its own.
- `serp-service-inpage-debounced` — in-page moves to another search are read once, `SERP_INPAGE_DEBOUNCE_MS` after the last (`pending` with the new parameters meanwhile; asking does not read early); the same search at another URL keeps the reading; a move to a page that is not a result page is `not-serp` at once.
- `serp-service-watch-wakes-times-out-capped` — `watch` wakes on a change, answers at once when newer and on abort; one more than `MAX_PENDING_SERP_WATCHES` answers the oldest early; through `serp.watch`, nothing changing answers after `WATCH_TIMEOUT_MS` and releases the waiter.
- `serp-service-pack-update-swaps-live` — nothing is fetched until the user checks; an installed pack is in use at once (`PackStatus`: version, `remote`, the outcome and when, `checking` while it runs); outlines go, the active tab is read again at once with the new layout and a background tab when next asked for; a second check is `not-newer` and changes nothing.
- `serp-service-disabled-pack` — a bundled pack that fails verification disables reading (`disabled`, `pack-invalid`; nothing read, no outlines, updates `disabled`).
- `serp-service-outlines-active-tab-only` — outlines are drawn only for the active tab's `ready` reading, with the engine's layout, once; removed by the toggle, a tab switch (polled every `SERP_OUTLINE_ACTIVE_POLL_MS`), an in-page navigation (removed from the page) and a new document (gone with it); off when the page ends them (`ended`) or the paint answer is not a drawing.
- `serp-service-intent-only-when-ready` — with the model missing the answer says so and nothing is classified or downloaded; a page that is not a result page has no intent; "Enable" calls `ensureModel` once, then the current query is classified on this computer; the same query in another tab is answered from the session's answers; an `unavailable` classifier is not asked by the overlay.
- `serp-service-clear-browsing-data` — the readings, outlines and the session's intent answers go; the page is read and classified afresh when next asked for.
- `serp-read-api` — `SerpReadApi.snapshot` answers the tab's `SerpState` (valid against `SerpStateSchema`), `classifyIntent` classifies without a download; after `dispose()` waiters answer.

## Outlines (`apps/desktop/src/main/serp/__tests__/outline.test.ts`; jsdom)
Decisions: drawn as Phase 2's highlight draws (one host element of its own, a closed shadow root,
CSSOM inline styles, no markup, no stylesheet, no change to a page element), in the SERP world with
its own state key, so it never meets the highlight overlay. The overlay reads the page with the same
fixed reader and the pack's layout (JSON, never code) on each pass, so its boxes follow scrolling,
resizing and in-place updates; labels are frost's own (`SERP_OUTLINE_STYLES`) and positions, never
page text.
- `serp-outline-plan-per-type` — organic results and ads one box each, numbered in their own counts (a result without a box still counts); a feature block one box (its block's) with its type's label; every type its own colour and label; the scroll offset moves boxes (a non-finite one is 0).
- `serp-outline-plan-is-defensive` — malformed blocks, unknown or prototype-named types, non-numeric, empty or out-of-range boxes are skipped; page text is never a label.
- `serp-outlines-capped` — at most `SERP_OUTLINE_LIMITS.maxBoxes`; the overlay reads with `SERP_READ_LIMITS`.
- `serp-outline-draws-in-closed-shadow-root` — one host element last in `<html>`, closed shadow root, `aria-hidden`, `pointer-events: none`, important inline styles; the page's DOM and stylesheets untouched; the page read with the layout and limits; labels are text nodes.
- `serp-outline-follows-the-page` — the ResizeObserver's first observations are not changes; a burst of scrolling and resizing makes one more pass on the same box elements, which move; an inner scroller is heard in the capture phase.
- `serp-outline-unreadable-draws-nothing` — a pass whose read fails clears the boxes; a reader that throws draws nothing.
- `serp-outline-off-removes-everything` — drawing again replaces it (`replaced`); off removes the host and every listener (`off`), leaving the page as it was; off with nothing drawn is a no-op.
- `serp-outline-ends-when-page-removes-host` — the page taking the host out stops it (`removed`); `pagehide` ends it (`gone`).
- `serp-outline-with-the-real-reader` — the bundled pack's Google layout and the real reader on the synthetic Google fixture draw numbered organic results and ads.
- `serp-outline-script-is-self-contained` — the script parses alone, embeds the layout and config as JSON (a hostile selector stays a string), uses no markup, stylesheet, eval, Node or Electron; its key and world are not the highlight's.
- `serp-outline-runs-in-serp-world` — `runOutline` and `watchOutline` run once each in `SERP_WORLD_ID`.

## Router (`packages/ipc-contract/src/__tests__/serp-router.test.ts`)
Procedures (each `publicProcedure.use(enforceSender).use(requireSerp)` first): `serp.watch`
(`{ tabId, sinceVersion }` → `SerpTabState`, a long-poll as `checks.watch`), `serp.state`
(`{ tabId }` → `SerpTabState`), `serp.setOutlines` (`{ tabId, on }` → whether drawn),
`serp.packStatus` (→ `PackStatus`), `serp.checkPackUpdate` (→ `PackUpdateOutcome`),
`serp.intentState` (→ `IntentState`), `serp.enableIntent` (→ `IntentEnableOutcome`) and
`serp.classify` (`{ query }` → `IntentAnswer`). Task 5 adds `runProbes`, `probes` and `stopProbes`.
- `serp-procedures-enforce-sender` — every `serp.*` procedure (exactly these) refuses a foreign origin, an unknown window and a subframe, with any input, before the service is touched.
- `serp-inputs-validated` — strict inputs: a missing, non-positive or non-integer tab id, a version below −1, a non-boolean `on`, an extra field (a URL, a layout, a model), an over-long query are `BAD_REQUEST`, the service untouched.
- `serp-without-service-fail-closed` — without the service every procedure is a masked internal error; with it, each answers the service's value.
- `serp-watch-long-polls` — answers at once when newer, at the next change, else the current state after `WATCH_TIMEOUT_MS`, releasing the service's waiter.

## Setup (`apps/desktop/src/main/serp/__tests__/setup.test.ts`)
- `serp-setup-e2e-seams-unpackaged-only` — `--frost-e2e-serp-pack-url` (http allowed) and `--frost-e2e-serp-pack-key` (one more trusted key) are read only by unpackaged builds (packaged ones refuse them at startup, `PACKAGED_FORBIDDEN_SWITCHES`): a pack signed by the extra key installs from the e2e URL through the `checks` lane; packaged, the same switches change nothing; nothing is fetched until the user checks.
- `serp-setup-watches-browse-tabs-only` — each browse-session tab's page is subscribed once (`did-finish-load`, `did-navigate`, `did-navigate-in-page`, `destroyed`), the app's own window never; a bundled pack that does not verify disables reading; `will-quit` disposes the service, the worker and the intent process once.
