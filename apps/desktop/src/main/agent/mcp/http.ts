import { MCP_LIMITS, type McpErrorCode } from '@app/specs/agent-mcp.spec';
import { isIpLiteral, isPrivateAddress } from '@app/specs/private-address.spec';
import { McpFailure, type JsonRpcOutgoing, type McpTransport } from './client';

// The Streamable HTTP transport (Phase 5 Task 10; acceptance `specs/agent-mcp.feature.md`, HTTP
// servers): each message is one `POST` to the server's URL, answered with JSON, an event stream or
// nothing (202). Requests go out on main's in-memory `agent-mcp` session (`session.fetch`), with no
// cookies (`credentials: 'omit'`), no cache and **no redirects** (`redirect: 'error'`: a redirect
// fails the request, so nothing is ever sent to another origin, nor the token). Before each request
// the host is resolved with the session's own resolver and refused if any address is private (the
// URL's host was already checked to be public; this catches a name pointing inward). A reply's
// body is read within `MCP_LIMITS.maxMessageBytes`; past it the request fails `too-large`. The
// optional bearer token is read from main's credential store for each request and never kept.
//
// Not used: the server-to-client `GET` stream (frost asks, the server answers; nothing it pushes on
// its own is acted on). The session id the server assigns (`Mcp-Session-Id`) is sent back, and the
// session is ended with a `DELETE` on close (best effort).

/** `session.fetch`'s init as used here. */
export interface McpFetchInit {
  readonly method: 'POST' | 'DELETE';
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect: 'error';
  readonly credentials: 'omit';
  readonly cache: 'no-store';
  readonly signal: AbortSignal;
}

export interface HttpTransportDeps {
  /** The server's URL (`parseMcpServerUrl` accepted it). */
  readonly url: string;
  /** The `agent-mcp` session's `fetch`. */
  readonly fetch: (url: string, init: McpFetchInit) => Promise<Response>;
  /** The session's resolver: every address of `host`. */
  readonly resolveHost: (host: string) => Promise<readonly string[]>;
  /** The server's bearer token, read for this request (`null`: none). */
  readonly token: () => Promise<string | null>;
}

const SESSION_ID = /^[\x21-\x7e]{1,256}$/;

/** A reader whose `read()` ends (rejects `timeout`) as soon as `signal` aborts, cancelling the body. */
function abortable(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (signal.aborted) throw new McpFailure('timeout');
      const next = await reader.read();
      if (signal.aborted) throw new McpFailure('timeout');
      return next;
    },
    async release() {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
    },
  };
}

/** Reads `body` to its end within `max` bytes; `null` when it is longer. Stops when `signal` aborts. */
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = abortable(body, signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    await reader.release();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The longest event-stream line (characters) and the most lines of one stream (keep-alives included). */
export const SSE_MAX_LINE_CHARS = 1024 * 1024;
export const SSE_MAX_LINES = 100_000;

/**
 * Reads an event stream within `max` bytes, handing each `message` event's JSON data to `deliver`
 * until `done()` holds (the reply frost waits for has come), then stops reading. Linear in the
 * stream's length (Task 10 review): each chunk is scanned once for line breaks from where the last
 * scan stopped; a line over `SSE_MAX_LINE_CHARS`, an event's data over `max`, or more than
 * `SSE_MAX_LINES` lines (a stream of keep-alives) fails `too-large`; `signal` (the request's
 * deadline or Stop) ends it at once.
 */
async function readEvents(body: ReadableStream<Uint8Array>, max: number, deliver: (value: unknown) => void, done: () => boolean, signal: AbortSignal): Promise<void> {
  const reader = abortable(body, signal);
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let pending = '';
  let scanned = 0;
  let lines = 0;
  let data: string[] = [];
  let dataChars = 0;
  let event = '';
  const dispatch = () => {
    if (data.length > 0 && (event === '' || event === 'message')) {
      try {
        deliver(JSON.parse(data.join('\n')));
      } catch {
        // Not JSON: skipped.
      }
    }
    data = [];
    dataChars = 0;
    event = '';
  };
  const handle = (line: string) => {
    if ((lines += 1) > SSE_MAX_LINES) throw new McpFailure('too-large');
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let text = colon === -1 ? '' : line.slice(colon + 1);
    if (text.startsWith(' ')) text = text.slice(1);
    if (field === 'data') {
      if ((dataChars += text.length + 1) > max) throw new McpFailure('too-large');
      data.push(text);
    } else if (field === 'event') event = text.slice(0, 64);
  };
  try {
    while (!done()) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      total += value.byteLength;
      if (total > max) throw new McpFailure('too-large');
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      // Only the new text is scanned (a `\r` just before it may start a `\r\n`).
      for (let index = Math.max(scanned - 1, 0); index < pending.length && !done(); index += 1) {
        const code = pending.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;
        if (code === 13 && index === pending.length - 1) break;
        handle(pending.slice(start, index));
        start = index + (code === 13 && pending.charCodeAt(index + 1) === 10 ? 2 : 1);
        index = start - 1;
      }
      pending = pending.slice(start);
      scanned = pending.length;
      if (pending.length > SSE_MAX_LINE_CHARS) throw new McpFailure('too-large');
    }
    if (!done()) dispatch();
  } finally {
    await reader.release();
  }
}

const mediaType = (value: string | null) => (value ?? '').split(';')[0]!.trim().toLowerCase();

export function createHttpTransport(deps: HttpTransportDeps): McpTransport {
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((code: McpErrorCode) => void)[] = [];
  const host = new URL(deps.url).hostname;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let closed = false;

  const deliver = (value: unknown) => {
    for (const item of Array.isArray(value) ? value.slice(0, 64) : [value]) for (const listener of messageListeners) listener(item);
  };

  /** Refuses a host that resolves to any private address (and one that doesn't resolve). */
  const checkHost = async () => {
    if (isIpLiteral(host)) return;
    let addresses: readonly string[];
    try {
      addresses = await deps.resolveHost(host);
    } catch {
      throw new McpFailure('network');
    }
    if (addresses.length === 0) throw new McpFailure('network');
    if (addresses.some(isPrivateAddress)) throw new McpFailure('private-address');
  };

  const headers = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (protocolVersion !== null) out['mcp-protocol-version'] = protocolVersion;
    if (sessionId !== null) out['mcp-session-id'] = sessionId;
    let token: string | null;
    try {
      token = await deps.token();
    } catch {
      throw new McpFailure('secrets-failed');
    }
    if (token !== null) out['authorization'] = `Bearer ${token}`;
    return out;
  };

  const request = async (init: Omit<McpFetchInit, 'redirect' | 'credentials' | 'cache' | 'headers'>, extra: Record<string, string> = {}): Promise<Response> => {
    await checkHost();
    try {
      return await deps.fetch(deps.url, { ...init, headers: { ...(await headers()), ...extra }, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      if (error instanceof McpFailure) throw error;
      if (init.signal.aborted) throw new McpFailure('timeout');
      throw new McpFailure(/redirect/i.test(String((error as { message?: unknown } | null)?.message ?? '')) ? 'redirect' : 'network');
    }
  };

  return {
    async send(message: JsonRpcOutgoing, signal: AbortSignal) {
      if (closed) throw new McpFailure('exited');
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body, 'utf8') > MCP_LIMITS.maxMessageBytes) throw new McpFailure('too-large');
      const response = await request({ method: 'POST', body, signal });
      if (response.status >= 300 && response.status < 400) throw new McpFailure('redirect', response.status);
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpFailure('unauthorized', response.status);
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpFailure('http-status', response.status);
      }
      const assigned = response.headers.get('mcp-session-id');
      if (assigned !== null && SESSION_ID.test(assigned) && 'method' in message && message.method === 'initialize') sessionId = assigned;
      if (response.status === 202 || !('id' in message) || !('method' in message)) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const type = mediaType(response.headers.get('content-type'));
      if (type === 'text/event-stream') {
        if (response.body === null) throw new McpFailure('protocol');
        let answered = false;
        await readEvents(
          response.body,
          MCP_LIMITS.maxMessageBytes,
          (value) => {
            const items = Array.isArray(value) ? value : [value];
            if (items.some((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === message.id && !('method' in item))) answered = true;
            deliver(value);
          },
          () => answered,
          signal,
        );
        return;
      }
      if (type !== 'application/json') {
        await response.body?.cancel().catch(() => undefined);
        throw new McpFailure('protocol');
      }
      const bytes = await readBounded(response.body, MCP_LIMITS.maxMessageBytes, signal);
      if (bytes === null) throw new McpFailure('too-large');
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      } catch {
        throw new McpFailure('protocol');
      }
      deliver(value);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    setProtocolVersion(version) {
      protocolVersion = version;
    },
    // Over HTTP frost answers no server request at all: each answer would be a `POST` (Task 10 review).
    answersServerRequests: false,
    async close(code: McpErrorCode = 'exited') {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener(code);
      if (sessionId === null) return;
      // Ends the server's session (best effort, briefly).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await request({ method: 'DELETE', signal: controller.signal });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // The server may not support it, or is gone.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
