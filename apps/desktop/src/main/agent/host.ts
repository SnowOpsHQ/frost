import path from 'node:path';
import {
  AGENT_PROTOCOL_VERSION,
  MainToRuntimeMessageSchema,
  RuntimeToMainMessageSchema,
  type MainToRuntimeMessage,
  type RuntimeToMainMessage,
} from '@app/specs/agent-protocol.schema';
import { AGENT_HOST_LIMITS, AGENT_PROXY_LIMITS, AGENT_RUNTIME_FILE, AGENT_SERVICE_NAME, MAX_MODEL_REQUESTS_PER_TURN, restartDelayMs } from '@app/specs/agent-proxy.spec';
import { coalescedLog } from './log';

// The agent host (Phase 5 Task 3, plan decision 6; acceptance `specs/agent-host.feature.md`, Host):
// forks the agent runtime as an Electron utility process on first use, hands it one MessagePort,
// and is main's only door to it. Every inbound message is parsed with `RuntimeToMainMessageSchema`
// and dropped (counted, never logged) when it fails; every outbound one is parsed with
// `MainToRuntimeMessageSchema` before it is posted. The process gets an empty environment (only
// `NODE_ENV`), so it inherits no secret; it never holds a key (model requests come back to main's
// proxy as `fetch.request`). Node's permission flags are passed, but Electron 45 does not enforce
// them in a utility process: the runtime reports that in `ready.lockdown.permissionModel`, and
// `lockdown()` hands it on so the settings page never claims a file sandbox that isn't there.

/** The part of Electron's `MessagePortMain` the host uses. */
export interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** The part of Electron's `UtilityProcess` the host uses. */
export interface HostChild {
  postMessage(message: unknown, transfer?: readonly HostPort[]): void;
  kill(): boolean;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

/** `utilityProcess.fork`'s options as the host passes them. */
export interface AgentForkOptions {
  readonly serviceName: string;
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly stdio: 'ignore' | 'inherit';
}

export interface AgentHostDeps {
  /** `utilityProcess.fork` (main) or a fake (tests). */
  readonly fork: (modulePath: string, args: string[], options: AgentForkOptions) => HostChild;
  /** `new MessageChannelMain()` (main) or a fake pair (tests). */
  readonly createChannel: () => { readonly port1: HostPort; readonly port2: HostPort };
  /** The directory holding main's build and the runtime's bundle (main: `__dirname`). */
  readonly buildDir: string;
  /** `app.isPackaged`: the runtime's output is dropped in a packaged build. */
  readonly packaged: boolean;
  /** The runtime's `NODE_ENV` (default `production`). */
  readonly nodeEnv?: string;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
  /** One line per event (start, exit, restart); never a message's content. */
  readonly log?: (line: string) => void;
}

/**
 * - `stopped`: not running (before first use, after `dispose`, or after a protocol mismatch);
 * - `starting`: forked, waiting for `ready`;
 * - `ready`: speaking the protocol;
 * - `crashed`: exited or missed `ready`; a restart is scheduled unless it failed too often in a row
 *   (then the next `start()` tries again).
 */
export type AgentHostStatus = 'stopped' | 'starting' | 'ready' | 'crashed';

/** Why the runtime last failed, for the settings page (`null`: it hasn't). */
export type AgentHostFailure = 'exited' | 'ready-timeout' | 'protocol-mismatch' | 'fork-failed' | 'misbehaved';

/** What the runtime's lockdown did (`ready.lockdown`), as last reported. */
export type AgentLockdown = Extract<RuntimeToMainMessage, { type: 'ready' }>['lockdown'];

export type AgentChatEvent = Extract<RuntimeToMainMessage, { type: 'chat.delta' | 'chat.tool-call' | 'chat.step' | 'chat.finish' | 'chat.error' }>;
export type AgentToolInvoke = Extract<RuntimeToMainMessage, { type: 'tool.invoke' }>;
export type AgentFetchEvent = Extract<RuntimeToMainMessage, { type: 'fetch.request' | 'fetch.abort' }>;

export interface AgentHostStats {
  /** Inbound messages dropped: invalid, before `ready`, a second `ready`, or for a chat main didn't start. */
  inboundDropped: number;
  /** Model requests refused here: no turn running, or past the running turns' budget. */
  fetchesRefused: number;
  /** Strikes counted (dropped messages, refusals here and the proxy's). */
  strikes: number;
  /** Outbound messages refused: invalid, or sent while not `ready`. */
  outboundRefused: number;
  /** Forks after the first. */
  restarts: number;
  /** Listener exceptions (a main bug; the message is not logged). */
  listenerErrors: number;
}

/** The message main gives a chat that was running when the runtime went away. */
export const AGENT_CRASHED_MESSAGE = 'The agent stopped unexpectedly. Send your message again to retry.';

export interface AgentHost {
  /** Forks the runtime if needed and waits for `ready`: `true` once ready, `false` if it failed or was stopped. */
  start(): Promise<boolean>;
  /** Posts `message` if the runtime is ready and it satisfies `MainToRuntimeMessageSchema`; `false` otherwise. */
  send(message: MainToRuntimeMessage): boolean;
  /** Chat events for chats main started (`chat.delta`, `chat.tool-call`, `chat.step`, `chat.finish`, `chat.error`). */
  onChat(listener: (event: AgentChatEvent) => void): () => void;
  /** Tool calls the runtime asks main to run (for chats main started). */
  onToolInvoke(listener: (invoke: AgentToolInvoke) => void): () => void;
  /**
   * Proxied model requests and their aborts (the model proxy). A request reaches it only while a
   * chat main started is running and within the running turns' budget (`MAX_MODEL_REQUESTS_PER_TURN`
   * each); the host refuses any other (`fetch.error` `refused`).
   */
  onFetch(listener: (event: AgentFetchEvent) => void): () => void;
  /**
   * Counts one misbehaviour against the running runtime (the proxy calls it for each refusal; the
   * host for each message it drops). Past `maxStrikesPerWindow` in a window, the runtime is killed
   * and another started.
   */
  strike(): void;
  onStatus(listener: (status: AgentHostStatus) => void): () => void;
  status(): AgentHostStatus;
  /** Why the runtime last failed (cleared once it is ready again). */
  lastFailure(): AgentHostFailure | null;
  /** The running (or last) runtime's lockdown report; `null` before the first `ready`. */
  lockdown(): AgentLockdown | null;
  /** Chat ids with a turn running (started, not yet finished or failed). */
  activeChats(): readonly string[];
  stats(): Readonly<AgentHostStats>;
  /** Stops the runtime for good (app quit): no restart; `start()` answers `false` from then on. */
  dispose(): void;
}

const FAILURE_TEXT: Readonly<Record<AgentHostFailure, string>> = {
  exited: 'exited',
  'ready-timeout': 'did not start in time',
  'fork-failed': 'could not be started',
  'protocol-mismatch': 'speaks another protocol version',
  misbehaved: 'sent too many invalid or refused messages; restarting it',
};

type Listener<T> = (value: T) => void;

function listenerSet<T>(onError: () => void) {
  const listeners = new Set<Listener<T>>();
  return {
    add(listener: Listener<T>) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch {
          onError();
        }
      }
    },
  };
}

/** One forked runtime: its process, its port, and whether the host still owns it. */
interface Instance {
  readonly child: HostChild;
  readonly port: HostPort;
  ready: boolean;
  readyAt: number;
  readyTimer: unknown;
  /** Set once the host gave up on it (killed, disposed): its later events are ignored. */
  abandoned: boolean;
}

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const logOnce = coalescedLog(log, AGENT_PROXY_LIMITS.logWindowMs, now);
  const stats: AgentHostStats = { inboundDropped: 0, fetchesRefused: 0, strikes: 0, outboundRefused: 0, restarts: 0, listenerErrors: 0 };
  const countListenerError = () => {
    stats.listenerErrors += 1;
  };
  const chat = listenerSet<AgentChatEvent>(countListenerError);
  const tools = listenerSet<AgentToolInvoke>(countListenerError);
  const fetches = listenerSet<AgentFetchEvent>(countListenerError);
  const statuses = listenerSet<AgentHostStatus>(countListenerError);

  let status: AgentHostStatus = 'stopped';
  let failure: AgentHostFailure | null = null;
  let lockdown: AgentLockdown | null = null;
  let current: Instance | null = null;
  let disposed = false;
  let forks = 0;
  let consecutiveFailures = 0;
  let restartTimer: unknown = null;
  const pendingChats = new Set<string>();
  /** Model requests the running turns may still make. */
  let fetchBudget = 0;
  /** The current flood window: when it started, and what it has counted. */
  let flood = { start: 0, strikes: 0, inbound: 0 };
  let waiters: ((ready: boolean) => void)[] = [];

  const setStatus = (next: AgentHostStatus) => {
    if (status === next) return;
    status = next;
    statuses.emit(next);
  };

  const settleWaiters = (ready: boolean) => {
    const settled = waiters;
    waiters = [];
    for (const resolve of settled) resolve(ready);
  };

  /** A chat ended: with none left, no model request is wanted any more. */
  const endChat = (chatId: string) => {
    pendingChats.delete(chatId);
    if (pendingChats.size === 0) fetchBudget = 0;
  };

  /** Fails every running chat (the runtime that ran them is gone). */
  const failPendingChats = () => {
    const chatIds = [...pendingChats];
    pendingChats.clear();
    fetchBudget = 0;
    for (const chatId of chatIds) chat.emit({ type: 'chat.error', chatId, message: AGENT_CRASHED_MESSAGE });
  };

  /** Drops `instance` for good: kills its process and closes its port. */
  const abandon = (instance: Instance) => {
    if (instance.abandoned) return;
    instance.abandoned = true;
    if (instance.readyTimer !== null) clearTimer(instance.readyTimer);
    try {
      instance.port.close();
    } catch {
      // Already closed.
    }
    try {
      instance.child.kill();
    } catch {
      // Already gone.
    }
    if (current === instance) current = null;
  };

  /** The runtime failed (`reason`): fail its chats, then restart after the backoff, or give up. */
  const failed = (instance: Instance, reason: AgentHostFailure) => {
    if (instance.abandoned) return;
    // A runtime that ran well for a while starts the count afresh, unless it was killed for flooding.
    const wasStable = reason !== 'misbehaved' && instance.ready && now() - instance.readyAt >= AGENT_HOST_LIMITS.stableAfterMs;
    abandon(instance);
    failure = reason;
    consecutiveFailures = wasStable ? 1 : consecutiveFailures + 1;
    log(`agent: runtime ${FAILURE_TEXT[reason]}`);
    failPendingChats();
    if (disposed) return;
    if (reason === 'protocol-mismatch') {
      // A different build answered: restarting would fork the same one again.
      setStatus('stopped');
      settleWaiters(false);
      return;
    }
    setStatus('crashed');
    if (consecutiveFailures >= AGENT_HOST_LIMITS.maxConsecutiveFailures) {
      log('agent: runtime failed too often; it will be started again on next use');
      settleWaiters(false);
      return;
    }
    const delay = restartDelayMs(consecutiveFailures);
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (!disposed && current === null) fork();
    }, delay);
  };

  /** Counts the window's events; `false` (and the runtime killed) once it is over a limit. */
  const withinLimits = (instance: Instance, strikes: number, inbound: number): boolean => {
    const at = now();
    if (at - flood.start >= AGENT_HOST_LIMITS.floodWindowMs) flood = { start: at, strikes: 0, inbound: 0 };
    flood.strikes += strikes;
    flood.inbound += inbound;
    stats.strikes += strikes;
    if (flood.strikes <= AGENT_HOST_LIMITS.maxStrikesPerWindow && flood.inbound <= AGENT_HOST_LIMITS.maxInboundPerWindow) return true;
    flood = { start: at, strikes: 0, inbound: 0 };
    failed(instance, 'misbehaved');
    return false;
  };

  /** Drops an inbound message (counted, and a strike). */
  const drop = (instance: Instance) => {
    stats.inboundDropped += 1;
    withinLimits(instance, 1, 0);
  };

  /** Answers a model request the host refuses (no turn running, or the turns' budget spent). */
  const refuseFetch = (instance: Instance, requestId: string, reason: 'no-chat' | 'turn-budget') => {
    stats.fetchesRefused += 1;
    logOnce(`refused:${reason}`, `agent proxy: refused a model request (${reason})`);
    if (!withinLimits(instance, 1, 0)) return;
    try {
      instance.port.postMessage({ type: 'fetch.error', requestId, code: 'refused', message: 'frost refused this model request.' } satisfies MainToRuntimeMessage);
    } catch {
      // The port closed: the exit handler runs.
    }
  };

  const onMessage = (instance: Instance, data: unknown) => {
    if (instance.abandoned) return;
    if (!withinLimits(instance, 0, 1)) return;
    const parsed = RuntimeToMainMessageSchema.safeParse(data);
    if (!parsed.success) {
      drop(instance);
      return;
    }
    const message = parsed.data;
    if (message.type === 'ready') {
      if (instance.ready) {
        drop(instance);
        return;
      }
      if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
        failed(instance, 'protocol-mismatch');
        return;
      }
      instance.ready = true;
      instance.readyAt = now();
      if (instance.readyTimer !== null) clearTimer(instance.readyTimer);
      instance.readyTimer = null;
      lockdown = message.lockdown;
      failure = null;
      setStatus('ready');
      settleWaiters(true);
      return;
    }
    if (!instance.ready) {
      drop(instance);
      return;
    }
    switch (message.type) {
      case 'chat.delta':
      case 'chat.tool-call':
      case 'chat.step':
      case 'chat.finish':
      case 'chat.error':
        if (!pendingChats.has(message.chatId)) {
          drop(instance);
          return;
        }
        if (message.type === 'chat.finish' || message.type === 'chat.error') endChat(message.chatId);
        chat.emit(message);
        return;
      case 'tool.invoke':
        if (!pendingChats.has(message.chatId)) {
          drop(instance);
          return;
        }
        tools.emit(message);
        return;
      case 'fetch.request':
        if (pendingChats.size === 0) {
          refuseFetch(instance, message.requestId, 'no-chat');
          return;
        }
        if (fetchBudget <= 0) {
          refuseFetch(instance, message.requestId, 'turn-budget');
          return;
        }
        fetchBudget -= 1;
        fetches.emit(message);
        return;
      case 'fetch.abort':
        fetches.emit(message);
        return;
    }
  };

  const fork = () => {
    if (disposed) return;
    let instance: Instance;
    try {
      const { port1, port2 } = deps.createChannel();
      const child = deps.fork(path.join(deps.buildDir, AGENT_RUNTIME_FILE), [], {
        serviceName: AGENT_SERVICE_NAME,
        env: { NODE_ENV: deps.nodeEnv ?? 'production' },
        execArgv: ['--permission', `--allow-fs-read=${deps.buildDir}`],
        stdio: deps.packaged ? 'ignore' : 'inherit',
      });
      instance = { child, port: port1, ready: false, readyAt: 0, readyTimer: null, abandoned: false };
      if (forks > 0) stats.restarts += 1;
      forks += 1;
      current = instance;
      setStatus('starting');
      port1.on('message', (event) => onMessage(instance, event.data));
      port1.on('close', () => failed(instance, 'exited'));
      child.on('exit', () => failed(instance, 'exited'));
      port1.start();
      instance.readyTimer = setTimer(() => {
        instance.readyTimer = null;
        if (!instance.ready) failed(instance, 'ready-timeout');
      }, AGENT_HOST_LIMITS.readyTimeoutMs);
      child.postMessage(null, [port2]);
    } catch {
      // `fork` itself threw (a missing bundle): treated like an exit.
      const dead: Instance = {
        child: { postMessage: () => undefined, kill: () => true, on: () => undefined },
        port: { postMessage: () => undefined, on: () => undefined, start: () => undefined, close: () => undefined },
        ready: false,
        readyAt: 0,
        readyTimer: null,
        abandoned: false,
      };
      current = dead;
      failed(dead, 'fork-failed');
    }
  };

  return {
    start() {
      if (disposed) return Promise.resolve(false);
      if (status === 'ready') return Promise.resolve(true);
      const ready = new Promise<boolean>((resolve) => waiters.push(resolve));
      if (current === null && restartTimer === null) {
        // First use, or the host gave up after too many failures: start afresh.
        consecutiveFailures = 0;
        fork();
      }
      return ready;
    },
    send(message) {
      const parsed = MainToRuntimeMessageSchema.safeParse(message);
      if (!parsed.success || status !== 'ready' || current === null || !current.ready) {
        stats.outboundRefused += 1;
        return false;
      }
      if (parsed.data.type === 'chat.start') {
        if (pendingChats.has(parsed.data.chatId)) {
          // The runtime would answer "busy"; main keeps one turn per chat too.
          stats.outboundRefused += 1;
          return false;
        }
        pendingChats.add(parsed.data.chatId);
        fetchBudget += MAX_MODEL_REQUESTS_PER_TURN;
      }
      try {
        current.port.postMessage(parsed.data);
      } catch {
        if (parsed.data.type === 'chat.start') {
          fetchBudget = Math.max(0, fetchBudget - MAX_MODEL_REQUESTS_PER_TURN);
          endChat(parsed.data.chatId);
        }
        stats.outboundRefused += 1;
        return false;
      }
      return true;
    },
    onChat: (listener) => chat.add(listener),
    onToolInvoke: (listener) => tools.add(listener),
    onFetch: (listener) => fetches.add(listener),
    onStatus: (listener) => statuses.add(listener),
    strike() {
      if (current !== null && !current.abandoned) withinLimits(current, 1, 0);
    },
    status: () => status,
    lastFailure: () => failure,
    lockdown: () => (lockdown === null ? null : { removed: [...lockdown.removed], failed: [...lockdown.failed], permissionModel: lockdown.permissionModel }),
    activeChats: () => [...pendingChats],
    stats: () => ({ ...stats }),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (restartTimer !== null) clearTimer(restartTimer);
      restartTimer = null;
      if (current !== null) abandon(current);
      pendingChats.clear();
      fetchBudget = 0;
      setStatus('stopped');
      settleWaiters(false);
    },
  };
}
