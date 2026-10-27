// Spec: specs/devtools.spec.ts (NETWORK_LIMITS, NETWORK_TYPE_OF, SECRET_HEADERS, MASKED_VALUE,
// REQUEST_HEADER_ALLOWLIST, RESPONSE_HEADER_KEEP, CRAWLABLE_TYPES)
// Acceptance: specs/devtools.feature.md (Network log)
import type { OnBeforeRedirectListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { MASKED_VALUE, NETWORK_LIMITS, NETWORK_TYPE_OF } from '@app/specs/devtools.spec';
import { createNetworkLog, type NetworkLog } from '../network-log';

const TAB = 7;
const PAGE = 'https://www.example.com/page';
let nextId = 1;

function sent(url: string, more: Partial<OnSendHeadersListenerDetails> = {}): OnSendHeadersListenerDetails {
  return { id: nextId++, url, method: 'GET', webContentsId: TAB, resourceType: 'script', referrer: '', timestamp: 1_000, requestHeaders: {}, ...more } as OnSendHeadersListenerDetails;
}
const responded = (of: OnSendHeadersListenerDetails, more: Partial<OnResponseStartedListenerDetails> = {}) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_050, fromCache: false, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: {}, ...more }) as OnResponseStartedListenerDetails;
const completed = (of: OnSendHeadersListenerDetails, more: Partial<OnCompletedListenerDetails> = {}) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_120, fromCache: false, statusCode: 200, statusLine: '', error: '', ...more }) as OnCompletedListenerDetails;
const failed = (of: OnSendHeadersListenerDetails, error: string) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_200, fromCache: false, error }) as OnErrorOccurredListenerDetails;
const redirected = (of: OnSendHeadersListenerDetails, to: string, status = 301, responseHeaders: Record<string, string[]> = {}) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_010, redirectURL: to, statusCode: status, statusLine: '', fromCache: false, responseHeaders }) as OnBeforeRedirectListenerDetails;

/** A log on a page (its document's main-frame request answered). */
function onPage(full = true): { log: NetworkLog; changed: ReturnType<typeof vi.fn> } {
  const changed = vi.fn();
  const log = createNetworkLog({ changed });
  log.setFullCapture(full);
  log.navigated(TAB, PAGE);
  const doc = sent(PAGE, { resourceType: 'mainFrame' });
  log.sent(doc);
  log.responded(responded(doc));
  log.completed(completed(doc));
  return { log, changed };
}

const entries = (log: NetworkLog) => log.snapshot(TAB)!.entries;

describe('network log', () => {
  test('devtools-masks-secrets', () => {
    const { log } = onPage();
    const secret = 'Bearer s3cr3t-token';
    const request = sent('https://www.example.com/api', {
      resourceType: 'xhr',
      method: 'POST',
      requestHeaders: { Authorization: secret, 'Proxy-Authorization': 'Basic cHJveHk6cGFzcw==', COOKIE: 'sid=abc123', Accept: '*/*' },
      // A body, as `onBeforeRequest` would carry it: never read.
      uploadData: [{ bytes: Buffer.from('password=hunter2') }],
    } as Partial<OnSendHeadersListenerDetails>);
    log.sent(request);
    log.responded(responded(request, { responseHeaders: { 'Set-Cookie': ['sid=zzz-session; HttpOnly', 'other=1'], 'set-cookie2': ['x'], 'Content-Type': ['application/json'] } }));
    log.completed(completed(request));
    const entry = entries(log).find((e) => e.url.endsWith('/api'))!;
    const header = (list: readonly { name: string; value: string; masked: boolean }[], name: string) => list.find((h) => h.name === name);
    for (const name of ['authorization', 'proxy-authorization', 'cookie']) expect(header(entry.requestHeaders, name), name).toEqual({ name, value: MASKED_VALUE, masked: true, truncated: false });
    expect(header(entry.responseHeaders, 'set-cookie')).toEqual({ name: 'set-cookie', value: MASKED_VALUE, masked: true, truncated: false });
    expect(entry.responseHeaders.filter((h) => h.name === 'set-cookie')).toHaveLength(1);
    expect(header(entry.requestHeaders, 'accept')).toMatchObject({ value: '*/*', masked: false });
    // Nothing in the whole log holds a secret or a body.
    const everything = JSON.stringify(log.snapshot(TAB));
    for (const leak of ['s3cr3t', 'cHJveHk6cGFzcw', 'abc123', 'zzz-session', 'hunter2', 'uploadData', 'bytes']) expect(everything, leak).not.toContain(leak);
    expect(Object.keys(entry).sort()).toEqual(
      ['document', 'durationMs', 'error', 'fromCache', 'key', 'method', 'omittedRequestHeaders', 'omittedResponseHeaders', 'redirectTo', 'requestHeaders', 'responseHeaders', 'robots', 'size', 'startedAt', 'state', 'status', 'thirdParty', 'type', 'url', 'urlTruncated'].sort(),
    );
  });

  test('network-headers-allowlisted', () => {
    const { log } = onPage();
    const many: Record<string, string> = { 'User-Agent': 'frost', 'X-Custom-Token': 'private', Referer: 'x'.repeat(NETWORK_LIMITS.maxHeaderValueChars + 10) };
    const request = sent('https://www.example.com/a.js', { requestHeaders: many });
    log.sent(request);
    const responseHeaders: Record<string, string[]> = { 'X-Internal': ['secret-ish'], 'Cache-Control': ['max-age=60'] };
    for (let i = 0; i < NETWORK_LIMITS.maxHeadersPerMessage + 5; i++) (responseHeaders['Link'] ??= []).push(`</l${i}>; rel=preload`);
    log.responded(responded(request, { responseHeaders }));
    const entry = entries(log).find((e) => e.url.endsWith('/a.js'))!;
    expect(entry.requestHeaders.map((h) => h.name).sort()).toEqual(['referer', 'user-agent']);
    expect(entry.omittedRequestHeaders).toBe(1);
    const referer = entry.requestHeaders.find((h) => h.name === 'referer')!;
    expect(referer.value).toHaveLength(NETWORK_LIMITS.maxHeaderValueChars);
    expect(referer.truncated).toBe(true);
    expect(entry.responseHeaders).toHaveLength(NETWORK_LIMITS.maxHeadersPerMessage);
    expect(entry.responseHeaders.some((h) => h.name === 'x-internal')).toBe(false);
    expect(entry.omittedResponseHeaders).toBeGreaterThanOrEqual(1 + 6);
  });

  test('network-entry-fields', () => {
    const { log } = onPage();
    const long = `https://www.example.com/${'p'.repeat(NETWORK_LIMITS.maxUrlChars)}`;
    const big = sent(long, { resourceType: 'image', method: 'get', timestamp: 2_000 });
    log.sent(big);
    log.responded(responded(big, { statusCode: 200, fromCache: true, responseHeaders: { 'Content-Length': ['12345'] } }));
    log.completed(completed(big, { timestamp: 2_250, fromCache: true }));
    const missing = sent('https://www.example.com/missing.css', { resourceType: 'stylesheet' });
    log.sent(missing);
    log.failed(failed(missing, 'net::ERR_NAME_NOT_RESOLVED'));
    const moved = sent('https://www.example.com/old.js');
    log.sent(moved);
    log.redirected(redirected(moved, 'https://www.example.com/new.js', 302));
    const next = sent('https://www.example.com/new.js', { id: moved.id });
    log.sent(next);
    const [doc, image, css, hop, after] = entries(log);
    expect(doc).toMatchObject({ type: 'document', status: 200, state: 'done', method: 'GET' });
    expect(image).toMatchObject({ type: 'image', method: 'GET', status: 200, size: 12345, fromCache: true, state: 'done', startedAt: 2_000, durationMs: 250, urlTruncated: true });
    expect(image!.url).toHaveLength(NETWORK_LIMITS.maxUrlChars);
    expect(css).toMatchObject({ type: 'stylesheet', state: 'failed', error: 'net::ERR_NAME_NOT_RESOLVED', status: null });
    expect(hop).toMatchObject({ state: 'redirected', status: 302, redirectTo: 'https://www.example.com/new.js' });
    expect(after).toMatchObject({ url: 'https://www.example.com/new.js', state: 'pending', durationMs: null });
    // Every Electron type maps to one of the drawer's.
    for (const [resourceType, type] of Object.entries(NETWORK_TYPE_OF)) {
      const r = sent(`https://www.example.com/t-${resourceType}`, { resourceType: resourceType as OnSendHeadersListenerDetails['resourceType'] });
      log.sent(r);
      expect(entries(log).at(-1)!.type, resourceType).toBe(type);
    }
    // A request of no tab (a service worker's) is not listed.
    const before = entries(log).length;
    log.sent(sent('https://www.example.com/sw', { webContentsId: undefined }));
    expect(entries(log)).toHaveLength(before);
  });

  test('network-third-party-flag', () => {
    const { log } = onPage();
    for (const url of ['https://cdn.example.com/a.js', 'https://example.com/b.js', 'https://tracker.example.net/c.js', 'https://www.example.co.uk/d.js']) log.sent(sent(url));
    const flags = Object.fromEntries(entries(log).map((e) => [e.url, e.thirdParty]));
    expect(flags).toEqual({
      [PAGE]: false,
      'https://cdn.example.com/a.js': false,
      'https://example.com/b.js': false,
      'https://tracker.example.net/c.js': true,
      'https://www.example.co.uk/d.js': true,
    });
  });

  test('network-log-caps-per-document', () => {
    const { log } = onPage(true);
    for (let i = 0; i < NETWORK_LIMITS.maxPerDocument + 25; i++) {
      const r = sent(`https://www.example.com/r${i}`);
      log.sent(r);
      log.completed(completed(r));
    }
    const snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries).toHaveLength(NETWORK_LIMITS.maxPerDocument);
    // The document, then the first requests: the rest were counted.
    expect(snapshot.entries[0]!.type).toBe('document');
    expect(snapshot.entries.at(-1)!.url).toBe(`https://www.example.com/r${NETWORK_LIMITS.maxPerDocument - 2}`);
    expect(snapshot.dropped).toBe(26);
    expect(snapshot.notKept).toBe(0);
  });

  test('network-log-ring-while-closed', () => {
    const { log } = onPage(false);
    const total = NETWORK_LIMITS.closedRingSize + 40;
    const requests = Array.from({ length: total }, (_, i) => sent(`https://www.example.com/r${i}`));
    for (const r of requests) log.sent(r);
    let snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 1);
    expect(snapshot.entries[0]!.url).toBe(PAGE);
    expect(snapshot.entries[1]!.url).toBe('https://www.example.com/r40');
    expect(snapshot.entries.at(-1)!.url).toBe(`https://www.example.com/r${total - 1}`);
    expect(snapshot.notKept).toBe(40);
    // A let-go request's later events add nothing.
    log.responded(responded(requests[0]!));
    log.completed(completed(requests[0]!));
    expect(log.snapshot(TAB)!.entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 1);
    // Opening the drawer keeps everything from now on (up to the document cap).
    log.setFullCapture(true);
    for (let i = 0; i < 10; i++) log.sent(sent(`https://www.example.com/more${i}`));
    snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 11);
    expect(snapshot.notKept).toBe(40);
  });

  test('network-log-resets-on-navigation', () => {
    const { log, changed } = onPage();
    const late = sent('https://www.example.com/slow.js');
    log.sent(late);
    log.sent(sent('https://www.example.com/fast.js'));
    expect(entries(log)).toHaveLength(3);
    changed.mockClear();
    log.navigated(TAB, 'https://www.example.com/next');
    expect(changed).toHaveBeenCalledWith(TAB);
    const snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.pageUrl).toBe('https://www.example.com/next');
    // The old document's late events are not listed in the new one.
    log.responded(responded(late));
    log.completed(completed(late));
    expect(entries(log)).toEqual([]);
    const doc = sent('https://www.example.com/next', { resourceType: 'mainFrame' });
    log.sent(doc);
    expect(entries(log).map((e) => e.url)).toEqual(['https://www.example.com/next']);
    expect(entries(log)[0]!.document).toBe(2);
  });

  test('network-preserve-log', () => {
    const { log } = onPage();
    const OTHER = 9;
    log.navigated(OTHER, 'https://other.test/');
    log.sent(sent('https://other.test/a.js', { webContentsId: OTHER }));
    log.setPreserve(TAB, true);
    log.sent(sent('https://www.example.com/one.js'));
    log.navigated(TAB, 'https://www.example.com/two');
    log.sent(sent('https://www.example.com/two', { resourceType: 'mainFrame' }));
    const snapshot = log.snapshot(TAB)!;
    expect(snapshot.preserve).toBe(true);
    expect(snapshot.entries.map((e) => [e.document, e.url])).toEqual([
      [1, PAGE],
      [1, 'https://www.example.com/one.js'],
      [2, 'https://www.example.com/two'],
    ]);
    // Per tab: the other tab is unaffected and still resets.
    log.navigated(OTHER, 'https://other.test/next');
    expect(log.snapshot(OTHER)!.entries).toEqual([]);
    expect(log.snapshot(OTHER)!.preserve).toBe(false);
    // Capped in all, earlier documents first out.
    for (let doc = 0; doc < 3; doc++) {
      log.navigated(TAB, `https://www.example.com/d${doc}`);
      for (let i = 0; i < NETWORK_LIMITS.maxPreserved / 2; i++) log.sent(sent(`https://www.example.com/d${doc}/${i}`));
    }
    const capped = log.snapshot(TAB)!.entries;
    expect(capped).toHaveLength(NETWORK_LIMITS.maxPreserved);
    expect(capped[0]!.url).toBe('https://www.example.com/d1/0');
    // Off again: the next navigation starts over.
    log.setPreserve(TAB, false);
    log.navigated(TAB, 'https://www.example.com/fresh');
    expect(log.snapshot(TAB)!.entries).toEqual([]);
  });

  test('network-log-tabs-bounded', () => {
    const log = createNetworkLog();
    for (let id = 1; id <= NETWORK_LIMITS.maxTrackedTabs + 3; id++) log.sent(sent(`https://t${id}.test/`, { webContentsId: id }));
    expect(log.snapshot(1)).toBeNull();
    expect(log.snapshot(3)).toBeNull();
    expect(log.snapshot(4)).not.toBeNull();
    log.forget(4);
    expect(log.snapshot(4)).toBeNull();
    log.clear();
    expect(log.snapshot(NETWORK_LIMITS.maxTrackedTabs + 3)).toBeNull();
  });
});
