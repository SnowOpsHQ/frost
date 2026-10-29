import { and, asc, count, desc, eq, gte, lt, notInArray, sql } from 'drizzle-orm';
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

/** A stored chat's own row (what the chat list needs at startup). */
export interface StoredAgentChatHead {
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

/** A stored chat's rows, read when the chat is opened. */
export interface StoredAgentChatRows {
  /** Protocol `ChatMessage`s, one JSON text each, in order. */
  readonly messages: readonly string[];
  /** Display entries, one JSON text each, in order. */
  readonly entries: readonly string[];
}

/**
 * The rows a save writes: every stored row at or after `messagesFrom` (`entriesFrom`) is replaced by
 * `messages` (`entries`). Appending a turn passes the stored counts; a full rewrite passes `0`.
 */
export interface AgentChatRowsUpdate {
  readonly messagesFrom: number;
  readonly messages: readonly string[];
  readonly entriesFrom: number;
  readonly entries: readonly string[];
}

export interface AgentChatsRepository {
  /** The stored chats' rows, most recently updated first (at most `MAX_STORED_CHATS`); a malformed row is skipped. */
  chatHeads(): Promise<StoredAgentChatHead[]>;
  /** One chat's messages and entries in order (a row over `STORED_CHAT_ROW_MAX_CHARS` skipped), or `null` if it isn't stored. */
  chatRows(id: string): Promise<StoredAgentChatRows | null>;
  /**
   * Stores `head` in place of any stored row with its id (which keeps its `createdAt`) and replaces
   * its rows from the given positions on, then keeps only the `MAX_STORED_CHATS` most recent. `false`
   * (nothing written) for a chat out of bounds, or rows that would leave a gap (a `from` past what is
   * stored: the caller then rewrites from `0`).
   */
  saveChat(head: StoredAgentChatHead, rows: AgentChatRowsUpdate): Promise<boolean>;
  deleteChat(id: string): Promise<void>;
  deleteAllChats(): Promise<void>;
  /** Deletes every chat last updated before `cutoff` (`Infinity`: all of them). */
  deleteChatsUpdatedBefore(cutoff: number): Promise<void>;
  /** How many stored chats `deleteChatsUpdatedBefore(cutoff)` would delete. */
  countChatsUpdatedBefore(cutoff: number): Promise<number>;
  /** The retention setting (`DEFAULT_CHAT_RETENTION` when unset or tampered). */
  chatRetention(): Promise<ChatRetention>;
  /** Stores the retention setting; `false` (nothing written) for an unknown value or an invalid time. */
  setChatRetention(retention: ChatRetention, at: number): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCount = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= STORED_CHAT_ID_MAX_CHARS && /^[\x21-\x7e]+$/.test(value);
const isRows = (rows: unknown, from: unknown): rows is readonly string[] =>
  Number.isSafeInteger(from) &&
  (from as number) >= 0 &&
  Array.isArray(rows) &&
  (from as number) + rows.length <= MAX_STORED_ROWS_PER_CHAT &&
  rows.every((row) => typeof row === 'string' && row.length >= 1 && row.length <= STORED_CHAT_ROW_MAX_CHARS);

function isStorableHead(chat: StoredAgentChatHead): boolean {
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
    typeof chat.truncated === 'boolean'
  );
}

export function createAgentChatsRepository(db: SessionDatabase): AgentChatsRepository {
  /** Deletes message and entry rows whose chat is gone. */
  const orphans = () => [
    db.delete(agentChatMessages).where(notInArray(agentChatMessages.chatId, db.select({ id: agentChats.id }).from(agentChats))),
    db.delete(agentChatEntries).where(notInArray(agentChatEntries.chatId, db.select({ id: agentChats.id }).from(agentChats))),
  ];

  /**
   * Runs `queries` in one transaction with SQLite's `secure_delete` on, so what they delete or
   * overwrite is zeroed in the file, not left in free pages; the connection's own setting is put
   * back in the same transaction (nothing else runs on the connection meanwhile: the batch is one
   * synchronous callback), so no other table's deletes change.
   */
  const secureBatch = async (queries: readonly Parameters<typeof db.batch>[0][number][]) => {
    const [row] = (await db.all<{ secure_delete?: unknown }>(sql`PRAGMA secure_delete`)) as unknown[];
    const value = Array.isArray(row) ? row[0] : (row as { secure_delete?: unknown } | undefined)?.secure_delete;
    const previous = value === 1 || value === 2 ? value : 0;
    await db.batch([db.run(sql`PRAGMA secure_delete = 1`), ...queries, db.run(sql.raw(`PRAGMA secure_delete = ${previous}`))] as unknown as Parameters<typeof db.batch>[0]);
  };

  const deleteAll = () => secureBatch([db.delete(agentChats), db.delete(agentChatMessages), db.delete(agentChatEntries)]);

  const readRows = async (column: 'message' | 'entry', id: string): Promise<string[]> => {
    const table = column === 'message' ? agentChatMessages : agentChatEntries;
    const body = column === 'message' ? agentChatMessages.message : agentChatEntries.entry;
    const rows = await db
      .select({ body: sql<unknown>`CASE WHEN length(${body}) <= ${STORED_CHAT_ROW_MAX_CHARS} THEN ${body} ELSE NULL END` })
      .from(table)
      .where(eq(table.chatId, id))
      .orderBy(asc(table.seq))
      .limit(MAX_STORED_ROWS_PER_CHAT);
    return rows.flatMap((row) => (typeof row.body === 'string' ? [row.body] : []));
  };

  const countRows = async (table: typeof agentChatMessages | typeof agentChatEntries, id: string, before: number) => {
    const [row] = await db
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.chatId, id), lt(table.seq, before)));
    return row?.n ?? 0;
  };

  return {
    async chatHeads() {
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
      const out: StoredAgentChatHead[] = [];
      for (const row of rows) {
        if (!isId(row.id) || typeof row.title !== 'string' || row.title.length > STORED_CHAT_TITLE_MAX_CHARS || !isTime(row.createdAt) || !isTime(row.updatedAt)) continue;
        if ((row.modelId !== null && typeof row.modelId !== 'string') || !isCount(row.inputTokens) || !isCount(row.outputTokens) || !isCount(row.contextTokens)) continue;
        out.push({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          modelId: (row.modelId as string | null) ?? null,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          contextTokens: row.contextTokens,
          truncated: row.truncated === 1 || row.truncated === true,
        });
      }
      return out;
    },

    async chatRows(id) {
      if (!isId(id)) return null;
      const [head] = await db.select({ id: agentChats.id }).from(agentChats).where(eq(agentChats.id, id)).limit(1);
      if (!head) return null;
      const [messages, entries] = await Promise.all([readRows('message', id), readRows('entry', id)]);
      return { messages, entries };
    },

    async saveChat(head, rows) {
      if (!isStorableHead(head) || typeof rows !== 'object' || rows === null || !isRows(rows.messages, rows.messagesFrom) || !isRows(rows.entries, rows.entriesFrom)) return false;
      // Appending past what is stored would leave a gap: the caller rewrites from the start instead.
      if (rows.messagesFrom > 0 && (await countRows(agentChatMessages, head.id, rows.messagesFrom)) !== rows.messagesFrom) return false;
      if (rows.entriesFrom > 0 && (await countRows(agentChatEntries, head.id, rows.entriesFrom)) !== rows.entriesFrom) return false;
      const values = {
        id: head.id,
        title: head.title,
        createdAt: head.createdAt,
        updatedAt: head.updatedAt,
        modelId: head.modelId,
        inputTokens: head.inputTokens,
        outputTokens: head.outputTokens,
        contextTokens: head.contextTokens,
        truncated: head.truncated,
      };
      const { id: _id, createdAt: _createdAt, ...changes } = values;
      const kept = db.select({ id: agentChats.id }).from(agentChats).orderBy(desc(agentChats.updatedAt), desc(agentChats.id)).limit(MAX_STORED_CHATS);
      // One transaction: the chat is never stored half written. Only rows from the given positions
      // on are touched, so a turn's save writes that turn's rows, not the whole chat.
      await secureBatch([
        db.insert(agentChats).values(values).onConflictDoUpdate({ target: agentChats.id, set: changes }),
        db.delete(agentChatMessages).where(and(eq(agentChatMessages.chatId, head.id), gte(agentChatMessages.seq, rows.messagesFrom))),
        db.delete(agentChatEntries).where(and(eq(agentChatEntries.chatId, head.id), gte(agentChatEntries.seq, rows.entriesFrom))),
        ...(rows.messages.length > 0 ? [db.insert(agentChatMessages).values(rows.messages.map((message, i) => ({ chatId: head.id, seq: rows.messagesFrom + i, message })))] : []),
        ...(rows.entries.length > 0 ? [db.insert(agentChatEntries).values(rows.entries.map((entry, i) => ({ chatId: head.id, seq: rows.entriesFrom + i, entry })))] : []),
        db.delete(agentChats).where(notInArray(agentChats.id, kept)),
        ...orphans(),
      ]);
      return true;
    },

    async deleteChat(id) {
      if (typeof id !== 'string') return;
      await secureBatch([db.delete(agentChats).where(eq(agentChats.id, id)), db.delete(agentChatMessages).where(eq(agentChatMessages.chatId, id)), db.delete(agentChatEntries).where(eq(agentChatEntries.chatId, id))]);
    },

    deleteAllChats: deleteAll,

    async deleteChatsUpdatedBefore(cutoff) {
      if (typeof cutoff !== 'number' || Number.isNaN(cutoff)) return;
      if (cutoff === Number.POSITIVE_INFINITY) {
        await deleteAll();
        return;
      }
      // A row whose time isn't a number (tampered) is deleted too.
      await secureBatch([db.delete(agentChats).where(sql`${lt(agentChats.updatedAt, cutoff)} OR typeof(${agentChats.updatedAt}) <> 'integer'`), ...orphans()]);
    },

    async countChatsUpdatedBefore(cutoff) {
      if (typeof cutoff !== 'number' || Number.isNaN(cutoff)) return 0;
      const [row] =
        cutoff === Number.POSITIVE_INFINITY
          ? await db.select({ n: count() }).from(agentChats)
          : await db
              .select({ n: count() })
              .from(agentChats)
              .where(sql`${lt(agentChats.updatedAt, cutoff)} OR typeof(${agentChats.updatedAt}) <> 'integer'`);
      return row?.n ?? 0;
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
