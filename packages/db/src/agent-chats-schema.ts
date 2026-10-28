import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The agent's stored chats (Phase 5 Task 9; spec `specs/agent-data.spec.ts`, `AGENT_CHAT_TABLES`;
// acceptance `specs/agent-data.feature.md`, Stored chats). Migration `0031_agent_chats` creates
// exactly these tables. Times are Unix milliseconds. Message and entry rows are JSON text main
// writes and validates again when it reads them (the database never parses them).

/** One row per stored chat. */
export const agentChats = sqliteTable('agent_chats', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** The model the last turn used (`ALLOWED_MODEL_IDS`), if any. */
  modelId: text('model_id'),
  /** The last turn's token usage and the context the next one starts from, if reported. */
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  contextTokens: integer('context_tokens'),
  /** Whether earlier entries were dropped before the chat was stored. */
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
});

/** What the model is sent: one protocol `ChatMessage` (JSON) per row, in order. */
export const agentChatMessages = sqliteTable(
  'agent_chat_messages',
  {
    chatId: text('chat_id').notNull(),
    seq: integer('seq').notNull(),
    message: text('message').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.seq] })],
);

/** What the panel shows (the display copy): one entry (JSON: a user message or an assistant step with its tool cards) per row. */
export const agentChatEntries = sqliteTable(
  'agent_chat_entries',
  {
    chatId: text('chat_id').notNull(),
    seq: integer('seq').notNull(),
    entry: text('entry').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.seq] })],
);
