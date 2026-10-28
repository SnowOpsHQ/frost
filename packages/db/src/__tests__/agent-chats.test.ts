// Spec: specs/agent-data.spec.ts (AGENT_CHAT_TABLES, MAX_STORED_CHATS, MAX_STORED_ROWS_PER_CHAT,
// STORED_CHAT_ROW_MAX_CHARS, CHAT_RETENTION_PREFERENCE_KEY, DEFAULT_CHAT_RETENTION, retentionCutoff)
// Acceptance: specs/agent-data.feature.md (Stored chats)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { CHAT_RETENTION_PREFERENCE_KEY, DEFAULT_CHAT_RETENTION, MAX_STORED_CHATS, MAX_STORED_ROWS_PER_CHAT, retentionCutoff, STORED_CHAT_ROW_MAX_CHARS } from '@app/specs/agent-data.spec';
import { createAgentChatsRepository, type AgentChatsRepository, type StoredAgentChat } from '../agent-chats';
import { agentChatEntries, agentChatMessages, agentChats } from '../agent-chats-schema';
import { createDrizzle } from '../client';
import { MIGRATIONS, runMigrations } from '../migrations';
import { openSessionStore } from '../store';

let raw: DatabaseSync;
let repo: AgentChatsRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAgentChatsRepository(createDrizzle(raw));
});

const count = (table: string) => Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']);

function columns(table: string) {
  return raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0, primaryKey: row['pk'] !== 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function drizzleColumns(table: SQLiteTable) {
  const config = getTableConfig(table);
  const keyColumns = new Set(config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)));
  return config.columns
    .map((column) => ({
      name: column.name,
      type: column.getSQLType().toLowerCase(),
      notNull: column.notNull || column.primary || keyColumns.has(column.name),
      primaryKey: column.primary || keyColumns.has(column.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const chat = (id: string, updatedAt: number, changes: Partial<StoredAgentChat> = {}): StoredAgentChat => ({
  id,
  title: `Chat ${id}`,
  createdAt: updatedAt,
  updatedAt,
  modelId: 'anthropic/claude-sonnet-5-5',
  inputTokens: 10,
  outputTokens: 2,
  contextTokens: 12,
  truncated: false,
  messages: ['{"role":"user","content":"hi"}', '{"role":"assistant","content":"hello","toolCalls":[]}'],
  entries: ['{"kind":"user","text":"hi"}', '{"kind":"assistant","text":"hello","tools":[]}'],
  ...changes,
});

describe('agent chats (db)', () => {
  test('agent-chats-migrate', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0031_agent_chats');
    expect(columns('agent_chats')).toEqual(drizzleColumns(agentChats));
    expect(columns('agent_chat_messages')).toEqual(drizzleColumns(agentChatMessages));
    expect(columns('agent_chat_entries')).toEqual(drizzleColumns(agentChatEntries));
    // Phase 5's block stays contiguous and in order, before any later phase's.
    const ids = MIGRATIONS.map((m) => m.id);
    const phase5 = ids.filter((id) => id >= '0030' && id < '0040');
    expect(phase5).toEqual(['0030_agent_grants', '0031_agent_chats', '0032_agent_skills']);
    expect(ids.indexOf('0031_agent_chats')).toBe(ids.indexOf('0030_agent_grants') + 1);
    expect([...ids].sort()).toEqual(ids);
    // A database with the grants only gains the chat tables and keeps its grants.
    const old = new DatabaseSync(':memory:');
    runMigrations(old, MIGRATIONS.filter((m) => m.id <= '0030_agent_grants'));
    old.prepare("INSERT INTO agent_grants (tool, origin, created_at) VALUES ('navigate', 'https://example.com', 1)").run();
    expect(runMigrations(old)).toEqual(['0031_agent_chats', '0032_agent_skills']);
    expect(old.prepare('SELECT count(*) AS n FROM agent_grants').get()!['n']).toBe(1);
  });

  test('agent-chats-round-trip', async () => {
    expect(await repo.chats()).toEqual([]);
    expect(await repo.saveChat(chat('a', 10))).toBe(true);
    expect(await repo.saveChat(chat('b', 20, { modelId: null, inputTokens: null, outputTokens: null, contextTokens: null, truncated: true, entries: [] }))).toBe(true);
    // Most recently updated first; rows in order.
    expect(await repo.chats()).toEqual([chat('b', 20, { modelId: null, inputTokens: null, outputTokens: null, contextTokens: null, truncated: true, entries: [] }), chat('a', 10)]);
    // Saving again replaces the rows and keeps the creation time.
    expect(await repo.saveChat(chat('a', 30, { createdAt: 99, title: 'Renamed', messages: ['{"role":"user","content":"only"}'] }))).toBe(true);
    const [first] = await repo.chats();
    expect(first).toMatchObject({ id: 'a', title: 'Renamed', createdAt: 10, updatedAt: 30, messages: ['{"role":"user","content":"only"}'] });
    expect(count('agent_chat_messages')).toBe(3);
    await repo.deleteChat('a');
    expect((await repo.chats()).map((c) => c.id)).toEqual(['b']);
    expect(count('agent_chat_messages')).toBe(2);
    await repo.deleteAllChats();
    expect(await repo.chats()).toEqual([]);
    expect(count('agent_chats') + count('agent_chat_messages') + count('agent_chat_entries')).toBe(0);
  });

  test('agent-chats-capped', async () => {
    for (let i = 0; i < MAX_STORED_CHATS + 3; i += 1) expect(await repo.saveChat(chat(`c${i}`, 1000 + i))).toBe(true);
    // Only the most recent are kept, and the older ones' rows go with them.
    const ids = (await repo.chats()).map((c) => c.id);
    expect(ids).toHaveLength(MAX_STORED_CHATS);
    expect(ids).not.toContain('c0');
    expect(ids[0]).toBe(`c${MAX_STORED_CHATS + 2}`);
    expect(count('agent_chats')).toBe(MAX_STORED_CHATS);
    expect(count('agent_chat_messages')).toBe(MAX_STORED_CHATS * 2);
    expect(count('agent_chat_entries')).toBe(MAX_STORED_CHATS * 2);
  });

  test('agent-chats-refuse-out-of-bounds', async () => {
    const refused: Partial<StoredAgentChat>[] = [
      { id: '' },
      { id: 'has space' },
      { id: 'x'.repeat(65) },
      { title: 't'.repeat(201) },
      { updatedAt: Number.NaN },
      { createdAt: -1 },
      { inputTokens: 1.5 },
      { messages: Array.from({ length: MAX_STORED_ROWS_PER_CHAT + 1 }, () => '{}') },
      { entries: [''] },
      { messages: ['x'.repeat(STORED_CHAT_ROW_MAX_CHARS + 1)] },
      { modelId: 'm'.repeat(200) },
    ];
    for (const changes of refused) expect(await repo.saveChat(chat('ok', 1, changes)), JSON.stringify(changes).slice(0, 80)).toBe(false);
    expect(count('agent_chats')).toBe(0);
    // A tampered row is skipped on the way out.
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('bad id', 't', 1, 1)").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('later', 't', 1, 'soon')").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at, input_tokens) VALUES ('neg', 't', 1, 1, -5)").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('fine', 't', 1, 2)").run();
    raw.prepare("INSERT INTO agent_chat_messages (chat_id, seq, message) VALUES ('fine', 0, 'm')").run();
    expect((await repo.chats()).map((c) => [c.id, c.messages])).toEqual([['fine', ['m']]]);
  });

  test('agent-chats-prune-by-retention', async () => {
    const day = 86_400_000;
    const now = 100 * day;
    await repo.saveChat(chat('old', now - 31 * day));
    await repo.saveChat(chat('week', now - 8 * day));
    await repo.saveChat(chat('new', now - day));
    await repo.deleteChatsUpdatedBefore(retentionCutoff('forever', now) ?? Number.NEGATIVE_INFINITY);
    expect((await repo.chats()).map((c) => c.id)).toEqual(['new', 'week', 'old']);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('30d', now)!);
    expect((await repo.chats()).map((c) => c.id)).toEqual(['new', 'week']);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('7d', now)!);
    expect((await repo.chats()).map((c) => c.id)).toEqual(['new']);
    expect(count('agent_chat_messages')).toBe(2);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('off', now)!);
    expect(await repo.chats()).toEqual([]);
    expect(count('agent_chat_messages') + count('agent_chat_entries')).toBe(0);
    // A tampered time is pruned too.
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('odd', 't', 1, 'x')").run();
    await repo.deleteChatsUpdatedBefore(retentionCutoff('30d', now)!);
    expect(count('agent_chats')).toBe(0);
  });

  test('chat-retention-preference-round-trip', async () => {
    expect(await repo.chatRetention()).toBe(DEFAULT_CHAT_RETENTION);
    for (const value of ['off', '7d', 'forever', '30d'] as const) {
      expect(await repo.setChatRetention(value, 5)).toBe(true);
      expect(await repo.chatRetention()).toBe(value);
    }
    expect(await repo.setChatRetention('1y' as never, 5)).toBe(false);
    expect(await repo.setChatRetention('7d', -1)).toBe(false);
    expect(await repo.chatRetention()).toBe('30d');
    raw.prepare('UPDATE agent_preferences SET value = ? WHERE key = ?').run('sometimes', CHAT_RETENTION_PREFERENCE_KEY);
    expect(await repo.chatRetention()).toBe(DEFAULT_CHAT_RETENTION);
  });

  test('agent-chats-in-store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-chats-'));
    try {
      const store = openSessionStore({ dir });
      expect(await store.agentChats.saveChat(chat('kept', 5))).toBe(true);
      expect(await store.agentChats.setChatRetention('7d', 5)).toBe(true);
      await store.close();
      const again = openSessionStore({ dir });
      expect((await again.agentChats.chats()).map((c) => c.id)).toEqual(['kept']);
      expect(await again.agentChats.chatRetention()).toBe('7d');
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
