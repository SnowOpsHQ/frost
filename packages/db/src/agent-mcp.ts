import { asc, count, eq, sql } from 'drizzle-orm';
import { isMcpServerId, MCP_LIMITS } from '@app/specs/agent-mcp.spec';
import type { SessionDatabase } from './client';
import { agentMcpServers } from './agent-mcp-schema';

// The agent's MCP servers (Phase 5 Task 10; spec `specs/agent-mcp.spec.ts`; acceptance
// `specs/agent-mcp.feature.md`, Persistence). The repository stores what main validated and bounds
// what it reads back (each text column cut past its cap reads as `null`, so main refuses the row);
// main validates every row with `McpServerConfigSchema` before it uses it. At most
// `MCP_LIMITS.maxServers` rows. No token or environment value is ever stored here.

export interface StoredAgentMcpServer {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly url: string | null;
  readonly command: string | null;
  /** JSON text: the arguments, the environment names, the readable folders. */
  readonly args: string;
  readonly envNames: string;
  readonly readPaths: string;
  readonly allowNetwork: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type AgentMcpServerWrite = Omit<StoredAgentMcpServer, 'createdAt' | 'updatedAt'>;

export interface AgentMcpRepository {
  /** The stored servers, oldest first (at most `maxServers`); a row with an out-of-bounds field is skipped. */
  servers(): Promise<StoredAgentMcpServer[]>;
  /**
   * Stores `server` in place of the one with its id (which keeps its `createdAt`), or adds it.
   * `false` (nothing written) for a malformed id, a field out of bounds, an invalid time, or a new
   * id when `maxServers` are stored.
   */
  saveServer(server: AgentMcpServerWrite, at: number): Promise<boolean>;
  /** Turns a stored server on or off; `false` for an unknown id. */
  setEnabled(id: string, enabled: boolean, at: number): Promise<boolean>;
  deleteServer(id: string): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Each text column's cap (characters): a JSON column holds at most its list's items at their caps, escaped. */
const CAPS = {
  name: MCP_LIMITS.maxNameChars * 2,
  transport: 16,
  url: MCP_LIMITS.maxUrlChars,
  command: MCP_LIMITS.maxCommandChars,
  args: (MCP_LIMITS.maxArgChars * 6 + 3) * MCP_LIMITS.maxArgs + 2,
  envNames: (MCP_LIMITS.maxEnvNameChars + 3) * MCP_LIMITS.maxEnvVars + 2,
  readPaths: (MCP_LIMITS.maxPathChars * 6 + 3) * MCP_LIMITS.maxReadPaths + 2,
} as const;

const fits = (value: string | null, max: number) => value === null || (typeof value === 'string' && value.length <= max);

export function createAgentMcpRepository(db: SessionDatabase): AgentMcpRepository {
  const capped = (column: Parameters<typeof sql>[1], max: number) => sql<unknown>`CASE WHEN length(${column}) <= ${max} THEN ${column} ELSE NULL END`;
  return {
    async servers() {
      const rows = await db
        .select({
          id: sql<unknown>`substr(${agentMcpServers.id}, 1, ${MCP_LIMITS.maxServerIdChars + 1})`,
          name: capped(agentMcpServers.name, CAPS.name),
          transport: capped(agentMcpServers.transport, CAPS.transport),
          url: capped(agentMcpServers.url, CAPS.url),
          command: capped(agentMcpServers.command, CAPS.command),
          args: capped(agentMcpServers.args, CAPS.args),
          envNames: capped(agentMcpServers.envNames, CAPS.envNames),
          readPaths: capped(agentMcpServers.readPaths, CAPS.readPaths),
          allowNetwork: agentMcpServers.allowNetwork,
          enabled: agentMcpServers.enabled,
          createdAt: agentMcpServers.createdAt,
          updatedAt: agentMcpServers.updatedAt,
          // Whether the cut columns were present (a NULL url or command is fine, a NULL from a cut is not).
          urlLength: sql<unknown>`length(${agentMcpServers.url})`,
          commandLength: sql<unknown>`length(${agentMcpServers.command})`,
        })
        .from(agentMcpServers)
        .orderBy(asc(agentMcpServers.createdAt), asc(agentMcpServers.id))
        .limit(MCP_LIMITS.maxServers);
      const out: StoredAgentMcpServer[] = [];
      for (const row of rows) {
        if (!isMcpServerId(row.id) || typeof row.name !== 'string' || typeof row.transport !== 'string' || typeof row.args !== 'string' || typeof row.envNames !== 'string' || typeof row.readPaths !== 'string') continue;
        if ((row.urlLength !== null && typeof row.url !== 'string') || (row.commandLength !== null && typeof row.command !== 'string')) continue;
        if (typeof row.allowNetwork !== 'boolean' || typeof row.enabled !== 'boolean' || !isTime(row.createdAt) || !isTime(row.updatedAt)) continue;
        out.push({
          id: row.id,
          name: row.name,
          transport: row.transport,
          url: typeof row.url === 'string' ? row.url : null,
          command: typeof row.command === 'string' ? row.command : null,
          args: row.args,
          envNames: row.envNames,
          readPaths: row.readPaths,
          allowNetwork: row.allowNetwork,
          enabled: row.enabled,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
      return out;
    },

    async saveServer(server, at) {
      if (!isMcpServerId(server.id) || !isTime(at)) return false;
      for (const key of ['name', 'transport', 'args', 'envNames', 'readPaths'] as const) if (typeof server[key] !== 'string' || !fits(server[key], CAPS[key])) return false;
      if (!fits(server.url, CAPS.url) || !fits(server.command, CAPS.command) || typeof server.allowNetwork !== 'boolean' || typeof server.enabled !== 'boolean') return false;
      const [existing] = await db.select({ id: agentMcpServers.id }).from(agentMcpServers).where(eq(agentMcpServers.id, server.id)).limit(1);
      if (!existing) {
        const [total] = await db.select({ n: count() }).from(agentMcpServers);
        if ((total?.n ?? 0) >= MCP_LIMITS.maxServers) return false;
      }
      const values = {
        name: server.name,
        transport: server.transport,
        url: server.url,
        command: server.command,
        args: server.args,
        envNames: server.envNames,
        readPaths: server.readPaths,
        allowNetwork: server.allowNetwork,
        enabled: server.enabled,
        updatedAt: at,
      };
      await db
        .insert(agentMcpServers)
        .values({ id: server.id, ...values, createdAt: at })
        .onConflictDoUpdate({ target: agentMcpServers.id, set: values });
      return true;
    },

    async setEnabled(id, enabled, at) {
      if (!isMcpServerId(id) || typeof enabled !== 'boolean' || !isTime(at)) return false;
      const updated = await db.update(agentMcpServers).set({ enabled, updatedAt: at }).where(eq(agentMcpServers.id, id)).returning({ id: agentMcpServers.id });
      return updated.length > 0;
    },

    async deleteServer(id) {
      if (!isMcpServerId(id)) return false;
      await db.delete(agentMcpServers).where(eq(agentMcpServers.id, id));
      return true;
    },
  };
}
