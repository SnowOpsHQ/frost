// The `fetch` the model providers use (Phase 5 Task 2, plan decision 5; acceptance
// `specs/agent-runtime.feature.md`, Proxied fetch). It sends no request itself: it posts
// `fetch.request` to main, which checks the URL against the route's allowlist, adds the real
// credential and sends it; the answer comes back as `fetch.response-start`, `fetch.chunk`… and
// `fetch.end` (or `fetch.error`), which this streams into a `Response`.
//
// It holds no credential. The providers get a placeholder key, and every credential-like header is
// dropped here before the request leaves (main drops them again and adds the real one).
import { AGENT_PROTOCOL_LIMITS as L, HeaderListSchema, type HeaderList, type MainToRuntimeMessage, type RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Headers never sent from the runtime (lower case). */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie']);

export type FetchAnswer = Extract<MainToRuntimeMessage, { type: `fetch.${string}` }>;

export type ProxyFetchErrorCode = Extract<FetchAnswer, { type: 'fetch.error' }>['code'] | 'invalid-request';

/** A request main refused or could not complete (`fetch.error`), or one refused here. */
export class ProxyFetchError extends Error {
  override readonly name = 'ProxyFetchError';
  constructor(
    readonly code: ProxyFetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ProxyFetch {
  readonly fetch: FetchFunction;
  /** Feeds one of main's `fetch.*` answers to its request (ignored for an unknown request id). */
  handle(answer: FetchAnswer): void;
  /** Requests still waiting for a head or streaming a body. */
  readonly pending: number;
}

interface PendingRequest {
  head: { resolve(response: Response): void; reject(error: unknown): void } | null;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  /** Detaches the abort listener. */
  cleanup(): void;
}

/** Statuses whose `Response` must have no body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function createProxyFetch(post: (message: RuntimeToMainMessage) => boolean, newRequestId: () => string = () => crypto.randomUUID()): ProxyFetch {
  const requests = new Map<string, PendingRequest>();

  const finish = (requestId: string) => {
    const request = requests.get(requestId);
    if (request === undefined) return;
    requests.delete(requestId);
    request.cleanup();
  };

  const fail = (requestId: string, error: unknown) => {
    const request = requests.get(requestId);
    if (request === undefined) return;
    finish(requestId);
    if (request.head !== null) request.head.reject(error);
    else request.body?.error(error);
  };

  const proxyFetch: FetchFunction = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = request !== null ? request.url : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const signal = init?.signal ?? request?.signal ?? null;
    if (signal?.aborted) throw signal.reason;
    if (method !== 'GET' && method !== 'POST') throw new ProxyFetchError('invalid-request', 'only GET and POST model requests are sent');

    const headers: HeaderList = [];
    new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
      if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
    });
    if (!HeaderListSchema.safeParse(headers).success) throw new ProxyFetchError('invalid-request', 'request headers out of bounds');

    const body = await requestBody(init?.body ?? (request !== null && request.body !== null ? await request.arrayBuffer() : null));
    if (method === 'GET' && body !== null) throw new ProxyFetchError('invalid-request', 'a GET has no body');

    const requestId = newRequestId();
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        if (!requests.has(requestId)) return;
        post({ type: 'fetch.abort', requestId });
        fail(requestId, signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      requests.set(requestId, {
        head: { resolve, reject },
        body: null,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      if (!post({ type: 'fetch.request', requestId, url, method, headers, body })) {
        fail(requestId, new ProxyFetchError('invalid-request', 'the model request is out of bounds'));
      }
    });
  };

  const handle = (answer: FetchAnswer) => {
    const request = requests.get(answer.requestId);
    if (request === undefined) return;
    switch (answer.type) {
      case 'fetch.response-start': {
        if (request.head === null) return;
        if (answer.status < 200) {
          fail(answer.requestId, new ProxyFetchError('network', 'unexpected informational response'));
          return;
        }
        const head = request.head;
        request.head = null;
        const requestId = answer.requestId;
        const stream = NULL_BODY_STATUSES.has(answer.status)
          ? null
          : new ReadableStream<Uint8Array>({
              start: (controller) => {
                request.body = controller;
              },
              cancel: () => {
                if (!requests.has(requestId)) return;
                finish(requestId);
                post({ type: 'fetch.abort', requestId });
              },
            });
        if (stream === null) finish(requestId);
        head.resolve(new Response(stream, { status: answer.status, statusText: answer.statusText, headers: answer.headers }));
        return;
      }
      case 'fetch.chunk':
        if (request.body === null) return;
        request.body.enqueue(answer.bytes);
        return;
      case 'fetch.end':
        if (request.head !== null) {
          fail(answer.requestId, new ProxyFetchError('network', 'the response ended before its head'));
          return;
        }
        finish(answer.requestId);
        request.body?.close();
        return;
      case 'fetch.error':
        fail(answer.requestId, new ProxyFetchError(answer.code, answer.message));
        return;
    }
  };

  return {
    fetch: proxyFetch,
    handle,
    get pending() {
      return requests.size;
    },
  };
}

/** The body as the protocol carries it (a string, bytes or nothing), refused over its cap. */
async function requestBody(body: BodyInit | null | undefined): Promise<string | Uint8Array<ArrayBuffer> | null> {
  if (body === null || body === undefined) return null;
  let value: string | Uint8Array<ArrayBuffer>;
  if (typeof body === 'string') value = body;
  else if (body instanceof ArrayBuffer) value = new Uint8Array(body.slice(0));
  else if (ArrayBuffer.isView(body)) {
    // A copy: the caller may reuse its buffer once `fetch` returns.
    value = new Uint8Array(body.byteLength);
    value.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  } else throw new ProxyFetchError('invalid-request', 'the request body is not a string or bytes');
  const size = typeof value === 'string' ? value.length : value.byteLength;
  if (size > L.maxRequestBodyBytes) throw new ProxyFetchError('too-large', 'the request body is too large');
  return value;
}
