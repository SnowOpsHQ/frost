// The runtime's one MessagePort to main (Phase 5 Task 2; acceptance `specs/agent-runtime.feature.md`,
// Transport). Every inbound message is parsed with `MainToRuntimeMessageSchema` and dropped when it
// fails (counted, never echoed, never logged); every outbound message is parsed with
// `RuntimeToMainMessageSchema` before it is posted, in every build: the check costs little next to
// a model's latency, and main never sees a malformed message from a bug here.
import {
  MainToRuntimeMessageSchema,
  RuntimeToMainMessageSchema,
  type MainToRuntimeMessage,
  type RuntimeToMainMessage,
} from '@app/specs/agent-protocol.schema';

/** A raw message port: what the runtime needs from Electron's `MessagePortMain` (or a test pair). */
export interface RuntimePort {
  post(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
  /** Called once when the other side goes away (optional: a test pair never closes). */
  onClose?(listener: () => void): void;
}

export interface ChannelStats {
  /** Inbound messages that failed `MainToRuntimeMessageSchema`. */
  inboundDropped: number;
  /** Outbound messages that failed `RuntimeToMainMessageSchema` (a runtime bug). */
  outboundDropped: number;
}

/** A validated channel over a `RuntimePort`. */
export interface Channel {
  /** Posts `message` if it satisfies `RuntimeToMainMessageSchema`; `false` (and counted) if not. */
  send(message: RuntimeToMainMessage): boolean;
  onMessage(listener: (message: MainToRuntimeMessage) => void): void;
  readonly stats: Readonly<ChannelStats>;
}

export function createChannel(port: RuntimePort): Channel {
  const stats: ChannelStats = { inboundDropped: 0, outboundDropped: 0 };
  const listeners: ((message: MainToRuntimeMessage) => void)[] = [];
  port.onMessage((data) => {
    const parsed = MainToRuntimeMessageSchema.safeParse(data);
    if (!parsed.success) {
      stats.inboundDropped += 1;
      return;
    }
    for (const listener of listeners) listener(parsed.data);
  });
  return {
    send(message) {
      const parsed = RuntimeToMainMessageSchema.safeParse(message);
      if (!parsed.success) {
        stats.outboundDropped += 1;
        return false;
      }
      port.post(parsed.data);
      return true;
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    stats,
  };
}

/**
 * Two connected in-memory ports (tests): a post on one arrives at the other's listeners on a later
 * microtask, as a structured clone, like a real MessagePort.
 */
export function createMemoryPortPair(): [RuntimePort, RuntimePort] {
  const listeners: [((data: unknown) => void)[], ((data: unknown) => void)[]] = [[], []];
  const end = (self: 0 | 1): RuntimePort => ({
    post(message) {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[self === 0 ? 1 : 0]) listener(copy);
      });
    },
    onMessage(listener) {
      listeners[self].push(listener);
    },
  });
  return [end(0), end(1)];
}

// ---- Electron's utility process --------------------------------------------------------------

/** The part of Electron's `MessagePortMain` the runtime uses. */
export interface MessagePortMainLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
}

/** The part of Electron's `process.parentPort` (a utility process's) the runtime uses. */
export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown; ports: readonly MessagePortMainLike[] }) => void): unknown;
  off(event: 'message', listener: (event: { data: unknown; ports: readonly MessagePortMainLike[] }) => void): unknown;
}

/** Wraps a `MessagePortMain` as a `RuntimePort` and starts it. */
export function wrapMessagePortMain(port: MessagePortMainLike): RuntimePort {
  const wrapped: RuntimePort = {
    post(message) {
      port.postMessage(message);
    },
    onMessage(listener) {
      port.on('message', (event) => listener(event.data));
    },
    onClose(listener) {
      port.on('close', listener);
    },
  };
  return wrapped;
}

/**
 * Waits for main to transfer the runtime its port: the first `parentPort` message carrying one
 * (`child.postMessage(null, [port])` in main). Later parent messages are ignored. The port is
 * started after the caller attaches its listeners (`start` on the answer).
 */
export function bindParentPort(parentPort: ParentPortLike | undefined = (process as unknown as { parentPort?: ParentPortLike }).parentPort): Promise<RuntimePort & { start(): void }> {
  if (parentPort === undefined) return Promise.reject(new Error('not running in a utility process'));
  return new Promise((resolve) => {
    const listener = (event: { data: unknown; ports: readonly MessagePortMainLike[] }) => {
      const port = event.ports[0];
      if (port === undefined) return;
      parentPort.off('message', listener);
      resolve({ ...wrapMessagePortMain(port), start: () => port.start() });
    };
    parentPort.on('message', listener);
  });
}
