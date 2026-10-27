// Spec: specs/seo-javascript.spec.ts (SERVED_FETCH_LIMITS, SERVED_ACCEPT, SERVED_UNAVAILABLE_REASONS), specs/fetcher.spec.ts
// Acceptance: specs/seo-javascript.feature.md (Fetching)
import { describe, expect, test, vi } from 'vitest';
import type { BoundedFetcher, BoundedFetchRequest, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS } from '@app/specs/seo-javascript.spec';
import { ServedStateSchema, type ServedParseInput, type ServedParseResult } from '@app/specs/seo-javascript.schema';
import { createServedHtml } from '../served';
import { parseServedHtml } from '../served-parse';

const PAGE = 'https://example.com/guide';
const HTML = new TextEncoder().encode('<html><head><title>Served</title></head><body><p>Hello world</p></body></html>');

function result(changes: Partial<BoundedFetchResult> = {}): BoundedFetchResult {
  return { url: PAGE, outcome: 'response', status: 200, finalUrl: PAGE, redirects: 0, chain: [], headers: { 'content-type': 'text/html; charset=utf-8' }, body: HTML, truncated: false, durationMs: 12, ...changes };
}

function setup(answer: (request: BoundedFetchRequest) => BoundedFetchResult = () => result(), parse?: (input: ServedParseInput) => Promise<ServedParseResult>) {
  const requests: BoundedFetchRequest[] = [];
  const fetcher: BoundedFetcher = {
    fetch: vi.fn(async (request: BoundedFetchRequest) => {
      requests.push(request);
      return answer(request);
    }),
    load: () => ({ running: 0, queued: 0 }),
  };
  const parsed = vi.fn(parse ?? (async (input: ServedParseInput) => parseServedHtml(input)));
  const served = createServedHtml({ fetcher, parse: parsed });
  return { served, requests, parsed };
}

describe('served HTML', () => {
  test('served-fetch-request', async () => {
    const { served, requests, parsed } = setup();
    const state = await served.get(1, `${PAGE}#section`, 'Googlebot/2.1');
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ url: PAGE, page: PAGE, userAgent: 'Googlebot/2.1', accept: SERVED_ACCEPT, maxBytes: SERVED_FETCH_LIMITS.maxBytes, timeoutMs: SERVED_FETCH_LIMITS.timeoutMs, maxRedirects: SERVED_FETCH_LIMITS.maxRedirects, keepHeaders: ['content-type'] });
    expect(request.method ?? 'GET').toBe('GET');
    expect(request.readBody!(200)).toBe(true);
    expect(request.readBody!(404)).toBe(false);
    expect(parsed).toHaveBeenCalledWith({ url: PAGE, contentType: 'text/html; charset=utf-8', body: HTML });
    expect(ServedStateSchema.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({ status: 'ready', fetch: { url: PAGE, finalUrl: PAGE, status: 200, bytes: HTML.byteLength, userAgent: 'Googlebot/2.1', truncated: false } });
    // Frost's own user agent: none is set.
    await served.get(2, PAGE, null);
    expect(requests[1]!.userAgent).toBeNull();
  });

  test('served-is-cached-per-document', async () => {
    const { served, requests } = setup();
    const first = served.get(1, PAGE, null);
    expect(served.peek(1, PAGE, null)).toBeUndefined();
    expect(await served.get(1, `${PAGE}#other`, null)).toBe(await first);
    expect(served.peek(1, PAGE, null)).toBe(await first);
    expect(requests).toHaveLength(1);
    // Another user agent, URL or tab document fetches again.
    await served.get(1, PAGE, 'Bingbot');
    await served.get(1, `${PAGE}/next`, null);
    await served.get(2, PAGE, null);
    expect(requests).toHaveLength(4);
    // Fetch again drops every user agent of that URL, for that tab only.
    served.drop(1, PAGE);
    expect(served.peek(1, PAGE, null)).toBeUndefined();
    expect(served.peek(1, PAGE, 'Bingbot')).toBeUndefined();
    expect(served.peek(1, `${PAGE}/next`, null)).toBeDefined();
    expect(served.peek(2, PAGE, null)).toBeDefined();
    // A new document, and Clear Browsing Data.
    served.forget(1);
    expect(served.size(1)).toBe(0);
    served.clear();
    expect(served.size(2)).toBe(0);
    await served.get(2, PAGE, null);
    expect(requests).toHaveLength(5);
    // At most `maxCachedPerTab` per tab.
    for (let i = 0; i < SERVED_FETCH_LIMITS.maxCachedPerTab + 3; i++) await served.get(3, `${PAGE}?p=${i}`, null);
    expect(served.size(3)).toBe(SERVED_FETCH_LIMITS.maxCachedPerTab);
  });

  test('served-never-fetches-non-web', async () => {
    const { served, requests } = setup();
    for (const url of ['about:blank', 'file:///etc/passwd', 'app://app/', 'data:text/html,x', '']) expect(await served.get(1, url, null), url).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null, finalUrl: null });
    expect(requests).toHaveLength(0);
  });

  test('served-states-of-failures', async () => {
    const cases: [Partial<BoundedFetchResult>, unknown][] = [
      [{ status: 404, body: new Uint8Array(0) }, { status: 'unavailable', reason: 'http-status', httpStatus: 404, finalUrl: PAGE }],
      [{ headers: { 'content-type': 'application/pdf' } }, { status: 'unavailable', reason: 'not-html' }],
      [{ outcome: 'timeout', status: null, finalUrl: null }, { status: 'unavailable', reason: 'timeout', httpStatus: null }],
      [{ outcome: 'private-redirect', status: 302 }, { status: 'unavailable', reason: 'private-redirect', httpStatus: 302 }],
      [{ outcome: 'unreachable', status: null, finalUrl: null }, { status: 'unavailable', reason: 'unreachable' }],
      [{ outcome: 'aborted', status: null, finalUrl: null }, { status: 'unavailable', reason: 'unreachable' }],
      [{ outcome: 'busy', status: null, finalUrl: null }, { status: 'unavailable', reason: 'busy' }],
    ];
    for (const [changes, expected] of cases) {
      const { served, parsed } = setup(() => result(changes));
      const state = await served.get(1, PAGE, null);
      expect(state, JSON.stringify(changes)).toMatchObject(expected as object);
      expect(ServedStateSchema.safeParse(state).success).toBe(true);
      expect(parsed).not.toHaveBeenCalled();
    }
    // A missing Content-Type and XHTML are parsed.
    expect((await setup(() => result({ headers: {} })).served.get(1, PAGE, null)).status).toBe('ready');
    expect((await setup(() => result({ headers: { 'content-type': 'application/xhtml+xml' } })).served.get(1, PAGE, null)).status).toBe('ready');
    // The worker failed or timed out.
    const timedOut = setup(undefined, async () => ({ ok: false, reason: 'parse-timeout' }));
    expect(await timedOut.served.get(1, PAGE, null)).toMatchObject({ status: 'unavailable', reason: 'parse-timeout', httpStatus: 200 });
    const rejected = setup(undefined, () => Promise.reject(new Error('gone')));
    expect(await rejected.served.get(1, PAGE, null)).toMatchObject({ status: 'unavailable', reason: 'parse-failed' });
    // The parse reads from the URL that answered (after redirects).
    const moved = setup(() => result({ finalUrl: 'https://example.com/moved', redirects: 1 }));
    expect(await moved.served.get(1, PAGE, null)).toMatchObject({ status: 'ready', fetch: { finalUrl: 'https://example.com/moved', redirects: 1 }, snapshot: { url: 'https://example.com/moved' } });
  });
});
