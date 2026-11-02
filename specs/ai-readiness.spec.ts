/**
 * AI readiness (Phase 9 Tasks 6–8; acceptance `ai-readiness.feature.md`; Zod side
 * `ai-readiness.schema.ts`). Task 6 is the static, robots.txt part: which AI crawlers exist, what each
 * is for, what its operator says about robots.txt, and the verdict of the page origin's robots.txt for
 * each one's token (`audit.aiReadiness.bots`, `@app/seo-core`). Task 7 adds the `/llms.txt` check
 * (fetched only with a probe run) and the AI-readiness score (see their sections below).
 *
 * ## The catalogue (`AI_BOTS`)
 * Fourteen robots.txt product tokens, each with:
 * - its operator and **role** (`AI_BOT_ROLES`):
 *   - `ai-search`: crawls so the operator's AI search can find and cite the page;
 *   - `live-fetch`: fetches a page while a user waits, because the user asked;
 *   - `training`: collects pages for model training, or controls whether the operator may train on
 *     what it already crawled;
 * - its **robots.txt stance** (`AI_ROBOTS_STANCES`), from the operator's own documentation:
 *   - `documented`: the operator names robots.txt as the way to allow or block it;
 *   - `may-ignore`: a user-initiated fetch the operator says robots.txt may not govern;
 *   - `control-token`: the token sends no requests of its own; it only tells the operator how it may
 *     use what its other crawlers fetched, and does not change search inclusion;
 *   - `not-documented`: frost found no operator page saying either way;
 * - `probeAgent`: the visibility probe that sends its user agent (`visibility-probes.spec.ts`), or
 *   `null` when frost does not fetch as it (no published user agent, or a control token);
 * - `docsUrl`: the operator's page frost read (`null`: none found).
 *
 * Classic search crawlers (Googlebot, Bingbot) are not in the catalogue: they keep their probe kind
 * `search` and their robots.txt verdicts in the Indexability panel (`ROBOTS_AGENTS`).
 *
 * ## Verdicts (`AI_BOT_VERDICTS`)
 * Each token is judged by the robots.txt the audit already has (`PageContext.robots`, main's cached
 * fetch of the page's origin), with the Indexability panel's parser and matcher (`parseRobotsTxt`,
 * `matchRobots`, RFC 9309: the token's own groups, else `*`), on the page's path. **No request is
 * made for it.** Applebot alone, as Apple documents, follows Googlebot's groups when it has none of
 * its own and Googlebot has some. Which groups decided is the verdict's `via` (`AI_BOT_VIAS`).
 * - `allowed` / `disallowed`: the file's rules say so (no file to obey, `ROBOTS_ALLOW_ALL_OUTCOMES`,
 *   is `allowed`);
 * - `unknown`: the file could not be read (`ROBOTS_UNKNOWN_OUTCOMES`; crawlers then assume
 *   everything is disallowed);
 * - `not-checked`: there is no robots.txt answer yet (still `pending`, or not fetched).
 *
 * A verdict is a fact about the file, not advice: blocking a training crawler is the owner's choice.
 * Nothing here is a rule of `SEO_RULE_SPECS`, and the SEO health score never reads it.
 *
 * ## Assistants (`AI_ASSISTANTS`)
 * The product a user asks, and the tokens that decide what it can read. ChatGPT, Claude, Perplexity
 * and Apple map to their operators' own tokens (`operator`). Copilot (Bingbot) and Google's AI
 * features (Googlebot plus Google-Extended) are frost's model (`frost-model`): their operators do
 * not publish such a mapping.
 *
 * Clean-room: the tokens and user agents are their operators' published values, read on the pages
 * in `docsUrl` (fetched 2026-11-02); the roles' and stances' names, the notes and every other word
 * are frost's own.
 *
 * Plain values, Zod-free (importing only the Zod-free probes spec), so the chrome renderer can import them.
 */
// One way only: this file reads the probes' spec (the agent ids, the `/llms.txt` fetch's numbers);
// `visibility-probes.spec.ts` imports nothing from here (`no-spec-import-cycle`).
import { LLMS_TXT_LIMITS, type ProbeAgentId } from './visibility-probes.spec';

/** What a crawler is for. */
export const AI_BOT_ROLES = ['ai-search', 'live-fetch', 'training'] as const;
export type AiBotRole = (typeof AI_BOT_ROLES)[number];

/** What its operator says about robots.txt. */
export const AI_ROBOTS_STANCES = ['documented', 'may-ignore', 'control-token', 'not-documented'] as const;
export type AiRobotsStance = (typeof AI_ROBOTS_STANCES)[number];

/** The catalogue's ids (its tokens, lowercased), in `AI_BOTS` order. */
export const AI_BOT_IDS = [
  'oai-searchbot',
  'chatgpt-user',
  'gptbot',
  'claude-searchbot',
  'claude-user',
  'claudebot',
  'perplexitybot',
  'perplexity-user',
  'applebot',
  'applebot-extended',
  'google-extended',
  'ccbot',
  'bytespider',
  'meta-externalagent',
] as const;
export type AiBotId = (typeof AI_BOT_IDS)[number];

export interface AiBot {
  readonly id: AiBotId;
  /** The robots.txt product token, as its operator writes it. */
  readonly token: string;
  readonly operator: string;
  readonly role: AiBotRole;
  readonly stance: AiRobotsStance;
  /** The visibility probe sending its user agent; `null`: not probed. */
  readonly probeAgent: ProbeAgentId | null;
  /** The operator's documentation page frost read; `null`: none found. */
  readonly docsUrl: string | null;
  /**
   * With no group of its own, it follows Googlebot's groups before `*` (its operator's documented
   * rule; Applebot only).
   */
  readonly followsGooglebot: boolean;
}

// The operators' pages (fetched 2026-11-02).
const OPENAI_DOCS = 'https://developers.openai.com/api/docs/bots';
const ANTHROPIC_DOCS = 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler';
const PERPLEXITY_DOCS = 'https://docs.perplexity.ai/guides/bots';
const APPLE_DOCS = 'https://support.apple.com/en-us/119829';
const GOOGLE_DOCS = 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers';
const COMMON_CRAWL_DOCS = 'https://commoncrawl.org/ccbot';
const META_DOCS = 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers';

/**
 * The fourteen tokens (`AI_BOT_IDS` order). Stances, from the pages above:
 * - OpenAI: OAI-SearchBot and GPTBot are managed with robots.txt; for ChatGPT-User, "robots.txt rules
 *   may not apply" (user-initiated).
 * - Anthropic: its bots honour robots.txt; the page lists all three tokens.
 * - Perplexity: PerplexityBot is managed with robots.txt; Perplexity-User "generally ignores" it.
 * - Apple: Applebot follows robots.txt (Spotlight, Siri and Safari's suggestions: `ai-search`,
 *   Decision 10); Applebot-Extended "does not crawl webpages" and does not affect search inclusion.
 *   Apple also documents that when no group names Applebot but one names Googlebot, Applebot
 *   follows Googlebot's (`followsGooglebot`); Applebot-Extended, a control token, has no such rule.
 * - Google: Google-Extended has no user agent of its own and does not affect Search inclusion or
 *   ranking.
 * - Common Crawl and Meta name robots.txt as the way to block CCBot and Meta-ExternalAgent (Meta lists
 *   only other crawlers as ones that may bypass it).
 * - ByteDance: no operator page found for Bytespider.
 */
export const AI_BOTS: readonly AiBot[] = [
  { id: 'oai-searchbot', token: 'OAI-SearchBot', operator: 'OpenAI', role: 'ai-search', stance: 'documented', probeAgent: 'oai-searchbot', docsUrl: OPENAI_DOCS, followsGooglebot: false },
  { id: 'chatgpt-user', token: 'ChatGPT-User', operator: 'OpenAI', role: 'live-fetch', stance: 'may-ignore', probeAgent: 'chatgpt-user', docsUrl: OPENAI_DOCS, followsGooglebot: false },
  { id: 'gptbot', token: 'GPTBot', operator: 'OpenAI', role: 'training', stance: 'documented', probeAgent: 'gptbot', docsUrl: OPENAI_DOCS, followsGooglebot: false },
  { id: 'claude-searchbot', token: 'Claude-SearchBot', operator: 'Anthropic', role: 'ai-search', stance: 'documented', probeAgent: null, docsUrl: ANTHROPIC_DOCS, followsGooglebot: false },
  { id: 'claude-user', token: 'Claude-User', operator: 'Anthropic', role: 'live-fetch', stance: 'documented', probeAgent: null, docsUrl: ANTHROPIC_DOCS, followsGooglebot: false },
  { id: 'claudebot', token: 'ClaudeBot', operator: 'Anthropic', role: 'training', stance: 'documented', probeAgent: 'claudebot', docsUrl: ANTHROPIC_DOCS, followsGooglebot: false },
  { id: 'perplexitybot', token: 'PerplexityBot', operator: 'Perplexity', role: 'ai-search', stance: 'documented', probeAgent: 'perplexitybot', docsUrl: PERPLEXITY_DOCS, followsGooglebot: false },
  { id: 'perplexity-user', token: 'Perplexity-User', operator: 'Perplexity', role: 'live-fetch', stance: 'may-ignore', probeAgent: null, docsUrl: PERPLEXITY_DOCS, followsGooglebot: false },
  { id: 'applebot', token: 'Applebot', operator: 'Apple', role: 'ai-search', stance: 'documented', probeAgent: null, docsUrl: APPLE_DOCS, followsGooglebot: true },
  { id: 'applebot-extended', token: 'Applebot-Extended', operator: 'Apple', role: 'training', stance: 'control-token', probeAgent: null, docsUrl: APPLE_DOCS, followsGooglebot: false },
  { id: 'google-extended', token: 'Google-Extended', operator: 'Google', role: 'training', stance: 'control-token', probeAgent: null, docsUrl: GOOGLE_DOCS, followsGooglebot: false },
  { id: 'ccbot', token: 'CCBot', operator: 'Common Crawl', role: 'training', stance: 'documented', probeAgent: null, docsUrl: COMMON_CRAWL_DOCS, followsGooglebot: false },
  { id: 'bytespider', token: 'Bytespider', operator: 'ByteDance', role: 'training', stance: 'not-documented', probeAgent: null, docsUrl: null, followsGooglebot: false },
  { id: 'meta-externalagent', token: 'Meta-ExternalAgent', operator: 'Meta', role: 'training', stance: 'documented', probeAgent: null, docsUrl: META_DOCS, followsGooglebot: false },
];

/** robots.txt's verdict for one token on the page's path (see the top of this file). */
export const AI_BOT_VERDICTS = ['allowed', 'disallowed', 'unknown', 'not-checked'] as const;
export type AiBotVerdictValue = (typeof AI_BOT_VERDICTS)[number];

/**
 * Which groups decided a verdict: the token's own; Googlebot's (Applebot's documented fallback,
 * `followsGooglebot`); or the `*` groups (or none, when the file has no `*` group: allowed).
 */
export const AI_BOT_VIAS = ['own', 'googlebot', '*'] as const;
export type AiBotVia = (typeof AI_BOT_VIAS)[number];

/** Where an assistant's crawler mapping comes from: its operator's documentation, or frost's model. */
export const AI_ASSISTANT_SOURCES = ['operator', 'frost-model'] as const;
export type AiAssistantSource = (typeof AI_ASSISTANT_SOURCES)[number];

export const AI_ASSISTANT_IDS = ['chatgpt', 'claude', 'perplexity', 'copilot', 'google-ai', 'apple'] as const;
export type AiAssistantId = (typeof AI_ASSISTANT_IDS)[number];

export interface AiAssistant {
  readonly id: AiAssistantId;
  readonly label: string;
  /** The robots.txt tokens that decide what it can read (catalogue tokens, or Googlebot / Bingbot). */
  readonly tokens: readonly string[];
  readonly source: AiAssistantSource;
}

/** The assistants (`AI_ASSISTANT_IDS` order). */
export const AI_ASSISTANTS: readonly AiAssistant[] = [
  { id: 'chatgpt', label: 'ChatGPT', tokens: ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot'], source: 'operator' },
  { id: 'claude', label: 'Claude', tokens: ['Claude-SearchBot', 'Claude-User', 'ClaudeBot'], source: 'operator' },
  { id: 'perplexity', label: 'Perplexity', tokens: ['PerplexityBot', 'Perplexity-User'], source: 'operator' },
  { id: 'copilot', label: 'Copilot', tokens: ['Bingbot'], source: 'frost-model' },
  { id: 'google-ai', label: 'Google AI', tokens: ['Googlebot', 'Google-Extended'], source: 'frost-model' },
  { id: 'apple', label: 'Apple', tokens: ['Applebot', 'Applebot-Extended'], source: 'operator' },
];

/** Shown with any statement about what AI crawlers read (Decision 12). */
export const AI_RENDERING_NOTE =
  'frost assumes AI crawlers read the HTML as the server sends it, without running its scripts. That is frost’s model: their operators do not say whether they render JavaScript.' as const;

/** What each stance means for the verdict beside it (frost's own words). */
export const AI_STANCE_NOTES: Readonly<Record<AiRobotsStance, string>> = {
  documented: 'Its operator says it follows robots.txt.',
  'may-ignore': 'It fetches a page because a user asked, and its operator says robots.txt may not apply to it.',
  'control-token': 'It sends no requests of its own: it only tells its operator whether pages it already crawled may be used for AI. Blocking it does not remove the page from search.',
  'not-documented': 'frost found no page from its operator saying whether it follows robots.txt.',
};

// ---- The AI-readiness score (Task 7, Decision 11) -------------------------------------------------

/**
 * The checks, in the order they are shown. seo-core judges each (`aiReadinessChecks`,
 * `ai-readiness/score.ts`) from the page's audit and the tab's probe run only: never from AI engines'
 * answers or citations (Phase 12), and never as a rule of `SEO_RULE_SPECS`, so the SEO health score is
 * untouched. How each is judged (frost's model):
 * - `search-indexable`, from the audit's indexability verdict (AI answers in Google and Bing ground on
 *   their search indexes): `indexable` passes; `canonicalised` warns (the engines index the URL the
 *   canonical names, not this one); `not-indexable` fails; `pending` is not checked.
 * - `ai-search-crawlers`, from robots.txt's verdicts for the `ai-search` tokens: every one allowed
 *   passes, some disallowed warns, every one disallowed fails. A robots.txt not read yet
 *   (`not-checked`) or unreadable (`unknown`) is not checked: frost cannot say what it allows.
 * - `served-content`, from the audit's served-vs-rendered verdict (Decision 12): `independent` passes,
 *   `partly` warns, `heavily` fails; with no comparison (pending, or the served fetch unavailable) it is
 *   not checked. The served fetch used the tab's render profile or frost's user agent, not an AI
 *   crawler's, and frost assumes AI crawlers read served HTML only (`AI_RENDERING_NOTE`).
 * - `agent-reachability`, from the tab's finished probe run for this page: each AI agent
 *   (`PROBE_AGENTS` of kind `ai`) is judged on its own row (`AI_REACH_FACTS`): no answer about the
 *   page (a redirect refused or not followed, unreachable, out of time) fails, as does a final answer
 *   that is not a 2xx HTML page (`http-status`, `not-html`), or a `noindex` it obeys; visible text that
 *   differs from the browser's (the `text` diff fact) warns; otherwise it passes. The check is its
 *   worst agent's. It is not checked without a run that finished (`done`) for this page, when the
 *   browser baseline itself got no HTML page, or when no agent could be judged (frost's own limits:
 *   `busy`, `parse-failed`, `private-address`, which leave that agent out).
 * - `live-fetch-agents`, from the `live-fetch` tokens, as `ai-search-crawlers`; shown with the
 *   `may-ignore` note (their operators say robots.txt may not apply to them).
 * - `training-opt-outs`, from the `training` tokens: allowing training or not is the owner's choice,
 *   never good or bad, so a robots.txt that was read always passes whatever it allows (the check lists
 *   each token's verdict); not checked as above.
 * - `llms-txt`, from the run's `/llms.txt` answer: `ok` passes, `malformed` warns, `missing` and
 *   `not-text` fail; anything else (no run yet, or no answer about the file) is not checked.
 */
export const AI_READINESS_CHECKS = ['search-indexable', 'ai-search-crawlers', 'served-content', 'agent-reachability', 'live-fetch-agents', 'training-opt-outs', 'llms-txt'] as const;
export type AiReadinessCheckId = (typeof AI_READINESS_CHECKS)[number];

/**
 * Each check's weight in the score (frost's own). Weight 0: shown, never scored. Training opt-outs
 * are a legitimate privacy choice, and `llms.txt` is a convention no search engine documents using.
 */
export const AI_READINESS_WEIGHTS: Readonly<Record<AiReadinessCheckId, number>> = {
  'search-indexable': 25,
  'ai-search-crawlers': 30,
  'served-content': 25,
  'agent-reachability': 20,
  'live-fetch-agents': 0,
  'training-opt-outs': 0,
  'llms-txt': 0,
};

/** How a check came out. */
export const AI_CHECK_STATUSES = ['pass', 'warn', 'fail', 'not-checked'] as const;
export type AiCheckStatus = (typeof AI_CHECK_STATUSES)[number];

/** What a judged check counts for. */
export const AI_CHECK_VALUES: Readonly<Record<Exclude<AiCheckStatus, 'not-checked'>, number>> = { pass: 1, warn: 0.5, fail: 0 };

/** The static scored checks: the score is `null` (pending) until all three are checked. */
export const AI_SCORE_REQUIRED_CHECKS = ['search-indexable', 'ai-search-crawlers', 'served-content'] as const satisfies readonly AiReadinessCheckId[];

/** Why an AI agent's probe row is not a clean pass (`agent-reachability`). */
export const AI_REACH_FACTS = ['no-answer', 'http-status', 'not-html', 'noindex', 'text'] as const;
export type AiReachFact = (typeof AI_REACH_FACTS)[number];

/**
 * The score: `round(100 × Σ w·v / Σ w)` over the checked checks of weight above 0 (`v` from
 * `AI_CHECK_VALUES`), `null` until every `AI_SCORE_REQUIRED_CHECKS` is checked; `checked` of `total`
 * weighted checks were counted ("based on 3 of 4" before a probe run).
 */
export interface AiReadinessScore {
  readonly score: number | null;
  readonly checked: number;
  readonly total: number;
}

/** The score of the checks' statuses (a missing one is `not-checked`). Pure. */
export function aiReadinessScore(checks: Readonly<Partial<Record<AiReadinessCheckId, AiCheckStatus>>>): AiReadinessScore {
  const weighted = AI_READINESS_CHECKS.filter((id) => AI_READINESS_WEIGHTS[id] > 0);
  const status = (id: AiReadinessCheckId): AiCheckStatus => checks[id] ?? 'not-checked';
  const counted = weighted.filter((id) => status(id) !== 'not-checked');
  const ready = AI_SCORE_REQUIRED_CHECKS.every((id) => status(id) !== 'not-checked');
  let weights = 0;
  let points = 0;
  for (const id of counted) {
    weights += AI_READINESS_WEIGHTS[id];
    points += AI_READINESS_WEIGHTS[id] * AI_CHECK_VALUES[status(id) as Exclude<AiCheckStatus, 'not-checked'>];
  }
  return { score: ready && weights > 0 ? Math.round((100 * points) / weights) : null, checked: counted.length, total: weighted.length };
}

/** What is said beside the score. */
export const aiScoreBasis = (score: Pick<AiReadinessScore, 'checked' | 'total'>): string => `Based on ${score.checked} of ${score.total} checks`;

// ---- llms.txt (Task 7, Decision 13) ---------------------------------------------------------------

/**
 * `/llms.txt`, as llmstxt.org proposes it (read 2026-11-02), in frost's words: a Markdown file at a
 * site's root that gives language models a short guide to the site. It opens with an H1 naming the
 * site or project, the one part it requires. A blockquote summary may follow, then paragraphs or lists
 * without headings, then sections under H2 headings, each a list of links written `[name](url)`, each
 * optionally followed by `:` and a note.
 *
 * frost asks for `<page origin>/llms.txt` only during a probe run (never on a page load; subpath files
 * are not checked), once per origin while its answer is cached, with frost's own user agent, through
 * the probes' lane (`LLMS_TXT_LIMITS` in `visibility-probes.spec.ts`). The body is parsed in the probes'
 * SERP worker (an `llms-txt` job, `ai-readiness.schema.ts`) by seo-core's `parseLlmsTxt`, bounded by
 * `LLMS_TXT_PARSE_LIMITS`. Its text is untrusted: only counts, the findings and a capped title leave
 * the worker, and they are shown as inert text.
 *
 * How the fetch ended (`LLMS_TXT_OUTCOMES`):
 * - `pending`: not answered yet; `stopped`: the run was stopped first;
 * - `ok`: a 2xx text answer with none of `LLMS_TXT_FINDINGS`; `malformed`: a 2xx text answer with some;
 * - `missing`: 404 or 410; `http-status`: any other final status that is not 2xx;
 * - `not-text`: a 2xx answer of a media type other than `LLMS_TXT_TEXT_TYPES` (a site answering every
 *   path with its HTML page, say); an answer without a type is read as text;
 * - `parse-failed`: the body could not be read in time;
 * - the bounded fetcher's own endings (`fetcher.spec.ts`): `private-address`, `private-redirect`,
 *   `too-many-redirects`, `bad-redirect`, `no-location`, `unreachable`, `timeout`, `busy`.
 */
export const LLMS_TXT_OUTCOMES = [
  'pending',
  'ok',
  'malformed',
  'missing',
  'not-text',
  'http-status',
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
export type LlmsTxtOutcome = (typeof LLMS_TXT_OUTCOMES)[number];

/** The answers kept per origin (`LLMS_TXT_LIMITS.cacheTtlMs`): the ones about the file itself. Others are asked again next run. */
export const LLMS_TXT_CACHED_OUTCOMES = ['ok', 'malformed', 'missing', 'not-text'] as const satisfies readonly LlmsTxtOutcome[];

/** What each outcome says (frost's own wording). */
export const LLMS_TXT_OUTCOME_MESSAGES: Readonly<Record<LlmsTxtOutcome, string>> = {
  pending: 'Waiting for the answer…',
  ok: 'Found, and it follows the proposal’s format.',
  malformed: 'Found, but it does not follow the proposal’s format.',
  missing: 'The site has no /llms.txt.',
  'not-text': 'The site answered /llms.txt with something other than a text file.',
  'http-status': 'The site answered /llms.txt with an error or another non-success status.',
  'parse-failed': 'frost could not read this file in time.',
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

/** Where a file departs from the proposal's format. */
export const LLMS_TXT_FINDINGS = ['no-h1', 'h1-not-first', 'no-links', 'links-not-markdown'] as const;
export type LlmsTxtFinding = (typeof LLMS_TXT_FINDINGS)[number];

export const LLMS_TXT_FINDING_MESSAGES: Readonly<Record<LlmsTxtFinding, string>> = {
  'no-h1': 'It has no H1 heading (“# Name”), the one part the proposal requires.',
  'h1-not-first': 'Its H1 heading is not the first thing in the file.',
  'no-links': 'It lists no links under H2 sections.',
  'links-not-markdown': 'Some list items under its H2 sections are not links written [name](url).',
};

/** The media types read as an `llms.txt` (an answer without one is read too). */
export const LLMS_TXT_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown'] as const;

/** The `Accept` header of the `/llms.txt` request. */
export const LLMS_TXT_ACCEPT = 'text/markdown, text/plain;q=0.9, */*;q=0.1' as const;

/**
 * The worker's parse: at most `maxChars` characters (the body is at most `LLMS_TXT_LIMITS.maxBytes`)
 * and `maxLines` lines are read; the title keeps at most `maxTitleChars` characters.
 */
export const LLMS_TXT_PARSE_LIMITS = {
  maxChars: LLMS_TXT_LIMITS.maxBytes,
  maxLines: 20_000,
  maxTitleChars: 200,
} as const;

/** Shown with the `llms-txt` check (frost's own words). */
export const LLMS_TXT_NOTE =
  'llms.txt is a proposal (llmstxt.org) for a short guide to a site written for language models. No search engine or AI assistant documents using it, so frost shows it but never scores it.' as const;
