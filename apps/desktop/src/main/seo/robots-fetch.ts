import type { Session } from 'electron';
import { ROBOTS_FETCH_LIMITS, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// Main's robots.txt fetch (spec `seo-indexability.spec.ts`, `ROBOTS_FETCH_LIMITS`,
// `ROBOTS_FETCH_OUTCOMES`; acceptance `seo-indexability.feature.md`, robots.txt fetch; review focus
// `robots-fetch-is-bounded`). For a page it asks for `<page origin>/robots.txt` only: one hop at a
// time (`hop`), each redirect checked before it is followed (at most `maxRedirects`, `http(s)`
// only), the body read up to `maxBytes`, everything under one `timeoutMs` deadline. Answers are
// cached per origin (`cacheTtlMs`, `failureTtlMs` for failures, at most `maxCacheEntries`), and
// concurrent requests for an origin share one fetch. The text is never parsed here: the analysis
// worker does (`@app/seo-core`, `parseRobotsTxt`).

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
  /** How many origins are cached (for tests). */
  size(): number;
}

const FAILURES: ReadonlySet<RobotsFetchOutcome> = new Set(['server-error', 'unreachable', 'timeout', 'bad-redirect']);

const cutUrl = (value: string): string => value.slice(0, SNAPSHOT_LIMITS.maxUrlChars);

/** The outcome of a final HTTP status (`ROBOTS_FETCH_OUTCOMES`). */
export function outcomeOf(status: number): RobotsFetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'server-error';
  if (status >= 400) return 'unavailable';
  // A 3xx answered as a response has no usable Location.
  if (status >= 300) return 'bad-redirect';
  // 1xx (never final) and anything odd: unknown.
  return 'server-error';
}

/** Reads `body` up to `maxBytes` bytes (then stops reading): the bytes and whether there was more. */
async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
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
  const cache = new Map<string, { expires: number; value: Promise<RobotsFetch> }>();

  async function fetchRobots(robotsUrl: string): Promise<RobotsFetch> {
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
      text: '',
      bytes: 0,
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
          if (redirects >= limits.maxRedirects) return ended('unavailable');
          const next = result.location === null ? null : parseWebUrl(safeResolve(result.location, current));
          if (!next) return ended('bad-redirect');
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
        return ended('ok', { text: new TextDecoder('utf-8').decode(read.bytes), bytes: read.bytes.byteLength, truncated: read.truncated });
      }
    } catch {
      return controller.signal.aborted ? ended('timeout') : ended('unreachable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    get(pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return Promise.resolve(null);
      const origin = page.origin;
      const at = now();
      const cached = cache.get(origin);
      if (cached && cached.expires > at) return cached.value;
      cache.delete(origin);
      const value = fetchRobots(`${origin}/robots.txt`);
      // In flight: shared until it settles, then kept for its TTL.
      const entry = { expires: Number.POSITIVE_INFINITY, value };
      cache.set(origin, entry);
      while (cache.size > limits.maxCacheEntries) cache.delete(cache.keys().next().value!);
      void value.then((fetched) => {
        entry.expires = now() + (FAILURES.has(fetched.outcome) ? limits.failureTtlMs : limits.cacheTtlMs);
      });
      return value;
    },
    size: () => cache.size,
  };
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
