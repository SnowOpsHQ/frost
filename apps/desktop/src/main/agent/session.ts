import { randomUUID } from 'node:crypto';
import { cleanSlotValue, createBuiltinSkillRegistry, renderSkill, type Skill, type SkillRegistry } from '@app/ai-skills/skills';
import type { AgentService } from '@app/ipc-contract';
import { isApprovalDecision, type ApprovalDecision, type ToolActivityStatus } from '@app/specs/agent-approvals.spec';
import { CHATGPT_SETUP_MESSAGES, chatgptFailureMessage, chatgptSetupReason, type ChatgptFailure, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { AGENT_PROTOCOL_LIMITS, CHAT_BUSY_MESSAGE, type ChatMessage, type LockdownTarget, type ToolCall, type ToolResult } from '@app/specs/agent-protocol.schema';
import { routeCredentialSlot, type AgentModelSettings, type CredentialSlot, type KeyProtection } from '@app/specs/agent-proxy.spec';
import { effectiveEffort, isReasoningEffort, reasoningLevels, type ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import {
  AGENT_DELTA_COALESCE_MS,
  AGENT_NOTICE_MESSAGES,
  AGENT_SET_KEY_RESULTS,
  CHAT_ENTRIES_MAX_CHARS,
  CHAT_HISTORY_MAX_CHARS,
  CHAT_TEXT_MAX_CHARS,
  CHAT_TITLE_MAX_CHARS,
  EXECUTE_JS_APPROVAL_NOTE,
  RUN_PROBES_APPROVAL_NOTE,
  MAX_CHATS_KEPT_IN_MEMORY,
  historyBudgetChars,
  MAX_DISPLAY_ENTRIES,
  OMITTED_TOOL_OUTPUT,
  MAX_PENDING_AGENT_WATCHES,
  MAX_TOOL_CARDS_PER_TURN,
  modelContextWindow,
  STOP_DEADLINE_MESSAGE,
  STOP_DEADLINE_MS,
  TOOL_CARD_INPUT_PREVIEW_CHARS,
  TOOL_CARD_OUTPUT_PREVIEW_CHARS,
  type AgentAnswerResult,
  type AgentApprovalView,
  type AgentChatgptView,
  type AgentChatSummary,
  type AgentIsolationView,
  type AgentMessageView,
  type AgentNoticeView,
  type AgentReasoningView,
  type AgentSendResult,
  type AgentSetKeyResult,
  type AgentSkillRequest,
  type AgentSkillView,
  type AgentState,
  type AgentToolCardView,
  type AgentUsageView,
} from '@app/specs/agent-session.spec';
import { AGENT_TOOL_NAMES, ALLOWED_MODEL_IDS, CHAT_MAX_MESSAGES, isMcpToolName, MAX_TOOL_STEPS, routeModelId, type AgentModelId, type AgentToolName, type ModelRoute, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import { MCP_LIMITS, type AgentMcpView } from '@app/specs/agent-mcp.spec';
import type { McpToolDefinition } from '@app/specs/agent-mcp.schema';
import type { ChatgptRoute } from './chatgpt/route';
import type { ChatgptAuth } from './chatgpt/service';
import { BUILTIN_SKILL_CATEGORY, BUILTIN_SKILL_IDS, isSkillId, SKILL_INPUT_SLOTS, SKILL_SLOT_MAX_CHARS, skillPageUrl as skillPageUrlOf, type BuiltinSkillId, type SkillInputSlot } from '@app/specs/skills.spec';
import {
  DEFAULT_CHAT_RETENTION,
  isChatRetention,
  retentionCutoff,
  type AgentSetRetentionResult,
  type AgentDeleteAllChatsResult,
  type AgentGrantView,
  type AgentSaveSkillResult,
  type AgentSkillDetail,
  type AgentSkillImportPreviewResult,
  type AgentSkillImportResult,
  type ChatExportFormat,
  type ChatExportResult,
  type ChatRetention,
  type SkillExportResult,
} from '@app/specs/agent-data.spec';
import { toolLabel, type ApprovalBroker, type ApprovalRequestView } from './approvals';
import type { ChatHistory } from './chat-history';
import type { ChatHead, ChatSnapshot, EntrySnapshot } from './chat-record';
import type { CredentialSettings } from './credentials';
import type { AgentEntitlements } from './entitlements';
import type { AgentGrants } from './grants';
import { AGENT_CRASHED_MESSAGE, type AgentChatEvent, type AgentHost } from './host';
import type { AgentSettings } from './settings';
import type { SkillFiles } from './skill-files';
import { AGENT_SYSTEM_PROMPT } from './system-prompt';
import { skillDetail, type UserSkills } from './user-skills';
import type { McpManager } from './mcp';

// The agent's chat session manager (Phase 5 Task 6a; spec `specs/agent-session.spec.ts`; acceptance
// `specs/agent-session.feature.md`, Session). Main keeps the chats (in memory until Task 9) and runs
// one turn at a time, app-wide: it registers the turn with the approval broker, posts `chat.start`
// with frost's system prompt, the configured model and the chat's history, and follows the turn's
// `chat.*` events, the broker's tool activity and results, and the host's status into the panel's
// `AgentState` (`watch` long-polls it). The history it sends the model is built only from what main
// knows: the user's messages, each step the runtime reported (`chat.step`: text and the calls main
// was asked to run) and the tool results main's broker produced, paired the way the runtime
// expects (a call left unanswered gets the runtime's own "aborted" result). The state never holds a
// key: the key store answers `hasKey` only, and tool output appears only as bounded preview text.
//
// A skill run (Task 7; acceptance `specs/skills.feature.md`, Running) is a send whose message is a
// skill id and the inputs it declares: main resolves the id through its `SkillRegistry`, renders the
// skill with the tab's page and the user's inputs as quoted data (`renderSkill`), sends that as the
// user turn, and offers the model only the skill's tools for the turn (`chat.start.allowedTools` and
// the broker's registration alike). The chat shows the skill's name and the note, not the template.
//
// Task 9 (acceptance `specs/agent-data.feature.md`): a chat is saved (`ChatHistory`, unless the
// retention is `off`) each time one of its turns ends and removed when the user deletes it; the
// stored chats are restored at startup (`restore`, without a tab: the next message binds the active
// one) and pruned with the retention. The grants page's revokes, the read-tools switch, the
// retention, "Delete all chats" (after main's own confirmation), export (`exportChat`, through
// main's save dialog) and the skills editor (`UserSkills`) all go through here, as do skills files
// (Phase 8 Task 6, `SkillFiles`: export, and import after the user reviewed the file).

export interface AgentSessionDeps {
  readonly host: Pick<AgentHost, 'send' | 'onChat' | 'onStatus' | 'status' | 'lastFailure' | 'lockdown' | 'activeChats' | 'strike' | 'restart'>;
  readonly approvals: Pick<ApprovalBroker, 'register' | 'unregister' | 'forget' | 'pending' | 'activity' | 'onChange' | 'onResult' | 'answer'>;
  readonly credentials: CredentialSettings;
  /** `chatgptModels`: the account's last list, as main's proxy reads it (the levels a ChatGPT model offers). */
  readonly settings: Pick<AgentSettings, 'current' | 'set' | 'onChange'> & Partial<Pick<AgentSettings, 'chatgptModels'>>;
  readonly entitlements: AgentEntitlements;
  readonly grants: Pick<AgentGrants, 'list' | 'readToolsAllowed' | 'onChange' | 'revoke' | 'revokeAll' | 'setReadToolsAllowed'>;
  /** Loads the settings and grants and starts the runtime (`createAgent().start`): `false` if it failed. */
  readonly start: () => Promise<boolean>;
  /** The tab a new chat works on: the active tab. */
  readonly activeTabId: () => number | null;
  /** The skills that can run (default: the built-ins; Task 9 composes the user's with them). */
  readonly skills?: SkillRegistry;
  /** A tab's page as a skill sees it: its URL and title (`null`s for none). Default: nothing known. */
  readonly tabPage?: (tabId: number) => { readonly url: string | null; readonly title: string | null } | null;
  /** The e2e seam is on: the runtime plays a script, so a turn needs no key. */
  readonly scripted?: boolean;
  /** Where chats are stored (Task 9); default: nowhere (chats live in memory, retention reads the default). */
  readonly history?: ChatHistory;
  /** The skills editor (Task 9); default: none (the built-ins only, read-only). */
  readonly userSkills?: Pick<UserSkills, 'detail' | 'save' | 'remove' | 'duplicate' | 'onChange' | 'isBuiltin' | 'enabled' | 'setEnabled'>;
  /** Asks the user, in main's own dialog, before every chat is deleted; default: never confirmed. */
  readonly confirmDeleteAllChats?: () => Promise<boolean>;
  /** Asks, in main's own dialog, before a retention change deletes `chats` stored chats; default: never confirmed. */
  readonly confirmRetentionChange?: (retention: ChatRetention, chats: number) => Promise<boolean>;
  /** Writes a chat's export where the user chooses, in main's own save dialog; default: `failed`. */
  readonly exportChat?: (chat: ChatSnapshot, format: ChatExportFormat) => Promise<ChatExportResult>;
  /** Skills files (Phase 8 Task 6, `./skill-files`): export and the reviewed import, through main's dialogs; default: none (`failed`). */
  readonly skillFiles?: SkillFiles;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Chat ids (default `crypto.randomUUID`). */
  readonly randomId?: () => string;
  /** One line per event; never a message, a tool's input or output, or a key. */
  readonly log?: (line: string) => void;
  /**
   * MCP servers (Task 10, `./mcp`): the tools a typed turn may also offer (never a skill's), their
   * labels, the settings' view and the server procedures. Default: none.
   */
  readonly mcp?: Pick<McpManager, 'toolsForChat' | 'labelOf' | 'view' | 'onChange' | 'save' | 'remove' | 'setEnabled' | 'start' | 'stop' | 'setToken'>;
  /**
   * The ChatGPT plan route (`./chatgpt/route.ts`, plan `agent-chatgpt-plan.md` Task 3): the account's
   * view and models for the setup, whether a turn may start on it, and the plan failures main's
   * proxy reports (shown on the running turn instead of the runtime's words). Default: none (the
   * route reads as signed out and is never ready).
   */
  readonly chatgpt?: Pick<ChatgptRoute, 'view' | 'ready' | 'onChange' | 'onFailure'> & { readonly auth?: Pick<ChatgptAuth, 'signIn' | 'cancel' | 'signOut' | 'acknowledge'> };
  /**
   * Spends app window `windowId`'s live user gesture (the account's per-window tracker, as Search
   * Console's connect): a ChatGPT sign-in opens the browser only after it. Default: none (every
   * sign-in answers `needs-gesture`).
   */
  readonly consumeGesture?: (windowId: number) => boolean;
}

export interface AgentSession extends AgentService {
  /** Reads which keys are set and how they'd be protected (after start-up; `send` and `setKey` do it too). */
  refreshSetup(): Promise<void>;
  /**
   * Adds stored chats (their own rows, most recent first) to the ones in memory, within
   * `MAX_CHATS_KEPT_IN_MEMORY`; their messages are read when one is opened. An id already open, or
   * one deleted (or "Delete all") before this ran, is skipped. Once.
   */
  restore(chats: readonly ChatHead[]): void;
  /** Reads a restored chat's messages if they aren't yet (selecting, sending to or exporting it does too). */
  loadChat(chatId: string): Promise<void>;
  /**
   * For Clear Browsing Data (the lead's wiring, the plan's lead follow-ups): revokes every standing
   * grant, with no dialog of the agent's own. `false` if it couldn't be written.
   */
  forgetAgentGrants(): Promise<boolean>;
  /** For Clear Browsing Data's "Also delete agent chats": deletes every chat with no dialog of the agent's own. */
  deleteAllChatsUnconfirmed(): Promise<boolean>;
  /** A chat as it would be stored or exported now, or `null`. */
  snapshot(chatId: string): ChatSnapshot | null;
  /** Deletes what the retention no longer keeps, stored and idle in memory (startup, daily). */
  prune(): Promise<void>;
  dispose(): void;
}

interface ToolCard {
  readonly callId: string;
  readonly toolName: string;
  readonly label: string;
  status: 'requested' | ToolActivityStatus;
  code: ToolErrorCode | null;
  readonly inputPreview: string;
  outputPreview: string | null;
}

interface Entry {
  readonly id: string;
  readonly kind: 'user' | 'assistant';
  text: string;
  readonly tools: ToolCard[];
  streaming: boolean;
  /** The skill a user entry ran. */
  readonly skill?: { readonly id: string; readonly name: string };
}

/** An entry's size in memory, roughly: its text and its cards' previews (characters). */
const entrySize = (entry: Entry): number => entry.text.length + entry.tools.reduce((sum, card) => sum + card.inputPreview.length + (card.outputPreview?.length ?? 0) + 64, 0);

/** A skill run, resolved and checked (before the turn is held). */
interface SkillRun {
  readonly skill: Skill;
  readonly inputs: { readonly [S in SkillInputSlot]?: string };
}

interface Chat {
  readonly id: string;
  readonly title: string;
  /** The tab it works on; `null` for a chat restored from disk until its next message binds one. */
  tabId: number | null;
  readonly createdAt: number;
  updatedAt: number;
  /** What the model is sent (protocol shape). */
  history: ChatMessage[];
  entries: Entry[];
  /** Whether earlier entries (or history messages) were dropped from memory. */
  truncated: boolean;
  error: string | null;
  /** When `error` is the ChatGPT plan's failure (main's reading, `AgentActiveChatView.chatgptError`); absent otherwise. */
  chatgptError?: ChatgptFailure;
  usage: AgentUsageView | null;
  contextTokens: number | null;
  modelId: AgentModelId | null;
  /** Whether its messages are in memory (`false` for a restored chat until it is opened). */
  loaded: boolean;
  loading: Promise<void> | null;
  /** The rows stored on disk (where the next save appends), `null` when the next save must write the whole chat. */
  stored: { messages: number; entries: number } | null;
}

/** The one turn running, app-wide. */
interface Turn {
  /** `starting`: checks and the runtime's start are awaited (no chat id yet for a new chat). */
  phase: 'starting' | 'running';
  chat: Chat | null;
  stopping: boolean;
  /** The assistant entry streaming now (the step not yet reported). */
  entry: Entry | null;
  /** Main's results for calls whose step hasn't been reported yet. */
  readonly results: Map<string, Extract<ChatMessage, { role: 'tool' }>>;
  /** Every card of the turn, by call id. */
  readonly cards: Map<string, ToolCard>;
  /** The calls the runtime reported (`chat.tool-call`), with their full input, in order. */
  readonly calls: Map<string, ToolCall>;
  /** The calls already written to the history by a step. */
  readonly landed: Set<string>;
  /** Steps reported (at most `MAX_TOOL_STEPS`). */
  steps: number;
  /** Ends the turn locally if the runtime ignores Stop (`STOP_DEADLINE_MS`). */
  stopTimer: unknown;
  /** The chat as it was before the user's message (a refused send changes nothing). */
  before: {
    readonly error: string | null;
    readonly chatgptError: ChatgptFailure | undefined;
    readonly modelId: AgentModelId | null;
    readonly updatedAt: number;
    readonly selected: string | null;
    readonly created: boolean;
  } | null;
  /** The route the turn runs on (set when `chat.start` is posted). */
  route?: ModelRoute;
  /** The first ChatGPT plan failure main's proxy reported during the turn (shown if the turn fails). */
  chatgptFailure?: ChatgptFailure;
  /** Whether the runtime said anything for this turn (a busy reply comes before anything else). */
  sawOutput: boolean;
  /** The history's and entries' lengths before the user's message (to take it back). */
  historyBefore: number;
  entriesBefore: number;
}

const NETWORK_TARGETS: readonly LockdownTarget[] = ['fetch', 'WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest'];
/** The tools a turn offers when it runs no skill: the whole catalogue. */
const ALL_TOOLS: readonly AgentToolName[] = AGENT_TOOL_NAMES;
const L = AGENT_PROTOCOL_LIMITS;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `text` cut at `max` characters, never between a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/** A chat's title: the first non-empty line of its first message, trimmed and cut. */
export function chatTitle(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  return cutText(line.trim().replace(/\s+/g, ' '), CHAT_TITLE_MAX_CHARS);
}

/**
 * The part of `history` a turn sends: at most `CHAT_MAX_MESSAGES` messages, starting at a user
 * message. When the latest messages alone don't start at one (one long turn of tool calls), it keeps
 * the nearest user message before them, then the latest messages from an assistant message on, so
 * the model keeps both what it was asked and what it did last (never an orphaned result).
 */
export function historyWindow(history: readonly ChatMessage[]): ChatMessage[] {
  const cut = history.length - CHAT_MAX_MESSAGES;
  if (cut <= 0) return history.slice();
  let anchor = -1;
  for (let index = cut; index >= 0; index -= 1) {
    if (history[index]!.role === 'user') {
      anchor = index;
      break;
    }
  }
  if (anchor === -1) {
    // No user message that early: the first one after it (the window then fits on its own).
    anchor = cut;
    while (anchor < history.length && history[anchor]!.role !== 'user') anchor += 1;
    return history.slice(anchor);
  }
  if (anchor === cut) return history.slice(anchor);
  let tail = Math.max(anchor + 1, history.length - (CHAT_MAX_MESSAGES - 1));
  while (tail < history.length && history[tail]!.role === 'tool') tail += 1;
  return [history[anchor]!, ...history.slice(tail)];
}

const messageChars = (message: ChatMessage): number => JSON.stringify(message).length;

/** `message`'s result with its data replaced by `OMITTED_TOOL_OUTPUT` (same call, same source, still untrusted). */
function omittedResult(message: Extract<ChatMessage, { role: 'tool' }>): Extract<ChatMessage, { role: 'tool' }> {
  const source = message.result.ok ? message.result.output.source : message.toolName;
  return { role: 'tool', callId: message.callId, toolName: message.toolName, result: { ok: true, output: { untrusted: true, source, data: OMITTED_TOOL_OUTPUT } } };
}

/**
 * `history` within `maxChars` (the JSON text of its messages): the oldest tool outputs are
 * shortened first (`OMITTED_TOOL_OUTPUT`, each still answering its call), then the oldest exchanges
 * (a user message and everything up to the next one) are dropped; the last exchange always stays.
 * Unchanged (the same messages) when it already fits.
 */
export function compactHistory(history: readonly ChatMessage[], maxChars: number): ChatMessage[] {
  const out = history.slice();
  let total = out.reduce((sum, message) => sum + messageChars(message), 0);
  for (let index = 0; index < out.length && total > maxChars; index += 1) {
    const message = out[index]!;
    if (message.role !== 'tool') continue;
    const short = omittedResult(message);
    const saved = messageChars(message) - messageChars(short);
    if (saved <= 0) continue;
    out[index] = short;
    total -= saved;
  }
  while (total > maxChars) {
    let next = 1;
    while (next < out.length && out[next]!.role !== 'user') next += 1;
    if (next >= out.length) break;
    for (const message of out.splice(0, next)) total -= messageChars(message);
  }
  return out;
}

/**
 * Appends main's result for `callId` to `history` when it answers a call of the last assistant
 * message and only results follow that message (the pairing the runtime reads, `toModelMessages`);
 * `false` (nothing appended) otherwise.
 */
export function attachToolResult(history: ChatMessage[], message: Extract<ChatMessage, { role: 'tool' }>): boolean {
  let index = history.length - 1;
  while (index >= 0 && history[index]!.role === 'tool') {
    if ((history[index] as Extract<ChatMessage, { role: 'tool' }>).callId === message.callId) return false;
    index -= 1;
  }
  const assistant = history[index];
  if (assistant?.role !== 'assistant' || !assistant.toolCalls.some((call) => call.callId === message.callId)) return false;
  history.push(message);
  return true;
}

function outputPreview(result: ToolResult): string {
  if (!result.ok) return cutText(result.error.message, TOOL_CARD_OUTPUT_PREVIEW_CHARS);
  return cutText(JSON.stringify(result.output.data) ?? 'null', TOOL_CARD_OUTPUT_PREVIEW_CHARS);
}

function approvalView(request: ApprovalRequestView): AgentApprovalView {
  // Field by field: nothing the broker might add later reaches the renderer unreviewed.
  return {
    id: request.id,
    chatId: request.chatId,
    callId: request.callId,
    toolName: request.toolName,
    label: request.label,
    risk: request.risk,
    origin: request.origin,
    pageUrl: request.pageUrl,
    input: request.input,
    inputSha256: request.inputSha256,
    code: request.code,
    grantable: request.grantable,
    note: request.toolName === 'execute_javascript' ? EXECUTE_JS_APPROVAL_NOTE : request.toolName === 'run_visibility_probes' ? RUN_PROBES_APPROVAL_NOTE : null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

/** A skill as the panel's picker shows it (field by field: never its template). */
function skillView(skill: Skill, builtin: boolean, enabled: boolean): AgentSkillView {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    inputs: (skill.inputs ?? []).map((input) => ({ slot: input.slot, label: input.label, placeholder: input.placeholder ?? null })),
    builtin,
    category: builtin && Object.hasOwn(BUILTIN_SKILL_CATEGORY, skill.id) ? BUILTIN_SKILL_CATEGORY[skill.id as BuiltinSkillId] : 'yours',
    enabled,
  };
}

/**
 * A stored history as the model may be sent it: from its first user message on, each tool result
 * kept only where it answers a call of the assistant message before it (`attachToolResult`), so
 * a history with a row left out never pairs a result with the wrong call.
 */
export function pairedHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      attachToolResult(out, message);
      continue;
    }
    if (out.length === 0 && message.role !== 'user') continue;
    out.push(message);
  }
  return out;
}

/** What a skill run's user entry says: the page it ran on, the target query and the note the user gave (`''` for none). */
function skillEntryText(inputs: SkillRun['inputs'], pageUrl: string | null = null): string {
  const lines: string[] = [];
  if (pageUrl !== null) lines.push(`Page: ${pageUrl}`);
  if (inputs.targetQuery !== undefined) lines.push(`Target query: ${inputs.targetQuery}`);
  if (inputs.userNote !== undefined) lines.push(inputs.userNote);
  return lines.join('\n');
}

export function isolationView(lockdown: ReturnType<AgentHost['lockdown']>): AgentIsolationView {
  if (lockdown === null) return { networkGlobalsRemoved: false, fileSandbox: false, note: 'The agent process has not started yet.' };
  const networkGlobalsRemoved = lockdown.removed.includes('fetch') && !lockdown.failed.some((target) => NETWORK_TARGETS.includes(target));
  const fileSandbox = lockdown.permissionModel;
  const sandbox = fileSandbox
    ? 'The agent process runs as you, with file access limited to its own files.'
    : 'The agent process runs as you, without an OS sandbox or file restrictions.';
  const network = networkGlobalsRemoved ? 'It holds no key and its network functions are removed' : 'It holds no key, but some of its network functions could not be removed';
  return { networkGlobalsRemoved, fileSandbox, note: `${sandbox} ${network}; frost decides every action and every model request.` };
}

export function createAgentSession(deps: AgentSessionDeps): AgentSession {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const randomId = deps.randomId ?? randomUUID;
  const log = deps.log ?? (() => undefined);
  const scripted = deps.scripted === true;
  const skills = deps.skills ?? createBuiltinSkillRegistry();
  const tabPage = deps.tabPage ?? (() => null);
  const history = deps.history ?? null;
  const userSkills = deps.userSkills ?? null;
  const mcp = deps.mcp ?? null;
  /** A card's label: the catalogue's, or "Untrusted tool from {server}" for an MCP tool. */
  const labelFor = (toolName: string): string => {
    if (mcp === null || !isMcpToolName(toolName)) return toolLabel(toolName);
    try {
      return mcp.labelOf(toolName);
    } catch {
      return toolLabel(toolName);
    }
  };
  /** The MCP tools a typed turn offers (enabled, ready, entitled servers'); none if that fails. */
  const mcpToolsNow = (): McpToolDefinition[] => {
    if (mcp === null) return [];
    try {
      const tools = mcp.toolsForChat();
      return Array.isArray(tools) ? tools.slice(0, MCP_LIMITS.maxToolsPerChat) : [];
    } catch {
      return [];
    }
  };
  const mcpView = (): AgentMcpView => {
    if (mcp === null) return { available: false, servers: [] };
    try {
      return mcp.view();
    } catch {
      return { available: false, servers: [] };
    }
  };
  const isBuiltinSkill = (id: string): boolean => {
    try {
      return userSkills !== null ? userSkills.isBuiltin(id) : (BUILTIN_SKILL_IDS as readonly string[]).includes(id);
    } catch {
      return false;
    }
  };
  const retention = (): ChatRetention => {
    try {
      const value = history?.retention();
      return isChatRetention(value) ? value : DEFAULT_CHAT_RETENTION;
    } catch {
      return DEFAULT_CHAT_RETENTION;
    }
  };
  let grantsVersion = 1;

  const skillsEntitled = (): boolean => {
    try {
      return deps.entitlements.allowed('agent.skills') === true;
    } catch {
      return false;
    }
  };

  /** Whether the user has `id` switched on (Phase 8 Task 5; every skill is, without the library's store). */
  const isSkillEnabled = (id: string): boolean => {
    try {
      return userSkills === null || userSkills.enabled(id) !== false;
    } catch {
      return true;
    }
  };
  /** The registry's skills (a registry that throws lists none). */
  const listSkills = (): readonly Skill[] => {
    try {
      const listed = skills.list();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  };
  const findSkill = (id: string): Skill | null => {
    try {
      return skills.get(id) ?? null;
    } catch {
      return null;
    }
  };

  const chats = new Map<string, Chat>();
  let selected: string | null = null;
  let turn: Turn | null = null;
  let notice: AgentNoticeView | null = null;
  let noticeSeq = 0;
  let keys: Record<CredentialSlot, boolean> = { anthropic: false, openai: false, gateway: false };
  let protection: KeyProtection = 'unavailable';
  let entryIds = 0;
  let disposed = false;

  // ---- Versions and watchers ----
  let version = 1;
  let cached: AgentState | null = null;
  let deltaTimer: unknown = null;
  let waiters: { resolve: (state: AgentState) => void }[] = [];

  const wake = () => {
    if (waiters.length === 0) return;
    const woken = waiters;
    waiters = [];
    const current = state();
    for (const waiter of woken) waiter.resolve(current);
  };
  /** A change the panel should see now. */
  const bump = () => {
    if (deltaTimer !== null) {
      clearTimer(deltaTimer);
      deltaTimer = null;
    }
    version += 1;
    cached = null;
    wake();
  };
  /** Streaming text: published at most every `AGENT_DELTA_COALESCE_MS`. */
  const bumpSoon = () => {
    if (deltaTimer !== null) return;
    deltaTimer = setTimer(() => {
      deltaTimer = null;
      bump();
    }, AGENT_DELTA_COALESCE_MS);
  };

  /** `message`: in place of the kind's fixed sentence (the `chatgpt` route's `setup-needed`). */
  const raise = (kind: AgentNoticeView['kind'], message: string = AGENT_NOTICE_MESSAGES[kind]) => {
    noticeSeq += 1;
    notice = { kind, message, seq: noticeSeq };
    bump();
  };

  // ---- The state ----
  const cardView = (card: ToolCard): AgentToolCardView => ({
    callId: card.callId,
    toolName: card.toolName,
    label: card.label,
    status: card.status,
    code: card.code,
    inputPreview: card.inputPreview,
    outputPreview: card.outputPreview,
  });
  const entryView = (entry: Entry): AgentMessageView =>
    entry.kind === 'user'
      ? { kind: 'user', id: entry.id, text: entry.text, ...(entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}) }
      : { kind: 'assistant', id: entry.id, text: entry.text, tools: entry.tools.map(cardView), streaming: entry.streaming };

  /** Whether the route's key slot holds a usable key (`false` for the `chatgpt` route, which has none). */
  const keySet = (route: ModelRoute): boolean => {
    const slot = routeCredentialSlot(route);
    return slot !== null && keys[slot];
  };
  const chatgpt = deps.chatgpt ?? null;
  /** The ChatGPT sign-in's view (never a token) and the account's last model list. */
  const chatgptView = (): AgentChatgptView => {
    try {
      if (chatgpt !== null) return chatgpt.view();
    } catch {
      // Read as signed out.
    }
    return { account: { state: 'signed-out', acknowledged: false }, models: [] };
  };
  /** Whether a turn may start on the `chatgpt` route: signed in, plan usage on, the chosen model listed. */
  const chatgptReady = (): boolean => {
    try {
      return chatgpt !== null && chatgpt.ready() === true;
    } catch {
      return false;
    }
  };
  /** Whether the route's credential is there: a stored key, or on `chatgpt` the sign-in. */
  const routeReady = (route: ModelRoute): boolean => (route === 'chatgpt' ? chatgptReady() : keySet(route));
  /** The account's last model list as main's proxy reads it, so a turn's level is the one the proxy checks. */
  const chatgptModels = (): readonly ChatgptModelView[] => {
    try {
      return deps.settings.chatgptModels?.() ?? [];
    } catch {
      return [];
    }
  };
  /** The level in effect for the settings' model (what the next turn sends) and the levels it offers (Phase 8 Task 8b). */
  const reasoningView = (settings: AgentModelSettings): AgentReasoningView => {
    const models = chatgptModels();
    return { effort: effectiveEffort(settings, models), levels: [...reasoningLevels(settings.modelId, models)] };
  };

  const state = (): AgentState => {
    if (cached !== null) return cached;
    const settings = deps.settings.current();
    const pending = deps.approvals.pending();
    const active = selected === null ? undefined : chats.get(selected);
    const summaries: AgentChatSummary[] = [...chats.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat) => ({ id: chat.id, title: chat.title, tabId: chat.tabId, updatedAt: chat.updatedAt, running: turn?.chat === chat }));
    const shown = active === undefined ? [] : active.entries.slice(-MAX_DISPLAY_ENTRIES);
    cached = {
      version,
      setup: {
        route: settings.route,
        modelId: settings.modelId,
        // On the `chatgpt` route, the account's last listed models (in the server's order).
        allowedModels: settings.route === 'chatgpt' ? chatgptView().models.map((model) => model.id) : ALLOWED_MODEL_IDS.filter((id) => routeModelId(settings.route, id) !== null),
        keys: { ...keys },
        chatgpt: chatgptView(),
        reasoning: reasoningView(settings),
        ready: scripted || routeReady(settings.route),
        protection,
        runtime: { status: deps.host.status(), lastFailure: deps.host.lastFailure() },
        isolation: isolationView(deps.host.lockdown()),
      },
      // Without the `agent.skills` entitlement the panel offers none.
      skills: skillsEntitled() ? listSkills().map((skill) => skillView(skill, isBuiltinSkill(skill.id), isSkillEnabled(skill.id))) : [],
      chats: summaries,
      active:
        active === undefined
          ? null
          : {
              id: active.id,
              title: active.title,
              tabId: active.tabId,
              messages: shown.map(entryView),
              truncated: active.truncated || active.entries.length > shown.length,
              running: turn?.chat === active,
              error: active.error,
              chatgptError: active.chatgptError ?? null,
              usage: active.usage === null ? null : { ...active.usage },
              contextTokens: active.contextTokens,
              contextWindow: modelContextWindow(active.modelId ?? settings.modelId),
              modelId: active.modelId,
            },
      running: turn !== null,
      approval: pending.length === 0 ? null : { request: approvalView(pending[0]!), queued: pending.length - 1 },
      notice,
      readToolsAllowed: deps.grants.readToolsAllowed(),
      grantsCount: deps.grants.list().length,
      grantsVersion,
      chatRetention: retention(),
      mcp: mcpView(),
    };
    return cached;
  };

  // ---- Chats ----
  const newEntry = (kind: Entry['kind'], text: string): Entry => ({ id: `entry-${(entryIds += 1)}`, kind, text, tools: [], streaming: kind === 'assistant' });

  /** Drops the least recently used idle chats past `MAX_CHATS_KEPT_IN_MEMORY`. */
  const evict = () => {
    while (chats.size > MAX_CHATS_KEPT_IN_MEMORY) {
      const oldest = [...chats.values()].filter((chat) => chat !== turn?.chat && chat.id !== selected).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest === undefined) return;
      chats.delete(oldest.id);
      deps.approvals.forget(oldest.id);
    }
  };

  /**
   * Keeps a chat's memory bounded: its history to twice what a turn sends and `CHAT_HISTORY_MAX_CHARS`
   * (oldest tool outputs shortened first), its entries to twice what the panel shows and
   * `CHAT_ENTRIES_MAX_CHARS` (oldest first).
   */
  const trim = (chat: Chat) => {
    const cut = () => {
      chat.truncated = true;
      chat.stored = null;
    };
    if (chat.history.length > CHAT_MAX_MESSAGES * 2) {
      chat.history = historyWindow(chat.history);
      cut();
    }
    const compacted = compactHistory(chat.history, CHAT_HISTORY_MAX_CHARS);
    if (compacted.length !== chat.history.length || compacted.some((message, index) => message !== chat.history[index])) {
      chat.history = compacted;
      cut();
    }
    if (chat.entries.length > MAX_DISPLAY_ENTRIES * 2) {
      chat.entries = chat.entries.slice(-MAX_DISPLAY_ENTRIES);
      cut();
    }
    let entryChars = chat.entries.reduce((sum, entry) => sum + entrySize(entry), 0);
    if (entryChars > CHAT_ENTRIES_MAX_CHARS) {
      let drop = 0;
      while (drop < chat.entries.length - 1 && entryChars > CHAT_ENTRIES_MAX_CHARS) entryChars -= entrySize(chat.entries[drop++]!);
      chat.entries = chat.entries.slice(drop);
      cut();
    }
  };

  const touch = (chat: Chat) => {
    chat.updatedAt = Math.max(now(), chat.updatedAt);
  };

  // ---- Stored chats (Task 9) ----
  const entrySnapshot = (entry: Entry): EntrySnapshot => ({
    kind: entry.kind,
    text: entry.text,
    tools: entry.tools.map((card) => ({ callId: card.callId, toolName: card.toolName, status: card.status, code: card.code, inputPreview: card.inputPreview, outputPreview: card.outputPreview })),
    ...(entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}),
  });
  const snapshotOf = (chat: Chat): ChatSnapshot => ({
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    modelId: chat.modelId,
    usage: chat.usage === null ? null : { ...chat.usage },
    contextTokens: chat.contextTokens,
    truncated: chat.truncated,
    history: structuredClone(chat.history),
    entries: chat.entries.map(entrySnapshot),
  });
  const headOf = (chat: Chat): ChatHead => ({
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    modelId: chat.modelId,
    usage: chat.usage === null ? null : { ...chat.usage },
    contextTokens: chat.contextTokens,
    truncated: chat.truncated,
  });
  /**
   * Saves a chat still open (one deleted meanwhile is not written back): its row, and only the
   * messages and entries after the ones already stored; the whole chat after a trim, or when the
   * stored rows don't line up (the store refuses an append past what it holds).
   */
  const persist = (chat: Chat) => {
    if (history === null || chats.get(chat.id) !== chat || !chat.loaded) return;
    const counts = { messages: chat.history.length, entries: chat.entries.length };
    const save = (from: { messages: number; entries: number }) =>
      history.save({
        head: headOf(chat),
        messagesFrom: from.messages,
        messages: structuredClone(chat.history.slice(from.messages, counts.messages)),
        entriesFrom: from.entries,
        entries: chat.entries.slice(from.entries, counts.entries).map(entrySnapshot),
      });
    const stored = chat.stored;
    const from = stored !== null && stored.messages <= counts.messages && stored.entries <= counts.entries ? stored : { messages: 0, entries: 0 };
    void (async () => {
      let ok = await save(from);
      if (!ok && (from.messages > 0 || from.entries > 0) && chats.get(chat.id) === chat) ok = await save({ messages: 0, entries: 0 });
      if (chats.get(chat.id) === chat) chat.stored = ok ? counts : null;
    })().catch(() => log('agent session: a chat could not be saved'));
  };

  /** Reads a restored chat's messages once (an unreadable one opens empty). */
  const ensureLoaded = (chat: Chat): Promise<void> => {
    if (chat.loaded) return Promise.resolve();
    chat.loading ??= (async () => {
      const rows = history === null ? null : await history.loadChat(chat.id);
      if (chat.loaded) return;
      if (rows !== null) {
        chat.history = pairedHistory(rows.history);
        chat.entries = rows.entries.map((entry) => ({
          ...newEntry(entry.kind, entry.text),
          streaming: false,
          tools: entry.tools.map((card) => ({ ...card, label: labelFor(card.toolName) })),
          ...(entry.kind === 'user' && entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}),
        }));
        // Rows that didn't read back as they were stored: the next save writes the chat anew.
        chat.stored = rows.exact && chat.history.length === rows.storedMessages ? { messages: rows.storedMessages, entries: rows.storedEntries } : null;
      } else {
        chat.stored = null;
      }
      chat.loaded = true;
      chat.loading = null;
      bump();
    })().catch(() => {
      chat.loaded = true;
      chat.loading = null;
      chat.stored = null;
      log('agent session: a stored chat could not be read');
    });
    return chat.loading;
  };

  // Deletions made before the stored chats were restored, so the restore can't bring them back.
  let restored = false;
  const deletedBeforeRestore = new Set<string>();
  let clearedBeforeRestore = false;

  // ---- Setup ----
  const refreshSetup = async () => {
    try {
      const [anthropic, openai, gateway, protected_] = await Promise.all([
        deps.credentials.hasKey('anthropic'),
        deps.credentials.hasKey('openai'),
        deps.credentials.hasKey('gateway'),
        deps.credentials.protection(),
      ]);
      keys = { anthropic: anthropic === true, openai: openai === true, gateway: gateway === true };
      protection = protected_;
    } catch {
      log('agent session: the key status could not be read');
    }
    // Also after the settings and grants loaded (which announce nothing themselves).
    bump();
  };

  // ---- A turn's events ----
  const ensureEntry = (current: Turn, chat: Chat): Entry => {
    if (current.entry !== null) return current.entry;
    const entry = newEntry('assistant', '');
    chat.entries.push(entry);
    current.entry = entry;
    return entry;
  };

  /** Whether main's broker saw the runtime ask for `call` this turn (`tool.invoke`). */
  const brokerSaw = (chat: Chat, call: ToolCall) => deps.approvals.activity(chat.id).some((item) => item.callId === call.callId && item.toolName === call.toolName);

  /**
   * The calls the runtime reported in a step that main can vouch for: each one it announced
   * (`chat.tool-call`, same tool and input) and the broker was asked to run, not already in the
   * history, at most once. Anything else is a strike.
   */
  const vouched = (current: Turn, chat: Chat, calls: readonly ToolCall[]): ToolCall[] => {
    const kept: ToolCall[] = [];
    const seen = new Set<string>();
    let refused = false;
    for (const call of calls) {
      const announced = current.calls.get(call.callId);
      const same = announced !== undefined && announced.toolName === call.toolName && JSON.stringify(announced.input) === JSON.stringify(call.input);
      if (!same || seen.has(call.callId) || current.landed.has(call.callId) || !brokerSaw(chat, announced)) {
        refused = true;
        continue;
      }
      seen.add(call.callId);
      kept.push(announced);
    }
    if (refused) deps.host.strike();
    return kept;
  };

  /** Writes `calls` to the history as an assistant message, each followed by main's result if it has one. */
  const writeStep = (current: Turn, chat: Chat, text: string, calls: readonly ToolCall[]) => {
    chat.history.push({ role: 'assistant', content: text, toolCalls: calls.map((call) => ({ ...call })) });
    for (const call of calls) {
      current.landed.add(call.callId);
      const result = current.results.get(call.callId);
      if (result === undefined) continue;
      current.results.delete(call.callId);
      attachToolResult(chat.history, result);
    }
  };

  /** Gives every card still in progress an end status. */
  const settleCards = (cards: Iterable<ToolCard>, unanswered: 'failed' | 'expired') => {
    for (const card of cards) {
      if (card.status === 'requested') {
        card.status = 'failed';
        card.code = 'failed';
      } else if (card.status === 'running' || card.status === 'awaiting-approval') {
        card.status = unanswered;
        card.code = unanswered;
      }
    }
  };

  /** Ends the turn (its chat stays as it is now). */
  const endTurn = (current: Turn) => {
    if (turn !== current) return;
    if (current.stopTimer !== null) clearTimer(current.stopTimer);
    current.stopTimer = null;
    const chat = current.chat;
    if (chat !== null) {
      // Calls the broker handled whose step never came (the runtime died or was cut off): the
      // history still says they were made, with main's own results, so the model learns they ran.
      const unlanded = [...current.calls.values()].filter((call) => !current.landed.has(call.callId) && brokerSaw(chat, call)).slice(0, L.maxToolCallsPerMessage);
      if (unlanded.length > 0) writeStep(current, chat, current.entry?.text ?? '', unlanded);
      settleCards(current.cards.values(), 'expired');
    }
    if (current.entry !== null) {
      current.entry.streaming = false;
      if (current.entry.text === '' && current.entry.tools.length === 0 && current.chat !== null) current.chat.entries = current.chat.entries.filter((entry) => entry !== current.entry);
      current.entry = null;
    }
    turn = null;
    if (current.chat !== null) {
      touch(current.chat);
      trim(current.chat);
      persist(current.chat);
    }
    bump();
  };

  /** Takes the user's message back (the turn never ran): the chat is as it was, or gone if this send made it. */
  const takeBack = (current: Turn) => {
    const chat = current.chat;
    const before = current.before;
    if (chat === null || before === null) return;
    chat.history = chat.history.slice(0, current.historyBefore);
    chat.entries = chat.entries.slice(0, current.entriesBefore);
    chat.error = before.error;
    if (before.chatgptError === undefined) delete chat.chatgptError;
    else chat.chatgptError = before.chatgptError;
    chat.modelId = before.modelId;
    chat.updatedAt = before.updatedAt;
    selected = before.selected;
    if (before.created) chats.delete(chat.id);
  };

  const onChat = (event: AgentChatEvent) => {
    const current = turn;
    if (current === null || current.phase !== 'running' || current.chat === null || current.chat.id !== event.chatId) return;
    const chat = current.chat;
    switch (event.type) {
      case 'chat.delta': {
        current.sawOutput = true;
        if (current.entry === null && current.steps >= MAX_TOOL_STEPS) {
          // No step can follow the last one: text past it is the runtime misbehaving.
          deps.host.strike();
          return;
        }
        const entry = ensureEntry(current, chat);
        if (entry.text.length < L.maxMessageChars) entry.text = cutText(entry.text + event.text, L.maxMessageChars);
        bumpSoon();
        return;
      }
      case 'chat.tool-call': {
        current.sawOutput = true;
        if (current.cards.has(event.callId)) return;
        if (current.cards.size >= MAX_TOOL_CARDS_PER_TURN || (current.entry === null && current.steps >= MAX_TOOL_STEPS)) {
          deps.host.strike();
          return;
        }
        const entry = ensureEntry(current, chat);
        current.calls.set(event.callId, { callId: event.callId, toolName: event.toolName, input: event.input });
        const activity = deps.approvals.activity(chat.id).find((item) => item.callId === event.callId);
        const card: ToolCard = {
          callId: event.callId,
          toolName: event.toolName,
          label: labelFor(event.toolName),
          status: activity?.status ?? 'requested',
          code: activity?.code ?? null,
          inputPreview: cutText(JSON.stringify(event.input) ?? 'null', TOOL_CARD_INPUT_PREVIEW_CHARS),
          outputPreview: null,
        };
        current.cards.set(event.callId, card);
        entry.tools.push(card);
        bump();
        return;
      }
      case 'chat.step': {
        current.sawOutput = true;
        if (current.steps >= MAX_TOOL_STEPS) {
          deps.host.strike();
          return;
        }
        current.steps += 1;
        const entry = ensureEntry(current, chat);
        entry.text = event.text;
        entry.streaming = false;
        current.entry = null;
        settleCards(entry.tools, 'expired');
        const calls = vouched(current, chat, event.toolCalls);
        if (event.text === '' && calls.length === 0 && entry.tools.length === 0) chat.entries = chat.entries.filter((item) => item !== entry);
        if (event.text !== '' || calls.length > 0) writeStep(current, chat, event.text, calls);
        if (event.usage !== undefined && event.usage.input !== null) chat.contextTokens = event.usage.input + (event.usage.output ?? 0);
        touch(chat);
        bump();
        return;
      }
      case 'chat.finish':
        chat.usage = { input: event.usage.input, output: event.usage.output };
        endTurn(current);
        return;
      case 'chat.error':
        if (event.message === CHAT_BUSY_MESSAGE && !current.sawOutput) {
          // The runtime still had a turn for this chat: this one never started.
          takeBack(current);
          turn = null;
          raise('busy');
          return;
        }
        // A plan failure main's proxy reported for this turn is what the chat says (never the runtime's words for it).
        if (current.chatgptFailure !== undefined) {
          chat.error = chatgptFailureMessage(current.chatgptFailure);
          chat.chatgptError = current.chatgptFailure;
        } else chat.error = event.message;
        endTurn(current);
        return;
    }
  };

  /** A plan failure from main's proxy: kept on the running turn on the `chatgpt` route (the first one). */
  const onChatgptFailure = (failure: ChatgptFailure) => {
    const current = turn;
    if (current === null || current.phase !== 'running' || current.route !== 'chatgpt' || current.chatgptFailure !== undefined) return;
    current.chatgptFailure = failure.param === undefined ? { reason: failure.reason } : { reason: failure.reason, param: failure.param };
  };

  const onActivity = () => {
    const current = turn;
    if (current !== null && current.chat !== null) {
      for (const activity of deps.approvals.activity(current.chat.id)) {
        const card = current.cards.get(activity.callId);
        if (card === undefined) continue;
        card.status = activity.status;
        card.code = activity.code;
      }
    }
    bump();
  };

  const onResult = (chatId: string, callId: string, toolName: string, result: ToolResult) => {
    const current = turn;
    const chat = current?.chat?.id === chatId ? current.chat : chats.get(chatId);
    if (chat === undefined || chat === null) return;
    const card = current?.chat === chat ? current.cards.get(callId) : undefined;
    if (card !== undefined) card.outputPreview = outputPreview(result);
    const message = { role: 'tool' as const, callId, toolName, result };
    // Before its step is reported, it waits for it (the step comes after its calls were answered).
    if (!attachToolResult(chat.history, message) && current?.chat === chat) current.results.set(callId, message);
    bump();
  };

  const onStatus = () => {
    const current = turn;
    // The host fails its running chats when the runtime goes; this is the backstop.
    if (current !== null && current.phase === 'running' && current.chat !== null && deps.host.status() !== 'ready' && !deps.host.activeChats().includes(current.chat.id)) {
      current.chat.error = AGENT_CRASHED_MESSAGE;
      endTurn(current);
      return;
    }
    bump();
  };

  const unsubscribe = [
    deps.host.onChat(onChat),
    deps.host.onStatus(onStatus),
    deps.approvals.onChange(onActivity),
    deps.approvals.onResult(onResult),
    deps.settings.onChange(() => bump()),
    deps.grants.onChange(() => {
      grantsVersion += 1;
      bump();
    }),
    ...(userSkills !== null ? [userSkills.onChange(() => bump())] : []),
    ...(mcp !== null ? [mcp.onChange(() => bump())] : []),
    ...(chatgpt !== null ? [chatgpt.onChange(() => bump()), chatgpt.onFailure(onChatgptFailure)] : []),
  ];

  // ---- Sending ----

  /**
   * A skill request's inputs, checked: only the slots the skill declares, each a bounded string,
   * cleaned as `renderSkill` quotes it (`cleanSlotValue`: NFKC, invisible characters such as an
   * emoji's joiner or a soft hyphen removed, one line), so the chat shows what the model reads; a
   * blank one counts as not given. `null` when an input is out of bounds or the skill doesn't declare it.
   */
  const skillInputs = (skill: Skill, request: AgentSkillRequest): SkillRun['inputs'] | null => {
    const declared = new Set<string>((skill.inputs ?? []).map((input) => input.slot));
    const inputs: { [S in SkillInputSlot]?: string } = {};
    for (const slot of SKILL_INPUT_SLOTS) {
      const value: unknown = Object.hasOwn(request, slot) ? request[slot] : undefined;
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > SKILL_SLOT_MAX_CHARS[slot] || !declared.has(slot)) return null;
      const cleaned = cleanSlotValue(slot, value);
      if (cleaned !== null) inputs[slot] = cleaned;
    }
    return inputs;
  };

  /** Resolves a skill request: the skill and its checked inputs, or why not. */
  const resolveSkill = (request: AgentSkillRequest): SkillRun | 'invalid' | 'unknown-skill' => {
    if (typeof request !== 'object' || request === null || !isSkillId(request.skillId)) return 'invalid';
    if (Object.keys(request).some((key) => key !== 'skillId' && !(SKILL_INPUT_SLOTS as readonly string[]).includes(key))) return 'invalid';
    const skill = findSkill(request.skillId);
    // A switched-off skill is as good as gone for a new run (one already running finishes as it began).
    if (skill === null || !isSkillEnabled(skill.id)) return 'unknown-skill';
    const inputs = skillInputs(skill, request);
    return inputs === null ? 'invalid' : { skill, inputs };
  };

  const send = async (chatId: string | null, message: string | AgentSkillRequest): Promise<AgentSendResult> => {
    if (disposed) return 'unavailable';
    let run: SkillRun | null = null;
    if (typeof message === 'string') {
      if (message.trim() === '' || message.length > CHAT_TEXT_MAX_CHARS) {
        raise('invalid');
        return 'invalid';
      }
    } else {
      // Not entitled to skills: said before anything about the skill itself.
      if (!deps.entitlements.allowed('agent') || !deps.entitlements.allowed('agent.skills')) {
        raise('not-entitled');
        return 'not-entitled';
      }
      const resolved = resolveSkill(message);
      if (resolved === 'invalid' || resolved === 'unknown-skill') {
        raise(resolved);
        return resolved;
      }
      run = resolved;
    }
    const text = typeof message === 'string' ? message : '';
    if (turn !== null) {
      raise('busy');
      return 'busy';
    }
    if (!deps.entitlements.allowed('agent') || (run !== null && !deps.entitlements.allowed('agent.skills'))) {
      raise('not-entitled');
      return 'not-entitled';
    }
    if (chatId !== null && !chats.has(chatId)) {
      raise('unknown-chat');
      return 'unknown-chat';
    }
    // Held from here, so a second send while this one awaits is refused.
    const current: Turn = {
      phase: 'starting',
      chat: null,
      stopping: false,
      entry: null,
      results: new Map(),
      cards: new Map(),
      calls: new Map(),
      landed: new Set(),
      steps: 0,
      stopTimer: null,
      sawOutput: false,
      historyBefore: 0,
      entriesBefore: 0,
      before: null,
    };
    turn = current;
    notice = null;
    bump();
    const refuse = (kind: Exclude<AgentSendResult, 'started'>, message?: string): AgentSendResult => {
      if (turn === current) turn = null;
      raise(kind, message);
      return kind;
    };
    /** Not ready: on the `chatgpt` route the notice says what the plan needs (sign in, plan usage, models), not "add a key". */
    const setupNeeded = (route: ModelRoute): AgentSendResult => {
      if (route !== 'chatgpt') return refuse('setup-needed');
      const { account, models } = chatgptView();
      return refuse('setup-needed', CHATGPT_SETUP_MESSAGES[chatgptSetupReason(account, models)]);
    };
    // A restored chat's messages are read before the turn uses them.
    const target = chatId === null ? undefined : chats.get(chatId);
    if (target !== undefined && !target.loaded) await ensureLoaded(target);

    const settings = deps.settings.current();
    if (!scripted) {
      let hasKey = false;
      const slot = routeCredentialSlot(settings.route);
      try {
        // The `chatgpt` route needs a sign-in with plan usage on and a listed model, not a key.
        hasKey = slot === null ? chatgptReady() : (await deps.credentials.hasKey(slot)) === true;
      } catch {
        hasKey = false;
      }
      void refreshSetup();
      if (!hasKey) return setupNeeded(settings.route);
    }
    let started = false;
    try {
      started = (await deps.start()) === true;
    } catch {
      started = false;
    }
    if (disposed) {
      if (turn === current) turn = null;
      return 'unavailable';
    }
    if (!started) return refuse('unavailable');

    // The runtime is ready: from here everything is synchronous until `chat.start` is posted.
    const turnSettings = deps.settings.current();
    const { route, modelId } = turnSettings;
    // The level in effect, never the raw stored one: main's proxy checks the body against the same.
    const reasoningEffort = effectiveEffort(turnSettings, chatgptModels());
    if (routeModelId(route, modelId) === null) return setupNeeded(route);
    let chat = chatId === null ? undefined : chats.get(chatId);
    if (chatId !== null && chat === undefined) return refuse('unknown-chat');
    const created = chat === undefined;
    // What the model reads and the tools it is offered: the typed text and the whole catalogue, or
    // the rendered skill and the skill's tools (in catalogue order).
    // A restored chat has no tab: its next message binds the active one.
    const tabId = chat?.tabId ?? deps.activeTabId();
    if (tabId === null) return refuse('no-tab');
    let content = text;
    let allowedTools: readonly string[] = ALL_TOOLS;
    // A typed turn also offers the ready MCP servers' tools (Task 10); a skill never does.
    let mcpTools: McpToolDefinition[] = [];
    /** The page a skill ran on, as its `pageUrl` slot (shown in the chat). */
    let skillPageUrl: string | null = null;
    if (run !== null) {
      let page: { readonly url: string | null; readonly title: string | null } | null = null;
      try {
        page = tabPage(tabId);
      } catch {
        page = null;
      }
      skillPageUrl = cleanSlotValue('pageUrl', skillPageUrlOf(page?.url ?? null));
      const rendered = renderSkill(run.skill, { pageUrl: skillPageUrl, pageTitle: page?.title ?? null, ...run.inputs });
      const skillTools = new Set<string>(run.skill.allowedTools);
      allowedTools = ALL_TOOLS.filter((name) => skillTools.has(name));
      if (rendered === null || rendered.length > L.maxMessageChars || allowedTools.length === 0) return refuse('unknown-skill');
      content = rendered;
    } else {
      mcpTools = mcpToolsNow().slice(0, L.maxAllowedTools - ALL_TOOLS.length);
      allowedTools = [...ALL_TOOLS, ...mcpTools.map((tool) => tool.name)];
    }
    if (chat === undefined) {
      chat = {
        id: randomId(),
        title: chatTitle(run !== null ? run.skill.name : text),
        tabId,
        createdAt: now(),
        updatedAt: now(),
        history: [],
        entries: [],
        truncated: false,
        error: null,
        usage: null,
        contextTokens: null,
        modelId: null,
        loaded: true,
        loading: null,
        stored: null,
      };
      chats.set(chat.id, chat);
    }
    current.chat = chat;
    chat.tabId = tabId;
    current.before = { error: chat.error, chatgptError: chat.chatgptError, modelId: chat.modelId, updatedAt: chat.updatedAt, selected, created };
    current.historyBefore = chat.history.length;
    current.entriesBefore = chat.entries.length;
    chat.history.push({ role: 'user', content });
    chat.entries.push(run !== null ? { ...newEntry('user', skillEntryText(run.inputs, skillPageUrl)), skill: { id: run.skill.id, name: run.skill.name } } : newEntry('user', text));
    chat.error = null;
    delete chat.chatgptError;
    chat.modelId = modelId;
    selected = chat.id;
    touch(chat);
    evict();

    // The broker refuses any tool outside the list, whatever the runtime asks for.
    deps.approvals.register(chat.id, { tabId: chat.tabId, allowedTools: [...allowedTools] });
    const posted = deps.host.send({
      type: 'chat.start',
      chatId: chat.id,
      // Within the model's context too (a long chat of large tool results would otherwise fail every turn).
      messages: compactHistory(historyWindow(chat.history), historyBudgetChars(modelId, AGENT_SYSTEM_PROMPT.length + JSON.stringify(mcpTools).length)),
      systemPrompt: AGENT_SYSTEM_PROMPT,
      modelId,
      route,
      allowedTools: [...allowedTools],
      mcpTools,
      reasoningEffort,
    });
    if (!posted) {
      deps.approvals.unregister(chat.id);
      takeBack(current);
      log('agent session: a turn could not be started');
      return refuse('unavailable');
    }
    current.phase = 'running';
    current.route = route;
    bump();
    return 'started';
  };

  const stop = (chatId: string): boolean => {
    const current = turn;
    if (current === null || current.phase !== 'running' || current.chat?.id !== chatId || current.stopping) return false;
    current.stopping = true;
    deps.host.send({ type: 'chat.stop', chatId });
    deps.approvals.unregister(chatId);
    // A runtime that ignores Stop can't hold the agent busy: past the deadline main ends the turn
    // itself and restarts the runtime (which also clears the host's running chats).
    current.stopTimer = setTimer(() => {
      current.stopTimer = null;
      if (turn !== current || current.chat === null) return;
      log('agent session: the runtime did not stop a turn in time; restarting it');
      current.chat.error = STOP_DEADLINE_MESSAGE;
      endTurn(current);
      deps.host.restart();
    }, STOP_DEADLINE_MS);
    bump();
    return true;
  };

  let deletingAll: Promise<AgentDeleteAllChatsResult> | null = null;
  let exporting = false;
  let changingRetention = false;

  /** Deletes every chat, in memory (a running one stopped first) and on disk; `false` if the disk's couldn't be. */
  const clearChats = async (): Promise<boolean> => {
    if (disposed) return false;
    for (const chatId of [...chats.keys()]) {
      stop(chatId);
      chats.delete(chatId);
      deps.approvals.forget(chatId);
    }
    if (!restored) clearedBeforeRestore = true;
    selected = null;
    bump();
    if (history === null) return true;
    try {
      return (await history.removeAll()) === true;
    } catch {
      return false;
    }
  };

  /** Deletes what the retention no longer keeps: on disk, and the idle chats in memory past a finite window. */
  const prune = async (): Promise<void> => {
    if (history === null) return;
    let cutoff: number | null = null;
    try {
      cutoff = await history.prune();
    } catch {
      cutoff = null;
    }
    // `off` keeps chats in memory until quit; a finite window drops the idle ones it no longer keeps.
    if (cutoff === null || !Number.isFinite(cutoff) || disposed) return;
    let dropped = false;
    for (const chat of [...chats.values()]) {
      if (chat.updatedAt >= cutoff || turn?.chat === chat || chat.id === selected) continue;
      chats.delete(chat.id);
      deps.approvals.forget(chat.id);
      dropped = true;
    }
    if (dropped) bump();
  };

  return {
    getState: state,
    watch(sinceVersion, signal) {
      if (version > sinceVersion || disposed || signal?.aborted) return Promise.resolve(state());
      return new Promise<AgentState>((resolve) => {
        const waiter = {
          resolve: (next: AgentState) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(next);
          },
        };
        const onAbort = () => {
          waiters = waiters.filter((item) => item !== waiter);
          waiter.resolve(state());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        if (waiters.length > MAX_PENDING_AGENT_WATCHES) waiters.shift()!.resolve(state());
      });
    },
    send,
    stop,
    newChat() {
      if (selected === null) return;
      selected = null;
      bump();
    },
    selectChat(chatId) {
      const chat = chats.get(chatId);
      if (chat === undefined) return false;
      if (!chat.loaded) void ensureLoaded(chat);
      if (selected !== chatId) {
        selected = chatId;
        bump();
      }
      return true;
    },
    deleteChat(chatId) {
      const chat = chats.get(chatId);
      if (chat === undefined) return false;
      stop(chatId);
      chats.delete(chatId);
      deps.approvals.forget(chatId);
      if (selected === chatId) selected = null;
      if (!restored) deletedBeforeRestore.add(chatId);
      if (history !== null) void history.remove(chatId).catch(() => log('agent session: a chat could not be deleted from disk'));
      bump();
      return true;
    },
    async answerApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentAnswerResult> {
      if (typeof approvalId !== 'string' || !isApprovalDecision(decision)) return 'invalid';
      try {
        const answer = await deps.approvals.answer(approvalId, decision);
        return answer.ok ? (answer.granted ? 'granted' : 'answered') : answer.reason;
      } catch {
        return 'unknown';
      }
    },
    async setModel(route: ModelRoute, modelId: AgentModelId) {
      let stored = false;
      try {
        stored = (await deps.settings.set({ route, modelId })) === true;
      } catch {
        stored = false;
      }
      bump();
      return stored;
    },
    async setReasoningEffort(effort: ReasoningEffort) {
      if (!isReasoningEffort(effort)) return false;
      let stored = false;
      try {
        stored = (await deps.settings.set({ reasoningEffort: effort })) === true;
      } catch {
        stored = false;
      }
      bump();
      return stored;
    },
    async setKey(slot, key): Promise<AgentSetKeyResult> {
      let result: AgentSetKeyResult = 'failed';
      try {
        const answer = await deps.credentials.setKey(slot, key);
        // Only one of the store's fixed answers goes back: never anything that could hold the key.
        result = (AGENT_SET_KEY_RESULTS as readonly string[]).includes(answer) ? answer : 'failed';
      } catch {
        result = 'failed';
      }
      await refreshSetup();
      bump();
      return result;
    },
    async clearKey(slot) {
      let cleared = false;
      try {
        cleared = (await deps.credentials.clearKey(slot)) === true;
      } catch {
        cleared = false;
      }
      await refreshSetup();
      bump();
      return cleared;
    },
    refreshSetup,

    // ---- Task 9: stored chats ----
    restore(stored) {
      if (disposed || restored || !Array.isArray(stored)) return;
      restored = true;
      if (clearedBeforeRestore) return;
      // A retention changed while the chats were read applies to them too.
      const cutoff = retentionCutoff(retention(), now());
      let added = false;
      for (const head of stored as readonly ChatHead[]) {
        if (chats.size >= MAX_CHATS_KEPT_IN_MEMORY) break;
        if (chats.has(head.id) || deletedBeforeRestore.has(head.id)) continue;
        const updatedAt = Math.min(head.updatedAt, now());
        if (cutoff !== null && updatedAt < cutoff) continue;
        chats.set(head.id, {
          id: head.id,
          title: head.title,
          tabId: null,
          createdAt: Math.min(head.createdAt, updatedAt),
          updatedAt,
          history: [],
          entries: [],
          truncated: head.truncated,
          error: null,
          usage: head.usage === null ? null : { ...head.usage },
          contextTokens: head.contextTokens,
          modelId: head.modelId,
          loaded: false,
          loading: null,
          stored: null,
        });
        added = true;
      }
      deletedBeforeRestore.clear();
      if (added) bump();
    },
    async loadChat(chatId) {
      const chat = typeof chatId === 'string' ? chats.get(chatId) : undefined;
      if (chat !== undefined) await ensureLoaded(chat);
    },
    snapshot(chatId) {
      const chat = typeof chatId === 'string' ? chats.get(chatId) : undefined;
      return chat === undefined ? null : snapshotOf(chat);
    },
    prune,
    async setChatRetention(next): Promise<AgentSetRetentionResult> {
      if (history === null || !isChatRetention(next)) return 'failed';
      if (changingRetention) return 'cancelled';
      changingRetention = true;
      try {
        // A change that would delete chats asks first, in main's own dialog.
        const cutoff = retentionCutoff(next, now());
        const inMemory = cutoff === null || !Number.isFinite(cutoff) ? 0 : [...chats.values()].filter((chat) => chat.updatedAt < cutoff && turn?.chat !== chat && chat.id !== selected).length;
        const onDisk = next === retention() ? 0 : await history.wouldDelete(next);
        const affected = Math.max(inMemory, onDisk);
        if (affected > 0) {
          let confirmed = false;
          try {
            confirmed = deps.confirmRetentionChange !== undefined && (await deps.confirmRetentionChange(next, affected)) === true;
          } catch {
            confirmed = false;
          }
          if (!confirmed || disposed) {
            bump();
            return 'cancelled';
          }
        }
        let stored = false;
        try {
          stored = (await history.setRetention(next)) === true;
        } catch {
          stored = false;
        }
        bump();
        if (!stored) return 'failed';
        await prune();
        return 'saved';
      } finally {
        changingRetention = false;
      }
    },
    deleteAllChats(): Promise<AgentDeleteAllChatsResult> {
      deletingAll ??= (async (): Promise<AgentDeleteAllChatsResult> => {
        let confirmed = false;
        try {
          confirmed = deps.confirmDeleteAllChats !== undefined && (await deps.confirmDeleteAllChats()) === true;
        } catch {
          confirmed = false;
        }
        if (!confirmed || disposed) return 'cancelled';
        return (await clearChats()) ? 'deleted' : 'failed';
      })().finally(() => {
        deletingAll = null;
      });
      return deletingAll;
    },
    deleteAllChatsUnconfirmed: () => clearChats(),
    async forgetAgentGrants() {
      try {
        return (await deps.grants.revokeAll()) === true;
      } catch {
        return false;
      }
    },
    async exportChat(chatId, format): Promise<ChatExportResult> {
      const chat = typeof chatId === 'string' ? chats.get(chatId) : undefined;
      if (chat === undefined || deps.exportChat === undefined || (format !== 'markdown' && format !== 'json')) return 'failed';
      // One save dialog at a time: a second export while one is open writes nothing.
      if (exporting) return 'cancelled';
      exporting = true;
      try {
        await ensureLoaded(chat);
        const result = await deps.exportChat(snapshotOf(chat), format);
        return result === 'saved' || result === 'cancelled' ? result : 'failed';
      } catch {
        return 'failed';
      } finally {
        exporting = false;
      }
    },

    // ---- Task 9: grants page ----
    listGrants(): AgentGrantView[] {
      return deps.grants.list().map((grant) => ({ tool: grant.tool, label: toolLabel(grant.tool), origin: grant.origin, createdAt: grant.createdAt }));
    },
    async revokeGrant(tool, origin) {
      try {
        return (await deps.grants.revoke(tool, origin)) === true;
      } catch {
        return false;
      }
    },
    async revokeAllGrants() {
      try {
        return (await deps.grants.revokeAll()) === true;
      } catch {
        return false;
      }
    },
    async setReadToolsAllowed(allowed) {
      if (typeof allowed !== 'boolean') return false;
      try {
        return (await deps.grants.setReadToolsAllowed(allowed)) === true;
      } catch {
        return false;
      } finally {
        bump();
      }
    },

    // ---- Task 9: skills editor ----
    skillDetail(id): AgentSkillDetail | null {
      if (!isSkillId(id)) return null;
      if (userSkills !== null) {
        try {
          return userSkills.detail(id);
        } catch {
          return null;
        }
      }
      const skill = findSkill(id);
      return skill === null ? null : skillDetail(skill, isBuiltinSkill(id));
    },
    async saveSkill(draft, mode): Promise<AgentSaveSkillResult> {
      if (userSkills === null) return { result: 'failed' };
      try {
        return await userSkills.save(draft, mode);
      } catch {
        return { result: 'failed' };
      }
    },
    async deleteSkill(id) {
      if (userSkills === null) return false;
      try {
        return (await userSkills.remove(id)) === true;
      } catch {
        return false;
      }
    },
    async duplicateSkill(id): Promise<AgentSaveSkillResult> {
      if (userSkills === null) return { result: 'failed' };
      try {
        return await userSkills.duplicate(id);
      } catch {
        return { result: 'failed' };
      }
    },
    async setSkillEnabled(id, enabled) {
      if (userSkills === null) return false;
      try {
        return (await userSkills.setEnabled(id, enabled)) === true;
      } catch {
        return false;
      }
    },

    // ---- Phase 8 Task 6: skill files (`agent-data.spec.ts`, Skill files) ----
    async exportSkills(ids): Promise<SkillExportResult> {
      if (deps.skillFiles === undefined) return 'failed';
      try {
        return await deps.skillFiles.exportSkills(ids);
      } catch {
        return 'failed';
      }
    },
    async previewSkillImport(): Promise<AgentSkillImportPreviewResult> {
      if (deps.skillFiles === undefined) return { result: 'failed' };
      try {
        return await deps.skillFiles.previewImport();
      } catch {
        return { result: 'failed' };
      }
    },
    async importSkills(token, indices): Promise<AgentSkillImportResult> {
      if (deps.skillFiles === undefined) return { result: 'failed' };
      try {
        return await deps.skillFiles.importSkills(token, indices);
      } catch {
        return { result: 'failed' };
      }
    },
    cancelSkillImport(token) {
      try {
        return deps.skillFiles?.cancelImport(token) === true;
      } catch {
        return false;
      }
    },

    // ---- Task 10: MCP servers (`agent-mcp.spec.ts`; acceptance `agent-mcp.feature.md`) ----
    async saveMcpServer(input) {
      if (mcp === null) return { result: 'failed' };
      try {
        return await mcp.save(input);
      } catch {
        return { result: 'failed' };
      }
    },
    async deleteMcpServer(id) {
      try {
        return mcp !== null && (await mcp.remove(id)) === true;
      } catch {
        return false;
      }
    },
    async setMcpServerEnabled(id, enabled) {
      try {
        return mcp !== null && (await mcp.setEnabled(id, enabled)) === true;
      } catch {
        return false;
      }
    },
    async startMcpServer(id) {
      if (mcp === null) return 'unknown';
      try {
        return await mcp.start(id);
      } catch {
        return 'failed';
      }
    },
    async stopMcpServer(id) {
      try {
        return mcp !== null && (await mcp.stop(id)) === true;
      } catch {
        return false;
      }
    },
    async setMcpToken(id, token) {
      if (mcp === null) return 'unknown';
      try {
        return await mcp.setToken(id, token);
      } catch {
        return 'failed';
      }
    },
    // ChatGPT plan (`agent-chatgpt.feature.md`, Router): the sign-in's procedures; never a token back.
    async chatgptSignIn(windowId, options) {
      // The sender window's live gesture is spent first: without one, nothing opens.
      let gesture = false;
      try {
        gesture = deps.consumeGesture?.(windowId) === true;
      } catch {
        gesture = false;
      }
      if (!gesture) return 'needs-gesture';
      const auth = chatgpt?.auth;
      if (auth === undefined) return 'failed';
      try {
        // The sender's window comes to the front once the sign-in succeeds.
        return await auth.signIn({ ...(options.reconsent === true ? { reconsent: true } : {}), ...(options.differentAccount === true ? { differentAccount: true } : {}), userGesture: true, windowId });
      } catch {
        return 'failed';
      }
    },
    chatgptCancel() {
      try {
        return chatgpt?.auth?.cancel() === true;
      } catch {
        return false;
      }
    },
    async chatgptSignOut() {
      const auth = chatgpt?.auth;
      if (auth === undefined) return 'signed-out';
      try {
        return await auth.signOut();
      } catch {
        return 'not-revoked';
      }
    },
    async chatgptAcknowledge() {
      try {
        return (await chatgpt?.auth?.acknowledge()) === true;
      } catch {
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe) off();
      if (turn?.stopTimer != null) clearTimer(turn.stopTimer);
      turn = null;
      version += 1;
      cached = null;
      if (deltaTimer !== null) clearTimer(deltaTimer);
      deltaTimer = null;
      const woken = waiters;
      waiters = [];
      const current = state();
      for (const waiter of woken) waiter.resolve(current);
    },
  };
}
