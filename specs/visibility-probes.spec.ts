/**
 * Indexability and AI-readiness probes (Phase 3 Task 5; Zod side `visibility-probes.schema.ts`;
 * acceptance `visibility-probes.feature.md`; review focus `probes-are-bounded`). "Run visibility
 * probes" fetches the active tab's current URL once as each agent in `PROBE_AGENTS` (frost's own
 * browser user agent first, the baseline, then search and AI crawlers) and shows, per agent, what
 * that agent would be told: the HTTP status and redirects, robots.txt's verdict for its token, the
 * meta robots and `X-Robots-Tag` directives it obeys (general and its own), the effective `noindex`,
 * the canonical (and any conflict), the size, the word count and the visible text, each marked where
 * it differs from the browser's answer.
 *
 * ## How a run goes
 * - **Only on the user's action.** A run starts only from `serp.runProbes` (the Visibility panel or
 *   the palette), for the **active** tab showing an `http(s)` page; nothing is fetched otherwise
 *   (Phase 3 Global Constraints, no background scraping). Phase 5's agent tools reach it only
 *   through `SerpReadApi.runProbes`, behind their approval model.
 * - **Bounded** (`PROBE_LIMITS`): one fetcher call per agent (`PROBE_AGENTS.length` ≤
 *   `maxFetches`), never retried, each following at most `maxRedirects` redirects one hop at a time,
 *   so at most `maxRequests` HTTP requests to the site in all; at most `maxConcurrent` calls at once;
 *   `page` the tab's URL (so a private host is requested only when the page itself is on one,
 *   `private-address.spec.ts`), with `maxBytes` and `timeoutMs`. One run per tab: asking again while
 *   one runs changes nothing.
 * - **Their own lane.** The calls go through the SERP lane (`SERP_FETCHER_LIMITS`,
 *   `serp-service.spec.ts`): a bounded fetcher of the SERP's own over main's hop and resolver, so
 *   every rule of `fetcher.spec.ts` holds, with the `checks` lane's per-origin limits and queues of its
 *   own (`fetcher.spec.ts`, Lanes). A link check holding both of the `checks` lane's slots on the site
 *   for minutes never makes a probe wait, and time out, in its queue.
 * - **robots.txt** is not one of the calls: it comes from main's cached robots.txt fetcher (the
 *   `audit` lane), once per origin judged (the tab's, and any other origin an agent was redirected
 *   to; so at most `maxFetches` files a run), fetched with frost's own user agent and possibly cached
 *   up to `ROBOTS_FETCH_LIMITS.cacheTtlMs` (`PROBE_ROBOTS_SERVED_NOTE`).
 * - **Page data is parsed off main's thread.** robots.txt (`@app/seo-core` `parseRobotsTxt`,
 *   `matchRobots` with each agent's token), the headers (`parseXRobotsTag`, `parseLinkHeader`) and
 *   each body (`parseServedHtml`, as the JavaScript panel's served view, and a bounded `parse5` walk
 *   for the visible text and every agent's meta names) are read in a SERP worker of the probes' own
 *   (`serp-analysis.cjs`, `probe` jobs), validated there, with a hard deadline. A stopped or cancelled
 *   run's jobs are dropped from its queue, and one still running is ended.
 * - **Rows stream.** Every agent's row is `pending` from the start and is filled in as its fetch and
 *   parse finish; each change bumps the state's `version` and wakes `serp.watchProbes`.
 * - **Stop keeps what was found** (`stopped`; rows not yet finished say `stopped`). A new document
 *   in the tab (a reload too), an in-page move to another URL (fragment aside), a closed tab, Clear
 *   Browsing Data or the app quitting cancel the run: its requests are aborted and its state goes
 *   (`idle`).
 *
 * ## Reading an agent's answer
 * - **robots.txt** (RFC 9309 through `matchRobots`): the URL the agent ended on (`finalUrl`; the tab's
 *   URL when it got no answer), its path against the groups of that origin's robots.txt for the
 *   agent's `robotsToken` (its own, else `*`); the browser baseline uses `*`. An origin on a private
 *   host while the page is not is never asked (`unknown`). A file that could not be read is `unknown`
 *   for the outcomes crawlers treat as "assume disallowed" (`ROBOTS_UNKNOWN_OUTCOMES`) and `allowed`
 *   when there is none to obey (`ROBOTS_ALLOW_ALL_OUTCOMES`). The verdict is reported, not obeyed
 *   (`PROBE_DISCLOSURE`).
 * - **Meta robots**: `<meta name>` values compared lowercased; `general` from `robots`, `agent` from
 *   the agent's own names (`metaNames` without `robots`), merged across tags.
 * - **`X-Robots-Tag`**: each header value on its own (the fetcher keeps repeated values apart,
 *   `BoundedFetchRequest.separateHeaders`); within a value, a `name:` prefix (unless it is a valued
 *   directive such as `max-snippet:`) scopes the directives after it, until the next prefix, and
 *   directives before any prefix are general. Scoped to one of the agent's `metaNames`
 *   (case-insensitive): `agent`; to another crawler: ignored.
 * - **The AI crawlers' directives are frost's model.** Their operators document robots.txt tokens,
 *   not meta robots or `X-Robots-Tag` names; frost applies `robots` and the crawler's own name to them
 *   as search crawlers do (`ProbeAgent.directives`, `PROBE_MODELLED_DIRECTIVES_NOTE`).
 * - **Effective `noindex` / `nofollow`**: any of the four lists holding it (or `none`). Only for an
 *   answer with a response; `null` otherwise.
 * - **Canonical**: the served HTML's first `rel=canonical` (resolved), else a `Link` header's (for any
 *   answer, HTML or not). Conflicts are reported, not hidden (`PROBE_CANONICAL_CONFLICTS`): several
 *   different HTML canonicals, or an HTML one and a header one that differ.
 * - **Visible text**: the body's text as the served word count reads it (the same subtrees left out,
 *   the same node and character budgets), whitespace collapsed to single spaces and trimmed; its
 *   sha256 (hex, exact identity) and a MinHash signature of its word shingles
 *   (`PROBE_TEXT_SIMILARITY`). `textTruncated` / `partial` say the text read hit its budget, or the
 *   parse stopped at a cap.
 *
 * ## Against the baseline (`PROBE_DIFF_FACTS`)
 * Once the browser row and an agent's row have both settled (anything but `pending` and `stopped`),
 * the agent's diff lists the facts that differ:
 * - `status` and `robots` (the verdict) always; `finalUrl` when both have one; `redirects` when the
 *   hops differ (each hop's URL and status, in order);
 * - `noindex` when both had a response; `canonical` when both bodies were read or both have one;
 * - when both bodies were read (`ok`): `wordCount` (a share beyond `PROBE_DIFF_TOLERANCE.wordShare` of
 *   the baseline's), `bytes` (beyond `byteShare`) and `text` (an estimated Jaccard similarity of the
 *   shingles below `PROBE_TEXT_SIMILARITY.minSimilarity`, `textSimilarity`).
 *
 * `contentTruncated` says either body or text was cut (`truncated`, `textTruncated`, `partial`): the
 * content facts were then compared on part of the page, and every surface says so
 * (`PROBE_TRUNCATED_NOTE`).
 *
 * ## Honesty
 * A user-agent string is all that changes; the requests, their count, the robots.txt policy and the
 * risk of tripping a bot firewall are all in `PROBE_DISCLOSURE`, which every surface shows (it
 * includes `FETCH_DISCLOSURE`, `fetcher.spec.ts`).
 *
 * Clean-room: the agents' robots.txt tokens are the ones their operators publish, and the user-agent
 * strings are published or observed (see `PROBE_AGENTS`); the limits, tolerances, labels and wording
 * are frost's own.
 *
 * Plain values and types, Zod-free, so the chrome renderer can import them.
 */
import { FETCH_DISCLOSURE } from './fetcher.spec';
import { normalChromeVersion, USER_AGENT_TEMPLATES } from './render-profile.spec';

/** The agents, in the order they are probed and shown (the baseline first). */
export const PROBE_AGENT_IDS = ['browser', 'googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot'] as const;
export type ProbeAgentId = (typeof PROBE_AGENT_IDS)[number];

/** What an agent is: frost's own browser (the baseline), a search crawler, or an AI crawler. */
export const PROBE_AGENT_KINDS = ['browser', 'search', 'ai'] as const;
export type ProbeAgentKind = (typeof PROBE_AGENT_KINDS)[number];

/**
 * Where an agent's meta robots / `X-Robots-Tag` handling comes from: `documented` by its operator
 * (search crawlers; the browser baseline obeys `robots` as frost's reference), or `frost-model`
 * (the AI crawlers, whose operators document robots.txt only).
 */
export const PROBE_DIRECTIVE_SOURCES = ['documented', 'frost-model'] as const;
export type ProbeDirectiveSource = (typeof PROBE_DIRECTIVE_SOURCES)[number];

/** The agent every other row is compared with. */
export const PROBE_BASELINE: ProbeAgentId = 'browser';

export interface ProbeAgent {
  readonly id: ProbeAgentId;
  readonly label: string;
  readonly kind: ProbeAgentKind;
  /**
   * The `User-Agent` sent: `null` for frost's own (the browse session's). Googlebot's and Bingbot's
   * are the render profiles' strings (`USER_AGENT_TEMPLATES`), whose `{version}` is the evergreen
   * Chromium version their operators fill in (`probeUserAgent`). GPTBot's and PerplexityBot's are
   * their operators' published strings; ClaudeBot's is the string as observed in server logs (its
   * operator publishes the robots.txt token, not the full user agent).
   */
  readonly userAgent: string | null;
  /** The robots.txt product token it obeys (`*`: the baseline, which has none of its own). */
  readonly robotsToken: string;
  /** The `<meta name>` values (and `X-Robots-Tag` scopes) frost applies to it, lowercase; `robots` is everyone's. */
  readonly metaNames: readonly string[];
  /** Whether that meta / header handling is its operator's documented behaviour or frost's model. */
  readonly directives: ProbeDirectiveSource;
}

/** The probed agents (`PROBE_AGENT_IDS` order). */
export const PROBE_AGENTS: readonly ProbeAgent[] = [
  { id: 'browser', label: 'Browser (frost)', kind: 'browser', userAgent: null, robotsToken: '*', metaNames: ['robots'], directives: 'documented' },
  { id: 'googlebot', label: 'Googlebot smartphone', kind: 'search', userAgent: USER_AGENT_TEMPLATES['googlebot-smartphone'], robotsToken: 'Googlebot', metaNames: ['robots', 'googlebot'], directives: 'documented' },
  { id: 'bingbot', label: 'Bingbot', kind: 'search', userAgent: USER_AGENT_TEMPLATES.bingbot, robotsToken: 'bingbot', metaNames: ['robots', 'bingbot'], directives: 'documented' },
  { id: 'gptbot', label: 'GPTBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot', robotsToken: 'GPTBot', metaNames: ['robots', 'gptbot'], directives: 'frost-model' },
  // As observed, not operator-published (see `userAgent`).
  { id: 'claudebot', label: 'ClaudeBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', robotsToken: 'ClaudeBot', metaNames: ['robots', 'claudebot'], directives: 'frost-model' },
  { id: 'perplexitybot', label: 'PerplexityBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', robotsToken: 'PerplexityBot', metaNames: ['robots', 'perplexitybot'], directives: 'frost-model' },
];

/** The agent `id` names. */
export function probeAgent(id: ProbeAgentId): ProbeAgent {
  return PROBE_AGENTS.find((agent) => agent.id === id)!;
}

/** The `User-Agent` an agent sends (`null`: frost's own), its `{version}` / `{major}` the app's Chromium (`normalChromeVersion`). */
export function probeUserAgent(agent: ProbeAgent, chromeVersion: string): string | null {
  if (agent.userAgent === null) return null;
  const version = normalChromeVersion(chromeVersion);
  return agent.userAgent.replaceAll('{version}', version).replaceAll('{major}', version.split('.')[0]!);
}

/** Probe fetcher calls per run, and redirects each may follow. */
const MAX_FETCHES = 6;
const MAX_REDIRECTS = 3;

/**
 * How a run is bounded (review focus `probes-are-bounded`):
 * - `maxFetches`: fetcher calls per run (one per agent, never retried);
 * - `maxRedirects`: redirects each call follows (one request per hop), so
 * - `maxRequests`: HTTP requests to the site per run at most, `maxFetches × (1 + maxRedirects)`
 *   (robots.txt aside: main's cached fetcher, at most one per origin judged);
 * - `maxConcurrent`: calls in flight at once;
 * - `maxBytes`, `timeoutMs`: each call's caps (`timeoutMs` counts the lane's queue, every hop and the
 *   body), as the served-HTML fetch's;
 * - `maxHeaderChars`: characters kept of each kept header (`PROBE_KEEP_HEADERS`);
 * - `parseTimeoutMs`: one probe job's deadline in the probes' SERP worker (two bounded parses of one
 *   body), after which the worker is terminated (`parse-failed`);
 * - `maxQueuedJobs`: probe jobs waiting for the worker (one more is `parse-failed` at once);
 * - `maxRunsPerTab`: runs at once per tab.
 */
export const PROBE_LIMITS = {
  maxFetches: MAX_FETCHES,
  maxRedirects: MAX_REDIRECTS,
  maxRequests: MAX_FETCHES * (1 + MAX_REDIRECTS),
  maxConcurrent: 2,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  maxHeaderChars: 2_048,
  parseTimeoutMs: 4_000,
  maxQueuedJobs: 16,
  maxRunsPerTab: 1,
} as const;

/** The response headers kept for each probe (`BoundedFetchRequest.keepHeaders`). */
export const PROBE_KEEP_HEADERS = ['x-robots-tag', 'content-type', 'location', 'link'] as const;
/** The kept headers whose repeated values stay apart (`BoundedFetchRequest.separateHeaders`). */
export const PROBE_SEPARATE_HEADERS = ['x-robots-tag'] as const;

/**
 * How far a row's word count or byte size may be from the baseline's before it is marked
 * different: `|row − baseline| / max(baseline, 1)` above the share.
 */
export const PROBE_DIFF_TOLERANCE = {
  wordShare: 0.1,
  byteShare: 0.2,
} as const;

/**
 * The visible text's similarity: the text's words (lowercased, as the word count segments them)
 * in shingles of `shingleWords` consecutive words (a text with fewer words is one shingle), each
 * hashed with `signatureSize` fixed seeds; the signature keeps each seed's minimum. The estimated
 * Jaccard similarity of two texts is the share of equal positions; below `minSimilarity` the `text`
 * fact differs. An empty text has no signature (two empty texts are alike; one empty, one not,
 * differ).
 */
export const PROBE_TEXT_SIMILARITY = {
  signatureSize: 64,
  shingleWords: 3,
  minSimilarity: 0.8,
} as const;

/** `serp.watchProbes` long-polls waiting at most (one more answers the oldest early). */
export const MAX_PENDING_PROBE_WATCHES = 8;

/** Where a tab's run stands. */
export const PROBE_STATUSES = ['idle', 'running', 'done', 'stopped'] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export const PROBE_STATUS_LABELS: Readonly<Record<ProbeStatus, string>> = {
  idle: 'Not run',
  running: 'Probing…',
  done: 'Done',
  stopped: 'Stopped',
};

/**
 * How one agent's probe ended:
 * - `pending`: not finished yet; `stopped`: the run was stopped first;
 * - `ok`: a 2xx HTML answer, read;
 * - `http-status`: a final answer that is not 2xx (its status and headers read, no body);
 * - `not-html`: a 2xx answer of another media type (headers read, no body);
 * - `parse-failed`: the body could not be read in time;
 * - the bounded fetcher's own endings (`fetcher.spec.ts`): `private-address`, `private-redirect`,
 *   `too-many-redirects`, `bad-redirect`, `no-location`, `unreachable`, `timeout`, `busy`.
 */
export const PROBE_OUTCOMES = [
  'pending',
  'ok',
  'http-status',
  'not-html',
  'parse-failed',
  'private-address',
  'private-redirect',
  'too-many-redirects',
  'bad-redirect',
  'no-location',
  'unreachable',
  'timeout',
  'busy',
  'stopped',
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** The outcomes of a row that is no longer waiting (diffs are drawn only between these, `stopped` aside). */
export const PROBE_SETTLED_OUTCOMES = PROBE_OUTCOMES.filter((outcome) => outcome !== 'pending' && outcome !== 'stopped');

/** What each outcome says (frost's own wording). */
export const PROBE_OUTCOME_MESSAGES: Readonly<Record<ProbeOutcome, string>> = {
  pending: 'Waiting for the answer…',
  ok: 'Answered with an HTML page.',
  'http-status': 'Answered with an error or another non-success status.',
  'not-html': 'Answered with something other than an HTML page.',
  'parse-failed': 'frost could not read this answer in time.',
  'private-address': 'Not requested: the address is on a private network and this page is not.',
  'private-redirect': 'Stopped: a redirect led to a private network address.',
  'too-many-redirects': 'Stopped: too many redirects.',
  'bad-redirect': 'Stopped: a redirect led to an address that is not a web page.',
  'no-location': 'Stopped: a redirect did not say where to go.',
  unreachable: 'The site could not be reached.',
  timeout: 'The site took too long to answer.',
  busy: 'Not requested: too many requests to this site are waiting.',
  stopped: 'Not finished: the run was stopped.',
};

/** robots.txt's verdict for an agent. */
export const PROBE_ROBOTS_VERDICTS = ['allowed', 'disallowed', 'unknown'] as const;
export type ProbeRobotsVerdict = (typeof PROBE_ROBOTS_VERDICTS)[number];

export const PROBE_ROBOTS_VERDICT_LABELS: Readonly<Record<ProbeRobotsVerdict, string>> = {
  allowed: 'Allowed',
  disallowed: 'Disallowed',
  unknown: 'Unknown (robots.txt could not be read)',
};

/** Shown beside each robots.txt the run read (with when it was read). */
export const PROBE_ROBOTS_SERVED_NOTE = 'As served to frost: fetched with frost’s own user agent, and possibly a cached copy up to 10 minutes old.' as const;

/** Canonical conflicts a row may report. */
export const PROBE_CANONICAL_CONFLICTS = ['several-html', 'html-vs-header'] as const;
export type ProbeCanonicalConflict = (typeof PROBE_CANONICAL_CONFLICTS)[number];

export const PROBE_CANONICAL_CONFLICT_MESSAGES: Readonly<Record<ProbeCanonicalConflict, string>> = {
  'several-html': 'The HTML names more than one canonical URL.',
  'html-vs-header': 'The HTML and the Link header name different canonical URLs.',
};

/** The facts a row is compared on, in the order they are shown. */
export const PROBE_DIFF_FACTS = ['status', 'finalUrl', 'redirects', 'robots', 'noindex', 'canonical', 'wordCount', 'bytes', 'text'] as const;
export type ProbeDiffFact = (typeof PROBE_DIFF_FACTS)[number];

export const PROBE_DIFF_FACT_LABELS: Readonly<Record<ProbeDiffFact, string>> = {
  status: 'HTTP status',
  finalUrl: 'Final URL',
  redirects: 'Redirects',
  robots: 'robots.txt',
  noindex: 'noindex',
  canonical: 'Canonical',
  wordCount: 'Word count',
  bytes: 'Size',
  text: 'Visible text',
};

/** Shown with a diff whose content facts were compared on cut text (`ProbeDiff.contentTruncated`). */
export const PROBE_TRUNCATED_NOTE = 'Compared on part of the page only: an answer was cut at frost’s size or parsing limits.' as const;

/** Shown with the AI crawlers' meta robots and `X-Robots-Tag` facts (`directives: 'frost-model'`). */
export const PROBE_MODELLED_DIRECTIVES_NOTE =
  'The AI crawlers’ operators document only their robots.txt tokens. Their meta robots and X-Robots-Tag rows are frost’s model: frost applies “robots” and the crawler’s own name to them as search crawlers do, but the operators do not say they obey these.' as const;

/** What every surface showing probes says (the request count follows `PROBE_LIMITS`). */
export const PROBE_DISCLOSURE =
  `Only the user-agent string changes. These requests come from your computer and network, not the crawler’s, the page is not rendered the way the crawler renders it, and nothing proves the request is the real bot, so sites that verify bots may answer the real crawler differently. A run makes at most ${MAX_FETCHES} requests to the site, one per agent, plus up to ${MAX_REDIRECTS} redirects each, and reads robots.txt from frost’s cache. robots.txt is reported, not obeyed: frost asks once for the page you are viewing, to show what each agent would be told. Sending crawler user agents from an address that is not the crawler’s can trip a site’s bot protection and get your address challenged or blocked for a while. ${FETCH_DISCLOSURE}` as const;
