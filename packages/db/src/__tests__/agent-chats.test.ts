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
import { createAgentChatsRepository, type AgentChatRowsUpdate, type AgentChatsRepository, type StoredAgentChatHead } from '../agent-chats';
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

const head = (id: string, updatedAt: number, changes: Partial<StoredAgentChatHead> = {}): StoredAgentChatHead => ({
  id,
  title: `Chat ${id}`,
  createdAt: updatedAt,
  updatedAt,
  modelId: 'anthropic/claude-sonnet-5-5',
  inputTokens: 10,
  outputTokens: 2,
  contextTokens: 12,
  truncated: false,
  ...changes,
});
const MESSAGES = ['{"role":"user","content":"hi"}', '{"role":"assistant","content":"hello","toolCalls":[]}'];
const ENTRIES = ['{"kind":"user","text":"hi"}', '{"kind":"assistant","text":"hello","tools":[]}'];
const full = (messages: readonly string[] = MESSAGES, entries: readonly string[] = ENTRIES): AgentChatRowsUpdate => ({ messagesFrom: 0, messages, entriesFrom: 0, entries });
/** Phase 5's migration ids (`0030`–`0039`): other phases' blocks may sit before or after it. */
const phase5 = (ids: readonly string[]) => ids.filter((id) => id >= '0030' && id < '0040');

describe('agent chats (db)', () => {
  test('agent-chats-migrate', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0031_agent_chats');
    expect(columns('agent_chats')).toEqual(drizzleColumns(agentChats));
    expect(columns('agent_chat_messages')).toEqual(drizzleColumns(agentChatMessages));
    expect(columns('agent_chat_entries')).toEqual(drizzleColumns(agentChatEntries));
    // Phase 5's block stays contiguous and in order.
    const ids = MIGRATIONS.map((m) => m.id);
    expect(phase5(ids)).toEqual(['0030_agent_grants', '0031_agent_chats', '0032_agent_skills']);
    expect(ids.indexOf('0031_agent_chats')).toBe(ids.indexOf('0030_agent_grants') + 1);
    expect(ids.indexOf('0032_agent_skills')).toBe(ids.indexOf('0031_agent_chats') + 1);
    // A database with the grants only gains the chat tables and keeps its grants.
    const old = new DatabaseSync(':memory:');
    runMigrations(old, MIGRATIONS.filter((m) => m.id <= '0030_agent_grants'));
    old.prepare("INSERT INTO agent_grants (tool, origin, created_at) VALUES ('navigate', 'https://example.com', 1)").run();
    expect(phase5(runMigrations(old))).toEqual(['0031_agent_chats', '0032_agent_skills']);
    expect(old.prepare('SELECT count(*) AS n FROM agent_grants').get()!['n']).toBe(1);
  });

  test('agent-chats-round-trip', async () => {
    expect(await repo.chatHeads()).toEqual([]);
    expect(await repo.chatRows('a')).toBeNull();
    expect(await repo.saveChat(head('a', 10), full())).toBe(true);
    const bare = head('b', 20, { modelId: null, inputTokens: null, outputTokens: null, contextTokens: null, truncated: true });
    expect(await repo.saveChat(bare, full(MESSAGES, []))).toBe(true);
    // Heads most recently updated first; rows only when asked for, in order.
    expect(await repo.chatHeads()).toEqual([bare, head('a', 10)]);
    expect(await repo.chatRows('a')).toEqual({ messages: MESSAGES, entries: ENTRIES });
    expect(await repo.chatRows('b')).toEqual({ messages: MESSAGES, entries: [] });
    // A full rewrite replaces the rows and keeps the creation time.
    expect(await repo.saveChat(head('a', 30, { createdAt: 99, title: 'Renamed' }), full(['{"role":"user","content":"only"}'], ENTRIES))).toBe(true);
    expect((await repo.chatHeads())[0]).toMatchObject({ id: 'a', title: 'Renamed', createdAt: 10, updatedAt: 30 });
    expect((await repo.chatRows('a'))!.messages).toEqual(['{"role":"user","content":"only"}']);
    await repo.deleteChat('a');
    expect((await repo.chatHeads()).map((c) => c.id)).toEqual(['b']);
    expect(count('agent_chat_messages')).toBe(2);
    await repo.deleteAllChats();
    expect(await repo.chatHeads()).toEqual([]);
    expect(count('agent_chats') + count('agent_chat_messages') + count('agent_chat_entries')).toBe(0);
  });

  test('agent-chats-append-only', async () => {
    expect(await repo.saveChat(head('a', 10), full())).toBe(true);
    const before = raw.prepare("SELECT rowid AS r, seq FROM agent_chat_messages WHERE chat_id = 'a' ORDER BY seq").all().map((row) => Number(row['r']));
    // The next turn writes only its own rows: the earlier ones are left as they were.
    expect(await repo.saveChat(head('a', 20), { messagesFrom: 2, messages: ['{"role":"user","content":"more"}'], entriesFrom: 2, entries: ['{"kind":"user","text":"more"}'] })).toBe(true);
    const after = raw.prepare("SELECT rowid AS r FROM agent_chat_messages WHERE chat_id = 'a' ORDER BY seq").all().map((row) => Number(row['r']));
    expect(after.slice(0, 2)).toEqual(before);
    expect(await repo.chatRows('a')).toEqual({ messages: [...MESSAGES, '{"role":"user","content":"more"}'], entries: [...ENTRIES, '{"kind":"user","text":"more"}'] });
    // A position past what is stored would leave a gap: refused, nothing written.
    expect(await repo.saveChat(head('a', 30), { messagesFrom: 9, messages: ['{}'], entriesFrom: 3, entries: [] })).toBe(false);
    expect(await repo.saveChat(head('new', 30), { messagesFrom: 1, messages: ['{}'], entriesFrom: 0, entries: [] })).toBe(false);
    expect((await repo.chatHeads()).map((c) => [c.id, c.updatedAt])).toEqual([['a', 20]]);
    // Replacing from a position drops the rows after it.
    expect(await repo.saveChat(head('a', 40), { messagesFrom: 1, messages: ['{"x":1}'], entriesFrom: 3, entries: [] })).toBe(true);
    expect((await repo.chatRows('a'))!.messages).toEqual([MESSAGES[0], '{"x":1}']);
  });

  test('agent-chats-capped', async () => {
    for (let i = 0; i < MAX_STORED_CHATS + 3; i += 1) expect(await repo.saveChat(head(`c${i}`, 1000 + i), full())).toBe(true);
    // Only the most recent are kept, and the older ones' rows go with them.
    const ids = (await repo.chatHeads()).map((c) => c.id);
    expect(ids).toHaveLength(MAX_STORED_CHATS);
    expect(ids).not.toContain('c0');
    expect(ids[0]).toBe(`c${MAX_STORED_CHATS + 2}`);
    expect(count('agent_chats')).toBe(MAX_STORED_CHATS);
    expect(count('agent_chat_messages')).toBe(MAX_STORED_CHATS * 2);
    expect(count('agent_chat_entries')).toBe(MAX_STORED_CHATS * 2);
  });

  test('agent-chats-refuse-out-of-bounds', async () => {
    const refused: [Partial<StoredAgentChatHead>, AgentChatRowsUpdate][] = [
      [{ id: '' }, full()],
      [{ id: 'has space' }, full()],
      [{ id: 'x'.repeat(65) }, full()],
      [{ title: 't'.repeat(201) }, full()],
      [{ updatedAt: Number.NaN }, full()],
      [{ createdAt: -1 }, full()],
      [{ inputTokens: 1.5 }, full()],
      [{ modelId: 'm'.repeat(200) }, full()],
      [{}, full(Array.from({ length: MAX_STORED_ROWS_PER_CHAT + 1 }, () => '{}'))],
      [{}, { ...full(), messagesFrom: MAX_STORED_ROWS_PER_CHAT }],
      [{}, { ...full(), entriesFrom: -1 }],
      [{}, full([''])],
      [{}, full(['x'.repeat(STORED_CHAT_ROW_MAX_CHARS + 1)])],
    ];
    for (const [changes, rows] of refused) expect(await repo.saveChat(head('ok', 1, changes), rows), JSON.stringify(changes).slice(0, 80)).toBe(false);
    expect(count('agent_chats')).toBe(0);
    // A tampered row is skipped on the way out.
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('bad id', 't', 1, 1)").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('later', 't', 1, 'soon')").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at, input_tokens) VALUES ('neg', 't', 1, 1, -5)").run();
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('fine', 't', 1, 2)").run();
    raw.prepare("INSERT INTO agent_chat_messages (chat_id, seq, message) VALUES ('fine', 0, 'm')").run();
    expect((await repo.chatHeads()).map((c) => c.id)).toEqual(['fine']);
    expect(await repo.chatRows('fine')).toEqual({ messages: ['m'], entries: [] });
  });

  test('agent-chats-prune-by-retention', async () => {
    const day = 86_400_000;
    const now = 100 * day;
    await repo.saveChat(head('old', now - 31 * day), full());
    await repo.saveChat(head('week', now - 8 * day), full());
    await repo.saveChat(head('new', now - day), full());
    expect(await repo.countChatsUpdatedBefore(retentionCutoff('30d', now)!)).toBe(1);
    expect(await repo.countChatsUpdatedBefore(retentionCutoff('7d', now)!)).toBe(2);
    expect(await repo.countChatsUpdatedBefore(retentionCutoff('off', now)!)).toBe(3);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('forever', now) ?? Number.NEGATIVE_INFINITY);
    expect((await repo.chatHeads()).map((c) => c.id)).toEqual(['new', 'week', 'old']);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('30d', now)!);
    expect((await repo.chatHeads()).map((c) => c.id)).toEqual(['new', 'week']);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('7d', now)!);
    expect((await repo.chatHeads()).map((c) => c.id)).toEqual(['new']);
    expect(count('agent_chat_messages')).toBe(2);
    await repo.deleteChatsUpdatedBefore(retentionCutoff('off', now)!);
    expect(await repo.chatHeads()).toEqual([]);
    expect(count('agent_chat_messages') + count('agent_chat_entries')).toBe(0);
    // A tampered time is pruned (and counted) too.
    raw.prepare("INSERT INTO agent_chats (id, title, created_at, updated_at) VALUES ('odd', 't', 1, 'x')").run();
    expect(await repo.countChatsUpdatedBefore(retentionCutoff('30d', now)!)).toBe(1);
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

  test('agent-chats-deleted-text-leaves-the-file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-chats-secure-'));
    try {
      const store = openSessionStore({ dir });
      const secret = (tag: string) => `SECRET-${tag}-${'q'.repeat(3000)}-TERCES`;
      const big = (tag: string) => `{"role":"user","content":"${secret(tag)}"}`;
      for (const tag of ['one', 'two', 'three', 'four']) expect(await store.agentChats.saveChat(head(tag, 1), full([big(tag)], [`{"kind":"user","text":"${secret(tag)}-entry"}`]))).toBe(true);
      // A rewrite overwrites rows too.
      expect(await store.agentChats.saveChat(head('four', 2), full(['{"role":"user","content":"short"}'], []))).toBe(true);
      await store.agentChats.deleteChat('one');
      await store.agentChats.deleteChatsUpdatedBefore(Number.POSITIVE_INFINITY);
      await store.close();
      const bytes = fs.readFileSync(store.file).toString('latin1');
      for (const tag of ['one', 'two', 'three', 'four']) expect(bytes, tag).not.toContain(`SECRET-${tag}`);
      // The connection's own setting is unchanged afterwards (no other table's deletes change).
      const db = new DatabaseSync(store.file);
      expect(db.prepare('PRAGMA secure_delete').get()!['secure_delete']).toBe(0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('agent-chats-in-store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-chats-'));
    try {
      const store = openSessionStore({ dir });
      expect(await store.agentChats.saveChat(head('kept', 5), full())).toBe(true);
      expect(await store.agentChats.setChatRetention('7d', 5)).toBe(true);
      await store.close();
      const again = openSessionStore({ dir });
      expect((await again.agentChats.chatHeads()).map((c) => c.id)).toEqual(['kept']);
      expect(await again.agentChats.chatRows('kept')).toEqual({ messages: MESSAGES, entries: ENTRIES });
      expect(await again.agentChats.chatRetention()).toBe('7d');
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
