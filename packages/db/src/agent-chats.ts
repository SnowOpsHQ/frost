import { asc, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import {
  CHAT_RETENTION_PREFERENCE_KEY,
  DEFAULT_CHAT_RETENTION,
  isChatRetention,
  MAX_STORED_CHATS,
  MAX_STORED_ROWS_PER_CHAT,
  STORED_CHAT_ID_MAX_CHARS,
  STORED_CHAT_ROW_MAX_CHARS,
  STORED_CHAT_TITLE_MAX_CHARS,
  type ChatRetention,
} from '@app/specs/agent-data.spec';
import type { SessionDatabase } from './client';
import { agentPreferences } from './agent-grants-schema';
import { agentChatEntries, agentChatMessages, agentChats } from './agent-chats-schema';

// The agent's stored chats and their retention (Phase 5 Task 9; spec `specs/agent-data.spec.ts`;
// acceptance `specs/agent-data.feature.md`, Stored chats). A chat is its row plus its messages (the
// protocol shape the model is sent) and its entries (the display copy), each a JSON text main
// wrote; main parses and validates them again on the way out, so the database never interprets
// them. At most `MAX_STORED_CHATS` are kept: saving one more deletes the least recently updated.

/** A chat as stored. */
export interface StoredAgentChat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly modelId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly contextTokens: number | null;
  readonly truncated: boolean;
  /** Protocol `ChatMessage`s, one JSON text each, in order. */
  readonly messages: readonly string[];
  /** Display entries, one JSON text each, in order. */
  readonly entries: readonly string[];
}

export interface AgentChatsRepository {
  /** The stored chats, most recently updated first (at most `MAX_STORED_CHATS`); a malformed row is skipped. */
  chats(): Promise<StoredAgentChat[]>;
  /**
   * Stores `chat` in place of any stored one with its id (which keeps its `createdAt`), then keeps
   * only the `MAX_STORED_CHATS` most recent. `false` (nothing written) for a chat out of bounds.
   */
  saveChat(chat: StoredAgentChat): Promise<boolean>;
  deleteChat(id: string): Promise<void>;
  deleteAllChats(): Promise<void>;
  /** Deletes every chat last updated before `cutoff` (`Infinity`: all of them). */
  deleteChatsUpdatedBefore(cutoff: number): Promise<void>;
  /** The retention setting (`DEFAULT_CHAT_RETENTION` when unset or tampered). */
  chatRetention(): Promise<ChatRetention>;
  /** Stores the retention setting; `false` (nothing written) for an unknown value or an invalid time. */
  setChatRetention(retention: ChatRetention, at: number): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCount = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= STORED_CHAT_ID_MAX_CHARS && /^[\x21-\x7e]+$/.test(value);
const isRows = (rows: unknown): rows is readonly string[] =>
  Array.isArray(rows) && rows.length <= MAX_STORED_ROWS_PER_CHAT && rows.every((row) => typeof row === 'string' && row.length >= 1 && row.length <= STORED_CHAT_ROW_MAX_CHARS);

function isStorable(chat: StoredAgentChat): boolean {
  return (
    typeof chat === 'object' &&
    chat !== null &&
    isId(chat.id) &&
    typeof chat.title === 'string' &&
    chat.title.length <= STORED_CHAT_TITLE_MAX_CHARS &&
    isTime(chat.createdAt) &&
    isTime(chat.updatedAt) &&
    (chat.modelId === null || (typeof chat.modelId === 'string' && chat.modelId.length <= 128)) &&
    isCount(chat.inputTokens) &&
    isCount(chat.outputTokens) &&
    isCount(chat.contextTokens) &&
    typeof chat.truncated === 'boolean' &&
    isRows(chat.messages) &&
    isRows(chat.entries)
  );
}

export function createAgentChatsRepository(db: SessionDatabase): AgentChatsRepository {
  /** Deletes message and entry rows whose chat is gone. */
  const orphans = () => [
    db.delete(agentChatMessages).where(notInArray(agentChatMessages.chatId, db.select({ id: agentChats.id }).from(agentChats))),
    db.delete(agentChatEntries).where(notInArray(agentChatEntries.chatId, db.select({ id: agentChats.id }).from(agentChats))),
  ] as const;

  return {
    async chats() {
      // A tampered file may hold values of any size: read no more of each than can be stored (one over).
      const rows = await db
        .select({
          id: sql<unknown>`substr(${agentChats.id}, 1, ${STORED_CHAT_ID_MAX_CHARS + 1})`,
          title: sql<unknown>`substr(${agentChats.title}, 1, ${STORED_CHAT_TITLE_MAX_CHARS + 1})`,
          createdAt: agentChats.createdAt,
          updatedAt: agentChats.updatedAt,
          modelId: sql<unknown>`substr(${agentChats.modelId}, 1, 129)`,
          inputTokens: agentChats.inputTokens,
          outputTokens: agentChats.outputTokens,
          contextTokens: agentChats.contextTokens,
          truncated: sql<unknown>`${agentChats.truncated}`,
        })
        .from(agentChats)
        .orderBy(desc(agentChats.updatedAt), desc(agentChats.id))
        .limit(MAX_STORED_CHATS);
      const valid = rows.filter(
        (row) =>
          isId(row.id) &&
          typeof row.title === 'string' &&
          row.title.length <= STORED_CHAT_TITLE_MAX_CHARS &&
          isTime(row.createdAt) &&
          isTime(row.updatedAt) &&
          (row.modelId === null || typeof row.modelId === 'string') &&
          isCount(row.inputTokens) &&
          isCount(row.outputTokens) &&
          isCount(row.contextTokens),
      );
      if (valid.length === 0) return [];
      const ids = valid.map((row) => row.id as string);
      const fits = (column: typeof agentChatMessages.message | typeof agentChatEntries.entry) => sql`length(${column}) <= ${STORED_CHAT_ROW_MAX_CHARS}`;
      const [messages, entries] = await Promise.all([
        db
          .select({ chatId: agentChatMessages.chatId, body: sql<unknown>`CASE WHEN ${fits(agentChatMessages.message)} THEN ${agentChatMessages.message} ELSE NULL END` })
          .from(agentChatMessages)
          .where(inArray(agentChatMessages.chatId, ids))
          .orderBy(asc(agentChatMessages.chatId), asc(agentChatMessages.seq)),
        db
          .select({ chatId: agentChatEntries.chatId, body: sql<unknown>`CASE WHEN ${fits(agentChatEntries.entry)} THEN ${agentChatEntries.entry} ELSE NULL END` })
          .from(agentChatEntries)
          .where(inArray(agentChatEntries.chatId, ids))
          .orderBy(asc(agentChatEntries.chatId), asc(agentChatEntries.seq)),
      ]);
      const group = (list: readonly { chatId: string; body: unknown }[]) => {
        const out = new Map<string, string[]>();
        for (const row of list) {
          if (typeof row.body !== 'string') continue;
          const bucket = out.get(row.chatId) ?? [];
          if (bucket.length < MAX_STORED_ROWS_PER_CHAT) bucket.push(row.body);
          out.set(row.chatId, bucket);
        }
        return out;
      };
      const messagesBy = group(messages);
      const entriesBy = group(entries);
      return valid.map((row) => ({
        id: row.id as string,
        title: row.title as string,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        modelId: (row.modelId as string | null) ?? null,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        contextTokens: row.contextTokens,
        truncated: row.truncated === 1 || row.truncated === true,
        messages: messagesBy.get(row.id as string) ?? [],
        entries: entriesBy.get(row.id as string) ?? [],
      }));
    },

    async saveChat(chat) {
      if (!isStorable(chat)) return false;
      const values = {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        modelId: chat.modelId,
        inputTokens: chat.inputTokens,
        outputTokens: chat.outputTokens,
        contextTokens: chat.contextTokens,
        truncated: chat.truncated,
      };
      const { id: _id, createdAt: _createdAt, ...changes } = values;
      const kept = db.select({ id: agentChats.id }).from(agentChats).orderBy(desc(agentChats.updatedAt), desc(agentChats.id)).limit(MAX_STORED_CHATS);
      // One transaction: the chat is never stored half written.
      await db.batch([
        db.insert(agentChats).values(values).onConflictDoUpdate({ target: agentChats.id, set: changes }),
        db.delete(agentChatMessages).where(eq(agentChatMessages.chatId, chat.id)),
        db.delete(agentChatEntries).where(eq(agentChatEntries.chatId, chat.id)),
        ...(chat.messages.length > 0 ? [db.insert(agentChatMessages).values(chat.messages.map((message, seq) => ({ chatId: chat.id, seq, message })))] : []),
        ...(chat.entries.length > 0 ? [db.insert(agentChatEntries).values(chat.entries.map((entry, seq) => ({ chatId: chat.id, seq, entry })))] : []),
        db.delete(agentChats).where(notInArray(agentChats.id, kept)),
        ...orphans(),
      ]);
      return true;
    },

    async deleteChat(id) {
      if (typeof id !== 'string') return;
      await db.batch([db.delete(agentChats).where(eq(agentChats.id, id)), db.delete(agentChatMessages).where(eq(agentChatMessages.chatId, id)), db.delete(agentChatEntries).where(eq(agentChatEntries.chatId, id))]);
    },

    async deleteAllChats() {
      await db.batch([db.delete(agentChats), db.delete(agentChatMessages), db.delete(agentChatEntries)]);
    },

    async deleteChatsUpdatedBefore(cutoff) {
      if (typeof cutoff !== 'number' || Number.isNaN(cutoff)) return;
      if (cutoff === Number.POSITIVE_INFINITY) {
        await db.batch([db.delete(agentChats), db.delete(agentChatMessages), db.delete(agentChatEntries)]);
        return;
      }
      // A row whose time isn't a number (tampered) is deleted too.
      await db.batch([db.delete(agentChats).where(sql`${lt(agentChats.updatedAt, cutoff)} OR typeof(${agentChats.updatedAt}) <> 'integer'`), ...orphans()]);
    },

    async chatRetention() {
      const [row] = await db
        .select({ value: sql<unknown>`substr(${agentPreferences.value}, 1, 16)` })
        .from(agentPreferences)
        .where(eq(agentPreferences.key, CHAT_RETENTION_PREFERENCE_KEY))
        .limit(1);
      return isChatRetention(row?.value) ? row.value : DEFAULT_CHAT_RETENTION;
    },

    async setChatRetention(retention, at) {
      if (!isChatRetention(retention) || !isTime(at)) return false;
      await db
        .insert(agentPreferences)
        .values({ key: CHAT_RETENTION_PREFERENCE_KEY, value: retention, updatedAt: at })
        .onConflictDoUpdate({ target: agentPreferences.key, set: { value: retention, updatedAt: at } });
      return true;
    },
  };
}
