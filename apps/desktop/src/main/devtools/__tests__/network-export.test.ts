// Spec: specs/devtools.spec.ts (NETWORK_EXPORT_FORMATS, NETWORK_EXPORT_RESULTS, NETWORK_CSV_COLUMNS, HAR_NO_BODY_COMMENT,
// EXPORT_URLS_REDACTED_NOTE, EXPORT_URL_PLACES, REDACTED_VALUE, HAR_CREATOR, MASKED_VALUE, DEVTOOLS_TAB_SCOPE),
// specs/devtools.schema.ts (HarLogSchema), specs/seo-sidebar.spec.ts (CSV_FORMULA_PREFIXES)
// Acceptance: specs/devtools.feature.md (Network export)
import { EventEmitter } from 'node:events';
import type { OnBeforeRedirectListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails, OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { EXPORT_URLS_REDACTED_NOTE, HAR_CREATOR, HAR_NO_BODY_COMMENT, MASKED_VALUE, NETWORK_CSV_COLUMNS, REDACTED_VALUE } from '@app/specs/devtools.spec';
import { HarLogSchema, type HarLog } from '@app/specs/devtools.schema';
import { buildCsv, buildHar } from '../network-export';
import { createNetworkLog, type NetworkLog } from '../network-log';
import { createDevtoolsService, type DevtoolsContents, type DevtoolsServiceOptions } from '../service';

const TAB = 7;
const PAGE = 'https://www.example.com/page?session=pagesecret1&q=shoes#frag-secret';
const R = REDACTED_VALUE;
let nextId = 1;

function sent(url: string, more: Partial<OnSendHeadersListenerDetails> = {}, tab = TAB): OnSendHeadersListenerDetails {
  return { id: nextId++, url, method: 'GET', webContentsId: tab, resourceType: 'script', referrer: '', timestamp: 1_700_000_000_000, requestHeaders: {}, ...more } as OnSendHeadersListenerDetails;
}
const responded = (of: OnSendHeadersListenerDetails, more: Partial<OnResponseStartedListenerDetails> = {}) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_700_000_000_050, fromCache: false, statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: {}, ...more }) as OnResponseStartedListenerDetails;
const completed = (of: OnSendHeadersListenerDetails) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_700_000_000_120, fromCache: false, statusCode: 200, statusLine: '', error: '' }) as OnCompletedListenerDetails;
const failed = (of: OnSendHeadersListenerDetails, error: string) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_700_000_000_200, fromCache: false, error }) as OnErrorOccurredListenerDetails;
const redirected = (of: OnSendHeadersListenerDetails, to: string, responseHeaders: Record<string, string[]> = {}) =>
  ({ id: of.id, url: of.url, method: of.method, webContentsId: of.webContentsId, resourceType: of.resourceType, referrer: '', timestamp: 1_700_000_000_010, redirectURL: to, statusCode: 302, statusLine: '', fromCache: false, responseHeaders }) as OnBeforeRedirectListenerDetails;

/** A log of one committed page with a script, a fetch with secrets, a redirect, a failure and a pending request. */
function recorded(log: NetworkLog = createNetworkLog(), tab = TAB): NetworkLog {
  log.setFullCapture(true);
  const doc = sent(PAGE, { resourceType: 'mainFrame', requestHeaders: { Cookie: 'sid=cookiesecret1', 'User-Agent': 'frost-test' } }, tab);
  log.sent(doc);
  log.responded(responded(doc, { responseHeaders: { 'Set-Cookie': ['a=setcookiesecret1'], 'Content-Type': ['text/html'], Link: ['<https://cdn.example.com/a.css?sig=linksecret1>; rel=preload, <https://cdn.example.com/b.css?token=linksecret2'] } }));
  log.committed(tab, PAGE);
  log.completed(completed(doc));
  const api = sent('https://api.example.com/v1/items?access_token=urlsecret1&page=2&to=jane%40mail.example#x', {
    resourceType: 'xhr',
    requestHeaders: { Authorization: 'Bearer authsecret1', Referer: 'https://www.example.com/page?code=refsecret1&q=shoes#frag' },
  }, tab);
  log.sent(api);
  log.responded(responded(api, { responseHeaders: { 'Content-Type': ['application/json'], 'Content-Length': ['12'] } }));
  log.completed(completed(api));
  const hop = sent('https://www.example.com/go?state=statesecret1', { resourceType: 'subFrame' }, tab);
  log.sent(hop);
  log.redirected(redirected(hop, 'https://login.example.com/cb?id_token=redirsecret1&lang=en', { Location: ['https://login.example.com/cb?id_token=redirsecret1&lang=en'] }));
  const bad = sent('https://www.example.com/missing.js?v=1', { method: '-2+3' }, tab);
  log.sent(bad);
  log.failed(failed(bad, '=HYPERLINK("https://evil.example")'));
  log.sent(sent('https://www.example.com/slow?nonce=pendingsecret1', {}, tab));
  return log;
}

const SECRETS = ['pagesecret1', 'frag-secret', 'cookiesecret1', 'setcookiesecret1', 'linksecret1', 'linksecret2', 'urlsecret1', 'jane%40mail.example', 'jane@mail.example', 'authsecret1', 'refsecret1', 'statesecret1', 'redirsecret1', 'pendingsecret1'];

const harOf = (log: NetworkLog): HarLog => buildHar(log.exportSnapshot(TAB)!, '1.2.3');
const entryFor = (har: HarLog, host: string) => har.log.entries.find((e) => e.request.url.includes(host))!;

describe('network export', () => {
  test('har-has-no-bodies-and-says-so', () => {
    const har = harOf(recorded());
    expect(har.log.entries.length).toBe(5);
    for (const entry of har.log.entries) {
      expect(entry.request.bodySize).toBe(-1);
      expect(entry.response.bodySize).toBe(-1);
      expect(entry.response.content.size).toBe(-1);
      expect(entry.response.content).not.toHaveProperty('text');
      expect(entry.response.content).not.toHaveProperty('encoding');
      expect(entry.request).not.toHaveProperty('postData');
      expect(entry.request.comment).toBe(HAR_NO_BODY_COMMENT);
      expect(entry.response.content.comment).toBe(HAR_NO_BODY_COMMENT);
    }
    expect(har.log.comment).toContain('Bodies are never recorded');
  });

  test('har-masks-secret-headers', () => {
    const har = harOf(recorded());
    const doc = har.log.entries[0]!;
    expect(doc.request.headers).toContainEqual({ name: 'cookie', value: MASKED_VALUE });
    expect(doc.response.headers).toContainEqual({ name: 'set-cookie', value: MASKED_VALUE });
    expect(entryFor(har, 'api.example.com').request.headers).toContainEqual({ name: 'authorization', value: MASKED_VALUE });
    const text = JSON.stringify(har);
    for (const secret of ['cookiesecret1', 'setcookiesecret1', 'authsecret1']) expect(text).not.toContain(secret);
  });

  test('har-redacts-sensitive-query-params', () => {
    const har = harOf(recorded());
    expect(entryFor(har, 'api.example.com').request.url).toBe(`https://api.example.com/v1/items?access_token=${R}&page=2&to=${R}`);
    expect(entryFor(har, '/slow').request.url).toBe(`https://www.example.com/slow?nonce=${R}`);
    // Nothing secret anywhere in the file, whichever place carried it.
    const text = JSON.stringify(har);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  test('har-querystring-array-redacted', () => {
    const entry = entryFor(harOf(recorded()), 'api.example.com');
    expect(entry.request.queryString).toEqual([
      { name: 'access_token', value: R },
      { name: 'page', value: '2' },
      { name: 'to', value: R },
    ]);
  });

  test('har-redirect-url-redacted', () => {
    const entry = entryFor(harOf(recorded()), '/go?');
    expect(entry.request.url).toBe(`https://www.example.com/go?state=${R}`);
    expect(entry.response.status).toBe(302);
    expect(entry.response.redirectURL).toBe(`https://login.example.com/cb?id_token=${R}&lang=en`);
  });

  test('har-redacts-referer-and-location-headers', () => {
    const har = harOf(recorded());
    expect(entryFor(har, 'api.example.com').request.headers).toContainEqual({ name: 'referer', value: `https://www.example.com/page?code=${R}&q=shoes` });
    expect(entryFor(har, '/go?').response.headers).toContainEqual({ name: 'location', value: `https://login.example.com/cb?id_token=${R}&lang=en` });
  });

  test('har-redacts-link-header-urls', () => {
    const doc = harOf(recorded()).log.entries[0]!;
    expect(doc.response.headers).toContainEqual({ name: 'link', value: `<https://cdn.example.com/a.css?sig=${R}>; rel=preload, <https://cdn.example.com/b.css?token=${R}` });
  });

  test('har-page-url-redacted', () => {
    const har = harOf(recorded());
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.pages[0]!.title).toBe(`https://www.example.com/page?session=${R}&q=shoes`);
    for (const entry of har.log.entries) expect(entry.pageref).toBe(har.log.pages[0]!.id);
  });

  test('csv-redacts-sensitive-query-params', () => {
    const csv = buildCsv(recorded().exportSnapshot(TAB)!);
    expect(csv).toContain(`https://api.example.com/v1/items?access_token=${R}&page=2&to=${R}`);
    expect(csv).toContain(`https://login.example.com/cb?id_token=${R}&lang=en`);
    for (const secret of SECRETS) expect(csv, secret).not.toContain(secret);
  });

  test('export-says-best-effort-redaction', () => {
    const log = recorded();
    const har = harOf(log);
    const csv = buildCsv(log.exportSnapshot(TAB)!);
    const lines = csv.split('\r\n');
    expect(har.log.comment.startsWith(EXPORT_URLS_REDACTED_NOTE)).toBe(true);
    expect(lines[0]).toBe(`"${EXPORT_URLS_REDACTED_NOTE}"`);
    expect(lines[1]).toBe(NETWORK_CSV_COLUMNS.join(','));
    for (const text of [har.log.comment, lines[0]!, HAR_NO_BODY_COMMENT, EXPORT_URLS_REDACTED_NOTE]) {
      expect(text).not.toMatch(/no (secret|token|personal)|secret-free|contains? no|free of|safe to share|fully redacted|all (secrets|sensitive)/i);
    }
    expect(EXPORT_URLS_REDACTED_NOTE).toMatch(/best effort/);
  });

  test('har-matches-har-log-schema', () => {
    const log = createNetworkLog();
    recorded(log);
    // "Preserve log": a second document's requests too (two pages).
    log.setPreserve(TAB, true);
    const next = sent('https://www.example.com/next', { resourceType: 'mainFrame' });
    log.sent(next);
    log.responded(responded(next));
    log.committed(TAB, 'https://www.example.com/next');
    log.completed(completed(next));
    const har = harOf(log);
    const parsed = HarLogSchema.safeParse(har);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: HAR_CREATOR.name, version: '1.2.3' });
    expect(har.log.pages.map((p) => p.title)).toEqual([`https://www.example.com/page?session=${R}&q=shoes`, 'https://www.example.com/next']);
    // A JSON round trip (as written to disk) is still valid.
    expect(HarLogSchema.safeParse(JSON.parse(JSON.stringify(har))).success).toBe(true);
    // Failed and pending answers: status 0, no timing below zero.
    const bad = entryFor(har, 'missing.js');
    expect(bad.response.status).toBe(0);
    expect(bad.comment).toContain('Failed');
  });

  test('har-comment-counts-dropped', () => {
    const log = createNetworkLog();
    recorded(log);
    log.setFullCapture(false);
    for (let i = 0; i < 105; i++) log.sent(sent(`https://www.example.com/r${i}.js`));
    const snapshot = log.exportSnapshot(TAB)!;
    expect(snapshot.notKept).toBeGreaterThan(0);
    const comment = buildHar({ ...snapshot, dropped: 3, overBudget: { entries: 4, bytes: 512 } }, '1').log.comment;
    expect(comment).toContain('3 requests past the log');
    expect(comment).toContain(`${snapshot.notKept} let go while the drawer was closed`);
    expect(comment).toContain('4 requests and 512 bytes over');
  });

  test('csv-formula-guard', () => {
    const csv = buildCsv(recorded().exportSnapshot(TAB)!);
    const row = csv.split('\r\n').find((line) => line.includes('missing.js'))!;
    // The page chose the method; Chromium's error text is guarded the same way.
    expect(row).toContain(",'-2+3,");
    expect(row).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
    for (const line of csv.split('\r\n').slice(1)) for (const cell of line.split(',')) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });
});

// ---- Through the service: the active tab, main's dialog, the file ----

class FakeContents extends EventEmitter {
  url = PAGE;
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return false;
  }
}

function serviceWith(over: Partial<NonNullable<DevtoolsServiceOptions['networkExport']>> = {}) {
  const tabs = new Map<number, FakeContents>([[1, new FakeContents(TAB)], [2, new FakeContents(8)]]);
  const writes: { path: string; data: string }[] = [];
  const chooseSavePath = vi.fn(async (_name: string, _format: string): Promise<string | null> => '/downloads/net.har');
  const service = createDevtoolsService({
    activeTabId: () => 1,
    contentsOf: (tabId) => (tabs.get(tabId) as unknown as DevtoolsContents) ?? null,
    tabIdOf: (contentsId) => [...tabs.entries()].find(([, c]) => c.id === contentsId)?.[0] ?? null,
    responses: { responseFor: () => null },
    robots: () => null,
    robotsVerdicts: async () => ({ ok: false, reason: 'invalid-job' }),
    cookies: async () => [],
    confirmClearSiteData: async () => true,
    clearOrigin: async () => undefined,
    liveWindow: () => true,
    networkExport: {
      chooseSavePath,
      writeFile: async (path, data) => {
        writes.push({ path, data });
      },
      appVersion: '9.9.9',
      now: () => new Date(2026, 10, 9, 8, 7, 6),
      ...over,
    },
  });
  for (const c of tabs.values()) service.watchContents(c as unknown as DevtoolsContents);
  return { service, writes, chooseSavePath: over.chooseSavePath ?? chooseSavePath };
}

describe('network export through the service', () => {
  test('export-active-tab-only', async () => {
    const { service, writes, chooseSavePath } = serviceWith();
    recorded(service.parts.network, 8);
    // Tab 2 (contents 8) has a log, but it is not the active tab: nothing asked, nothing written.
    await expect(service.exportNetwork(2, 'har')).resolves.toBe('empty');
    await expect(service.exportNetwork(99, 'csv')).resolves.toBe('empty');
    expect(chooseSavePath).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    recorded(service.parts.network, TAB);
    await expect(service.exportNetwork(1, 'har')).resolves.toBe('saved');
    expect(chooseSavePath).toHaveBeenCalledExactlyOnceWith('frost-network-www.example.com-20261109-080706.har', 'har');
    expect(writes).toHaveLength(1);
    const har = JSON.parse(writes[0]!.data) as HarLog;
    expect(HarLogSchema.safeParse(har).success).toBe(true);
    // Only the active tab's requests (contents 7), never tab 2's.
    expect(har.log.entries).toHaveLength(5);
    expect(har.log.creator.version).toBe('9.9.9');
    await expect(service.exportNetwork(1, 'csv')).resolves.toBe('saved');
    expect(writes[1]!.data.split('\r\n')[0]).toBe(`"${EXPORT_URLS_REDACTED_NOTE}"`);
  });

  test('one-export-dialog-at-a-time', async () => {
    let answer: (path: string | null) => void = () => undefined;
    const slow = vi.fn((_name: string, _format: string) => new Promise<string | null>((resolve) => (answer = resolve)));
    const { service, writes } = serviceWith({ chooseSavePath: slow });
    recorded(service.parts.network, TAB);
    const first = service.exportNetwork(1, 'har');
    await vi.waitFor(() => expect(slow).toHaveBeenCalledOnce());
    // A second export while main's dialog is open: no second dialog, nothing written.
    await expect(service.exportNetwork(1, 'csv')).resolves.toBe('cancelled');
    expect(slow).toHaveBeenCalledOnce();
    answer('/downloads/one.har');
    await expect(first).resolves.toBe('saved');
    expect(writes.map((w) => w.path)).toEqual(['/downloads/one.har']);
    // Once it is done, the next export asks again.
    const again = service.exportNetwork(1, 'csv');
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
    answer(null);
    await expect(again).resolves.toBe('cancelled');
  });

  test('cancelled-writes-nothing', async () => {
    const cancel = vi.fn(async () => null);
    const { service, writes } = serviceWith({ chooseSavePath: cancel });
    // An empty log: `empty`, no dialog.
    await expect(service.exportNetwork(1, 'har')).resolves.toBe('empty');
    expect(cancel).not.toHaveBeenCalled();
    recorded(service.parts.network, TAB);
    await expect(service.exportNetwork(1, 'har')).resolves.toBe('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    // A dialog or write failure: `failed`, never a rejection.
    const broken = serviceWith({
      writeFile: async () => {
        throw new Error('disk full');
      },
    });
    recorded(broken.service.parts.network, TAB);
    await expect(broken.service.exportNetwork(1, 'csv')).resolves.toBe('failed');
    const noDialog = serviceWith({
      chooseSavePath: async () => {
        throw new Error('no window');
      },
    });
    recorded(noDialog.service.parts.network, TAB);
    await expect(noDialog.service.exportNetwork(1, 'csv')).resolves.toBe('failed');
  });
});
