import { and, asc, count, eq, sql } from 'drizzle-orm';
import { canGrant, DEFAULT_READ_TOOLS_ALLOWED, MAX_AGENT_GRANTS, MAX_GRANT_ORIGIN_CHARS, READ_TOOLS_PREFERENCE_KEY } from '@app/specs/agent-approvals.spec';
import type { SessionDatabase } from './client';
import { agentGrants, agentPreferences } from './agent-grants-schema';

// The agent's standing grants and preferences (Phase 5 Task 4; spec `specs/agent-approvals.spec.ts`;
// acceptance `specs/agent-approvals.feature.md`, Grants). A grant is an `act` tool allowed on one
// public origin (`canGrant`); anything else is refused on the way in (`false`) and skipped on the
// way out (a tampered row never becomes a grant). Main keeps them cached (`apps/desktop/src/main/agent/grants.ts`).

/** A stored grant. */
export interface StoredAgentGrant {
  readonly tool: string;
  readonly origin: string;
  readonly createdAt: number;
}

export interface AgentGrantsRepository {
  /** Every valid grant (`canGrant`), oldest first, at most `MAX_AGENT_GRANTS`. */
  grants(): Promise<StoredAgentGrant[]>;
  /**
   * Stores a grant for `tool` on `origin` (an existing one keeps its time). `false` (nothing
   * written) when `canGrant` refuses the pair, the time is invalid, or `MAX_AGENT_GRANTS` are stored.
   */
  addGrant(tool: string, origin: string, at: number): Promise<boolean>;
  /** Deletes the grant; `false` for a pair that can't be a grant. */
  revokeGrant(tool: string, origin: string): Promise<boolean>;
  /** Deletes every grant. */
  revokeAllGrants(): Promise<void>;
  /** Whether read tools run without asking (`DEFAULT_READ_TOOLS_ALLOWED` when unset or tampered). */
  readToolsAllowed(): Promise<boolean>;
  /** Stores the read-tools setting; `false` (nothing written) for a non-boolean or an invalid time. */
  setReadToolsAllowed(allowed: boolean, at: number): Promise<boolean>;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function createAgentGrantsRepository(db: SessionDatabase): AgentGrantsRepository {
  return {
    async grants() {
      // A tampered file may hold values of any size: read no more of each than can be stored (one over).
      const rows = await db
        .select({
          tool: sql<unknown>`substr(${agentGrants.tool}, 1, 65)`,
          origin: sql<unknown>`substr(${agentGrants.origin}, 1, ${MAX_GRANT_ORIGIN_CHARS + 1})`,
          createdAt: agentGrants.createdAt,
        })
        .from(agentGrants)
        .orderBy(asc(agentGrants.createdAt), asc(agentGrants.tool), asc(agentGrants.origin))
        .limit(MAX_AGENT_GRANTS);
      const out: StoredAgentGrant[] = [];
      for (const row of rows) {
        if (typeof row.tool !== 'string' || !canGrant(row.tool, row.origin) || !isTime(row.createdAt)) continue;
        out.push({ tool: row.tool, origin: row.origin as string, createdAt: row.createdAt });
      }
      return out;
    },

    async addGrant(tool, origin, at) {
      if (!canGrant(tool, origin) || !isTime(at)) return false;
      const [existing] = await db
        .select({ tool: agentGrants.tool })
        .from(agentGrants)
        .where(and(eq(agentGrants.tool, tool), eq(agentGrants.origin, origin)))
        .limit(1);
      if (existing) return true;
      const [total] = await db.select({ n: count() }).from(agentGrants);
      if ((total?.n ?? 0) >= MAX_AGENT_GRANTS) return false;
      await db.insert(agentGrants).values({ tool, origin, createdAt: at }).onConflictDoNothing();
      return true;
    },

    async revokeGrant(tool, origin) {
      if (!canGrant(tool, origin)) return false;
      await db.delete(agentGrants).where(and(eq(agentGrants.tool, tool), eq(agentGrants.origin, origin)));
      return true;
    },

    async revokeAllGrants() {
      await db.delete(agentGrants);
    },

    async readToolsAllowed() {
      const [row] = await db
        .select({ value: sql<unknown>`substr(${agentPreferences.value}, 1, 2)` })
        .from(agentPreferences)
        .where(eq(agentPreferences.key, READ_TOOLS_PREFERENCE_KEY))
        .limit(1);
      if (row?.value === '1') return true;
      if (row?.value === '0') return false;
      return DEFAULT_READ_TOOLS_ALLOWED;
    },

    async setReadToolsAllowed(allowed, at) {
      if (typeof allowed !== 'boolean' || !isTime(at)) return false;
      const value = allowed ? '1' : '0';
      await db
        .insert(agentPreferences)
        .values({ key: READ_TOOLS_PREFERENCE_KEY, value, updatedAt: at })
        .onConflictDoUpdate({ target: agentPreferences.key, set: { value, updatedAt: at } });
      return true;
    },
  };
}
