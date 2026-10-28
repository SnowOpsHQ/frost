// The agent runtime (Phase 5 Task 2; acceptance `specs/agent-runtime.feature.md`, Runtime): routes
// main's messages to the chat turns and the proxied fetch, one turn at a time per chat id.
import { AGENT_PROTOCOL_VERSION, type ToolResult } from '@app/specs/agent-protocol.schema';
import { runChat, chatErrorMessage, type ChatRun, type ChatStart } from './chat';
import { createModel, type ModelFactory } from './provider';
import { createProxyFetch, type ProxyFetch } from './proxy-fetch';
import { createChannel, type Channel, type ChannelStats, type RuntimePort } from './transport';

export interface RuntimeOptions {
  /** Builds each turn's model (default `createModel`; Task 6's e2e seam injects a scripted one). */
  readonly modelFactory?: ModelFactory;
  /** Ids for proxied requests (default `crypto.randomUUID`). */
  readonly newRequestId?: () => string;
}

export interface RuntimeStats extends ChannelStats {
  /** `chat.start`s dropped because that chat id already had a turn running. */
  startsDropped: number;
  /** `tool.result`s that matched no waiting call (late, repeated or for another chat). */
  toolResultsUnmatched: number;
}

export interface Runtime {
  readonly stats: Readonly<RuntimeStats>;
  /** Chat ids with a turn running. */
  readonly activeChats: readonly string[];
  /** Settles when the running turn of `chatId` (if any) has posted its end. */
  whenIdle(chatId: string): Promise<void>;
}

interface Turn {
  readonly controller: AbortController;
  run: ChatRun | null;
  readonly done: Promise<void>;
}

/**
 * Starts the runtime on `port`: posts `ready` (with `AGENT_PROTOCOL_VERSION`) and answers main's
 * messages from then on. Call it after `lockdownNetworkGlobals()`.
 */
export function startRuntime(port: RuntimePort, options: RuntimeOptions = {}): Runtime {
  const modelFactory = options.modelFactory ?? createModel;
  const channel: Channel = createChannel(port);
  const post = channel.send.bind(channel);
  const proxy: ProxyFetch = createProxyFetch(post, options.newRequestId);
  const turns = new Map<string, Turn>();
  const counts = { startsDropped: 0, toolResultsUnmatched: 0 };

  const startTurn = (start: ChatStart) => {
    if (turns.has(start.chatId)) {
      counts.startsDropped += 1;
      return;
    }
    const controller = new AbortController();
    let resolveDone!: () => void;
    const turn: Turn = { controller, run: null, done: new Promise<void>((resolve) => (resolveDone = resolve)) };
    turns.set(start.chatId, turn);
    const end = () => {
      turns.delete(start.chatId);
      resolveDone();
    };
    try {
      const model = modelFactory(start.route, start.modelId, proxy.fetch);
      turn.run = runChat({ start, model, post, signal: controller.signal });
      void turn.run.done.then(end);
    } catch (error) {
      post({ type: 'chat.error', chatId: start.chatId, message: chatErrorMessage(error) });
      end();
    }
  };

  const deliver = (chatId: string, callId: string, result: ToolResult) => {
    if (!turns.get(chatId)?.run?.deliverToolResult(callId, result)) counts.toolResultsUnmatched += 1;
  };

  channel.onMessage((message) => {
    switch (message.type) {
      case 'chat.start':
        startTurn(message);
        return;
      case 'chat.stop':
        turns.get(message.chatId)?.controller.abort();
        return;
      case 'tool.result':
        deliver(message.chatId, message.callId, message.result);
        return;
      case 'fetch.response-start':
      case 'fetch.chunk':
      case 'fetch.end':
      case 'fetch.error':
        proxy.handle(message);
        return;
    }
  });

  post({ type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION });

  return {
    get stats() {
      return { ...channel.stats, ...counts };
    },
    get activeChats() {
      return [...turns.keys()];
    },
    whenIdle: (chatId) => turns.get(chatId)?.done ?? Promise.resolve(),
  };
}
