# Feature: Visibility probes

Spec: `specs/visibility-probes.spec.ts` (`PROBE_AGENT_IDS`, `PROBE_AGENTS`, `PROBE_DIRECTIVE_SOURCES`,
`PROBE_BASELINE`, `probeUserAgent`, `PROBE_LIMITS`, `PROBE_KEEP_HEADERS`, `PROBE_SEPARATE_HEADERS`,
`PROBE_DIFF_TOLERANCE`, `PROBE_TEXT_SIMILARITY`, `MAX_PENDING_PROBE_WATCHES`, `PROBE_STATUSES`,
`PROBE_OUTCOMES`, `PROBE_OUTCOME_MESSAGES`, `PROBE_ROBOTS_VERDICTS`, `PROBE_ROBOTS_SERVED_NOTE`,
`PROBE_CANONICAL_CONFLICTS`, `PROBE_DIFF_FACTS`, `PROBE_TRUNCATED_NOTE`,
`PROBE_MODELLED_DIRECTIVES_NOTE`, `PROBE_DISCLOSURE`), `specs/visibility-probes.schema.ts`
(`ProbeRowSchema`, `ProbeDiffSchema`, `ProbeReportSchema`, `ProbesStateSchema`, `ProbeJobSchema`,
`ProbeRobotsAnswerSchema`, `ProbePageAnswerSchema`), `specs/serp-service.spec.ts`
(`SERP_FETCHER_LIMITS`) and `specs/fetcher.spec.ts` (`BoundedFetchRequest.separateHeaders`). Phase 3
Task 5; review focus `probes-are-bounded`. Each line maps to one named test.

## Decisions
- **Only on the user's action.** Nothing is fetched until `serp.runProbes` (or
  `SerpReadApi.runProbes`, which Phase 5 gates behind its approval model) for the active tab showing
  an `http(s)` page. Page loads, navigations, `serp.probes` and `serp.watchProbes` never fetch.
- **Bounded.** One fetcher call per agent (6), never retried, at most 3 redirects each (at most 24
  requests), at most 2 calls in flight, `page` the tab's URL (so the fetcher's private-address rule
  applies: a private host only for a private page), `PROBE_LIMITS`' caps and `PROBE_KEEP_HEADERS`.
  robots.txt comes from main's cached robots.txt fetcher, once per origin an agent ended on, and is
  not one of the calls. One run per tab.
- **Their own lane.** The SERP lane (`SERP_FETCHER_LIMITS`): a bounded fetcher over main's hop and
  resolver with the `checks` lane's limits and its own queues, so a link check never makes a probe
  wait or time out; pack updates and the model download use it too (`fetcher.spec.ts`, Lanes).
- **Off main's thread.** robots.txt, the headers and the bodies are parsed in a SERP worker of the
  probes' own (`probe` jobs, validated with `ProbeJobSchema`, answers checked with the answer schemas
  there), one job at a time, each with `PROBE_LIMITS.parseTimeoutMs`; a stopped or cancelled run's
  jobs are dropped or ended with it.
- **The JavaScript panel's served view.** The title, canonicals and word count come from
  `parseServedHtml`; a second bounded `parse5` walk reads the same text for the hash and signature,
  and every agent's `<meta name>` values (the served snapshot keeps only the search engines').
- **Honest.** One `PROBE_DISCLOSURE` (the user agent alone, the request count, robots.txt reported
  not obeyed, the bot-protection risk, `FETCH_DISCLOSURE`); the AI crawlers' directive handling is
  labelled frost's model (`PROBE_MODELLED_DIRECTIVES_NOTE`); robots.txt as served to frost
  (`PROBE_ROBOTS_SERVED_NOTE`); diffs on cut text say so (`PROBE_TRUNCATED_NOTE`).

## Agents and reading (`apps/desktop/src/main/serp/__tests__/probe-compare.test.ts`)
- `probes-agent-table` — six agents in a fixed order, the browser first (kind `browser`, frost's own user agent, token `*`, `robots` only); Googlebot smartphone and Bingbot send the render profiles' strings with the app's Chromium version; GPTBot, ClaudeBot and PerplexityBot their strings verbatim; each has its robots.txt token and `robots` plus its own name, documented for the search crawlers and frost's model for the AI crawlers; `PROBE_LIMITS` allows 6 calls, 3 redirects each, 24 requests; the disclosure says all of it, with `FETCH_DISCLOSURE`.
- `probes-per-agent-robots` — a robots.txt disallowing a path for GPTBot only is `disallowed` for GPTBot (with its rule, group and file) and `allowed` for the rest (the browser by `*`, others falling back to `*`); each agent is judged on the URL it ended on; another origin's file never judges a URL (`unknown`); a missing file is `allowed`, an unreadable one `unknown`, none asked `unknown`; the worker job validates its input.
- `probes-agent-scoped-x-robots-tag` — `X-Robots-Tag: googlebot: noindex` is Googlebot's own, ignored by the others; repeated headers kept apart (`googlebot: nofollow` and `noindex`) are Googlebot's `nofollow` and everyone's `noindex`; within one value `noindex, gptbot: nofollow` is general `noindex` and GPTBot's `nofollow`; valued directives (`max-snippet: 20`) are not crawler names; `none` is `noindex` and `nofollow`.
- `probes-meta-per-agent` — `<meta name="claudebot" content="noindex">` makes ClaudeBot's `noindex` only; `<meta name="robots">` applies to everyone; names compare lowercased; a meta for another crawler is ignored.
- `probes-page-facts` — the worker's page job reads the title, the canonical (else the `Link` header's), the word count, the text hash and signature as the served view does (hidden, script and style text left out, whitespace collapsed); the same words give the same hash, other words another; several HTML canonicals and an HTML one against the header's are reported as conflicts; a non-HTML answer is read from its headers only and keeps its `Link` canonical; an invalid job is refused; every answer passes its schema.
- `probes-text-similarity` — the MinHash signature of word 3-shingles (fixed seeds, 64 values) gives 1 for the same text (case aside), stays high for a small edit, low for another text; an empty text has none (two empty texts alike, one empty one not).
- `probes-diff-against-browser` — against the baseline: a redirect only for one agent marks `finalUrl` and `redirects`; the same hop count with another status or URL marks `redirects`; robots disallowed for GPTBot only marks `robots`; Googlebot's `noindex` marks `noindex`; a canonical that differs marks `canonical` (a non-HTML answer's header canonical too); content smaller than the baseline beyond the tolerance marks `wordCount`, `bytes` and `text` (similarity below `minSimilarity`), a near-identical text nothing; cut text is still compared and flagged `contentTruncated`; a failed request marks `status` only (no final URL to compare, no content facts); unsettled rows have no diff; the facts follow `PROBE_DIFF_FACTS`.

## Runs (`apps/desktop/src/main/serp/__tests__/probes.test.ts`, with fakes and the real bounded fetcher)
- `probes-are-bounded` — one run makes exactly 6 fetcher calls (one per agent's user agent, `GET`, `page` the tab URL, the caps, kept and separate headers of `PROBE_LIMITS`), at most 2 at once, and asks robots.txt once from main's fetcher when every agent stays on the origin; through the real fetcher a public page's redirect to a private address is refused (`private-redirect`), a public name resolving to a private address is never requested (`private-address`), and a private page may be probed.
- `probes-only-on-user-action` — loads, navigations, state reads and watches fetch nothing; a background tab, a tab without a web page and an unknown tab do not run; after `dispose()` nothing runs.
- `probes-one-run-per-tab` — a second `run` while one runs starts nothing; a finished run can be run again.
- `probes-rows-stream` — every row is `pending` at first and filled in as its answer is read (with robots.txt's verdict for its final URL), each bumping `version`; the robots.txt read is listed with when it was read; the state passes `ProbesStateSchema` throughout; diffs appear once the baseline has settled.
- `probes-robots-per-final-url` — an agent sent to another origin is judged by that origin's robots.txt, asked once for all agents there and listed; one sent to another path is judged on it; a final URL on a private host (the page public) is never asked (`unknown`).
- `probes-stop-keeps-rows` — Stop aborts the requests in flight, keeps finished rows, marks the rest `stopped` and the run `stopped`; a late answer changes nothing.
- `probes-cancel-on-new-document` — a new document, an in-page move to another URL (the same URL with another fragment keeps it), a closed tab and Clear Browsing Data (`cancelAll`) abort the run's requests and reset its state to `idle`; a late answer is dropped.
- `probes-stop-frees-the-worker` — with the real job queue, Stop then Run three times: each stopped run's jobs leave the queue and its running job's worker is ended, so a fourth run reads every row; a job whose signal has aborted never runs.
- `probes-watch-wakes-capped` — `watch` answers at once when newer, on the next change, and on abort; one more than `MAX_PENDING_PROBE_WATCHES` answers the oldest early; `dispose()` answers every waiter.
- `probes-parse-in-worker` — probe jobs run one at a time in one worker; past `parseTimeoutMs` it is terminated and the job is `parse-failed`; a crash fails the job; a full queue refuses at once; after `dispose()` nothing spawns; the worker entry answers `{ id, kind: 'probe', job }` with `{ id, result }`, and its code imports no Electron.

## Router and setup
- `serp-probes-procedures` (`packages/ipc-contract/src/__tests__/serp-router.test.ts`) — `serp.runProbes`, `serp.stopProbes` (mutations, `{ tabId }` → whether it runs / stopped), `serp.probes` (`{ tabId }` → `ProbesState`) and `serp.watchProbes` (`{ tabId, sinceVersion }` → `ProbesState`, a long-poll as `serp.watch`) are `enforceSender`-first with strict inputs, like the other `serp.*` procedures.
- `serp-setup-wires-probes` (`apps/desktop/src/main/serp/__tests__/setup.test.ts`) — the service and the read API expose the probes; a run uses the SERP lane and main's robots.txt fetcher; a tab's new document, in-page move and close, and Clear Browsing Data, cancel it; `will-quit` disposes the probes and their worker.
- `serp-lane-own-queues` (`setup.test.ts`) — over one hop, a link check holding the `checks` lane's slots on a site (more waiting) never delays the probes, which run in the SERP lane's own queues; "Check for selector updates" goes through the same lane and hop.
