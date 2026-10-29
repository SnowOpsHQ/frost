import type { Migration } from './migrations';

// The agent's MCP servers (Phase 5 Task 10; ids `0030`–`0039` are Phase 5's), appended to
// `MIGRATIONS` after `0032_agent_skills`. It creates exactly the table of `agent-mcp-schema.ts`
// (`AGENT_MCP_TABLES`). No secret is stored here: a server's token and environment values live in
// main's credential store (`safeStorage`), keyed by the server's id.

export const AGENT_MCP_MIGRATIONS: readonly Migration[] = [
  {
    id: '0033_agent_mcp_servers',
    sql: `
      CREATE TABLE agent_mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        url TEXT,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        env_names TEXT NOT NULL DEFAULT '[]',
        read_paths TEXT NOT NULL DEFAULT '[]',
        allow_network INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
