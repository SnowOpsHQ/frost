import type { Session } from 'electron';
import { ROBOTS_FETCH_LIMITS, ROBOTS_TRANSIENT_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// Main's robots.txt fetch (spec `seo-indexability.spec.ts`, `ROBOTS_FETCH_LIMITS`,
// `ROBOTS_FETCH_OUTCOMES`; acceptance `seo-indexability.feature.md`, robots.txt fetch; review focus
// `robots-fetch-is-bounded`). For a page it asks for `<page origin>/robots.txt` only: one hop at a
// time (`hop`), each redirect checked before it is followed (at most `maxRedirects`, `http(s)`
// only, never to a private host unless the page is on one), the body read up to `maxBytes`,
// everything under one `timeoutMs` deadline. Answers are cached per origin (`cacheTtlMs`,
// `failureTtlMs` for transient failures, at most `maxCacheEntries`), and concurrent requests for an
// origin share one fetch. The body is kept as bytes, never decoded or parsed here: the analysis
// worker does (`@app/seo-core`, `decodeRobotsBytes`, `parseRobotsTxt`).

/** One HTTP exchange: a redirect (not followed), or a response whose body can be read. */
export type HopResult =
  | { readonly kind: 'redirect'; readonly status: number; readonly location: string | null }
  | { readonly kind: 'response'; readonly status: number; readonly body: AsyncIterable<Uint8Array>; cancel(): void };

/** Requests `url` once, never following a redirect; rejects on a network error or when `signal` aborts. */
export type Hop = (url: string, signal: AbortSignal) => Promise<HopResult>;

export interface RobotsFetcherOptions {
  readonly hop: Hop;
  /** Wall clock in ms, for the cache (injectable for tests). */
  readonly now?: () => number;
  readonly limits?: Partial<typeof ROBOTS_FETCH_LIMITS>;
}

export interface RobotsFetcher {
  /** The robots.txt of `pageUrl`'s origin (cached), or `null` for a non-`http(s)` page. Never rejects. */
  get(pageUrl: string): Promise<RobotsFetch | null>;
  /** What `get` would answer at once: the cached, settled answer; `undefined` when there is none yet (or it is still being fetched); `null` for a non-`http(s)` page. */
  peek(pageUrl: string): RobotsFetch | null | undefined;
  /** Forgets every origin (Clear Browsing Data); a fetch in flight is not cached when it settles. */
  clear(): void;
  /** How many origins are cached (for tests). */
  size(): number;
}

const TRANSIENT: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_TRANSIENT_OUTCOMES);
const EMPTY = new Uint8Array(0);

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
 * Whether `hostname` (`URL.hostname`) is a private host (`ROBOTS_FETCH_LIMITS`, private addresses):
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

const cutUrl = (value: string): string => value.slice(0, SNAPSHOT_LIMITS.maxUrlChars);

/** The outcome of a final HTTP status (`ROBOTS_FETCH_OUTCOMES`). */
export function outcomeOf(status: number): RobotsFetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'server-error';
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 400) return 'unavailable';
  // A 3xx answered as a response has no Location.
  if (status >= 300) return 'no-location';
  // 1xx (never final) and anything odd: unknown.
  return 'server-error';
}

/** Reads `body` up to `maxBytes` bytes (then stops reading): the bytes and whether there was more. */
async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; truncated: boolean }> {
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

export function createRobotsFetcher(options: RobotsFetcherOptions): RobotsFetcher {
  const limits = { ...ROBOTS_FETCH_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { expires: number; value: Promise<RobotsFetch>; settled?: RobotsFetch }>();

  async function fetchRobots(robotsUrl: string, pageIsPrivate: boolean): Promise<RobotsFetch> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    let current = robotsUrl;
    let redirects = 0;
    let status: number | null = null;
    const ended = (outcome: RobotsFetchOutcome, extra: Partial<RobotsFetch> = {}): RobotsFetch => ({
      url: cutUrl(robotsUrl),
      outcome,
      status,
      finalUrl: status === null ? null : cutUrl(current),
      redirects,
      body: EMPTY,
      truncated: false,
      ...extra,
    });
    // The deadline also wins against a hop that never settles.
    const deadline = new Promise<'timeout'>((resolve) => controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true }));
    try {
      for (;;) {
        const result = await Promise.race([options.hop(current, controller.signal), deadline]);
        if (result === 'timeout') return ended('timeout');
        status = result.status;
        if (result.kind === 'redirect') {
          if (redirects >= limits.maxRedirects) return ended('too-many-redirects');
          if (result.location === null) return ended('no-location');
          const next = parseWebUrl(safeResolve(result.location, current));
          if (!next) return ended('bad-redirect');
          if (!pageIsPrivate && isPrivateHost(next.hostname)) return ended('private-redirect');
          redirects += 1;
          current = next.href;
          status = null;
          continue;
        }
        const outcome = outcomeOf(result.status);
        if (outcome !== 'ok') {
          result.cancel();
          return ended(outcome);
        }
        const read = await Promise.race([readCapped(result.body, limits.maxBytes), deadline]);
        result.cancel();
        if (read === 'timeout') return ended('timeout');
        return ended('ok', { body: read.bytes, truncated: read.truncated });
      }
    } catch {
      return controller.signal.aborted ? ended('timeout') : ended('unreachable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** The live cache entry for `origin` (an expired one is dropped). */
  const fresh = (origin: string) => {
    const cached = cache.get(origin);
    if (cached && cached.expires > now()) return cached;
    cache.delete(origin);
    return undefined;
  };

  return {
    get(pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return Promise.resolve(null);
      const origin = page.origin;
      const cached = fresh(origin);
      if (cached) return cached.value;
      const value = fetchRobots(`${origin}/robots.txt`, isPrivateHost(page.hostname));
      // In flight: shared until it settles, then kept for its TTL.
      const entry: { expires: number; value: Promise<RobotsFetch>; settled?: RobotsFetch } = { expires: Number.POSITIVE_INFINITY, value };
      cache.set(origin, entry);
      while (cache.size > limits.maxCacheEntries) cache.delete(cache.keys().next().value!);
      void value.then((fetched) => {
        entry.settled = fetched;
        entry.expires = now() + (TRANSIENT.has(fetched.outcome) ? limits.failureTtlMs : limits.cacheTtlMs);
      });
      return value;
    },
    peek(pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return null;
      return fresh(page.origin)?.settled;
    },
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}

/** What the audit sees while `pageUrl`'s robots.txt is still being fetched (`pending`); `null` for a non-`http(s)` page. */
export function pendingRobots(pageUrl: string): RobotsFetch | null {
  const page = parseWebUrl(pageUrl);
  if (!page) return null;
  return { url: cutUrl(`${page.origin}/robots.txt`), outcome: 'pending', status: null, finalUrl: null, redirects: 0, body: EMPTY, truncated: false };
}

/** `location` resolved against `base`, or `''` when it does not parse. */
function safeResolve(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    return '';
  }
}

/** The parts of Electron's `net` the hop uses. */
export interface NetRequester {
  request(options: Electron.ClientRequestConstructorOptions): Electron.ClientRequest;
}

/**
 * A hop through `session` (the browse session) with Electron's `net.request`: `GET`, cookies and
 * credentials off (`credentials: 'omit'`, so no `login` prompt either), no referrer, bypassing
 * the HTTP cache (`no-store`), and `redirect: 'manual'` so a redirect is reported, never followed
 * (the request is aborted at it). `net.fetch` / `session.fetch` cannot be used: with
 * `redirect: 'manual'` they reject ("Redirect was cancelled") instead of answering the 3xx.
 */
export function netHop(net: NetRequester, session: Session): Hop {
  return (url, signal) =>
    new Promise<HopResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const request = net.request({ url, session, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
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
        resolve({ kind: 'response', status: response.statusCode, body: response as unknown as AsyncIterable<Uint8Array>, cancel: abort });
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.end();
    });
}
