// Spec: specs/devtools.spec.ts (MAX_PENDING_DEVTOOLS_WATCHES, DEVTOOLS_WATCH_EVICTED, DEVTOOLS_TAB_SCOPE, REDIRECT_KEY_HEADERS, NETWORK_LIMITS)
// Acceptance: specs/devtools.feature.md (Service)
import { EventEmitter } from 'node:events';
import type { OnBeforeRedirectListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { DEVTOOLS_WATCH_EVICTED, MAX_PENDING_DEVTOOLS_WATCHES, NETWORK_LIMITS } from '@app/specs/devtools.spec';
import type { ResponseMeta } from '@app/specs/seo-snapshot.spec';
import { createDevtoolsService, type DevtoolsContents, type DevtoolsServiceOptions } from '../service';

class FakeContents extends EventEmitter {
  url = 'https://www.example.com/start';
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function setup(over: Partial<DevtoolsServiceOptions> = {}) {
  const tabs = new Map<number, FakeContents>([[1, new FakeContents(21)], [2, new FakeContents(22)]]);
  let response: ResponseMeta | null = null;
  const live = new Set([100, 101]);
  let active = 1;
  const service = createDevtoolsService({
    activeTabId: () => active,
    contentsOf: (tabId) => (tabs.get(tabId) as unknown as DevtoolsContents) ?? null,
    tabIdOf: (contentsId) => [...tabs.entries()].find(([, c]) => c.id === contentsId)?.[0] ?? null,
    responses: { responseFor: () => response },
    robots: () => null,
    robotsVerdicts: async () => ({ ok: false, reason: 'invalid-job' }),
    cookies: async () => [{ name: 'a', value: 'secret' }],
    confirmClearSiteData: async () => true,
    clearOrigin: async () => undefined,
    liveWindow: (id) => live.has(id),
    ...over,
  });
  for (const contents of tabs.values()) service.watchContents(contents as unknown as DevtoolsContents);
  return { service, tabs, live, setResponse: (meta: ResponseMeta | null) => (response = meta), setActive: (id: number) => (active = id) };
}

let nextId = 1;
const sent = (contentsId: number, url: string, resourceType = 'script') =>
  ({ id: nextId++, url, method: 'GET', webContentsId: contentsId, resourceType, referrer: '', timestamp: 1, requestHeaders: {} }) as unknown as OnSendHeadersListenerDetails;

describe('devtools service', () => {
  test('devtools-watch-wakes-on-change', async () => {
    const { service, tabs } = setup();
    expect(service.version(1)).toBe(0);
    expect(service.version(99)).toBe(0);
    // A request wakes a waiter on its tab only.
    const never = new AbortController();
    const onOne = service.watch(1, 0, never.signal);
    service.observer.sent!(sent(22, 'https://www.example.com/other-tab.js'));
    service.observer.sent!(sent(21, 'https://www.example.com/a.js'));
    const v1 = await onOne;
    expect(v1).toBeGreaterThan(0);
    expect(service.version(1)).toBe(v1);
    // Already newer: at once.
    expect(await service.watch(1, v1 - 1, never.signal)).toBe(v1);
    // A console message and a navigation change the version too.
    const next = service.watch(1, v1, never.signal);
    tabs.get(1)!.emit('console-message', { level: 'info', message: 'hi', sourceId: '', lineNumber: 1 });
    const v2 = await next;
    expect(v2).toBeGreaterThan(v1);
    const nav = service.watch(1, v2, never.signal);
    tabs.get(1)!.emit('did-navigate', {}, 'https://www.example.com/next', 200);
    expect(await nav).toBeGreaterThan(v2);
    const c = service.console(1);
    expect(c).toEqual({ status: 'ready', entries: [], total: 0, dropped: 0 });
    // A reveal does too.
    const reveal = service.watch(1, service.version(1), never.signal);
    expect(await service.revealCookie(1, { name: 'a', domain: '', path: '' })).toBe(true);
    expect(await reveal).toBe(service.version(1));
    // Aborted: the current version.
    const aborted = new AbortController();
    const waiting = service.watch(1, service.version(1), aborted.signal);
    aborted.abort();
    expect(await waiting).toBe(service.version(1));
    // A future version waits for the next change, not forever.
    const future = service.watch(1, 1e9, never.signal);
    service.observer.sent!(sent(21, 'https://www.example.com/b.js'));
    expect(await future).toBe(service.version(1));
    // A destroyed tab is forgotten.
    tabs.get(1)!.destroyed = true;
    tabs.get(1)!.emit('destroyed');
    expect(service.network(1, 0)).toEqual({ status: 'no-tab', tabId: 1 });
    expect(service.console(1)).toEqual({ status: 'no-tab' });
    expect(await service.storage(1)).toEqual({ status: 'no-tab' });
    expect(service.redirects(1)).toEqual({ status: 'no-tab' });
    expect(service.setPreserveLog(1, true)).toBe(false);
    expect(await service.clearSiteData(1)).toBe('refused');
  });

  test('devtools-watch-eviction-marker', async () => {
    const { service } = setup();
    const never = new AbortController();
    const waits = Array.from({ length: MAX_PENDING_DEVTOOLS_WATCHES + 2 }, () => service.watch(1, 0, never.signal));
    // The two oldest are pushed out: a marker, never a version (so the chrome knows to back off).
    expect(await waits[0]).toBe(DEVTOOLS_WATCH_EVICTED);
    expect(await waits[1]).toBe(DEVTOOLS_WATCH_EVICTED);
    expect(DEVTOOLS_WATCH_EVICTED).toBeLessThan(0);
    service.observer.sent!(sent(21, 'https://www.example.com/a.js'));
    for (const wait of waits.slice(2)) expect(await wait).toBe(service.version(1));
  });

  test('devtools-active-tab-only', async () => {
    const { service, setActive } = setup();
    service.observer.sent!(sent(22, 'https://www.example.com/secret-tab.js'));
    service.parts.console.add(22, { level: 'info', message: 'other tab' });
    const never = new AbortController();
    // Tab 2 is open but not active: nothing of it is served.
    expect(service.version(2)).toBe(0);
    expect(await service.watch(2, 0, never.signal)).toBe(0);
    expect(service.network(2, 0)).toEqual({ status: 'no-tab', tabId: 2 });
    expect(service.requestHeaders(2, 1)).toEqual({ status: 'gone' });
    expect(service.redirects(2)).toEqual({ status: 'no-tab' });
    expect(service.console(2)).toEqual({ status: 'no-tab' });
    expect(await service.storage(2)).toEqual({ status: 'no-tab' });
    expect(await service.revealCookie(2, { name: 'a', domain: '', path: '' })).toBe(false);
    expect(await service.clearSiteData(2)).toBe('refused');
    expect(service.setPreserveLog(2, true)).toBe(false);
    // Once it is the active tab, it is.
    setActive(2);
    const log = service.network(2, 0);
    expect(log.status === 'ready' && log.entries.map((e) => e.url)).toEqual(['https://www.example.com/secret-tab.js']);
    expect(log.status === 'ready' && service.requestHeaders(2, log.entries[0]!.key)).toMatchObject({ status: 'ready' });
    expect(service.console(2)).toMatchObject({ status: 'ready', total: 1 });
    expect(service.version(2)).toBeGreaterThan(0);
  });

  test('devtools-redirect-trace', () => {
    const { service, setResponse, tabs } = setup();
    tabs.get(1)!.url = 'https://www.example.com/final';
    expect(service.redirects(1)).toEqual({ status: 'none' });
    service.parts.network.committed(21, 'https://www.example.com/a');
    const first = sent(21, 'https://www.example.com/a', 'mainFrame');
    service.observer.sent!(first);
    service.observer.redirected!({ ...first, redirectURL: 'https://www.example.com/b', statusCode: 301, statusLine: '', fromCache: false, responseHeaders: { Location: ['https://www.example.com/b'], 'Cache-Control': ['max-age=3600'], 'X-Robots-Tag': ['noindex'], 'Set-Cookie': ['t=1'] } } as unknown as OnBeforeRedirectListenerDetails);
    service.observer.responded!({ ...first, url: 'https://www.example.com/final', statusCode: 200, statusLine: '', fromCache: false, responseHeaders: { 'Cache-Control': ['no-cache'] } } as unknown as OnResponseStartedListenerDetails);
    setResponse({
      url: 'https://www.example.com/final',
      source: 'network',
      status: 200,
      headersAvailable: true,
      headers: [{ name: 'x-robots-tag', value: 'all' }],
      redirects: [
        { url: 'https://www.example.com/a', status: 301, location: 'https://www.example.com/b', internal: false },
        { url: 'https://www.example.com/b', status: 302, location: 'https://www.example.com/final', internal: false },
      ],
      redirectTotal: 2,
    });
    const trace = service.redirects(1);
    expect(trace).toEqual({
      status: 'ready',
      url: 'https://www.example.com/final',
      source: 'network',
      hopTotal: 2,
      finalStatus: 200,
      finalHeaders: [{ name: 'cache-control', value: 'no-cache', masked: false, truncated: false }],
      hops: [
        {
          url: 'https://www.example.com/a',
          status: 301,
          location: 'https://www.example.com/b',
          internal: false,
          headersRecorded: true,
          headers: [
            { name: 'location', value: 'https://www.example.com/b', masked: false, truncated: false },
            { name: 'cache-control', value: 'max-age=3600', masked: false, truncated: false },
            { name: 'x-robots-tag', value: 'noindex', masked: false, truncated: false },
            { name: 'set-cookie', value: '•••', masked: true, truncated: false },
          ],
        },
        { url: 'https://www.example.com/b', status: 302, location: 'https://www.example.com/final', internal: false, headersRecorded: false, headers: [] },
      ],
    });
    // Without the recorder's own final headers, the response recorder's key headers.
    service.parts.network.committed(21, 'https://www.example.com/other');
    const other = service.redirects(1);
    expect(other.status === 'ready' && other.finalHeaders).toEqual([{ name: 'x-robots-tag', value: 'all', masked: false, truncated: false }]);
  });

  test('devtools-clear-browsing-data', async () => {
    const { service, tabs, setActive } = setup();
    const never = new AbortController();
    service.observer.sent!(sent(21, 'https://www.example.com/a.js'));
    service.observer.sent!(sent(22, 'https://www.example.com/other-tab.js'));
    tabs.get(1)!.emit('console-message', { level: 'info', message: 'hi', sourceId: '', lineNumber: 1 });
    expect(await service.revealCookie(1, { name: 'a', domain: '', path: '' })).toBe(true);
    expect(await service.storage(1)).toMatchObject({ cookies: [{ name: 'a', value: 'secret' }] });
    // What an open drawer holds: the rows and the cursor of its last answer.
    const held = service.network(1, 0);
    expect(held.status === 'ready' && held.entries.map((e) => e.url)).toEqual(['https://www.example.com/a.js']);
    const cursor = held.status === 'ready' ? held.rev : -1;
    const seen = service.version(1);
    setActive(2);
    const otherSeen = service.version(2);
    setActive(1);
    const woken = service.watch(1, seen, never.signal);
    service.clear();
    // Its watch wakes (and every other tab that had data moves on too).
    expect(service.version(1)).toBeGreaterThan(seen);
    expect(await woken).toBe(service.version(1));
    setActive(2);
    expect(service.version(2)).toBeGreaterThan(otherSeen);
    setActive(1);
    // Asking again: nothing cleared is left.
    expect(service.console(1)).toEqual({ status: 'ready', entries: [], total: 0, dropped: 0 });
    expect(await service.storage(1)).toMatchObject({ status: 'ready', cookies: [{ name: 'a', value: null }] });
    expect(service.network(1, cursor)).toMatchObject({ status: 'ready', full: true, entries: [] });
    // The next request: the old cursor still gets a full answer, so the cleared rows go.
    service.observer.sent!(sent(21, 'https://www.example.com/b.js'));
    const next = service.network(1, cursor);
    expect(next).toMatchObject({ status: 'ready', full: true, removed: [] });
    expect(next.status === 'ready' && next.entries.map((e) => e.url)).toEqual(['https://www.example.com/b.js']);
  });

  test('devtools-open-switches-capture', () => {
    const { service, live } = setup();
    expect(service.parts.network.fullCapture()).toBe(false);
    service.setOpen(100, true);
    service.setOpen(101, true);
    expect(service.parts.network.fullCapture()).toBe(true);
    service.setOpen(100, false);
    expect(service.parts.network.fullCapture()).toBe(true);
    // A window that went away no longer counts.
    live.delete(101);
    service.setOpen(null, true);
    expect(service.parts.network.fullCapture()).toBe(false);
    // Closed: the small ring.
    service.parts.network.committed(21, 'https://www.example.com/');
    for (let i = 0; i < NETWORK_LIMITS.closedRingSize + 5; i++) service.observer.sent!(sent(21, `https://www.example.com/${i}`));
    const log = service.network(1, 0);
    expect(log.status === 'ready' && [log.entries.length, log.notKept]).toEqual([NETWORK_LIMITS.closedRingSize, 5]);
    // Preserve log is per tab, through the service.
    expect(service.setPreserveLog(1, true)).toBe(true);
    const preserved = service.network(1, 0);
    expect(preserved.status === 'ready' && preserved.preserve).toBe(true);
    service.clear();
    expect(service.network(1, 0)).toMatchObject({ status: 'ready', entries: [] });
  });
});
