# Feature: The agent's core page tools (main)

Spec: `specs/agent-page-tools.spec.ts` (`AGENT_PAGE_WORLD_ID`, `AGENT_JS_WORLD_ID`,
`NON_AGENT_WORLD_IDS`, `PAGE_SCRIPT_TIMEOUT_MS`, `NAVIGATE_SETTLE_TIMEOUT_MS`, `CLICK_LIMITS`,
`CLICKABLE_SELECTOR`, `PAGE_TEXT_DEFAULT_CHARS`, `EXECUTE_JS_LIMITS`, `EXECUTE_JS_MARK_KEY`,
`PAGE_AUDIT_LIMITS`, `PAGE_TITLE_MAX_CHARS`, `pageKeyOf`, `pageSource`), `specs/agent-tools.spec.ts`
(`EXECUTE_JS_TIMEOUT_MS`, `EXECUTE_JS_MAX_RESULT_BYTES`, `TOOL_RESULT_MAX_CHARS`,
`AGENT_TOOL_INPUT_LIMITS`), `specs/agent-approvals.spec.ts` (`runTargetFor`, `pageUrlOf`,
`TOOL_RUN_VIAS`). Phase 5 Task 5 (`docs/plans/phase-5-ai-agent.md`, with the requirements Task 4's
review added; threat model row "`execute_javascript` takes over the page or hangs").
Code: `apps/desktop/src/main/agent/tools/` (`runner.ts`, `page-scripts.ts`, `audit-summary.ts`,
`navigator.ts`, `index.ts`). Tests: `apps/desktop/src/main/agent/__tests__/page-tools.test.ts`
(the runner over fake WebContents), `page-scripts-dom.test.ts` (the in-page scripts run in a jsdom
document), `navigator.test.ts` (the tab navigator over a fake WebContents). Each line maps to one
named test.

## Decisions
- **The runner is the broker's.** `createPageToolRunner(deps)` implements Task 4's `ToolRunner`; the
  broker hands it only calls it decided to run and wraps what it answers as untrusted data. The
  runner re-parses each input with the tool's own schema, and answers `{ ok: true, data, source }`
  (`source` is `page:<origin>`) or `{ ok: false, code }`. Its dependencies are injected: the tab's
  live WebContents (`contentsOf`), its audit (`audit`), the controller's navigation (`navigate`), a
  clock, and Task 8's ports (until then SERP, intent and GSC tools answer `unavailable`).
- **Every tool checks the page it acts on.** The context names the page (`expectedOrigin`; approved,
  also `expectedUrl`). A `null` expectation, or a page that isn't the expected one, acts on nothing
  and answers `expired`. `page_text`, `click` and `execute_javascript` make the check inside their
  isolated-world script, as its first act, with nothing but `Location`'s unforgeable attributes and
  string concatenation (`location.origin`, and approved `location.origin + location.pathname +
  location.search === pageKeyOf(expectedUrl)`). `page_audit` and `page_data` read main's audit, not
  the page: they check the audit's URL and the tab's live URL the same way.
- **Worlds.** `click` and `page_text` run frost's fixed scripts in `AGENT_PAGE_WORLD_ID`;
  `execute_javascript` runs approved code in `AGENT_JS_WORLD_ID`, its own world. Neither is the
  main world (`0`), Electron's (`999`) or any SEO or other frost world (`NON_AGENT_WORLD_IDS`).
- **Input is data.** A script's arguments are one JSON object literal after a fixed function; the
  selector, text and code are string values in it, never source. `execute_javascript` compiles the
  code from its string inside the world, after the page check, so nothing in it runs on another
  page. (Checked on Electron 45: string compilation works in an isolated world even under a page
  CSP of `script-src 'none'`; a non-cloneable result rejects, so every script answers a JSON string
  it built itself.)
- **Bounded.** Script answers are parsed and checked in main. `page_text` is cut at `maxChars`
  (default `PAGE_TEXT_DEFAULT_CHARS`) and fitted to `TOOL_RESULT_MAX_CHARS` with its escapes
  counted. `page_audit` and `page_data` trim themselves to `PAGE_AUDIT_LIMITS.budgetChars`.
  `execute_javascript`'s result is written as JSON in-page, cut at `EXECUTE_JS_MAX_RESULT_BYTES` of
  UTF-8 (`truncated`); one that doesn't fit the tool cap is handed on as its cut JSON text.
- **Time.** `click` and `page_text` wait `PAGE_SCRIPT_TIMEOUT_MS`, `execute_javascript`
  `EXECUTE_JS_TIMEOUT_MS`, then answer `timeout`. An isolated-world script can't be stopped: the page
  may go on running it; frost reports and does not reload the page.
- **`execute_javascript` only with an approval.** Run `via` anything but `approval` it answers
  `not-allowed` (the broker never does that; defence in depth).
- **Navigate.** Only `http(s)`; it loads `parseWebUrl(url).href`, which must be the context's
  `expectedUrl`, through the controller's address-bar path (`browser.navigate`), so the browse guards
  and the render profile apply; the controller navigates the shown tab only, so a chat whose tab
  isn't shown gets `navigated: false`. Under a standing grant a main-frame redirect of this
  navigation that leaves the granted origin is cancelled and reported (`blocked: 'redirect'`, `to`);
  an approved navigate follows redirects and reports where it ended. It waits for the load to settle
  or `NAVIGATE_SETTLE_TIMEOUT_MS`.
- **No cookies, storage or main world.** No tool reads them; `click` clicks without a user gesture.

## Scenarios: reads
- `page_audit` on a ready audit answers its score, band, indexability, counts, findings (most severe
  first: rule id, severity, title, why, fix, facts, samples) and key facts → `page-audit-summarises-ready-audit`
- A large audit trims its least severe findings to the budget and says how many it left out → `page-audit-trims-to-budget`
- A pending or unavailable audit is a plain data answer; no tab is `unavailable` → `page-audit-pending-and-unavailable`
- `page_data` answers the page's facts (title, meta, canonical, robots, outline, link counts, images
  without alt, schema types, hreflang, indexability, render profile) → `page-data-facts`
- The audit tools refuse an audit or a tab of another origin, another page when approved, and a
  `null` expectation (`expired`) → `audit-tools-refuse-other-page`
- `page_text` runs its script in the agent page world, answers the text cut at `maxChars` (default
  `PAGE_TEXT_DEFAULT_CHARS`) and fitted to the tool cap → `page-text-capped`

## Scenarios: click
- `click` runs in the agent page world and reports what it clicked; not found and a bad selector are
  data answers → `click-reports-element`
- A selector with quotes, backslashes and `</script>` reaches the page as a JSON string value → `click-selector-is-data`
- `click` runs only under a grant or an approval → `click-needs-grant-or-approval`

## Scenarios: execute_javascript
- It runs only in `AGENT_JS_WORLD_ID`, never the main world or an SEO world, and its code is a JSON
  string value in a fixed wrapper → `execute-js-never-main-world`
- It runs only `via: 'approval'`, with an exact page → `execute-js-approval-only`
- A script still running after `EXECUTE_JS_TIMEOUT_MS` answers `timeout` → `execute-js-timeout`
- A result over the cap is handed on cut, flagged `truncated` → `execute-js-result-truncated`
- A thrown error is a data answer (`error`), a rejected run `failed` → `execute-js-errors`

## Scenarios: the page check
- A script answering `mismatch` (the page changed) is `expired`, and so is a tab already elsewhere → `page-mismatch-expired`

## Scenarios: navigate
- It loads `parseWebUrl(url).href` and reports the final URL, status and title → `navigate-loads-parsed-href`
- A URL that isn't the context's `expectedUrl` is `expired` → `navigate-refuses-other-target`
- Under a grant the navigator is told the granted origin; approved it isn't; a blocked redirect is reported → `navigate-grant-blocks-redirect`
- A chat tab that isn't shown is told so; nothing loads → `navigate-not-shown`

## Scenarios: every tool
- An aborted run answers `failed`, before or during the script → `abort-ends-tool`
- SERP, intent and GSC tools answer `unavailable` (Task 8) → `port-tools-unavailable`
- The browser factory finds the tab's WebContents through the controller → `browser-runner-wiring`
- The agent world ids are distinct from every other world → `agent-worlds-distinct`

## Scenarios: in the page (jsdom)
- The click finder: a selector, an exact text, a case-insensitive contained text, hidden elements
  skipped, the scan bounded; it reports tag, role, name and href and clicks once → `dom-click-finder`
- A selector or text holding quotes, backslashes and `</script>` is matched as written → `dom-click-input-is-data`
- `page_text` folds blank runs and cuts at `maxChars` without splitting a surrogate pair → `dom-page-text-caps`
- The page check inside each script: another origin, or approved another page, reads and does nothing → `dom-page-check`
- `execute_javascript`: an expression's value, a script's completion value, an async body's return,
  a code that runs once even when it throws, thrown errors → `dom-execute-runs-code`
- `execute_javascript`'s JSON: `undefined`, functions, bigints, nodes, cycles, depth and getters that
  throw, and the UTF-8 byte cap with a flag → `dom-execute-bounded-json`

## Scenarios: the navigator
- It navigates through the controller only when the URL loads as itself and the tab is shown → `navigator-uses-controller`
- It waits for the load to settle, or the timeout → `navigator-settles`
- With an allowed origin it cancels a main-frame redirect off it, and only for this navigation → `navigator-blocks-off-origin-redirect`
- Without one it follows the redirect and reports where it ended → `navigator-follows-redirect-approved`
- An abort ends the wait; the redirect watch stays until the navigation ends → `navigator-abort`
