import { randomUUID } from 'node:crypto';
import type { AgentService } from '@app/ipc-contract';
import { isApprovalDecision, type ApprovalDecision, type ToolActivityStatus } from '@app/specs/agent-approvals.spec';
import { AGENT_PROTOCOL_LIMITS, CHAT_BUSY_MESSAGE, type ChatMessage, type LockdownTarget, type ToolCall, type ToolResult } from '@app/specs/agent-protocol.schema';
import { ROUTE_CREDENTIAL_SLOT, type CredentialSlot, type KeyProtection } from '@app/specs/agent-proxy.spec';
import {
  AGENT_DELTA_COALESCE_MS,
  AGENT_NOTICE_MESSAGES,
  AGENT_SET_KEY_RESULTS,
  CHAT_TEXT_MAX_CHARS,
  CHAT_TITLE_MAX_CHARS,
  EXECUTE_JS_APPROVAL_NOTE,
  MAX_CHATS_KEPT_IN_MEMORY,
  MAX_DISPLAY_ENTRIES,
  MAX_PENDING_AGENT_WATCHES,
  MAX_TOOL_CARDS_PER_TURN,
  MODEL_CONTEXT_WINDOWS,
  STOP_DEADLINE_MESSAGE,
  STOP_DEADLINE_MS,
  TOOL_CARD_INPUT_PREVIEW_CHARS,
  TOOL_CARD_OUTPUT_PREVIEW_CHARS,
  type AgentAnswerResult,
  type AgentApprovalView,
  type AgentChatSummary,
  type AgentIsolationView,
  type AgentMessageView,
  type AgentNoticeView,
  type AgentSendResult,
  type AgentSetKeyResult,
  type AgentState,
  type AgentToolCardView,
  type AgentUsageView,
} from '@app/specs/agent-session.spec';
import { AGENT_TOOL_NAMES, ALLOWED_MODEL_IDS, CHAT_MAX_MESSAGES, MAX_TOOL_STEPS, routeModelId, type ModelId, type ModelRoute, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import { toolLabel, type ApprovalBroker, type ApprovalRequestView } from './approvals';
import type { CredentialSettings } from './credentials';
import type { AgentEntitlements } from './entitlements';
import type { AgentGrants } from './grants';
import { AGENT_CRASHED_MESSAGE, type AgentChatEvent, type AgentHost } from './host';
import type { AgentSettings } from './settings';
import { AGENT_SYSTEM_PROMPT } from './system-prompt';

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

export interface AgentSessionDeps {
  readonly host: Pick<AgentHost, 'send' | 'onChat' | 'onStatus' | 'status' | 'lastFailure' | 'lockdown' | 'activeChats' | 'strike' | 'restart'>;
  readonly approvals: Pick<ApprovalBroker, 'register' | 'unregister' | 'forget' | 'pending' | 'activity' | 'onChange' | 'onResult' | 'answer'>;
  readonly credentials: CredentialSettings;
  readonly settings: Pick<AgentSettings, 'current' | 'set' | 'onChange'>;
  readonly entitlements: AgentEntitlements;
  readonly grants: Pick<AgentGrants, 'list' | 'readToolsAllowed' | 'onChange'>;
  /** Loads the settings and grants and starts the runtime (`createAgent().start`): `false` if it failed. */
  readonly start: () => Promise<boolean>;
  /** The tab a new chat works on: the active tab. */
  readonly activeTabId: () => number | null;
  /** The e2e seam is on: the runtime plays a script, so a turn needs no key. */
  readonly scripted?: boolean;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Chat ids (default `crypto.randomUUID`). */
  readonly randomId?: () => string;
  /** One line per event; never a message, a tool's input or output, or a key. */
  readonly log?: (line: string) => void;
}

export interface AgentSession extends AgentService {
  /** Reads which keys are set and how they'd be protected (after start-up; `send` and `setKey` do it too). */
  refreshSetup(): Promise<void>;
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
}

interface Chat {
  readonly id: string;
  readonly title: string;
  readonly tabId: number;
  updatedAt: number;
  /** What the model is sent (protocol shape). */
  history: ChatMessage[];
  entries: Entry[];
  /** Whether earlier entries were dropped from memory. */
  truncated: boolean;
  error: string | null;
  usage: AgentUsageView | null;
  contextTokens: number | null;
  modelId: ModelId | null;
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
  before: { readonly error: string | null; readonly modelId: ModelId | null; readonly updatedAt: number; readonly selected: string | null; readonly created: boolean } | null;
  /** Whether the runtime said anything for this turn (a busy reply comes before anything else). */
  sawOutput: boolean;
  /** The history's and entries' lengths before the user's message (to take it back). */
  historyBefore: number;
  entriesBefore: number;
}

const NETWORK_TARGETS: readonly LockdownTarget[] = ['fetch', 'WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest'];
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
    note: request.toolName === 'execute_javascript' ? EXECUTE_JS_APPROVAL_NOTE : null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

export function isolationView(lockdown: ReturnType<AgentHost['lockdown']>): AgentIsolationView {
  if (lockdown === null) return { networkGlobalsRemoved: false, fileSandbox: false, note: 'The agent process has not started yet.' };
  const networkGlobalsRemoved = lockdown.removed.includes('fetch') && !lockdown.failed.some((target) => NETWORK_TARGETS.includes(target));
  const fileSandbox = lockdown.permissionModel;
  const sandbox = fileSandbox
    ? 'The agent process runs as you, with file access limited to its own files.'
    : 'The agent process runs as you, without an OS sandbox or file restrictions.';
  const network = networkGlobalsRemoved ? 'It holds no key and has no network of its own' : 'It holds no key, but some of its network functions could not be removed';
  return { networkGlobalsRemoved, fileSandbox, note: `${sandbox} ${network}; frost decides every action and every model request.` };
}

export function createAgentSession(deps: AgentSessionDeps): AgentSession {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const randomId = deps.randomId ?? randomUUID;
  const log = deps.log ?? (() => undefined);
  const scripted = deps.scripted === true;

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

  const raise = (kind: AgentNoticeView['kind']) => {
    noticeSeq += 1;
    notice = { kind, message: AGENT_NOTICE_MESSAGES[kind], seq: noticeSeq };
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
    entry.kind === 'user' ? { kind: 'user', id: entry.id, text: entry.text } : { kind: 'assistant', id: entry.id, text: entry.text, tools: entry.tools.map(cardView), streaming: entry.streaming };

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
        allowedModels: ALLOWED_MODEL_IDS.filter((id) => routeModelId(settings.route, id) !== null),
        keys: { ...keys },
        ready: scripted || keys[ROUTE_CREDENTIAL_SLOT[settings.route]],
        protection,
        runtime: { status: deps.host.status(), lastFailure: deps.host.lastFailure() },
        isolation: isolationView(deps.host.lockdown()),
      },
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
              usage: active.usage === null ? null : { ...active.usage },
              contextTokens: active.contextTokens,
              contextWindow: active.modelId === null ? MODEL_CONTEXT_WINDOWS[settings.modelId] : MODEL_CONTEXT_WINDOWS[active.modelId],
              modelId: active.modelId,
            },
      running: turn !== null,
      approval: pending.length === 0 ? null : { request: approvalView(pending[0]!), queued: pending.length - 1 },
      notice,
      readToolsAllowed: deps.grants.readToolsAllowed(),
      grantsCount: deps.grants.list().length,
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

  /** Keeps a chat's memory bounded: its history to twice what a turn sends, its entries likewise. */
  const trim = (chat: Chat) => {
    if (chat.history.length > CHAT_MAX_MESSAGES * 2) chat.history = historyWindow(chat.history);
    if (chat.entries.length > MAX_DISPLAY_ENTRIES * 2) {
      chat.entries = chat.entries.slice(-MAX_DISPLAY_ENTRIES);
      chat.truncated = true;
    }
  };

  const touch = (chat: Chat) => {
    chat.updatedAt = Math.max(now(), chat.updatedAt);
  };

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
          label: toolLabel(event.toolName),
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
        chat.error = event.message;
        endTurn(current);
        return;
    }
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
    deps.grants.onChange(() => bump()),
  ];

  // ---- Sending ----
  const send = async (chatId: string | null, text: string): Promise<AgentSendResult> => {
    if (disposed) return 'unavailable';
    if (typeof text !== 'string' || text.trim() === '' || text.length > CHAT_TEXT_MAX_CHARS) {
      raise('invalid');
      return 'invalid';
    }
    if (turn !== null) {
      raise('busy');
      return 'busy';
    }
    if (!deps.entitlements.allowed('agent')) {
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
    const refuse = (kind: Exclude<AgentSendResult, 'started'>): AgentSendResult => {
      if (turn === current) turn = null;
      raise(kind);
      return kind;
    };

    const settings = deps.settings.current();
    if (!scripted) {
      let hasKey = false;
      try {
        hasKey = (await deps.credentials.hasKey(ROUTE_CREDENTIAL_SLOT[settings.route])) === true;
      } catch {
        hasKey = false;
      }
      void refreshSetup();
      if (!hasKey) return refuse('setup-needed');
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
    const { route, modelId } = deps.settings.current();
    if (routeModelId(route, modelId) === null) return refuse('setup-needed');
    let chat = chatId === null ? undefined : chats.get(chatId);
    if (chatId !== null && chat === undefined) return refuse('unknown-chat');
    const created = chat === undefined;
    if (chat === undefined) {
      const tabId = deps.activeTabId();
      if (tabId === null) return refuse('no-tab');
      chat = { id: randomId(), title: chatTitle(text), tabId, updatedAt: now(), history: [], entries: [], truncated: false, error: null, usage: null, contextTokens: null, modelId: null };
      chats.set(chat.id, chat);
    }
    current.chat = chat;
    current.before = { error: chat.error, modelId: chat.modelId, updatedAt: chat.updatedAt, selected, created };
    current.historyBefore = chat.history.length;
    current.entriesBefore = chat.entries.length;
    chat.history.push({ role: 'user', content: text });
    chat.entries.push(newEntry('user', text));
    chat.error = null;
    chat.modelId = modelId;
    selected = chat.id;
    touch(chat);
    evict();

    deps.approvals.register(chat.id, { tabId: chat.tabId, allowedTools: [...AGENT_TOOL_NAMES] });
    const posted = deps.host.send({
      type: 'chat.start',
      chatId: chat.id,
      messages: historyWindow(chat.history),
      systemPrompt: AGENT_SYSTEM_PROMPT,
      modelId,
      route,
      allowedTools: [...AGENT_TOOL_NAMES],
    });
    if (!posted) {
      deps.approvals.unregister(chat.id);
      takeBack(current);
      log('agent session: a turn could not be started');
      return refuse('unavailable');
    }
    current.phase = 'running';
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
      if (!chats.has(chatId)) return false;
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
    async setModel(route: ModelRoute, modelId: ModelId) {
      let stored = false;
      try {
        stored = (await deps.settings.set({ route, modelId })) === true;
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
