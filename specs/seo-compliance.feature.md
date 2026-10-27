# Feature: compliance (Compliance panel)

Spec: `specs/seo-compliance.spec.ts` (`SECURITY_HEADERS`, `HEADER_STATES`, `LOOPBACK_HOST_PATTERNS`,
`HSTS_MIN_MAX_AGE_SECONDS`, `REFERRER_POLICIES`, `UNSAFE_REFERRER_POLICIES`, `CSP_INLINE_OVERRIDES`,
`INSECURE_RESOURCE_KINDS`, `ACTIVE_RESOURCE_KINDS`, `MIXED_CONTENT_SOURCE`, `SECURITY_LIMITS`,
`SECURITY_VERDICTS`, `A11Y_WORLD_ID`, `A11Y_TIMEOUT_MS`, `A11Y_RUN_TAGS`, `A11Y_DISABLED_RULES`,
`A11Y_RUN_OPTIONS`, `A11Y_IMPACTS`, `A11Y_SCORED_IMPACTS`, `A11Y_LIMITS`, `A11Y_RUN_STATUSES`,
`A11Y_FAIL_REASONS`, `COMPLIANCE_RULE_SPECS`), `specs/seo-compliance.schema.ts` (`PageSecuritySchema`,
`AccessibilityResultSchema`, `AccessibilityContextSchema`), `specs/seo-snapshot.spec.ts` (the
snapshot's `security`, `PageContext.accessibility`), `specs/seo-rules.spec.ts` (the `security` and
`accessibility` categories) and `specs/seo-sidebar.spec.ts` (the Compliance panel). Phase 2 Task 6.
Each line maps to one named test.

## Decisions
- **Security is read from what frost already has.** HTTPS from the snapshot's URL; mixed content
  from the DOM (the extractor's security read, in the isolated SEO world, after `extractPage`, with
  its own `budgetMs` deadline and caps); the headers from Task 4's recorded main-frame response
  (`RESPONSE_HEADER_ALLOWLIST` already holds CSP, HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`), plus `<meta http-equiv=
  "Content-Security-Policy">` and `<meta name="referrer">` from the DOM. Everything is parsed in the
  analysis worker by frost's own readers (`@app/seo-core`, `compliance/`).
- **Mixed content comes from the snapshot, not `webRequest`** (`MIXED_CONTENT_SOURCE`). Chromium
  blocks active mixed content in the renderer before any request exists and upgrades passive mixed
  content to https, so the network never shows either as an http request; and the browse session's
  `webRequest` events have one owner each, filtered to main frames (`browser/web-request.ts`). The
  markup states what the page asks for, blocked or not. Active (script, stylesheet, frame, object,
  font) is an error, passive (image, media) a warning. An http URL of this computer is not mixed
  content (browsers treat it as authenticated) and is not reported.
- **Unknown is not a failure.** Without the document's headers (a back/forward cache page, an
  in-page URL, nothing recorded) every header rule passes and the header table says "Unknown"; a
  meta CSP or referrer tag still counts.
- **Loopback pages are local, not insecure.** `https-missing` skips `localhost`, `*.localhost`,
  `127.0.0.0/8` and `[::1]` (secure contexts to browsers); the verdict is "Local page".
- **axe-core runs on request, in its own isolated world** (`A11Y_WORLD_ID`, review focus
  `measurement-runs-isolated`). `axe.min.js` (MPL-2.0, unmodified, licence header kept) is bundled into
  main as a string (`?raw`) and injected with `executeJavaScriptInIsolatedWorld` only when the user
  presses "Run accessibility check", once per document (a probe asks whether the world has it). The
  world has the page's DOM but its own globals and prototypes, so a page's `axe`, overridden
  `Element.prototype.matches` or `document.querySelectorAll` change nothing, and the page never sees
  frost's `axe`. Verified in Electron 45: axe 4.14 runs there unchanged (including under a page CSP
  with Trusted Types and no `unsafe-eval`); no workaround was needed.
- **Ruleset**: `A11Y_RUN_TAGS` (WCAG 2.0/2.1/2.2 A and AA, best practices) minus `A11Y_DISABLED_RULES`
  (`region`: too noisy on real pages; `frame-tested`: frames are not checked). `A11Y_RUN_OPTIONS`:
  no frames, no CSSOM preload (no network fetches from the check), violations' nodes only, no HTML
  snippets.
- **The run is bounded.** `A11Y_TIMEOUT_MS` (10 s) then "timed out" (the page's renderer may keep
  working; its late answer is dropped, and a new run while it still runs answers `busy`). The run
  script caps every list and string (`A11Y_LIMITS`) before answering; main only checks the answer's
  size with a bounded walk; the analysis worker validates it (`AccessibilityResultSchema`) beside the
  next snapshot, and a rejected answer is `invalid` without taking the audit down.
- **Scoring is modest and opt-in.** Until a check has run on the document and URL shown, nothing is
  scored. Then `a11y-critical` and `a11y-serious` are one warning each (whatever the number of rules
  and elements); moderate and minor violations are shown, never scored.
- **A run belongs to one document and URL.** A new document, an in-page navigation to another URL,
  an error or crash panel or a closed tab cancels it (back to idle, late answers dropped). An answer
  re-scores the audit at once for the active tab, keeping the shown audit on screen until the new one
  is ready (`rerun(tab, keepShown)`; with Task 5's measurement still on its way, until the final
  one), or when a background tab is next shown. Later audits of the same document keep the answer:
  it is an input of the page's context known at once (`withKnown`, `seo/context-source.ts`).
- **State reaches the chrome without new channels.** `seo.getAudit`'s ready answer carries the
  tab's `accessibilityRun`; its changes bump the tab's `auditVersion` (the auditor's version plus the
  run's), so `browser.watch` wakes the sidebar. `seo.runAccessibility` (sender-guarded) starts a run.
- **Review fixes** (after the Task 6 review):
  - `upgrade-insecure-requests` in any enforced policy (header or meta; not report-only) means the
    browser fetches http subresources over https: they are listed as "Upgraded by CSP", and neither
    mixed content rule fails (`CSP_UPGRADE_DIRECTIVE`).
  - X-Frame-Options follows the HTML Standard's algorithm (`XFO_BLOCKING_VALUES`): several distinct
    values block framing if one of them is DENY, SAMEORIGIN or ALLOWALL; a single ALLOWALL or unknown
    value allows it. A Content-Security-Policy header's `frame-ancestors` overrides it, whatever its
    sources allow (the XFO row then says it is overridden, and is not called weak only when
    `frame-ancestors` restricts framing). `frame-ancestors` holding `*`, a bare scheme or a wildcard host does not
    protect (`FRAME_ANCESTORS_OPEN`). Inline scripts are decided by `script-src-elem`, then
    `script-src`, then `default-src` (`CSP_SCRIPT_ELEMENT_DIRECTIVES`).
  - CSP headers (and Content-Security-Policy-Report-Only, now recorded) are kept up to 16 KB
    (`LONG_VALUE_HEADERS`, `maxLongHeaderValueChars`); a value still cut is marked `truncated`, and
    what depends on the policy (inline scripts, frame-ancestors, upgrade-insecure-requests) is
    unknown: no rule fails because of it, and the CSP row says it was cut (`CSP_CUT_IS_UNKNOWN`).
  - The run script runs the rules in `A11Y_RULE_CHUNKS` chunks and checks its own deadline
    (`A11Y_PAGE_BUDGET_MS`) before each; past it, it answers `partial: true`, and the panel says
    not every rule ran. A chunk that overruns still times out in main, and the panel says the page may
    stay busy for a while. Before injecting axe and before running it, main checks the run is still
    for the requested document and URL, and aborts (no injection, no run) if not.
  - "Local page" only when nothing above info fails; a warning on a loopback page is "Needs attention".
  - The extractor keeps the last *valid* `<meta name="referrer">` (`META_REFERRER_VALUES`).
  - axe's summaries and descriptions are bidi-isolated text.
- **Panel.** A verdict card (Secure / Needs attention / Not secure / Local page, with HTTPS, mixed
  content and HSTS signals), the ranked security issues, the security header table (present / weak /
  missing / unknown / not applicable, the values as text and frost's reading of them), the mixed
  content list, then the accessibility card: the run button, progress against the time cap, then a
  tally by impact, the groups (worst first) and each rule expandable to its description, help URL
  (text, "Open in new tab" through `browser.openBackgroundTab`, http(s) only) and elements (selector
  text and axe's failure summary). Light and dark; inline SVG icons drawn for frost; no `style`
  props, no HTML from the page. "Highlight node" is not offered in this task.

## CSP (`packages/seo-core/src/__tests__/compliance.test.ts`)
- Policies split on commas, directives on semicolons, first occurrence wins, junk names skipped, a meta policy drops frame-ancestors / report-uri / sandbox; linear → `csp-parser-reads-policies`
- Inline scripts run only if every policy that governs scripts allows `'unsafe-inline'` without a nonce, hash or `'strict-dynamic'` → `csp-inline-scripts`
- frame-ancestors counts from header policies only → `csp-frame-ancestors-header-only`
- frame-ancestors with `*`, a bare scheme or a wildcard host does not protect; `'none'`, `'self'` and hosts do → `frame-ancestors-open-sources`
- `script-src-elem` decides inline scripts before `script-src` and `default-src` → `csp-script-src-elem-precedence`
- A cut CSP header leaves inline scripts, frame-ancestors and upgrade-insecure-requests unknown: no rule fails for them → `csp-cut-is-unknown`

## Headers
- HSTS parses max-age (quoted too), includeSubDomains, preload; duplicates or a bad max-age make it ignored → `hsts-parser`
- nosniff is the first token → `frame-options-and-nosniff`
- X-Frame-Options by the HTML Standard: one DENY / SAMEORIGIN blocks; several distinct values block if one is DENY, SAMEORIGIN or ALLOWALL; ALLOWALL alone and unknown values allow → `frame-options-html-algorithm`
- An enforced `frame-ancestors` (a header policy's) overrides X-Frame-Options even when its sources allow framing: with `frame-ancestors *` and `X-Frame-Options: DENY` the page is unprotected (`clickjacking-unprotected` fails), the XFO is not counted, and its row says it is overridden by CSP frame-ancestors; a meta policy's `frame-ancestors` overrides nothing → `frame-ancestors-overrides-frame-options`
- The referrer policy is the last known header token, a meta tag (legacy values too) wins → `referrer-policy-reading`

## Mixed content
- Active and passive kinds split as `ACTIVE_RESOURCE_KINDS`; an http page has none → `mixed-content-classification`
- This computer's hosts are loopback → `loopback-hosts`
- `upgrade-insecure-requests` (header or meta, not report-only) turns http subresources into "upgraded by CSP": no mixed content rule fails, the verdict is not Not secure → `mixed-content-upgraded-by-csp`

## Rules (one named test per rule; the clean fixture passes all → `compliance-rules-in-catalog`)
- `https-missing` · `mixed-content-active` · `mixed-content-passive` · `hsts-missing` · `hsts-short-max-age` · `csp-missing` · `csp-unsafe-inline` · `nosniff-missing` · `clickjacking-unprotected` · `referrer-policy-missing` · `referrer-policy-unsafe` · `a11y-critical` · `a11y-serious`

## Accessibility scoring and report
- Not run: not scored; moderate/minor never scored; critical and serious one warning each; another URL's answer is not run; an invalid one is shown as such and not scored → `a11y-only-scored-once-run`
- Groups by impact, worst first, rules by elements affected → `a11y-report-groups-by-impact`
- Verdicts: secure / attention / insecure / local from the security rules' severities; local only when nothing above info fails → `security-verdicts`
- Header rows: good / weak / missing / unknown / not applicable, meta tags, notes; X-Frame-Options is not weak when frame-ancestors protects; a cut CSP says so → `security-header-rows`

## Extraction (`apps/desktop/src/main/seo/__tests__/security-extract.test.ts`)
- http subresources of an https page by kind, deduplicated, links and canonicals ignored, loopback hosts skipped → `security-read-finds-http-subresources`
- Nothing on an http page; a `<base>` can make relative URLs http → `security-read-only-on-https-pages`
- Meta CSP values and the last valid meta referrer → `security-read-meta-policies`
- CSP headers are kept up to 16 KB, other headers 2 KB; a cut value is marked `truncated` and still validates → `csp-header-cap`
- Every cap and the scan limit hold → `security-read-is-bounded`
- It is part of the extractor's script → `security-read-is-in-the-extractor-script`

## Accessibility check (`apps/desktop/src/main/seo/__tests__/a11y.test.ts`)
- The summary of a fixture result: order, fields, selectors, no snippets, bad help URLs dropped → `a11y-summary-from-fixture`
- Every cap holds on a hostile result, in bounded time → `a11y-summary-caps`
- Garbage never throws and still validates → `a11y-summary-never-throws`
- The schema rejects every over-cap or malformed answer; in a context it becomes `invalid` → `a11y-result-schema-caps`
- The worker scores a valid answer, marks a bad one invalid, and leaves a page without one not run → `a11y-result-validated-in-worker`
- Main's size check is bounded → `within-size`
- The run script is self-contained and axe is injected unmodified → `a11y-run-script-is-self-contained`
- Only the accessibility world is used, axe injected once per document → `a11y-runs-in-its-isolated-world-only`
- Real axe on a DOM finds missing alt, unlabelled field and empty button; disabled rules never report; the DOM is unchanged → `a11y-real-axe-on-a-dom`
- An earlier run still going answers busy → `a11y-busy-run-is-reported`
- The rules run in chunks; past its own deadline the script answers what it has, marked partial → `a11y-run-in-chunks-with-deadline`
- A document or URL change between the probe and the injection or the run aborts the check (no injection, no run) → `a11y-run-aborts-if-the-document-changed`

## Run lifecycle and controller (`apps/desktop/src/main/seo/__tests__/a11y-runs.test.ts`)
- Runs only on request, reports running and bumps the audit version, never doubled → `a11y-run-starts-on-request-only`
- Only the active tab showing a web page → `a11y-run-only-for-the-active-web-page`
- An answer is scored without a pending audit in between, and kept for later audits of the document → `a11y-answer-is-scored-without-pending`
- Time cap: timed out, late answer dropped, can run again → `a11y-run-times-out`
- A new document cancels it; its late answer never reaches the next page → `a11y-run-cancelled-by-navigation`
- A reload is a new document: the answer goes → `a11y-answer-belongs-to-its-document`
- A fragment change keeps it, another URL cancels it → `a11y-run-cancelled-by-in-page-navigation`
- Busy, script errors, non-objects and oversized answers fail with their reasons → `a11y-run-failures`
- A crash or a closed tab ends it → `a11y-run-ends-with-the-page`
- A background tab's answer is scored when it is shown → `a11y-background-tab-scored-when-shown`
- An answer arriving while a later context input (a speed measurement) is pending: the shown audit stays, then the final audit has both → `a11y-answer-while-context-pending`

## Router (`packages/ipc-contract/src/__tests__/seo-router.test.ts`)
- `seo.runAccessibility` is sender-guarded, validates `{ tabId }` strictly, is a mutation answering a boolean → `seo-procedures-*`

## Renderer helpers (`apps/desktop/src/renderer/__tests__/compliance-view.test.ts`)
- The verdict card's summary and signals → `security-card-text`
- Header tones and the "unknown" notes → `header-tones-and-notes`
- What the accessibility section shows for each run state and report → `a11y-view-states`
- Upgraded mixed content in the signals; partial and timed-out notes → `compliance-notes`
- Progress, impact counts and node lists → `a11y-progress-and-counts`

## End to end (`apps/desktop/e2e/seo-compliance.e2e.ts`)
https cases use a loopback https server with a fresh self-signed certificate that the suite's own
app trusts for `127.0.0.1` (`setCertificateVerifyProc` on the browse session, reset afterwards); the
certificate helper is shared with the browse guard's certificate-error test (`e2e/tls.ts`).
- All security headers: Secure, no issues, every row present, no mixed content, the check idle → `secure-page-is-clean-e2e`
- No headers: Needs attention with the five header issues; weak values flagged; an http loopback page is Local → `missing-headers-show-issues-e2e`
- Active and passive http subresources reported (Chromium blocks the active ones), loopback ones not; Not secure; text only → `mixed-content-is-detected-e2e`
- With `upgrade-insecure-requests` the same subresources are "Upgraded by CSP", no mixed content issue, not Not secure → `mixed-content-upgraded-by-csp-e2e`
- A run reports missing alt, unlabelled field, empty button (critical) and low contrast (serious); a rule opens to its selector and help URL, which opens in a background tab; the score drops and Overview lists both (once its issue list has settled) → `accessibility-check-reports-violations-e2e`
- After a run the main world has no `axe` and an unchanged DOM; a page overriding DOM methods and defining its own `axe` gets the same results and keeps its own `axe` → `measurement-runs-isolated-e2e`
- A 24 000-element page answers within the cap (every list capped) or times out, the app stays responsive, and navigating away cancels a run: back on the page, it is still idle after the cap → `huge-dom-run-stays-bounded-e2e`
