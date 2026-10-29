import { AGENT_PROTOCOL_LIMITS, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import {
  AGENT_PROXY_LIMITS,
  checkModelRequestBody,
  filterRequestHeaders,
  filterResponseHeaders,
  mainRequestHeaders,
  ROUTE_CREDENTIAL_SLOT,
  sanitizeStatusText,
  type ProxyRefusal,
} from '@app/specs/agent-proxy.spec';
import { isAllowedModelRequest, MODEL_REQUESTS, MODEL_ROUTES } from '@app/specs/agent-tools.spec';
import type { CredentialStore } from './credentials';
import type { AgentFetchEvent, AgentHost } from './host';
import { coalescedLog } from './log';
import type { AgentSettings } from './settings';

// Main's model proxy (Phase 5 Task 3, plan decision 5; acceptance `specs/agent-host.feature.md`,
// Model proxy; spec `specs/agent-proxy.spec.ts`). The agent runtime holds no key and has no network:
// its providers' requests arrive here as `fetch.request`. Each is checked against the route main's
// settings name (never one the runtime names): the exact method and canonical URL
// (`isAllowedModelRequest`), the request headers it keeps (an allowlist; credential headers are
// dropped), and the body (`checkModelRequestBody`: the configured model, no server-side tool, MCP
// server, file or stored-state reference; OpenAI `store: false`). Main then adds the real key
// (inside `credentials.withKey`, the only place it is read) and sends the request on an in-memory
// session with no cookies, never following a redirect, under an idle timeout, a total time cap and
// a response size cap, at most `maxConcurrentRequests` at once. The response streams back as
// `fetch.response-start` (allowlisted headers), `fetch.chunk`s and `fetch.end`; an error status's
// body is withheld (it may quote the key, masked, or account details). A refusal answers
// `fetch.error` `refused` with no detail; main logs one line with the reason code, never the URL,
// a header or the body.

/** What the proxy hands `fetch` (Electron's `session.fetch` on the in-memory `agent-model` partition). */
export interface ProxyRequestInit {
  readonly method: 'POST';
  readonly headers: [string, string][];
  readonly body: string;
  /** A redirect rejects the request (Electron 45: "Attempted to redirect, but redirect policy was 'error'"). */
  readonly redirect: 'error';
  /** No cookies sent or stored (verified on Electron 45's `session.fetch`). */
  readonly credentials: 'omit';
  readonly cache: 'no-store';
  readonly signal: AbortSignal;
}

export type ProxyFetchFunction = (url: string, init: ProxyRequestInit) => Promise<Response>;

export interface ModelProxyDeps {
  readonly host: Pick<AgentHost, 'send' | 'onFetch' | 'onStatus' | 'onChat' | 'activeChats' | 'strike'>;
  readonly credentials: Pick<CredentialStore, 'withKey'>;
  readonly settings: Pick<AgentSettings, 'current' | 'load'>;
  readonly fetch: ProxyFetchFunction;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
  /** One line per refusal or failure (the reason code only), at most one per reason per `logWindowMs`. */
  readonly log?: (line: string) => void;
  readonly limits?: Partial<typeof AGENT_PROXY_LIMITS>;
}

export interface ModelProxyState {
  /** Whether the current route had a key at the last request (`unknown` before one). */
  readonly key: 'unknown' | 'set' | 'no-key';
  /** Requests in flight. */
  readonly active: number;
  /** The last refusal's reason (`null`: none yet). */
  readonly lastRefusal: ProxyRefusal | null;
}

export interface ModelProxy {
  state(): ModelProxyState;
  /** Aborts every request in flight without answering (the runtime that asked is gone). */
  abortAll(): void;
  /** Stops listening and aborts everything in flight. */
  dispose(): void;
}

type FetchRequest = Extract<AgentFetchEvent, { type: 'fetch.request' }>;
type FetchErrorCode = Extract<MainToRuntimeMessage, { type: 'fetch.error' }>['code'];

/** Short, fixed texts for `fetch.error` (never a URL, header, body or upstream message). */
const ERROR_TEXT: Readonly<Record<FetchErrorCode, string>> = {
  refused: 'frost refused this model request.',
  network: 'The model request failed.',
  aborted: 'The model request was stopped.',
  timeout: 'The model took too long to answer.',
  'too-large': "The model's answer was too large.",
};

interface Live {
  readonly controller: AbortController;
  settled: boolean;
  idle: unknown;
  total: unknown;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

/** Refusals that are not the runtime's doing (no strike; see `refuse`). */
const NOT_THE_RUNTIMES_FAULT: ReadonlySet<ProxyRefusal> = new Set(['no-key', 'key-unavailable', 'redirect', 'model']);

/** A `fetch` rejection from a redirect (Electron 45's `redirect: 'error'` message), told apart from a network failure. */
const isRedirectError = (error: unknown): boolean => error instanceof Error && /redirect/i.test(error.message);

export function createModelProxy(deps: ModelProxyDeps): ModelProxy {
  const limits = { ...AGENT_PROXY_LIMITS, ...deps.limits };
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = coalescedLog(deps.log ?? (() => undefined), limits.logWindowMs, deps.now);
  const live = new Map<string, Live>();
  // Requests waiting for the settings to load, and the ones of those the runtime aborted meanwhile.
  const starting = new Set<string>();
  const abortedEarly = new Set<string>();
  let key: ModelProxyState['key'] = 'unknown';
  let lastRefusal: ProxyRefusal | null = null;
  let disposed = false;

  const send = (message: MainToRuntimeMessage) => {
    deps.host.send(message);
  };

  /**
   * Refuses a request. A refusal the runtime caused counts against it (a flood restarts it: the
   * host's strike window); one that comes from main's side or upstream does not: no key or one that
   * won't decrypt, a redirect, or a request made for the route or model the user just switched away
   * from (`endpoint` for another route's URL, `model`).
   */
  const refuse = (requestId: string, reason: ProxyRefusal, strike = !NOT_THE_RUNTIMES_FAULT.has(reason)) => {
    lastRefusal = reason;
    log(`refused:${reason}`, `agent proxy: refused a model request (${reason})`);
    if (strike) deps.host.strike();
    send({ type: 'fetch.error', requestId, code: 'refused', message: ERROR_TEXT.refused });
  };

  /** Ends `entry` once: clears its timers, stops its request, and posts `answer` (if any). */
  const finish = (requestId: string, entry: Live, answer: MainToRuntimeMessage | null) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.idle !== null) clearTimer(entry.idle);
    if (entry.total !== null) clearTimer(entry.total);
    if (live.get(requestId) === entry) live.delete(requestId);
    entry.controller.abort();
    void entry.reader?.cancel().catch(() => undefined);
    if (answer !== null) send(answer);
  };

  const fail = (requestId: string, entry: Live, code: FetchErrorCode) => {
    if (!entry.settled && code !== 'aborted') log(`ended:${code}`, `agent proxy: a model request ended (${code})`);
    finish(requestId, entry, { type: 'fetch.error', requestId, code, message: ERROR_TEXT[code] });
  };

  const resetIdle = (requestId: string, entry: Live) => {
    if (entry.idle !== null) clearTimer(entry.idle);
    entry.idle = setTimer(() => fail(requestId, entry, 'timeout'), limits.idleTimeoutMs);
  };

  /** The request body as text, or why it is refused. */
  const bodyText = (body: FetchRequest['body']): string | ProxyRefusal => {
    if (body === null) return 'body-missing';
    let text: string;
    if (typeof body === 'string') text = body;
    else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        return 'body-encoding';
      }
    }
    return Buffer.byteLength(text, 'utf8') > AGENT_PROTOCOL_LIMITS.maxRequestBodyBytes ? 'body-size' : text;
  };

  const stream = async (requestId: string, entry: Live, response: Response) => {
    if (entry.settled) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      fail(requestId, entry, 'network');
      return;
    }
    send({ type: 'fetch.response-start', requestId, status: response.status, statusText: sanitizeStatusText(response.statusText), headers: filterResponseHeaders(response.headers) });
    resetIdle(requestId, entry);
    if (response.status >= 400) {
      // An error body may quote the credential (masked) or account details: the runtime gets the
      // status and the allowlisted headers only (the providers read retries from those).
      log(`status:${response.status}`, `agent proxy: the model service answered ${response.status}`);
      void response.body?.cancel().catch(() => undefined);
      finish(requestId, entry, { type: 'fetch.end', requestId });
      return;
    }
    if (response.body === null) {
      finish(requestId, entry, { type: 'fetch.end', requestId });
      return;
    }
    const reader = response.body.getReader();
    entry.reader = reader;
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (entry.settled) return;
      if (done) break;
      received += value.byteLength;
      if (received > AGENT_PROTOCOL_LIMITS.maxResponseBytes) {
        fail(requestId, entry, 'too-large');
        return;
      }
      for (let at = 0; at < value.byteLength; at += AGENT_PROTOCOL_LIMITS.maxChunkBytes) {
        // A copy, so the message owns exactly its bytes (not the rest of the read's buffer).
        send({ type: 'fetch.chunk', requestId, bytes: value.slice(at, at + AGENT_PROTOCOL_LIMITS.maxChunkBytes) });
      }
      resetIdle(requestId, entry);
    }
    finish(requestId, entry, { type: 'fetch.end', requestId });
  };

  const handleRequest = async (request: FetchRequest) => {
    const { requestId } = request;
    // The route and model are main's (read once loaded); the runtime's say nothing here. Everything
    // from here to the fetch runs in one go, so the cap and the duplicate check can't race.
    starting.add(requestId);
    await deps.settings.load();
    starting.delete(requestId);
    if (abortedEarly.delete(requestId) || disposed) return;
    const prior = live.get(requestId);
    if (prior !== undefined) {
      // Two requests under one id: neither can be answered unambiguously.
      finish(requestId, prior, null);
      refuse(requestId, 'duplicate-id');
      return;
    }
    if (live.size >= limits.maxConcurrentRequests) {
      refuse(requestId, 'busy');
      return;
    }
    const { route, modelId } = deps.settings.current();
    if (!isAllowedModelRequest(route, request.method, request.url)) {
      // Another route's endpoint: the turn began before the user switched routes.
      refuse(requestId, 'endpoint', !MODEL_ROUTES.some((other) => isAllowedModelRequest(other, request.method, request.url)));
      return;
    }
    // The URL sent is the allowlist's own string (equal to the one checked).
    const target = MODEL_REQUESTS[route].find((candidate) => candidate.method === request.method && candidate.url === request.url)!;
    const body = bodyText(request.body);
    if (body === 'body-missing' || body === 'body-encoding' || body === 'body-size') {
      refuse(requestId, body);
      return;
    }
    const headers = filterRequestHeaders(route, request.headers);
    const check = checkModelRequestBody(route, modelId, body, headers);
    if (!check.ok) {
      refuse(requestId, check.reason);
      return;
    }
    // The bytes sent are the object checked (a repeated key in the runtime's text can't differ).
    const checkedBody = check.body;

    const entry: Live = { controller: new AbortController(), settled: false, idle: null, total: null, reader: null };
    live.set(requestId, entry);
    resetIdle(requestId, entry);
    entry.total = setTimer(() => fail(requestId, entry, 'timeout'), limits.maxRequestMs);
    const refuseEntry = (reason: ProxyRefusal) => {
      if (entry.settled) return;
      finish(requestId, entry, null);
      refuse(requestId, reason);
    };

    try {
      const sent = await deps.credentials.withKey(ROUTE_CREDENTIAL_SLOT[route], (secret) =>
        deps.fetch(target.url, {
          method: target.method,
          headers: [...headers, ...mainRequestHeaders(route, secret)],
          body: checkedBody,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: entry.controller.signal,
        }),
      );
      if (!sent.ok) {
        if (sent.reason === 'no-key') key = 'no-key';
        refuseEntry(sent.reason === 'no-key' ? 'no-key' : 'key-unavailable');
        return;
      }
      key = 'set';
      await stream(requestId, entry, sent.value);
    } catch (error) {
      if (entry.settled) return;
      // The error's own text is never passed on or logged: it may quote the request.
      if (isRedirectError(error)) refuseEntry('redirect');
      else fail(requestId, entry, 'network');
    }
  };

  const onFetch = (event: AgentFetchEvent) => {
    if (event.type === 'fetch.abort') {
      const entry = live.get(event.requestId);
      if (entry !== undefined) finish(event.requestId, entry, null);
      else if (starting.has(event.requestId)) abortedEarly.add(event.requestId);
      return;
    }
    void handleRequest(event);
  };

  const abortAll = () => {
    for (const [requestId, entry] of [...live]) finish(requestId, entry, null);
  };

  const unsubscribeFetch = deps.host.onFetch(onFetch);
  const unsubscribeStatus = deps.host.onStatus((status) => {
    if (status !== 'ready') abortAll();
  });
  // No turn running, no request is wanted: whatever is still in flight is stopped.
  const unsubscribeChat = deps.host.onChat((event) => {
    if ((event.type === 'chat.finish' || event.type === 'chat.error') && deps.host.activeChats().length === 0) abortAll();
  });

  return {
    state: () => ({ key, active: live.size, lastRefusal }),
    abortAll,
    dispose() {
      disposed = true;
      unsubscribeFetch();
      unsubscribeStatus();
      unsubscribeChat();
      abortAll();
    },
  };
}
