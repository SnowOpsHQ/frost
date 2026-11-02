import { routeCredentialSlot, type AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { routeModelId, type AgentModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import type { ChatgptRoute } from './chatgpt/route';
import type { CredentialSettings } from './credentials';
import type { AgentCheckEvent, AgentCheckStart, AgentHost } from './host';
import type { AgentSession } from './session';
import type { AgentSettings } from './settings';

// What the AI checks service (Phase 9 Task 10, `main/ai-checks/`; Decision 15) may use of the
// agent: Task 9's check transport on the host (`startCheck` / `stopCheck` / `onCheck`), the route
// and model main's own agent settings name (and whether that route's credential is set up: a stored
// key, or the ChatGPT sign-in ready, as a chat checks before a turn), whether a chat turn is running,
// and when the last one ends. Never a key, a token or the proxy itself: the service names no route
// or model of its own, and `startCheck` is only ever given the ones `model()` answered.

/** A route and model as main's agent settings name them. */
export interface AgentCheckModel {
  readonly route: ModelRoute;
  readonly modelId: AgentModelId;
}

export interface AgentCheckPort {
  /** The route and model the agent settings name now (the cost note), set up or not. */
  current(): AgentCheckModel;
  /**
   * The route and model the agent settings name, once they are loaded, when a check could run on
   * them: the model belongs to the route and the route's credential is set up. `null`: no model.
   */
  model(): Promise<AgentCheckModel | null>;
  /** Forks the runtime if needed and waits for it (`false`: it did not start). */
  start(): Promise<boolean>;
  /** Task 9's `host.startCheck`. */
  startCheck(start: AgentCheckStart): boolean;
  /** Task 9's `host.stopCheck`. */
  stopCheck(checkId: string): boolean;
  /** Task 9's `host.onCheck`. */
  onCheck(listener: (event: AgentCheckEvent) => void): () => void;
  /** Whether a chat turn is running (its requests come first). */
  chatRunning(): boolean;
  /** The last running chat turn ended (finished or failed). */
  onChatsIdle(listener: () => void): () => void;
}

export interface AgentCheckPortDeps {
  readonly host: Pick<AgentHost, 'startCheck' | 'stopCheck' | 'onCheck' | 'onChat' | 'activeChats'>;
  readonly settings: Pick<AgentSettings, 'load' | 'current'>;
  readonly credentials: Pick<CredentialSettings, 'hasKey'>;
  readonly chatgpt: Pick<ChatgptRoute, 'ready'>;
  /** Loads the agent's settings and grants, then forks the runtime (`Agent.start`). */
  start(): Promise<boolean>;
}

/** The agent session the IPC gets, with the AI checks' port beside it (main wires both). */
export type AgentSessionWithChecks = AgentSession & { readonly checks: AgentCheckPort };

const modelOf = (settings: AgentModelSettings): AgentCheckModel => ({ route: settings.route, modelId: settings.modelId });

export function createAgentCheckPort(deps: AgentCheckPortDeps): AgentCheckPort {
  return {
    current: () => modelOf(deps.settings.current()),
    async model() {
      await deps.settings.load();
      const model = modelOf(deps.settings.current());
      if (routeModelId(model.route, model.modelId) === null) return null;
      const slot = routeCredentialSlot(model.route);
      let ready = false;
      try {
        ready = slot === null ? deps.chatgpt.ready() === true : (await deps.credentials.hasKey(slot)) === true;
      } catch {
        ready = false;
      }
      return ready ? model : null;
    },
    async start() {
      try {
        return (await deps.start()) === true;
      } catch {
        return false;
      }
    },
    startCheck: (start) => deps.host.startCheck(start),
    stopCheck: (checkId) => deps.host.stopCheck(checkId),
    onCheck: (listener) => deps.host.onCheck(listener),
    chatRunning: () => deps.host.activeChats().length > 0,
    onChatsIdle: (listener) =>
      // The host ends a chat before it emits its end, so `activeChats` is already current here.
      deps.host.onChat((event) => {
        if ((event.type === 'chat.finish' || event.type === 'chat.error') && deps.host.activeChats().length === 0) listener();
      }),
  };
}
