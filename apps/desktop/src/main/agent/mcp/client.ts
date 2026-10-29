import { MCP_ACCEPTED_PROTOCOL_VERSIONS, MCP_CLIENT_INFO, MCP_LIMITS, MCP_PROTOCOL_VERSION, type McpErrorCode } from '@app/specs/agent-mcp.spec';

// frost's MCP client (Phase 5 Task 10; spec `specs/agent-mcp.spec.ts`; acceptance
// `specs/agent-mcp.feature.md`, Client): the three requests frost makes of a server (`initialize`,
// `tools/list`, `tools/call`) over JSON-RPC 2.0, on a transport (`stdio.ts`, `http.ts`) that moves
// one message at a time within `MCP_LIMITS.maxMessageBytes`.
//
// Why not the official SDK's client: its `Client` statically pulls Ajv (and compiles each server's
// output schema with generated code, in main), Zod 3 beside Zod 4, an OAuth client and PKCE helper,
// and `cross-spawn`, which on Windows runs a non-`.exe` command through `cmd.exe` (a shell). frost
// needs none of that, and bounding what a hostile server sends meant replacing both transports
// anyway; what is left (ids, a handshake, three methods) is small enough to own and test here.
//
// The client declares no capabilities (no sampling, roots or elicitation), so a server has nothing
// to ask it (Task 10 review): over stdio only `ping` is answered, at most `maxPingRepliesPerSecond`;
// every other server request gets no answer at all, and over HTTP none does (an answer would be a
// `POST` each). Notifications are ignored. Whatever a server sends on its own (requests,
// notifications, answers to nothing frost asked) is budgeted per connection,
// `maxServerMessagesPerSecond` and `maxServerMessagesPerCall` while a request is open: past either,
// the connection is closed (`flood`). Every request has a timeout and the caller's abort signal; both
// abort the transport's own work for it (an HTTP request, an event stream), not just the wait.

/** A JSON-RPC message as frost sends it. */
export type JsonRpcOutgoing =
  | { readonly jsonrpc: '2.0'; readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }
  | { readonly jsonrpc: '2.0'; readonly method: string; readonly params?: Record<string, unknown> }
  | { readonly jsonrpc: '2.0'; readonly id: number | string; readonly result: Record<string, unknown> }
  | { readonly jsonrpc: '2.0'; readonly id: number | string; readonly error: { readonly code: number; readonly message: string } };

/** A failure the settings can name (`MCP_ERRORS`), with an HTTP status where one applies. */
export class McpFailure extends Error {
  constructor(
    readonly code: McpErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

/** A JSON-RPC error answer from the server (its message is untrusted text). */
export class McpRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    readonly rpcMessage: string,
  ) {
    super('rpc-error');
  }
}

/**
 * Moves messages to and from a server. `send` resolves once the message is handed on (for HTTP,
 * once the reply messages, if any, were delivered through `onMessage`); it rejects with a
 * `McpFailure`. `onClose` fires once, when the connection ends for good.
 */
export interface McpTransport {
  send(message: JsonRpcOutgoing, signal: AbortSignal): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: (code: McpErrorCode) => void): void;
  /** Tells the transport the negotiated protocol revision (HTTP sends it as a header). */
  setProtocolVersion?(version: string): void;
  /** `false`: never answer a server's request (HTTP: each answer would be a request of its own). Default `true` (only `ping`). */
  readonly answersServerRequests?: boolean;
  /** Ends the connection for good; `onClose` hears `code` (default `exited`). */
  close(code?: McpErrorCode): Promise<void>;
}

/** A tool as the server listed it (untrusted, unchecked beyond its shape). */
export interface ListedTool {
  readonly name: unknown;
  readonly description: unknown;
  readonly inputSchema: unknown;
}

export interface McpClient {
  /** `initialize`, then `notifications/initialized`. Whether the server offers tools. */
  initialize(signal: AbortSignal): Promise<{ readonly tools: boolean }>;
  /** `tools/list`, following cursors (at most `maxToolListPages` pages, 1024 tools). */
  listTools(signal: AbortSignal): Promise<ListedTool[]>;
  /** `tools/call` with `name` and `args`: the result object, or a `McpRpcError` / `McpFailure`. */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** Fails every request in flight and closes the transport. */
  close(): Promise<void>;
}

export interface McpClientOptions {
  /** Per request (default `MCP_LIMITS.callTimeoutMs`). */
  readonly timeoutMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Milliseconds clock for the budgets (default `Date.now`). */
  readonly now?: () => number;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The pages of `tools/list` frost reads, and the tools it looks at in all. */
const MAX_LISTED = 1024;

export function createMcpClient(transport: McpTransport, options: McpClientOptions = {}): McpClient {
  const timeoutMs = options.timeoutMs ?? MCP_LIMITS.callTimeoutMs;
  const setTimer = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; noise: number }>();
  let nextId = 1;
  let closed: McpErrorCode | null = null;
  const answersServerRequests = transport.answersServerRequests !== false;
  // The budgets: what the server sent on its own this second, and `ping`s answered this second.
  let windowStart = now();
  let windowCount = 0;
  let pings = 0;
  /** Aborted when the connection ends (closed, flooded, or `close()`): best-effort sends stop with it. */
  const connection = new AbortController();
  let notifying = 0;

  /**
   * Sends a message frost doesn't wait on (a cancellation, a `ping`'s reply), aborted after
   * `notificationTimeoutMs` or when the connection ends. Cancellations past
   * `maxOutstandingNotifications` in flight are skipped (`ping` replies have their own budget,
   * `maxPingRepliesPerSecond`, and go over stdio only). Never rejects.
   */
  const notify = (message: JsonRpcOutgoing, capped: boolean) => {
    if (closed !== null || (capped && notifying >= MCP_LIMITS.maxOutstandingNotifications)) return;
    const counted = capped ? 1 : 0;
    notifying += counted;
    const deadline = new AbortController();
    const timer = setTimer(() => deadline.abort(), MCP_LIMITS.notificationTimeoutMs);
    void transport
      .send(message, AbortSignal.any([connection.signal, deadline.signal]))
      .catch(() => undefined)
      .finally(() => {
        clearTimer(timer);
        notifying -= counted;
      });
  };

  const failAll = (code: McpErrorCode) => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      entry.reject(new McpFailure(code));
    }
  };

  transport.onClose((code) => {
    if (closed === null) closed = code;
    failAll(code);
    connection.abort();
  });

  const flood = () => {
    if (closed !== null) return;
    closed = 'flood';
    failAll('flood');
    connection.abort();
    void transport.close('flood').catch(() => undefined);
  };

  /** Counts one message the server sent on its own; `false` (and the connection closed) past a budget. */
  const spend = (): boolean => {
    const at = now();
    if (at - windowStart >= 1000 || at < windowStart) {
      windowStart = at;
      windowCount = 0;
      pings = 0;
    }
    windowCount += 1;
    let over = windowCount > MCP_LIMITS.maxServerMessagesPerSecond;
    for (const entry of pending.values()) if ((entry.noise += 1) > MCP_LIMITS.maxServerMessagesPerCall) over = true;
    if (over) flood();
    return !over;
  };

  transport.onMessage((message) => {
    if (closed !== null) return;
    const id = isObject(message) ? message['id'] : undefined;
    const entry = isObject(message) && message['jsonrpc'] === '2.0' && typeof message['method'] !== 'string' && typeof id === 'number' ? pending.get(id) : undefined;
    // Anything but an answer to an open request of frost's comes out of the budget.
    if (entry === undefined) {
      if (!spend()) return;
      if (!isObject(message) || message['jsonrpc'] !== '2.0') return;
      // The one request answered: `ping`, over stdio, a few a second. Every other one goes unanswered.
      if (message['method'] === 'ping' && answersServerRequests && (typeof id === 'number' || (typeof id === 'string' && id.length <= 256)) && pings < MCP_LIMITS.maxPingRepliesPerSecond) {
        pings += 1;
        notify({ jsonrpc: '2.0', id, result: {} }, false);
      }
      return;
    }
    pending.delete(id as number);
    const answer = message as Record<string, unknown>;
    if (Object.hasOwn(answer, 'error')) {
      const error = answer['error'];
      const code = isObject(error) && typeof error['code'] === 'number' && Number.isInteger(error['code']) ? error['code'] : -32603;
      const text = isObject(error) && typeof error['message'] === 'string' ? error['message'].slice(0, 2000) : '';
      entry.reject(new McpRpcError(code, text));
      return;
    }
    const result = answer['result'];
    if (!isObject(result)) {
      entry.reject(new McpFailure('protocol'));
      return;
    }
    entry.resolve(result);
  });

  const request = (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (closed !== null) return Promise.reject(new McpFailure(closed));
    if (signal.aborted) return Promise.reject(new McpFailure('timeout'));
    const id = nextId;
    nextId += 1;
    // Aborted by the deadline, the caller's signal or the connection closing: the transport's own
    // work for this request (an HTTP request, an event stream) stops too, not just the wait.
    const own = new AbortController();
    const sendSignal = AbortSignal.any([signal, own.signal]);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        clearTimer(timer);
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
      };
      const fail = (error: Error) => {
        if (done) return;
        finish();
        own.abort();
        reject(error);
      };
      const onAbort = () => {
        if (done) return;
        // The server may go on; frost tells it the request is cancelled (best effort).
        notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }, true);
        fail(new McpFailure('timeout'));
      };
      const timer = setTimer(onAbort, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        noise: 0,
        resolve: (value) => {
          if (done) return;
          finish();
          resolve(value);
        },
        reject: (error) => fail(error),
      });
      transport.send({ jsonrpc: '2.0', id, method, params }, sendSignal).catch((error: unknown) => fail(error instanceof McpFailure ? error : new McpFailure('network')));
    });
  };

  return {
    async initialize(signal) {
      const result = await request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: MCP_CLIENT_INFO.name, version: MCP_CLIENT_INFO.version } },
        signal,
      );
      const version = result['protocolVersion'];
      if (typeof version !== 'string' || !(MCP_ACCEPTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) throw new McpFailure('protocol');
      transport.setProtocolVersion?.(version);
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
      const capabilities = result['capabilities'];
      return { tools: isObject(capabilities) && isObject(capabilities['tools']) };
    },

    async listTools(signal) {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MCP_LIMITS.maxToolListPages; page += 1) {
        const result = await request('tools/list', cursor === undefined ? {} : { cursor }, signal);
        const listed = result['tools'];
        if (!Array.isArray(listed)) throw new McpFailure('protocol');
        for (const tool of listed) {
          if (tools.length >= MAX_LISTED) break;
          if (isObject(tool)) tools.push({ name: tool['name'], description: tool['description'], inputSchema: tool['inputSchema'] });
        }
        const next = result['nextCursor'];
        if (typeof next !== 'string' || next === '' || next.length > 1024 || tools.length >= MAX_LISTED) break;
        cursor = next;
      }
      return tools;
    },

    callTool(name, args, signal) {
      return request('tools/call', { name, arguments: args }, signal);
    },

    async close() {
      if (closed === null) closed = 'exited';
      failAll('exited');
      connection.abort();
      await transport.close().catch(() => undefined);
    },
  };
}
