import { z } from 'zod';
import { MAX_STORED_ROWS_PER_CHAT, STORED_CHAT_TITLE_MAX_CHARS } from '@app/specs/agent-data.spec';
import { AgentChatIdSchema } from '@app/specs/agent-ipc.schema';
import { AGENT_PROTOCOL_LIMITS, AgentIdSchema, ChatMessageSchema, ToolNameSchema, type ChatMessage } from '@app/specs/agent-protocol.schema';
import { MAX_TOOL_CARDS_PER_TURN, TOOL_CARD_INPUT_PREVIEW_CHARS, TOOL_CARD_OUTPUT_PREVIEW_CHARS, type AgentToolCardView, type AgentUsageView } from '@app/specs/agent-session.spec';
import { isAllowedModelId, TOOL_ERROR_CODES, type ModelId, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import { SkillIdSchema } from '@app/specs/skills-schema';
import { SKILL_LIMITS } from '@app/specs/skills.spec';

// A chat as main stores and exports it (Phase 5 Task 9; spec `specs/agent-data.spec.ts`; acceptance
// `specs/agent-data.feature.md`, Stored chats). The session hands out a `ChatSnapshot` of a finished
// turn's chat: its history in the protocol shape (what the model is sent: the user's messages, the
// steps, and main's untrusted-wrapped tool results, each already bounded) and its display entries
// (the tool cards with their bounded previews). Nothing else: no key, no approval id, no input
// hash. `encodeChat` turns one into `@app/db` rows; `decodeChat` validates rows read back, every
// message with the protocol's own schema, so a tampered file can't put anything else in a chat.

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
  readonly modelId: ModelId | null;
  readonly usage: AgentUsageView | null;
  readonly contextTokens: number | null;
  readonly truncated: boolean;
  readonly history: readonly ChatMessage[];
  readonly entries: readonly EntrySnapshot[];
}

/** The `@app/db` row shape (`StoredAgentChat`), restated so main needn't import the database's types here. */
export interface ChatRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly modelId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly contextTokens: number | null;
  readonly truncated: boolean;
  readonly messages: readonly string[];
  readonly entries: readonly string[];
}

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

/** A chat as `@app/db` rows: the latest rows only (`MAX_STORED_ROWS_PER_CHAT` of each). */
export function encodeChat(chat: ChatSnapshot): ChatRow {
  const history = chat.history.slice(-MAX_STORED_ROWS_PER_CHAT);
  // Never start at an orphaned result: the window begins at a user message.
  const start = history.findIndex((message) => message.role === 'user');
  const entries = chat.entries.slice(-MAX_STORED_ROWS_PER_CHAT);
  return {
    id: chat.id,
    title: chat.title.slice(0, STORED_CHAT_TITLE_MAX_CHARS),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    modelId: chat.modelId,
    inputTokens: count(chat.usage?.input),
    outputTokens: count(chat.usage?.output),
    contextTokens: count(chat.contextTokens),
    truncated: chat.truncated || entries.length < chat.entries.length,
    messages: (start === -1 ? [] : history.slice(start)).map((message) => JSON.stringify(message)),
    // Field by field: what a card is stored with is exactly what it is shown with (its label is the catalogue's).
    entries: entries.map((entry) =>
      JSON.stringify({
        kind: entry.kind,
        text: entry.text,
        tools: entry.tools.map((card) => ({ callId: card.callId, toolName: card.toolName, status: card.status, code: card.code, inputPreview: card.inputPreview, outputPreview: card.outputPreview })),
        ...(entry.skill !== undefined ? { skill: { id: entry.skill.id, name: entry.skill.name } } : {}),
      }),
    ),
  };
}

/**
 * A stored chat, validated: `null` for a row that can't be one (an id that isn't a chat id, a bad
 * time). Each message and entry is parsed and checked on its own; one that fails is left out.
 * The history is checked again for pairing by the session when it restores the chat.
 */
export function decodeChat(row: ChatRow): ChatSnapshot | null {
  if (!AgentChatIdSchema.safeParse(row.id).success || typeof row.title !== 'string') return null;
  if (!Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) return null;
  const history: ChatMessage[] = [];
  for (const text of row.messages.slice(0, MAX_STORED_ROWS_PER_CHAT)) {
    const parsed = ChatMessageSchema.safeParse(parseJson(text));
    if (parsed.success) history.push(parsed.data);
  }
  const entries: EntrySnapshot[] = [];
  for (const text of row.entries.slice(0, MAX_STORED_ROWS_PER_CHAT)) {
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
  const input = count(row.inputTokens);
  const output = count(row.outputTokens);
  return {
    id: row.id,
    title: row.title,
    createdAt: Math.max(0, row.createdAt),
    updatedAt: row.updatedAt,
    modelId: isAllowedModelId(row.modelId) ? row.modelId : null,
    usage: input === null && output === null ? null : { input, output },
    contextTokens: count(row.contextTokens),
    truncated: row.truncated === true || entries.length < row.entries.length,
    history,
    entries,
  };
}
