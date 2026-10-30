import { z } from 'zod';
import { MAX_STORED_ROWS_PER_CHAT, STORED_CHAT_TITLE_MAX_CHARS } from '@app/specs/agent-data.spec';
import { AgentChatIdSchema } from '@app/specs/agent-ipc.schema';
import { AGENT_PROTOCOL_LIMITS, AgentIdSchema, ChatMessageSchema, ToolNameSchema, type ChatMessage } from '@app/specs/agent-protocol.schema';
import { MAX_TOOL_CARDS_PER_TURN, TOOL_CARD_INPUT_PREVIEW_CHARS, TOOL_CARD_OUTPUT_PREVIEW_CHARS, type AgentToolCardView, type AgentUsageView } from '@app/specs/agent-session.spec';
import { isAgentModelId, TOOL_ERROR_CODES, type AgentModelId, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import { SkillIdSchema } from '@app/specs/skills-schema';
import { SKILL_LIMITS } from '@app/specs/skills.spec';

// A chat as main stores and exports it (Phase 5 Task 9; spec `specs/agent-data.spec.ts`; acceptance
// `specs/agent-data.feature.md`, Stored chats). The session hands out a `ChatSnapshot` of a finished
// turn's chat: its history in the protocol shape (what the model is sent: the user's messages, the
// steps, and main's untrusted-wrapped tool results, each already bounded) and its display entries
// (the tool cards with their bounded previews). Nothing else: no key, no approval id, no input
// hash. `encodeHead` / `encodeMessages` / `encodeEntries` turn one into `@app/db` rows (a turn's save
// writes only the rows after the stored ones); `decodeHead` / `decodeRows` validate rows read back,
// every message with the protocol's own schema, so a tampered file can't put anything else in a chat.

export interface ToolCardSnapshot {
  readonly callId: string;
  readonly toolName: string;
  readonly status: AgentToolCardView['status'];
  readonly code: ToolErrorCode | null;
  readonly inputPreview: string;
  readonly outputPreview: string | null;
}

export interface EntrySnapshot {
  readonly kind: 'user' | 'assistant';
  readonly text: string;
  readonly tools: readonly ToolCardSnapshot[];
  readonly skill?: { readonly id: string; readonly name: string };
}

export interface ChatSnapshot {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly modelId: AgentModelId | null;
  readonly usage: AgentUsageView | null;
  readonly contextTokens: number | null;
  readonly truncated: boolean;
  readonly history: readonly ChatMessage[];
  readonly entries: readonly EntrySnapshot[];
}

/** A chat's own row as `@app/db` stores it (`StoredAgentChatHead`), restated so main needn't import the database's types here. */
export interface ChatHeadRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly modelId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly contextTokens: number | null;
  readonly truncated: boolean;
}

/** A chat's rows (`StoredAgentChatRows`). */
export interface ChatRowsRow {
  readonly messages: readonly string[];
  readonly entries: readonly string[];
}

/** The rows a save replaces from the given positions on (`AgentChatRowsUpdate`). */
export interface ChatRowsUpdate {
  readonly messagesFrom: number;
  readonly messages: readonly string[];
  readonly entriesFrom: number;
  readonly entries: readonly string[];
}

/** A chat without its rows: what the list shows before the chat is opened. */
export type ChatHead = Omit<ChatSnapshot, 'history' | 'entries'>;

const TOOL_CARD_STATUSES = ['requested', 'awaiting-approval', 'running', 'done', 'denied', 'failed', 'expired'] as const satisfies readonly AgentToolCardView['status'][];
/** A stored card still in progress was cut off: it reads back expired. */
const SETTLED: Readonly<Record<AgentToolCardView['status'], { status: AgentToolCardView['status']; code: ToolErrorCode | null } | null>> = {
  requested: { status: 'failed', code: 'failed' },
  'awaiting-approval': { status: 'expired', code: 'expired' },
  running: { status: 'expired', code: 'expired' },
  done: null,
  denied: null,
  failed: null,
  expired: null,
};

const ToolCardRowSchema = z.strictObject({
  callId: AgentIdSchema,
  toolName: ToolNameSchema,
  status: z.enum(TOOL_CARD_STATUSES),
  code: z.enum(TOOL_ERROR_CODES).nullable(),
  inputPreview: z.string().max(TOOL_CARD_INPUT_PREVIEW_CHARS),
  outputPreview: z.string().max(TOOL_CARD_OUTPUT_PREVIEW_CHARS).nullable(),
});

const EntryRowSchema = z.strictObject({
  kind: z.enum(['user', 'assistant']),
  text: z.string().max(AGENT_PROTOCOL_LIMITS.maxMessageChars),
  tools: z.array(ToolCardRowSchema).max(MAX_TOOL_CARDS_PER_TURN),
  skill: z.strictObject({ id: SkillIdSchema, name: z.string().min(1).max(SKILL_LIMITS.maxNameChars) }).optional(),
});

const count = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** A chat's own row. */
export function encodeHead(chat: ChatHead): ChatHeadRow {
  return {
    id: chat.id,
    title: chat.title.slice(0, STORED_CHAT_TITLE_MAX_CHARS),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    modelId: chat.modelId,
    inputTokens: count(chat.usage?.input),
    outputTokens: count(chat.usage?.output),
    contextTokens: count(chat.contextTokens),
    truncated: chat.truncated,
  };
}

/** History messages as rows, one JSON text each. */
export function encodeMessages(history: readonly ChatMessage[]): string[] {
  return history.map((message) => JSON.stringify(message));
}

/** Display entries as rows. Field by field: what a card is stored with is exactly what it is shown with (its label is the catalogue's). */
export function encodeEntries(entries: readonly EntrySnapshot[]): string[] {
  return entries.map((entry) =>
    JSON.stringify({
      kind: entry.kind,
      text: entry.text,
      tools: entry.tools.map((card) => ({ callId: card.callId, toolName: card.toolName, status: card.status, code: card.code, inputPreview: card.inputPreview, outputPreview: card.outputPreview })),
      ...(entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}),
    }),
  );
}

/** A whole chat's rows (a full rewrite), within `MAX_STORED_ROWS_PER_CHAT` each. */
export function encodeChat(chat: ChatSnapshot): { head: ChatHeadRow; rows: ChatRowsUpdate } {
  return {
    head: encodeHead(chat),
    rows: { messagesFrom: 0, messages: encodeMessages(chat.history.slice(-MAX_STORED_ROWS_PER_CHAT)), entriesFrom: 0, entries: encodeEntries(chat.entries.slice(-MAX_STORED_ROWS_PER_CHAT)) },
  };
}

/**
 * A stored chat's own row, validated: `null` for a row that can't be one (an id that isn't a chat
 * id, a bad time). Times in the future (a clock moved back, a tampered file) read as `now`.
 */
export function decodeHead(row: ChatHeadRow, now: number): ChatHead | null {
  if (!AgentChatIdSchema.safeParse(row.id).success || typeof row.title !== 'string') return null;
  if (!Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) return null;
  const input = count(row.inputTokens);
  const output = count(row.outputTokens);
  const updatedAt = Math.min(row.updatedAt, now);
  return {
    id: row.id,
    title: row.title,
    createdAt: Math.min(Math.max(0, row.createdAt), updatedAt),
    updatedAt,
    modelId: isAgentModelId(row.modelId) ? row.modelId : null,
    usage: input === null && output === null ? null : { input, output },
    contextTokens: count(row.contextTokens),
    truncated: row.truncated === true,
  };
}

/**
 * A stored chat's rows, validated: each message with the protocol's schema and each entry with its
 * own, one that fails left out (`exact` is then `false`: the rows no longer line up with what is
 * stored, so the next save rewrites them). The session re-pairs the history's results with their calls.
 */
export function decodeRows(rows: ChatRowsRow): { history: ChatMessage[]; entries: EntrySnapshot[]; exact: boolean } {
  const history: ChatMessage[] = [];
  for (const text of rows.messages.slice(0, MAX_STORED_ROWS_PER_CHAT)) {
    const parsed = ChatMessageSchema.safeParse(parseJson(text));
    if (parsed.success) history.push(parsed.data);
  }
  const entries: EntrySnapshot[] = [];
  for (const text of rows.entries.slice(0, MAX_STORED_ROWS_PER_CHAT)) {
    const parsed = EntryRowSchema.safeParse(parseJson(text));
    if (!parsed.success) continue;
    const entry = parsed.data;
    entries.push({
      kind: entry.kind,
      text: entry.text,
      tools: entry.kind === 'user' ? [] : entry.tools.map((card) => ({ ...card, ...(SETTLED[card.status] ?? {}) })),
      ...(entry.kind === 'user' && entry.skill !== undefined ? { skill: entry.skill } : {}),
    });
  }
  return { history, entries, exact: history.length === rows.messages.length && entries.length === rows.entries.length };
}
