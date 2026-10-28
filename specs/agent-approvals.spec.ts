/**
 * The approval broker's policy and constants (Phase 5 Task 4, plan decision 7; acceptance
 * `agent-approvals.feature.md`). Plain values and pure functions with no Zod, so the chrome renderer
 * can use them (labels, statuses) as well as main's broker (`apps/desktop/src/main/agent/approvals.ts`),
 * its standing grants (`grants.ts`) and the grants table in `@app/db` (`agent-grants.ts`).
 *
 * Main decides every tool call the runtime asks for (`tool.invoke`): it runs it, asks the user, or
 * refuses it. Only main's code answers an approval (through the app window's sender-guarded IPC,
 * Task 6); no runtime message can approve a call or create a grant.
 */
import { AGENT_TOOLS, EXECUTE_JS_MAX_SOURCE_CHARS, isAgentToolName, isGrantable, isSafeInputText, MAX_TOOL_STEPS, toolRisk, type AgentToolRisk, type ToolErrorCode } from './agent-tools.spec';
import { isPublicHost } from './private-address.spec';
import { parseWebUrl, webOrigin } from './web-url.spec';

// ---- Constants -------------------------------------------------------------------------------

/** How long an approval request waits for the user before it answers `expired` (milliseconds). */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Approval requests one chat may have waiting at once; a call past it is refused (`not-allowed`). */
export const MAX_PENDING_APPROVALS_PER_CHAT = 32;

/**
 * Tool calls one turn may make: `MAX_TOOL_STEPS` steps of at most 32 calls each (the protocol's
 * `maxToolCallsPerMessage`); later ones are refused (`not-allowed`).
 */
export const MAX_TOOL_CALLS_PER_TURN = MAX_TOOL_STEPS * 32;

/**
 * How the user answers an approval request:
 * - `allow-once`: run this call;
 * - `allow-always`: run it, and keep a standing grant for the tool on that origin (`canGrant` only);
 * - `deny`: don't run it (`denied`).
 */
export const APPROVAL_DECISIONS = ['allow-once', 'allow-always', 'deny'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/**
 * A tool call's state, for its card in the panel:
 * `awaiting-approval` (asking the user), `running`, `done` (output handed to the model), `denied`
 * (the user said no), `failed` (refused, invalid, or the tool failed), `expired` (unanswered in
 * time, the chat stopped, or the tab left the approved page).
 */
export const TOOL_ACTIVITY_STATUSES = ['awaiting-approval', 'running', 'done', 'denied', 'failed', 'expired'] as const;
export type ToolActivityStatus = (typeof TOOL_ACTIVITY_STATUSES)[number];

/** The status a call ends in for each error code. */
export function activityStatusFor(code: ToolErrorCode): ToolActivityStatus {
  return code === 'denied' ? 'denied' : code === 'expired' ? 'expired' : 'failed';
}

/**
 * The only messages a failed `tool.result` carries: short, fixed, and free of stacks, page text or
 * main's internals. The model reads them; so does the user, on the tool card.
 */
export const TOOL_ERROR_MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  denied: 'The user did not allow this tool call.',
  unavailable: "This tool's data source is not connected.",
  failed: 'The tool failed.',
  timeout: 'The tool ran out of time.',
  expired: 'The approval for this call expired before it ran.',
  'invalid-input': "The input does not match the tool's schema.",
  'not-allowed': 'This tool is not allowed in this chat.',
};

/**
 * Longest canonical input (JSON text, characters) a call may have: an approval request always shows
 * the whole input, never a cut one. Derived from the catalogue's caps: the longest input any
 * catalogue schema admits is `execute_javascript`'s code, and JSON writes each character it allows
 * in at most two (`\"`, `\\`, `\n`, `\t`; the escapes JSON writes longer, other controls and lone
 * surrogates, are refused by `UNSAFE_CODE_CHARS`), plus the key. An MCP tool's input longer than it
 * is refused (`invalid-input`).
 */
export const APPROVAL_DISPLAY_MAX_CHARS = 2 * EXECUTE_JS_MAX_SOURCE_CHARS + 64;

/** Most standing grants kept; adding one past it is refused (the grants page can revoke some). */
export const MAX_AGENT_GRANTS = 1000;

/** The `@app/db` tables of this task (migration `0030_agent_grants`). */
export const AGENT_GRANT_TABLES = ['agent_grants', 'agent_preferences'] as const;

/** `agent_preferences`' key for "read tools run without asking" (`'1'` or `'0'`). */
export const READ_TOOLS_PREFERENCE_KEY = 'read_tools_allowed';

/** Read tools run without asking until the user turns that off. */
export const DEFAULT_READ_TOOLS_ALLOWED = true;

/** Longest origin a grant is stored for (characters). */
export const MAX_GRANT_ORIGIN_CHARS = 2048;

/**
 * Why a tool runs, handed to the tool runner (Task 5) with what it must find before it acts:
 * - `read`: a read tool, on its own (read tools allowed);
 * - `grant`: an `act` tool under a standing grant (the tab must still be on `expectedOrigin`);
 * - `approval`: the user allowed this call (the tab must still show exactly `expectedUrl`).
 */
export const TOOL_RUN_VIAS = ['read', 'grant', 'approval'] as const;
export type ToolRunVia = (typeof TOOL_RUN_VIAS)[number];

// ---- Inputs ----------------------------------------------------------------------------------

/**
 * Whether an MCP tool's input (JSON data) is safe to show and approve: every key and string holds
 * no `UNSAFE_CODE_CHARS` (line feeds and tabs allowed), so nothing in it is invisible or reorders
 * what is shown. Its length is checked against `APPROVAL_DISPLAY_MAX_CHARS` separately.
 */
export function isSafeInputJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === 'string') return isSafeInputText(value, 'code');
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every((item) => isSafeInputJson(item, depth + 1));
  return Object.entries(value).every(([key, item]) => isSafeInputText(key, 'code') && isSafeInputJson(item, depth + 1));
}

// ---- Origins and pages -----------------------------------------------------------------------

/**
 * Whether `origin` may carry a standing grant: an `https:` origin written exactly as the URL parser
 * serialises it (`https://example.com`, no path, no trailing slash, no trailing dot on the host)
 * whose host is public (`isPublicHost`: not `localhost`, a private or loopback IP literal, a single
 * label or a reserved name). A grant is never created for, or used on, any other origin; plain
 * `http:` always asks.
 */
export function isGrantOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length > MAX_GRANT_ORIGIN_CHARS) return false;
  const parsed = parseWebUrl(origin);
  return parsed !== null && parsed.protocol === 'https:' && parsed.origin === origin && !parsed.hostname.endsWith('.') && isPublicHost(parsed.hostname);
}

/** `url` as an approval binds a page: an `http(s)` URL without its `#fragment`; else `null`. */
export function pageUrlOf(url: unknown): string | null {
  const parsed = parseWebUrl(url);
  if (parsed === null) return null;
  parsed.hash = '';
  return parsed.href;
}

/** Whether `url` is an `http(s)` page on a public host (`isPublicHost`): read tools run there without asking. */
export function isPublicPage(url: unknown): boolean {
  const parsed = parseWebUrl(url);
  return parsed !== null && isPublicHost(parsed.hostname);
}

/** Tools that act on the chat tab's page: the origin they act on is the tab's. */
export const PAGE_TOOLS: readonly string[] = ['page_audit', 'page_data', 'page_text', 'click', 'execute_javascript'];

/** Whether `toolName` acts on the chat tab's page (`PAGE_TOOLS`): it needs a web page there, and an approval binds that page. */
export function isTabBound(toolName: string): boolean {
  return PAGE_TOOLS.includes(toolName);
}

/**
 * The origin a grant for a call to `toolName` is keyed to (`act` tools only):
 * - `navigate`: the destination's origin (`input.url`), never the tab's, so a grant for one site
 *   doesn't let the agent go to another;
 * - `click`: the origin of the page the chat's tab shows (`tabUrl`);
 * - any other tool, or a non-`http(s)` URL: `null` (no grant applies).
 */
export function grantOriginFor(toolName: string, input: unknown, tabUrl: string | null): string | null {
  if (toolName === 'navigate') {
    const url = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
    return webOrigin(url);
  }
  if (toolName === 'click') return webOrigin(tabUrl);
  return null;
}

/**
 * The origin an approval request names: the grant origin for `navigate` and `click`, the tab page's
 * origin for the other page tools (`PAGE_TOOLS`), else `null` (the call doesn't act on a site).
 */
export function approvalOriginFor(toolName: string, input: unknown, tabUrl: string | null): string | null {
  if (toolName === 'navigate' || toolName === 'click') return grantOriginFor(toolName, input, tabUrl);
  return PAGE_TOOLS.includes(toolName) ? webOrigin(tabUrl) : null;
}

/** What a run must find (`ToolRunContext`): the origin, and the exact URL. */
export interface RunTarget {
  readonly expectedOrigin: string | null;
  readonly expectedUrl: string | null;
}

/**
 * What a call to `toolName` must find when it runs, decided when main decides the call:
 * - `navigate`: the destination's origin and `parseWebUrl(url).href` (the URL the tab loads);
 * - a page tool: the tab page's origin and its URL without the fragment (`pageUrlOf`);
 * - any other tool: nothing (`null`s).
 */
export function runTargetFor(toolName: string, input: unknown, tabUrl: string | null): RunTarget {
  if (toolName === 'navigate') {
    const url = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
    const parsed = parseWebUrl(url);
    return { expectedOrigin: parsed?.origin ?? null, expectedUrl: parsed?.href ?? null };
  }
  if (isTabBound(toolName)) return { expectedOrigin: webOrigin(tabUrl), expectedUrl: pageUrlOf(tabUrl) };
  return { expectedOrigin: null, expectedUrl: null };
}

/**
 * Whether a standing grant may be created for (`allow-always`) or used by `toolName` on `origin`:
 * an `act` catalogue tool the catalogue says is grantable (`navigate`, `click`), on a grantable
 * origin (`isGrantOrigin`). Never for `read` tools (covered by the read-tools setting),
 * `run_ai_search`, `execute`, `external` or an unknown name.
 */
export function canGrant(toolName: unknown, origin: unknown): boolean {
  return isAgentToolName(toolName) && AGENT_TOOLS[toolName].risk === 'act' && isGrantable(toolName) && isGrantOrigin(origin);
}

// ---- Policy ----------------------------------------------------------------------------------

export interface DecideContext {
  /** The catalogue says a standing grant may cover the tool (`isGrantable`). */
  readonly grantable: boolean;
  /** A standing grant exists for the tool on the call's grant origin. */
  readonly hasGrant: boolean;
  /** The user lets read tools run without asking (`DEFAULT_READ_TOOLS_ALLOWED`). */
  readonly readToolsAllowed: boolean;
  /** The grant origin is missing or can't carry a grant (not `isGrantOrigin`). */
  readonly privateOrigin: boolean;
  /** A page tool on a page whose host isn't public (`isPublicPage`): a local service's page. */
  readonly privatePage: boolean;
}

/**
 * What main does with a valid, allowed call of a tool of class `risk`:
 * - `read`: `run`, unless the user turned read tools off or the page isn't public (`ask`);
 * - `act`: `run` only with a standing grant for a grantable tool on a grantable origin, else `ask`;
 * - `execute`, `external`: `ask`, every call.
 */
export function decide(risk: AgentToolRisk, context: DecideContext): 'run' | 'ask' {
  switch (risk) {
    case 'read':
      return context.readToolsAllowed && !context.privatePage ? 'run' : 'ask';
    case 'act':
      return context.grantable && context.hasGrant && !context.privateOrigin ? 'run' : 'ask';
    case 'execute':
    case 'external':
      return 'ask';
  }
}

/** `decide` for a tool name (`ask` for a name with no risk class). */
export function decideFor(toolName: string, context: DecideContext): 'run' | 'ask' {
  const risk = toolRisk(toolName);
  return risk === null ? 'ask' : decide(risk, context);
}
