import type { Session } from 'electron';
import type { CheckFetchOutcome } from '@app/specs/seo-checks.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { isPrivateHost, netHop, type HopResult, type NetRequester } from './robots-fetch';

// The checks' one door to the network (spec `seo-checks.spec.ts`, `CHECK_FETCH_OUTCOMES`; Global
// Constraints, fetching on the user's behalf; review focus `link-checks-are-bounded`). The link,
// sitemap and hreflang checks only ever see `CheckFetch`: one URL, one method, its caps, answered
// with how it ended, the final status and URL, the redirects followed, the body as bytes (at most
// `maxBytes`) and the few headers the checks read. It never rejects.
//
// Every request is the robots.txt fetcher's kind (`robots-fetch.ts`): the browse session, cookies
// and credentials off, no referrer, the HTTP cache bypassed, `http(s)` only, one hop at a time with
// each redirect checked before it is followed (at most `maxRedirects`, never to a private host unless
// `allowPrivate`, which the caller sets only when the page itself is on one), the body read up to
// `maxBytes` and then the connection aborted, everything under one `timeoutMs` deadline.

/** The response headers the checks read (lowercased names; `null`: not sent). */
export interface CheckFetchHeaders {
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly link: string | null;
}

export interface CheckFetchOptions {
  readonly method: 'HEAD' | 'GET';
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  /** Redirects to private hosts are followed (the page itself is on one). */
  readonly allowPrivate: boolean;
  /** The `User-Agent` to send (the tab's render profile's), `null` for frost's own. */
  readonly userAgent: string | null;
  /** Aborts the request (the run was stopped or cancelled): answered `aborted`. */
  readonly signal: AbortSignal;
}

export interface CheckFetchResult {
  readonly outcome: CheckFetchOutcome;
  /** The final HTTP status (`null`: no response). */
  readonly status: number | null;
  /** The URL that answered (or the last one tried). */
  readonly finalUrl: string;
  readonly redirects: number;
  readonly body: Uint8Array;
  /** The body was longer than `maxBytes` (or exactly as long: more may have followed). */
  readonly truncated: boolean;
  readonly headers: CheckFetchHeaders;
}

/** Fetches `url` once, bounded by `options`; never rejects. */
export type CheckFetch = (url: string, options: CheckFetchOptions) => Promise<CheckFetchResult>;

/** One HTTP exchange, as the robots.txt fetcher's `Hop`, with a method, a user agent and the headers the checks read. */
export type CheckHop = (
  url: string,
  request: { readonly method: 'HEAD' | 'GET'; readonly userAgent: string | null },
  signal: AbortSignal,
) => Promise<Extract<HopResult, { kind: 'redirect' }> | (Omit<Extract<HopResult, { kind: 'response' }>, 'headers'> & { readonly headers?: CheckFetchHeaders })>;

const EMPTY = new Uint8Array(0);
const NO_HEADERS: CheckFetchHeaders = { contentType: null, contentEncoding: null, link: null };
const cutUrl = (value: string): string => value.slice(0, SNAPSHOT_LIMITS.maxUrlChars);

/** Reads `body` up to `maxBytes` bytes (then stops): the bytes and whether there was more. */
async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  for await (const chunk of body) {
    const room = maxBytes - length;
    if (chunk.byteLength >= room) {
      chunks.push(chunk.subarray(0, room));
      length += room;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    length += chunk.byteLength;
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

/**
 * The checks' `CheckFetch` over `hop`: the robots.txt fetcher's redirect, private-host, size and
 * deadline rules, for any method and cap.
 *
 * TODO(integration): switch to seo/fetcher.ts (Phase 2.5 Task 2's shared bounded fetcher), which
 * replaces this loop, `readCapped` and the hop below; `CheckFetch` stays the checks' interface.
 */
export function createCheckFetch(hop: CheckHop): CheckFetch {
  return async (url, options) => {
    let current = url;
    let redirects = 0;
    let status: number | null = null;
    let headers = NO_HEADERS;
    const ended = (outcome: CheckFetchOutcome, extra: Partial<CheckFetchResult> = {}): CheckFetchResult => ({ outcome, status, finalUrl: cutUrl(current), redirects, body: EMPTY, truncated: false, headers, ...extra });
    if (options.signal.aborted) return ended('aborted');
    const start = parseWebUrl(url);
    if (!start) return ended('bad-redirect');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    // The deadline (or a stop) also wins against a hop that never settles.
    const deadline = new Promise<'abort'>((resolve) => controller.signal.addEventListener('abort', () => resolve('abort'), { once: true }));
    const stopped = (): CheckFetchResult => ended(options.signal.aborted ? 'aborted' : 'timeout');
    try {
      for (;;) {
        const result = await Promise.race([hop(current, { method: options.method, userAgent: options.userAgent }, controller.signal), deadline]);
        if (result === 'abort') return stopped();
        status = result.status;
        headers = result.kind === 'response' ? (result.headers ?? NO_HEADERS) : NO_HEADERS;
        if (result.kind === 'redirect') {
          if (redirects >= options.maxRedirects) return ended('too-many-redirects');
          if (result.location === null) return ended('no-location');
          const next = parseWebUrl(safeResolve(result.location, current));
          if (!next) return ended('bad-redirect');
          if (!options.allowPrivate && isPrivateHost(next.hostname)) return ended('private-redirect', { finalUrl: cutUrl(next.href) });
          redirects += 1;
          current = next.href;
          status = null;
          headers = NO_HEADERS;
          continue;
        }
        if (options.method === 'HEAD' || options.maxBytes === 0) {
          result.cancel();
          return ended('response');
        }
        const read = await Promise.race([readCapped(result.body, options.maxBytes), deadline]);
        result.cancel();
        if (read === 'abort') return stopped();
        return ended('response', { body: read.bytes, truncated: read.truncated });
      }
    } catch {
      return controller.signal.aborted ? stopped() : ended('unreachable');
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  };
}

/** The first value of header `name` in Electron's `IncomingMessage.headers`. */
function headerOf(headers: unknown, name: string, max: number): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const value = (headers as Record<string, unknown>)[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.slice(0, max) : null;
}

/** A `User-Agent` safe to send: printable ASCII only (anything else, frost's own). */
function safeUserAgent(value: string | null): string | null {
  return value !== null && value !== '' && value.length <= 512 && /^[\x20-\x7e]+$/.test(value) ? value : null;
}

/**
 * The checks' hop through `session` (the browse session): the robots.txt fetcher's `netHop`
 * (`net.request`, `credentials: 'omit'`, no session cookies, no referrer, `no-store`,
 * `redirect: 'manual'`) with the check's method and, when the tab has a render profile, its user
 * agent; and the headers the checks read from the response.
 *
 * TODO(integration): switch to seo/fetcher.ts (Phase 2.5 Task 2's shared bounded fetcher).
 */
export function netCheckHop(net: NetRequester, session: Session): CheckHop {
  return async (url, request, signal) => {
    const result = await netHop(net, session)(url, signal, { method: request.method, userAgent: safeUserAgent(request.userAgent) });
    if (result.kind === 'redirect') return result;
    const raw = result.headers;
    return { ...result, headers: { contentType: headerOf(raw, 'content-type', 256), contentEncoding: headerOf(raw, 'content-encoding', 64), link: headerOf(raw, 'link', 8_192) } };
  };
}
