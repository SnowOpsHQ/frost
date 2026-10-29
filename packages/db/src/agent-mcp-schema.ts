import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The agent's MCP servers (Phase 5 Task 10; spec `specs/agent-mcp.spec.ts`; acceptance
// `specs/agent-mcp.feature.md`, Persistence). Migration `0033_agent_mcp_servers` creates exactly
// this table. An HTTP server has a `url`; a command server a `command` and `args` (a JSON array of
// strings), the names of its environment variables (`env_names`, JSON; their values are secrets
// main keeps in its credential store), the folders a sandbox lets it read (`read_paths`, JSON) and
// whether its sandbox allows the network. Main validates every row again when it reads it
// (`McpServerConfigSchema`), so a tampered row never becomes a server.

export const agentMcpServers = sqliteTable('agent_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(),
  url: text('url'),
  command: text('command'),
  args: text('args').notNull().default('[]'),
  envNames: text('env_names').notNull().default('[]'),
  readPaths: text('read_paths').notNull().default('[]'),
  allowNetwork: integer('allow_network', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
