import type { Session } from 'electron';
import { FETCHER_LIMITS, type BoundedFetcher, type BoundedFetchRequest, type BoundedFetchResult, type FetchMethod, type FetchOutcome, type FetchRedirect } from '@app/specs/fetcher.spec';
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
}

/** The 32-bit value of a dotted IPv4 literal (as `URL` serialises one), or `null`. */
function ipv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

function privateIpv4(value: number): boolean {
  const a = Math.floor(value / 2 ** 24);
  const b = Math.floor(value / 2 ** 16) % 256;
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The eight 16-bit groups of an IPv6 literal (without brackets, as `URL` serialises one), or `null`. */
function ipv6(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * Whether `hostname` (`URL.hostname`) is a private host (`fetcher.spec.ts`, private addresses):
 * `localhost` / `*.localhost`, `*.local`, or an IP literal in loopback, RFC 1918, link-local or
 * `0.0.0.0/8`, IPv6 loopback / unspecified, unique-local `fc00::/7`, link-local `fe80::/10`, or an
 * IPv4-mapped form of a private IPv4 address. Literal hosts only: no DNS lookup.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const v4 = ipv4(host);
  if (v4 !== null) return privateIpv4(v4);
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const groups = ipv6(host.slice(1, -1));
  if (!groups) return false;
  const [g0, , , , , g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (groups.slice(0, 7).every((group) => group === 0) && (g7 === 0 || g7 === 1)) return true;
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) return privateIpv4(g6 * 65_536 + g7);
  return false;
}

/** Whether `pageUrl` is on a private host (so the requests made for it may go to private hosts too). */
export function isPrivatePage(pageUrl: string): boolean {
  const page = parseWebUrl(pageUrl);
  return page !== null && isPrivateHost(page.hostname);
}

export const cutUrl = (value: string): string => value.slice(0, SNAPSHOT_LIMITS.maxUrlChars);

const EMPTY = new Uint8Array(0);

/** Reads `body` up to `maxBytes` bytes (then stops reading): the bytes and whether there was more. */
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
    if (length === maxBytes) {
      // Exactly full: whether more follows is unknown; stop reading anyway.
      break;
    }
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

/** The kept headers of a hop's answer: lowercase names, arrays joined with `, `, values cut. */
function keptHeaders(headers: Readonly<Record<string, string | readonly string[]>> | undefined, keep: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!keep.includes(lower)) continue;
    const joined = Array.isArray(value) ? value.join(', ') : String(value);
    out[lower] = joined.slice(0, FETCHER_LIMITS.maxHeaderValueChars);
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

  async function fetchBounded(request: BoundedFetchRequest): Promise<BoundedFetchResult> {
    const started = now();
    const maxRedirects = request.maxRedirects ?? limits.maxRedirects;
    const maxBytes = request.maxBytes ?? limits.maxBytes;
    const timeoutMs = request.timeoutMs ?? limits.timeoutMs;
    const method = request.method ?? 'GET';
    const keep = request.keepHeaders ?? ['content-type'];
    const pagePrivate = isPrivatePage(request.page);
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
        const result = await Promise.race([options.hop(current, controller.signal, { method, userAgent: request.userAgent ?? null, ...(request.accept ? { accept: request.accept } : {}) }), deadline]);
        if (result === 'stopped') return ended(why());
        status = result.status;
        if (result.kind === 'redirect') {
          if (chain.length >= maxRedirects) return ended('too-many-redirects');
          if (result.location === null) return ended('no-location');
          const next = parseWebUrl(safeResolve(result.location, current));
          if (!next) return ended('bad-redirect');
          if (!pagePrivate && isPrivateHost(next.hostname)) return ended('private-redirect');
          chain.push({ url: cutUrl(current), status: result.status, location: cutUrl(next.href) });
          current = next.href;
          status = null;
          continue;
        }
        headers = keptHeaders(result.headers, keep);
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
