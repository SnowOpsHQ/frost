import { canGrant, DEFAULT_READ_TOOLS_ALLOWED, MAX_AGENT_GRANTS } from '@app/specs/agent-approvals.spec';

// The agent's standing grants (Phase 5 Task 4; spec `specs/agent-approvals.spec.ts`; acceptance
// `specs/agent-approvals.feature.md`, Grants): an `act` tool (navigate, click) allowed on one public
// origin, and whether read tools run without asking. Kept in the database (`@app/db`'s
// `agentGrants`), cached here so the broker decides synchronously. Only main's code changes them:
// the broker on an `allow-always` answer, and the grants page (Task 9) through the sender-guarded
// IPC. Nothing the runtime sends reaches this module.
//
// Writes are awaited. A change that takes power away (revoking, turning read tools off) takes effect
// in the cache before the write, so it holds at once even if the write fails; one that gives power
// (a grant, read tools on) only after the write succeeded. Until `load()` has read the database,
// nothing is granted and read tools ask.

/** A standing grant. */
export interface AgentGrant {
  readonly tool: string;
  readonly origin: string;
  readonly createdAt: number;
}

/** The database side (`SessionStore.agentGrants` from `@app/db`, or `createMemoryGrantsStore`). */
export interface AgentGrantsStore {
  grants(): Promise<readonly AgentGrant[]>;
  addGrant(tool: string, origin: string, at: number): Promise<boolean>;
  revokeGrant(tool: string, origin: string): Promise<boolean>;
  revokeAllGrants(): Promise<void>;
  readToolsAllowed(): Promise<boolean>;
  setReadToolsAllowed(allowed: boolean, at: number): Promise<boolean>;
}

export interface AgentGrantsDeps {
  readonly store: AgentGrantsStore;
  readonly now?: () => number;
  /** One line per failure; never an origin. */
  readonly log?: (line: string) => void;
}

export interface AgentGrants {
  /** Reads the grants and the read-tools setting once (later calls share it). Never rejects. */
  load(): Promise<void>;
  /** Whether `load()` read the database (until then nothing is granted and read tools ask). */
  loaded(): boolean;
  /** Every grant, oldest first (the grants page). */
  list(): readonly AgentGrant[];
  /** Whether a grant covers `tool` on `origin` (never for a pair `canGrant` refuses). */
  has(tool: string, origin: string): boolean;
  /** Stores a grant; `false` (nothing granted) when `canGrant` refuses the pair, the cap is reached or the write fails. */
  add(tool: string, origin: string): Promise<boolean>;
  /** Revokes one grant (at once; then written). `false` if the write failed (the grant stays revoked for this run). */
  revoke(tool: string, origin: string): Promise<boolean>;
  /** Revokes every grant (at once; then written). `false` if the write failed. */
  revokeAll(): Promise<boolean>;
  /** Whether read tools run without asking. */
  readToolsAllowed(): boolean;
  /** Turns read tools' implied grant on or off; `false` if the value isn't a boolean or the write failed. */
  setReadToolsAllowed(allowed: boolean): Promise<boolean>;
  /** Called after each change (the grants page, the panel). */
  onChange(listener: () => void): () => void;
}

const key = (tool: string, origin: string) => `${tool}\n${origin}`;

export function createAgentGrants(deps: AgentGrantsDeps): AgentGrants {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const grants = new Map<string, AgentGrant>();
  let readTools = false;
  let isLoaded = false;
  let loading: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent grants: a change listener failed');
      }
    }
  };

  /** Runs writes one after another, so the cache and the database change in the same order. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = () => {
    loading ??= (async () => {
      try {
        const [stored, allowed] = await Promise.all([deps.store.grants(), deps.store.readToolsAllowed()]);
        for (const grant of stored.slice(0, MAX_AGENT_GRANTS)) {
          if (canGrant(grant.tool, grant.origin)) grants.set(key(grant.tool, grant.origin), { tool: grant.tool, origin: grant.origin, createdAt: grant.createdAt });
        }
        readTools = allowed === true;
        isLoaded = true;
      } catch {
        // Nothing is granted and read tools ask: the restrictive reading of an unreadable store.
        log('agent grants: the stored grants could not be read');
      }
      changed();
    })();
    return loading;
  };

  return {
    load,
    loaded: () => isLoaded,
    list: () => [...grants.values()].sort((a, b) => a.createdAt - b.createdAt),
    has: (tool, origin) => canGrant(tool, origin) && grants.has(key(tool, origin)),
    add(tool, origin) {
      if (!canGrant(tool, origin)) return Promise.resolve(false);
      return serial(async () => {
        await load();
        if (grants.has(key(tool, origin))) return true;
        if (grants.size >= MAX_AGENT_GRANTS) return false;
        const at = now();
        let ok = false;
        try {
          ok = await deps.store.addGrant(tool, origin, at);
        } catch {
          ok = false;
        }
        if (!ok) {
          log('agent grants: a grant could not be stored');
          return false;
        }
        grants.set(key(tool, origin), { tool, origin, createdAt: at });
        changed();
        return true;
      });
    },
    revoke(tool, origin) {
      if (grants.delete(key(tool, origin))) changed();
      if (!canGrant(tool, origin)) return Promise.resolve(true);
      return serial(async () => {
        await load();
        // A load that finished meanwhile may have read the row back.
        if (grants.delete(key(tool, origin))) changed();
        try {
          await deps.store.revokeGrant(tool, origin);
          return true;
        } catch {
          log('agent grants: a revoke could not be written');
          return false;
        }
      });
    },
    revokeAll() {
      if (grants.size > 0) {
        grants.clear();
        changed();
      }
      return serial(async () => {
        await load();
        // A load or an earlier add that finished meanwhile may have filled the cache again.
        if (grants.size > 0) {
          grants.clear();
          changed();
        }
        try {
          await deps.store.revokeAllGrants();
          return true;
        } catch {
          log('agent grants: revoking all could not be written');
          return false;
        }
      });
    },
    readToolsAllowed: () => readTools,
    setReadToolsAllowed(allowed) {
      if (typeof allowed !== 'boolean') return Promise.resolve(false);
      if (!allowed && readTools) {
        readTools = false;
        changed();
      }
      return serial(async () => {
        await load();
        // A load that finished meanwhile may have read the old value back.
        if (!allowed && readTools) {
          readTools = false;
          changed();
        }
        let ok = false;
        try {
          ok = await deps.store.setReadToolsAllowed(allowed, now());
        } catch {
          ok = false;
        }
        if (!ok) {
          log('agent grants: the read-tools setting could not be written');
          return false;
        }
        if (readTools !== allowed) {
          readTools = allowed;
          changed();
        }
        return true;
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * A store kept in memory (nothing persists): tests, and an agent built without the database. It
 * applies the same checks as `@app/db`'s repository.
 */
export function createMemoryGrantsStore(initial: { grants?: readonly AgentGrant[]; readToolsAllowed?: boolean } = {}): AgentGrantsStore & { rows: Map<string, AgentGrant> } {
  const rows = new Map<string, AgentGrant>((initial.grants ?? []).map((grant) => [key(grant.tool, grant.origin), grant]));
  let readTools = initial.readToolsAllowed ?? DEFAULT_READ_TOOLS_ALLOWED;
  return {
    rows,
    grants: async () => [...rows.values()],
    async addGrant(tool, origin, at) {
      if (!canGrant(tool, origin)) return false;
      if (!rows.has(key(tool, origin))) {
        if (rows.size >= MAX_AGENT_GRANTS) return false;
        rows.set(key(tool, origin), { tool, origin, createdAt: at });
      }
      return true;
    },
    async revokeGrant(tool, origin) {
      if (!canGrant(tool, origin)) return false;
      rows.delete(key(tool, origin));
      return true;
    },
    async revokeAllGrants() {
      rows.clear();
    },
    readToolsAllowed: async () => readTools,
    async setReadToolsAllowed(allowed) {
      if (typeof allowed !== 'boolean') return false;
      readTools = allowed;
      return true;
    },
  };
}
