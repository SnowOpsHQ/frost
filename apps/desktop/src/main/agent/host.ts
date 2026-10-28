import path from 'node:path';
import {
  AGENT_PROTOCOL_VERSION,
  MainToRuntimeMessageSchema,
  RuntimeToMainMessageSchema,
  type MainToRuntimeMessage,
  type RuntimeToMainMessage,
} from '@app/specs/agent-protocol.schema';
import { AGENT_HOST_LIMITS, AGENT_RUNTIME_FILE, AGENT_SERVICE_NAME, restartDelayMs } from '@app/specs/agent-proxy.spec';

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
export type AgentHostFailure = 'exited' | 'ready-timeout' | 'protocol-mismatch' | 'fork-failed';

/** What the runtime's lockdown did (`ready.lockdown`), as last reported. */
export type AgentLockdown = Extract<RuntimeToMainMessage, { type: 'ready' }>['lockdown'];

export type AgentChatEvent = Extract<RuntimeToMainMessage, { type: 'chat.delta' | 'chat.tool-call' | 'chat.step' | 'chat.finish' | 'chat.error' }>;
export type AgentToolInvoke = Extract<RuntimeToMainMessage, { type: 'tool.invoke' }>;
export type AgentFetchEvent = Extract<RuntimeToMainMessage, { type: 'fetch.request' | 'fetch.abort' }>;

export interface AgentHostStats {
  /** Inbound messages dropped: invalid, before `ready`, a second `ready`, or for a chat main didn't start. */
  inboundDropped: number;
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
  /** Proxied model requests and their aborts (the model proxy). */
  onFetch(listener: (event: AgentFetchEvent) => void): () => void;
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
  const stats: AgentHostStats = { inboundDropped: 0, outboundRefused: 0, restarts: 0, listenerErrors: 0 };
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

  /** Fails every running chat (the runtime that ran them is gone). */
  const failPendingChats = () => {
    const chatIds = [...pendingChats];
    pendingChats.clear();
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
    const wasStable = instance.ready && now() - instance.readyAt >= AGENT_HOST_LIMITS.stableAfterMs;
    abandon(instance);
    failure = reason;
    consecutiveFailures = wasStable ? 1 : consecutiveFailures + 1;
    log(`agent: runtime ${reason === 'exited' ? 'exited' : reason === 'ready-timeout' ? 'did not start in time' : reason === 'fork-failed' ? 'could not be started' : 'speaks another protocol version'}`);
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

  const onMessage = (instance: Instance, data: unknown) => {
    if (instance.abandoned) return;
    const parsed = RuntimeToMainMessageSchema.safeParse(data);
    if (!parsed.success) {
      stats.inboundDropped += 1;
      return;
    }
    const message = parsed.data;
    if (message.type === 'ready') {
      if (instance.ready) {
        stats.inboundDropped += 1;
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
      stats.inboundDropped += 1;
      return;
    }
    switch (message.type) {
      case 'chat.delta':
      case 'chat.tool-call':
      case 'chat.step':
      case 'chat.finish':
      case 'chat.error':
        if (!pendingChats.has(message.chatId)) {
          stats.inboundDropped += 1;
          return;
        }
        if (message.type === 'chat.finish' || message.type === 'chat.error') pendingChats.delete(message.chatId);
        chat.emit(message);
        return;
      case 'tool.invoke':
        if (!pendingChats.has(message.chatId)) {
          stats.inboundDropped += 1;
          return;
        }
        tools.emit(message);
        return;
      case 'fetch.request':
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
      }
      try {
        current.port.postMessage(parsed.data);
      } catch {
        if (parsed.data.type === 'chat.start') pendingChats.delete(parsed.data.chatId);
        stats.outboundRefused += 1;
        return false;
      }
      return true;
    },
    onChat: (listener) => chat.add(listener),
    onToolInvoke: (listener) => tools.add(listener),
    onFetch: (listener) => fetches.add(listener),
    onStatus: (listener) => statuses.add(listener),
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
      setStatus('stopped');
      settleWaiters(false);
    },
  };
}
