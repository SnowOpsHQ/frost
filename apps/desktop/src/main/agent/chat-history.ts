import {
  CHAT_SEARCH_SCAN_MAX_CHARS,
  chatTitleFromUser,
  DEFAULT_CHAT_RETENTION,
  isChatRetention,
  MAX_STORED_CHATS,
  MAX_STORED_ROWS_PER_CHAT,
  retentionCutoff,
  type ChatRetention,
} from '@app/specs/agent-data.spec';
import type { ChatMessage } from '@app/specs/agent-protocol.schema';
import { decodeHead, decodeRows, encodeEntries, encodeHead, encodeMessages, type ChatHead, type ChatHeadRow, type ChatRowsRow, type ChatRowsUpdate, type EntrySnapshot } from './chat-record';

// The agent's stored chats and their retention (Phase 5 Task 9; spec `specs/agent-data.spec.ts`;
// acceptance `specs/agent-data.feature.md`, Stored chats and Retention). The session saves a chat
// when one of its turns ends (only the rows after the ones already stored, unless the chat was
// trimmed) and removes it when the user deletes it; this module writes to the database (`@app/db`'s
// `agentChats`) unless the retention is `off`, and deletes what the retention no longer keeps: at
// startup, daily, and at once when the setting changes (`off` deletes every stored chat). At startup
// only the chats' own rows are read; a chat's messages are read when it is opened (`loadChat`).
// Writes run one after another, after the setting has been read, so a chat ended before the setting
// loaded is never stored against an `off` the user chose.
// Phase 11 Task 8 (Decision 10): a stored chat is renamed or archived on its own row (its rows are
// not read), and search reads a stored chat's display text only (`texts`); under `off` nothing is
// written or read.

/** The database side (`SessionStore.agentChats` from `@app/db`, or `createMemoryChatsStore`). */
export interface AgentChatsStore {
  chatHeads(): Promise<readonly ChatHeadRow[]>;
  chatRows(id: string): Promise<ChatRowsRow | null>;
  saveChat(head: ChatHeadRow, rows: ChatRowsUpdate): Promise<boolean>;
  deleteChat(id: string): Promise<void>;
  /** Phase 11 Task 8: the user's title, an archive time (`null`: unarchived), and a chat's display text for search. */
  renameChat(id: string, title: string): Promise<boolean>;
  setChatArchived(id: string, archivedAt: number | null): Promise<boolean>;
  chatTexts(id: string): Promise<readonly string[] | null>;
  deleteAllChats(): Promise<void>;
  deleteChatsUpdatedBefore(cutoff: number): Promise<void>;
  countChatsUpdatedBefore(cutoff: number): Promise<number>;
  chatRetention(): Promise<ChatRetention>;
  setChatRetention(retention: ChatRetention, at: number): Promise<boolean>;
}

export interface ChatHistoryDeps {
  readonly store: AgentChatsStore;
  readonly now?: () => number;
  /** One line per failure; never a chat's content. */
  readonly log?: (line: string) => void;
}

/** What a save writes: the chat's own row, and its rows from the given positions on. */
export interface ChatSave {
  readonly head: ChatHead;
  readonly messagesFrom: number;
  readonly messages: readonly ChatMessage[];
  readonly entriesFrom: number;
  readonly entries: readonly EntrySnapshot[];
}

/** A chat's rows as read back: validated, and how many rows are stored (where the next save appends). */
export interface LoadedChatRows {
  readonly history: readonly ChatMessage[];
  readonly entries: readonly EntrySnapshot[];
  /** Whether every stored row read back valid (else the next save rewrites the chat). */
  readonly exact: boolean;
  readonly storedMessages: number;
  readonly storedEntries: number;
}

export interface ChatHistory {
  /** Reads the retention, prunes, and answers the stored chats' own rows (most recent first). Once; later calls share it. Never rejects. */
  load(): Promise<readonly ChatHead[]>;
  /** One stored chat's messages and entries, or `null` (not stored, or unreadable). Never rejects. */
  loadChat(id: string): Promise<LoadedChatRows | null>;
  /** The retention in effect (`DEFAULT_CHAT_RETENTION` until loaded). */
  retention(): ChatRetention;
  /** How many stored chats `retention` would delete now. */
  wouldDelete(retention: ChatRetention): Promise<number>;
  /** Stores the retention, then prunes under it at once; `false` if it couldn't be stored. */
  setRetention(retention: ChatRetention): Promise<boolean>;
  /**
   * Stores a chat's row and its rows from the given positions on (nothing under `off`, answered
   * `true`). `false` if it couldn't be written, or the positions are past what is stored (the
   * session then saves the whole chat).
   */
  save(chat: ChatSave): Promise<boolean>;
  /** Deletes a stored chat. */
  remove(id: string): Promise<void>;
  /** Gives a stored chat the user's title (nothing under `off`); `false` if it couldn't be written. */
  rename(id: string, title: string): Promise<boolean>;
  /** Archives a stored chat at `archivedAt` (`null`: unarchives it; nothing under `off`); `false` if it couldn't be written. */
  setArchived(id: string, archivedAt: number | null): Promise<boolean>;
  /** A stored chat's display text for search (the user's and the assistant's, never tool output), or `null`. Never rejects. */
  texts(id: string): Promise<readonly string[] | null>;
  /** Deletes every stored chat; `false` if that failed. */
  removeAll(): Promise<boolean>;
  /** Deletes what the retention no longer keeps; answers the cutoff applied (`null`: none). */
  prune(): Promise<number | null>;
}

export function createChatHistory(deps: ChatHistoryDeps): ChatHistory {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  let retention: ChatRetention = DEFAULT_CHAT_RETENTION;
  let queue: Promise<unknown> = Promise.resolve();
  let loading: Promise<readonly ChatHead[]> | null = null;
  let ready: Promise<void> | null = null;

  const readSetting = () => {
    ready ??= (async () => {
      try {
        const stored = await deps.store.chatRetention();
        if (isChatRetention(stored)) retention = stored;
      } catch {
        log('agent chats: the retention setting could not be read');
      }
    })();
    return ready;
  };

  /** Runs writes one after another, each after the setting was read. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => readSetting()).then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const pruneNow = async (): Promise<number | null> => {
    const cutoff = retentionCutoff(retention, now());
    if (cutoff === null) return null;
    try {
      await deps.store.deleteChatsUpdatedBefore(cutoff);
    } catch {
      log('agent chats: old chats could not be deleted');
    }
    return cutoff;
  };

  return {
    load() {
      loading ??= serial(async () => {
        await pruneNow();
        if (retention === 'off') return [];
        let rows: readonly ChatHeadRow[] = [];
        try {
          rows = await deps.store.chatHeads();
        } catch {
          log('agent chats: the stored chats could not be read');
          return [];
        }
        const at = now();
        const out: ChatHead[] = [];
        for (const row of rows.slice(0, MAX_STORED_CHATS)) {
          const chat = decodeHead(row, at);
          if (chat !== null) out.push(chat);
        }
        return out;
      }).catch(() => []);
      return loading;
    },
    loadChat(id) {
      return serial(async () => {
        const rows = await deps.store.chatRows(id);
        if (rows === null) return null;
        const decoded = decodeRows(rows);
        return { ...decoded, storedMessages: Math.min(rows.messages.length, MAX_STORED_ROWS_PER_CHAT), storedEntries: Math.min(rows.entries.length, MAX_STORED_ROWS_PER_CHAT) };
      }).catch(() => {
        log('agent chats: a stored chat could not be read');
        return null;
      });
    },
    retention: () => retention,
    wouldDelete(next) {
      return serial(async () => {
        const cutoff = isChatRetention(next) ? retentionCutoff(next, now()) : null;
        if (cutoff === null) return 0;
        const n = await deps.store.countChatsUpdatedBefore(cutoff);
        return Number.isSafeInteger(n) && n > 0 ? n : 0;
      }).catch(() => 0);
    },
    setRetention(next) {
      if (!isChatRetention(next)) return Promise.resolve(false);
      return serial(async () => {
        let ok = false;
        try {
          ok = (await deps.store.setChatRetention(next, now())) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          log('agent chats: the retention setting could not be written');
          return false;
        }
        retention = next;
        await pruneNow();
        return true;
      });
    },
    save(chat) {
      return serial(async () => {
        if (retention === 'off') return true;
        const cutoff = retentionCutoff(retention, now());
        if (cutoff !== null && chat.head.updatedAt < cutoff) return true;
        try {
          const ok = await deps.store.saveChat(encodeHead(chat.head), {
            messagesFrom: chat.messagesFrom,
            messages: encodeMessages(chat.messages),
            entriesFrom: chat.entriesFrom,
            entries: encodeEntries(chat.entries),
          });
          if (!ok && chat.messagesFrom === 0 && chat.entriesFrom === 0) log('agent chats: a chat was out of bounds and not stored');
          return ok === true;
        } catch {
          log('agent chats: a chat could not be stored');
          return false;
        }
      });
    },
    remove(id) {
      return serial(async () => {
        try {
          await deps.store.deleteChat(id);
        } catch {
          log('agent chats: a chat could not be deleted');
        }
      });
    },
    rename(id, title) {
      return serial(async () => {
        if (retention === 'off') return true;
        try {
          return (await deps.store.renameChat(id, title)) === true;
        } catch {
          log('agent chats: a chat could not be renamed');
          return false;
        }
      });
    },
    setArchived(id, archivedAt) {
      return serial(async () => {
        if (retention === 'off') return true;
        try {
          return (await deps.store.setChatArchived(id, archivedAt)) === true;
        } catch {
          log('agent chats: a chat could not be archived');
          return false;
        }
      });
    },
    texts(id) {
      return serial(async () => {
        if (retention === 'off') return null;
        const texts = await deps.store.chatTexts(id);
        if (!Array.isArray(texts)) return null;
        // The store's bound, applied again: only strings, within the scan's bound in all.
        const out: string[] = [];
        let left = CHAT_SEARCH_SCAN_MAX_CHARS;
        for (const text of texts.slice(0, MAX_STORED_ROWS_PER_CHAT)) {
          if (left <= 0) break;
          if (typeof text !== 'string') continue;
          out.push(text.slice(0, left));
          left -= text.length;
        }
        return out;
      }).catch(() => {
        log('agent chats: a stored chat could not be searched');
        return null;
      });
    },
    removeAll() {
      return serial(async () => {
        try {
          await deps.store.deleteAllChats();
          return true;
        } catch {
          log('agent chats: the stored chats could not be deleted');
          return false;
        }
      });
    },
    prune: () => serial(pruneNow),
  };
}

/** A store kept in memory (nothing persists): tests, and an agent built without the database. It applies the database's rules for rows. */
export function createMemoryChatsStore(
  initial: { chats?: readonly { readonly head: ChatHeadRow; readonly rows: ChatRowsRow }[]; retention?: ChatRetention } = {},
): AgentChatsStore & { heads: Map<string, ChatHeadRow>; rows: Map<string, { messages: string[]; entries: string[] }>; retentionValue(): ChatRetention; writes: ChatRowsUpdate[] } {
  const heads = new Map<string, ChatHeadRow>((initial.chats ?? []).map((chat) => [chat.head.id, chat.head]));
  const rows = new Map<string, { messages: string[]; entries: string[] }>((initial.chats ?? []).map((chat) => [chat.head.id, { messages: [...chat.rows.messages], entries: [...chat.rows.entries] }]));
  const writes: ChatRowsUpdate[] = [];
  let stored: ChatRetention = initial.retention ?? DEFAULT_CHAT_RETENTION;
  const sorted = () => [...heads.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  const drop = (id: string) => {
    heads.delete(id);
    rows.delete(id);
  };
  return {
    heads,
    rows,
    writes,
    retentionValue: () => stored,
    chatHeads: async () => sorted().slice(0, MAX_STORED_CHATS),
    chatRows: async (id) => (heads.has(id) ? { messages: [...(rows.get(id)?.messages ?? [])], entries: [...(rows.get(id)?.entries ?? [])] } : null),
    async saveChat(head, update) {
      const current = rows.get(head.id) ?? { messages: [], entries: [] };
      if (update.messagesFrom > current.messages.length || update.entriesFrom > current.entries.length) return false;
      if (update.messagesFrom + update.messages.length > MAX_STORED_ROWS_PER_CHAT || update.entriesFrom + update.entries.length > MAX_STORED_ROWS_PER_CHAT) return false;
      writes.push(update);
      const before = heads.get(head.id);
      // As the database: a stored user title stays unless the save carries one too.
      const keepTitle = before?.titleByUser === true && !head.titleByUser;
      heads.set(head.id, { ...head, createdAt: before?.createdAt ?? head.createdAt, ...(keepTitle ? { title: before.title, titleByUser: true } : {}) });
      rows.set(head.id, { messages: [...current.messages.slice(0, update.messagesFrom), ...update.messages], entries: [...current.entries.slice(0, update.entriesFrom), ...update.entries] });
      for (const extra of sorted().slice(MAX_STORED_CHATS)) drop(extra.id);
      return true;
    },
    async deleteChat(id) {
      drop(id);
    },
    async renameChat(id, title) {
      const clean = chatTitleFromUser(title);
      if (clean === null) return false;
      const head = heads.get(id);
      if (head !== undefined) heads.set(id, { ...head, title: clean, titleByUser: true });
      return true;
    },
    async setChatArchived(id, archivedAt) {
      const head = heads.get(id);
      if (head !== undefined) heads.set(id, { ...head, archivedAt });
      return true;
    },
    async chatTexts(id) {
      if (!heads.has(id)) return null;
      return (rows.get(id)?.entries ?? []).flatMap((entry) => {
        try {
          const parsed = JSON.parse(entry) as { kind?: unknown; text?: unknown };
          return (parsed.kind === 'user' || parsed.kind === 'assistant') && typeof parsed.text === 'string' ? [parsed.text] : [];
        } catch {
          return [];
        }
      });
    },
    async deleteAllChats() {
      heads.clear();
      rows.clear();
    },
    async deleteChatsUpdatedBefore(cutoff) {
      for (const [id, chat] of heads) if (chat.updatedAt < cutoff) drop(id);
    },
    countChatsUpdatedBefore: async (cutoff) => [...heads.values()].filter((chat) => chat.updatedAt < cutoff).length,
    chatRetention: async () => stored,
    async setChatRetention(retention) {
      if (!isChatRetention(retention)) return false;
      stored = retention;
      return true;
    },
  };
}
