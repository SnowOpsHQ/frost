# Phase 9 — Search Console depth and AI readiness: Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven: a fresh implementer per task
> (spec, then red, then green), a fresh reviewer before the next task starts, and a whole-branch
> review at the end. **Security-focused review:**
> - Task 2: a new Google endpoint and untrusted strings from it.
> - Task 6: more crawler requests per probe run, and agent-visible numbers.
> - Task 7: a new fetch of `/llms.txt`.
> - Task 9: new agent-protocol messages and the request budget.
> - Task 10: page text sent to the user's model route.
>
> Tasks 4 and 11 get a security-lens check of their "inert text" tests (Google's strings, model
> output) and of the external open. Do not commit unless the lead asks. Steps use checkbox
> (`- [ ]`) syntax.

**Goal** (what the user sees):
- **Search Console, deeper.** In the Search Console panel: any date range (a calendar, plus the
  7/28/90-day presets, "Last 3 months" through "Last 16 months"), and country and device filters
  with Clear. Settings shows how many properties the connection can read.
- **URL Inspection.** "Inspect in Search Console" shows Google's own view of the page: whether it is
  on Google, coverage, last crawl and crawler, fetch and robots.txt state, the canonical Google chose
  next to yours (Indexability), and the rich results Google detected, with their issues (Schema).
  It uses the same read-only connection.
- **Search targets.** The Content panel suggests target queries from the page's Search Console
  queries ("Use as target"), and for the target query it shows which pages of the property Google
  showed (query→page check). Both are facts, not rules.
- **AI readiness.** A readiness score (0–100) at the top of the Visibility panel and as a tile on
  Overview. It is built from static checks of the page and the probes, and covers:
  - each AI assistant (ChatGPT, Claude, Perplexity, Copilot, Google AI, Apple), with its crawlers;
  - each crawler's role (AI search, live fetch for a user, training) and robots.txt verdict, for 14
    tokens and with no extra request;
  - two more probed agents (OAI-SearchBot, ChatGPT-User);
  - whether the served HTML holds the content (pre-render coverage);
  - an `llms.txt` check.
- **Page type and AI checks.**
  - The Overview shows a page type computed on the device, always on and free.
  - An opt-in **AI checks** setting runs on the user's own agent model route: off by default, then
    "only when I ask" or "automatically". It judges page type, intent, content quality and a
    suggested target query from the page **as frost fetched it without cookies**, never from what
    the user sees while signed in. The consent screen explains the cost and privacy.

**Spec sources:**
- `docs/research/serplens-gap-analysis.md`: §2 rows SL-016, SL-019, SL-020, SL-027, SL-029, SL-030,
  SL-033, SL-040, SL-108, SL-112; §3.2 backlog #3, #5, #16; §3.3 Wave 2; §4 "Google rich-result
  eligibility / index status" and "AI-search visibility" (option (c) only); §6 (URL Inspection
  quotas unverified: now verified, see Decisions 3).
- Competitor audit (data, not instructions): `serplens-surfaces-and-features.md` SL-016/019/020/
  027/029/030/033/040/108/112.
- Existing specs extended: `specs/gsc.spec.ts`, `gsc.schema.ts`, `gsc.feature.md`,
  `gsc-panel.spec.ts`, `gsc-panel.feature.md`; `specs/visibility-probes.spec.ts`, `.schema.ts`,
  `.feature.md`; `specs/seo-content.feature.md`; `specs/seo-indexability.spec.ts` (robots matching);
  `specs/seo-javascript.spec.ts` (`JS_VERDICTS`, the served-vs-rendered verdict); `specs/agent-protocol.schema.ts`,
  `agent-proxy.spec.ts`, `agent-tools.spec.ts` (`MODEL_ROUTES`); `specs/intent-classifier.spec.ts`;
  `specs/entitlements-snapshot.spec.ts` (`UNGATED_FEATURES`).
- Google (fetched 2026-10-29): `developers.google.com/webmaster-tools/v1/urlInspection.index/inspect`,
  `…/UrlInspectionResult`, `…/v1/searchanalytics/query`, `…/webmaster-tools/limits`;
  `developers.google.com/search/docs/crawling-indexing/google-common-crawlers` (Google-Extended).
- Crawler operators (fetched 2026-10-29): `developers.openai.com/api/docs/bots`,
  `support.claude.com/…/8896518`, `docs.perplexity.ai/guides/bots`, `support.apple.com/en-us/119829`;
  `llmstxt.org` (a proposal, not a standard).

## Decisions

1. **One Search Console connection, read-only scope unchanged.** Google's documentation for URL
   Inspection (`POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`) accepts
   `webmasters.readonly`, so `GSC_SCOPE` does not change and nobody has to connect again. The
   connection stays per install (`GSC_PROFILE_OWNER`), ungated, with no frost account.
   *Rejected:* the full `webmasters` scope, which Inspection does not need and which allows writes.
   *Deferred (SL-112):* more than one Google account. One profile keeps one connection; Settings only
   gains the property count.
2. **URL Inspection runs only when the user asks, and goes to a second host.** It runs on a click
   ("Inspect in Search Console"), never when a page loads. The endpoint is a new
   `GSC_ENDPOINTS.inspectionBase` (`https://searchconsole.googleapis.com/v1`); `apiBase` stays on
   `webmasters/v3`. Unpackaged e2e builds get a matching override, `FROST_GSC_INSPECTION_BASE`, under
   the same `runtimeOverridesAllowed` rule.
   *Rejected:* inspecting every page on load. It would use up the per-site quota (Decision 3) while
   the user browses.
3. **Quotas are verified, not guessed** (§6 closed). Google's limits page lists:
   - URL Inspection: 2,000 queries a day and 600 a minute per site; 10,000,000 a day and 15,000 a
     minute per project.
   - Search Analytics: 1,200 queries a minute per site and per user.
   - Load is higher for long ranges and for page and query filters.

   frost's own controls:
   - Inspection gets its own token bucket (`GSC_INSPECTION_RATE`, 1 a second, burst 3), separate
     from `GSC_RATE_LIMIT`.
   - Each property URL's result is cached for `GSC_CACHE_TTL_MS`. "Inspect again" skips the cache.
   - Google's `429` (or a 403 with a quota reason) maps to the existing `quota` reason.
   - No daily counter: Google is the authority, and a counter that resets on restart would mislead.
4. **The read API grows only by additions** (`GscService` in `packages/ipc-contract/src/gsc-service.ts`
   is "stable across phases").
   - `GscPerformanceQuery` gains optional `range` (a custom `{start, end}`; exactly one of `days` and
     `range`) and optional `country` / `device`.
   - Three new methods: `countries`, `inspect` and `targetPages`.
   - Phase 5's `gsc-adapter.ts` keeps sending `{url, scope, days}` unchanged.

   *Rejected:* replacing `days` with a range everywhere. That breaks the agent adapter and every
   existing test.
5. **Range and filter values.**
   - Custom ranges end no later than the data-lag day and start no earlier than
     `gscRetentionStart(nowMs)`: the same UTC day 16 calendar months before today (Search Console's
     retention).
   - Any 16 calendar months span at most 489 days (with a leap February), so the cap is
     `GSC_MAX_RANGE_DAYS = 490`, and `GSC_LIMITS.maxDateRows` grows from 90 to 490. The "Last 16
     months" preset (`gscRetentionStart` to the lag day) therefore always fits, untruncated.
   - The agent tool's own 1–480-day input (`gsc-adapter.ts`) is unaffected.
   - Country values are Google's ISO 3166-1 alpha-3 codes. The picker lists only countries that have
     data for the page or property (a `country` dimension read, `gsc.countries`) and names them with
     `Intl.DisplayNames` through a spec table from alpha-3 to alpha-2.
   - Devices are `DESKTOP`, `MOBILE` and `TABLET`.
   - Filters and range are shared by every tab and held while the chrome runs, like
     `GSC_PANEL_DEFAULTS`. They are not persisted.
6. **Inspection results are untrusted text, shown in the panels they belong to.**
   - Indexability gets a "Google's view" card: verdict, coverage, indexing state, robots.txt state,
     page fetch state, last crawl, crawled as, and Google's canonical next to yours and next to the
     canonical frost read. A mismatch is marked as a fact.
   - Schema gets a "Detected by Google" card: rich result types, items and issues with severity.
   - Strings from Google (coverage text, item names, issue messages) are capped and shown as inert,
     bidi-isolated text.
   - Not kept or shown: `referringUrls`, `sitemap` and AMP. `mobileUsabilityResult` is deprecated by
     Google and ignored.
   - "Open in Search Console" (`inspectionResultLink`) opens externally, only on a live gesture, and
     only when the link is `https://search.google.com/…`. The renderer never passes the link:
     `gsc.openInspectionLink({ url })` names the page, and main reads the link from its cached
     answer (Task 2).
7. **Query→page targets reuse what exists.**
   - Suggestions are the page's top queries, read with the existing `gsc.topQueries` (page scope,
     the panel's range). "Use as target" calls the existing `content.setTargetQuery`.
   - The check is a new read, `gsc.targetPages`: Search Analytics with `dimensions: ['page']`, filtered
     by `query equals <target>`, over the whole property.
     - The target is first trimmed, whitespace-collapsed and lowercased, because Google reports
       queries in lowercase.
     - It reads up to `GSC_TARGET_PAGES_READ_ROWS` (1,000) rows. It answers the top
       `GSC_LIMITS.maxTargetPages` (10) by clicks, the number of pages read (`pagesRead`), and this
       page's rank among all rows read.
     - `thisPageRank: null` means "not among the pages Google returned", not "no data". An empty
       answer is `no-data`.
   - It stays a fact under the "Information, not targets" rule of `seo-content.feature.md`: no rule,
     score or colour depends on it.
8. **The AI-readiness score is static and probe-based only** (the cross-plan ruling).
   - It never reads AI-engine answers or citations. Capturing those is Phase 12, and nothing here
     waits for or reads that data.
   - It is **separate from the SEO health score**. No AI-readiness rule is added to
     `SEO_RULE_SPECS`, so no page's health score changes.

   *Rejected:* AI rules in the scored catalog. Blocking GPTBot is a legitimate choice, and it would
   lower every such site's SEO score.
9. **Robots.txt tokens versus probed agents.**
   - A new catalogue, `AI_BOTS` (`specs/ai-readiness.spec.ts`), lists 14 tokens with operator, role
     and robots.txt stance (the list is in Task 6). They are judged by seo-core against the
     robots.txt the audit already fetches (`PageContext.robots`), with `matchRobots`. **No extra
     request.**
   - Only agents whose operators publish a user agent are fetched. `PROBE_AGENT_IDS` grows from 6 to
     8 (`oai-searchbot` and `chatgpt-user` added), so `PROBE_LIMITS.maxFetches` goes to 8 and
     `maxRequests` to 32.
   - The invariants hold: `PROBE_AGENTS.length <= maxFetches`, `maxRequests = maxFetches × (1 +
     maxRedirects)`, and `ProbesState.robotsTxt.max(maxFetches)` (robots.txt origins ≤ agents).
   - The `llms.txt` fetch is counted separately (Decision 13).

   *Rejected:* probing all 14. Google-Extended and Applebot-Extended don't crawl at all. Claude
   publishes tokens but no user agent. Each extra spoofed user agent raises the risk of tripping bot
   protection.
10. **Roles and stances come from operator documentation.**
    - Roles: `ai-search`, `live-fetch` and `training`. Classic search crawlers (Googlebot, Bingbot)
      are not in `AI_BOTS`. They keep their probe kind `search` and feed `search-indexable`.
    - Applebot is `ai-search`. Apple documents that it powers Siri, Spotlight and Safari's
      suggestions, which are assistant answers rather than a classic results page, and Apple's AI
      training is controlled separately by Applebot-Extended.
    - Stances:
      - `documented`: the operator says it obeys robots.txt.
      - `may-ignore`: user-initiated fetches. OpenAI says ChatGPT-User's "robots.txt rules may not
        apply"; Perplexity says Perplexity-User "generally ignores" them.
      - `control-token`: Google-Extended and Applebot-Extended send no requests. Their operators say
        they don't affect Search inclusion or ranking.
      - `not-documented`.
    - The assistant view (`AI_ASSISTANTS`) maps ChatGPT, Claude and Perplexity to their own tokens.
      Copilot maps to Bingbot and Google AI to Googlebot plus Google-Extended; these two are frost's
      model, labelled so and listed under Open questions. Apple maps to Applebot plus
      Applebot-Extended.
11. **What the score counts.** Each check is `pass` (1), `warn` (0.5), `fail` (0) or `not-checked`.
    The score is `round(100 × Σ w·v / Σ w)` over checked, weighted checks, with "based on k of n
    checks" beside it. It is `null` (shown as pending) until the three static scored checks are
    checked.

    | Check | Weight | Source |
    |---|---|---|
    | `search-indexable` | 25 | audit indexability verdict; AI answers in Google and Bing ground on their search indexes |
    | `ai-search-crawlers` | 30 | robots.txt verdicts for the `ai-search` tokens |
    | `served-content` | 25 | `audit.javascript` verdict: `independent` pass / `partly` warn / `heavily` fail |
    | `agent-reachability` | 20 | probes, when run: the AI agents' status, `noindex` and text diff against the browser |
    | `live-fetch-agents` | 0 (shown) | robots.txt for `live-fetch` tokens, with the `may-ignore` note |
    | `training-opt-outs` | 0 (shown) | robots.txt for `training` tokens: the owner's choice, never good or bad |
    | `llms-txt` | 0 (shown) | `/llms.txt` present and well-formed (a proposal; no engine documents using it) |

    *Rejected:* scoring `llms.txt` or training opt-outs. That would reward a convention no search
    engine documents using, and penalise a legitimate privacy choice.
12. **Pre-render coverage reuses the served-vs-rendered diff, and says what it measured.** The
    served fetch uses the tab's render profile or frost's own user agent, not an AI crawler's. The
    check says so. The per-agent served text comes from `agent-reachability` (probes), which uses
    each crawler's user agent. frost assumes AI crawlers read served HTML only; this is labelled as
    frost's model (`AI_RENDERING_NOTE`).
13. **`llms.txt` is fetched only with a probe run**, once per origin and only `<origin>/llms.txt`
    (subpath files are a scope cut). It uses the probes' SERP lane and frost's own user agent. It is
    parsed in the probes' SERP worker (a new `llms-txt` job) and cached per origin like robots.txt.
    - **One consistent count.** It is not a 9th agent fetch, so `maxFetches` (8) and `maxRequests`
      (32) keep meaning "per agent". Two new members of `PROBE_LIMITS`:
      - `llmsTxtRequests = 1 + LLMS_TXT_LIMITS.maxRedirects` (= 4);
      - `maxRunRequests = maxRequests + llmsTxtRequests` (= 36): every HTTP request a run can make
        to the site, robots.txt aside, which comes from cache.
    - `PROBE_DISCLOSURE` says "at most 8 requests to the site, one per agent, plus up to 3 redirects
      each, and one request for /llms.txt (plus up to 3 redirects)".
    - Agent-visible texts that state a run's request count switch from `maxRequests` to
      `maxRunRequests` (Task 7).
    - `ProbesState.robotsTxt.max(maxFetches)` is unchanged. `llmsTxt` is its own member.
    *Rejected:* fetching it on every page load like robots.txt, which would be a new request to
    every site the user visits.
14. **Page type is on-device and deterministic; AI judgments are opt-in.**
    - `audit.pageType` (seo-core, worker): `home`, `article`, `product`, `listing`, `documentation`,
      `contact`, `landing` or `other`, with `confidence` and the signals that decided it.
    - It reads JSON-LD `@type`, `og:type`, the URL path, and a structure signal computed only from
      fields `PageSnapshot` already has: heading, link and image counts and word count. No extractor
      or snapshot-schema change.
    - Always on: it sends nothing anywhere.
    - Intent comes from the existing on-device classifier (`serp.classify`), applied to the page's
      target query, and only when on-device intent is enabled.

    *Rejected:* a downloaded page-type model. It would mean a second download and consent flow for a
    small gain over the signals the page already declares.
15. **AI checks consume the agent's existing model proxy, and no new route is added.**
    - A check is a tool-less, single-request job in the agent runtime: new protocol messages
      `check.start`, `check.finish` and `check.error`.
    - It runs on the route and model the agent settings name (any of `byok-anthropic`, `byok-openai`,
      `gateway`, `chatgpt`).
    - **A check always runs at effort `auto`.** `check.start` carries no effort, and `check.ts`
      sends no reasoning option, whatever the agent's Reasoning setting is (Phase 8 Decision 8). A
      check is a short classification call; a non-auto effort would also add thinking under
      `AI_CHECK_LIMITS.maxOutputTokens`.
    - Requests go through `model-proxy.ts`, which checks a live check's requests with Phase 8's
      composite `checkModelRequest(route, modelId, 'auto', body, headers)` (the structural
      allowlist first, then the reasoning fields against `reasoningWire` for `auto`), against the
      route and model the check began on, never the settings' effort. **A refused check request is
      never counted as an agent runtime fault** (lead ruling): it answers that check `check.error`
      (`refused`) and does not strike the runtime, so automatic mode cannot trip the strike window
      or degrade chat.
    - The request budget is the host's. Today `host.ts` adds `MAX_MODEL_REQUESTS_PER_TURN` to its
      `fetchBudget` per turn. A live check adds `MAX_MODEL_REQUESTS_PER_CHECK = 1` (new, in
      `agent-proxy.spec.ts`).
    - **Checks have their own lifecycle, separate from chats.** The host counts live checks and
      their unspent requests apart from `pendingChats` and the turn budget, and cancels them on
      their own:
      - a chat ending never clears a live check's budget (today `endChat`, `host.ts:237`, sets
        `fetchBudget = 0` when no chat is left) and never aborts a check's proxy request (today the
        proxy's `onChat` handler, `model-proxy.ts:491`, calls `abortAll()` when the last chat
        finishes); a check ending touches neither a chat's budget nor its requests;
      - main stops a check with a new main→runtime message `check.stop` (`checkId`), as `chat.stop`
        stops a turn; its unspent request is withdrawn and an in-flight one aborted;
      - a runtime failure (crash, restart, status not `ready`) cleans up both: every pending chat
        fails as today (`failPendingChats`) and every live check answers `check.error` with its
        budget and requests dropped.
    - `check.ts` calls the AI SDK with `maxRetries: 0` (the chat uses `CHAT_MAX_RETRIES = 1`), so a
      retry can never become a second request.
    - Plain text JSON is parsed in main with Zod, so no provider structured-output feature is needed.
    - Output limits per route:
      - BYOK and gateway send `maxOutputTokens = AI_CHECK_LIMITS.maxOutputTokens` (1,024; at most
        `MAX_OUTPUT_TOKENS`, which the proxy requires).
      - The `chatgpt` route sends no `max_output_tokens` or `temperature` (that route's rules).

    *Rejected:*
    - Main calling providers directly: a second credential path outside the proxy.
    - A hidden chat turn: it would appear in chat history and share the turn budget.
16. **Opt-in, off by default, never fed signed-in content, bounded, and honest about cost and
    privacy.**
    - **Modes.** `AI_CHECK_MODES = ['off', 'on-request', 'automatic']`, default `off`, stored under
      `AI_CHECKS_SETTING_KEY` in `app_settings` (no migration).
      - Leaving `off` needs the consent screen (`AI_CHECKS_ENABLE_PROMPT`).
      - `on-request` runs only on "Check this page".
      - `automatic` also runs for the active tab once its audit is ready.
    - **The input never comes from the rendered page.** The rendered DOM is what the user sees,
      signed in: webmail, banking, admin panels and docs behind a login are all on public hosts. A
      check's input is built **only from the served-HTML fetch**: the JavaScript panel's existing
      fetch through the bounded fetcher, **without cookies or credentials**
      (`seo-javascript.spec.ts`), i.e. what an anonymous visitor is sent. It uses:
      - its titles, meta descriptions, headings and JSON-LD types;
      - its word count;
      - a new capped `leadText`: the first `SERVED_LEAD_TEXT_MAX_CHARS` of the served body text,
        read in the same worker walk as `wordCount` (Task 10);
      - the URL.

      **Not** the on-device page type. `audit.pageType` (Decision 14) is computed from the rendered
      snapshot, so it stays out of the input. The model judges page type itself, and the heuristic
      type is shown beside the AI's only in the UI (Task 11). This was chosen over computing a
      second page type from `ServedSnapshot` because it is simpler: one heuristic, one input
      source, and the "served only" invariant is checkable by type.
    - **A guard on top.** A page is skipped (`not-anonymous`) unless every one of these holds:
      - the served state is `ready`;
      - the fetch answered 2xx;
      - its final URL is the tab's URL (fragment aside), so a redirect to a sign-in page skips;
      - the served snapshot is not `partial`;
      - the served HTML is not `noindex`;
      - the host is public (`isGscReadablePage`'s rule).

      A page whose anonymous version is a sign-in wall therefore sends nothing useful. It is
      skipped, and the card says why.
    - frost has no private or incognito browsing context today (none in `main/`). If one is added,
      checks are off there.
    - **Consent copy** (`AI_CHECKS_ENABLE_PROMPT`) says, in frost's words:
      - frost sends a short extract of the page as anyone signed out would get it (its title,
        headings and opening text, at most N characters), never what you see while signed in;
      - it goes to the model provider of your agent settings, on your key or ChatGPT plan, at your
        cost (a plan's usage limits apply);
      - each check is one model request;
      - automatic mode checks at most N pages an hour;
      - results stay on this computer, and Clear Browsing Data removes them;
      - you can turn it off in Settings.
    - Automatic checks wait while a chat turn runs (the chat has priority), run one at a time, and
      at most `AI_CHECK_LIMITS.maxAutomaticPerHour` an hour.
    - Results are cached per URL and input hash. "Check again" asks again.
    - Results are stored (migration **0210**), capped, and removed by Clear Browsing Data.
    - Ungated: no entitlement flag.
17. **AI output is untrusted and only displayed.** The input is wrapped as untrusted page data. The
    output is validated and capped, rendered inert, and never drives an action, a rule or the SEO
    score. The card says "AI judgment — the page's own text can influence it".
18. **Scope cuts and deferrals.**
    - Multiple Google accounts (SL-112) are deferred.
    - **No agent tool code changes, but derived numbers change.** Going from 6 to 8 probe agents
      changes the agent-visible text built from `PROBE_AGENT_IDS.length` and `PROBE_LIMITS`:
      `RUN_PROBES_APPROVAL_NOTE` (`agent-session.spec.ts`), the `run_visibility_probes` description
      (`packages/ai-skills/src/tools.ts`), and `PROBE_RUN_USER_AGENTS` / `PROBE_RUN_MAX_REQUESTS`
      (`agent-search-tools.spec.ts`). Tasks 6 and 7 list every text and test this touches.
    - A `gsc_inspect_url` tool and exact custom ranges in `gsc-adapter.ts` are deferred to a later
      wave (Phase 8 adds no tools; tool additions need their own review).
    - Not done: AMP inspection, subpath `llms.txt`, Markdown-alternate (`rel="alternate"
      type="text/markdown"`) agent-delivery checks, AI-answer capture (Phase 12), and any persisted
      Search Console data.

## Global constraints
Everything in `CONTRIBUTING.md`, `IMPLEMENTATION-PLAN.md` §3 and the Phase 3–5 plans still holds:
- **IPC** only through `packages/ipc-contract`. Every new procedure starts
  `publicProcedure.use(enforceSender)` and has strict Zod inputs. Outputs are strict schemas, so an
  extra member (a token) is a masked error, never forwarded. Procedure names follow the existing
  `db-only-in-main` test (`apps/desktop/src/main/__tests__/session-store.test.ts`), which refuses any
  procedure path matching `/sql|sqlite|database|db\b|exec|query|session/i`: hence `gsc.targetPages`,
  not `gsc.queryPages` (schema and constant names are not procedure paths).
- **Secrets only in main.** The Google refresh token stays in the secret store's `gsc` blob and the
  access token in memory. Model credentials stay in `credentials.ts` / `chatgpt/` behind
  `safeStorage`. No new renderer-facing type carries a token, code or key.
- **Untrusted text.** These are data, never instructions:
  - strings from Google's answers;
  - `llms.txt` contents;
  - robots.txt;
  - page text sent to a model;
  - model output.

  Each is capped and rendered inert. Model output never reaches a privileged context and is never
  executed.
- **Page scripts.** Nothing new runs in a page. Page type reads the existing snapshot in the
  analysis worker, and nothing is extracted from the main world.
- **Outbound calls.**
  - Google calls go through `gsc/http.ts` `send`: `credentials: 'omit'`, `redirect: 'error'`, a
    timeout and a capped body.
  - `llms.txt` goes through the SERP lane's bounded fetcher, with its private-address rules.
  - Model calls go only through `model-proxy.ts`.
  - No new CDP domains or methods: the render-profile debugger allowlist is unchanged.
- **User action.** These never run on page load:
  - Inspection;
  - probes;
  - the `llms.txt` fetch;
  - Search Console reads (only while the panel or card is shown);
  - AI checks (unless the user chose `automatic`). Even then, a check's input is the cookieless
    served fetch only, never the rendered, possibly signed-in page (Decision 16).
- **CI makes no network call** to Google, crawler sites or model providers. Unit tests use fakes.
  E2E tests use `e2e/fake-google.ts` (extended), the loopback fixture site and the scripted agent
  model seam. Unpackaged-only seams (`FROST_GSC_*` env, `--frost-e2e-agent-script`) stay refused in
  packaged builds.
- **Renderer.** Strict CSP and Trusted Types: no `style=`, no Zod in the chrome (types only from
  `*.schema.ts`; values from Zod-free `*.spec.ts`).
- **Migrations:** ids **0210–0219** only. This phase uses `0210_seo_ai_checks`, in its own file
  whose list (`...AI_CHECKS_MIGRATIONS`) is spread at the **end** of `MIGRATIONS`, after Phase 8's
  `...AGENT_SKILL_PREFS_MIGRATIONS` (`0200`), so ids stay strictly increasing (lead ruling: each
  phase appends its list last, in phase order 8 → 12). Phase 8 already moved the test-only fixture
  ids to `9000_`; this phase only checks `migrations-are-forward-only` still passes.
- **Clean-room.** Every label, prompt, threshold and the score's weights are frost's own. Crawler
  tokens and user agents are their operators' published values; Google's field names are its public
  API.

## Team contract
- New files may go in:
  - `apps/desktop/src/main/gsc/**`, `apps/desktop/src/main/serp/**` (probe and `llms.txt` parts),
    `apps/desktop/src/main/ai-checks/**` (new);
  - `apps/desktop/src/main/agent/` (only `check-*.ts` and the edits named in Task 9),
    `apps/agent-runtime/src/check.ts` (new);
  - `apps/desktop/src/main/seo/served-parse.ts`, `specs/seo-javascript.spec.ts` and
    `specs/seo-javascript.schema.ts` (Task 10's optional, main-only `leadText` and
    `SERVED_LEAD_TEXT_MAX_CHARS` only).
  - `packages/seo-core/src/ai-readiness/**`, `packages/seo-core/src/page-type/**` (new);
  - `packages/ipc-contract/src/{gsc-router,gsc-service,serp-router,serp-service}.ts`,
    `packages/ipc-contract/src/ai-checks-{router,service}.ts` (new);
  - `packages/db/src/ai-checks*.ts` (new);
  - renderer `components/seo/**`, `gsc-*.ts`, `ai-readiness-*.ts`, `ai-checks-*.ts`,
    `page-type-*.ts`, `settings-ai-checks*.ts(x)`, `hooks/use*.ts`;
  - `specs/gsc*`, `specs/ai-readiness*`, `specs/ai-checks*`, `specs/page-type*`,
    `specs/visibility-probes*`;
  - `apps/desktop/e2e/*`.
- Hub files get one-line, append-only registrations only:
  - `apps/desktop/src/main/index.ts` (create the AI-checks service, pass it to services);
  - `packages/ipc-contract/src/router.ts` (`aiChecks: aiChecksRouter`) and `services.ts`
    (`aiChecks?`);
  - `packages/db/src/migrations.ts` (`...AI_CHECKS_MIGRATIONS`, spread last, after Phase 8's
    `0200` block);
  - `App.tsx` (none expected);
  - the palette registry (actions register from their own modules, as `gsc-palette.ts` does);
  - root config (none).
- Shared files edited in place with care:
  - `specs/agent-protocol.schema.ts` (`AGENT_PROTOCOL_VERSION`) and `agent-proxy.spec.ts`. **Phase 8
    also bumps the protocol** (reasoning effort). Whichever merges second takes the next version
    number and rebases its tests.
  - `apps/desktop/src/main/agent/model-proxy.ts` after Phase 8: its turn path calls
    `checkModelRequest(route, modelId, effectiveEffort(settings), …)` and strikes on a `reasoning`
    refusal. Task 9 adds a separate branch for a live check's request (`'auto'`, the check's route
    and model, never counted), leaving Phase 8's five-step turn flow unchanged, and limits the
    last-chat abort (`:491`) to turn requests (Decision 15's check lifecycle).
  - The derived-number sites of Tasks 6 and 7, edited only for the probe counts:
    - `specs/agent-session.spec.ts` (`RUN_PROBES_APPROVAL_NOTE`);
    - `specs/agent-search-tools.spec.ts` (`PROBE_RUN_*`);
    - `packages/ai-skills/src/tools.ts` (`run_visibility_probes` description);
    - their tests;
    - `apps/desktop/README.md`.
- Stale wording to fix while touching these files: `gsc-panel.spec.ts` header ("gated on
  `search-console` (a `pro` feature)"), the `GscService` doc ("is gated on the `search-console`
  feature itself") and the `GscPanel.tsx` header ("included in the plan"). Search Console is ungated
  (`UNGATED_FEATURES`).

## Tasks

### Task 1 — Search Console: custom range and country/device filters (main + IPC)
Purpose: SL-040 data side.
- [ ] **Spec.**
  - `specs/gsc.spec.ts`:
    - `GSC_MAX_RANGE_DAYS = 490`, `GSC_RETENTION_MONTHS = 16` and `gscRetentionStart(nowMs)`
      (Decision 5);
    - `GSC_DEVICES = ['DESKTOP','MOBILE','TABLET']`;
    - `GSC_COUNTRY_ALPHA3` (alpha-3 → alpha-2 table) and `GSC_COUNTRY_PATTERN = /^[a-z]{3}$/`
      (Google answers lowercase);
    - `gscCustomRange(start, end, nowMs)`, which validates against the data lag and retention;
    - `GSC_LIMITS.maxDateRows` 90 → 490 and `maxCountries: 250`.
  - `specs/gsc.schema.ts`:
    - `GscPerformanceQuerySchema` gets exactly one of `days` | `range`, plus optional `country` and
      `device` (strict);
    - new `GscCountriesAnswerSchema` (`{status:'ok', property, range, countries:[{country, clicks,
      impressions}]}`).
  - `specs/gsc.feature.md` gets a "Ranges and filters" section.
  - Fix the stale gating wording (Team contract).
- [ ] **Red.**
  - `apps/desktop/src/main/gsc/__tests__/api.test.ts`:
    - `body-custom-range` (start/end as given);
    - `body-filters`: a page filter plus `country equals` plus `device equals` in one `and` group;
      the property scope sends no page filter.
  - `service.test.ts`:
    - `custom-range-validated`: future end, before `gscRetentionStart`, over 490 days or start >
      end → `invalid` with nothing sent;
    - `range-16m-preset-valid`: `gscRetentionStart(now)` to the lag day is accepted for every
      `now` across two years (leap February included), with every row kept (≤ `maxDateRows`);
    - `filters-in-cache-key`: different filters → separate reads; the same → one;
    - `countries-read` (dimension `country`, at most `maxCountries`);
    - `days-shape-still-works`: `{url, scope, days}` unchanged; the agent adapter's type-level test
      still passes.
  - `gsc-spec.test.ts`: `country-table-round-trips`.
  - `packages/ipc-contract/src/__tests__/gsc-router.test.ts`: `gsc-countries-procedure-enforces-sender`;
    `performance-input-strict` (both `days` and `range` refused).
- [ ] **Green.**
  - `gsc/api.ts`: `searchAnalyticsBody` takes a range and filters, and gains the `country` dimension.
  - `gsc/service.ts`: `resolveQuery` takes range or days; `runQuery` cache key; new `countries`.
  - `packages/ipc-contract/src/gsc-service.ts` (`countries`) and `gsc-router.ts` (`countries`).
- **Acceptance:** every existing gsc test passes unchanged, plus the new ones.
- **Risks:** Google's dates are Pacific time and frost's are UTC (already documented), and a custom
  end date can land on a partial day. Clamp the end to the lag day.

### Task 2 — URL Inspection in main (security review)
Purpose: SL-027 and SL-033 data.
- [ ] **Spec.** New `specs/gsc-inspection.spec.ts` (Zod-free):
  - `GSC_INSPECTION_VERDICTS` (`PASS`, `FAIL`, `NEUTRAL`; `PARTIAL` and `VERDICT_UNSPECIFIED` read as
    `unknown`), `GSC_ROBOTS_TXT_STATES`, `GSC_INDEXING_STATES`, `GSC_PAGE_FETCH_STATES`,
    `GSC_CRAWLED_AS`, `GSC_RICH_SEVERITIES`, each with frost's labels;
  - `GSC_INSPECTION_LIMITS` (`maxItems: 50`, `maxIssues: 20`, `maxTextChars: 500`);
  - `GSC_INSPECTION_RATE = { perSecond: 1, burst: 3 }`;
  - `GSC_INSPECTION_LINK_HOST = 'search.google.com'`.

  New `specs/gsc-inspection.schema.ts`:
  - `GoogleInspectionResponseSchema` (lenient: unknown members stripped, unknown enum strings read
    as `unknown`);
  - `GscInspectionAnswerSchema` (strict):
    - `{status:'ok', property, url, inspectedAt}`;
    - `index: {verdict, coverageState, robotsTxtState, indexingState, pageFetchState, lastCrawlTime|null,
      crawledAs|null, googleCanonical|null, userCanonical|null}` (Google's `sitemap` and
      `referringUrls` are dropped while parsing: Decision 6);
    - `richResults: {verdict, types:[{type, items:[{name, issues:[{message, severity}]}]}]} | null`;
    - `link | null`;
    - or `GscUnavailable`.
  - `GscInspectInputSchema` (`{url, fresh?: boolean}`);
  - `GscOpenInspectionLinkInputSchema` (`{url}`: the page, never the link) and its result
    `GSC_OPEN_LINK_RESULTS = ['opened','needs-gesture','no-link']`.

  `specs/gsc.spec.ts`: `GSC_ENDPOINTS.inspectionBase` and `GSC_ENDPOINT_ENV.inspectionBase =
  'FROST_GSC_INSPECTION_BASE'`. The `GscEndpoints` type then requires the key everywhere one is
  built: `gsc/__tests__/harness.ts`, `e2e/fake-google.ts` (`endpoints` and its `env`) and any test
  fixture. `e2e/harness.ts` already strips every `FROST_GSC_*` and needs no change. New
  `specs/gsc-inspection.feature.md`.
- [ ] **Red.**
  - `gsc/__tests__/inspection.test.ts`:
    - `inspect-request-shape`: `POST <inspectionBase>/urlInspection/index:inspect` with
      `{inspectionUrl, siteUrl}` (no `languageCode`), a Bearer token only, `redirect:'error'`;
    - `inspect-uses-readonly-scope`: no reconnect, and `GSC_SCOPE` unchanged;
    - `inspect-maps-enums`, including unknown and deprecated values;
    - `inspect-caps-untrusted-strings`;
    - `inspect-ignores-mobile-usability`;
    - `inspect-link-host-checked` (any other host → `link: null`);
    - `inspect-rate-bucket-separate`: exhausting inspection leaves performance reads working;
    - `performance-reads-dont-drain-inspection`: exhausting `GSC_RATE_LIMIT` leaves inspection
      working;
    - `open-link-needs-gesture-and-cached-answer`: `needs-gesture` without a live gesture in the
      sender's window; `no-link` without a cached `ok` answer for that URL or when its host is not
      `GSC_INSPECTION_LINK_HOST`; it never opens anything the renderer named;
    - `inspect-cache-and-fresh`;
    - `inspect-quota-429-and-403`;
    - `inspect-connection-changed-mid-read` → `not-connected`.
  - `config.test.ts`: `inspection-base-override-unpackaged-only`.
  - `gsc-router.test.ts`: `gsc-inspect-enforces-sender`, `gsc-inspect-output-strict`.
- [ ] **Green.**
  - `gsc/config.ts` (the new endpoint);
  - `gsc/api.ts` (`inspect`, built on the same `call`);
  - `gsc/inspection.ts` (new: mapping and caps);
  - `gsc/service.ts`:
    - `withToken` takes the bucket to draw from as a parameter. Reads pass the `GSC_RATE_LIMIT`
      bucket, and `inspect` passes its own `GSC_INSPECTION_RATE` bucket, so neither drains the
      other.
    - `inspect` caches under key `['inspect', siteUrl, url]`.
  - `gsc-service.ts` / `gsc-router.ts`:
    - `inspect` is a mutation: it spends quota.
    - `openInspectionLink({url})` is a mutation that uses `ctx.sender.windowId` like `connect`. Main
      consumes that window's live gesture, takes `link` from its own cached answer for `url`,
      re-checks the host, and calls `openExternalIfAllowed`. Any failure is `needs-gesture` or
      `no-link`, and nothing opens (fails closed).
- **Acceptance:** nothing is sent without `inspect` being called; no token is in any answer; all
  tests are green.
- **Risks:** Google adds enum values (they read as `unknown` and are shown as the raw code, capped);
  the 2,000 a day per-site quota.

### Task 3 — Search Console panel: calendar range, filters, Settings property count
Purpose: SL-040 UI and SL-112 property count.
- [ ] **Spec.** `specs/gsc-panel.spec.ts`:
  - `GSC_RANGE_PRESETS` (7, 28, 90 days; `3m`, `6m`, `12m`, `16m`; `custom`). Month presets count
    calendar months back from the lag day, and `16m` starts at `gscRetentionStart`;
  - `GSC_PANEL_DEFAULTS` gains `country: null, device: null`;
  - `GSC_FILTER_TEXT` (labels, "Clear filters", "All countries", "All devices");
  - `GSC_CALENDAR` (week start from the locale, month navigation, disabled days outside retention
    and the lag);
  - the chart's x ticks for long ranges (first, middle, last stay; labels use the month when the
    range is over 90 days).

  `specs/gsc-panel.feature.md`: new scenarios below. `specs/gsc.feature.md`: Settings shows
  "N properties" (from the existing `gsc.properties`).
- [ ] **Red.**
  - `renderer/__tests__/gsc-view.test.ts`: `presets-to-ranges`, `custom-range-bounds`,
    `filters-in-request-key`, `clear-filters`, `country-names-from-alpha3`.
  - `gsc-chart.test.ts`: `chart-long-range-ticks` (490 days stays inside the plot).
  - `gsc-calendar.test.ts` (new, jsdom): `calendar-keyboard` (arrows, PageUp/PageDown months,
    Enter picks; `aria-selected`) and `calendar-disables-unavailable-days`.
  - `use-gsc-data.test.ts`: `filters-trigger-one-read`.
  - `settings-gsc-view.test.ts`: `property-count-shown-when-connected`.
- [ ] **Green.**
  - `gsc-view.ts` (prefs store: range, country, device), `hooks/useGscData.ts`, `gsc-chart.ts`;
  - `components/seo/GscPanel.tsx` (`Controls`: preset select, a calendar popover, country and device
    selects, Clear);
  - new `components/seo/GscCalendar.tsx`;
  - `gsc-panel.css`; `settings-gsc.tsx`; `settings-gsc-view.ts`;
  - `gsc-palette.ts` ("Search Console: clear filters").
- **Acceptance:** the existing `gsc-panel.e2e.ts` passes unchanged with the defaults.
- **Risks:** the calendar's accessibility, which needs a focused review of the keyboard model.

### Task 4 — URL Inspection UI in Indexability and Schema (security-lens check: inert text, external open)
Purpose: SL-027 and SL-033 UI.
- [ ] **Spec.** `specs/gsc-inspection.spec.ts`:
  - `GSC_INSPECTION_STATES` (`not-connected`, `no-property`, `idle`, `inspecting`, `ok`, `quota`,
    `network`, `invalid`, `auth-expired`, `not-a-web-page`);
  - `GSC_INSPECTION_COPY`;
  - `GSC_CANONICAL_MATCH` (`same`, `google-differs`, `user-missing`), compared resolved and without
    the fragment.

  `specs/gsc-inspection.feature.md` UI scenarios. `specs/seo-indexability.feature.md` and
  `seo-schema.feature.md` get a line each: the card exists, reads only on a click, and changes no rule.
- [ ] **Red.**
  - `renderer/__tests__/gsc-inspection-view.test.ts`: `states-and-copy`,
    `canonical-three-way-compare` (Google's, the user-declared one from the answer, and frost's audit
    canonical), `last-crawl-relative-and-absolute`, `rich-issues-grouped-by-severity`,
    `strings-are-inert`.
  - `gsc-inspection-card.test.ts` (jsdom, IPC faked):
    - `inspect-only-on-click`: mounting calls nothing;
    - `inspect-again-sends-fresh`;
    - `open-in-search-console-uses-main`: it calls `gsc.openInspectionLink({url})` with the page URL
      and never passes, renders as `href` or opens the link itself.
- [ ] **Green.**
  - New `renderer/gsc-inspection-view.ts`, `hooks/useGscInspection.ts` (one shared request per tab
    URL, so Indexability and Schema show the same answer) and
    `components/seo/GscInspectionCard.tsx`.
  - Mounted in `Indexability.tsx` ("Google's view") and `Schema.tsx` ("Detected by Google").
  - `gsc-palette.ts`: "Inspect this page in Search Console".
- **Acceptance:** no rule or score changes. The card is hidden when Search Console is unconfigured
  and offers Connect in Settings when it is not connected.
- **Risks:** users read "Google's view" as live. The copy states that it is the indexed version (as
  Google's docs say) and gives the time of last crawl.

### Task 5 — Search targets in the Content panel (query→page)
Purpose: SL-020.
- [ ] **Spec.**
  - `specs/gsc.schema.ts`:
    - `GscTargetPagesQuerySchema` (`{url, query ≤ TARGET_QUERY_MAX_CHARS, days|range}`);
    - `GscTargetPagesAnswerSchema` (`{status:'ok', property, range, query, rows:[{page, clicks,
      impressions, ctr, position}] ≤ maxTargetPages, pagesRead, thisPageRank: int|null}`).
  - `specs/gsc.spec.ts`:
    - `GSC_LIMITS.maxTargetPages = 10`;
    - `GSC_TARGET_PAGES_READ_ROWS = 1_000`;
    - `normalizeGscQuery(q)`: trim, collapse whitespace, lowercase (Decision 7).
  - `specs/seo-content.feature.md`, new "Search Console targets" section:
    - suggestions are the page's top queries (at most `GSC_TARGET_SUGGESTIONS = 5`), each with
      "Use as target";
    - the query→page check runs for the saved target query when connected;
    - both are information only.
- [ ] **Red.**
  - `gsc/__tests__/service.test.ts`:
    - `target-pages-body`: dimension `page`, `query equals` the normalised query, no page filter,
      `rowLimit` `GSC_TARGET_PAGES_READ_ROWS`;
    - `target-pages-this-page-rank`: the page matched without its fragment, ranked among all rows
      read (rank 37 of 120 is reported with only the top 10 rows); `null` only when Google
      returned the query but not this page;
    - `target-pages-empty-is-no-data`.
  - `gsc-router.test.ts`: `gsc-target-pages-enforces-sender`.
  - `renderer/__tests__/content-gsc-targets.test.ts` (jsdom):
    - `suggestions-only-when-connected`;
    - `use-as-target-calls-setTargetQuery-with-generation`, keeping the notes-generation rule;
    - `target-pages-list-marks-this-page`;
    - `another-page-leads-is-a-fact-not-a-rule`: no rule and no colour change.
- [ ] **Green.**
  - `gsc/service.ts` (`targetPages`), `gsc-service.ts`, `gsc-router.ts`;
  - new `renderer/content-gsc-view.ts` and `components/seo/ContentGscTargets.tsx`, mounted in
    `Content.tsx` under the target query.
- **Acceptance:** with Search Console unconfigured or disconnected, the Content panel is unchanged.
- **Risks:** Google omits rare queries (anonymised). The empty state says "Google hides rare queries".

### Task 6 — AI bot catalogue, roles and robots.txt verdicts; two more probed agents (security review)
Purpose: SL-030, and the static part of SL-029.
- [ ] **Spec.** New `specs/ai-readiness.spec.ts` (Zod-free):
  - `AI_BOT_ROLES = ['ai-search','live-fetch','training']`;
  - `AI_ROBOTS_STANCES = ['documented','may-ignore','control-token','not-documented']`;
  - `AI_BOTS` (id, token, operator, role, stance, `probeAgent: ProbeAgentId | null`, docs URL):
    **exactly 14 tokens**:

    | Operator | `ai-search` | `live-fetch` | `training` |
    |---|---|---|---|
    | OpenAI | OAI-SearchBot | ChatGPT-User | GPTBot |
    | Anthropic | Claude-SearchBot | Claude-User | ClaudeBot |
    | Perplexity | PerplexityBot | Perplexity-User | — |
    | Apple | Applebot (Decision 10) | — | Applebot-Extended (`control-token`) |
    | Google | — | — | Google-Extended (`control-token`) |
    | Others | — | — | CCBot, Bytespider, Meta-ExternalAgent |

  - `AI_ASSISTANTS` (ChatGPT, Claude, Perplexity, Copilot, Google AI, Apple): each with its tokens
    and `source: 'operator' | 'frost-model'`. Copilot → Bingbot and Google AI → Googlebot +
    Google-Extended are `frost-model`.
  - `AI_RENDERING_NOTE`, `AI_STANCE_NOTES`.

  `specs/visibility-probes.spec.ts`:
  - `PROBE_AGENT_IDS` adds `oai-searchbot` and `chatgpt-user` (kind `ai`), with their operators'
    published user agents;
  - `PROBE_LIMITS.maxFetches` 6 → 8 (`maxRequests` 32);
  - `PROBE_DISCLOSURE`'s counts follow (it already derives them from `MAX_FETCHES` and
    `MAX_REDIRECTS`);
  - refreshed published strings: GPTBot `1.1` → the operator's current `1.4`; check PerplexityBot's
    against `docs.perplexity.ai` (Open questions).

  `specs/ai-readiness.feature.md` and `visibility-probes.feature.md` updated: the Decisions' "6"
  and "24", and `probes-agent-table` (eight agents, 32 requests).
- [ ] **Agent-visible numbers that change by derivation** (no agent tool code change, Decision 18).
  Each is checked and its test updated in this task:
  - `RUN_PROBES_APPROVAL_NOTE` (`specs/agent-session.spec.ts`): reads "up to 32 requests (8 user
    agents …)";
  - the `run_visibility_probes` description (`packages/ai-skills/src/tools.ts`): the same numbers;
  - `PROBE_RUN_MAX_REQUESTS` / `PROBE_RUN_USER_AGENTS` (`specs/agent-search-tools.spec.ts`): 32 / 8;
  - `apps/desktop/src/main/agent/__tests__/probe-tools.test.ts:224-225`: the hard-coded `24` and `6`
    become `32` and `8`;
  - `probes-integration.test.ts` and `ports/probes-adapter.ts` (its `KIND` map is built from
    `PROBE_AGENTS`): check that the two new `ai` rows map with no code change, and add an
    assertion for them;
  - `apps/desktop/README.md` (line ~609, "6 calls and 24 requests"): 8 and 32.

  Task 7 then moves the run-total texts from `maxRequests` to `maxRunRequests`.
- [ ] **Red.**
  - `packages/seo-core/src/__tests__/ai-readiness.test.ts`:
    - `ai-bots-catalogue-has-14-tokens-and-known-roles`: every `role` is in `AI_BOT_ROLES`;
    - `ai-bots-judged-from-audit-robots`: one fixture robots.txt gives each token its verdict, with
      `*` as the fallback, and `Claude-SearchBot` matched as its own token, not as `Claude-User`;
    - `control-tokens-never-requested`;
    - `robots-pending-is-not-checked`;
    - `no-new-rule-in-catalog`: `SEO_RULE_SPECS` is unchanged and so is the health score.
  - `apps/desktop/src/main/serp/__tests__/probes.test.ts`:
    - `probes-are-bounded` asserts 8 calls and 32 requests;
    - the hard-coded `toHaveLength(6)` at lines ~246 and ~425 become `PROBE_AGENT_IDS.length` (8).
  - `probe-compare.test.ts`: `probes-agent-table` (8; line ~51's hard-coded 6) and
    `PROBE_AGENTS.length <= maxFetches`.
  - The agent tests listed above, with their new numbers.
  - `renderer/__tests__/visibility-view.test.ts`: `eight-columns-fit`.
- [ ] **Green.**
  - New `packages/seo-core/src/ai-readiness/{bots,index}.ts`: `audit.aiReadiness.bots`, reusing the
    indexability robots parser and matcher.
  - `seo-core/src/types.ts` and `audit.ts` gain `aiReadiness`.
  - `specs/visibility-probes.schema.ts` caps follow `PROBE_AGENT_IDS`.
  - `main/serp/probes.ts` changes nothing beyond the table.
- **Acceptance (data level; UI in Task 8, e2e in Task 12):**
  - One probe run makes at most 8 agent calls (`llms.txt` comes in Task 7).
  - `audit.aiReadiness.bots` holds 14 verdicts with no request beyond the existing robots.txt fetch.
  - Every derived agent-visible number reads 8 and 32.
- **Risks:**
  - Operators rename tokens. The catalogue is data, refreshed by spec edits.
  - Spoofed user agents trip bot protection; the disclosure says so. Sending ChatGPT-User's user
    agent from the user's machine is listed under Open questions.

### Task 7 — `llms.txt` check and the AI-readiness score (data; security review for the fetch)
Purpose: the data side of SL-029.
- [ ] **Spec.** `specs/ai-readiness.spec.ts`:
  - `AI_READINESS_CHECKS`, `AI_READINESS_WEIGHTS` (Decision 11), `AI_CHECK_STATUSES`,
    `aiReadinessScore(checks)` (pure);
  - `LLMS_TXT_OUTCOMES` (`missing`, `ok`, `malformed`, `not-text`, plus the fetcher's endings);
  - `LLMS_TXT_FINDINGS` (no H1, H1 not first, no links, links not `[name](url)`), written from
    llmstxt.org's proposal in frost's words.

  `specs/visibility-probes.spec.ts` (Decision 13). **It owns the fetch's numbers**, so the
  imports run one way (no cycle):
  - `LLMS_TXT_LIMITS` (`maxBytes: 512_000`, `maxRedirects: 3`, `timeoutMs: 5_000`, `cacheTtlMs`
    as robots.txt) is defined here, beside `PROBE_LIMITS`.
  - `ai-readiness.spec.ts` imports from `visibility-probes.spec.ts`: `import type { ProbeAgentId }`
    for `AI_BOTS.probeAgent`, plus the value `LLMS_TXT_LIMITS` where it needs it.
    `visibility-probes.spec.ts` imports nothing from `ai-readiness.spec.ts`. A test
    (`no-spec-import-cycle`) checks the direction.
  - `PROBE_LIMITS.llmsTxtRequests = 1 + LLMS_TXT_LIMITS.maxRedirects` (4);
  - `PROBE_LIMITS.maxRunRequests = maxRequests + llmsTxtRequests` (36);
  - `maxFetches` / `maxRequests` unchanged (8 / 32, per agent);
  - `PROBE_DISCLOSURE` adds the one `/llms.txt` request and its redirects.

  `specs/ai-readiness.schema.ts`: `LlmsTxtJobSchema`, `LlmsTxtAnswerSchema`.
  `specs/visibility-probes.schema.ts`: `ProbeReportSchema.llmsTxt: LlmsTxtStateSchema | null`.
  `robotsTxt.max(maxFetches)` is unchanged.

  **Run totals for the agent:** `RUN_PROBES_APPROVAL_NOTE`, the `run_visibility_probes` description
  and `PROBE_RUN_MAX_REQUESTS` switch from `maxRequests` to `maxRunRequests` (36), naming
  `/llms.txt`. `probes-adapter.ts` ignores `llmsTxt`: the tool's output is unchanged.
- [ ] **Red.**
  - `seo-core` `ai-readiness.test.ts`:
    - `score-weights-and-partial` ("k of n");
    - `score-null-until-static-checks`;
    - `training-and-llms-unscored`;
    - `served-content-from-js-verdict`;
    - `agent-reachability-from-probes` (non-2xx = fail, text diff = warn, `noindex` = fail);
    - `score-imports-no-capture-module`: `score.ts` depends only on `audit` and `ProbesState`
      types.
  - `main/serp/__tests__/probes.test.ts`:
    - `probes-are-bounded`: 8 agent calls and at most `maxRunRequests` (36) requests in all,
      `llms.txt` included. `llms.txt` goes through the same SERP-lane fetcher mock, so the existing
      assertion at ~line 109 (`fetch toHaveBeenCalledTimes(PROBE_LIMITS.maxFetches)`) becomes
      `maxFetches + 1` on a run whose origin's `llms.txt` is not cached. The per-agent user-agent
      assertion beside it filters out the `llms.txt` call (frost's own user agent, its own URL), and
      the per-request loop at `:112-113` (`for (const { request } of h.calls)`, `url: PAGE`,
      `maxRedirects: 3`, the probe caps and headers) runs over the eight agent calls only; the
      `llms.txt` request is asserted separately (its own URL, frost's user agent,
      `LLMS_TXT_LIMITS`);
    - `llms-txt-only-on-run`: page loads fetch nothing;
    - `llms-txt-once-per-origin-cached`;
    - `llms-txt-private-redirect-refused`;
    - `llms-txt-parsed-in-worker`: the job validates; a deadline applies;
    - `llms-txt-cleared-by-clear-browsing-data`;
    - `stop-and-cancel-abort-llms-txt`.
  - `probe-compare.test.ts`: `limits-arithmetic` (`maxRequests = maxFetches × (1 + maxRedirects)`,
    `maxRunRequests = maxRequests + llmsTxtRequests`).
  - `probe-tools.test.ts`: `PROBE_RUN_MAX_REQUESTS` is 36. The approval-note and tool-description
    tests name `/llms.txt`.
- [ ] **Green.**
  - New `packages/seo-core/src/ai-readiness/{score,llms}.ts` (the parser is pure and runs in the
    worker).
  - `main/serp/probes.ts` (one `llms.txt` fetch per run and origin, aborted with the run);
  - `main/serp/probe-parser.ts` / `serp-worker.ts` (the `llms-txt` job);
  - the derived-number specs above;
  - `apps/desktop/README.md`: the probe bullet Task 6 set to "8 calls and 32 requests" adds "and one
    request for `/llms.txt` (up to 3 redirects), at most 36 in all". The README lists every outbound
    call.
- **Acceptance:**
  - The score never reads Phase 12 data.
  - The SEO health score is unchanged on every fixture.
  - Every count in the disclosure, the approval note and the tool description matches
    `PROBE_LIMITS`.
- **Risks:** a score invites optimising for it. Task 8's copy explains each check and that the
  weights are frost's.

### Task 8 — On-device page type, and the AI-readiness and Overview UI
Purpose: SL-016 (page type, intent) and the SL-029/030 surfaces. Two parts, one reviewer: the
seo-core heuristic is small, and both parts land in the Overview.
- [ ] **Spec.**
  - New `specs/page-type.spec.ts`:
    - `PAGE_TYPES`, `PAGE_TYPE_LABELS`, `PAGE_TYPE_SIGNALS` (`schema-type`, `og-type`, `url-path`,
      `structure`);
    - `PAGE_TYPE_SCHEMA_MAP` (Article / BlogPosting / NewsArticle → `article`; Product → `product`;
      CollectionPage / ItemList → `listing`; TechArticle → `documentation`; ContactPage →
      `contact` …);
    - `PAGE_TYPE_PATH_HINTS` (`/` → `home`; `/blog/`, `/news/` → `article`; `/docs/` →
      `documentation` …);
    - `PAGE_TYPE_STRUCTURE`: thresholds over existing `PageSnapshot` fields only. Example: `listing`
      when headings of one level ≥ 6, internal links ≥ 30 and words per heading are low. No
      extractor or snapshot-schema change (Decision 14).
    - `PAGE_TYPE_CONFIDENCE` (`high` when two signals agree, `low` for one, `unsure` for none or a
      conflict).
  - New `specs/page-type.feature.md`.
  - `AI_READINESS_COPY` in `specs/ai-readiness.spec.ts`: check labels and explanations, "based on k
    of n checks", the `frost-model` label, the `may-ignore` and `control-token` notes, and training
    opt-outs shown as neutral. `specs/ai-readiness.feature.md` UI scenarios.
  - `specs/seo-sidebar.feature.md`: the Overview's "Page" card (type, intent of the target query)
    and the AI-readiness tile.
- [ ] **Red.**
  - `packages/seo-core/src/__tests__/page-type.test.ts`:
    - `schema-wins`, `path-hint-only-is-low`, `conflict-is-unsure`, `home-by-root-path`;
    - `listing-by-repeated-headings-and-links` (from snapshot counts only);
    - `pure-no-network` (`purity.test.ts` extended).
  - `renderer/__tests__/overview-page-type.test.ts`:
    - `shows-type-and-signals`;
    - `intent-only-with-target-and-enabled-intent`: calls `serp.classify` with the stored target
      query only when `intentState` is `ready`;
    - `no-intent-otherwise`.
  - `renderer/__tests__/ai-readiness-view.test.ts`:
    - `assistants-rows-and-roles`;
    - `frost-model-labelled`;
    - `may-ignore-note-on-live-fetch`;
    - `training-opt-out-neutral`;
    - `score-ring-states` (pending, partial, full);
    - `llms-txt-findings-inert`;
    - `overview-tile-links-to-visibility`.
- [ ] **Green.**
  - New `packages/seo-core/src/page-type/index.ts` (`audit.pageType`); `types.ts` and `audit.ts`.
  - `Overview.tsx`: a "Page" card (type, confidence, signals; intent of the target query) and the
    AI-readiness tile.
  - New `renderer/ai-readiness-view.ts` and `components/seo/AiReadiness.tsx`, mounted at the top of
    `Visibility.tsx`.
  - New `renderer/ai-readiness-palette.ts` ("Open AI readiness"; "Run visibility probes" already
    exists).
- **Acceptance:**
  - Page type: no network, no rule, and it is in the snapshot-derived audit only.
  - Before probes run, the static score shows "based on 3 of 4 checks". After a run it shows 4 of 4.
- **Risks:**
  - Heuristics mislabel landing pages. `unsure` is shown honestly.
  - Eight probe columns plus an assistants table in a 360 px panel. The table scrolls horizontally,
    and the assistants view is a list.

### Task 9 — Agent protocol, runtime and host budget for checks (security review)
Purpose: the transport for SL-019 and SL-108. Nothing user-visible yet.
- [ ] **Spec.**
  - `specs/agent-protocol.schema.ts`:
    - `check.start` (`checkId, systemPrompt, input, modelId, route`; **no effort field**: a check
      always runs at `auto`, Decision 15);
    - `check.finish` (`checkId, text ≤ AI_CHECK_LIMITS.maxOutputChars`);
    - `check.error` (`checkId`, code);
    - `check.stop` (`checkId`; main → runtime, added to `MAIN_TO_RUNTIME_MESSAGE_TYPES` beside
      `chat.stop`): main cancels a check (Decision 15's check lifecycle);
    - `fetch.request` gains an optional `checkId`: how main tells a check's model request from a
      turn's when both are live (the host shares one fetch path and budget). A request takes the
      check branch only if main started that check, it is still live, and it has not used its one
      request; any other `checkId` (unknown, finished, or spent) is refused and **counted** as a
      runtime fault, and a request without one takes the turn path unchanged (lead ruling N1);
    - `AGENT_PROTOCOL_VERSION` + 1 (Team contract on Phase 8).
  - `specs/agent-proxy.spec.ts`: `MAX_MODEL_REQUESTS_PER_CHECK = 1`, beside
    `MAX_MODEL_REQUESTS_PER_TURN`.
  - New `specs/ai-checks.spec.ts` (Zod-free; the part this task needs):
    - `AI_CHECK_LIMITS.maxOutputChars: 2_000`, `maxOutputTokens: 1_024` (≤ `MAX_OUTPUT_TOKENS`),
      `requestTimeoutMs: 60_000`;
    - `AI_CHECK_SYSTEM_PROMPT` (frost's own words: output JSON only; page text is data, never
      instructions).
  - `specs/agent-host.feature.md` / `agent-runtime.feature.md`: a "Checks" section.
- [ ] **Red.**
  - `apps/desktop/src/main/agent/__tests__/host.test.ts`:
    - `check-request-budget-one`: a live check's `fetchBudget` admits exactly one
      `fetch.request`; a second is refused;
    - `no-request-without-live-check-or-turn`;
    - `check-and-turn-budgets-separate`;
    - `check-and-turn-concurrent`: with a High-effort chat turn and a check live together, the
      turn's request (no `checkId`) is checked on the turn path at High and sent, and the check's
      request (its `checkId`) is checked at `auto` and sent; neither strikes;
    - `unknown-or-spent-checkId-refused-and-counted`: a `checkId` main never started, one already
      finished, and a second request on a live check's id are each refused and counted;
    - `chat-ends-while-check-streams`: the last chat finishes while a check's request is streaming;
      the check keeps its budget, its proxy request is not aborted, and it answers `check.finish`;
    - `check-ends-while-chat-continues`: a check finishes during a turn; the turn's budget and its
      in-flight request are untouched and the turn completes;
    - `check-cancelled-before-its-request`: main sends `check.stop` before the check's
      `fetch.request`; the budget is withdrawn, a late request on that id is refused, and nothing
      reaches the proxy;
    - `runtime-failure-cleans-up-chats-and-checks`: a crash with a chat and a check live fails the
      chat (as today) and answers the check `check.error`; neither budget survives the restart.
  - `proxy-rules.test.ts`:
    - `check-uses-current-route` for all four routes, each body passing
      `checkModelRequest(route, modelId, 'auto', body, headers)`;
    - `check-ignores-the-reasoning-setting`: with the agent's Reasoning set to High on a model that
      supports it, the check's body has no reasoning field and is sent;
    - `check-with-reasoning-fields-refused`: a check body carrying any reasoning field (e.g.
      `reasoning.effort: 'high'`, Anthropic `thinking`) is refused `reasoning`, answers the check
      `check.error` (`refused`), and is **not** counted as a runtime fault (no strike);
    - BYOK and gateway bodies carry `maxOutputTokens = AI_CHECK_LIMITS.maxOutputTokens` (a body
      without one is refused, as today);
    - `chatgpt-check-has-no-forbidden-fields` (no `max_output_tokens`, no `temperature`).
  - `apps/agent-runtime/src/__tests__/check.test.ts` (`MockLanguageModelV4`):
    - `check-is-toolless-single-request`;
    - `check-sets-maxRetries-0`: a failed request is not retried and answers `check.error`;
    - `check-stop-aborts`.
  - Agent protocol tests: `unknown-check-message-dropped`, `runtime-cannot-start-a-check`.
- [ ] **Green.**
  - New `apps/agent-runtime/src/check.ts` (`generateText`, no tools, `maxRetries: 0`, per-route
    output options as in Decision 15), wired in `runtime.ts` / `transport.ts`;
  - `main/agent/host.ts`: `startCheck` / `onCheck` / `stopCheck` (posts `check.stop`), and
    `MAX_MODEL_REQUESTS_PER_CHECK` held per live check, apart from the turn budget: `endChat`
    (`:237`) clears only the turns' budget, and the runtime-failure path (`failPendingChats` and its
    caller) also fails every live check;
  - `apps/agent-runtime/src/check.ts` tags its one `fetch.request` with its `checkId`;
    `main/agent/host.ts` resolves the tag against the checks main started (live, unspent) before
    the proxy sees the request;
  - `main/agent/model-proxy.ts`: a request from a live check takes its own branch: it is checked
    with `checkModelRequest(route, modelId, 'auto', body, headers)` against the route and model the
    check began on (not the current settings' effort, and not Phase 8's mid-turn `previous` steps);
    a refusal answers the check `check.error` (`refused`) and is never counted as a runtime fault;
    its `onChat` handler (`:491`) aborts only turn requests when the last chat ends, and a check's
    request is aborted only by that check's stop, end or a runtime failure;
  - `apps/agent-runtime/src/check.ts` sends no reasoning provider option, and handles `check.stop`
    (aborts the check's request, as `chat.stop` does a turn's).
- **Acceptance:**
  - No key or token is in any check message.
  - Every check request passes `checkModelRequest(…, 'auto', …)`; the Reasoning setting never
    changes a check's body; a refused check request never strikes the runtime.
  - With no live check or turn, the host admits no request.
  - A check and a turn running together each take their own path; a `checkId` that is unknown,
    finished or spent is refused and counted (it can never be used to escape the strike count).
  - A chat ending never ends a check, and a check ending never ends a chat; `check.stop` cancels a
    check; a runtime failure cleans up both.
- **Risks:** protocol version collision with Phase 8 (Team contract).

### Task 10 — AI checks service: modes, anonymous input, storage, IPC, consent (security review)
Purpose: SL-019 and SL-108, main side.
- [ ] **Spec.** `specs/ai-checks.spec.ts`:
  - `AI_CHECKS_SETTING_KEY`;
  - `AI_CHECK_MODES = ['off','on-request','automatic']` (default `off`);
  - `AI_CHECK_KINDS = ['page-type','intent','quality','target-query']`;
  - `AI_CHECK_LIMITS` adds `maxInputChars: 8_000`, `maxLeadChars: SERVED_LEAD_TEXT_MAX_CHARS`, `maxAutomaticPerHour: 20`
    and `maxStoredUrls: 500`;
  - `AI_QUALITY_RATINGS = ['strong','adequate','weak']`;
  - `AI_CHECKS_ENABLE_PROMPT`, worded as in Decision 16: the signed-out extract, never what you see
    signed in; to the agent's model provider on your key or plan; one request per check; the
    hourly cap; results stay local; Clear Browsing Data; how to turn it off;
  - `AI_CHECK_UNAVAILABLE`: `off`, `no-model`, `not-public`, `not-anonymous`, `served-pending`,
    `busy-chat`, `rate`, `refused`, `invalid-output`, `network`.

  `specs/ai-checks.schema.ts`:
  - `AiCheckInputSchema`: built only from a `ServedState` `ready` (its `ServedSnapshot`, including
    `leadText`, and its `ServedFetch`) plus the tab URL. No rendered field, and no `audit.pageType`
    (Decision 16);
  - `AiCheckOutputSchema` (strict, capped; `suggestedTarget` ≤ `TARGET_QUERY_MAX_CHARS`);
  - `AiCheckResultSchema`, `AiChecksStateSchema`;
  - IPC inputs `aiChecks.state`, `watch`, `setMode`, `checkNow`.

  `specs/seo-javascript.spec.ts` / `.schema.ts`:
  - `SERVED_LEAD_TEXT_MAX_CHARS = 4_000` (`AI_CHECK_LIMITS.maxLeadChars` re-exports it).
  - `ServedSnapshotSchema.leadText`: **optional**
    (`z.string().max(SERVED_LEAD_TEXT_MAX_CHARS).optional()`). It is the first characters of the
    served body text, from the same walk and budgets as `wordCount`, whitespace collapsed.
    - Being optional, every existing served fixture stays valid without it, and a snapshot without
      it reads as "no lead text" (the check then sends only the other fields).
    - It is **main-only**. The served snapshot already never reaches the renderer
      (`javascript/report.ts`: "the served snapshot's Zod schema stays in main"), and the
      `JavascriptReport` the renderer gets copies no snapshot text.
    - Its consumers:
      - producer: `main/seo/served-parse.ts`, in the analysis worker;
      - holder: `main/seo/served.ts` (the per-tab cache) and `main/seo/analyse.ts` (passes the
        served state to the worker);
      - reader: `main/ai-checks/input.ts` only;
      - ignored: `packages/seo-core/src/javascript/report.ts`;
      - not produced for Phase 12's crawl job, which parses with the option
        `ServedParseInput.skipExtraText: true` (Phase 12 Task 6b), so crawl results carry no
        `leadText`.
    - The extra up to 4,000 characters cross only the main ↔ analysis-worker boundary.

  New `specs/ai-checks.feature.md`.
- [ ] **Red.**
  - `apps/desktop/src/main/ai-checks/__tests__/service.test.ts`:
    - `off-by-default-sends-nothing`;
    - `leaving-off-needs-the-consent-dialog` (main shows it; the renderer can't flip it alone);
    - `on-request-never-automatic`;
    - `input-only-from-served-fetch`: a fixture whose rendered DOM holds "signed-in" text that the
      served HTML lacks; the input never contains it;
    - `logged-in-looking-page-not-sent`: served 401/403, a redirect to another path (a sign-in
      page), `partial`, or served `noindex` → `not-anonymous`, with no `check.start` posted;
    - `served-pending-waits`;
    - `check-never-fetches`: in every mode, including `automatic` and "Check this page", the service
      calls only `served.peek` with the audit's key (user agent and scripting of the tab), never
      `served.get`, and the fake fetcher records no request; a page whose served state is not
      cached is `served-pending`;
    - `only-public-hosts`;
    - `waits-for-chat-turn`;
    - `one-at-a-time-and-hourly-cap` (manual "Check this page" is exempt from the cap, but not from
      the mode or the guards);
    - `cache-by-url-and-input-hash`;
    - `invalid-output-is-unavailable`;
    - `output-capped-and-inert`;
    - `cleared-by-clear-browsing-data`.
  - `apps/desktop/src/main/seo/__tests__/served-parse.test.ts`: `lead-text-capped-and-hidden-text-skipped`.
  - `apps/desktop/src/main/seo/__tests__/served.test.ts`: `served-snapshot-without-lead-text-still-valid`
    (existing fixtures parse unchanged).
  - `packages/seo-core/src/__tests__/javascript.test.ts`: `lead-text-not-in-javascript-report`.
  - `ai-checks/__tests__/input.test.ts`: `input-type-has-no-rendered-or-page-type-field` (type-level:
    `AiCheckInput` is built from `ServedState` and the URL only).
  - `packages/db/src/__tests__/ai-checks.test.ts`: `migration-0210`, `cap-max-stored-urls`,
    `tampered-row-reads-as-none`; `migrations.test.ts` `migrations-are-forward-only` still passes
    with `0210` after `0200` (a check: the `9000_` fixture ids are Phase 8's).
  - `packages/ipc-contract/src/__tests__/ai-checks-router.test.ts`: `enforces-sender`,
    `outputs-strict`.
- [ ] **Green.**
  - New `apps/desktop/src/main/ai-checks/{service,input,main}.ts`. `input.ts` reads the served state
    **only** with `served.peek(contents.id, url, userAgent, how)` using the audit's own key (the same
    `tabUserAgent(contents)` and `{ scripting: tabScripting(contents) }` that `servedInput` in
    `main/index.ts` passes to `served.get` / `served.peek`), never `served.get`: an AI check never
    causes a fetch. A miss (`undefined`: not settled yet) is `served-pending`, retried when the
    audit's served state settles; a settled state goes through Decision 16's guard;
  - `main/seo/served-parse.ts` (`leadText`);
  - new `packages/db/src/ai-checks{,-schema,-migrations}.ts` (`0210_seo_ai_checks`: `url`,
    `input_hash`, `result_json`, `model_id`, `checked_at`), its `...AI_CHECKS_MIGRATIONS` spread in
    `migrations.ts` after Phase 8's `0200` block (in id order; Global constraints);
  - `packages/db/src/settings.ts` (`aiChecksMode`, `setAiChecksMode`);
  - new `packages/ipc-contract/src/ai-checks-{router,service}.ts`;
  - hub one-liners; `clear-browsing-data.ts` (one part).
- **Acceptance:**
  - With the mode `off`, no `check.start` is ever posted (test).
  - No input field comes from the rendered snapshot (a type-level test: `AiCheckInput` built from
    `ServedSnapshot` only).
- **Risks:**
  - Prompt injection skews the judgment. It is display-only and labelled.
  - Cost surprises: the hourly cap, and the consent screen and Settings say what a check sends.
  - A site that serves the same content to everyone, signed in or not, is sent as served. That is
    the page's public form, and the consent copy says so.

### Task 11 — AI checks UI (security-lens check: model output rendered inert)
Purpose: SL-016, SL-019 and SL-108 surfaces.
- [ ] **Spec.** `specs/ai-checks.feature.md` UI scenarios. `AI_CHECKS_COPY` in `ai-checks.spec.ts`:
  - the Settings section (three modes) and the Overview "AI judgment" card;
  - Content's "Quality" row, "Check this page" and "Check again";
  - the `not-anonymous` explanation;
  - the cost note naming the active route and model.
- [ ] **Red.** `renderer/__tests__/ai-checks-view.test.ts`:
  - `settings-mode-change-opens-consent`;
  - `card-states` (off: a one-line invite to Settings; no model: "Set up the agent's model";
    checking; result; each unavailable reason);
  - `labelled-ai-judgment`;
  - `model-text-inert` (no markup, links or `href` from model output);
  - `suggested-target-use-as-target`: on a click only, through `content.setTargetQuery` with the
    notes generation, capped to `TARGET_QUERY_MAX_CHARS`;
  - `heuristic-and-ai-page-type-both-shown-when-they-differ`.
- [ ] **Green.**
  - New `renderer/ai-checks-view.ts`, `hooks/useAiChecks.ts`, `components/seo/AiChecksCard.tsx`
    (Overview) and a "Quality" row in `Content.tsx`;
  - new `settings-ai-checks.tsx`, mounted in `settings-view.tsx` near the agent's model settings;
  - palette: "Check this page with AI" and "AI checks: change mode…".
- **Acceptance:** nothing AI-generated is shown without the label; switching to `off` stops queued
  checks.
- **Risks:** UI noise on every page. The card stays collapsed to one line when the mode is `off`.

### Task 12 — End to end
Purpose: the phase's UI in the real app, with fakes only.
- [ ] **Fakes.**
  - `e2e/fake-google.ts`:
    - `endpoints.inspectionBase` and its `env` entry (`FROST_GSC_INSPECTION_BASE`, from
      `GSC_ENDPOINT_ENV`);
    - a `/v1/urlInspection/index:inspect` handler with fixture results and modes (`ok`, `quota`,
      `garbage`);
    - `country` / `device` filter echo;
    - `dimensions:['country']` and `['page']` answers.

    `e2e/harness.ts` is unchanged: it already strips `FROST_GSC_*`, and the test passes
    `google.env`.
  - The loopback fixture site served inside `visibility.e2e.ts` (`createServer`, `/robots.txt`;
    behind `E2E_PUBLIC_HOSTS_SWITCH`) gains:
    - a robots.txt that disallows `OAI-SearchBot` on a path and `GPTBot` everywhere;
    - an `/llms.txt`;
    - a page that serves different HTML with and without a cookie (for the anonymous-input check).
  - **AI checks use the real proxy, not the scripted model.** The agent script seam
    (`--frost-e2e-agent-script`) runs a scripted model in the runtime and makes no model request,
    so it cannot show what the proxy sends. The AI-checks e2e uses the ChatGPT route's fake instead:
    `e2e/fake-chatgpt.ts` behind its unpackaged-only seam (`agent-chatgpt-e2e.schema.ts`).
    - The fake answers a check's Responses request with fixture JSON.
    - It records every request body, which is the observable: a count and the bodies.
- [ ] **Tests.**
  - `e2e/gsc-panel.e2e.ts`: `gsc-panel-custom-range`, `gsc-panel-16m-preset`,
    `gsc-panel-country-device-filters`, `gsc-panel-clear-filters`.
  - New `e2e/gsc-inspection.e2e.ts`: `inspection-only-on-click`,
    `inspection-index-and-canonical-card`, `inspection-rich-results-in-schema`,
    `inspection-quota-message`.
  - `e2e/seo-content.e2e.ts`: `content-gsc-suggestion-sets-target`,
    `content-target-pages-marks-this-page`.
  - `e2e/visibility.e2e.ts`:
    - `ai-readiness-static-score-before-probes`;
    - `ai-readiness-bot-verdicts` (OAI-SearchBot disallowed on the path; training opt-out shown
      neutral);
    - `probes-eight-agents-and-llms-txt` (the fixture server counts at most 36 requests);
    - `score-includes-reachability-after-run`.
  - New `e2e/ai-checks.e2e.ts` (ChatGPT route on the fake):
    - `ai-checks-off-sends-nothing`: the fake records zero requests while browsing;
    - `enable-via-consent-then-check-runs`: exactly one request per check, whose body holds the
      served (signed-out) title and none of the cookie-only text;
    - `check-again`;
    - `clear-browsing-data-removes-results`.
- **Acceptance:** the e2e suite passes with no network beyond loopback; packaged builds refuse every
  seam.

## Open questions
| Question | How to resolve |
|---|---|
| Does `urlInspection.index:inspect` answer domain properties (`sc-domain:`) the same way as URL-prefix ones, and are `languageCode` translations worth sending? | Try both property kinds with a real account before release; the docs say both forms are accepted. Keep en-US for now. |
| Is the 2,000 a day per-site inspection quota per property or per verified site, and is a domain property and its URL-prefix child one "site"? | Test against a real account, or ask in the Search Central help community. The UI copy names only "Google's daily limit". |
| Does Search Console still keep 16 months of performance data (`GSC_RETENTION_MONTHS`)? | Check Google's "data limits" page linked from the Search Analytics reference. A shorter limit only narrows the calendar. |
| PerplexityBot's current user agent (`docs.perplexity.ai` shows `Mozilla/5.0 (compatible; PerplexityBot/1.0; …)`, `PROBE_AGENTS` holds another form) and GPTBot's version (1.4 documented, 1.1 in the spec) | Refresh from the operators' pages in Task 6; record the fetch date in the spec comment. |
| Copilot grounds on Bing and Google AI Overviews/AI Mode on Googlebot (frost's model in `AI_ASSISTANTS`) | Look for Microsoft and Google documentation stating it. Until then the rows are labelled "frost's model". |
| Claude-SearchBot / Claude-User user-agent strings (only tokens are published) | If Anthropic publishes them, add probe agents in a later change (it raises `maxFetches`). |
| Bytespider and Meta-ExternalAgent robots.txt stance | Read the operators' current pages. Until then: `not-documented`. |
| Does the `chatgpt` route accept a tool-less single request with a plain JSON instruction (no `text.format`), and does each check count against the user's ChatGPT plan limits like a chat message? | Verify with a real Plus account (as the ChatGPT plan's own open questions). Fallback: the check reports `refused` on that route. Until verified, the consent copy says checks use the plan's limits. |
| Is it acceptable, under the operators' terms, to send ChatGPT-User's (and, if added later, Perplexity-User's) user agent from the user's own machine? These name user-initiated fetches by the operator's service. | Read OpenAI's bot page and terms before release. The probe disclosure already says only the user-agent string changes and nothing proves the request is the real bot. If the terms object, drop `chatgpt-user` from `PROBE_AGENT_IDS` (`maxFetches` back to 7) and keep its robots.txt verdict only. |
| Does `llms.txt` matter to any engine? | No major engine documents using it (llmstxt.org calls it a proposal). It stays unscored; revisit if one documents it. |
| Phase 8 and Phase 9 both bump `AGENT_PROTOCOL_VERSION` | Lead sequences the merges; the second rebases (Team contract). |
