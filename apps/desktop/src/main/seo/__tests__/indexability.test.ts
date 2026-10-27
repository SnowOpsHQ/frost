// Spec: specs/seo-indexability.spec.ts (RESPONSE_HEADER_ALLOWLIST, RESPONSE_LIMITS, RESPONSE_SOURCES,
// ROBOTS_FETCH_LIMITS, ROBOTS_FETCH_OUTCOMES), specs/seo-snapshot.spec.ts (PageContextSchema, HreflangLinkSchema)
// Acceptance: specs/seo-indexability.feature.md (Response metadata, robots.txt fetch, Collected beside the snapshot)
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OnBeforeRedirectListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails } from 'electron';
import { RESPONSE_LIMITS, ROBOTS_FETCH_LIMITS } from '@app/specs/seo-indexability.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS } from '@app/specs/seo-limits.spec';
import { PageContextSchema, PageSnapshotSchema, type ExtractedSnapshot, type PageContext, type RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type HostWindow, type TabView } from '../../browser/controller';
import { MAIN_FRAME_FILTER, observeMainFrames, type ObservedSession } from '../../browser/web-request';
import { analyseSnapshot } from '../analyse';
import type { AnalysisResult } from '../analysis';
import { CONTEXT_TIMEOUT_MS, type ContextSource } from '../auditor';
import { extractPage, type PageDocument } from '../extract';
import { extractSecurity, RESOURCE_SELECTOR, type SecurityDocument } from '../security-extract';
import { SECURITY_LIMITS } from '@app/specs/seo-compliance.spec';
import { captureHeaders, createResponseRecorder } from '../responses';
import { createRobotsFetcher, isPrivateHost, netHop, outcomeOf, type Hop, type HopResult, type NetRequester } from '../robots-fetch';

const PAGE = 'https://example.com/a';

// ---- The browse session's webRequest hub ------------------------------------------------------

/** A session's `webRequest` like Electron's: one listener per event (registering again replaces it). */
function fakeSession() {
  const listeners: Record<string, ((details: unknown) => void) | null> = {};
  const register = (event: string) =>
    vi.fn((filter: unknown, listener: ((details: unknown) => void) | null) => {
      expect(filter).toEqual(MAIN_FRAME_FILTER);
      listeners[event] = listener;
    });
  const webRequest = { onBeforeRedirect: register('redirect'), onResponseStarted: register('response'), onErrorOccurred: register('error') };
  return { session: { webRequest } as unknown as ObservedSession, webRequest, listeners };
}

describe('main-frame observers', () => {
  test('web-request-observers-compose', () => {
    const { session, webRequest, listeners } = fakeSession();
    const first = { responded: vi.fn(() => { throw new Error('boom'); }) };
    const second = { responded: vi.fn(), redirected: vi.fn(), failed: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    observeMainFrames(session, first);
    const remove = observeMainFrames(session, second);
    // One Electron listener per event, whatever the number of observers.
    expect(webRequest.onResponseStarted).toHaveBeenCalledTimes(1);
    expect(webRequest.onBeforeRedirect).toHaveBeenCalledTimes(1);
    expect(webRequest.onErrorOccurred).toHaveBeenCalledTimes(1);
    expect(MAIN_FRAME_FILTER.types).toEqual(['mainFrame']);
    listeners.response!({ id: 1 });
    // One observer throwing never keeps the event from the next.
    expect(first.responded).toHaveBeenCalledTimes(1);
    expect(second.responded).toHaveBeenCalledWith({ id: 1 });
    listeners.redirect!({ id: 2 });
    listeners.error!({ id: 3 });
    expect(second.redirected).toHaveBeenCalledWith({ id: 2 });
    expect(second.failed).toHaveBeenCalledWith({ id: 3 });
    remove();
    listeners.response!({ id: 4 });
    expect(second.responded).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

// ---- Response metadata -----------------------------------------------------------------------

const responded = (changes: Partial<OnResponseStartedListenerDetails> = {}) =>
  ({ id: 1, url: PAGE, webContentsId: 7, resourceType: 'mainFrame', statusCode: 200, statusLine: 'HTTP/1.1 200 OK', fromCache: false, responseHeaders: { 'Content-Type': ['text/html'] }, ...changes }) as OnResponseStartedListenerDetails;
const redirected = (url: string, location: string, changes: Partial<OnBeforeRedirectListenerDetails> = {}) =>
  ({ id: 1, url, redirectURL: location, webContentsId: 7, resourceType: 'mainFrame', statusCode: 301, statusLine: 'HTTP/1.1 301 Moved Permanently', fromCache: false, ...changes }) as OnBeforeRedirectListenerDetails;

describe('response recorder', () => {
  test('response-recorded-with-redirects-and-headers', () => {
    const recorder = createResponseRecorder();
    recorder.redirected(redirected('http://example.com/a', 'https://example.com/a', { statusCode: 307, statusLine: 'HTTP/1.1 307 Internal Redirect' }));
    recorder.redirected(redirected('https://example.com/a', 'https://example.com/b'));
    recorder.redirected(redirected('https://example.com/b', PAGE, { statusCode: 302 }));
    recorder.responded(
      responded({ responseHeaders: { 'X-Robots-Tag': ['noindex', 'googlebot: nofollow'], 'Set-Cookie': ['sid=secret'], Link: ['</c>; rel="canonical"'], Server: ['test'], 'Content-Type': ['text/html'] } }),
    );
    recorder.committed(7, `${PAGE}#section`, 200);
    const response = recorder.responseFor(7, PAGE)!;
    expect(response).toMatchObject({ source: 'network', status: 200, headersAvailable: true, redirectTotal: 3 });
    expect(response.redirects).toEqual([
      { url: 'http://example.com/a', status: 307, location: 'https://example.com/a', internal: true },
      { url: 'https://example.com/a', status: 301, location: 'https://example.com/b', internal: false },
      { url: 'https://example.com/b', status: 302, location: PAGE, internal: false },
    ]);
    // Only allowlisted headers, lowercased, every instance of X-Robots-Tag; never Set-Cookie.
    expect(response.headers).toEqual([
      { name: 'x-robots-tag', value: 'noindex' },
      { name: 'x-robots-tag', value: 'googlebot: nofollow' },
      { name: 'link', value: '</c>; rel="canonical"' },
      { name: 'server', value: 'test' },
      { name: 'content-type', value: 'text/html' },
    ]);
    // What the worker receives is a valid context.
    expect(PageContextSchema.safeParse({ response, robots: null }).success).toBe(true);
  });

  test('response-headers-are-capped', () => {
    const huge = 'v'.repeat(RESPONSE_LIMITS.maxHeaderValueChars * 3);
    const headers = captureHeaders({ link: Array.from({ length: 50 }, () => huge), 'x-robots-tag': 'single' as unknown as string[], 'content-type': [huge] });
    expect(headers.filter((h) => h.name === 'link')).toHaveLength(RESPONSE_LIMITS.maxValuesPerHeader);
    expect(headers.every((h) => h.value.length <= RESPONSE_LIMITS.maxHeaderValueChars)).toBe(true);
    expect(headers.find((h) => h.name === 'x-robots-tag')?.value).toBe('single');
    const many = Object.fromEntries(['link', 'x-robots-tag', 'vary', 'etag', 'server', 'content-language', 'cache-control'].map((name) => [name, Array.from({ length: 20 }, () => 'x')]));
    expect(captureHeaders(many).length).toBeLessThanOrEqual(RESPONSE_LIMITS.maxHeaders);
    expect(captureHeaders(undefined)).toEqual([]);
    // A surrogate pair is never split.
    expect(captureHeaders({ server: [`${'a'.repeat(RESPONSE_LIMITS.maxHeaderValueChars - 1)}😀`] })[0]!.value).toHaveLength(RESPONSE_LIMITS.maxHeaderValueChars - 1);
    // Redirect hops are capped too.
    const recorder = createResponseRecorder();
    for (let i = 0; i < 25; i++) recorder.redirected(redirected(`https://example.com/${i}`, `https://example.com/${i + 1}`));
    recorder.responded(responded({ url: 'https://example.com/25' }));
    recorder.committed(7, 'https://example.com/25', 200);
    const response = recorder.responseFor(7, 'https://example.com/25')!;
    expect(response.redirects).toHaveLength(RESPONSE_LIMITS.maxRedirects);
    expect(response.redirectTotal).toBe(25);
  });

  test('response-from-cache-or-restored', () => {
    const recorder = createResponseRecorder();
    recorder.responded(responded({ fromCache: true }));
    recorder.committed(7, PAGE, 200);
    expect(recorder.responseFor(7, PAGE)).toMatchObject({ source: 'cache', status: 200, headersAvailable: true });
    // No network events for the committed document (back/forward cache): did-navigate's status, no headers.
    recorder.committed(7, 'https://example.com/back', 404);
    expect(recorder.responseFor(7, 'https://example.com/back')).toEqual({ url: 'https://example.com/back', source: 'navigation', status: 404, headersAvailable: false, headers: [], redirects: [], redirectTotal: 0 });
    recorder.committed(7, 'https://example.com/zero', 0);
    expect(recorder.responseFor(7, 'https://example.com/zero')?.status).toBeNull();
  });

  test('response-in-page-url-has-none', () => {
    const recorder = createResponseRecorder();
    recorder.responded(responded());
    recorder.committed(7, PAGE, 200);
    expect(recorder.responseFor(7, `${PAGE}#frag`)?.source).toBe('network');
    expect(recorder.responseFor(7, 'https://example.com/route')).toEqual({ url: 'https://example.com/route', source: 'in-page', status: null, headersAvailable: false, headers: [], redirects: [], redirectTotal: 0 });
    expect(recorder.responseFor(8, PAGE)).toBeNull();
  });

  test('response-recorded-for-a-url-longer-than-it-holds', () => {
    // Codex review: the stored URL is cut to `maxUrlChars`, the URLs it is matched with are not.
    const long = `https://example.com/${'a'.repeat(SNAPSHOT_LIMITS.maxUrlChars)}`;
    const recorder = createResponseRecorder();
    recorder.responded(responded({ url: long, responseHeaders: { 'X-Robots-Tag': ['noindex'] } }));
    recorder.committed(7, `${long}#part`, 200);
    const response = recorder.responseFor(7, long)!;
    expect(response).toMatchObject({ source: 'network', status: 200, headersAvailable: true, headers: [{ name: 'x-robots-tag', value: 'noindex' }] });
    expect(response.url).toHaveLength(SNAPSHOT_LIMITS.maxUrlChars);
    // Another page is still another page, even one that shares those first characters.
    expect(recorder.responseFor(7, 'https://example.com/other')?.source).toBe('in-page');
    expect(recorder.responseFor(7, `${long}&page=2`)?.source).toBe('in-page');
    const other = createResponseRecorder();
    other.responded(responded({ url: `${long}&page=1`, responseHeaders: { 'X-Robots-Tag': ['noindex'] } }));
    other.committed(7, `${long}&page=2`, 200);
    expect(other.responseFor(7, `${long}&page=2`)).toMatchObject({ source: 'navigation', headersAvailable: false, headers: [] });
  });

  test('response-attributed-to-its-tab-only', () => {
    const recorder = createResponseRecorder();
    recorder.responded(responded({ webContentsId: 8, responseHeaders: { 'x-robots-tag': ['noindex'] } }));
    recorder.responded(responded({ id: 2, resourceType: 'subFrame', responseHeaders: { 'x-robots-tag': ['noindex'] } }));
    recorder.responded(responded({ id: 3, webContentsId: undefined }));
    recorder.responded(responded({ id: 4 }));
    recorder.committed(7, PAGE, 200);
    expect(recorder.responseFor(7, PAGE)!.headers).toEqual([{ name: 'content-type', value: 'text/html' }]);
    recorder.committed(8, PAGE, 200);
    expect(recorder.responseFor(8, PAGE)!.headers).toEqual([{ name: 'x-robots-tag', value: 'noindex' }]);
  });

  test('response-not-committed-is-not-the-document', () => {
    const recorder = createResponseRecorder();
    recorder.responded(responded());
    recorder.committed(7, PAGE, 200);
    // A download (or a 204, or a cancelled navigation) answers but never commits.
    recorder.responded(responded({ id: 2, url: 'https://example.com/file.zip', statusCode: 200, responseHeaders: { 'x-robots-tag': ['noindex'] } }));
    recorder.failed({ id: 3, webContentsId: 7 } as OnErrorOccurredListenerDetails);
    expect(recorder.responseFor(7, PAGE)!.headers).toEqual([{ name: 'content-type', value: 'text/html' }]);
    // A failed request is dropped; pending requests are bounded per tab.
    recorder.redirected(redirected('https://example.com/x', 'https://example.com/y', { id: 5 }));
    recorder.failed({ id: 5, webContentsId: 7 } as OnErrorOccurredListenerDetails);
    for (let i = 10; i < 30; i++) recorder.responded(responded({ id: i, url: `https://example.com/p${i}` }));
    recorder.committed(7, 'https://example.com/p10', 200);
    expect(recorder.responseFor(7, 'https://example.com/p10')!.source).toBe('navigation');
    recorder.committed(7, 'https://example.com/p29', 200);
    expect(recorder.responseFor(7, 'https://example.com/p29')!.source).toBe('network');
  });

  test('response-tracks-tabs-through-their-contents', () => {
    const recorder = createResponseRecorder();
    const contents = Object.assign(new FakeTabContents(), { id: 7 });
    recorder.watch(contents);
    recorder.responded(responded());
    contents.emit('did-navigate', {}, PAGE, 200, 'OK');
    expect(recorder.responseFor(7, PAGE)?.source).toBe('network');
    contents.destroy();
    expect(recorder.responseFor(7, PAGE)).toBeNull();
    // At most `maxTrackedTabs` tabs are remembered.
    for (let id = 100; id < 100 + RESPONSE_LIMITS.maxTrackedTabs + 5; id++) recorder.committed(id, PAGE, 200);
    expect(recorder.responseFor(100, PAGE)).toBeNull();
    expect(recorder.responseFor(100 + RESPONSE_LIMITS.maxTrackedTabs + 4, PAGE)).not.toBeNull();
  });

  test('response-recorder-clears', () => {
    const recorder = createResponseRecorder();
    recorder.responded(responded());
    recorder.committed(7, PAGE, 200);
    recorder.responded(responded({ id: 2, url: 'https://example.com/next' }));
    recorder.clear();
    expect(recorder.responseFor(7, PAGE)).toBeNull();
    // Nothing pending survives either.
    recorder.committed(7, 'https://example.com/next', 200);
    expect(recorder.responseFor(7, 'https://example.com/next')?.source).toBe('navigation');
  });
});

// ---- robots.txt fetch -------------------------------------------------------------------------

const encoder = new TextEncoder();
/** A body of `chunks` (strings or byte counts of `x`), counting how many were read. */
function body(chunks: (string | number)[], read = { count: 0 }): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        read.count++;
        yield typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk).fill(0x78);
      }
    },
  };
}
const decoder = new TextDecoder();
/** The fetched body as text (tests only; frost decodes it in the worker). */
const textOf = (fetched: RobotsFetch | null): string => decoder.decode(fetched!.body);
const ok = (text: string, status = 200): HopResult => ({ kind: 'response', status, body: body([text]), cancel: vi.fn() });
const redirect = (location: string | null, status = 301): HopResult => ({ kind: 'redirect', status, location });

/** A hop answering by URL from `routes` (a function or a fixed answer); records every URL asked. */
function fakeHop(routes: Record<string, HopResult | (() => Promise<HopResult>)>) {
  const asked: string[] = [];
  const hop: Hop = async (url) => {
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error(`net::ERR_CONNECTION_REFUSED ${url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { hop, asked };
}

describe('robots.txt fetcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('robots-fetch-origin-only', async () => {
    const { hop, asked } = fakeHop({ 'https://example.com:8443/robots.txt': ok('User-agent: *\nDisallow: /x\n') });
    const fetcher = createRobotsFetcher({ hop });
    const fetched = await fetcher.get('https://user:pw@example.com:8443/deep/page?q=1#f');
    expect(asked).toEqual(['https://example.com:8443/robots.txt']);
    expect(fetched).toEqual({ url: 'https://example.com:8443/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com:8443/robots.txt', redirects: 0, body: encoder.encode('User-agent: *\nDisallow: /x\n'), truncated: false });
    expect(PageContextSchema.safeParse({ response: null, robots: fetched }).success).toBe(true);
    // Only http(s) pages have a robots.txt to fetch.
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,x', 'about:blank', 'not a url']) expect(await fetcher.get(url)).toBeNull();
    expect(asked).toHaveLength(1);
  });

  test('robots-fetch-status-semantics', async () => {
    expect([200, 204, 404, 401, 403, 410, 429, 500, 503, 301, 100].map(outcomeOf)).toEqual(['ok', 'ok', 'unavailable', 'forbidden', 'forbidden', 'unavailable', 'server-error', 'server-error', 'server-error', 'no-location', 'server-error']);
    const { hop } = fakeHop({ 'https://a.example/robots.txt': ok('ignored', 404), 'https://b.example/robots.txt': ok('ignored', 503), 'https://c.example/robots.txt': ok('ignored', 403), 'https://d.example/robots.txt': ok('ignored', 302) });
    const fetcher = createRobotsFetcher({ hop });
    expect(await fetcher.get('https://a.example/')).toMatchObject({ outcome: 'unavailable', status: 404, body: new Uint8Array(0) });
    expect(await fetcher.get('https://b.example/')).toMatchObject({ outcome: 'server-error', status: 503, body: new Uint8Array(0) });
    expect(await fetcher.get('https://c.example/')).toMatchObject({ outcome: 'forbidden', status: 403 });
    // A 3xx answered without a Location (so not reported as a redirect).
    expect(await fetcher.get('https://d.example/')).toMatchObject({ outcome: 'no-location', status: 302 });
    expect(await fetcher.get('https://down.example/')).toMatchObject({ outcome: 'unreachable', status: null, finalUrl: null });
  });

  test('robots-fetch-follows-bounded-redirects', async () => {
    const chain: Record<string, HopResult> = { 'http://example.com/robots.txt': redirect('https://example.com/robots.txt') };
    for (let i = 0; i < 4; i++) chain[i === 0 ? 'https://example.com/robots.txt' : `https://cdn.example.net/${i}`] = redirect(`https://cdn.example.net/${i + 1}`, 302);
    chain['https://cdn.example.net/4'] = ok('User-agent: *\nAllow: /\n');
    const { hop, asked } = fakeHop(chain);
    // Five redirects (another origin included) are followed.
    expect(await createRobotsFetcher({ hop }).get('http://example.com/page')).toMatchObject({ outcome: 'ok', redirects: 5, finalUrl: 'https://cdn.example.net/4' });
    expect(asked).toHaveLength(6);
    // A sixth is not: no robots.txt (RFC 9309).
    const loop = fakeHop({});
    const loopHop: Hop = async (url) => {
      loop.asked.push(url);
      return redirect(`${url}x`);
    };
    expect(await createRobotsFetcher({ hop: loopHop }).get('https://loop.example/')).toMatchObject({ outcome: 'too-many-redirects', redirects: ROBOTS_FETCH_LIMITS.maxRedirects });
    expect(loop.asked).toHaveLength(ROBOTS_FETCH_LIMITS.maxRedirects + 1);
    // A relative Location resolves against the hop that sent it.
    const relative = fakeHop({ 'https://r.example/robots.txt': redirect('/real/robots.txt'), 'https://r.example/real/robots.txt': ok('') });
    expect(await createRobotsFetcher({ hop: relative.hop }).get('https://r.example/')).toMatchObject({ outcome: 'ok', finalUrl: 'https://r.example/real/robots.txt' });
  });

  test('robots-fetch-never-leaves-http', async () => {
    for (const location of ['file:///etc/passwd', 'ftp://example.com/robots.txt', 'javascript:alert(1)', 'data:text/plain,User-agent', 'chrome://settings', 'http://']) {
      const { hop, asked } = fakeHop({ 'https://example.com/robots.txt': redirect(location, 302) });
      expect(await createRobotsFetcher({ hop }).get('https://example.com/'), String(location)).toMatchObject({ outcome: 'bad-redirect', redirects: 0 });
      // The non-web URL is never requested.
      expect(asked).toEqual(['https://example.com/robots.txt']);
    }
    const none = fakeHop({ 'https://example.com/robots.txt': redirect(null, 302) });
    expect(await createRobotsFetcher({ hop: none.hop }).get('https://example.com/')).toMatchObject({ outcome: 'no-location', redirects: 0 });
  });

  test('robots-fetch-refuses-private-redirects', async () => {
    const privateTargets = [
      'http://127.0.0.1/robots.txt',
      'http://127.8.9.10:8080/x',
      'http://10.0.0.5/robots.txt',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/',
      'http://localhost/robots.txt',
      'http://api.localhost:3000/',
      'http://printer.local/',
      'http://[::1]/',
      'http://[fd12:3456::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.0.1]/',
      'http://2130706433/',
      'http://0x7f.1/',
    ];
    for (const location of privateTargets) {
      const { hop, asked } = fakeHop({ 'https://example.com/robots.txt': redirect(location, 302) });
      expect(await createRobotsFetcher({ hop }).get('https://example.com/'), location).toMatchObject({ outcome: 'private-redirect', redirects: 0 });
      expect(asked, location).toEqual(['https://example.com/robots.txt']);
    }
    for (const host of ['172.32.0.1', '192.169.0.1', '11.0.0.1', '[2606:4700::1111]', 'example.local.example.com', 'localhost.example.com']) expect(isPrivateHost(new URL(`http://${host}/`).hostname), host).toBe(false);
    // Phase 2.5 Task 2 review: the shared check (private-address.spec.ts) also refuses documentation and `.test` names.
    for (const host of ['[2001:db8::1]', 'example.local.test', '100.64.0.1']) expect(isPrivateHost(new URL(`http://${host}/`).hostname), host).toBe(true);
    // A page that is itself on a private host (a dev server) may be redirected to another one.
    const dev = fakeHop({ 'http://localhost:5173/robots.txt': redirect('http://127.0.0.1:5173/robots.txt'), 'http://127.0.0.1:5173/robots.txt': ok('User-agent: *\n') });
    expect(await createRobotsFetcher({ hop: dev.hop }).get('http://localhost:5173/page')).toMatchObject({ outcome: 'ok', redirects: 1 });
  });

  test('robots-fetch-caps-the-body', async () => {
    const read = { count: 0 };
    const cancel = vi.fn();
    const chunk = 64 * 1024;
    const { hop } = fakeHop({ 'https://big.example/robots.txt': { kind: 'response', status: 200, body: body(Array.from({ length: 100 }, () => chunk), read), cancel } });
    const fetched = (await createRobotsFetcher({ hop }).get('https://big.example/'))!;
    expect(fetched).toMatchObject({ outcome: 'ok', truncated: true });
    expect(fetched.body.byteLength).toBe(ROBOTS_FETCH_LIMITS.maxBytes);
    // Reading stopped at the cap, and the request was cancelled.
    expect(read.count).toBe(Math.ceil(ROBOTS_FETCH_LIMITS.maxBytes / chunk));
    expect(cancel).toHaveBeenCalled();
    expect(PageContextSchema.safeParse({ response: null, robots: fetched }).success).toBe(true);
    // The bytes are kept exactly as read (not decoded on main): a Latin-1 file stays Latin-1.
    const latin1 = Uint8Array.from([0x2f, 0x63, 0x61, 0x66, 0xe9]);
    const raw = fakeHop({ 'https://u.example/robots.txt': { kind: 'response', status: 200, body: { async *[Symbol.asyncIterator]() { yield latin1; } }, cancel: vi.fn() } });
    expect((await createRobotsFetcher({ hop: raw.hop }).get('https://u.example/'))!.body).toEqual(latin1);
    expect(textOf(await createRobotsFetcher({ hop: fakeHop({ 'https://v.example/robots.txt': ok('User-agent: *') }).hop }).get('https://v.example/'))).toBe('User-agent: *');
  });

  test('robots-fetch-times-out', async () => {
    const never = fakeHop({ 'https://slow.example/robots.txt': () => new Promise<HopResult>(() => undefined) });
    const pending = createRobotsFetcher({ hop: never.hop }).get('https://slow.example/');
    let settled: RobotsFetch | null | undefined;
    void pending.then((value) => (settled = value));
    await vi.advanceTimersByTimeAsync(ROBOTS_FETCH_LIMITS.timeoutMs - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ outcome: 'timeout', status: null });
    // A body that never ends times out too, and the hop's signal is aborted.
    let signal: AbortSignal | undefined;
    const stalled: Hop = async (_url, s) => {
      signal = s;
      return { kind: 'response', status: 200, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }, cancel: vi.fn() };
    };
    const slowBody = createRobotsFetcher({ hop: stalled }).get('https://drip.example/');
    await vi.advanceTimersByTimeAsync(ROBOTS_FETCH_LIMITS.timeoutMs);
    await expect(slowBody).resolves.toMatchObject({ outcome: 'timeout', status: 200 });
    expect(signal?.aborted).toBe(true);
  });

  test('robots-fetch-is-cached-and-deduplicated', async () => {
    let now = 1_000;
    let release: (value: HopResult) => void = () => undefined;
    const { hop, asked } = fakeHop({ 'https://c.example/robots.txt': () => new Promise<HopResult>((resolve) => (release = resolve)) });
    const fetcher = createRobotsFetcher({ hop, now: () => now });
    const first = fetcher.get('https://c.example/a');
    const second = fetcher.get('https://c.example/b');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(1);
    release(ok('User-agent: *\n'));
    expect(await first).toBe(await second);
    now += ROBOTS_FETCH_LIMITS.cacheTtlMs - 1;
    await fetcher.get('https://c.example/c');
    expect(asked).toHaveLength(1);
    now += 1;
    void fetcher.get('https://c.example/d');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
    // A failure is kept for `failureTtlMs` only.
    const failing = fakeHop({});
    const failures = createRobotsFetcher({ hop: failing.hop, now: () => now });
    await failures.get('https://f.example/');
    now += ROBOTS_FETCH_LIMITS.failureTtlMs - 1;
    await failures.get('https://f.example/');
    expect(failing.asked).toHaveLength(1);
    now += 1;
    await failures.get('https://f.example/');
    expect(failing.asked).toHaveLength(2);
    // Origins are distinct (scheme and port too), and at most `maxCacheEntries` are kept.
    const spread = fakeHop({});
    const many = createRobotsFetcher({ hop: spread.hop, now: () => now });
    for (let i = 0; i < ROBOTS_FETCH_LIMITS.maxCacheEntries + 10; i++) await many.get(`https://h${i}.example/`);
    expect(many.size()).toBe(ROBOTS_FETCH_LIMITS.maxCacheEntries);
    await many.get('http://h40.example/');
    await many.get('https://h40.example:444/');
    expect(spread.asked.slice(-2)).toEqual(['http://h40.example/robots.txt', 'https://h40.example:444/robots.txt']);
  });

  test('robots-fetch-peeks-and-clears', async () => {
    let release: (value: HopResult) => void = () => undefined;
    const { hop, asked } = fakeHop({ 'https://p.example/robots.txt': () => new Promise<HopResult>((resolve) => (release = resolve)) });
    const fetcher = createRobotsFetcher({ hop });
    // Nothing known before a fetch, nor while it runs; the answer once it settled.
    expect(fetcher.peek('https://p.example/a')).toBeUndefined();
    const fetching = fetcher.get('https://p.example/a');
    expect(fetcher.peek('https://p.example/b')).toBeUndefined();
    release(ok('User-agent: *\n'));
    const fetched = await fetching;
    expect(fetcher.peek('https://p.example/c')).toBe(fetched);
    expect(fetcher.peek('ftp://p.example/')).toBeNull();
    // Clear Browsing Data forgets every origin: the next audit fetches again.
    fetcher.clear();
    expect(fetcher.size()).toBe(0);
    expect(fetcher.peek('https://p.example/c')).toBeUndefined();
    void fetcher.get('https://p.example/d');
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
    // A fetch in flight while clearing is not cached afterwards.
    release(ok('late'));
    await vi.advanceTimersByTimeAsync(0);
    fetcher.clear();
    expect(fetcher.peek('https://p.example/')).toBeUndefined();
  });

  test('robots-net-hop-sends-no-cookies-and-follows-nothing', async () => {
    class FakeRequest extends EventEmitter {
      aborted = false;
      abort = vi.fn(() => {
        this.aborted = true;
      });
      end = vi.fn();
    }
    const requests: { options: Electron.ClientRequestConstructorOptions; request: FakeRequest }[] = [];
    const net: NetRequester = {
      request: (options) => {
        const request = new FakeRequest();
        requests.push({ options, request });
        return request as unknown as Electron.ClientRequest;
      },
    };
    const session = {} as Electron.Session;
    const hop = netHop(net, session);
    const controller = new AbortController();
    const redirecting = hop('https://example.com/robots.txt', controller.signal);
    expect(requests[0]!.options).toMatchObject({ url: 'https://example.com/robots.txt', session, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(requests[0]!.request.end).toHaveBeenCalled();
    requests[0]!.request.emit('redirect', 302, 'GET', 'file:///etc/passwd', {});
    await expect(redirecting).resolves.toEqual({ kind: 'redirect', status: 302, location: 'file:///etc/passwd' });
    // The redirect is never followed: the request is aborted at it.
    expect(requests[0]!.request.abort).toHaveBeenCalled();
    // A response's body is the message; aborting the signal aborts the request.
    const answering = hop('https://example.com/robots.txt', controller.signal);
    const message = new EventEmitter() as EventEmitter & { statusCode: number };
    message.statusCode = 200;
    requests[1]!.request.emit('response', message);
    await expect(answering).resolves.toMatchObject({ kind: 'response', status: 200 });
    const failing = hop('https://example.com/robots.txt', controller.signal);
    controller.abort();
    await expect(failing).rejects.toThrow();
    expect(requests[2]!.request.abort).toHaveBeenCalled();
    await expect(hop('https://example.com/robots.txt', controller.signal)).rejects.toThrow();
  });
});

// ---- Collected beside the snapshot (auditor and worker) -------------------------------------

const CONTEXT: PageContext = {
  response: { url: PAGE, source: 'network', status: 404, headersAvailable: true, headers: [{ name: 'x-robots-tag', value: 'noindex' }], redirects: [], redirectTotal: 0 },
  robots: { url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: new TextEncoder().encode('User-agent: *\nDisallow: /a\n'), truncated: false },
};
/** The same context while robots.txt is still being fetched. */
const PENDING_CONTEXT: PageContext = { ...CONTEXT, robots: { ...CONTEXT.robots!, outcome: 'pending', status: null, finalUrl: null, body: new Uint8Array(0) } };

describe('context in the analysis', () => {
  test('analysis-validates-the-context', () => {
    const answer = analyseSnapshot(rawSnapshot(PAGE), CONTEXT);
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.audit.indexability.verdict).toBe('not-indexable');
    expect(answer.audit.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['http-status-client-error', 'x-robots-noindex', 'robots-txt-blocks-googlebot']));
    // No context: nothing collected.
    const bare = analyseSnapshot(rawSnapshot(PAGE));
    if (!bare.ok) throw new Error(bare.reason);
    expect(bare.audit.indexability).toMatchObject({ verdict: 'indexable', http: null, robots: null });
    // A context that does not parse (wrong shape, over a cap, a header off the allowlist) is refused.
    const bad: unknown[] = [
      { response: null },
      { ...CONTEXT, extra: 1 },
      { ...CONTEXT, response: { ...CONTEXT.response, headers: [{ name: 'set-cookie', value: 'x' }] } },
      { ...CONTEXT, response: { ...CONTEXT.response, headers: [{ name: 'link', value: 'x'.repeat(RESPONSE_LIMITS.maxHeaderValueChars + 1) }] } },
      { ...CONTEXT, response: { ...CONTEXT.response, headersAvailable: false } },
      { ...CONTEXT, robots: { ...CONTEXT.robots, body: new Uint8Array(ROBOTS_FETCH_LIMITS.maxBytes + 1) } },
      { ...CONTEXT, robots: { ...CONTEXT.robots, body: 'User-agent: *' } },
      { ...CONTEXT, robots: { ...CONTEXT.robots, text: 'User-agent: *' } },
      { ...CONTEXT, robots: { ...CONTEXT.robots, url: 'file:///robots.txt' } },
      'context',
    ];
    for (const context of bad) expect(analyseSnapshot(rawSnapshot(PAGE), context)).toEqual({ ok: false, reason: 'invalid-snapshot' });
    // The page cannot smuggle its own context in the snapshot.
    expect(analyseSnapshot({ ...rawSnapshot(PAGE), response: CONTEXT.response })).toEqual({ ok: false, reason: 'invalid-snapshot' });
  });

  describe('auditor', () => {
    let views: FakeTabView[];
    let analysed: { raw: unknown; context: unknown }[];
    let source: (contents: unknown) => ContextSource;
    let controller: ReturnType<typeof createBrowserController>;

    beforeEach(() => {
      vi.useFakeTimers();
      views = [];
      analysed = [];
      source = () => ({ now: () => ({ context: CONTEXT, final: true }), later: null });
      controller = createBrowserController({
        createView: () => {
          const view = new FakeTabView();
          views.push(view);
          return view as unknown as TabView;
        },
        platform: 'linux',
        seo: {
          extract: async (contents) => rawSnapshot((contents as unknown as FakeTabContents).url),
          analyse: async (raw, collected): Promise<AnalysisResult> => {
            analysed.push({ raw, context: collected });
            return analyseSnapshot(raw, collected);
          },
          context: (contents) => source(contents),
        },
      });
      controller.attach(new FakeHostWindow() as unknown as HostWindow);
    });
    afterEach(() => vi.useRealTimers());

    const load = (url: string) => {
      controller.navigate(url);
      const contents = views.at(-1)!.contents;
      commit(contents, url, 'Title');
      contents.emit('did-finish-load');
      return contents;
    };
    const status = () => controller.seo.getAudit(controller.getState().activeTabId!);
    const verdict = () => {
      const answer = status();
      return answer.status === 'ready' ? answer.audit.indexability.verdict : answer.status;
    };
    /** A source whose robots.txt settles when the test says. */
    const slowSource = () => {
      let release: (value: unknown) => void = () => undefined;
      const later = new Promise<unknown>((resolve) => (release = resolve));
      return { source: (): ContextSource => ({ now: () => ({ context: PENDING_CONTEXT, final: false }), later }), release: () => release(CONTEXT) };
    };

    test('auditor-hands-the-context-to-the-worker', async () => {
      const seen: unknown[] = [];
      source = (contents) => {
        seen.push(contents);
        return { now: () => ({ context: CONTEXT, final: true }), later: null };
      };
      const contents = load(PAGE);
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      expect(seen).toEqual([contents]);
      expect(analysed).toHaveLength(1);
      expect(analysed[0]!.context).toBe(CONTEXT);
      expect(verdict()).toBe('not-indexable');
    });

    test('auditor-does-not-wait-for-robots', async () => {
      const slow = slowSource();
      source = slow.source;
      load(PAGE);
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      // Ready at once, without robots.txt: the other panels are complete, the verdict is pending
      // (the 404 already makes it "not indexable" here, so take a page without other reasons).
      expect(analysed).toHaveLength(1);
      expect(analysed[0]!.context).toBe(PENDING_CONTEXT);
      expect(status().status).toBe('ready');
      const before = controller.getState().tabs[0]!.auditVersion;
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      // Analysed again with robots.txt, and the chrome is told.
      expect(analysed).toHaveLength(2);
      expect(analysed[1]!.context).toBe(CONTEXT);
      expect(controller.getState().tabs[0]!.auditVersion).toBeGreaterThan(before);
      const answer = status();
      expect(answer.status === 'ready' && answer.audit.indexability.robots?.outcome).toBe('ok');
    });

    test('auditor-verdict-pending-until-robots', async () => {
      const clean = { ...CONTEXT, response: { ...CONTEXT.response!, status: 200, headers: [] } };
      let release: (value: unknown) => void = () => undefined;
      const later = new Promise<unknown>((resolve) => (release = resolve));
      source = () => ({ now: () => ({ context: { ...clean, robots: PENDING_CONTEXT.robots }, final: false }), later });
      load(PAGE);
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      expect(verdict()).toBe('pending');
      release(clean);
      await vi.advanceTimersByTimeAsync(0);
      // `Disallow: /a` blocks the page.
      expect(verdict()).toBe('not-indexable');
    });

    test('auditor-drops-late-robots-for-a-page-that-moved-on', async () => {
      const slow = slowSource();
      source = slow.source;
      const contents = load(PAGE);
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      expect(analysed).toHaveLength(1);
      commit(contents, 'https://example.com/b', 'B');
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      // Not analysed again for a URL the tab no longer shows.
      expect(analysed).toHaveLength(1);
      // Nor for a superseded run: a rerun took over.
      const again = slowSource();
      source = again.source;
      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      const runs = analysed.length;
      source = () => ({ now: () => ({ context: CONTEXT, final: true }), later: null });
      controller.seo.rerun(controller.getState().activeTabId!);
      await vi.advanceTimersByTimeAsync(0);
      expect(analysed).toHaveLength(runs + 1);
      again.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(analysed).toHaveLength(runs + 1);
    });

    test('auditor-survives-a-broken-context-source', async () => {
      // A source that throws, a `now` that throws, a `later` that rejects or never settles.
      source = () => {
        throw new Error('boom');
      };
      load(PAGE);
      await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
      expect(analysed.at(-1)!.context).toBeUndefined();
      expect(status().status).toBe('ready');
      source = () => ({
        now: () => {
          throw new Error('boom');
        },
        later: Promise.reject(new Error('late boom')),
      });
      controller.seo.rerun(controller.getState().activeTabId!);
      await vi.advanceTimersByTimeAsync(0);
      expect(analysed.at(-1)!.context).toBeUndefined();
      const count = analysed.length;
      source = () => ({ now: () => ({ context: PENDING_CONTEXT, final: false }), later: new Promise(() => undefined) });
      controller.seo.rerun(controller.getState().activeTabId!);
      await vi.advanceTimersByTimeAsync(CONTEXT_TIMEOUT_MS + 1);
      expect(analysed).toHaveLength(count + 1);
      expect(status().status).toBe('ready');
    });
  });
});

// ---- hreflang extraction ------------------------------------------------------------------------

function extract(head: string, body = '', limits = {}): ExtractedSnapshot {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { url: PAGE });
  const page = extractPage(dom.window.document as unknown as PageDocument, { ...SNAPSHOT_LIMITS, ...limits }, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS) as ExtractedSnapshot;
  // With the security read beside it, as the extractor's script does (Task 6).
  return { ...page, security: extractSecurity(dom.window.document as unknown as SecurityDocument, SECURITY_LIMITS, RESOURCE_SELECTOR) as ExtractedSnapshot['security'] };
}

describe('hreflang extraction', () => {
  test('extractor-reads-head-hreflang', () => {
    const snapshot = extract(
      '<link rel="alternate" hreflang=" en-GB " href="/en-gb/"><link rel="ALTERNATE stylesheet" hreflang="de" href="https://example.com/de/"><link rel="alternate" href="/no-lang/"><link rel="canonical" hreflang="fr" href="/fr/"><link rel="alternate" hreflang="x" href="http://[bad">',
      '<link rel="alternate" hreflang="es" href="/es/">',
    );
    expect(snapshot.hreflang).toEqual([
      { hreflang: 'en-GB', href: '/en-gb/', resolved: 'https://example.com/en-gb/' },
      { hreflang: 'de', href: 'https://example.com/de/', resolved: 'https://example.com/de/' },
      { hreflang: 'x', href: 'http://[bad', resolved: null },
    ]);
    expect(snapshot.hreflangTotal).toBe(3);
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test('extractor-caps-hreflang', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<link rel="alternate" hreflang="${'x'.repeat(200)}${i}" href="/${i}/">`).join('');
    const snapshot = extract(many, '', { maxHreflang: 10 });
    expect(snapshot.hreflang).toHaveLength(10);
    expect(snapshot.hreflangTotal).toBe(40);
    expect(snapshot.hreflang[0]!.hreflang).toHaveLength(SNAPSHOT_LIMITS.maxHreflangChars);
    expect(PageSnapshotSchema.safeParse(extract(many)).success).toBe(true);
  });
});
