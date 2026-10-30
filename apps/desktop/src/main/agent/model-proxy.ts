import { chatgptAnswerFailure, type ChatgptFailure, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { AGENT_PROTOCOL_LIMITS, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import {
  AGENT_PROXY_LIMITS,
  checkModelRequestBody,
  filterRequestHeaders,
  filterResponseHeaders,
  isUsableModelSettings,
  mainRequestHeaders,
  routeCredentialSlot,
  sanitizeStatusText,
  type AgentModelSettings,
  type ProxyRefusal,
} from '@app/specs/agent-proxy.spec';
import { isAllowedModelRequest, MODEL_REQUESTS, MODEL_ROUTES } from '@app/specs/agent-tools.spec';
import type { ChatgptAuth, ChatgptTokenFailure } from './chatgpt/service';
import { createStreamScanner, readErrorAnswer } from './chatgpt/responses';
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
//
// The ChatGPT plan route (`agent-chatgpt.feature.md`, Through the proxy; plan Task 3): the credential
// is the sign-in's access token, handed out by `chatgpt.withAccessToken` (refreshed as needed) and
// sent as `Authorization: Bearer` only (no organisation or project header). A `401` refreshes once
// with the refused token and retries once (a single 401 is not proof of revocation). Main reads an
// error answer's body (capped) and watches the event stream for `response.failed`, only to find a
// documented failure code; it reports the failure (`ChatgptFailure`) to the session, never passes
// the body on, and after a failure that repeating can't fix (`usage-limit`, `not-eligible`,
// `plan-usage-off`, `unsupported`, `signed-out`) sends nothing more on the plan until the turn ends
// (`plan-paused`). The model must be in the account's last model list.
//
// A route switch while a turn runs: a request that fits the route the turn began on (and not the
// new one) is refused as `model` (no strike), so a request shaped for the user's OpenAI key never
// goes out with the plan's token, or the reverse, even though both routes share one URL.

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

/** What the proxy uses of the ChatGPT sign-in (main's `chatgpt/` service) and where it reports a plan failure. */
export interface ModelProxyChatgpt {
  readonly withAccessToken: ChatgptAuth['withAccessToken'];
  /** A failure the panel should show for the running turn (`AgentActiveChatView.chatgptError`). */
  report(failure: ChatgptFailure): void;
  /**
   * The signed-in ChatGPT account (or its plan usage) changed: a pause from the previous one
   * (`plan-paused`) no longer holds, so the plan is asked again.
   */
  onAccountChange?(listener: () => void): () => void;
}

export interface ModelProxyDeps {
  readonly host: Pick<AgentHost, 'send' | 'onFetch' | 'onStatus' | 'onChat' | 'activeChats' | 'strike'>;
  readonly credentials: Pick<CredentialStore, 'withKey'>;
  /** `onChange` lets a request made for the route a turn began on be told from the runtime's fault; `chatgptModels` is the account's last list. */
  readonly settings: Pick<AgentSettings, 'current' | 'load'> & Partial<Pick<AgentSettings, 'onChange' | 'chatgptModels'>>;
  /** The ChatGPT plan route's credential (absent: the route has none, every request is `no-key`). */
  readonly chatgpt?: ModelProxyChatgpt;
  /**
   * Where a plan request that passed every check is sent (default: the allowlisted URL it was
   * checked against). Only the unpackaged e2e seam sets it (`agent-chatgpt-e2e.schema.ts`), to a
   * loopback fake; what the runtime may ask for is unchanged.
   */
  readonly chatgptResponsesUrl?: string;
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
const NOT_THE_RUNTIMES_FAULT: ReadonlySet<ProxyRefusal> = new Set(['no-key', 'key-unavailable', 'redirect', 'model', 'plan-paused']);

/** Plan failures that the same request can't get past: nothing more goes out on the plan this turn. */
const PAUSING_FAILURES: ReadonlySet<ChatgptFailure['reason']> = new Set(['usage-limit', 'not-eligible', 'plan-usage-off', 'unsupported', 'signed-out']);

/** A token the sign-in couldn't hand out, as a refusal and the failure the panel shows (if any). */
const TOKEN_FAILURES: Readonly<Record<ChatgptTokenFailure, { readonly refusal: ProxyRefusal | 'network'; readonly failure: ChatgptFailure | null }>> = {
  'signed-out': { refusal: 'no-key', failure: { reason: 'signed-out' } },
  expired: { refusal: 'no-key', failure: { reason: 'signed-out' } },
  'plan-usage-off': { refusal: 'no-key', failure: { reason: 'plan-usage-off' } },
  network: { refusal: 'network', failure: null },
  failed: { refusal: 'key-unavailable', failure: null },
};

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
  /**
   * The settings a running turn began on, when they changed since (until no turn runs). Taken from
   * the settings' own change (the value before it), so it is the loaded settings, never the
   * defaults the proxy saw before the file was read.
   */
  let previous: AgentModelSettings | null = null;
  /** A plan failure that pauses the plan until the turn ends. */
  let paused: ChatgptFailure | null = null;
  const chatgptModels = (): readonly ChatgptModelView[] => {
    try {
      return deps.settings.chatgptModels?.() ?? [];
    } catch {
      return [];
    }
  };
  /** Reports a plan failure once per request (the first), logged with its reason only. */
  const reportFailure = (failure: ChatgptFailure) => {
    log(`plan:${failure.reason}`, `agent proxy: the ChatGPT plan refused a request (${failure.reason})`);
    if (PAUSING_FAILURES.has(failure.reason)) paused = failure;
    try {
      deps.chatgpt?.report(failure);
    } catch {
      // The session's listener failing doesn't change the answer.
    }
  };

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

  const stream = async (requestId: string, entry: Live, response: Response, chatgpt = false) => {
    if (entry.settled) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      fail(requestId, entry, 'network');
      return;
    }
    if (chatgpt && response.status >= 400) {
      // The plan's failure code, read in main (capped) under the idle timer; the body goes no further.
      const failure = chatgptAnswerFailure(response.status, await readErrorAnswer(response));
      if (entry.settled) return;
      if (failure !== null) reportFailure(failure);
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
    // A usage limit can arrive as a `response.failed` after streaming began.
    const scanner = chatgpt ? createStreamScanner(reportFailure) : null;
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (entry.settled) return;
      if (done) break;
      scanner?.push(value);
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
    const settings = deps.settings.current();
    const { route, modelId } = settings;
    /** Whether the request fits the route the running turn began on (a switch since): not the runtime's fault. */
    const madeForPrevious = (body: string): boolean =>
      previous !== null &&
      (previous.route !== route || previous.modelId !== modelId) &&
      isAllowedModelRequest(previous.route, request.method, request.url) &&
      checkModelRequestBody(previous.route, previous.modelId, body, filterRequestHeaders(previous.route, request.headers)).ok;
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
      // Shaped for the route the turn began on (the user switched since): the model changed, not the runtime's doing.
      if (madeForPrevious(body)) refuse(requestId, 'model', false);
      else refuse(requestId, check.reason);
      return;
    }
    // The bytes sent are the object checked (a repeated key in the runtime's text can't differ).
    const checkedBody = check.body;
    if (madeForPrevious(body)) {
      // It fits both: sent under the new route's credential it would go where the user didn't ask.
      refuse(requestId, 'model', false);
      return;
    }
    const slot = routeCredentialSlot(route);
    if (slot === null) {
      handleChatgpt(requestId, deps.chatgptResponsesUrl ?? target.url, headers, checkedBody, settings);
      return;
    }

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
      const sent = await deps.credentials.withKey(slot, (secret) =>
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

  /** The ChatGPT plan route: the sign-in's access token as the credential, a 401 refreshed and retried once. */
  const handleChatgpt = (requestId: string, url: string, headers: [string, string][], checkedBody: string, settings: AgentModelSettings) => {
    const chatgpt = deps.chatgpt;
    if (chatgpt === undefined) {
      key = 'no-key';
      refuse(requestId, 'no-key');
      return;
    }
    // Only a model the account's last list has.
    if (!isUsableModelSettings(settings, chatgptModels())) {
      refuse(requestId, 'model');
      return;
    }
    if (paused !== null) {
      refuse(requestId, 'plan-paused');
      return;
    }
    const entry: Live = { controller: new AbortController(), settled: false, idle: null, total: null, reader: null };
    live.set(requestId, entry);
    resetIdle(requestId, entry);
    entry.total = setTimer(() => fail(requestId, entry, 'timeout'), limits.maxRequestMs);
    const refuseEntry = (reason: ProxyRefusal) => {
      if (entry.settled) return;
      finish(requestId, entry, null);
      refuse(requestId, reason);
    };
    // The token stays in this closure: it goes into the header and, after a 401, back to the service as the refused one.
    const attempt = (rejected?: string) =>
      chatgpt.withAccessToken(
        async (token) => ({
          token,
          response: await deps.fetch(url, {
            method: 'POST',
            headers: [...headers, ...mainRequestHeaders('chatgpt', token)],
            body: checkedBody,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: entry.controller.signal,
          }),
        }),
        rejected === undefined ? {} : { rejected },
      );
    void (async () => {
      try {
        let sent = await attempt();
        if (sent.ok && sent.value.response.status === 401 && !entry.settled) {
          // Not proof of revocation: refreshed once with the refused token, and asked once more.
          void sent.value.response.body?.cancel().catch(() => undefined);
          sent = await attempt(sent.value.token);
        }
        // The request ended meanwhile (aborted, timed out, its turn over): a late token failure is not
        // reported, so it can't pause the plan for the next turn.
        if (entry.settled) return;
        if (!sent.ok) {
          const outcome = TOKEN_FAILURES[sent.reason];
          if (outcome.failure !== null) reportFailure(outcome.failure);
          if (outcome.refusal === 'network') fail(requestId, entry, 'network');
          else {
            if (outcome.refusal === 'no-key') key = 'no-key';
            refuseEntry(outcome.refusal);
          }
          return;
        }
        key = 'set';
        await stream(requestId, entry, sent.value.response, true);
      } catch (error) {
        if (entry.settled) return;
        if (isRedirectError(error)) refuseEntry('redirect');
        else fail(requestId, entry, 'network');
      }
    })();
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
    if ((event.type === 'chat.finish' || event.type === 'chat.error') && deps.host.activeChats().length === 0) {
      abortAll();
      // The next turn starts on the settings in effect, with the plan no longer paused.
      previous = null;
      paused = null;
    }
  });
  // A route or model change while a turn runs: what the turn began on (the settings before the
  // first change) is kept until no turn runs.
  const unsubscribeSettings =
    deps.settings.onChange?.((_next, before) => {
      if (deps.host.activeChats().length > 0 && previous === null) previous = before;
    }) ?? (() => undefined);
  // Another account, or plan usage turned on: a pause from before no longer holds.
  const unsubscribeAccount =
    deps.chatgpt?.onAccountChange?.(() => {
      paused = null;
    }) ?? (() => undefined);

  return {
    state: () => ({ key, active: live.size, lastRefusal }),
    abortAll,
    dispose() {
      disposed = true;
      unsubscribeFetch();
      unsubscribeStatus();
      unsubscribeChat();
      unsubscribeSettings();
      unsubscribeAccount();
      abortAll();
    },
  };
}
