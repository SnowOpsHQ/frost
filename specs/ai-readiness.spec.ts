/**
 * AI readiness (Phase 9 Tasks 6–8; acceptance `ai-readiness.feature.md`). Task 6 is the static,
 * robots.txt part: which AI crawlers exist, what each is for, what its operator says about robots.txt,
 * and the verdict of the page origin's robots.txt for each one's token (`audit.aiReadiness.bots`,
 * `@app/seo-core`).
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
 * made for it.**
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
 * Plain values with type-only imports, Zod-free, so the chrome renderer can import them.
 */
import type { ProbeAgentId } from './visibility-probes.spec';

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
 *   Apple also says Applebot follows Googlebot's rules when no group names Applebot; frost judges
 *   every token as RFC 9309 does (its own groups, else `*`), so that case is not modelled.
 * - Google: Google-Extended has no user agent of its own and does not affect Search inclusion or
 *   ranking.
 * - Common Crawl and Meta name robots.txt as the way to block CCBot and Meta-ExternalAgent (Meta lists
 *   only other crawlers as ones that may bypass it).
 * - ByteDance: no operator page found for Bytespider.
 */
export const AI_BOTS: readonly AiBot[] = [
  { id: 'oai-searchbot', token: 'OAI-SearchBot', operator: 'OpenAI', role: 'ai-search', stance: 'documented', probeAgent: 'oai-searchbot', docsUrl: OPENAI_DOCS },
  { id: 'chatgpt-user', token: 'ChatGPT-User', operator: 'OpenAI', role: 'live-fetch', stance: 'may-ignore', probeAgent: 'chatgpt-user', docsUrl: OPENAI_DOCS },
  { id: 'gptbot', token: 'GPTBot', operator: 'OpenAI', role: 'training', stance: 'documented', probeAgent: 'gptbot', docsUrl: OPENAI_DOCS },
  { id: 'claude-searchbot', token: 'Claude-SearchBot', operator: 'Anthropic', role: 'ai-search', stance: 'documented', probeAgent: null, docsUrl: ANTHROPIC_DOCS },
  { id: 'claude-user', token: 'Claude-User', operator: 'Anthropic', role: 'live-fetch', stance: 'documented', probeAgent: null, docsUrl: ANTHROPIC_DOCS },
  { id: 'claudebot', token: 'ClaudeBot', operator: 'Anthropic', role: 'training', stance: 'documented', probeAgent: 'claudebot', docsUrl: ANTHROPIC_DOCS },
  { id: 'perplexitybot', token: 'PerplexityBot', operator: 'Perplexity', role: 'ai-search', stance: 'documented', probeAgent: 'perplexitybot', docsUrl: PERPLEXITY_DOCS },
  { id: 'perplexity-user', token: 'Perplexity-User', operator: 'Perplexity', role: 'live-fetch', stance: 'may-ignore', probeAgent: null, docsUrl: PERPLEXITY_DOCS },
  { id: 'applebot', token: 'Applebot', operator: 'Apple', role: 'ai-search', stance: 'documented', probeAgent: null, docsUrl: APPLE_DOCS },
  { id: 'applebot-extended', token: 'Applebot-Extended', operator: 'Apple', role: 'training', stance: 'control-token', probeAgent: null, docsUrl: APPLE_DOCS },
  { id: 'google-extended', token: 'Google-Extended', operator: 'Google', role: 'training', stance: 'control-token', probeAgent: null, docsUrl: GOOGLE_DOCS },
  { id: 'ccbot', token: 'CCBot', operator: 'Common Crawl', role: 'training', stance: 'documented', probeAgent: null, docsUrl: COMMON_CRAWL_DOCS },
  { id: 'bytespider', token: 'Bytespider', operator: 'ByteDance', role: 'training', stance: 'not-documented', probeAgent: null, docsUrl: null },
  { id: 'meta-externalagent', token: 'Meta-ExternalAgent', operator: 'Meta', role: 'training', stance: 'documented', probeAgent: null, docsUrl: META_DOCS },
];

/** robots.txt's verdict for one token on the page's path (see the top of this file). */
export const AI_BOT_VERDICTS = ['allowed', 'disallowed', 'unknown', 'not-checked'] as const;
export type AiBotVerdictValue = (typeof AI_BOT_VERDICTS)[number];

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
