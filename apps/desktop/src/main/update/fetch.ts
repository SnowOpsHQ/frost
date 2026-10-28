import { isIpLiteral, isPrivateAddress, isPrivateHost } from '@app/specs/private-address.spec';
import { UPDATE_ALLOWED_REQUEST_HEADERS } from '@app/specs/update-client.spec';
import { MAX_ARTIFACT_URL_CHARS } from '@app/specs/update-manifest.spec';
import { isLoopbackLiteral } from './feed';

// The update client's bounded HTTP getter (spec `update-client.spec.ts`, Requests and
// `UPDATE_FETCH_LIMITS`; `update-client.feature.md`, `feed-request-carries-nothing`, `hop-rules`,
// `download-is-bounded`). Pure: the transport (`UpdateHop`) and the resolver are injected; main
// uses `netTransport` over a dedicated in-memory session (`hardenUpdateSession`), tests a Node
// `http` transport against a local fake feed.
//
// One `GET` per hop, never following a redirect itself: each `Location` is checked before it is
// requested. Every hop is `https:` (or, unpackaged only, `http:` to a loopback literal, never after
// an `https:` hop), without a user name or password, and on a public address: an IP literal is
// checked directly, a name must not be local-only and must resolve to public addresses only
// (`private-address.spec.ts`). The body goes to a sink chunk by chunk and is cut at `maxBytes` (one
// byte more ends the request). Timeouts: to each hop's response, between body bytes, and in total.
// The request carries only the `User-Agent` it is given: no cookies, no credentials, no referrer.

/** One HTTP exchange: a redirect (not followed), or a response whose body can be read. */
export type UpdateHopResult =
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string | null }
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Lowercase names. */
      readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
      readonly body: AsyncIterable<Uint8Array>;
      cancel(): void;
    };

/** Requests `url` once with `GET`, sending only `User-Agent: userAgent`; rejects on a network error or when `signal` aborts. */
export type UpdateHop = (url: string, signal: AbortSignal, userAgent: string) => Promise<UpdateHopResult>;

/**
 * The addresses `host` (a name, never a literal) resolves to; rejects when it does not resolve.
 * `null`: not checked (only an e2e seam may answer so, in an unpackaged build).
 */
export type UpdateResolve = (host: string) => Promise<readonly string[] | null>;

export interface UpdateGetDeps {
  readonly hop: UpdateHop;
  readonly resolve: UpdateResolve;
  /** A packaged build never uses `http:`, not even to loopback. */
  readonly isPackaged: boolean;
  /** `updateUserAgent(currentVersion)`. */
  readonly userAgent: string;
}

export interface UpdateGetLimits {
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly responseMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

/**
 * Why a get failed:
 * - `insecure-url`: the URL itself is not `https:` (or allowed loopback `http:`), or has credentials;
 * - `insecure-redirect`: a redirect to such a URL, or from `https:` to `http:`;
 * - `private-address`: a hop's host is, or resolves to, a private address (never requested);
 * - `too-many-redirects`, `bad-redirect` (no, an unparsable or an over-long `Location`);
 * - `http-status`: a final status other than 200;
 * - `too-large`: the body (or its declared `Content-Length`) is over `maxBytes`;
 * - `unreachable`: a network error, or a name that does not resolve; `timeout`; `aborted`;
 * - `sink`: the sink threw (a disk error).
 */
export type UpdateGetFailure =
  | 'insecure-url'
  | 'insecure-redirect'
  | 'private-address'
  | 'too-many-redirects'
  | 'bad-redirect'
  | 'http-status'
  | 'too-large'
  | 'unreachable'
  | 'timeout'
  | 'aborted'
  | 'sink';

export type UpdateGetResult = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly reason: UpdateGetFailure; readonly status?: number };

type HopCheck = 'ok' | 'insecure' | 'private-address' | 'unreachable' | 'stopped';

/**
 * Whether `url` may be requested as the next hop (`previous`: the protocol of the hop that
 * redirected here, `null` for the first): its scheme and credentials, then its address.
 */
async function checkHop(url: URL, previous: string | null, deps: UpdateGetDeps, stopped: Promise<'stopped'>): Promise<HopCheck> {
  if (url.username !== '' || url.password !== '' || url.hostname === '') return 'insecure';
  if (url.protocol === 'http:') {
    // Loopback http: is the tests' fake feed only: unpackaged, a literal, and never down from https:.
    return !deps.isPackaged && previous !== 'https:' && isLoopbackLiteral(url.hostname) ? 'ok' : 'insecure';
  }
  if (url.protocol !== 'https:') return 'insecure';
  const host = url.hostname.replace(/\.+$/, '');
  // Literals and local-only names (localhost, *.local, single labels…) are judged as written.
  if (isPrivateHost(host)) return 'private-address';
  if (isIpLiteral(host)) return 'ok';
  let addresses: readonly string[] | null | 'stopped';
  try {
    addresses = await Promise.race([deps.resolve(host), stopped]);
  } catch {
    return 'unreachable';
  }
  if (addresses === 'stopped') return 'stopped';
  if (addresses === null) return 'ok';
  if (addresses.length === 0) return 'unreachable';
  return addresses.some(isPrivateAddress) ? 'private-address' : 'ok';
}

const declaredLength = (headers: Readonly<Record<string, string | readonly string[] | undefined>>): number | null => {
  const value = headers['content-length'];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && /^\d{1,16}$/.test(text.trim()) ? Number(text.trim()) : null;
};

/**
 * Gets `url` within `limits`, passing the body to `sink` chunk by chunk (awaited, so a slow disk
 * slows the read). Never rejects. A body over `limits.maxBytes` stops at the chunk that crosses it
 * (that chunk is not passed on).
 */
export async function updateGet(url: string, deps: UpdateGetDeps, limits: UpdateGetLimits, sink: (chunk: Uint8Array) => Promise<void> | void, signal?: AbortSignal): Promise<UpdateGetResult> {
  const controller = new AbortController();
  const stop = (why: 'timeout' | 'aborted') => {
    if (!controller.signal.aborted) controller.abort(why);
  };
  const why = (): 'timeout' | 'aborted' => (controller.signal.reason === 'aborted' ? 'aborted' : 'timeout');
  const stopped = new Promise<'stopped'>((resolve) => controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
  const onCallerAbort = () => stop('aborted');
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const total = setTimeout(() => stop('timeout'), limits.totalMs);
  let phase: ReturnType<typeof setTimeout> | undefined;
  /** (Re)arms the response or idle timer. */
  const arm = (ms: number) => {
    clearTimeout(phase);
    phase = setTimeout(() => stop('timeout'), ms);
  };
  let cancel: (() => void) | undefined;
  const fail = (reason: UpdateGetFailure, status?: number): UpdateGetResult => (status === undefined ? { ok: false, reason } : { ok: false, reason, status });

  try {
    if (!URL.canParse(url)) return fail('insecure-url');
    let current = new URL(url);
    let previous: string | null = null;
    for (let redirects = 0; ; ) {
      const check = await checkHop(current, previous, deps, stopped);
      if (check === 'stopped' || controller.signal.aborted) return fail(why());
      if (check === 'insecure') return fail(previous === null ? 'insecure-url' : 'insecure-redirect');
      if (check !== 'ok') return fail(check);

      arm(limits.responseMs);
      let result: UpdateHopResult | 'stopped';
      try {
        // `hop` may throw synchronously; the async wrapper turns that into a rejection.
        result = await Promise.race([(async () => deps.hop(current.href, controller.signal, deps.userAgent))(), stopped]);
      } catch {
        return controller.signal.aborted ? fail(why()) : fail('unreachable');
      }
      if (result === 'stopped') return fail(why());
      if (result.kind === 'redirect') {
        if (redirects >= limits.maxRedirects) return fail('too-many-redirects', result.status);
        redirects += 1;
        const location = result.location;
        if (location === null || location.length > MAX_ARTIFACT_URL_CHARS || !URL.canParse(location, current.href)) return fail('bad-redirect', result.status);
        previous = current.protocol;
        current = new URL(location, current.href);
        continue;
      }
      const response = result;
      cancel = () => response.cancel();
      if (response.status !== 200) return fail('http-status', response.status);
      const declared = declaredLength(response.headers);
      if (declared !== null && declared > limits.maxBytes) return fail('too-large', response.status);

      let bytes = 0;
      const iterator = response.body[Symbol.asyncIterator]();
      try {
        for (;;) {
          arm(limits.idleMs);
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === 'stopped') return fail(why());
          if (next.done) break;
          const chunk = next.value;
          if (bytes + chunk.byteLength > limits.maxBytes) return fail('too-large', response.status);
          bytes += chunk.byteLength;
          clearTimeout(phase);
          try {
            await sink(chunk);
          } catch {
            return fail('sink', response.status);
          }
          if (controller.signal.aborted) return fail(why());
        }
      } catch {
        return controller.signal.aborted ? fail(why()) : fail('unreachable', response.status);
      } finally {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
      return { ok: true, bytes };
    }
  } finally {
    clearTimeout(total);
    clearTimeout(phase);
    signal?.removeEventListener('abort', onCallerAbort);
    try {
      cancel?.();
    } catch {
      // Already finished.
    }
    if (!controller.signal.aborted) controller.abort('done');
  }
}

/** `updateGet` into memory (the envelope): the bytes, or why not. */
export async function getBytes(url: string, deps: UpdateGetDeps, limits: UpdateGetLimits, signal?: AbortSignal): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: UpdateGetFailure; readonly status?: number }> {
  const chunks: Uint8Array[] = [];
  const result = await updateGet(url, deps, limits, (chunk) => void chunks.push(Uint8Array.from(chunk)), signal);
  if (!result.ok) return result;
  const bytes = new Uint8Array(result.bytes);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ---- Electron glue (injected by main; typed structurally, no Electron import) -------------------

/** The part of Electron's `net` the transport uses. */
export interface UpdateNet {
  request(options: Electron.ClientRequestConstructorOptions): Electron.ClientRequest;
}

/**
 * Main's transport: `net.request` through `session` (the dedicated update session), `GET`, no
 * cookies or credentials (`credentials: 'omit'`, `useSessionCookies: false`, so no login prompt),
 * no referrer, not from or into the HTTP cache, and `redirect: 'manual'` so a redirect is reported
 * and checked, never followed by the network stack (the request is aborted at it). Sets only
 * `User-Agent`.
 */
export function netTransport(net: UpdateNet, session: Electron.Session): UpdateHop {
  return (url, signal, userAgent) =>
    new Promise<UpdateHopResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const request = net.request({ url, method: 'GET', session, credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
      request.setHeader('User-Agent', userAgent);
      let settled = false;
      const abort = () => {
        try {
          request.abort();
        } catch {
          // Already finished.
        }
      };
      signal.addEventListener(
        'abort',
        () => {
          abort();
          if (!settled) {
            settled = true;
            reject(new Error('aborted'));
          }
        },
        { once: true },
      );
      request.on('redirect', (statusCode, _method, redirectUrl) => {
        if (settled) return;
        settled = true;
        abort();
        resolve({ kind: 'redirect', status: statusCode, location: typeof redirectUrl === 'string' && redirectUrl !== '' ? redirectUrl : null });
      });
      request.on('response', (response) => {
        if (settled) return;
        settled = true;
        // An aborted body must never surface as an unhandled stream error.
        response.on('error', () => undefined);
        const headers: Record<string, string | readonly string[] | undefined> = {};
        for (const [name, value] of Object.entries((response as { headers?: Record<string, string | string[]> }).headers ?? {})) headers[name.toLowerCase()] = value;
        resolve({ kind: 'response', status: response.statusCode, headers, body: response as unknown as AsyncIterable<Uint8Array>, cancel: abort });
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.end();
    });
}

/** Main's resolver: the update session's own (`session.resolveHost`). */
export function netResolve(session: { resolveHost(host: string): Promise<{ readonly endpoints: readonly { readonly address: string }[] }> }): UpdateResolve {
  return async (host) => (await session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address);
}

/** The headers the update session sends: `User-Agent` only (`UPDATE_ALLOWED_REQUEST_HEADERS`), forced to `userAgent`. */
export function updateRequestHeaders(_headers: Readonly<Record<string, string>>, userAgent: string): Record<string, string> {
  // Whatever the session would send, only the one allowed header goes out.
  void UPDATE_ALLOWED_REQUEST_HEADERS;
  return { 'User-Agent': userAgent };
}

/** Whether the update session lets a request out: `GET`, to `https:`, or (unpackaged) `http:` loopback. */
function allowedRequest(url: string, method: string, isPackaged: boolean): boolean {
  if (method !== 'GET' || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || (!isPackaged && parsed.protocol === 'http:' && isLoopbackLiteral(parsed.hostname));
}

/** The parts of the update session `hardenUpdateSession` sets up. */
export interface UpdateSessionLike {
  setUserAgent(userAgent: string): void;
  webRequest: {
    onBeforeSendHeaders(listener: (details: { requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void): void;
    onBeforeRequest(listener: (details: { url: string; method: string }, callback: (response: { cancel: boolean }) => void) => void): void;
  };
}

/**
 * Sets up the dedicated update session (main: `session.fromPartition(UPDATE_PARTITION, { cache:
 * false })`, in memory): its user agent, a header filter that sends only `User-Agent` (whatever
 * else the session would add, `Accept-Language` included), and a request filter that cancels
 * anything but a `GET` to `https:` (or, unpackaged, `http:` loopback). Defence in depth: the
 * transport already sends nothing else, and the getter checks every hop.
 */
export function hardenUpdateSession(session: UpdateSessionLike, userAgent: string, { isPackaged }: { isPackaged: boolean }): void {
  session.setUserAgent(userAgent);
  session.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: updateRequestHeaders(details.requestHeaders, userAgent) }));
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url, details.method, isPackaged) }));
}
