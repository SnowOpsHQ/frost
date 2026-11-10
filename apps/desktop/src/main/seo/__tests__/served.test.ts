// Spec: specs/seo-javascript.spec.ts (SERVED_FETCH_LIMITS, SERVED_ACCEPT, SERVED_UNAVAILABLE_REASONS, SERVED_SOURCE_MAX_CHARS,
// SERVED_SOURCE_KEEP), specs/seo-javascript.schema.ts (ServedParseResult's sourceText), specs/fetcher.spec.ts
// Acceptance: specs/seo-javascript.feature.md (Fetching; Phase 11 Task 5: served-source-decoded-in-worker-and-capped,
// served-source-kept-for-four-documents)
import { describe, expect, test, vi } from 'vitest';
import type { BoundedFetcher, BoundedFetchRequest, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS, SERVED_LEAD_TEXT_MAX_CHARS, SERVED_SOURCE_KEEP, SERVED_SOURCE_MAX_CHARS } from '@app/specs/seo-javascript.spec';
import { ServedStateSchema, type ServedParseInput, type ServedParseResult } from '@app/specs/seo-javascript.schema';
import { createServedHtml } from '../served';
import { parseServedHtml } from '../served-parse';
import { SERVED_PARSE_LIMITS } from '@app/specs/seo-javascript.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';

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
    expect(parsed).toHaveBeenCalledWith({ url: PAGE, contentType: 'text/html; charset=utf-8', body: HTML, scriptingEnabled: true });
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
    // A redirect that ends back at the page (its fragment aside) is the page.
    const back = setup(() => result({ finalUrl: `${PAGE}#top`, redirects: 1 }));
    expect(await back.served.get(1, PAGE, null)).toMatchObject({ status: 'ready', fetch: { redirects: 1 } });
  });

  test('served-long-url-is-not-a-redirect', async () => {
    // The fetcher cuts `finalUrl` to `maxUrlChars`; a longer page that answered without a redirect is still that page.
    // Long in its path: cut there, the base would lose the page's own directory.
    const long = `https://example.com/${'a/'.repeat(SNAPSHOT_LIMITS.maxUrlChars / 2)}guide/page`;
    const html = new TextEncoder().encode('<html><head><title>Long</title></head><body><a href="next">Next</a></body></html>');
    const { served, parsed } = setup((request) => result({ url: request.url.slice(0, SNAPSHOT_LIMITS.maxUrlChars), finalUrl: request.url.slice(0, SNAPSHOT_LIMITS.maxUrlChars), body: html }));
    const state = await served.get(1, long, null);
    expect(state).toMatchObject({ status: 'ready', fetch: { redirects: 0 } });
    expect(ServedStateSchema.safeParse(state).success).toBe(true);
    // The document's links resolve against the whole URL, not the cut one; what is stored and shown is cut.
    expect(parsed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: long }));
    if (state.status === 'ready') expect(state.fetch.finalUrl).toBe(long.slice(0, SNAPSHOT_LIMITS.maxUrlChars));
  });

  test('served-redirected-elsewhere', async () => {
    // A fetch without cookies sent to the login page (302 → /login): not the page that was rendered.
    const { served, parsed } = setup(() => result({ finalUrl: 'https://example.com/login', redirects: 1 }));
    const state = await served.get(1, PAGE, null);
    expect(state).toEqual({ status: 'unavailable', reason: 'redirected', httpStatus: 200, finalUrl: 'https://example.com/login' });
    expect(ServedStateSchema.safeParse(state).success).toBe(true);
    expect(parsed).not.toHaveBeenCalled();
  });

  test('served-aborted-on-navigation', async () => {
    const signals: AbortSignal[] = [];
    const fetcher: BoundedFetcher = {
      fetch: (request) => {
        signals.push(request.signal!);
        return new Promise(() => undefined);
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    const served = createServedHtml({ fetcher, parse: async () => ({ ok: false, reason: 'parse-failed' }) });
    void served.get(1, PAGE, null);
    void served.get(1, `${PAGE}/b`, null);
    void served.get(2, PAGE, null);
    // A new document in tab 1 aborts its fetches in flight, not tab 2's.
    served.forget(1);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    served.drop(2, PAGE);
    expect(signals[2]!.aborted).toBe(true);
    void served.get(3, PAGE, null);
    served.clear();
    expect(signals[3]!.aborted).toBe(true);
  });

  test('served-scripting-follows-the-profile', async () => {
    const { served, requests, parsed } = setup();
    await served.get(1, PAGE, null, { scripting: false });
    expect(parsed).toHaveBeenLastCalledWith(expect.objectContaining({ scriptingEnabled: false }));
    expect(served.peek(1, PAGE, null, { scripting: false })).toBeDefined();
    // Another key: scripting on is fetched again.
    expect(served.peek(1, PAGE, null)).toBeUndefined();
    await served.get(1, PAGE, null);
    expect(requests).toHaveLength(2);
    // `<noscript>` content is markup without scripting: it counts as words and links of the page.
    const html = new TextEncoder().encode('<html><head><title>T</title></head><body><p>one</p><noscript><p>two three</p><a href="/x">x</a></noscript></body></html>');
    const off = parseServedHtml({ url: PAGE, contentType: 'text/html', body: html, scriptingEnabled: false });
    const on = parseServedHtml({ url: PAGE, contentType: 'text/html', body: html });
    expect(off.ok && on.ok).toBe(true);
    if (off.ok && on.ok) {
      expect(off.snapshot.links.map((l) => l.href)).toEqual(['https://example.com/x']);
      expect(on.snapshot.links).toEqual([]);
      expect(off.snapshot.noscript).toEqual({ count: 1, wordCount: 3, linkCount: 1 });
      expect(on.snapshot.noscript).toEqual({ count: 1, wordCount: 3, linkCount: 1 });
    }
  });

  test('served-snapshot-without-lead-text-still-valid', async () => {
    // `leadText` is optional (Phase 9 Task 10): a snapshot from before it, or one without it, is
    // still a valid served state and reads as "no lead text".
    const { served } = setup();
    const state = await served.get(1, PAGE, null);
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.snapshot.leadText).toBe('Hello world');
    const { leadText: _dropped, ...without } = state.snapshot;
    expect(ServedStateSchema.safeParse({ ...state, snapshot: without }).success).toBe(true);
    // Over its cap it is not a served snapshot.
    expect(ServedStateSchema.safeParse({ ...state, snapshot: { ...without, leadText: 'x'.repeat(SERVED_LEAD_TEXT_MAX_CHARS + 1) } }).success).toBe(false);
  });

  test('served-source-decoded-in-worker-and-capped', async () => {
    // The worker's parse decodes the bytes (a meta charset honoured) and answers the text with the parse.
    const latin = Uint8Array.from([...new TextEncoder().encode('<html><head><meta charset="windows-1252"><title>Caf'), 0xe9, ...new TextEncoder().encode('</title></head><body>x</body></html>')]);
    const parsed = parseServedHtml({ url: PAGE, contentType: 'text/html', body: latin });
    expect(parsed).toMatchObject({ ok: true, sourceText: '<html><head><meta charset="windows-1252"><title>Café</title></head><body>x</body></html>', sourceTruncated: false });
    // Cut at the cap, never splitting a surrogate pair.
    const emoji = new TextEncoder().encode('<p>abcdefgh😀😀</p>');
    expect(parseServedHtml({ url: PAGE, contentType: 'text/html', body: emoji }, SERVED_PARSE_LIMITS, SNAPSHOT_LIMITS, 12)).toMatchObject({ ok: true, sourceText: '<p>abcdefgh', sourceTruncated: true });
    expect(parseServedHtml({ url: PAGE, contentType: 'text/html', body: emoji }, SERVED_PARSE_LIMITS, SNAPSHOT_LIMITS, 13)).toMatchObject({ ok: true, sourceText: '<p>abcdefgh😀', sourceTruncated: true });
    const big = parseServedHtml({ url: PAGE, contentType: 'text/html', body: new TextEncoder().encode(`<p>${'x'.repeat(SERVED_SOURCE_MAX_CHARS)}</p>`) });
    expect(big.ok && big.sourceText?.length === SERVED_SOURCE_MAX_CHARS && big.sourceTruncated).toBe(true);

    // Main keeps what the worker answered beside the state (never in it), and never decodes itself.
    const { served } = setup();
    const state = await served.get(1, PAGE, null);
    expect(ServedStateSchema.safeParse(state).success).toBe(true);
    expect(JSON.stringify(state)).not.toContain('sourceText');
    expect(served.source(1, `${PAGE}#x`, null)).toEqual({ status: 'ready', ref: expect.any(Number), text: new TextDecoder().decode(HTML), truncated: false });
    // Another key: nothing fetched for it.
    expect(served.source(1, PAGE, 'Bingbot')).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null });
    expect(served.source(1, PAGE, null, { scripting: false })).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null });
    // Fetched bytes that were cut, or text the worker cut, are flagged.
    const cutBytes = setup(() => result({ truncated: true }));
    await cutBytes.served.get(1, PAGE, null);
    expect(cutBytes.served.source(1, PAGE, null)).toMatchObject({ status: 'ready', truncated: true });
    const cutText = setup(undefined, async (input) => ({ ...parseServedHtml(input), sourceText: 'cut', sourceTruncated: true }) as ServedParseResult);
    await cutText.served.get(1, PAGE, null);
    expect(cutText.served.source(1, PAGE, null)).toMatchObject({ status: 'ready', text: 'cut', truncated: true });
    // A source that is not a capped string is not kept: the state stays ready, the source reads as not fetched.
    for (const bad of ['x'.repeat(SERVED_SOURCE_MAX_CHARS + 1), 5, { text: 'x' }, undefined]) {
      const odd = setup(undefined, async (input) => ({ ...parseServedHtml(input), sourceText: bad }) as unknown as ServedParseResult);
      expect((await odd.served.get(1, PAGE, null)).status).toBe('ready');
      expect(odd.served.source(1, PAGE, null)).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null });
    }
    // The states before and beside it.
    const slow = setup(undefined, () => new Promise(() => undefined));
    void slow.served.get(1, PAGE, null);
    expect(slow.served.source(1, PAGE, null)).toEqual({ status: 'pending' });
    const failing = setup(() => result({ status: 503, body: new Uint8Array(0) }));
    await failing.served.get(1, PAGE, null);
    expect(failing.served.source(1, PAGE, null)).toEqual({ status: 'unavailable', reason: 'http-status', httpStatus: 503 });
    expect(served.source(1, 'about:blank', null)).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null });
  });

  test('served-source-kept-for-four-documents', async () => {
    expect(SERVED_SOURCE_KEEP).toBe(4);
    const { served } = setup((request) => result({ url: request.url, finalUrl: request.url }));
    const kept = (id: number, url = PAGE) => served.source(id, url, null).status === 'ready';
    for (let id = 1; id <= SERVED_SOURCE_KEEP + 1; id++) await served.get(id, PAGE, null);
    // The oldest document's source went; its served state stays.
    expect([1, 2, 3, 4, 5].map((id) => kept(id))).toEqual([false, true, true, true, true]);
    expect(served.peek(1, PAGE, null)?.status).toBe('ready');
    // Kept per document over all tabs: a second URL in tab 2 is one more document.
    await served.get(2, `${PAGE}/next`, null);
    expect([2, 3].map((id) => kept(id))).toEqual([false, true]);
    expect(kept(2, `${PAGE}/next`)).toBe(true);
    // Each answer has its own ref, and a fetch again is a new one.
    const refOf = (id: number, url = PAGE) => {
      const source = served.source(id, url, null);
      return source.status === 'ready' ? source.ref : null;
    };
    const refs = [refOf(3), refOf(4), refOf(5), refOf(2, `${PAGE}/next`)];
    expect(new Set(refs).size).toBe(4);
    // `forget` (a new document) bumps the tab document's generation; nothing else does.
    expect(served.generation(4)).toBe(0);
    served.drop(5, PAGE);
    await served.get(5, PAGE, null);
    expect(served.generation(5)).toBe(0);
    expect(refOf(5)).not.toBe(refs[2]);
    expect(refOf(5)).toBeGreaterThan(refs[2]!);
    // Fetch again, a new document and Clear Browsing Data drop the source with its answer.
    served.drop(3, PAGE);
    expect(kept(3)).toBe(false);
    served.forget(4);
    expect(kept(4)).toBe(false);
    expect(served.generation(4)).toBe(1);
    served.forget(4);
    expect(served.generation(4)).toBe(2);
    served.clear();
    expect(kept(5)).toBe(false);
    expect(kept(2, `${PAGE}/next`)).toBe(false);
    // A source settling after its answer was dropped is not kept.
    let finish: (value: ServedParseResult) => void = () => undefined;
    const late = setup(undefined, () => new Promise<ServedParseResult>((resolve) => (finish = resolve)));
    const pendingState = late.served.get(1, PAGE, null);
    await vi.waitFor(() => expect(late.parsed).toHaveBeenCalled());
    late.served.forget(1);
    finish(parseServedHtml({ url: PAGE, contentType: 'text/html', body: HTML }));
    await pendingState;
    expect(late.served.source(1, PAGE, null)).toEqual({ status: 'unavailable', reason: 'not-fetched', httpStatus: null });
  });
});
