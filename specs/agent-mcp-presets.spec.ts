/**
 * MCP presets: known MCP servers one click from a filled add-server form (Phase 8 Task 10,
 * Decision 9; SL-066 / SL-085; acceptance `agent-mcp-presets.feature.md`). Plain values and pure
 * functions with no Zod, so the chrome renderer imports them as they are.
 *
 * A preset is data only. It is never contacted (not at startup, not in tests, not when shown or
 * chosen); it holds no token and no environment value, and pre-fills none. Choosing one only fills
 * the existing add form (`AgentMcp.tsx`): the user still presses "Add server" (nothing is saved
 * before), sets the token afterwards in the server's write-only token field (keychain), and presses
 * Start. The saved server is like one typed by hand: untrusted, off until switched on, every tool
 * call asks (`MCP_TOOL_GRANTABLE` is false), and a command server starts only after main's native
 * dialog (`agent-mcp.feature.md`, unchanged). Every `url` passes `parseMcpServerUrl`; every
 * `docsUrl` opens only through the app window's open handler (`resolveExternalOpen`, on a gesture).
 *
 * Verification (Open question 6): each shipped preset was checked on 2026-10-30 against the
 * vendor's own documentation (the `docsUrl` row below): transport (Streamable HTTP), URL, and an
 * `Authorization: Bearer <token>` path that works without OAuth (frost's client has no MCP OAuth
 * sign-in and sends no other header). Each vendor's page documents the token path for MCP clients
 * in general (custom or headless clients included).
 *
 * | Preset     | URL                                  | Token                                    | Vendor doc (checked 2026-10-30) |
 * |------------|--------------------------------------|------------------------------------------|---------------------------------|
 * | Ahrefs     | https://api.ahrefs.com/mcp/mcp       | MCP key (Lite plan or higher)            | https://docs.ahrefs.com/mcp/docs/introduction (+ its n8n and OpenClaw guides: Bearer). Terms: "for interactive use with MCP-compatible clients"; scripts, bridges and standalone JSON-RPC clients are not permitted. frost is an interactive MCP client whose every call the user approves. |
 * | Profound   | https://mcp.tryprofound.com/mcp      | API key as a long-lived Bearer token     | https://docs.tryprofound.com/mcp/authentication |
 * | Peec AI    | https://api.peec.ai/mcp              | Personal Access Token                    | https://docs.peec.ai/mcp/setup ("any AI tool that supports the MCP standard") |
 * | Sanity     | https://mcp.sanity.io/               | API token or personal token              | https://www.sanity.io/docs/ai/mcp-server ("works with any MCP-compatible client") |
 * | Storyblok  | https://mcp.storyblok.com/mcp        | Personal access token                    | https://www.storyblok.com/docs/tooling/mcp-server/setup ("any client that supports the HTTP transport") |
 * | GitHub     | https://api.githubcopilot.com/mcp/   | Personal access token                    | https://github.com/github/github-mcp-server (README, Remote GitHub MCP Server) |
 * | GitLab.com | https://gitlab.com/api/v4/mcp        | Fine-grained PAT (MCP tool: Execute)     | https://docs.gitlab.com/user/model_context_protocol/mcp_server/ (GA; tokens accepted) and doc/api/rest/authentication.md (`Authorization: Bearer`) |
 * | Linear     | https://mcp.linear.app/mcp           | API key or OAuth access token            | https://linear.app/docs/mcp (FAQ: `Authorization: Bearer <yourtoken>`) |
 * | monday.com | https://mcp.monday.com/mcp           | Personal API token                       | https://developer.monday.com/api-reference/docs/mcp-api-token |
 * | PostHog    | https://mcp.posthog.com/mcp          | Personal API key, "MCP Server" preset    | https://posthog.com/docs/model-context-protocol/faq |
 * | Cloudflare | https://mcp.cloudflare.com/mcp       | API token (user or account)              | https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/ |
 * | Airtable   | https://mcp.airtable.com/mcp         | Personal access token with MCP scopes    | https://airtable.com/developers/agents/mcp/other |
 *
 * Command presets (`npx -y pkg@x.y.z`) are deferred by default (Decision 9): they ship only once
 * Open question 10 shows the pinned command starting under frost's command-server rules on macOS,
 * Linux and Windows. None does yet, so the catalogue ships HTTP presets only; the command shape and
 * its checks (`mcpPresetProblems`: an exact top-level version, the unpinned-dependencies sentence)
 * stay so a future one is held to them. Candidates that need OAuth, another header, or that could
 * not be verified are listed in `MCP_DEFERRED_PRESETS` with the reason.
 */
import type { AgentSaveMcpServerInput } from './agent-mcp.schema';
import { isMcpArg, isMcpCommand, isMcpEnvName, MCP_LIMITS, normalizeMcpServerName, parseMcpServerUrl } from './agent-mcp.spec';
import { isSafeInputText } from './agent-tools.spec';

// ---- Categories ------------------------------------------------------------------------------

export const MCP_PRESET_CATEGORIES = [
  { id: 'seo-data', label: 'SEO data' },
  { id: 'ai-visibility', label: 'AI search visibility' },
  { id: 'site', label: 'Site and CMS' },
  { id: 'work', label: 'Work tracking' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'reporting', label: 'Reporting' },
] as const;
export type McpPresetCategory = (typeof MCP_PRESET_CATEGORIES)[number]['id'];

export function isMcpPresetCategory(value: unknown): value is McpPresetCategory {
  return MCP_PRESET_CATEGORIES.some((category) => category.id === value);
}

export function mcpPresetCategoryLabel(category: McpPresetCategory): string {
  return MCP_PRESET_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}

// ---- Presets ---------------------------------------------------------------------------------

/**
 * How the server is given its credential: `bearer` (an HTTP server's token, which the user pastes
 * into the saved server's token field), `env` (a command server's environment variables, whose
 * values the user types into the form), `none`.
 */
export const MCP_PRESET_AUTHS = ['bearer', 'env', 'none'] as const;
export type McpPresetAuth = (typeof MCP_PRESET_AUTHS)[number];

interface McpPresetBase {
  /** Stable id: lowercase letters, digits and dashes. */
  readonly id: string;
  /** The server's name as the form starts with it (a valid server name). */
  readonly name: string;
  readonly category: McpPresetCategory;
  /** One line, in frost's words. A command preset's says its dependencies are not pinned. */
  readonly description: string;
  /** Environment variable names the server needs (names only; never a value). */
  readonly envNames: readonly string[];
  readonly auth: McpPresetAuth;
  /** How the user gets the token or values, in frost's words (never a token). */
  readonly tokenHint: string;
  /** The vendor's setup page (opened in the system browser, on a click). */
  readonly docsUrl: string;
}

export interface McpHttpPreset extends McpPresetBase {
  readonly transport: 'http';
  /** The server's URL, normalised (`parseMcpServerUrl(url) === url`), with no query. */
  readonly url: string;
}

export interface McpCommandPreset extends McpPresetBase {
  readonly transport: 'stdio';
  /** A program name or absolute path (`isMcpCommand`). */
  readonly command: string;
  /** Arguments; the package argument pins an exact version (`isPinnedMcpPackage`). */
  readonly args: readonly string[];
  /** Whether the server needs the network (the form's network box starts ticked only then). */
  readonly needsNetwork: boolean;
}

export type McpPreset = McpHttpPreset | McpCommandPreset;

/** The fields a preset may have: nothing else (no token, no environment value). */
export const MCP_PRESET_FIELDS = {
  http: ['id', 'name', 'category', 'description', 'transport', 'url', 'envNames', 'auth', 'tokenHint', 'docsUrl'],
  stdio: ['id', 'name', 'category', 'description', 'transport', 'command', 'args', 'needsNetwork', 'envNames', 'auth', 'tokenHint', 'docsUrl'],
} as const;

export const MCP_PRESET_LIMITS = {
  maxIdChars: 32,
  maxDescriptionChars: 140,
  maxTokenHintChars: 220,
} as const;

/** The sentence every command preset's description holds (Decision 9). */
export const MCP_PRESET_UNPINNED_SENTENCE = 'Its own dependencies are not pinned.';

/** The catalogue (verified 2026-10-30; see the table above). HTTP presets only (Decision 9). */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    category: 'seo-data',
    description: 'Backlinks, keywords and site metrics from your Ahrefs account.',
    transport: 'http',
    url: 'https://api.ahrefs.com/mcp/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'An Ahrefs MCP key: Account settings, API keys, Generate MCP key (Lite plan or higher).',
    docsUrl: 'https://docs.ahrefs.com/mcp/docs/introduction',
  },
  {
    id: 'profound',
    name: 'Profound',
    category: 'ai-visibility',
    description: 'How AI answer engines mention your brand, from your Profound account.',
    transport: 'http',
    url: 'https://mcp.tryprofound.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Profound API key, used as a long-lived bearer token.',
    docsUrl: 'https://docs.tryprofound.com/mcp/authentication',
  },
  {
    id: 'peec-ai',
    name: 'Peec AI',
    category: 'ai-visibility',
    description: 'Brand visibility in AI search from your Peec AI projects (read-only tools).',
    transport: 'http',
    url: 'https://api.peec.ai/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Peec AI personal access token: API Keys, Personal Access Tokens, Create token.',
    docsUrl: 'https://docs.peec.ai/mcp/setup',
  },
  {
    id: 'sanity',
    name: 'Sanity',
    category: 'site',
    description: 'Query and edit content, schemas and datasets in your Sanity projects.',
    transport: 'http',
    url: 'https://mcp.sanity.io/',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Sanity API token from sanity.io/manage, or a personal token; it limits what the server may do.',
    docsUrl: 'https://www.sanity.io/docs/ai/mcp-server',
  },
  {
    id: 'storyblok',
    name: 'Storyblok',
    category: 'site',
    description: 'Stories, components and assets in your Storyblok spaces.',
    transport: 'http',
    url: 'https://mcp.storyblok.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Storyblok personal access token, limited to the spaces and permissions it needs.',
    docsUrl: 'https://www.storyblok.com/docs/tooling/mcp-server/setup',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'work',
    description: 'Issues, pull requests and code in your GitHub repositories.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A GitHub personal access token; a fine-grained one limited to the repositories it needs.',
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'gitlab',
    name: 'GitLab.com',
    category: 'work',
    description: 'Issues, merge requests and projects on GitLab.com.',
    transport: 'http',
    url: 'https://gitlab.com/api/v4/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A GitLab fine-grained personal access token with the MCP tool resource (Execute); your top-level group must allow MCP.',
    docsUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'work',
    description: 'Issues, projects and documents in your Linear workspace.',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Linear personal API key; one with only the Read permission keeps it read-only.',
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    id: 'monday',
    name: 'monday.com',
    category: 'work',
    description: 'Boards, items and updates in your monday.com account.',
    transport: 'http',
    url: 'https://mcp.monday.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A monday.com personal API token: profile picture, Developers, My access tokens.',
    docsUrl: 'https://developer.monday.com/api-reference/docs/mcp-api-token',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'analytics',
    description: 'Product analytics, errors and feature flags in your PostHog projects.',
    transport: 'http',
    url: 'https://mcp.posthog.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A PostHog personal API key made with the MCP Server preset.',
    docsUrl: 'https://posthog.com/docs/model-context-protocol/faq',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'analytics',
    description: 'The Cloudflare API for your account: analytics, DNS, Workers and more.',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'A Cloudflare API token (user or account) with only the permissions you need.',
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'reporting',
    description: 'Bases, tables and records in your Airtable workspace.',
    transport: 'http',
    url: 'https://mcp.airtable.com/mcp',
    envNames: [],
    auth: 'bearer',
    tokenHint: 'An Airtable personal access token with the MCP scopes, limited to the bases it needs.',
    docsUrl: 'https://airtable.com/developers/agents/mcp/other',
  },
];

// ---- Deferred candidates ---------------------------------------------------------------------

/**
 * Why a candidate is not a preset yet:
 * - `oauth-only`: its server signs in with OAuth only (frost has no MCP OAuth sign-in);
 * - `auth-scheme`: its token path needs a header frost doesn't send (frost sends only `Authorization: Bearer`);
 * - `command`: a command server, deferred until Open question 10 holds on every OS (Decision 9);
 * - `unverified`: no vendor-documented server or token path could be confirmed.
 */
export const MCP_PRESET_DEFER_REASONS = ['oauth-only', 'auth-scheme', 'command', 'unverified'] as const;
export type McpPresetDeferReason = (typeof MCP_PRESET_DEFER_REASONS)[number];

export interface McpDeferredPreset {
  readonly name: string;
  readonly category: McpPresetCategory;
  readonly reason: McpPresetDeferReason;
  /** What was found, in frost's words. */
  readonly detail: string;
  /** The vendor page read on 2026-10-30, or `null` when none was found. */
  readonly source: string | null;
}

/** Candidates from the audit and §4 that are not presets (checked 2026-10-30). */
export const MCP_DEFERRED_PRESETS: readonly McpDeferredPreset[] = [
  {
    name: 'Semrush',
    category: 'seo-data',
    reason: 'auth-scheme',
    detail: 'Its API-key path sends "Authorization: Apikey"; otherwise it signs in with OAuth.',
    source: 'https://developer.semrush.com/api/basics/semrush-mcp/',
  },
  {
    name: 'SE Ranking',
    category: 'seo-data',
    reason: 'auth-scheme',
    detail: 'Its API-key path sends an "X-Api-Key" header; otherwise it signs in with OAuth.',
    source: 'https://seranking.com/api/integrations/mcp',
  },
  {
    name: 'SISTRIX',
    category: 'seo-data',
    reason: 'oauth-only',
    detail: 'The vendor technical page documents OAuth 2.0 sign-in only.',
    source: 'https://www.sistrix.com/api/connection-to-chatbot-ai/technical-information-mcp',
  },
  {
    name: 'DataForSEO',
    category: 'seo-data',
    reason: 'auth-scheme',
    detail: 'The hosted server takes HTTP Basic credentials (login and password); its local package is a command.',
    source: 'https://dataforseo.com/help-center/setting-up-the-official-dataforseo-mcp-server-simple-guide',
  },
  {
    name: 'Otterly.AI',
    category: 'ai-visibility',
    reason: 'oauth-only',
    detail: 'The server authenticates with OAuth 2.0 only and does not accept API keys.',
    source: 'https://help.otterly.ai/does-otterlyai-have-an-mcp',
  },
  {
    name: 'WordPress (self-hosted)',
    category: 'site',
    reason: 'command',
    detail: 'Each site serves its own address, reached through WP-CLI or a local proxy command.',
    source: 'https://github.com/WordPress/mcp-adapter',
  },
  {
    name: 'Webflow',
    category: 'site',
    reason: 'oauth-only',
    detail: 'The remote server signs in with OAuth; its token-based local package is a command.',
    source: 'https://developers.webflow.com/mcp/reference/how-it-works',
  },
  {
    name: 'Wix',
    category: 'site',
    reason: 'auth-scheme',
    detail: 'Its API-key path sends the raw key and a "wix-account-id" header; otherwise it signs in with OAuth.',
    source: 'https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp',
  },
  {
    name: 'ClickUp',
    category: 'work',
    reason: 'oauth-only',
    detail: 'The vendor states only OAuth is supported; API keys and access tokens are not.',
    source: 'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server',
  },
  {
    name: 'Trello',
    category: 'work',
    reason: 'unverified',
    detail: 'No vendor-documented MCP server could be confirmed; only third-party servers were found.',
    source: null,
  },
  {
    name: 'Shortcut',
    category: 'work',
    reason: 'oauth-only',
    detail: 'The hosted server signs in with OAuth; its token-based local package is a command.',
    source: 'https://www.shortcut.com/help/integrations/mcp-server',
  },
  {
    name: 'Sentry',
    category: 'analytics',
    reason: 'auth-scheme',
    detail: 'A token goes in "Authorization: Sentry-Bearer" (plain Bearer is kept for OAuth); its local package is a command.',
    source: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    name: 'Coda',
    category: 'reporting',
    reason: 'unverified',
    detail: 'The vendor help page (beta) could not be read; the setup found signs in with OAuth.',
    source: 'https://help.coda.io/hc/en-us/articles/44722661982989-Connect-to-the-Coda-MCP',
  },
];

// ---- Rules -----------------------------------------------------------------------------------

export const MCP_PRESET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * An npm package pinned to one exact version: `name@x.y.z` or `@scope/name@x.y.z` (an optional
 * pre-release, no build metadata). Refused: no version, a range (`^1.2.3`, `~1.2`, `1.x`, `>=1`), a
 * tag (`@latest`, `@next`), a URL, a path, a git or `file:` spec, or an integrity form (`npx` can't
 * pin one, so none is accepted). The package's own dependencies are still not pinned.
 */
export const MCP_PINNED_PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isPinnedMcpPackage(arg: unknown): arg is string {
  return typeof arg === 'string' && arg.length <= 214 && MCP_PINNED_PACKAGE_PATTERN.test(arg);
}

/** A command preset's package argument: its first argument that isn't an option (`-y`, `--yes`). */
export function mcpPresetPackageArg(preset: McpCommandPreset): string | null {
  return preset.args.find((arg) => !arg.startsWith('-')) ?? null;
}

/**
 * Text that looks like a credential: a `token=`/`key=`/`secret=`/`password=` assignment (or `:`
 * with no space), a known token prefix, a `Bearer`/`Basic`/`Apikey` value, or a long unbroken run
 * of key-like characters. A preset's text never holds one.
 */
export function looksLikeMcpSecret(text: string): boolean {
  return (
    /\b(?:token|key|secret|password|passwd|apikey|api_key|access_token)[=:][^\s/]/i.test(text) ||
    /\b(?:sk|pk|ghp|gho|ghs|github_pat|glpat|phx|lin_api|xox[abp]|sbp|pat)[-_][A-Za-z0-9]/.test(text) ||
    /\b(?:Bearer|Basic|Apikey)\s+[A-Za-z0-9+/=._-]{8,}/.test(text) ||
    /[A-Za-z0-9_]{32,}|[A-Za-z0-9+/]{40,}/.test(text)
  );
}

const textOk = (text: unknown, max: number): text is string => typeof text === 'string' && text.trim() === text && text !== '' && text.length <= max && isSafeInputText(text);

/** Every string a preset holds (to check none looks like a secret). */
function presetStrings(preset: McpPreset): string[] {
  const own = [preset.id, preset.name, preset.description, preset.tokenHint, preset.docsUrl, ...preset.envNames];
  return preset.transport === 'http' ? [...own, preset.url] : [...own, preset.command, ...preset.args];
}

/**
 * What is wrong with a preset, as short reasons (an empty list: none). Checks its shape (only the
 * allowed fields), id, name, category, words and hint; an HTTP preset's URL (normalised, public
 * `https:`, no query) and auth (`bearer` or `none`, no environment); a command preset's command,
 * arguments, exact top-level version, environment names (portable, not reserved, unique), auth
 * (`env` with names or `none` without), and the unpinned-dependencies sentence; and that no text
 * looks like a secret. Main's `resolveExternalOpen` checks each `docsUrl` in tests too.
 */
export function mcpPresetProblems(preset: McpPreset): string[] {
  const problems: string[] = [];
  const allowed: readonly string[] = preset.transport === 'http' ? MCP_PRESET_FIELDS.http : preset.transport === 'stdio' ? MCP_PRESET_FIELDS.stdio : [];
  if (allowed.length === 0) return ['transport'];
  for (const key of Object.keys(preset)) if (!allowed.includes(key)) problems.push(`field:${key}`);
  for (const key of allowed) if (!Object.hasOwn(preset, key)) problems.push(`missing:${key}`);
  if (typeof preset.id !== 'string' || !MCP_PRESET_ID_PATTERN.test(preset.id)) problems.push('id');
  if (normalizeMcpServerName(preset.name) !== preset.name) problems.push('name');
  if (!isMcpPresetCategory(preset.category)) problems.push('category');
  if (!textOk(preset.description, MCP_PRESET_LIMITS.maxDescriptionChars)) problems.push('description');
  if (typeof preset.tokenHint !== 'string' || (preset.tokenHint !== '' && !textOk(preset.tokenHint, MCP_PRESET_LIMITS.maxTokenHintChars))) problems.push('token-hint');
  if (preset.auth !== 'none' && preset.tokenHint === '') problems.push('token-hint');
  if (typeof preset.docsUrl !== 'string' || !preset.docsUrl.startsWith('https://') || !textOk(preset.docsUrl, MCP_LIMITS.maxUrlChars)) problems.push('docs-url');
  const envNames = Array.isArray(preset.envNames) ? preset.envNames : [];
  if (!Array.isArray(preset.envNames) || envNames.length > MCP_LIMITS.maxEnvVars || !envNames.every((name) => isMcpEnvName(name)) || new Set(envNames).size !== envNames.length) problems.push('env-names');
  if (preset.transport === 'http') {
    const url = parseMcpServerUrl(preset.url);
    if (url === null || url !== preset.url || new URL(url).search !== '') problems.push('url');
    if (preset.auth !== 'bearer' && preset.auth !== 'none') problems.push('auth');
    if (envNames.length > 0) problems.push('env-names');
  } else {
    if (!isMcpCommand(preset.command)) problems.push('command');
    if (!Array.isArray(preset.args) || preset.args.length > MCP_LIMITS.maxArgs || !preset.args.every((arg) => isMcpArg(arg))) problems.push('args');
    else if (!isPinnedMcpPackage(mcpPresetPackageArg(preset))) problems.push('unpinned');
    if (typeof preset.needsNetwork !== 'boolean') problems.push('network');
    if (!(preset.auth === 'env' && envNames.length > 0) && !(preset.auth === 'none' && envNames.length === 0)) problems.push('auth');
    if (typeof preset.description !== 'string' || !preset.description.includes(MCP_PRESET_UNPINNED_SENTENCE)) problems.push('unpinned-not-said');
  }
  if (presetStrings(preset).some((text) => typeof text === 'string' && looksLikeMcpSecret(text))) problems.push('secret');
  return problems;
}

// ---- Search and the form ---------------------------------------------------------------------

/** The text a search compares: NFKC-folded, lower-cased, spaces collapsed. */
function foldPresetText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The presets in `category` (`null`: every category) whose name, description, category label or id
 * contain every word of `query` (folded; order kept). A blank query keeps them all. Pure: the
 * catalogue filters in the renderer, with no IPC and no network.
 */
export function filterPresets(query: string, category: McpPresetCategory | null, presets: readonly McpPreset[] = MCP_PRESETS): McpPreset[] {
  const words = foldPresetText(typeof query === 'string' ? query : '')
    .split(' ')
    .filter((word) => word !== '');
  return presets.filter((preset) => {
    if (category !== null && preset.category !== category) return false;
    const haystack = foldPresetText(`${preset.name} ${preset.description} ${mcpPresetCategoryLabel(preset.category)} ${preset.id}`);
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The `agent.saveMcpServer` input the add form starts from: the preset's name and URL, or its
 * command and arguments, no readable folder, the network allowed only when the server needs it,
 * and its environment names with no value. Never a token or an environment value; nothing is saved
 * until the user presses "Add server".
 */
export function presetDraft(preset: McpPreset): AgentSaveMcpServerInput {
  if (preset.transport === 'http') return { name: preset.name, transport: 'http', url: preset.url };
  return {
    name: preset.name,
    transport: 'stdio',
    command: preset.command,
    args: [...preset.args],
    readPaths: [],
    allowNetwork: preset.needsNetwork === true,
    env: preset.envNames.map((name) => ({ name })),
  };
}

// ---- Words -----------------------------------------------------------------------------------

/** The catalogue sheet's fixed copy (frost's words). */
export const MCP_PRESET_WORDS = {
  open: 'Add from catalogue',
  close: 'Close catalogue',
  title: 'Server catalogue',
  intro: 'Known servers that sign in with a token. Choosing one only fills the form below.',
  search: 'Search the catalogue',
  all: 'All',
  choose: 'Use',
  docs: 'Setup guide',
  noMatch: 'No server in the catalogue matches.',
  filled: 'Filled in from the catalogue. Check it, then add the server, and set its token once saved.',
  untrusted: 'Like any server, it is untrusted: every tool call asks you first.',
  tokenHint: 'Token',
} as const;
