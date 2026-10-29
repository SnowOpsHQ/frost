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
// The client declares no capabilities (no sampling, roots or elicitation): a server's request to
// it is answered "method not found", except `ping` (answered empty). Notifications from the server
// are ignored. Every request has a timeout and an abort signal; a response is matched by id only.

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
  close(): Promise<void>;
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
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The pages of `tools/list` frost reads, and the tools it looks at in all. */
const MAX_LISTED = 1024;

export function createMcpClient(transport: McpTransport, options: McpClientOptions = {}): McpClient {
  const timeoutMs = options.timeoutMs ?? MCP_LIMITS.callTimeoutMs;
  const setTimer = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let closed: McpErrorCode | null = null;

  const failAll = (code: McpErrorCode) => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      entry.reject(new McpFailure(code));
    }
  };

  transport.onClose((code) => {
    if (closed === null) closed = code;
    failAll(code);
  });

  const reply = (message: JsonRpcOutgoing) => {
    // Answers to the server's own requests: best effort, on a signal of their own.
    void transport.send(message, new AbortController().signal).catch(() => undefined);
  };

  transport.onMessage((message) => {
    if (!isObject(message) || message['jsonrpc'] !== '2.0') return;
    const id = message['id'];
    const method = message['method'];
    if (typeof method === 'string') {
      // A request from the server (it has an id): `ping` is answered, anything else refused.
      if (typeof id === 'number' || typeof id === 'string') {
        if (typeof id === 'string' && id.length > 256) return;
        reply(method === 'ping' ? { jsonrpc: '2.0', id, result: {} } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
      // A notification: nothing frost acts on.
      return;
    }
    if (typeof id !== 'number') return;
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (Object.hasOwn(message, 'error')) {
      const error = message['error'];
      const code = isObject(error) && typeof error['code'] === 'number' && Number.isInteger(error['code']) ? error['code'] : -32603;
      const text = isObject(error) && typeof error['message'] === 'string' ? error['message'].slice(0, 2000) : '';
      entry.reject(new McpRpcError(code, text));
      return;
    }
    const result = message['result'];
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
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        clearTimer(timer);
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
      };
      const onAbort = () => {
        if (done) return;
        finish();
        // The server may go on; frost tells it the request is cancelled (best effort).
        void transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }, new AbortController().signal).catch(() => undefined);
        reject(new McpFailure('timeout'));
      };
      const timer = setTimer(onAbort, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          if (done) return;
          finish();
          resolve(value);
        },
        reject: (error) => {
          if (done) return;
          finish();
          reject(error);
        },
      });
      transport.send({ jsonrpc: '2.0', id, method, params }, signal).catch((error: unknown) => {
        if (done) return;
        finish();
        reject(error instanceof McpFailure ? error : new McpFailure('network'));
      });
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
      await transport.close().catch(() => undefined);
    },
  };
}
