# Feature: AI readiness

Spec: `specs/ai-readiness.spec.ts` (`AI_BOT_ROLES`, `AI_ROBOTS_STANCES`, `AI_BOT_IDS`, `AI_BOTS`,
`AI_BOT_VERDICTS`, `AI_ASSISTANT_SOURCES`, `AI_ASSISTANT_IDS`, `AI_ASSISTANTS`, `AI_RENDERING_NOTE`,
`AI_STANCE_NOTES`; Task 7: `AI_READINESS_CHECKS`, `AI_READINESS_WEIGHTS`, `AI_CHECK_STATUSES`,
`AI_CHECK_VALUES`, `AI_SCORE_REQUIRED_CHECKS`, `AI_REACH_AGENTS`, `AI_REACH_FACTS`, `aiReadinessScore`, `aiScoreBasis`,
`LLMS_TXT_OUTCOMES`, `LLMS_TXT_CACHED_OUTCOMES`, `LLMS_TXT_FINDINGS`, `LLMS_TXT_TEXT_TYPES`,
`LLMS_TXT_ACCEPT`, `LLMS_TXT_PARSE_LIMITS`, `LLMS_TXT_NOTE`), `specs/ai-readiness.schema.ts`
(`LlmsTxtJobSchema`, `LlmsTxtAnswerSchema`, `LlmsTxtStateSchema`), with
`specs/visibility-probes.spec.ts` (`PROBE_AGENT_IDS`, `PROBE_AGENTS`, `PROBE_LIMITS`,
`LLMS_TXT_LIMITS`), `specs/visibility-probes.schema.ts` (`ProbeReportSchema.llmsTxt`) and
`specs/seo-indexability.spec.ts` (`ROBOTS_ALLOW_ALL_OUTCOMES`, `ROBOTS_UNKNOWN_OUTCOMES`). Phase 9
Task 6 (the robots.txt part) and Task 7 (the score and `llms.txt`; the UI follows in Task 8);
security review (Task 7: the `/llms.txt` fetch). Each line maps to one named test.

## Decisions
- **Separate from the SEO health score.** No AI-readiness rule is in `SEO_RULE_SPECS`, so no page's
  health score changes; blocking an AI crawler is a legitimate choice.
- **Fourteen tokens, judged with no extra request.** `AI_BOTS` lists 14 robots.txt tokens with their
  operator, role and stance. seo-core judges each against the robots.txt the audit already has
  (`PageContext.robots`) with the Indexability panel's parser and `matchRobots`, on the page's path
  (`audit.aiReadiness.bots`).
- **Two more probed agents, because their operators publish user agents.** The visibility probes add
  OAI-SearchBot and ChatGPT-User (8 agents, so `PROBE_LIMITS.maxFetches` is 8 and `maxRequests` 32).
  ClaudeBot keeps the observed user agent it was probed with before this phase; Claude-SearchBot and
  Claude-User are not probed (Anthropic publishes their tokens, not user agents). Control tokens
  (Google-Extended, Applebot-Extended) send no requests and are never probed.
- **Roles and stances from operator documentation.** `ai-search`, `live-fetch`, `training`;
  `documented`, `may-ignore` (ChatGPT-User, Perplexity-User), `control-token`, `not-documented`
  (Bytespider). Applebot is `ai-search`. Copilot → Bingbot and Google AI → Googlebot plus
  Google-Extended are frost's model. Applebot follows Googlebot's groups when none names it and some
  name Googlebot (Apple's documented rule, `followsGooglebot`); each verdict says which groups decided
  (`via`: `own`, `googlebot`, `*`).
- **The score is frost's, static and probe-based only.** Seven checks (`AI_READINESS_CHECKS`), each
  `pass` (1), `warn` (0.5), `fail` (0), `info` (a neutral fact, never scored or counted) or
  `not-checked`; the score is `round(100 × Σ w·v / Σ w)` over
  the checked ones with a weight (search-indexable 25, ai-search-crawlers 30, served-content 25,
  agent-reachability 20), "based on k of 4", and `null` until the three static ones are checked.
  Live-fetch agents, training opt-outs and `llms.txt` are shown with weight 0: a training opt-out is
  the owner's choice (it reads `info` once robots.txt is read, neither good nor bad), and `llms.txt`
  is a proposal no engine documents using (it keeps pass / warn / fail: whether the file is there and
  well-formed is a real fact about it). `agent-reachability` judges only the probe agents of the
  `ai-search` and `live-fetch` bots (`AI_REACH_AGENTS`); refusing a training crawler (GPTBot,
  ClaudeBot) is an opt-out, never a reachability fault. It never reads AI engines' answers (Phase 12). seo-core's
  `aiReadinessOf(audit, probes)` (`ai-readiness/score.ts`) is pure and reads only the audit and
  `ProbesState`; the Visibility panel and the Overview tile (Task 8) call it with both.
- **`llms.txt` only with a probe run.** `<page origin>/llms.txt` only (no subpaths), once per run
  after the agents' calls, through the probes' SERP lane (its private-address rules, the tab's URL as
  the page) with frost's own user agent and `LLMS_TXT_LIMITS`; kept per origin
  (`LLMS_TXT_CACHED_OUTCOMES`) for robots.txt's cache lifetime; Clear Browsing Data forgets it; Stop
  and cancel abort it. Its 2xx text body is parsed in the probes' SERP worker (`llms-txt` jobs) by
  seo-core's `parseLlmsTxt` against llmstxt.org's proposal (`LLMS_TXT_FINDINGS`); only counts,
  findings and a capped, control-free title leave the worker. The agent's tool output is unchanged.

## Catalogue and verdicts (`packages/seo-core/src/__tests__/ai-readiness.test.ts`)
- `ai-bots-catalogue-has-14-tokens-and-known-roles` — exactly 14 entries in `AI_BOT_IDS` order, one per
  token (the table of Task 6), every role in `AI_BOT_ROLES` and stance in `AI_ROBOTS_STANCES`, every
  id its token lowercased, every docs URL `https:` or `null`; each probed bot's probe agent sends its
  token; the assistants map ChatGPT, Claude, Perplexity and Apple from their operators and Copilot and
  Google AI as frost's model.
- `ai-bots-judged-from-audit-robots` — one fixture robots.txt gives each of the 14 tokens its verdict
  on the page's path, with the deciding rule and its line; a token with no group of its own falls
  back to `*` (`via: '*'`); `Claude-SearchBot` is judged by its own group, not `Claude-User`'s; a
  missing file allows every token, an unreadable one is `unknown`.
- `applebot-follows-googlebot-when-not-named` — only Applebot has `followsGooglebot`; with no
  Applebot group and a Googlebot one, Applebot is judged by Googlebot's group (`via: 'googlebot'`)
  while Applebot-Extended and the rest use `*`; with no Googlebot group (a `Googlebot-News` one is
  another crawler) Applebot uses `*`; its own group wins over both.
- `control-tokens-never-requested` — Google-Extended and Applebot-Extended are `control-token`
  `training` tokens with no probe agent, and no probe agent sends either token; the verdicts come
  from the audit's robots.txt alone.
- `robots-pending-is-not-checked` — while robots.txt is `pending`, or when there is none, every
  verdict reads `not-checked`.
- `no-new-rule-in-catalog` — `SEO_RULE_SPECS` keeps its rules (none about AI crawlers), and a
  robots.txt blocking every AI token gives the same findings and health score as one blocking none.

## Score (`packages/seo-core/src/__tests__/ai-readiness.test.ts`)
- `score-weights-and-partial` — the checks, weights, statuses and values are Decision 11's; every check
  passing is 100 on 4 of 4; before a probe run the score is weighted over the three static checks
  ("Based on 3 of 4 checks"), and the fourth counts once the run is in; it rounds; from the audit,
  `ai-search` tokens all allowed pass, some blocked warn, all blocked fail, and an unreadable
  robots.txt is not checked; indexable passes, canonicalised warns, not-indexable fails.
- `score-null-until-static-checks` — with any of search-indexable, ai-search-crawlers and
  served-content not checked the score is `null`, whatever else is checked; a pending served
  comparison or a pending robots.txt keeps it `null`.
- `training-and-llms-unscored` — live-fetch agents, training opt-outs and `llms.txt` weigh 0, so no
  status of theirs moves the score; training opt-outs read the neutral `info` whether every training
  token is blocked, some or none, and `not-checked` before robots.txt is read (pending or
  unreadable); `info` has no value, so even on a weighted check it is never scored or counted; live-fetch tokens are judged like the AI search crawlers; `llms.txt` `ok` passes,
  `malformed` warns, `missing` and `not-text` fail, any other outcome (or no run) is not checked.
- `served-content-from-js-verdict` — `independent` passes, `partly` warns, `heavily` fails (an
  `identical` comparison carries its verdict too); pending or unavailable is not checked.
- `agent-reachability-from-probes` — over `AI_REACH_AGENTS` (derived from `AI_BOTS`: OAI-SearchBot,
  ChatGPT-User, PerplexityBot) of a finished run for the page: a non-2xx
  answer fails, as do a 2xx that is not HTML, a refused redirect, a timeout and a `noindex`; a
  visible-text diff warns; the worst agent decides; frost's own limits (`busy`, `parse-failed`)
  leave an agent out; a search crawler's answer is not this check's; no run, a running or stopped
  run, a run for another URL and a browser without a page are not checked.
- `training-crawlers-refused-still-reachable` — GPTBot and ClaudeBot answered 403 and told
  `noindex` (or timing out), every other agent fine: `agent-reachability` passes, lists neither, and
  the score is the same as a clean run's.
- `score-imports-no-capture-module` — `score.ts` imports only the audit's types and `ProbesState`'s
  (type-only) and the Zod-free specs: nothing of answer capture, and no clock or I/O.
- `no-spec-import-cycle` — `visibility-probes.spec.ts` imports nothing of AI readiness and owns
  `LLMS_TXT_LIMITS`; `ai-readiness.spec.ts` imports only it (`ProbeAgentId` and `LLMS_TXT_LIMITS`);
  the schemas run the same way (`visibility-probes.schema.ts` reads `ai-readiness.schema.ts`).
- `llms-txt-findings` — a file in the proposal's shape (H1, summary, H2 sections of `[name](url)`
  links with notes) has no findings; no H1, an H1 after other text, no links and list items that are
  not links are each found; an HTML page is not an llms.txt; code fences and lists outside sections
  are ignored; the title is capped and loses control and bidi characters; the parse is bounded.

## llms.txt (`apps/desktop/src/main/serp/__tests__/probes.test.ts`)
- `llms-txt-only-on-run` — page loads, in-page moves, reads and watches fetch nothing (`llmsTxt` is
  `null` while idle); a run asks for the tab origin's `/llms.txt` once, after the agents' calls; it
  is no agent's row; a background tab never asks; it is parsed as an `llms-txt` job.
- `llms-txt-once-per-origin-cached` — a second run, and a run on another page of the origin, show the
  cached answer at once (with when it was read) and ask nothing; another origin asks for its own;
  past the cache's lifetime it is asked again; an answer about nothing (a timeout) is not kept; an
  HTML answer is `not-text` and never parsed.
- `llms-txt-private-redirect-refused` — through the real bounded fetcher, a public page's
  `/llms.txt` redirecting to a private address is refused (`private-redirect`) and never requested,
  and not kept.
- `llms-txt-parsed-in-worker` — `runLlmsTxtJob` validates the job (`LlmsTxtJobSchema`: kind, an
  http(s) URL, the body cap, nothing else) and answers counts, findings and a capped title, decoding
  the charset the server names; the parser queue posts it as `{ id, kind: 'llms-txt', job }` under
  `parseTimeoutMs`; the worker entry answers it; a failed parse is `parse-failed` and not kept.
- `llms-txt-cleared-by-clear-browsing-data` — after `clearCache()` (the SERP setup's Clear Browsing
  Data, with `cancelAll()`) the next run asks again.
- `stop-and-cancel-abort-llms-txt` — Stop aborts the `/llms.txt` request in flight and marks it
  `stopped` (not kept); a new document, Clear Browsing Data and quitting abort it and the state goes;
  a parse in the worker is ended with the run.
