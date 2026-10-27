// Spec: specs/devtools.spec.ts (NETWORK_LIMITS, NETWORK_TYPE_OF, SECRET_HEADERS, MASKED_VALUE,
// REQUEST_HEADER_ALLOWLIST, RESPONSE_HEADER_KEEP, CRAWLABLE_TYPES, NetworkLogAnswer, NetworkHeadersAnswer)
// Acceptance: specs/devtools.feature.md (Network log)
import type { OnBeforeRedirectListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { MASKED_VALUE, NETWORK_LIMITS, NETWORK_TYPE_OF, type NetworkEntry } from '@app/specs/devtools.spec';
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

/** A log on a committed page (its document's main-frame request answered). */
function onPage(full = true): { log: NetworkLog; changed: ReturnType<typeof vi.fn> } {
  const changed = vi.fn();
  const log = createNetworkLog({ changed });
  log.setFullCapture(full);
  const doc = sent(PAGE, { resourceType: 'mainFrame' });
  log.sent(doc);
  log.responded(responded(doc));
  log.committed(TAB, PAGE);
  log.completed(completed(doc));
  return { log, changed };
}

/** The tab's whole log, as the chrome merges it from a cursor of 0 (every page). */
function snap(log: NetworkLog, tab = TAB) {
  let since = 0;
  const rows = new Map<number, NetworkEntry>();
  for (;;) {
    const answer = log.rows(tab, since)!;
    if (answer.full) rows.clear();
    for (const e of answer.entries) rows.set(e.key, e);
    for (const key of answer.removed) rows.delete(key);
    since = answer.rev;
    if (!answer.more) return { ...answer, entries: [...rows.values()].sort((a, b) => a.key - b.key) };
  }
}

const entries = (log: NetworkLog) => snap(log).entries;
function headersOf(log: NetworkLog, key: number) {
  const answer = log.headers(TAB, key);
  if (answer.status !== 'ready') throw new Error(`no headers for ${key}`);
  return answer;
}
const header = (list: readonly { name: string; value: string; masked: boolean }[], name: string) => list.find((h) => h.name === name);

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
    const entry = headersOf(log, entries(log).find((e) => e.url.endsWith('/api'))!.key);
    for (const name of ['authorization', 'proxy-authorization', 'cookie']) expect(header(entry.requestHeaders, name), name).toEqual({ name, value: MASKED_VALUE, masked: true, truncated: false });
    expect(header(entry.responseHeaders, 'set-cookie')).toEqual({ name: 'set-cookie', value: MASKED_VALUE, masked: true, truncated: false });
    expect(entry.responseHeaders.filter((h) => h.name === 'set-cookie')).toHaveLength(1);
    expect(header(entry.requestHeaders, 'accept')).toMatchObject({ value: '*/*', masked: false });
    // Nothing in the whole log, rows and headers, holds a secret or a body.
    const everything = JSON.stringify([snap(log), ...entries(log).map((e) => log.headers(TAB, e.key))]);
    for (const leak of ['s3cr3t', 'cHJveHk6cGFzcw', 'abc123', 'zzz-session', 'hunter2', 'uploadData']) expect(everything, leak).not.toContain(leak);
    // Rows carry no headers (they come on demand).
    expect(Object.keys(entries(log)[0]!).sort()).toEqual(
      ['document', 'durationMs', 'error', 'fromCache', 'headersDropped', 'key', 'method', 'redirectTo', 'requestHeaderCount', 'responseHeaderCount', 'rev', 'robots', 'size', 'startedAt', 'state', 'status', 'thirdParty', 'type', 'url', 'urlTruncated'].sort(),
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
    const row = entries(log).find((e) => e.url.endsWith('/a.js'))!;
    expect(NETWORK_LIMITS.maxHeadersPerMessage).toBeLessThanOrEqual(16);
    expect([row.requestHeaderCount, row.responseHeaderCount]).toEqual([2, NETWORK_LIMITS.maxHeadersPerMessage]);
    const entry = headersOf(log, row.key);
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
    const snapshot = snap(log);
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
    let snapshot = snap(log);
    expect(snapshot.entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 1);
    expect(snapshot.entries[0]!.url).toBe(PAGE);
    expect(snapshot.entries[1]!.url).toBe('https://www.example.com/r40');
    expect(snapshot.entries.at(-1)!.url).toBe(`https://www.example.com/r${total - 1}`);
    expect(snapshot.notKept).toBe(40);
    // A let-go request's later events add nothing.
    log.responded(responded(requests[0]!));
    log.completed(completed(requests[0]!));
    expect(snap(log).entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 1);
    // Opening the drawer keeps everything from now on (up to the document cap).
    log.setFullCapture(true);
    for (let i = 0; i < 10; i++) log.sent(sent(`https://www.example.com/more${i}`));
    snapshot = snap(log);
    expect(snapshot.entries).toHaveLength(NETWORK_LIMITS.closedRingSize + 11);
    expect(snapshot.notKept).toBe(40);
  });

  test('network-log-resets-on-commit', () => {
    const { log, changed } = onPage();
    const late = sent('https://www.example.com/slow.js');
    log.sent(late);
    log.sent(sent('https://www.example.com/fast.js'));
    expect(entries(log)).toHaveLength(3);
    // The next document's request, redirected once, while the old page still loads things.
    const next = sent('https://www.example.com/old-next', { resourceType: 'mainFrame' });
    log.sent(next);
    log.redirected(redirected(next, 'https://www.example.com/next'));
    const hop = sent('https://www.example.com/next', { id: next.id, resourceType: 'mainFrame' });
    log.sent(hop);
    log.sent(sent('https://www.example.com/old-page-beacon'));
    log.responded(responded(hop));
    // Sent once the new document's response started: the new document's.
    log.sent(sent('https://www.example.com/next.css', { resourceType: 'stylesheet' }));
    expect(entries(log)).toHaveLength(7);
    changed.mockClear();
    log.committed(TAB, 'https://www.example.com/next#top');
    expect(changed).toHaveBeenCalledWith(TAB);
    const snapshot = snap(log);
    expect(snapshot.entries.map((e) => [e.document, e.url])).toEqual([
      [2, 'https://www.example.com/old-next'],
      [2, 'https://www.example.com/next'],
      [2, 'https://www.example.com/next.css'],
    ]);
    expect(snapshot.pageUrl).toBe('https://www.example.com/next#top');
    // The committing request's own late events still land; the old document's do not.
    log.completed(completed(hop));
    expect(entries(log)[1]).toMatchObject({ state: 'done' });
    log.responded(responded(late));
    log.completed(completed(late));
    expect(entries(log)).toHaveLength(3);
    // A commit no request was recorded for (back/forward cache): a fresh, empty log.
    log.committed(TAB, 'https://www.example.com/cached');
    expect(entries(log)).toEqual([]);
  });

  test('network-log-survives-uncommitted-navigation', () => {
    const { log } = onPage();
    log.sent(sent('https://www.example.com/app.js'));
    // A link to a 204: a main-frame request that never commits.
    const nothing = sent('https://www.example.com/no-content', { resourceType: 'mainFrame' });
    log.sent(nothing);
    log.responded(responded(nothing, { statusCode: 204 }));
    log.completed(completed(nothing, { statusCode: 204 }));
    expect(entries(log).map((e) => e.url)).toEqual([PAGE, 'https://www.example.com/app.js', 'https://www.example.com/no-content']);
    expect(entries(log).every((e) => e.document === 1)).toBe(true);
    expect(snap(log).pageUrl).toBe(PAGE);
  });

  test('network-log-byte-budgets', () => {
    const { log } = onPage();
    const bigHeaders = (n: number) => ({ Link: Array.from({ length: n }, (_, i) => `<https://www.example.com/${i}/${'h'.repeat(NETWORK_LIMITS.maxHeaderValueChars)}>; rel=preload`) });
    // Headers that do not fit are left off; the row stays.
    const added = 400;
    for (let i = 0; i < added; i++) {
      const r = sent(`https://www.example.com/x${i}`, { resourceType: 'xhr' });
      log.sent(r);
      log.responded(responded(r, { responseHeaders: bigHeaders(16) }));
    }
    expect(log.bytes(TAB)).toBeLessThanOrEqual(NETWORK_LIMITS.tabBudgetBytes);
    const rows = snap(log);
    expect(rows.entries).toHaveLength(1 + added);
    const dropped = rows.entries.filter((e) => e.headersDropped);
    expect(dropped.length).toBeGreaterThan(0);
    expect(log.headers(TAB, dropped[0]!.key)).toMatchObject({ status: 'ready', responseHeaders: [], headersDropped: true });
    expect(rows.overBudget.bytes).toBeGreaterThan(0);
    // Rows that do not fit are not kept, and counted.
    for (let i = 0; i < 1_500; i++) log.sent(sent(`https://www.example.com/${'u'.repeat(NETWORK_LIMITS.maxUrlChars)}${i}`));
    const after = snap(log);
    expect(after.overBudget.entries).toBeGreaterThan(0);
    expect(log.bytes(TAB)).toBeLessThanOrEqual(NETWORK_LIMITS.tabBudgetBytes);
    expect(after.entries.length + after.overBudget.entries).toBe(1 + added + 1_500);
    // A reset gives the bytes back.
    log.committed(TAB, 'https://www.example.com/next');
    expect(log.bytes(TAB)).toBe(0);
    expect(log.bytes()).toBe(0);
    // All tabs together stay within the global budget.
    const tabs = Math.ceil(NETWORK_LIMITS.globalBudgetBytes / NETWORK_LIMITS.tabBudgetBytes) + 3;
    for (let tab = 100; tab < 100 + tabs; tab++) {
      for (let i = 0; i < 1_200; i++) log.sent(sent(`https://t${tab}.test/${'u'.repeat(NETWORK_LIMITS.maxUrlChars)}${i}`, { webContentsId: tab }));
    }
    expect(log.bytes()).toBeLessThanOrEqual(NETWORK_LIMITS.globalBudgetBytes);
    expect(snap(log, 100 + tabs - 1).overBudget.entries).toBeGreaterThan(0);
    // Forgetting a tab gives its bytes back to the others.
    const before = log.bytes();
    log.forget(100);
    expect(log.bytes()).toBeLessThan(before);
  });

  test('network-log-hostile-server-bounded', () => {
    const { log } = onPage();
    // The review's server: 2,000 XHRs, long URLs, 32 long `link` headers each (98 MB before the fix).
    for (let i = 0; i < 2_000; i++) {
      const r = sent(`https://www.example.com/${'q'.repeat(NETWORK_LIMITS.maxUrlChars)}${i}`, { resourceType: 'xhr' });
      log.sent(r);
      log.responded(responded(r, { responseHeaders: { Link: Array.from({ length: 32 }, (_, n) => `<${'l'.repeat(2_000)}${n}>; rel=preload`) } }));
      log.completed(completed(r));
    }
    const rows = snap(log);
    const headers = rows.entries.map((e) => log.headers(TAB, e.key));
    // Rows and headers together, as the chrome could ever fetch them (UTF-16): within the tab budget and JSON's overhead.
    const bytes = 2 * (JSON.stringify(rows).length + JSON.stringify(headers).length);
    expect(bytes).toBeLessThanOrEqual(NETWORK_LIMITS.tabBudgetBytes * 1.25);
    expect(log.bytes(TAB)).toBeLessThanOrEqual(NETWORK_LIMITS.tabBudgetBytes);
    expect(rows.overBudget.entries + rows.entries.length).toBe(2_001);
    // Rows keep at least half the budget: headers never crowd every later request out.
    expect(rows.entries.length).toBeGreaterThan(400);
  });

  test('network-rows-incremental', () => {
    const { log } = onPage();
    const first = log.rows(TAB, 0)!;
    expect(first).toMatchObject({ full: true, more: false, removed: [] });
    expect(first.entries).toHaveLength(1);
    // Nothing changed: an empty answer.
    expect(log.rows(TAB, first.rev)).toMatchObject({ full: false, entries: [], removed: [], rev: first.rev });
    // Only the changed rows.
    const r = sent('https://www.example.com/a.js');
    log.sent(r);
    const second = log.rows(TAB, first.rev)!;
    expect(second.full).toBe(false);
    expect(second.entries.map((e) => e.url)).toEqual(['https://www.example.com/a.js']);
    log.responded(responded(r, { statusCode: 203 }));
    const third = log.rows(TAB, second.rev)!;
    expect(third.entries.map((e) => [e.url, e.status])).toEqual([['https://www.example.com/a.js', 203]]);
    expect(third.rev).toBeGreaterThan(second.rev);
    // Removed rows are named (the closed drawer's ring lets them go).
    log.setFullCapture(false);
    for (let i = 0; i < NETWORK_LIMITS.closedRingSize + 1; i++) log.sent(sent(`https://www.example.com/r${i}`));
    const fourth = log.rows(TAB, third.rev)!;
    expect(fourth.removed).toEqual([second.entries[0]!.key, expect.any(Number)]);
    // Paged.
    log.setFullCapture(true);
    for (let i = 0; i < NETWORK_LIMITS.maxRowsPerAnswer + 20; i++) log.sent(sent(`https://www.example.com/p${i}`));
    const page = log.rows(TAB, fourth.rev)!;
    expect(page.entries).toHaveLength(NETWORK_LIMITS.maxRowsPerAnswer);
    expect(page.more).toBe(true);
    const rest = log.rows(TAB, page.rev)!;
    expect(rest.entries).toHaveLength(20);
    expect(rest.more).toBe(false);
    // A cursor from before a reset gets everything again.
    log.committed(TAB, 'https://www.example.com/next');
    expect(log.rows(TAB, rest.rev)).toMatchObject({ full: true, entries: [] });
    // A cursor from the future (another tab's) too.
    expect(log.rows(TAB, rest.rev + 1e6)!.full).toBe(true);
  });

  test('network-headers-on-demand', () => {
    const { log } = onPage();
    const r = sent('https://www.example.com/api', { resourceType: 'xhr', requestHeaders: { Authorization: 'Bearer zzz', Accept: 'application/json' } });
    log.sent(r);
    log.responded(responded(r, { responseHeaders: { 'Content-Type': ['application/json'] } }));
    const row = entries(log).at(-1)!;
    expect(log.headers(TAB, row.key)).toEqual({
      status: 'ready',
      key: row.key,
      requestHeaders: [
        { name: 'authorization', value: MASKED_VALUE, masked: true, truncated: false },
        { name: 'accept', value: 'application/json', masked: false, truncated: false },
      ],
      omittedRequestHeaders: 0,
      responseHeaders: [{ name: 'content-type', value: 'application/json', masked: false, truncated: false }],
      omittedResponseHeaders: 0,
      headersDropped: false,
    });
    expect(log.headers(TAB, 999_999)).toEqual({ status: 'gone' });
    expect(log.headers(42, row.key)).toEqual({ status: 'gone' });
  });

  test('network-preserve-log', () => {
    const { log } = onPage();
    const OTHER = 9;
    log.committed(OTHER, 'https://other.test/');
    log.sent(sent('https://other.test/a.js', { webContentsId: OTHER }));
    log.setPreserve(TAB, true);
    log.sent(sent('https://www.example.com/one.js'));
    const two = sent('https://www.example.com/two', { resourceType: 'mainFrame' });
    log.sent(two);
    log.responded(responded(two));
    log.committed(TAB, 'https://www.example.com/two');
    const snapshot = snap(log);
    expect(snapshot.preserve).toBe(true);
    expect(snapshot.entries.map((e) => [e.document, e.url])).toEqual([
      [1, PAGE],
      [1, 'https://www.example.com/one.js'],
      [2, 'https://www.example.com/two'],
    ]);
    // Per tab: the other tab is unaffected and still resets.
    log.committed(OTHER, 'https://other.test/next');
    expect(snap(log, OTHER).entries).toEqual([]);
    expect(snap(log, OTHER).preserve).toBe(false);
    // Capped in all, earlier documents first out.
    for (let doc = 0; doc < 3; doc++) {
      log.committed(TAB, `https://www.example.com/d${doc}`);
      for (let i = 0; i < NETWORK_LIMITS.maxPreserved / 2; i++) log.sent(sent(`https://www.example.com/d${doc}/${i}`));
    }
    const capped = snap(log).entries;
    expect(capped).toHaveLength(NETWORK_LIMITS.maxPreserved);
    expect(capped[0]!.url).toBe('https://www.example.com/d1/0');
    // Off again: the next navigation starts over.
    log.setPreserve(TAB, false);
    log.committed(TAB, 'https://www.example.com/fresh');
    expect(snap(log).entries).toEqual([]);
  });

  test('network-log-tabs-bounded', () => {
    const log = createNetworkLog();
    for (let id = 1; id <= NETWORK_LIMITS.maxTrackedTabs + 3; id++) log.sent(sent(`https://t${id}.test/`, { webContentsId: id }));
    expect(log.rows(1)).toBeNull();
    expect(log.rows(3)).toBeNull();
    expect(log.rows(4)).not.toBeNull();
    log.forget(4);
    expect(log.rows(4)).toBeNull();
    log.clear();
    expect(log.rows(NETWORK_LIMITS.maxTrackedTabs + 3)).toBeNull();
    expect(log.bytes()).toBe(0);
  });
});
