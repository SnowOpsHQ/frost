import type { Migration } from './migrations';

// The agent's stored chats (Phase 5 Task 9; ids `0030`–`0039` are Phase 5's), appended to
// `MIGRATIONS` after `0030_agent_grants`. They create exactly the tables of `agent-chats-schema.ts`
// (`AGENT_CHAT_TABLES`). The retention setting lives in `agent_preferences` (`0030`).

export const AGENT_CHATS_MIGRATIONS: readonly Migration[] = [
  {
    id: '0031_agent_chats',
    sql: `
      CREATE TABLE agent_chats (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        context_tokens INTEGER,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE agent_chat_messages (
        chat_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
      );
      CREATE TABLE agent_chat_entries (
        chat_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (chat_id, seq)
      );
    `,
  },
];
