import { DEFAULT_CHAT_RETENTION, isChatRetention, MAX_STORED_CHATS, retentionCutoff, type ChatRetention } from '@app/specs/agent-data.spec';
import { decodeChat, encodeChat, type ChatRow, type ChatSnapshot } from './chat-record';

// The agent's stored chats and their retention (Phase 5 Task 9; spec `specs/agent-data.spec.ts`;
// acceptance `specs/agent-data.feature.md`, Stored chats and Retention). The session saves a chat
// when one of its turns ends and removes it when the user deletes it; this module writes it to the
// database (`@app/db`'s `agentChats`) unless the retention is `off`, and deletes what the retention
// no longer keeps: at startup, daily, and at once when the setting changes (`off` deletes every
// stored chat). Writes run one after another, after the setting has been read, so a chat ended
// before the setting loaded is never stored against an `off` the user chose.

/** The database side (`SessionStore.agentChats` from `@app/db`, or `createMemoryChatsStore`). */
export interface AgentChatsStore {
  chats(): Promise<readonly ChatRow[]>;
  saveChat(chat: ChatRow): Promise<boolean>;
  deleteChat(id: string): Promise<void>;
  deleteAllChats(): Promise<void>;
  deleteChatsUpdatedBefore(cutoff: number): Promise<void>;
  chatRetention(): Promise<ChatRetention>;
  setChatRetention(retention: ChatRetention, at: number): Promise<boolean>;
}

export interface ChatHistoryDeps {
  readonly store: AgentChatsStore;
  readonly now?: () => number;
  /** One line per failure; never a chat's content. */
  readonly log?: (line: string) => void;
}

export interface ChatHistory {
  /** Reads the retention, prunes, and answers the stored chats (most recent first). Once; later calls share it. Never rejects. */
  load(): Promise<readonly ChatSnapshot[]>;
  /** The retention in effect (`DEFAULT_CHAT_RETENTION` until loaded). */
  retention(): ChatRetention;
  /** Stores the retention, then prunes under it at once; `false` if it couldn't be stored. */
  setRetention(retention: ChatRetention): Promise<boolean>;
  /** Stores a chat (nothing under `off`). */
  save(chat: ChatSnapshot): Promise<void>;
  /** Deletes a stored chat. */
  remove(id: string): Promise<void>;
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
  let loading: Promise<readonly ChatSnapshot[]> | null = null;
  let ready: Promise<void> | null = null;

  /** Runs writes one after another, each after the setting was read. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => readSetting()).then(task);
    queue = run.catch(() => undefined);
    return run;
  };

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
        let rows: readonly ChatRow[] = [];
        try {
          rows = await deps.store.chats();
        } catch {
          log('agent chats: the stored chats could not be read');
          return [];
        }
        const out: ChatSnapshot[] = [];
        for (const row of rows.slice(0, MAX_STORED_CHATS)) {
          const chat = decodeChat(row);
          if (chat !== null) out.push(chat);
        }
        return out;
      }).catch(() => []);
      return loading;
    },
    retention: () => retention,
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
        if (retention === 'off') return;
        const cutoff = retentionCutoff(retention, now());
        if (cutoff !== null && chat.updatedAt < cutoff) return;
        try {
          if (!(await deps.store.saveChat(encodeChat(chat)))) log('agent chats: a chat was out of bounds and not stored');
        } catch {
          log('agent chats: a chat could not be stored');
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

/** A store kept in memory (nothing persists): tests, and an agent built without the database. */
export function createMemoryChatsStore(initial: { chats?: readonly ChatRow[]; retention?: ChatRetention } = {}): AgentChatsStore & { rows: Map<string, ChatRow>; retentionValue(): ChatRetention } {
  const rows = new Map<string, ChatRow>((initial.chats ?? []).map((chat) => [chat.id, chat]));
  let stored: ChatRetention = initial.retention ?? DEFAULT_CHAT_RETENTION;
  const sorted = () => [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  return {
    rows,
    retentionValue: () => stored,
    chats: async () => sorted().slice(0, MAX_STORED_CHATS),
    async saveChat(chat) {
      const existing = rows.get(chat.id);
      rows.set(chat.id, { ...chat, createdAt: existing?.createdAt ?? chat.createdAt });
      for (const extra of sorted().slice(MAX_STORED_CHATS)) rows.delete(extra.id);
      return true;
    },
    async deleteChat(id) {
      rows.delete(id);
    },
    async deleteAllChats() {
      rows.clear();
    },
    async deleteChatsUpdatedBefore(cutoff) {
      for (const [id, chat] of rows) if (chat.updatedAt < cutoff) rows.delete(id);
    },
    chatRetention: async () => stored,
    async setChatRetention(retention) {
      if (!isChatRetention(retention)) return false;
      stored = retention;
      return true;
    },
  };
}
