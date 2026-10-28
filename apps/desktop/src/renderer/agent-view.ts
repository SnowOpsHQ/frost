import {
  AGENT_ANSWER_MESSAGES,
  AGENT_KEY_PROTECTION_MESSAGES,
  AGENT_KEY_SET_LABEL,
  AGENT_KEY_SLOT_LABELS,
  AGENT_KEY_UNSET_LABEL,
  AGENT_MCP_APPROVAL_NOTE,
  AGENT_MODEL_LABELS,
  AGENT_PANEL_STORAGE_KEY,
  AGENT_ROUTE_LABELS,
  AGENT_SET_KEY_MESSAGES,
  AGENT_TOOL_STATUS_LABELS,
} from '@app/specs/agent-panel.spec';
import { CREDENTIAL_SLOTS, ROUTE_CREDENTIAL_SLOT, type CredentialSlot } from '@app/specs/agent-proxy.spec';
import type {
  AgentActiveChatView,
  AgentAnswerResult,
  AgentApprovalView,
  AgentChatSummary,
  AgentNoticeView,
  AgentSetKeyResult,
  AgentSetupView,
  AgentState,
  AgentToolCardView,
} from '@app/specs/agent-session.spec';
import { ALLOWED_MODEL_IDS, MODEL_ROUTES, isMcpToolName, routeModelId, type ModelId, type ModelRoute } from '@app/specs/agent-tools.spec';

// The agent panel's view model (spec `agent-panel.spec.ts`; acceptance `agent-panel.feature.md`):
// pure functions from main's `AgentState` (`agent-session.spec.ts`) to what the components draw.
// No React, no IPC. Everything page- or model-derived stays a string the components render as
// React text (never HTML); nothing here ever sees a key.

export { AGENT_PANEL_STORAGE_KEY };

/** Whether the stored value means open (`'1'`); anything else, or nothing, is closed. */
export function agentPanelOpenFromStorage(value: string | null): boolean {
  return value === '1';
}

// ---- Tool cards ------------------------------------------------------------------------------

/** A status chip's tone (its colour in agent.css). */
export type ToolTone = 'pending' | 'running' | 'ok' | 'denied' | 'failed' | 'expired';

export interface ToolCardModel {
  readonly callId: string;
  readonly toolName: string;
  readonly label: string;
  readonly status: AgentToolCardView['status'];
  readonly statusLabel: string;
  readonly tone: ToolTone;
  /** Whether the call is an MCP server's (untrusted) tool. */
  readonly untrusted: boolean;
  readonly input: string;
  /** The output preview (untrusted data or the error message), `null` until there is one. */
  readonly output: string | null;
}

const TONES: Readonly<Record<AgentToolCardView['status'], ToolTone>> = {
  requested: 'pending',
  'awaiting-approval': 'pending',
  running: 'running',
  done: 'ok',
  denied: 'denied',
  failed: 'failed',
  expired: 'expired',
};

export function toolStatusLabel(status: AgentToolCardView['status']): string {
  return AGENT_TOOL_STATUS_LABELS[status] ?? AGENT_TOOL_STATUS_LABELS.failed;
}

export function toolCardModel(card: AgentToolCardView): ToolCardModel {
  return {
    callId: card.callId,
    toolName: card.toolName,
    label: card.label,
    status: card.status,
    statusLabel: toolStatusLabel(card.status),
    tone: TONES[card.status] ?? 'failed',
    untrusted: isMcpToolName(card.toolName),
    input: card.inputPreview,
    output: card.outputPreview,
  };
}

// ---- Approval cards --------------------------------------------------------------------------

export interface ApprovalCardModel {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly label: string;
  /** The page the call acts on (without its fragment), or `null`. */
  readonly pageUrl: string | null;
  readonly origin: string | null;
  /** `execute_javascript`'s exact code, shown in full as code; `null` for other tools. */
  readonly code: string | null;
  /** The exact input (JSON text), in full; `null` when the code block already shows all of it. */
  readonly input: string | null;
  /** What the card says beside the code (`EXECUTE_JS_APPROVAL_NOTE`) or for an untrusted tool. */
  readonly note: string | null;
  /** Whether "Always allow on this site" is offered (`grantable` only). */
  readonly showAlways: boolean;
  readonly untrusted: boolean;
  /** "N more waiting", or `null` when this is the only one. */
  readonly queuedText: string | null;
  /** `navigate`'s full destination URL (its "Opens" line), `null` for other tools. */
  readonly destination: string | null;
  /** The chat asking, named when it isn't the one on screen (`null`: it is, or unknown). */
  readonly askingChat: string | null;
}

/** Where the panel is: the chat on screen and every chat's title (to name another chat asking). */
export interface ApprovalContext {
  readonly activeChatId: string | null;
  readonly chats: readonly Pick<AgentChatSummary, 'id' | 'title'>[];
}

/** Where a request acts, for its title: the page URL, else the origin, else "this page". */
const placeOf = (request: AgentApprovalView): string => request.pageUrl ?? request.origin ?? 'this page';

/** The card's question, per tool (frost's own words). */
export function approvalTitle(request: AgentApprovalView): string {
  switch (request.toolName) {
    case 'navigate':
      return `Allow navigation to ${request.origin ?? 'this address'}?`;
    case 'click':
      return `Allow click on ${placeOf(request)}?`;
    case 'execute_javascript':
      return `Run this JavaScript on ${placeOf(request)}?`;
    default:
      if (isMcpToolName(request.toolName) || request.risk === 'external') return `Untrusted tool: allow ${request.label}?`;
      return request.pageUrl !== null || request.origin !== null ? `Allow "${request.label}" on ${placeOf(request)}?` : `Allow "${request.label}"?`;
  }
}

/** Whether the input holds only `code` (so the code block shows all of it). */
function inputIsOnlyCode(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'code');
  } catch {
    return false;
  }
}

/** `navigate`'s destination: the input's `url` string, exactly as main will be asked to load it. */
function destinationOf(request: AgentApprovalView): string | null {
  if (request.toolName !== 'navigate') return null;
  try {
    const value: unknown = JSON.parse(request.input);
    const url = typeof value === 'object' && value !== null ? (value as { url?: unknown }).url : undefined;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

/** The asking chat's title when it isn't the chat on screen. */
function askingChatOf(request: AgentApprovalView, context: ApprovalContext | undefined): string | null {
  if (context === undefined || request.chatId === context.activeChatId) return null;
  const title = context.chats.find((chat) => chat.id === request.chatId)?.title.trim() ?? '';
  return title === '' ? 'another chat' : title;
}

export function approvalCardModel(approval: { readonly request: AgentApprovalView; readonly queued: number }, context?: ApprovalContext): ApprovalCardModel {
  const { request, queued } = approval;
  const untrusted = isMcpToolName(request.toolName) || request.risk === 'external';
  const code = request.toolName === 'execute_javascript' ? request.code : null;
  return {
    id: request.id,
    toolName: request.toolName,
    title: approvalTitle(request),
    label: request.label,
    pageUrl: request.pageUrl,
    origin: request.origin,
    code,
    input: code !== null && inputIsOnlyCode(request.input) ? null : request.input,
    note: request.note ?? (untrusted ? AGENT_MCP_APPROVAL_NOTE : null),
    showAlways: request.grantable === true,
    untrusted,
    queuedText: queued > 0 ? `${queued} more waiting` : null,
    destination: destinationOf(request),
    askingChat: askingChatOf(request, context),
  };
}

/** What the card says after an answer that didn't take, or `null` (it did). */
export function answerMessage(result: AgentAnswerResult): string | null {
  return result === 'answered' || result === 'granted' ? null : (AGENT_ANSWER_MESSAGES[result] ?? AGENT_ANSWER_MESSAGES.invalid);
}

// ---- Context meter ---------------------------------------------------------------------------

export interface ContextMeterModel {
  readonly tokens: number;
  readonly window: number | null;
  /** 0–100, `null` without a window. */
  readonly percent: number | null;
  readonly text: string;
  readonly level: 'ok' | 'high' | 'full';
}

/** `n` tokens, short: `950`, `12.3k`, `1M`, `1.25M`. */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trim(value / 1000, value < 100_000 ? 1 : 0)}k`;
  return `${trim(value / 1_000_000, 2)}M`;
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

/** The meter for the selected chat, or `null` before a step reported its usage. */
export function contextMeter(active: Pick<AgentActiveChatView, 'contextTokens' | 'contextWindow'> | null): ContextMeterModel | null {
  if (active === null || active.contextTokens === null || !Number.isFinite(active.contextTokens)) return null;
  const tokens = Math.max(0, active.contextTokens);
  const window = active.contextWindow !== null && Number.isFinite(active.contextWindow) && active.contextWindow > 0 ? active.contextWindow : null;
  if (window === null) return { tokens, window: null, percent: null, text: `${formatTokens(tokens)} tokens in context`, level: 'ok' };
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  const level = percent >= 95 ? 'full' : percent >= 75 ? 'high' : 'ok';
  return { tokens, window, percent, text: `${formatTokens(tokens)} of ${formatTokens(window)} tokens (${percent}%)`, level };
}

// ---- Settings --------------------------------------------------------------------------------

export const routeLabel = (route: ModelRoute): string => AGENT_ROUTE_LABELS[route] ?? route;
export const modelLabel = (modelId: ModelId): string => AGENT_MODEL_LABELS[modelId] ?? modelId;
export const slotLabel = (slot: CredentialSlot): string => AGENT_KEY_SLOT_LABELS[slot] ?? slot;
export const slotForRoute = (route: ModelRoute): CredentialSlot => ROUTE_CREDENTIAL_SLOT[route];

export function routeOptions(): readonly { readonly value: ModelRoute; readonly label: string }[] {
  return MODEL_ROUTES.map((value) => ({ value, label: routeLabel(value) }));
}

/** The model choices: exactly the setup's `allowedModels` (what the selected route serves). */
export function modelOptions(setup: Pick<AgentSetupView, 'allowedModels'>): readonly { readonly value: ModelId; readonly label: string }[] {
  return setup.allowedModels.map((value) => ({ value, label: modelLabel(value) }));
}

/** The model to keep when switching to `route`: the current one if it serves it, else its first. */
export function modelForRoute(route: ModelRoute, current: ModelId): ModelId | null {
  if (routeModelId(route, current) !== null) return current;
  return ALLOWED_MODEL_IDS.find((id) => routeModelId(route, id) !== null) ?? null;
}

/** The key slots in the order the settings list them: the selected route's first. */
export function keySlotsFor(route: ModelRoute): readonly CredentialSlot[] {
  const first = slotForRoute(route);
  return [first, ...CREDENTIAL_SLOTS.filter((slot) => slot !== first)];
}

export const keyStateLabel = (set: boolean): string => (set ? AGENT_KEY_SET_LABEL : AGENT_KEY_UNSET_LABEL);
export const protectionMessage = (setup: Pick<AgentSetupView, 'protection'>): string => AGENT_KEY_PROTECTION_MESSAGES[setup.protection] ?? AGENT_KEY_PROTECTION_MESSAGES.unavailable;
export const setKeyMessage = (result: AgentSetKeyResult): string => AGENT_SET_KEY_MESSAGES[result] ?? AGENT_SET_KEY_MESSAGES.failed;

/**
 * The agent process's isolation, said plainly and never more than is in effect: the network line
 * from the runtime's own report, and a file sandbox only when one is.
 */
export function isolationLine(setup: Pick<AgentSetupView, 'isolation' | 'runtime'>): string {
  const { isolation, runtime } = setup;
  if (!isolation.networkGlobalsRemoved && runtime.status !== 'ready') return 'Agent process: not started yet; it starts with your first message';
  const network = isolation.networkGlobalsRemoved ? 'network access removed' : 'some network functions could not be removed';
  const files = isolation.fileSandbox ? 'file access limited to its own files' : 'file sandbox not available on this platform';
  return `Agent process: ${network}; ${files}`;
}

export function runtimeLine(runtime: AgentSetupView['runtime']): string {
  switch (runtime.status) {
    case 'ready':
      return 'Running';
    case 'starting':
      return 'Starting…';
    case 'crashed':
      return 'Stopped after repeated failures; it starts again with your next message';
    default:
      return runtime.lastFailure === null ? 'Not started' : 'Stopped; it restarts with your next message';
  }
}

export interface ChecklistItem {
  readonly id: 'route' | 'model' | 'key' | 'keychain' | 'isolation';
  readonly label: string;
  readonly value: string;
  readonly ok: boolean;
}

/** The setup checklist (the settings page and the empty chat's hint). */
export function setupChecklist(setup: AgentSetupView): readonly ChecklistItem[] {
  const slot = slotForRoute(setup.route);
  const hasKey = setup.keys[slot] === true;
  return [
    { id: 'route', label: 'Model route', value: routeLabel(setup.route), ok: true },
    { id: 'model', label: 'Model', value: modelLabel(setup.modelId), ok: setup.allowedModels.includes(setup.modelId) },
    { id: 'key', label: slotLabel(slot), value: keyStateLabel(hasKey), ok: hasKey || setup.ready },
    { id: 'keychain', label: 'Key storage', value: protectionMessage(setup), ok: setup.protection === 'os' },
    { id: 'isolation', label: 'Isolation', value: isolationLine(setup), ok: setup.isolation.networkGlobalsRemoved },
  ];
}

// ---- Chat ------------------------------------------------------------------------------------

/** The notice to show, or `null` (none, or the user dismissed that one). */
export function visibleNotice(notice: AgentNoticeView | null, dismissedSeq: number): AgentNoticeView | null {
  return notice !== null && notice.seq > dismissedSeq ? notice : null;
}

/** The chat a Stop goes to: the running one (one turn at a time, app-wide). */
export function runningChatId(state: Pick<AgentState, 'chats' | 'active'>): string | null {
  if (state.active?.running) return state.active.id;
  return state.chats.find((chat) => chat.running)?.id ?? null;
}

/** What a key in the composer does: Enter sends, Shift+Enter (or an IME composition) types. */
export function composerKey(event: { readonly key: string; readonly shiftKey: boolean; readonly isComposing?: boolean }): 'send' | null {
  return event.key === 'Enter' && !event.shiftKey && event.isComposing !== true ? 'send' : null;
}

/** Whether the composer's text can be sent now. */
export function canSend(text: string, running: boolean, sending: boolean): boolean {
  return !running && !sending && text.trim() !== '';
}

/** How close to the bottom (px) still counts as following the stream. */
export const FOLLOW_THRESHOLD_PX = 24;

/** Whether a scroller is at (or near) its bottom: new text keeps it there, else the user's place holds. */
export function isAtBottom(metrics: { readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number }): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= FOLLOW_THRESHOLD_PX;
}

export interface ChatListItem {
  readonly id: string;
  readonly title: string;
  readonly selected: boolean;
  readonly running: boolean;
}

export function chatListItems(chats: readonly AgentChatSummary[], activeId: string | null): readonly ChatListItem[] {
  return chats.map((chat) => ({ id: chat.id, title: chat.title.trim() === '' ? 'Untitled chat' : chat.title, selected: chat.id === activeId, running: chat.running }));
}

/** The panel header's second line: the selected chat's title, or "New chat". */
export function chatHeading(active: AgentActiveChatView | null): string {
  return active === null || active.title.trim() === '' ? 'New chat' : active.title;
}

/** The rail toggle's badge: an approval waiting (most urgent), a turn running, or nothing. */
export function railBadge(state: Pick<AgentState, 'approval' | 'running'> | null): 'approval' | 'running' | null {
  if (state === null) return null;
  if (state.approval !== null) return 'approval';
  return state.running ? 'running' : null;
}
