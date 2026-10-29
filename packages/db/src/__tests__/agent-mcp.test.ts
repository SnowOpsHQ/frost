// Spec: specs/agent-mcp.spec.ts (AGENT_MCP_TABLES, MCP_LIMITS, isMcpServerId)
// Acceptance: specs/agent-mcp.feature.md (Persistence)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { AGENT_MCP_TABLES, MCP_LIMITS } from '@app/specs/agent-mcp.spec';
import { createAgentMcpRepository, type AgentMcpRepository, type AgentMcpServerWrite } from '../agent-mcp';
import { agentMcpServers } from '../agent-mcp-schema';
import { createDrizzle } from '../client';
import { MIGRATIONS, runMigrations } from '../migrations';

let raw: DatabaseSync;
let repo: AgentMcpRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAgentMcpRepository(createDrizzle(raw));
});

const http = (id: string): AgentMcpServerWrite => ({ id, name: `Server ${id}`, transport: 'http', url: 'https://mcp.example.com/', command: null, args: '[]', envNames: '[]', readPaths: '[]', allowNetwork: false, enabled: false });
const stdio: AgentMcpServerWrite = { id: 'local', name: 'Local', transport: 'stdio', url: null, command: 'node', args: '["server.js"]', envNames: '["API_MODE"]', readPaths: '["/opt/tools"]', allowNetwork: true, enabled: true };

describe('agent MCP servers (db)', () => {
  test('agent-mcp-migrate', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0033_agent_mcp_servers');
    expect(AGENT_MCP_TABLES).toEqual([getTableConfig(agentMcpServers).name]);
    const sqlite = raw
      .prepare('PRAGMA table_info(agent_mcp_servers)')
      .all()
      .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const drizzle = getTableConfig(agentMcpServers)
      .columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull || column.primary }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sqlite).toEqual(drizzle);
  });

  test('agent-mcp-round-trip', async () => {
    expect(await repo.servers()).toEqual([]);
    expect(await repo.saveServer(http('docs'), 10)).toBe(true);
    expect(await repo.saveServer(stdio, 20)).toBe(true);
    // An update keeps its creation time (and its place).
    expect(await repo.saveServer({ ...http('docs'), name: 'Docs' }, 30)).toBe(true);
    expect(await repo.setEnabled('docs', true, 40)).toBe(true);
    expect(await repo.setEnabled('nope', true, 40)).toBe(false);
    const servers = await repo.servers();
    expect(servers.map((s) => [s.id, s.name, s.enabled, s.createdAt, s.updatedAt])).toEqual([
      ['docs', 'Docs', true, 10, 40],
      ['local', 'Local', true, 20, 20],
    ]);
    expect(servers[1]).toMatchObject({ command: 'node', args: '["server.js"]', envNames: '["API_MODE"]', readPaths: '["/opt/tools"]', allowNetwork: true, url: null });
    expect(await repo.deleteServer('docs')).toBe(true);
    expect((await repo.servers()).map((s) => s.id)).toEqual(['local']);
  });

  test('agent-mcp-no-secret-columns', () => {
    // Tokens and environment values live in main's credential store, never in this table.
    const columns = getTableConfig(agentMcpServers).columns.map((column) => column.name);
    expect(columns.some((name) => /token|secret|value|password|key/i.test(name))).toBe(false);
  });

  test('agent-mcp-refuse-out-of-bounds', async () => {
    for (const id of ['', 'Has-Caps', 'a'.repeat(17), 'with space']) expect(await repo.saveServer(http(id), 1), id).toBe(false);
    expect(await repo.saveServer({ ...http('ok'), url: 'x'.repeat(MCP_LIMITS.maxUrlChars + 1) }, 1)).toBe(false);
    expect(await repo.saveServer(http('ok'), Number.NaN)).toBe(false);
    for (let i = 0; i < MCP_LIMITS.maxServers; i += 1) expect(await repo.saveServer(http(`s${i}`), i)).toBe(true);
    expect(await repo.saveServer(http('onemore'), 99)).toBe(false);
    // Tampered rows are skipped.
    raw.prepare("DELETE FROM agent_mcp_servers").run();
    raw.prepare("INSERT INTO agent_mcp_servers (id, name, transport, created_at, updated_at) VALUES ('BAD', 'x', 'http', 1, 1)").run();
    raw.prepare("INSERT INTO agent_mcp_servers (id, name, transport, url, created_at, updated_at) VALUES ('huge', 'x', 'http', ?, 1, 1)").run('x'.repeat(MCP_LIMITS.maxUrlChars + 1));
    raw.prepare("INSERT INTO agent_mcp_servers (id, name, transport, url, created_at, updated_at) VALUES ('fine', 'x', 'http', 'https://a.example.com/', 1, 1)").run();
    expect((await repo.servers()).map((s) => s.id)).toEqual(['fine']);
  });
});
