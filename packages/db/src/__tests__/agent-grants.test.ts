// Spec: specs/agent-approvals.spec.ts (AGENT_GRANT_TABLES, canGrant, isGrantOrigin, MAX_AGENT_GRANTS,
// READ_TOOLS_PREFERENCE_KEY, DEFAULT_READ_TOOLS_ALLOWED)
// Acceptance: specs/agent-approvals.feature.md (Grants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { AGENT_CHAT_TABLES, AGENT_SKILL_TABLES } from '@app/specs/agent-data.spec';
import { AGENT_GRANT_TABLES, DEFAULT_READ_TOOLS_ALLOWED, MAX_AGENT_GRANTS, READ_TOOLS_PREFERENCE_KEY } from '@app/specs/agent-approvals.spec';
import { createAgentGrantsRepository, type AgentGrantsRepository } from '../agent-grants';
import { agentGrants, agentPreferences } from '../agent-grants-schema';
import { createDrizzle } from '../client';
import { MIGRATIONS, runMigrations } from '../migrations';
import { openSessionStore } from '../store';

let raw: DatabaseSync;
let repo: AgentGrantsRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAgentGrantsRepository(createDrizzle(raw));
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

describe('agent grants (db)', () => {
  test('agent-grants-migrate', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0030_agent_grants');
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%' ORDER BY name").all().map((row) => String(row['name']));
    // Task 9's tables (`agent-chats.test.ts`, `agent-skills.test.ts`) sit beside them.
    expect(tables).toEqual([...AGENT_GRANT_TABLES, ...AGENT_CHAT_TABLES, ...AGENT_SKILL_TABLES].sort());
    expect(columns('agent_grants')).toEqual(drizzleColumns(agentGrants));
    expect(columns('agent_preferences')).toEqual(drizzleColumns(agentPreferences));
    // The key is (tool, origin): no second row for one pair.
    const insert = raw.prepare('INSERT INTO agent_grants (tool, origin, created_at) VALUES (?, ?, ?)');
    insert.run('navigate', 'https://example.com', 1);
    expect(() => insert.run('navigate', 'https://example.com', 2)).toThrow();
    // A database from before Phase 5 gains the tables and keeps its data.
    const old = new DatabaseSync(':memory:');
    runMigrations(old, MIGRATIONS.filter((m) => m.id < '0030'));
    old.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('search_engine', 'x', 1)").run();
    // Phase 5's block only: other phases' migrations may be appended around it.
    expect(runMigrations(old).filter((id) => id >= '0030' && id < '0040')).toEqual(['0030_agent_grants', '0031_agent_chats', '0032_agent_skills']);
    expect(old.prepare('SELECT count(*) AS n FROM app_settings').get()!['n']).toBe(1);
  });

  test('agent-grants-round-trip', async () => {
    expect(await repo.grants()).toEqual([]);
    expect(await repo.addGrant('navigate', 'https://example.com', 10)).toBe(true);
    expect(await repo.addGrant('click', 'https://shop.example.com:8443', 20)).toBe(true);
    // An existing grant keeps its time.
    expect(await repo.addGrant('navigate', 'https://example.com', 30)).toBe(true);
    expect(await repo.grants()).toEqual([
      { tool: 'navigate', origin: 'https://example.com', createdAt: 10 },
      { tool: 'click', origin: 'https://shop.example.com:8443', createdAt: 20 },
    ]);
    expect(await repo.revokeGrant('navigate', 'https://example.com')).toBe(true);
    expect((await repo.grants()).map((g) => g.tool)).toEqual(['click']);
    expect(await repo.addGrant('navigate', 'https://a.example.com', 40)).toBe(true);
    await repo.revokeAllGrants();
    expect(await repo.grants()).toEqual([]);
    expect(count('agent_grants')).toBe(0);
  });

  test('agent-grants-refuse-ungrantable', async () => {
    const refused: [string, string][] = [
      // Not an act tool: read tools are covered by the setting; execute and MCP never.
      ['page_text', 'https://example.com'],
      ['execute_javascript', 'https://example.com'],
      ['mcp__files__read', 'https://example.com'],
      ['shell', 'https://example.com'],
      // Not a canonical public http(s) origin.
      ['navigate', 'http://localhost:3000'],
      ['navigate', 'http://127.0.0.1'],
      ['navigate', 'http://[::1]'],
      ['navigate', 'http://192.168.1.1'],
      ['navigate', 'https://intranet'],
      ['navigate', 'https://printer.local'],
      ['navigate', 'file:///etc'],
      ['navigate', 'javascript:alert(1)'],
      ['navigate', 'https://example.com/'],
      ['navigate', 'https://example.com/path'],
      ['navigate', 'HTTPS://EXAMPLE.COM'],
      ['navigate', 'http://example.com'],
      ['navigate', 'https://example.com.'],
      ['navigate', ''],
    ];
    for (const [tool, origin] of refused) {
      expect(await repo.addGrant(tool, origin, 1), `${tool} ${origin}`).toBe(false);
      expect(await repo.revokeGrant(tool, origin), `${tool} ${origin}`).toBe(false);
    }
    expect(await repo.addGrant('navigate', 'https://example.com', Number.NaN)).toBe(false);
    expect(count('agent_grants')).toBe(0);
    // A tampered row is never read back as a grant.
    const insert = raw.prepare('INSERT INTO agent_grants (tool, origin, created_at) VALUES (?, ?, ?)');
    insert.run('execute_javascript', 'https://example.com', 1);
    insert.run('navigate', 'http://localhost', 1);
    insert.run('navigate', `https://${'a'.repeat(5000)}.com`, 1);
    insert.run('click', 'https://ok.example.com', 'soon');
    insert.run('click', 'https://ok.example.com:1', 2);
    expect(await repo.grants()).toEqual([{ tool: 'click', origin: 'https://ok.example.com:1', createdAt: 2 }]);
  });

  test('agent-grants-capped', async () => {
    const insert = raw.prepare('INSERT INTO agent_grants (tool, origin, created_at) VALUES (?, ?, ?)');
    for (let i = 0; i < MAX_AGENT_GRANTS; i += 1) insert.run('navigate', `https://site${i}.example.com`, i);
    expect(await repo.addGrant('navigate', 'https://one-more.example.com', 1)).toBe(false);
    // An existing one is still "added".
    expect(await repo.addGrant('navigate', 'https://site0.example.com', 1)).toBe(true);
    expect((await repo.grants()).length).toBe(MAX_AGENT_GRANTS);
  });

  test('read-tools-preference-round-trip', async () => {
    expect(await repo.readToolsAllowed()).toBe(DEFAULT_READ_TOOLS_ALLOWED);
    expect(await repo.setReadToolsAllowed(false, 5)).toBe(true);
    expect(await repo.readToolsAllowed()).toBe(false);
    expect(await repo.setReadToolsAllowed(true, 6)).toBe(true);
    expect(await repo.readToolsAllowed()).toBe(true);
    expect(count('agent_preferences')).toBe(1);
    expect(await repo.setReadToolsAllowed('no' as never, 7)).toBe(false);
    expect(await repo.setReadToolsAllowed(false, -1)).toBe(false);
    expect(await repo.readToolsAllowed()).toBe(true);
    // A tampered value reads as the default.
    raw.prepare('UPDATE agent_preferences SET value = ? WHERE key = ?').run('maybe', READ_TOOLS_PREFERENCE_KEY);
    expect(await repo.readToolsAllowed()).toBe(DEFAULT_READ_TOOLS_ALLOWED);
  });

  test('agent-grants-in-store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-grants-'));
    try {
      const store = openSessionStore({ dir });
      expect(await store.agentGrants.addGrant('navigate', 'https://example.com', 1)).toBe(true);
      await store.close();
      // Persisted across opens.
      const again = openSessionStore({ dir });
      expect(await again.agentGrants.grants()).toEqual([{ tool: 'navigate', origin: 'https://example.com', createdAt: 1 }]);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
