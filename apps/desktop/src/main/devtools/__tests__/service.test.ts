// Spec: specs/devtools.spec.ts (MAX_PENDING_DEVTOOLS_WATCHES, REDIRECT_KEY_HEADERS, NETWORK_LIMITS)
// Acceptance: specs/devtools.feature.md (Service)
import { EventEmitter } from 'node:events';
import type { OnBeforeRedirectListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { MAX_PENDING_DEVTOOLS_WATCHES, NETWORK_LIMITS } from '@app/specs/devtools.spec';
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
  const service = createDevtoolsService({
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
  return { service, tabs, live, setResponse: (meta: ResponseMeta | null) => (response = meta) };
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
    const onTwo = service.watch(2, 0, never.signal);
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
    tabs.get(1)!.emit('did-start-navigation', { url: 'https://www.example.com/next', isSameDocument: false, isMainFrame: true });
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
    // Capped: one more answers the oldest early.
    const waits = Array.from({ length: MAX_PENDING_DEVTOOLS_WATCHES + 1 }, () => service.watch(2, service.version(2), never.signal));
    expect(await waits[0]).toBe(service.version(2));
    await onTwo;
    // A destroyed tab is forgotten.
    tabs.get(2)!.destroyed = true;
    tabs.get(2)!.emit('destroyed');
    expect(service.network(2)).toEqual({ status: 'no-tab', tabId: 2 });
    expect(service.console(2)).toEqual({ status: 'no-tab' });
    expect(await service.storage(2)).toEqual({ status: 'no-tab' });
    expect(service.redirects(2)).toEqual({ status: 'no-tab' });
    expect(service.setPreserveLog(2, true)).toBe(false);
    expect(await service.clearSiteData(2)).toBe('refused');
  });

  test('devtools-redirect-trace', () => {
    const { service, setResponse, tabs } = setup();
    tabs.get(1)!.url = 'https://www.example.com/final';
    expect(service.redirects(1)).toEqual({ status: 'none' });
    service.parts.network.navigated(21, 'https://www.example.com/a');
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
    service.parts.network.navigated(21, 'https://www.example.com/other');
    const other = service.redirects(1);
    expect(other.status === 'ready' && other.finalHeaders).toEqual([{ name: 'x-robots-tag', value: 'all', masked: false, truncated: false }]);
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
    service.parts.network.navigated(21, 'https://www.example.com/');
    for (let i = 0; i < NETWORK_LIMITS.closedRingSize + 5; i++) service.observer.sent!(sent(21, `https://www.example.com/${i}`));
    const log = service.network(1);
    expect(log.status === 'ready' && [log.entries.length, log.notKept]).toEqual([NETWORK_LIMITS.closedRingSize, 5]);
    // Preserve log is per tab, through the service.
    expect(service.setPreserveLog(1, true)).toBe(true);
    const preserved = service.network(1);
    expect(preserved.status === 'ready' && preserved.preserve).toBe(true);
    service.clear();
    expect(service.network(1)).toMatchObject({ status: 'ready', entries: [] });
  });
});
