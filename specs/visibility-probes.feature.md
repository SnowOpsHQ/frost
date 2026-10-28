# Feature: Visibility probes

Spec: `specs/visibility-probes.spec.ts` (`PROBE_AGENT_IDS`, `PROBE_AGENTS`, `PROBE_BASELINE`,
`probeUserAgent`, `PROBE_LIMITS`, `PROBE_KEEP_HEADERS`, `PROBE_DIFF_TOLERANCE`,
`MAX_PENDING_PROBE_WATCHES`, `PROBE_STATUSES`, `PROBE_OUTCOMES`, `PROBE_OUTCOME_MESSAGES`,
`PROBE_ROBOTS_VERDICTS`, `PROBE_DIFF_FACTS`, `PROBE_HONESTY_NOTE`, `PROBE_ROBOTS_NOTE`,
`PROBE_DISCLOSURE`) and `specs/visibility-probes.schema.ts` (`ProbeRowSchema`, `ProbeDiffSchema`,
`ProbeReportSchema`, `ProbesStateSchema`, `ProbeJobSchema`, `ProbeRobotsAnswerSchema`,
`ProbePageAnswerSchema`). Phase 3 Task 5; review focus `probes-are-bounded`. Each line maps to one
named test.

## Decisions
- **Only on the user's action.** Nothing is fetched until `serp.runProbes` (or
  `SerpReadApi.runProbes`, which Phase 5 gates behind its approval model) for the active tab showing
  an `http(s)` page. Page loads, navigations, `serp.probes` and `serp.watchProbes` never fetch.
- **Bounded.** One GET per agent (6), never retried, at most 2 in flight, each through the `checks`
  lane with `page` the tab's URL (so the fetcher's private-address rule applies: a private host only
  for a private page), `PROBE_LIMITS`' caps and `PROBE_KEEP_HEADERS`. robots.txt comes once from
  main's cached robots.txt fetcher and is not one of the 6. One run per tab.
- **Off main's thread.** robots.txt, the headers and the bodies are parsed in the SERP worker
  (`probe` jobs, validated with `ProbeJobSchema`, answers checked with the answer schemas there),
  one job at a time, each with `PROBE_LIMITS.parseTimeoutMs` (the worker is terminated past it).
- **The JavaScript panel's served view.** The title, canonical and word count come from
  `parseServedHtml`; a second bounded `parse5` walk reads the same text for the hash, and every
  agent's `<meta name>` values (the served snapshot keeps only the search engines').
- **Reported, not obeyed.** A disallowed agent's row still has its answer (`PROBE_ROBOTS_NOTE`).
- **Honest.** `PROBE_HONESTY_NOTE` with `FETCH_DISCLOSURE` (`PROBE_DISCLOSURE`).

## Agents and reading (`apps/desktop/src/main/serp/__tests__/probe-compare.test.ts`)
- `probes-agent-table` — six agents in a fixed order, the browser first (kind `browser`, frost's own user agent, token `*`, `robots` only); Googlebot smartphone and Bingbot send the render profiles' strings with the app's Chromium version; GPTBot, ClaudeBot and PerplexityBot their published strings; each has its robots.txt token and obeys `robots` plus its own name; at most `PROBE_LIMITS.maxFetches`; the honesty note is paired with `FETCH_DISCLOSURE`.
- `probes-per-agent-robots` — a robots.txt disallowing the page for GPTBot only is `disallowed` for GPTBot (with its rule and group) and `allowed` for the rest (the browser by `*`, others falling back to `*`); a missing file is `allowed` for all; an unreadable one `unknown`; `null` (no file asked) `unknown`.
- `probes-agent-scoped-x-robots-tag` — `X-Robots-Tag: googlebot: noindex` is Googlebot's own, ignored by the others; a joined `noindex, gptbot: nofollow` is general `noindex` and GPTBot's `nofollow`; valued directives (`max-snippet: 20`) are not crawler names; `none` is `noindex` and `nofollow`.
- `probes-meta-per-agent` — `<meta name="claudebot" content="noindex">` makes ClaudeBot's `noindex` only; `<meta name="robots">` applies to everyone; names compare lowercased; a meta for another crawler is ignored.
- `probes-page-facts` — the worker's page job reads the title, the canonical (else the `Link` header's), the word count and the text hash as the served view does (hidden, script and style text left out, whitespace collapsed); the same words give the same hash, other words another; a non-HTML answer is read from its headers only; an invalid job is refused; every answer passes its schema.
- `probes-diff-against-browser` — against the baseline: a redirect only for one agent marks `finalUrl` and `redirects`; robots disallowed for GPTBot only marks `robots`; Googlebot's `noindex` marks `noindex`; a canonical that differs marks `canonical`; content smaller than the baseline beyond the tolerance marks `wordCount`, `bytes` and `text`, within it only `text`; a failed request marks `status` but no content fact; unsettled rows have no diff; the facts follow `PROBE_DIFF_FACTS`.

## Runs (`apps/desktop/src/main/serp/__tests__/probes.test.ts`, with fakes and the real bounded fetcher)
- `probes-are-bounded` — one run makes exactly 6 page requests (one per agent's user agent, `GET`, `page` the tab URL, the caps and kept headers of `PROBE_LIMITS`), at most 2 at once, and asks robots.txt once from main's fetcher; through the real fetcher a public page's redirect to a private address is refused (`private-redirect`), a public name resolving to a private address is never requested (`private-address`), and a private page may be probed.
- `probes-only-on-user-action` — loads, navigations, state reads and watches fetch nothing; a background tab, a tab without a web page and an unknown tab do not run; after `dispose()` nothing runs.
- `probes-one-run-per-tab` — a second `run` while one runs starts nothing; a finished run can be run again.
- `probes-rows-stream` — every row is `pending` at first and filled in as its answer is read, each bumping `version`; the state passes `ProbesStateSchema` throughout; diffs appear once the baseline has settled.
- `probes-stop-keeps-rows` — Stop aborts the requests in flight, keeps finished rows, marks the rest `stopped` and the run `stopped`; a late answer changes nothing.
- `probes-cancel-on-new-document` — a new document, an in-page move to another URL (the same URL with another fragment keeps it), a closed tab and Clear Browsing Data (`cancelAll`) abort the run's requests and reset its state to `idle`; a late answer is dropped.
- `probes-watch-wakes-capped` — `watch` answers at once when newer, on the next change, and on abort; one more than `MAX_PENDING_PROBE_WATCHES` answers the oldest early; `dispose()` answers every waiter.
- `probes-parse-in-worker` — probe jobs run one at a time in one worker; past `parseTimeoutMs` it is terminated and the job is `parse-failed`; a crash fails the job; a full queue refuses at once; after `dispose()` nothing spawns; the worker entry answers `{ id, kind: 'probe', job }` with `{ id, result }`, and its code imports no Electron.

## Router and setup
- `serp-probes-procedures` (`packages/ipc-contract/src/__tests__/serp-router.test.ts`) — `serp.runProbes`, `serp.stopProbes` (mutations, `{ tabId }` → whether it runs / stopped), `serp.probes` (`{ tabId }` → `ProbesState`) and `serp.watchProbes` (`{ tabId, sinceVersion }` → `ProbesState`, a long-poll as `serp.watch`) are `enforceSender`-first with strict inputs, like the other `serp.*` procedures.
- `serp-setup-wires-probes` (`apps/desktop/src/main/serp/__tests__/setup.test.ts`) — the service and the read API expose the probes; a run uses the `checks` lane and main's robots.txt fetcher; a tab's new document, in-page move and close, and Clear Browsing Data, cancel it; `will-quit` disposes the probes and their worker.
