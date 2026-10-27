import type { Session } from 'electron';
import { FETCHER_LANES, FETCHER_LIMITS, type BoundedFetcher, type BoundedFetchRequest, type BoundedFetchResult, type FetchMethod, type FetchOutcome, type FetcherLane, type FetchRedirect } from '@app/specs/fetcher.spec';
import { isIpLiteral, isPrivateAddress, isPrivateHost } from '@app/specs/private-address.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The bounded fetcher (spec `fetcher.spec.ts`; Phase 2.5 Global Constraints, "Fetching on the user's
// behalf"): every request main makes on the user's behalf (robots.txt, served HTML, Task 7's link,
// sitemap and hreflang checks). One hop at a time (`hop`), each redirect checked before it is
// followed (at most `maxRedirects`, `http(s)` only, never to a private host unless the page is on
// one), the body read up to `maxBytes`, everything under one `timeoutMs` deadline from the call, and
// requests queued per origin (`perOriginConcurrency`, `perOriginIntervalMs`, `maxQueuedPerOrigin`).
// The body is kept as bytes, never decoded here.

/** One HTTP exchange: a redirect (not followed), or a response whose body can be read. */
export type HopResult =
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string | null }
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: AsyncIterable<Uint8Array>;
      /** The response's headers (lowercase names), when the hop reports them. */
      readonly headers?: Readonly<Record<string, string | readonly string[]>>;
      cancel(): void;
    };

/** What a hop sends beside the URL. */
export interface HopOptions {
  readonly method?: FetchMethod;
  readonly userAgent?: string | null;
  readonly accept?: string;
}

/** Requests `url` once, never following a redirect; rejects on a network error or when `signal` aborts. */
export type Hop = (url: string, signal: AbortSignal, options?: HopOptions) => Promise<HopResult>;

export interface BoundedFetcherOptions {
  readonly hop: Hop;
  /** Wall clock in ms, for the rate limit (injectable for tests). */
  readonly now?: () => number;
  /** The per-origin queue's limits (defaults: `FETCHER_LIMITS`). */
  readonly limits?: { readonly perOriginConcurrency?: number; readonly perOriginIntervalMs?: number; readonly maxQueuedPerOrigin?: number };
  /**
   * Resolves a host name before each hop to it (`fetcher.spec.ts`, Private addresses; main:
   * `netResolver` on the browse session). Without one only literal hosts are checked (unit tests of
   * other rules); main always gives one (`createFetcherLanes` requires it).
   */
  readonly resolve?: Resolve;
}

/**
 * The addresses `host` resolves to; rejects when it does not resolve. `null`: not checked (only the
 * e2e seam answers so, for the hosts `E2E_PUBLIC_HOSTS_SWITCH` names).
 */
export type Resolve = (host: string) => Promise<readonly string[] | null>;

// The private-host check is the shared one (`private-address.spec.ts`), re-exported for callers.
export { isPrivateHost };

/** Whether `pageUrl` is on a private host (so the requests made for it may go to private hosts too). */
export function isPrivatePage(pageUrl: string): boolean {
  const page = parseWebUrl(pageUrl);
  return page !== null && isPrivateHost(page.hostname);
}

export const cutUrl = (value: string): string => value.slice(0, SNAPSHOT_LIMITS.maxUrlChars);

const EMPTY = new Uint8Array(0);

/** Reads `body` up to `maxBytes` bytes (then stops reading): the bytes and whether there was more (one chunk past an exactly full cap is read to know). */
export async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  for await (const chunk of body) {
    const room = maxBytes - length;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      length += room;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    length += chunk.byteLength;
    // Exactly full: the loop reads one more chunk, so a body that goes on is `truncated` (a 50 MB cap
    // is a whole number of a stream's chunks, so a longer body often fills it exactly).
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** `location` resolved against `base`, or `''` when it does not parse. */
function safeResolve(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    return '';
  }
}

/** The kept headers of a hop's answer: lowercase names, arrays joined with `, `, values cut to `maxChars`. */
function keptHeaders(headers: Readonly<Record<string, string | readonly string[]>> | undefined, keep: readonly string[], maxChars: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!keep.includes(lower)) continue;
    const joined = Array.isArray(value) ? value.join(', ') : String(value);
    out[lower] = joined.slice(0, maxChars);
  }
  return out;
}

/** One origin's queue: requests running, and waiting (in order). */
interface OriginQueue {
  running: number;
  lastStart: number;
  waiting: { start: () => void; cancel: () => void }[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createBoundedFetcher(options: BoundedFetcherOptions): BoundedFetcher {
  const limits: { readonly [K in keyof typeof FETCHER_LIMITS]: number } = { ...FETCHER_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const queues = new Map<string, OriginQueue>();

  /** Starts as many waiting requests of `origin` as its limits allow (now, or when the interval has passed). */
  const pump = (origin: string): void => {
    const queue = queues.get(origin);
    if (!queue) return;
    if (queue.timer !== undefined) return;
    while (queue.waiting.length > 0 && queue.running < limits.perOriginConcurrency) {
      const wait = queue.lastStart + limits.perOriginIntervalMs - now();
      if (wait > 0) {
        queue.timer = setTimeout(() => {
          queue.timer = undefined;
          pump(origin);
        }, wait);
        return;
      }
      const next = queue.waiting.shift()!;
      queue.running += 1;
      queue.lastStart = now();
      next.start();
    }
  };

  /** Forgets idle origins whose interval has passed (their next request may start at once anyway). */
  const prune = (): void => {
    if (queues.size <= 64) return;
    const at = now();
    for (const [origin, queue] of queues) {
      if (queue.running === 0 && queue.waiting.length === 0 && queue.timer === undefined && at >= queue.lastStart + limits.perOriginIntervalMs) queues.delete(origin);
    }
  };

  /**
   * `origin`'s turn: a release function at once when the origin is free (so the first request to an
   * idle origin starts in the same tick), else a promise of one (`null`: `signal` aborted first);
   * `busy` when its queue is full.
   */
  const turn = (origin: string, signal: AbortSignal): (() => void) | 'busy' | Promise<(() => void) | null> => {
    let queue = queues.get(origin);
    if (!queue) {
      prune();
      queue = { running: 0, lastStart: Number.NEGATIVE_INFINITY, waiting: [], timer: undefined };
      queues.set(origin, queue);
    }
    const owner = queue;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owner.running -= 1;
      pump(origin);
    };
    if (owner.waiting.length === 0 && owner.timer === undefined && owner.running < limits.perOriginConcurrency && now() >= owner.lastStart + limits.perOriginIntervalMs) {
      owner.running += 1;
      owner.lastStart = now();
      return release;
    }
    if (owner.waiting.length >= limits.maxQueuedPerOrigin) return 'busy';
    return new Promise((resolve) => {
      const item = {
        start: () => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) {
            release();
            resolve(null);
          } else resolve(release);
        },
        cancel: () => resolve(null),
      };
      const onAbort = () => {
        const index = owner.waiting.indexOf(item);
        if (index >= 0) {
          owner.waiting.splice(index, 1);
          item.cancel();
          pump(origin);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      owner.waiting.push(item);
      pump(origin);
    });
  };

  /** Whether `hostname` (a name) resolves to any private address: `null` when it does not (or is not checked). */
  async function resolvedPrivate(hostname: string, deadline: Promise<'stopped'>): Promise<'private' | 'unresolved' | 'stopped' | null> {
    if (!options.resolve) return null;
    let addresses: readonly string[] | null | 'stopped';
    try {
      addresses = await Promise.race([options.resolve(hostname.replace(/\.+$/, '')), deadline]);
    } catch {
      return 'unresolved';
    }
    if (addresses === 'stopped') return 'stopped';
    if (addresses === null) return null;
    if (addresses.length === 0) return 'unresolved';
    return addresses.some(isPrivateAddress) ? 'private' : null;
  }

  async function fetchBounded(request: BoundedFetchRequest): Promise<BoundedFetchResult> {
    const started = now();
    const maxRedirects = request.maxRedirects ?? limits.maxRedirects;
    const maxBytes = request.maxBytes ?? limits.maxBytes;
    const timeoutMs = request.timeoutMs ?? limits.timeoutMs;
    const method = request.method ?? 'GET';
    const keep = request.keepHeaders ?? ['content-type'];
    const pagePrivate = isPrivatePage(request.page);
    /** Whether a hop to `hostname` must be resolved first (a name, a public page, a resolver). */
    const mustResolve = (hostname: string): boolean => !pagePrivate && options.resolve !== undefined && !isIpLiteral(hostname);
    const chain: FetchRedirect[] = [];
    let current = request.url;
    let status: number | null = null;
    let headers: Record<string, string> = {};
    const ended = (outcome: FetchOutcome, extra: Partial<BoundedFetchResult> = {}): BoundedFetchResult => ({
      url: cutUrl(request.url),
      outcome,
      status,
      finalUrl: status === null ? null : cutUrl(current),
      redirects: chain.length,
      chain,
      headers,
      body: EMPTY,
      truncated: false,
      durationMs: Math.max(0, now() - started),
      ...extra,
    });

    const first = parseWebUrl(request.url);
    if (!first) return ended('not-web');
    if (!pagePrivate && isPrivateHost(first.hostname)) return ended('private-address');
    current = first.href;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const onCallerAbort = () => controller.abort('aborted');
    if (request.signal?.aborted) onCallerAbort();
    else request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const why = (): FetchOutcome => (controller.signal.reason === 'aborted' ? 'aborted' : 'timeout');
    // The deadline (or the caller's abort) also wins against a hop that never settles.
    const deadline = new Promise<'stopped'>((resolve) => {
      if (controller.signal.aborted) resolve('stopped');
      else controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    });
    let release: (() => void) | null = null;
    try {
      const slot = turn(first.origin, controller.signal);
      const got = typeof slot === 'object' ? await Promise.race([slot, deadline]) : slot;
      if (got === 'busy') return ended('busy');
      // Stopped while waiting: the abort took the request out of the queue.
      if (got === 'stopped' || got === null) return ended(why());
      release = got;
      for (;;) {
        if (controller.signal.aborted) return ended(why());
        // A name is resolved before the first hop (each redirect's target is resolved where it is
        // checked, below); any private address refuses it, unless the page is private.
        if (chain.length === 0 && mustResolve(first.hostname)) {
          const refused = await resolvedPrivate(first.hostname, deadline);
          if (refused === 'stopped') return ended(why());
          if (refused === 'unresolved') return ended('unreachable');
          if (refused === 'private') return ended('private-address');
          if (controller.signal.aborted) return ended(why());
        }
        const result = await Promise.race([options.hop(current, controller.signal, { method, userAgent: request.userAgent ?? null, ...(request.accept ? { accept: request.accept } : {}) }), deadline]);
        if (result === 'stopped') return ended(why());
        status = result.status;
        if (result.kind === 'redirect') {
          if (chain.length >= maxRedirects) return ended('too-many-redirects');
          if (result.location === null) return ended('no-location');
          const next = parseWebUrl(safeResolve(result.location, current));
          if (!next) return ended('bad-redirect');
          if (!pagePrivate && isPrivateHost(next.hostname)) return ended('private-redirect');
          if (mustResolve(next.hostname)) {
            const refused = await resolvedPrivate(next.hostname, deadline);
            if (refused === 'stopped') return ended(why());
            if (refused === 'unresolved') return ended('unreachable');
            if (refused === 'private') return ended('private-redirect');
          }
          chain.push({ url: cutUrl(current), status: result.status, location: cutUrl(next.href) });
          current = next.href;
          status = null;
          continue;
        }
        headers = keptHeaders(result.headers, keep, request.maxHeaderChars ?? limits.maxHeaderValueChars);
        const wanted = method !== 'HEAD' && (request.readBody ? request.readBody(result.status) : true);
        if (!wanted) {
          result.cancel();
          return ended('response');
        }
        const read = await Promise.race([readCapped(result.body, maxBytes), deadline]);
        result.cancel();
        if (read === 'stopped') return ended(why());
        return ended('response', { body: read.bytes, truncated: read.truncated });
      }
    } catch {
      return controller.signal.aborted ? ended(why()) : ended('unreachable');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
      controller.abort('done');
      release?.();
    }
  }

  return {
    fetch: (request) => fetchBounded(request).catch(() => ({ url: cutUrl(request.url), outcome: 'unreachable', status: null, finalUrl: null, redirects: 0, chain: [], headers: {}, body: EMPTY, truncated: false, durationMs: 0 })),
    load(origin) {
      const queue = queues.get(origin);
      return { running: queue?.running ?? 0, queued: queue?.waiting.length ?? 0 };
    },
  };
}

/** Main's fetchers, one per lane (`fetcher.spec.ts`, Lanes): separate per-origin queues over one hop. */
export type FetcherLanes = Readonly<Record<FetcherLane, BoundedFetcher>>;

/**
 * The `audit` lane (robots.txt, the served HTML) and the `checks` lane (link, sitemap and hreflang
 * checks), each a bounded fetcher over `hop` with its lane's per-origin limits (`FETCHER_LANES`), so
 * an audit's requests never wait in a queue behind a check's.
 */
export function createFetcherLanes(options: Omit<BoundedFetcherOptions, 'limits' | 'resolve'> & { readonly resolve: Resolve }): FetcherLanes {
  return {
    audit: createBoundedFetcher({ ...options, limits: FETCHER_LANES.audit }),
    checks: createBoundedFetcher({ ...options, limits: FETCHER_LANES.checks }),
  };
}

/** The parts of Electron's `net` the hop uses. */
export interface NetRequester {
  request(options: Electron.ClientRequestConstructorOptions): Electron.ClientRequest;
}

/**
 * A hop through `session` (the browse session) with Electron's `net.request`: `GET` (or `HEAD`),
 * cookies and credentials off (`credentials: 'omit'`, so no `login` prompt either), no referrer,
 * bypassing the HTTP cache (`no-store`), and `redirect: 'manual'` so a redirect is reported, never
 * followed (the request is aborted at it). The `User-Agent` is the session's own unless one is
 * given. `net.fetch` / `session.fetch` cannot be used: with `redirect: 'manual'` they reject
 * ("Redirect was cancelled") instead of answering the 3xx.
 */
export function netHop(net: NetRequester, session: Session): Hop {
  return (url, signal, options = {}) =>
    new Promise<HopResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const request = net.request({ url, session, method: options.method ?? 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (options.userAgent) request.setHeader('User-Agent', options.userAgent);
      if (options.accept) request.setHeader('Accept', options.accept);
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
          if (!settled) reject(new Error('aborted'));
        },
        { once: true },
      );
      request.on('redirect', (statusCode, _method, redirectUrl) => {
        settled = true;
        abort();
        resolve({ kind: 'redirect', status: statusCode, location: typeof redirectUrl === 'string' && redirectUrl !== '' ? redirectUrl : null });
      });
      request.on('response', (response) => {
        settled = true;
        // An aborted body must never surface as an unhandled stream error.
        response.on('error', () => undefined);
        const headers = (response as { headers?: Record<string, string | string[]> }).headers;
        resolve({ kind: 'response', status: response.statusCode, body: response as unknown as AsyncIterable<Uint8Array>, ...(headers ? { headers } : {}), cancel: abort });
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.end();
    });
}

/** The parts of a session the resolver uses. */
export interface HostResolver {
  resolveHost(host: string): Promise<{ readonly endpoints: readonly { readonly address: string }[] }>;
}

/** Main's `Resolve`: the browse session's own resolver (`session.resolveHost`: its host rules and DNS cache). */
export function netResolver(session: HostResolver): Resolve {
  return async (host) => (await session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address);
}

/**
 * The e2e seam (`fetcher.spec.ts`, `E2E_PUBLIC_HOSTS_SWITCH`): `resolve`, except that the names in
 * `hosts` are not checked (`null`). Main wires it only in an unpackaged build started with the switch
 * (a packaged build refuses to start with it); never in production.
 */
export function withE2ePublicHosts(resolve: Resolve, hosts: readonly string[]): Resolve {
  const exempt = new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== ''));
  return (host) => (exempt.has(host.toLowerCase()) ? Promise.resolve(null) : resolve(host));
}
