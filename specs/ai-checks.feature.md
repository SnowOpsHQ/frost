# Feature: AI checks

Spec: `specs/ai-checks.spec.ts` (`AI_CHECK_MODES`, `AI_CHECKS_SETTING_KEY`, `AI_CHECK_KINDS`,
`AI_CHECK_LIMITS`, `AI_QUALITY_RATINGS`, `AI_CHECKS_ENABLE_PROMPT`, `AI_CHECK_UNAVAILABLE`,
`AI_CHECK_WAITING_REASONS`, `aiCheckFailureReason`, `AI_CHECK_TASK`, `AI_CHECK_EXTRACT_TAGS`,
`AI_CHECKS_TABLES`), `specs/ai-checks.schema.ts` (`AiCheckInputSchema`, `AiCheckOutputSchema`,
`AiCheckResultSchema`, `AiChecksStateSchema`, the `aiChecks.*` inputs), `specs/seo-javascript.spec.ts`
(`SERVED_LEAD_TEXT_MAX_CHARS`) and `specs/seo-javascript.schema.ts` (`ServedSnapshotSchema.leadText`).
Phase 9 Tasks 9–11 (Decisions 15–17); the transport is `agent-host.feature.md` and
`agent-runtime.feature.md`, Checks. This file is Task 10's main side; Task 11 adds the UI scenarios.
Each line maps to one named test.

## Decisions
- **Opt-in, off by default.** The mode is `off`, `on-request` or `automatic`, stored under
  `AI_CHECKS_SETTING_KEY` in `app_settings`. Leaving `off` needs main's consent dialog
  (`AI_CHECKS_ENABLE_PROMPT`); the renderer asks, main decides. Turning off stops a running check.
- **Only the cookieless served fetch.** A check's input is the served HTML the JavaScript panel's
  audit already fetched (no cookies or credentials), read with `served.peek` under the audit's own key
  (the tab's user agent and scripting). An AI check never fetches: a page whose served state is not
  cached is `served-pending` and is tried again once the audit's fetch settles. The rendered page and
  the on-device page type are never part of the input.
- **A guard on top.** A page is skipped (`not-anonymous`, nothing sent) unless the served state is
  `ready`, the fetch answered 2xx, its final URL is the tab's (fragment aside), the served snapshot is
  not partial (nor the body cut short) and the served HTML is not `noindex`. Only public hosts
  (`isGscReadablePage`) are checked (`not-public`).
- **Main's own route and model.** A check runs on the route and model main's agent settings name,
  only when that route's credential is set up (`no-model` otherwise). Each check gets a fresh id.
- **Bounded.** One check at a time; automatic checks wait while a chat turn runs (`busy-chat`), at
  most `maxAutomaticPerHour` start in any hour (`rate`), and after a failed automatic check the next
  wait `automaticBackoffMs` (`rate`). "Check this page" is exempt from the hourly cap and the backoff,
  never from the mode or the guard.
- **Cached per URL and input hash.** A stored answer for the same URL and the same input is shown
  without a request; "Check again" asks again. At most `maxStoredUrls` URLs are kept (migration
  `0210_seo_ai_checks`); Clear Browsing Data removes them and stops a running check.
- **Untrusted output.** The answer is plain text JSON parsed in main: control and bidi characters are
  removed, texts collapsed and capped, then checked strictly (`AiCheckOutputSchema`); anything else is
  `invalid-output`. It is shown only, never acted on.

## Service (`apps/desktop/src/main/ai-checks/__tests__/service.test.ts`)
- `off-by-default-sends-nothing` — a fresh service is `off`: browsing, ready audits and "Check this
  page" post no `check.start`, and the state says `off`.
- `leaving-off-needs-the-consent-dialog` — `setMode('automatic')` or `('on-request')` from `off` shows
  main's dialog; cancelled, the mode stays `off` and nothing is stored; confirmed, the mode is stored.
  Moving between the two on modes and back to `off` asks nothing.
- `on-request-never-automatic` — in `on-request`, ready audits post nothing; "Check this page" posts one.
- `input-only-from-served-fetch` — with a rendered page holding signed-in text that the served HTML
  lacks, the input holds the served title and lead text and none of the rendered text.
- `logged-in-looking-page-not-sent` — a served 401 or 403, a redirect to another path, a `partial`
  snapshot or a served `noindex` is `not-anonymous`, and no `check.start` is posted.
- `served-pending-waits` — with no settled served state the page is `served-pending`; once it
  settles and the service is told, the check runs.
- `check-never-fetches` — in every mode, automatic and "Check this page", the service reads the
  served state only through `peek` with the audit's key (the tab's user agent and scripting), never
  `get`, and the fetcher records no request.
- `only-public-hosts` — a private, loopback or local page is `not-public` and nothing is read or sent.
- `waits-for-chat-turn` — while a chat turn runs a check is `busy-chat` and nothing is posted; when the
  last chat ends it runs.
- `one-at-a-time-and-hourly-cap` — a second page waits until the first check ends; after
  `maxAutomaticPerHour` automatic checks in an hour the next is `rate`, until the window moves on;
  "Check this page" still runs past the cap, but not when the mode is `off` or the guard skips.
- `cache-by-url-and-input-hash` — the same URL and input read the stored answer with no request; a
  changed input asks again; "Check again" asks again.
- `invalid-output-is-unavailable` — non-JSON, an extra key, a wrong type, a value outside its list
  are `invalid-output` and nothing is stored.
- `output-capped-and-inert` — control and bidi characters are removed and texts capped, so a long or
  marked-up answer is stored and shown as capped plain text.
- `check-errors-map-and-back-off` — a `check.error` code is mapped (`aiCheckFailureReason`), never
  read as more than "this check failed"; after a failed automatic check the next automatic one is
  `rate` for `automaticBackoffMs` while "Check this page" still runs; with no model set up it is
  `no-model` and nothing is sent.
- `cleared-by-clear-browsing-data` — clearing removes the stored answers and the ones in memory, and
  stops a running check (its late answer is ignored). Wiring: `clear-browsing-data.test.ts`
  `clear-forgets-ai-checks` (the part runs after the SEO caches), and the dialog names the results.

## Input (`apps/desktop/src/main/ai-checks/__tests__/input.test.ts`)
- `input-type-has-no-rendered-or-page-type-field` — `buildAiCheckInput` takes a ready `ServedState`
  and the URL only, and `AiCheckInput` has no rendered or page-type field (type-level).
- `input-fits-max-input-chars` — the wrapped extract fits `maxInputChars` (extra headings, then the
  lead text, give way first) and every `<` of the page is escaped inside the wrapper.

## Served lead text (`apps/desktop/src/main/seo/__tests__/served-parse.test.ts`, `served.test.ts`,
`packages/seo-core/src/__tests__/javascript.test.ts`)
- `lead-text-capped-and-hidden-text-skipped` — `leadText` is the body's text, whitespace collapsed,
  at most `SERVED_LEAD_TEXT_MAX_CHARS`, without `script`, `style`, `[hidden]` and the other skipped
  subtrees.
- `served-snapshot-without-lead-text-still-valid` — a served snapshot without `leadText` still
  satisfies `ServedSnapshotSchema`.
- `lead-text-not-in-javascript-report` — the JavaScript report of a page with a lead text holds none of it.

## Storage (`packages/db/src/__tests__/ai-checks.test.ts`)
- `migration-0210` — `0210_seo_ai_checks` comes after Phase 8's `0200` and creates exactly
  `seo_ai_checks` (`url`, `input_hash`, `result_json`, `model_id`, `checked_at`).
- `cap-max-stored-urls` — one row per URL; past `maxStoredUrls` the oldest go.
- `tampered-row-reads-as-none` — a row whose JSON, hash, model or time is not well-formed reads as no answer.
- `ai-checks-mode-setting` — the mode is `off` until one is stored; an unknown or tampered value reads as `off`.

## Router (`packages/ipc-contract/src/__tests__/ai-checks-router.test.ts`)
- `enforces-sender` — every `aiChecks.*` procedure refuses a foreign sender before its input or service.
- `outputs-strict` — inputs are strict, and an answer with anything more (a key) is a masked error.
