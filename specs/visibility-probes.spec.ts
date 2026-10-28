/**
 * Indexability and AI-readiness probes (Phase 3 Task 5; Zod side `visibility-probes.schema.ts`;
 * acceptance `visibility-probes.feature.md`; review focus `probes-are-bounded`). "Run visibility
 * probes" fetches the active tab's current URL once as each agent in `PROBE_AGENTS` (frost's own
 * browser user agent first, the baseline, then search and AI crawlers) and shows, per agent, what
 * that agent would be told: the HTTP status and redirects, robots.txt's verdict for its token, the
 * meta robots and `X-Robots-Tag` directives it obeys (general and its own), the effective `noindex`,
 * the canonical, the size, the word count and a hash of the visible text, each marked where it
 * differs from the browser's answer.
 *
 * ## How a run goes
 * - **Only on the user's action.** A run starts only from `serp.runProbes` (the Visibility panel or
 *   the palette), for the **active** tab showing an `http(s)` page; nothing is fetched otherwise
 *   (Phase 3 Global Constraints, no background scraping). Phase 5's agent tools reach it only
 *   through `SerpReadApi.runProbes`, behind their approval model.
 * - **Bounded** (`PROBE_LIMITS`): one GET per agent (`PROBE_AGENTS.length` ≤ `maxFetches`), never
 *   retried; at most `maxConcurrent` at once; each through the bounded fetcher's `checks` lane
 *   (`fetcher.spec.ts`), `page` the tab's URL (so a private host is requested only when the page
 *   itself is on one, `private-address.spec.ts`), with `maxBytes`, `timeoutMs` and `maxRedirects`.
 *   robots.txt is not one of them: it comes from main's cached robots.txt fetcher (the `audit`
 *   lane), once per run. One run per tab: asking again while one runs changes nothing.
 * - **Page data is parsed off main's thread.** robots.txt (`@app/seo-core` `parseRobotsTxt`,
 *   `matchRobots` with each agent's token), the headers (`parseXRobotsTag`, `parseLinkHeader`) and
 *   each body (`parseServedHtml`, as the JavaScript panel's served view, and a bounded `parse5` walk
 *   for the visible text and every agent's meta names) are read in the SERP worker
 *   (`serp-analysis.cjs`, a `probe` job), validated there, with a hard deadline.
 * - **Rows stream.** Every agent's row is `pending` from the start and is filled in as its fetch and
 *   parse finish; each change bumps the state's `version` and wakes `serp.watchProbes`.
 * - **Stop keeps what was found** (`stopped`; rows not yet finished say `stopped`). A new document
 *   in the tab (a reload too), an in-page move to another URL (fragment aside), a closed tab, Clear
 *   Browsing Data or the app quitting cancel the run: its requests are aborted and its state goes
 *   (`idle`).
 *
 * ## Reading an agent's answer
 * - **robots.txt** (RFC 9309 through `matchRobots`): the tab URL's path against the groups for the
 *   agent's `robotsToken` (its own, else `*`); the browser baseline uses `*`. A file that could not
 *   be read is `unknown` for the outcomes crawlers treat as "assume disallowed"
 *   (`ROBOTS_UNKNOWN_OUTCOMES`) and `allowed` when there is none to obey
 *   (`ROBOTS_ALLOW_ALL_OUTCOMES`). The verdict is reported, not obeyed: frost is not the crawler, and
 *   the page is the one the user is already looking at (`PROBE_ROBOTS_NOTE`).
 * - **Meta robots**: `<meta name>` values compared lowercased; `general` from `robots`, `agent` from
 *   the agent's own names (`metaNames` without `robots`), merged across tags.
 * - **`X-Robots-Tag`**: the fetcher joins repeated headers with `, `, so the joined value is read as
 *   one list: a `name:` prefix (unless it is a valued directive such as `max-snippet:`) scopes the
 *   directives after it, until the next prefix; directives before any prefix are general. Scoped to
 *   one of the agent's `metaNames` (case-insensitive): `agent`; to another crawler: ignored.
 * - **Effective `noindex` / `nofollow`**: any of the four lists holding it (or `none`). Only for an
 *   answer with a response; `null` otherwise.
 * - **Canonical**: the served HTML's first `rel=canonical` (resolved), else a `Link` header's.
 * - **Text hash**: sha256 (hex) of the body's visible text as the served word count reads it (the
 *   same subtrees left out, the same node and character budgets), whitespace collapsed to single
 *   spaces and trimmed. Two answers with the same hash showed the same words in the same order.
 *
 * ## Against the baseline (`PROBE_DIFF_FACTS`)
 * Once the browser row and an agent's row have both settled (anything but `pending` and `stopped`),
 * the agent's diff lists the facts that differ: `status`, `finalUrl`, `redirects` and `robots`
 * (the verdict) always; `noindex` when both had a response; `canonical`, `wordCount` (a share beyond
 * `PROBE_DIFF_TOLERANCE.wordShare` of the baseline's), `bytes` (beyond `byteShare`) and `text` (the
 * hashes) when both bodies were read (`ok`).
 *
 * ## Honesty
 * A user-agent string is all that changes (`PROBE_HONESTY_NOTE`); every surface says so, with
 * `FETCH_DISCLOSURE` (`fetcher.spec.ts`).
 *
 * Clean-room: the agents' user-agent strings and robots.txt tokens are the ones their operators
 * publish; the limits, tolerances, labels and wording are frost's own.
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

/** The agent every other row is compared with. */
export const PROBE_BASELINE: ProbeAgentId = 'browser';

export interface ProbeAgent {
  readonly id: ProbeAgentId;
  readonly label: string;
  readonly kind: ProbeAgentKind;
  /**
   * The `User-Agent` sent: `null` for frost's own (the browse session's). Googlebot's and Bingbot's
   * are the render profiles' strings (`USER_AGENT_TEMPLATES`), whose `{version}` is the evergreen
   * Chromium version their operators fill in (`probeUserAgent`); the AI crawlers' are their
   * operators' published strings, verbatim.
   */
  readonly userAgent: string | null;
  /** The robots.txt product token it obeys (`*`: the baseline, which has none of its own). */
  readonly robotsToken: string;
  /** The `<meta name>` values (and `X-Robots-Tag` scopes) it obeys, lowercase; `robots` is everyone's. */
  readonly metaNames: readonly string[];
}

/** The probed agents (`PROBE_AGENT_IDS` order). */
export const PROBE_AGENTS: readonly ProbeAgent[] = [
  { id: 'browser', label: 'Browser (frost)', kind: 'browser', userAgent: null, robotsToken: '*', metaNames: ['robots'] },
  { id: 'googlebot', label: 'Googlebot smartphone', kind: 'search', userAgent: USER_AGENT_TEMPLATES['googlebot-smartphone'], robotsToken: 'Googlebot', metaNames: ['robots', 'googlebot'] },
  { id: 'bingbot', label: 'Bingbot', kind: 'search', userAgent: USER_AGENT_TEMPLATES.bingbot, robotsToken: 'bingbot', metaNames: ['robots', 'bingbot'] },
  { id: 'gptbot', label: 'GPTBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot', robotsToken: 'GPTBot', metaNames: ['robots', 'gptbot'] },
  { id: 'claudebot', label: 'ClaudeBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', robotsToken: 'ClaudeBot', metaNames: ['robots', 'claudebot'] },
  { id: 'perplexitybot', label: 'PerplexityBot', kind: 'ai', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', robotsToken: 'PerplexityBot', metaNames: ['robots', 'perplexitybot'] },
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

/**
 * How a run is bounded (review focus `probes-are-bounded`):
 * - `maxFetches`: page requests per run (one per agent; robots.txt comes from main's cached fetcher
 *   and is not counted);
 * - `maxConcurrent`: requests in flight at once;
 * - `maxBytes`, `timeoutMs`, `maxRedirects`: each request's caps (`timeoutMs` counts the fetcher's
 *   queue, every hop and the body), as the served-HTML fetch's;
 * - `maxHeaderChars`: characters kept of each kept header (`x-robots-tag`, `content-type`,
 *   `location`, `link`);
 * - `parseTimeoutMs`: one probe job's deadline in the SERP worker (two bounded parses of one body),
 *   after which the worker is terminated (`parse-failed`);
 * - `maxQueuedJobs`: probe jobs waiting for the worker (one more is `parse-failed` at once);
 * - `maxRunsPerTab`: runs at once per tab.
 */
export const PROBE_LIMITS = {
  maxFetches: 6,
  maxConcurrent: 2,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 5,
  maxHeaderChars: 2_048,
  parseTimeoutMs: 4_000,
  maxQueuedJobs: 8,
  maxRunsPerTab: 1,
} as const;

/** The response headers kept for each probe (`BoundedFetchRequest.keepHeaders`). */
export const PROBE_KEEP_HEADERS = ['x-robots-tag', 'content-type', 'location', 'link'] as const;

/**
 * How far a row's word count or byte size may be from the baseline's before it is marked
 * different: `|row − baseline| / max(baseline, 1)` above the share.
 */
export const PROBE_DIFF_TOLERANCE = {
  wordShare: 0.1,
  byteShare: 0.2,
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

/** What every surface showing probes says, beside `FETCH_DISCLOSURE` (`PROBE_DISCLOSURE` holds both). */
export const PROBE_HONESTY_NOTE =
  'Only the user-agent string changes. These requests come from your computer and network, not the crawler’s, the page is not rendered the way the crawler renders it, and nothing proves the request is the real bot. Sites that verify bots may answer the real crawler differently.' as const;

/** Why a disallowed agent's row still has an answer. */
export const PROBE_ROBOTS_NOTE = 'robots.txt is reported, not obeyed: frost asks once for the page you are viewing, to show what each agent would be told.' as const;

/** The honesty note and the fetch disclosure, as shown together. */
export const PROBE_DISCLOSURE = `${PROBE_HONESTY_NOTE} ${FETCH_DISCLOSURE}` as const;
