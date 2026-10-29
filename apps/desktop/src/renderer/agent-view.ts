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
import {
  MCP_NO_SANDBOX_SENTENCE,
  MCP_SAVE_MESSAGES,
  MCP_SETTINGS_WORDS,
  MCP_START_MESSAGES,
  MCP_STATUS_LABELS,
  MCP_TOKEN_MESSAGES,
  MCP_UNTRUSTED_LABEL,
  mcpServerIdOf,
  type AgentMcpServerView,
  type AgentMcpView,
  type McpSaveResult,
  type McpStartResult,
  type McpTokenResult,
} from '@app/specs/agent-mcp.spec';
import type {
  AgentActiveChatView,
  AgentAnswerResult,
  AgentApprovalView,
  AgentChatSummary,
  AgentNoticeView,
  AgentSetKeyResult,
  AgentMessageView,
  AgentSetupView,
  AgentSkillRequest,
  AgentSkillView,
  AgentState,
  AgentToolCardView,
} from '@app/specs/agent-session.spec';
import { SKILL_ACTING_TOOLS, SKILL_INPUT_SLOTS, SKILL_SLOT_MAX_CHARS, SKILL_SLOT_NAMES, SKILL_USER_MARK, SKILL_WARNINGS, templateSlots, type SkillInputSlot, type SkillSlotName } from '@app/specs/skills.spec';
import { AGENT_TOOL_NAMES, AGENT_TOOLS, ALLOWED_MODEL_IDS, MODEL_ROUTES, UNSAFE_INPUT_CHARS, isMcpToolName, routeModelId, type AgentToolName, type AgentToolRisk, type ModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import {
  AGENT_SAVE_SKILL_MESSAGES,
  CHAT_EXPORT_MESSAGES,
  CHAT_RETENTION_HINTS,
  CHAT_RETENTION_LABELS,
  CHAT_RETENTIONS,
  DEFAULT_CHAT_RETENTION,
  SKILL_BUILTIN_LABEL,
  SKILL_USER_LABEL,
  type AgentDeleteAllChatsResult,
  type AgentGrantView,
  type AgentSaveSkillResult,
  type AgentSkillDetail,
  type AgentSkillDraft,
  type ChatExportResult,
  type ChatRetention,
  type SkillEditorField,
} from '@app/specs/agent-data.spec';

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
    case 'run_visibility_probes':
      return `Fetch ${placeOf(request)} as search and AI crawlers would?`;
    default:
      if (isMcpToolName(request.toolName) || request.risk === 'external') return `${request.label}: allow "${mcpToolPartOf(request.toolName)}"?`;
      return request.pageUrl !== null || request.origin !== null ? `Allow "${request.label}" on ${placeOf(request)}?` : `Allow "${request.label}"?`;
  }
}

/** The tool part of an MCP tool name (`mcp__<server>__<tool>`), else the name. */
function mcpToolPartOf(toolName: string): string {
  const server = mcpServerIdOf(toolName);
  return server === null ? toolName : toolName.slice(`mcp__${server}__`.length);
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
  // Its network functions (the globals), not all network access: it is not OS-sandboxed. The file
  // sandbox isn't in effect because Electron 45 doesn't enforce Node's permission model there.
  const network = isolation.networkGlobalsRemoved ? 'network functions removed' : 'some network functions could not be removed';
  const files = isolation.fileSandbox ? 'File sandbox: in effect' : 'File sandbox: not in effect';
  return `Agent process: ${network}. ${files}`;
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

// ---- Skills (Task 7) -------------------------------------------------------------------------

/** What a skill input field holds, by slot (the composer's fields). */
export type SkillFieldValues = { readonly [S in SkillInputSlot]?: string };

/** A skill's name as the picker and the palette show it: the user's own marked "Your skill". */
export function skillDisplayName(skill: Pick<AgentSkillView, 'name' | 'builtin'>): string {
  return skill.builtin ? skill.name : `${skill.name} (${SKILL_USER_MARK})`;
}

/** The picker's choices: "no skill" (a typed message), then main's skills in order. */
export function skillOptions(skills: readonly AgentSkillView[]): readonly { readonly value: string; readonly label: string }[] {
  return [{ value: '', label: 'Write a message' }, ...skills.map((skill) => ({ value: skill.id, label: skillDisplayName(skill) }))];
}

const UNSAFE_ALL = new RegExp(UNSAFE_INPUT_CHARS.source, 'gu');

/** `text` cut at `max` UTF-16 units, never between a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The skill picked (`''`: none), or `null` when main no longer lists it. */
export function pickedSkill(skills: readonly AgentSkillView[], id: string): AgentSkillView | null {
  return id === '' ? null : (skills.find((skill) => skill.id === id) ?? null);
}

/**
 * The `agent.send` request for running `skill` with the composer's fields: only the slots the skill
 * declares, each trimmed and cut to its cap (`SKILL_SLOT_MAX_CHARS`); a blank field is left out.
 */
export function skillRequest(skill: AgentSkillView, values: SkillFieldValues): AgentSkillRequest {
  const request: { skillId: string; userNote?: string; targetQuery?: string } = { skillId: skill.id };
  for (const input of skill.inputs) {
    // Invisible characters (an emoji's joiner, a soft hyphen) are dropped here too; main cleans again.
    const value = (values[input.slot] ?? '').replace(UNSAFE_ALL, '').trim();
    if (value !== '') request[input.slot] = cutText(value, SKILL_SLOT_MAX_CHARS[input.slot]);
  }
  return request;
}

/** The label a user message carries in the chat: the skill it ran, or `null` for a typed message. */
export function userMessageSkillLabel(message: AgentMessageView): string | null {
  return message.kind === 'user' && message.skill !== undefined ? `Skill: ${message.skill.name}` : null;
}

// ---- Grants page, chat data and skills editor (Task 9; `agent-data.spec.ts`) ----------------

export interface GrantItem {
  readonly key: string;
  readonly tool: string;
  readonly label: string;
  readonly origin: string;
  /** When it was given, as a short local date and time. */
  readonly since: string;
}

/** A local date and time, short (`28 Oct 2026, 14:05`), or `''` for a time that isn't one. */
export function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The grants page's rows, oldest first (main's order). */
export function grantItems(grants: readonly AgentGrantView[]): readonly GrantItem[] {
  return grants.map((grant) => ({ key: `${grant.tool}\n${grant.origin}`, tool: grant.tool, label: grant.label, origin: grant.origin, since: formatWhen(grant.createdAt) }));
}

export function retentionOptions(): readonly { readonly value: ChatRetention; readonly label: string }[] {
  return CHAT_RETENTIONS.map((value) => ({ value, label: CHAT_RETENTION_LABELS[value] }));
}

export const retentionHint = (retention: ChatRetention): string => CHAT_RETENTION_HINTS[retention] ?? CHAT_RETENTION_HINTS[DEFAULT_CHAT_RETENTION];
export const exportMessage = (result: ChatExportResult): string => CHAT_EXPORT_MESSAGES[result] ?? CHAT_EXPORT_MESSAGES.failed;

export function deleteAllChatsMessage(result: AgentDeleteAllChatsResult): string | null {
  if (result === 'deleted') return 'Every chat was deleted.';
  if (result === 'failed') return 'Some saved chats could not be deleted. Try again.';
  return null;
}

/** What the skills list shows for each skill: built-ins read-only (duplicate to edit), the user's editable. */
export interface SkillListItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly builtin: boolean;
  readonly badge: string;
}

export function skillListItems(skills: readonly AgentSkillView[]): readonly SkillListItem[] {
  return skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, builtin: skill.builtin, badge: skill.builtin ? SKILL_BUILTIN_LABEL : SKILL_USER_LABEL }));
}

/** The editor's working copy (`AgentSkillDraft`, mutable by replacing it). */
export interface SkillEditorDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly inputs: readonly { readonly slot: SkillInputSlot; readonly label: string; readonly placeholder: string }[];
}

export function emptySkillDraft(): SkillEditorDraft {
  return { id: '', name: '', description: '', allowedTools: ['page_audit', 'page_data', 'page_text'], instructions: 'Review the page at {{pageUrl}} (titled {{pageTitle}}).\n', inputs: [] };
}

export function draftFromDetail(detail: AgentSkillDetail): SkillEditorDraft {
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    allowedTools: [...detail.allowedTools],
    instructions: detail.instructions,
    inputs: detail.inputs.map((input) => ({ slot: input.slot, label: input.label, placeholder: input.placeholder ?? '' })),
  };
}

/** The draft as `agent.saveSkill` takes it (tools in catalogue order; blank placeholders left out). */
export function draftToSkill(draft: SkillEditorDraft): AgentSkillDraft {
  const chosen = new Set(draft.allowedTools);
  return {
    id: draft.id.trim(),
    name: draft.name,
    description: draft.description,
    allowedTools: [...AGENT_TOOL_NAMES.filter((name) => chosen.has(name)), ...draft.allowedTools.filter((name) => !(AGENT_TOOL_NAMES as readonly string[]).includes(name))],
    instructions: draft.instructions,
    inputs: draft.inputs.map((input) => ({ slot: input.slot, label: input.label, ...(input.placeholder.trim() !== '' ? { placeholder: input.placeholder } : {}) })),
  };
}

export const SKILL_RISK_LABELS: Readonly<Record<AgentToolRisk, string>> = {
  read: 'Reads only',
  act: 'Acts: asks first unless you allowed the site',
  execute: 'Runs code: asks every time',
  external: 'Untrusted: asks every time',
};

/** The editor's tool checkboxes: frost's catalogue in order, each with its risk said plainly. */
export function toolChoices(): readonly { readonly name: AgentToolName; readonly label: string; readonly risk: AgentToolRisk; readonly riskLabel: string }[] {
  return AGENT_TOOL_NAMES.map((name) => ({ name, label: AGENT_TOOLS[name].label, risk: AGENT_TOOLS[name].risk, riskLabel: SKILL_RISK_LABELS[AGENT_TOOLS[name].risk] }));
}

export function toggleTool(draft: SkillEditorDraft, name: string, on: boolean): SkillEditorDraft {
  const rest = draft.allowedTools.filter((tool) => tool !== name);
  return { ...draft, allowedTools: on ? [...rest, name] : rest };
}

/** What each `{{slot}}` holds, for the editor's list of allowed placeholders. */
export const SKILL_SLOT_HELP: Readonly<Record<SkillSlotName, string>> = {
  pageUrl: "The tab's page address (filled by frost)",
  pageTitle: "The tab's page title (filled by frost)",
  targetQuery: 'A search query the user types (an input)',
  userNote: 'A note the user types (an input)',
};

export function slotHelp(): readonly { readonly slot: SkillSlotName; readonly placeholder: string; readonly help: string; readonly input: boolean }[] {
  return SKILL_SLOT_NAMES.map((slot) => ({ slot, placeholder: `{{${slot}}}`, help: SKILL_SLOT_HELP[slot], input: (SKILL_INPUT_SLOTS as readonly string[]).includes(slot) }));
}

/** The slots the instructions use, or `null` when a placeholder isn't allowed (main says so too). */
export const draftSlots = (draft: Pick<SkillEditorDraft, 'instructions'>): readonly SkillSlotName[] | null => templateSlots(draft.instructions);

/** Turns asking the user for `slot` on (with a default label) or off. */
export function toggleInput(draft: SkillEditorDraft, slot: SkillInputSlot, on: boolean): SkillEditorDraft {
  const rest = draft.inputs.filter((input) => input.slot !== slot);
  if (!on) return { ...draft, inputs: rest };
  const label = slot === 'targetQuery' ? 'Target query (optional)' : 'Note (optional)';
  return { ...draft, inputs: SKILL_INPUT_SLOTS.flatMap((name) => (name === slot ? [{ slot, label, placeholder: '' }] : rest.filter((input) => input.slot === name))) };
}

export function setInputField(draft: SkillEditorDraft, slot: SkillInputSlot, field: 'label' | 'placeholder', value: string): SkillEditorDraft {
  return { ...draft, inputs: draft.inputs.map((input) => (input.slot === slot ? { ...input, [field]: value } : input)) };
}

/** Main's inline errors by field (the first per field). */
export function fieldErrors(result: AgentSaveSkillResult | null): Partial<Record<SkillEditorField, string>> {
  if (result === null || result.result !== 'invalid') return {};
  const out: Partial<Record<SkillEditorField, string>> = {};
  for (const error of result.errors) out[error.field] ??= error.message;
  return out;
}

/** What the editor says after Save (or Duplicate), `null` for nothing. */
export function saveSkillMessage(result: AgentSaveSkillResult | null): string | null {
  if (result === null) return null;
  return AGENT_SAVE_SKILL_MESSAGES[result.result] ?? AGENT_SAVE_SKILL_MESSAGES.failed;
}

/**
 * What the skills editor warns about a draft (it still saves): a name a built-in skill already has
 * (`builtinNames`, compared case- and space-insensitively), and acting tools (`SKILL_ACTING_TOOLS`).
 */
export function skillDraftWarnings(draft: Pick<SkillEditorDraft, 'name' | 'allowedTools'>, builtinNames: readonly string[]): readonly string[] {
  const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const warnings: string[] = [];
  if (draft.name.trim() !== '' && builtinNames.some((name) => key(name) === key(draft.name))) warnings.push(SKILL_WARNINGS.builtinName);
  if (draft.allowedTools.some((tool) => (SKILL_ACTING_TOOLS as readonly string[]).includes(tool))) warnings.push(SKILL_WARNINGS.actingTools);
  return warnings;
}

/**
 * The chat a palette "Run skill" runs in: the chat on screen when it works on the active tab, else
 * `null` (a new chat, which main binds to the active tab), so a skill never runs on a tab the user
 * isn't looking at.
 */
export function skillRunChatId(active: Pick<AgentActiveChatView, 'id' | 'tabId'> | null, activeTabId: number | null): string | null {
  return active !== null && activeTabId !== null && active.tabId === activeTabId ? active.id : null;
}

// ---- MCP servers (Task 10, `agent-mcp.spec.ts`) ----------------------------------------------

export interface McpServerItem {
  readonly id: string;
  readonly name: string;
  readonly transport: AgentMcpServerView['transport'];
  readonly transportLabel: string;
  readonly target: string;
  readonly enabled: boolean;
  readonly status: AgentMcpServerView['status'];
  readonly statusLabel: string;
  readonly tone: ToolTone;
  /** The sandbox sentence (main's, `mcpSandboxSentence`). */
  readonly sandboxNote: string;
  /** Whether it runs with no sandbox at all (the sentence says so plainly). */
  readonly unsandboxed: boolean;
  readonly toolsText: string;
  readonly error: string | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly hasToken: boolean;
  readonly envNames: readonly string[];
}

const MCP_TONES: Readonly<Record<AgentMcpServerView['status'], ToolTone>> = { stopped: 'pending', starting: 'running', ready: 'ok', failed: 'failed' };

export function mcpServerItems(view: AgentMcpView | null | undefined): readonly McpServerItem[] {
  return (view?.servers ?? []).map((server) => ({
    id: server.id,
    name: server.name,
    transport: server.transport,
    transportLabel: server.transport === 'http' ? 'HTTP server' : 'Command',
    target: server.target,
    enabled: server.enabled,
    status: server.status,
    statusLabel: MCP_STATUS_LABELS[server.status] ?? MCP_STATUS_LABELS.failed,
    tone: MCP_TONES[server.status] ?? 'failed',
    sandboxNote: server.sandboxNote,
    unsandboxed: server.transport === 'stdio' && server.sandbox === 'none',
    toolsText: server.status === 'ready' ? `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}` : '',
    error: server.lastError,
    canStart: view?.available === true && server.enabled && (server.status === 'stopped' || server.status === 'failed'),
    canStop: server.status === 'starting' || server.status === 'ready',
    hasToken: server.hasToken,
    envNames: server.envNames,
  }));
}

/** The add-server form, as typed (one argument and one folder per line; environment rows). */
export interface McpServerDraft {
  readonly name: string;
  readonly transport: 'http' | 'stdio';
  readonly url: string;
  readonly command: string;
  readonly args: string;
  readonly readPaths: string;
  readonly allowNetwork: boolean;
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export function emptyMcpDraft(): McpServerDraft {
  return { name: '', transport: 'stdio', url: '', command: '', args: '', readPaths: '', allowNetwork: false, env: [] };
}

const lines = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * The draft as `agent.saveMcpServer`'s input: arguments one per line exactly as typed (no shell
 * splitting or quoting: each line is one argument), blank lines dropped; environment rows with a
 * name, their value sent only when typed. `null` when a required field is empty.
 */
export function mcpDraftToInput(draft: McpServerDraft): AgentSaveMcpServerRequest | null {
  const name = draft.name.trim();
  if (name === '') return null;
  if (draft.transport === 'http') {
    const url = draft.url.trim();
    return url === '' ? null : { name, transport: 'http', url };
  }
  const command = draft.command.trim();
  if (command === '') return null;
  const args = draft.args.split(/\r\n|\r|\n/).filter((line) => line !== '');
  const env = draft.env.filter((item) => item.name.trim() !== '').map((item) => ({ name: item.name.trim(), ...(item.value !== '' ? { value: item.value } : {}) }));
  return { name, transport: 'stdio', command, args, readPaths: lines(draft.readPaths), allowNetwork: draft.allowNetwork, env };
}

/** What `agent.saveMcpServer` sends (the router's input shape; the renderer stays Zod-free). */
export type AgentSaveMcpServerRequest =
  | { readonly name: string; readonly transport: 'http'; readonly url: string; readonly id?: string }
  | {
      readonly name: string;
      readonly transport: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly readPaths: readonly string[];
      readonly allowNetwork: boolean;
      readonly env: readonly { readonly name: string; readonly value?: string }[];
      readonly id?: string;
    };

export const mcpSaveMessage = (result: McpSaveResult): string => MCP_SAVE_MESSAGES[result] ?? MCP_SAVE_MESSAGES.failed;
export const mcpStartMessage = (result: McpStartResult): string | null => (Object.hasOwn(MCP_START_MESSAGES, result) ? MCP_START_MESSAGES[result] : null);
export const mcpTokenMessage = (result: McpTokenResult): string => MCP_TOKEN_MESSAGES[result] ?? MCP_TOKEN_MESSAGES.failed;
export { MCP_NO_SANDBOX_SENTENCE, MCP_SETTINGS_WORDS, MCP_UNTRUSTED_LABEL };
