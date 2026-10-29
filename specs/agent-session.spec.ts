/**
 * The agent panel's view of main's chat sessions (Phase 5 Task 6a; acceptance
 * `agent-session.feature.md`). Plain values and types with no Zod, so the chrome renderer imports
 * them as they are (the `agent.*` procedures' inputs are in `agent-ipc.schema.ts`). It imports only
 * the plain, Zod-free `agent-approvals.spec.ts` values.
 *
 * Main keeps the chats (`apps/desktop/src/main/agent/session.ts`) and answers `agent.watch` with an
 * `AgentState`: what the panel shows and nothing more. No key, no part of one and no plaintext
 * secret is ever in it; tool output appears only as bounded, inert preview text.
 */
import { MAX_TOOL_CALLS_PER_TURN, type ApprovalDecision, type ToolActivityStatus } from './agent-approvals.spec';
import type { ChatRetention } from './agent-data.spec';
import type { AgentMcpView } from './agent-mcp.spec';
import { MAX_OUTPUT_TOKENS, type KeyProtection } from './agent-proxy.spec';
import type { AgentToolRisk, ModelId, ModelRoute, ToolErrorCode } from './agent-tools.spec';
import type { SkillInputSlot } from './skills.spec';

// ---- Bounds ----------------------------------------------------------------------------------

/** The longest message the user may send (characters; the protocol allows more, `maxMessageChars`). */
export const CHAT_TEXT_MAX_CHARS = 32_000;
/** A chat's title: the first line of its first message, cut (characters). */
export const CHAT_TITLE_MAX_CHARS = 80;
/**
 * Chats kept in memory; past it the least recently used idle chat is dropped (Task 9 stores the same
 * most recent chats on disk, `MAX_STORED_CHATS`). A running chat is never dropped.
 */
export const MAX_CHATS_KEPT_IN_MEMORY = 50;
/** Entries (user messages and assistant steps) the panel is sent for the selected chat: the latest. */
export const MAX_DISPLAY_ENTRIES = 200;
/** A tool card's input preview (JSON text, characters; the approval card shows the whole input). */
export const TOOL_CARD_INPUT_PREVIEW_CHARS = 1000;
/** A tool card's output preview (JSON text of the untrusted data, or the error message; characters). */
export const TOOL_CARD_OUTPUT_PREVIEW_CHARS = 2000;
/**
 * Tool cards one turn may show: the broker's `MAX_TOOL_CALLS_PER_TURN`. A turn's `chat.step`s are
 * capped at `MAX_TOOL_STEPS`. Past either, main ignores what the runtime sends and counts a strike.
 */
export const MAX_TOOL_CARDS_PER_TURN = MAX_TOOL_CALLS_PER_TURN;
/**
 * How long a turn may go on after Stop before main ends it itself and restarts the runtime
 * (milliseconds): a runtime that ignores `chat.stop` can't keep every send `busy`.
 */
export const STOP_DEADLINE_MS = 5_000;
/** The chat's error when that happens. */
export const STOP_DEADLINE_MESSAGE = 'The agent did not stop in time, so frost restarted it.';
/** Streaming text is published at most this often (milliseconds), so long-polls aren't flooded. */
export const AGENT_DELTA_COALESCE_MS = 50;
/**
 * How long `agent.watch` waits for a change before answering the current state (milliseconds): the
 * same as `browser.watch`'s `WATCH_TIMEOUT_MS` (`browser.spec.ts`, which needs Zod; a test keeps
 * them equal).
 */
export const AGENT_WATCH_TIMEOUT_MS = 25_000;
/** At most this many `agent.watch` calls wait at once; one more answers the oldest early. */
export const MAX_PENDING_AGENT_WATCHES = 4;
/**
 * After an approval card appears, how long its Allow buttons stay disabled (milliseconds), so a
 * click meant for something else can't approve it (Task 4 review; the panel enforces it).
 */
export const APPROVAL_ENABLE_DELAY_MS = 500;
/** What an `execute_javascript` approval card says beside the code (Task 5 review). */
export const EXECUTE_JS_APPROVAL_NOTE = 'Runs alongside any code you allowed earlier on this page.';
/**
 * What a `run_visibility_probes` approval card says (Task 8, the SERP wiring): what frost will
 * actually do, plainly. Phase 3's probes fetch the page once per agent it models (its own browser,
 * then search and AI crawlers, each with that crawler's user agent) and read the site's robots.txt.
 */
export const RUN_PROBES_APPROVAL_NOTE =
  "frost will fetch this page as search and AI crawlers would: one request as its own browser and one with each crawler's user agent it models, plus the site's robots.txt. The site sees these requests.";

/**
 * Each allowed model's context window (tokens), for the context meter; `null` where frost has no
 * published figure to rely on (the meter then shows tokens without a percentage). The Anthropic
 * figures are the provider's documented ones; the OpenAI ones are left `null` because the installed
 * provider package publishes none, and frost doesn't guess.
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<ModelId, number | null>> = {
  'anthropic/claude-sonnet-5-5': 1_000_000,
  'anthropic/claude-opus-5-5': 1_000_000,
  'openai/gpt-5': null,
  'openai/gpt-5-mini': null,
};

// ---- The e2e seam ----------------------------------------------------------------------------

// ---- The history a turn sends (whole-branch review) ---------------------------------------------

/**
 * Characters per token assumed when fitting a chat's history to a model's context window. Low on
 * purpose: JSON tool output and text in many languages run at about three characters per token or
 * fewer, and overestimating the room is what makes every later turn fail.
 */
export const HISTORY_CHARS_PER_TOKEN = 3;
/** Tokens kept free beside the history (besides `MAX_OUTPUT_TOKENS`): the system prompt and the tools' definitions. */
export const HISTORY_HEADROOM_TOKENS = 24_000;
/** The context window assumed for a model with no published figure (`MODEL_CONTEXT_WINDOWS` `null`). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/**
 * The most of a chat's history main keeps in memory and sends, as the JSON text of its messages
 * (characters): past it the oldest tool outputs are shortened first, then the oldest exchanges go.
 */
export const CHAT_HISTORY_MAX_CHARS = 1_000_000;
/** The most of a chat's display entries kept in memory (their text and card previews, characters). */
export const CHAT_ENTRIES_MAX_CHARS = 500_000;
/** The least a turn's history may be given, whatever the model (characters): a long message fits. */
export const HISTORY_MIN_BUDGET_CHARS = 80_000;
/** What a shortened tool result says instead of its data (still wrapped untrusted, still paired with its call). */
export const OMITTED_TOOL_OUTPUT = '[older tool output omitted]';

/**
 * The characters of history a turn on `modelId` may send: its context window (or
 * `DEFAULT_CONTEXT_WINDOW_TOKENS`) less the output cap and `HISTORY_HEADROOM_TOKENS`, at
 * `HISTORY_CHARS_PER_TOKEN`, less `reservedChars` (what else the request carries: the system
 * prompt, MCP tool definitions), within `HISTORY_MIN_BUDGET_CHARS`–`CHAT_HISTORY_MAX_CHARS`.
 */
export function historyBudgetChars(modelId: ModelId, reservedChars = 0): number {
  const window = MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const chars = (window - MAX_OUTPUT_TOKENS - HISTORY_HEADROOM_TOKENS) * HISTORY_CHARS_PER_TOKEN - Math.max(0, reservedChars);
  return Math.min(CHAT_HISTORY_MAX_CHARS, Math.max(HISTORY_MIN_BUDGET_CHARS, Math.floor(chars)));
}

/**
 * The e2e seam's switch (unpackaged builds only; a packaged build refuses to start with it,
 * `PACKAGED_FORBIDDEN_SWITCHES`): `--frost-e2e-agent-script=<file>` names a JSON script
 * (`AgentE2eScriptSchema`, `agent-e2e-script.schema.ts`) that the runtime plays as its model instead
 * of a provider, with no model request at all. With it, a turn needs no stored key.
 */
export const AGENT_E2E_SCRIPT_SWITCH = 'frost-e2e-agent-script' as const;
/** The runtime's environment variable carrying the script (its canonical JSON text). */
export const AGENT_E2E_SCRIPT_ENV = 'FROST_E2E_AGENT_SCRIPT' as const;
/** The longest script (canonical JSON text, characters; also bounds the file read). */
export const AGENT_E2E_SCRIPT_MAX_CHARS = 64_000;

// ---- Answers ---------------------------------------------------------------------------------

/**
 * `agent.send`'s answer:
 * - `started`: the turn is running (its progress shows in `agent.watch`);
 * - `busy`: a turn is already running (one at a time, app-wide; nothing queued);
 * - `setup-needed`: the selected route has no usable key;
 * - `not-entitled`: the agent isn't available on this plan;
 * - `no-tab`: no tab to work on;
 * - `unknown-chat`: no such chat;
 * - `invalid`: empty text, or a skill input the skill doesn't declare;
 * - `unavailable`: the agent process couldn't be started, or refused the turn;
 * - `unknown-skill`: no such skill (Task 7).
 */
export const AGENT_SEND_RESULTS = ['started', 'busy', 'setup-needed', 'not-entitled', 'no-tab', 'unknown-chat', 'invalid', 'unavailable', 'unknown-skill'] as const;
export type AgentSendResult = (typeof AGENT_SEND_RESULTS)[number];

/** `agent.setKey`'s answer (main's key store's; never the key). */
export const AGENT_SET_KEY_RESULTS = ['stored', 'invalid', 'no-keychain', 'failed'] as const;
export type AgentSetKeyResult = (typeof AGENT_SET_KEY_RESULTS)[number];

/**
 * `agent.answerApproval`'s answer: `answered` (allowed once or denied), `granted` (allowed, and a
 * standing grant stored), `unknown` (no such pending request: answered, expired, never existed),
 * `not-grantable` (Allow for this site where it can't be granted; still pending), `invalid`.
 */
export const AGENT_ANSWER_RESULTS = ['answered', 'granted', 'unknown', 'not-grantable', 'invalid'] as const;
export type AgentAnswerResult = (typeof AGENT_ANSWER_RESULTS)[number];

// ---- The state -------------------------------------------------------------------------------

/** The agent process, as the host reports it. */
export type AgentRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'crashed';
export type AgentRuntimeFailure = 'exited' | 'ready-timeout' | 'protocol-mismatch' | 'fork-failed' | 'misbehaved' | 'unresponsive';

/** What the agent process's isolation is, said plainly (plan decision 6); never claims more. */
export interface AgentIsolationView {
  /** Whether the running (or last) runtime reported its network globals removed. */
  readonly networkGlobalsRemoved: boolean;
  /** Whether a file sandbox is in effect (Node's permission model): `false` on Electron 45. */
  readonly fileSandbox: boolean;
  /** One plain sentence for the settings page. */
  readonly note: string;
}

export interface AgentSetupView {
  readonly route: ModelRoute;
  readonly modelId: ModelId;
  /** The models the selected route serves. */
  readonly allowedModels: readonly ModelId[];
  /** Whether each slot holds a usable key (never the key). */
  readonly keys: { readonly anthropic: boolean; readonly openai: boolean; readonly gateway: boolean };
  /** Whether a turn can start: the route's key is set (or the e2e seam is on). */
  readonly ready: boolean;
  readonly protection: KeyProtection;
  readonly runtime: { readonly status: AgentRuntimeStatus; readonly lastFailure: AgentRuntimeFailure | null };
  readonly isolation: AgentIsolationView;
}

export interface AgentChatSummary {
  readonly id: string;
  readonly title: string;
  /** The tab the chat works on (the active tab when its first message was sent). */
  readonly tabId: number | null;
  readonly updatedAt: number;
  readonly running: boolean;
}

/** A tool call's card. Its output preview is untrusted page or third-party data: shown as inert text only. */
export interface AgentToolCardView {
  readonly callId: string;
  readonly toolName: string;
  /** The catalogue's label (or the MCP tool's). */
  readonly label: string;
  /** `requested` until main's broker has it; then the broker's status. */
  readonly status: 'requested' | ToolActivityStatus;
  /** The error code it ended with, `null` otherwise. */
  readonly code: ToolErrorCode | null;
  /** The input (JSON text), cut at `TOOL_CARD_INPUT_PREVIEW_CHARS`. */
  readonly inputPreview: string;
  /** The output main produced (the untrusted data's JSON text, or the error message), cut; `null` until there is one. */
  readonly outputPreview: string | null;
}

export type AgentMessageView =
  | {
      readonly kind: 'user';
      readonly id: string;
      /** What the user typed: the message, or a skill run's note (`''` without one). */
      readonly text: string;
      /** The skill this message ran (Task 7): the chat shows its name, never its template. Absent for a typed message. */
      readonly skill?: { readonly id: string; readonly name: string };
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly text: string;
      readonly tools: readonly AgentToolCardView[];
      /** Still streaming (the step hasn't ended). */
      readonly streaming: boolean;
    };

export interface AgentUsageView {
  /** The last turn's tokens, summed over its steps (`null`: not reported). */
  readonly input: number | null;
  readonly output: number | null;
}

export interface AgentActiveChatView {
  readonly id: string;
  readonly title: string;
  readonly tabId: number | null;
  /** The latest `MAX_DISPLAY_ENTRIES` entries, oldest first. */
  readonly messages: readonly AgentMessageView[];
  /** Whether earlier entries were left out. */
  readonly truncated: boolean;
  readonly running: boolean;
  /** The last turn's failure (shown as a banner), `null` otherwise. */
  readonly error: string | null;
  readonly usage: AgentUsageView | null;
  /** The context the next request starts from: the last step's input plus output tokens (`null`: unknown). */
  readonly contextTokens: number | null;
  /** The model's context window (`MODEL_CONTEXT_WINDOWS`), `null` when unknown. */
  readonly contextWindow: number | null;
  /** The model the last turn used, `null` before one ran. */
  readonly modelId: ModelId | null;
}

/** An approval request as the panel shows it (main's broker's view, field for field). */
export interface AgentApprovalView {
  readonly id: string;
  readonly chatId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly label: string;
  readonly risk: AgentToolRisk;
  readonly origin: string | null;
  readonly pageUrl: string | null;
  /** The exact canonical input (JSON text), in full. */
  readonly input: string;
  readonly inputSha256: string;
  /** `execute_javascript`'s exact code, `null` for other tools. */
  readonly code: string | null;
  readonly grantable: boolean;
  /** `EXECUTE_JS_APPROVAL_NOTE` for `execute_javascript`, `null` otherwise. */
  readonly note: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A notice the panel shows once (refused sends), with the version it was raised at. */
export interface AgentNoticeView {
  readonly kind: Exclude<AgentSendResult, 'started'>;
  readonly message: string;
  readonly seq: number;
}

/** A skill the panel can run (Task 7; main's `SkillRegistry`): what the picker shows, never its template. */
export interface AgentSkillView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The fields the user may fill (each optional), in the skill's order. */
  readonly inputs: readonly { readonly slot: SkillInputSlot; readonly label: string; readonly placeholder: string | null }[];
  /** frost's own (read-only) skill, or the user's (Task 9's editor). */
  readonly builtin: boolean;
}

/**
 * A skill run, as `agent.send` takes it instead of text (Task 7): the skill's id and the inputs it
 * declares (`agent-ipc.schema.ts` bounds them). Main resolves the id, renders the skill with these
 * and the tab's page, and narrows the turn's tools to the skill's.
 */
export interface AgentSkillRequest {
  readonly skillId: string;
  readonly userNote?: string | undefined;
  readonly targetQuery?: string | undefined;
}

export interface AgentState {
  /** Raised on every change. */
  readonly version: number;
  readonly setup: AgentSetupView;
  /** The skills that can run (Task 7), in the picker's order. */
  readonly skills: readonly AgentSkillView[];
  /** Every chat, most recently updated first. */
  readonly chats: readonly AgentChatSummary[];
  /** The selected chat; `null` for a new, empty one. */
  readonly active: AgentActiveChatView | null;
  /** Whether any turn is running (one at a time, app-wide). */
  readonly running: boolean;
  /** The oldest pending approval (of any chat) and how many more wait behind it. */
  readonly approval: { readonly request: AgentApprovalView; readonly queued: number } | null;
  readonly notice: AgentNoticeView | null;
  /** Whether read tools run without asking (the grants page, Task 9). */
  readonly readToolsAllowed: boolean;
  /** Standing grants stored. */
  readonly grantsCount: number;
  /** Raised whenever the grants change (the grants page then reads `agent.listGrants` again; Task 9). */
  readonly grantsVersion: number;
  /** How long chats are kept on disk (Task 9, `agent-data.spec.ts`). */
  readonly chatRetention: ChatRetention;
  /** The MCP servers and whether they may be used (Task 10, `agent-mcp.spec.ts`). Never a token or an environment value. */
  readonly mcp: AgentMcpView;
}

/** What a refused send says (the panel shows it as a notice). */
export const AGENT_NOTICE_MESSAGES: Readonly<Record<AgentNoticeView['kind'], string>> = {
  busy: 'The agent is already answering. Stop it or wait for it to finish.',
  'setup-needed': 'Add a key for the selected model route in the agent settings first.',
  'not-entitled': 'The agent is not available on this plan.',
  'no-tab': 'Open a tab for the agent to work on first.',
  'unknown-chat': 'That chat is no longer available.',
  invalid: 'Type a message first.',
  unavailable: 'The agent could not be started. Try again.',
  'unknown-skill': 'That skill is no longer available.',
};

/** Re-exported for the panel's approval buttons. */
export type { ApprovalDecision };
