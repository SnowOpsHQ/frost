// Specs: specs/location-profiles.spec.ts (LOCATION_BADGE, LOCATION_TAB_REFUSAL_MESSAGE, locationPartition),
// specs/seo-javascript.spec.ts (SERVED_ACCEPT), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH),
// specs/serp-selector-pack.spec.ts (the e2e pack seams), specs/browser-session-db.spec.ts (DB_FILE_NAME)
// Acceptance: specs/location-profiles.feature.md (End to end: the leak test, K-D), plan
// docs/plans/phase-12-big-bets.md Task 11 (location.e2e.ts), Decision 3 (K-D), Decision 11.
//
// The leak test (K-D), as the feature file designs it. The fake site is served on loopback under a
// public-looking name (`SITE_HOST`) that Chromium's implicit loopback bypass does not match, so a
// location tab's requests for it go to the profile's proxy (`fake-proxy.ts`, Basic auth), which maps
// the name to the real origin itself and marks every plain-HTTP request it forwards. The same name,
// resolved directly (`--host-resolver-rules`), lands on a tripwire that records every request: the
// disclosed audit fetches (robots.txt and the served HTML, from the browse session) are expected there
// and classified; anything else is a leak. A NetLog of the location partition and a WebRTC probe in the
// tab complete the check. Loopback only: no request leaves the machine.
import { createHash } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { DB_FILE_NAME } from '@app/specs/browser-session-db.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { LOCATION_BADGE, LOCATION_TAB_REFUSAL_MESSAGE, locationPartition } from '@app/specs/location-profiles.spec';
import { SERVED_ACCEPT } from '@app/specs/seo-javascript.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH } from '@app/specs/serp-selector-pack.spec';
import { FAKE_PROXY_MARKER, startFakeProxy, startTripwire, type FakeProxy, type Tripwire, type TripwireRequest } from './fake-proxy';
import { APP_DIR, closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { PACK_PATH, PACK_VERSION, SEARCH_HOST, engineAnswer, signedTestPack } from './serp-fixtures';

/** The fake site's public-looking name: proxied in a location tab, mapped to the tripwire when resolved directly. */
const SITE_HOST = 'site.frost-e2e.test';
const LABEL = 'Lisbon test proxy';
const AUTH = { username: 'frost-e2e', password: 'proxy-secret-1' } as const;
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 10_000;
const READ_WAIT = 20_000;
const FAKE_KEYCHAIN = path.join(APP_DIR, 'e2e', 'fake-keychain.cjs');

test.describe.configure({ mode: 'serial', timeout: 180_000 });

// ---- The real origin --------------------------------------------------------------------------------

/** One request the real origin answered (the site and the synthetic engine share it). */
interface OriginRecord {
  readonly at: number;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** The fake proxy's marker header, if the request carried it. */
  readonly marker: string | undefined;
  /** The client end's port: a tunnel's (the proxy's own connection) or the app's. */
  readonly remotePort: number;
  readonly upgradeInsecure: boolean;
  readonly websocket: boolean;
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page for frost's location leak test."><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>${title}</h1>${body}</body></html>`;

/** The page under test: every kind of subresource a renderer asks for, each under `/leak-probe/`. */
const PROBE_PAGE = page(
  'Leak probe',
  '<p>This page asks for an image, a script, a fetch and a WebSocket, all on its own origin.</p><img id="probe-img" src="/leak-probe/img.png" alt="probe" width="1" height="1"><script src="/leak-probe/script.js"></script>',
);
const PROBE_SCRIPT = `window.__probe = { fetch: null, ws: null };
fetch('/leak-probe/fetch').then((r) => r.text()).then((t) => { window.__probe.fetch = t; }, () => { window.__probe.fetch = 'error'; });
const ws = new WebSocket('ws://' + location.host + '/leak-probe/ws');
ws.onopen = () => { window.__probe.ws = 'open'; ws.close(); };
ws.onerror = () => { if (window.__probe.ws === null) window.__probe.ws = 'error'; };
`;
const ARTICLE_PAGE = page('An ordinary article', `<p>${'An ordinary article that is no search result page. '.repeat(40)}</p>`);
const WEBRTC_PAGE = page('WebRTC probe', '<p>A blank page the WebRTC probe runs in.</p>');

async function startOrigin(pack: { bytes: Buffer; signature: string }) {
  const log: OriginRecord[] = [];
  const sockets = new Set<Socket>();
  const record = (request: IncomingMessage, websocket: boolean) => {
    const marker = request.headers[FAKE_PROXY_MARKER.name];
    log.push({
      at: Date.now(),
      method: request.method ?? '',
      host: (request.headers.host ?? '').split(':')[0]!.toLowerCase(),
      path: request.url ?? '',
      marker: typeof marker === 'string' ? marker : undefined,
      remotePort: request.socket.remotePort ?? 0,
      upgradeInsecure: request.headers['upgrade-insecure-requests'] === '1',
      websocket,
    });
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    record(request, false);
    const url = new URL(request.url ?? '/', 'http://x');
    const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
    const send = (status: number, type: string, body: string | Buffer) => response.writeHead(status, { 'Content-Type': type }).end(body);
    if (host === SEARCH_HOST) {
      const answer = engineAnswer(url, pack);
      return answer ? send(answer.status, answer.type, answer.body) : send(404, 'text/plain', 'not here');
    }
    switch (url.pathname) {
      case '/robots.txt':
        return send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
      case '/page':
        return send(200, 'text/html; charset=utf-8', PROBE_PAGE);
      case '/article':
        return send(200, 'text/html; charset=utf-8', ARTICLE_PAGE);
      case '/webrtc':
        return send(200, 'text/html; charset=utf-8', WEBRTC_PAGE);
      case '/leak-probe/img.png':
        return send(200, 'image/png', PNG_1X1);
      case '/leak-probe/script.js':
        return send(200, 'text/javascript', PROBE_SCRIPT);
      case '/leak-probe/fetch':
        return send(200, 'text/plain', 'fetched');
      default:
        return send(404, 'text/plain', 'not here');
    }
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  // A minimal WebSocket handshake (RFC 6455), so the page's socket opens; nothing is exchanged.
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    record(request, true);
    socket.on('error', () => undefined);
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || request.url !== '/leak-probe/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A UDP listener standing in for a STUN server: it records every datagram and answers none. */
async function startStunFake(): Promise<{ port: number; packets: () => number; close(): Promise<void> }> {
  const socket: UdpSocket = createSocket('udp4');
  let count = 0;
  socket.on('message', () => (count += 1));
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, packets: () => count, close: () => new Promise<void>((resolve) => socket.close(() => resolve())) };
}

// ---- The classifier (location-profiles.feature.md, End to end) ------------------------------------

type TripwireVerdict = 'audit-robots' | 'audit-served-html' | 'leak';

/**
 * A tripwire request is a disclosed audit fetch only when it is `GET /robots.txt`, or a `GET` of exactly
 * one of the location tab's page URLs with the served-HTML `Accept`, and, for both, has no cookie, no
 * `upgrade-insecure-requests`, no `sec-fetch-*` and the user agent the audit uses. Anything else (a
 * navigation, a `/leak-probe/` path, a WebSocket, a cookie, a request head that is not HTTP) is a leak.
 */
function classifyTripwireRequest(request: TripwireRequest, allowed: { readonly pagePaths: readonly string[]; readonly userAgents: readonly string[] }): TripwireVerdict {
  const h = request.headers;
  const clean = request.method === 'GET' && h.cookie === undefined && h['upgrade-insecure-requests'] === undefined && h['sec-fetch-mode'] === undefined && h['sec-fetch-dest'] === undefined && h['sec-fetch-site'] === undefined && h.upgrade === undefined;
  if (!clean || h['user-agent'] === undefined || !allowed.userAgents.includes(h['user-agent'])) return 'leak';
  if (request.path.startsWith('/leak-probe/')) return 'leak';
  if (request.path === '/robots.txt') return 'audit-robots';
  if (allowed.pagePaths.includes(request.path) && h.accept === SERVED_ACCEPT) return 'audit-served-html';
  return 'leak';
}

// ---- NetLog --------------------------------------------------------------------------------------

interface NetLogFile {
  readonly constants: { readonly logEventTypes: Record<string, number>; readonly logSourceType: Record<string, number> };
  readonly events: readonly { readonly type: number; readonly source: { readonly id: number; readonly type: number }; readonly params?: Record<string, unknown> }[];
}

interface NetLogSummary {
  /** Every HTTP stream job whose URL names the host: its URL, privacy mode and the proxy decision. */
  readonly streams: { readonly id: number; readonly url: string; readonly privacyMode: string; readonly proxy: string | null }[];
  /** Host resolver events (any `HOST_RESOLVER_*`) whose parameters name the host. */
  readonly resolverEvents: { readonly type: string; readonly sourceType: string; readonly sourceId: number }[];
}

/**
 * What a NetLog says about `host`: each `HTTP_STREAM_JOB_CONTROLLER` (one per request needing a stream,
 * WebSockets included) whose URL names it, with its `PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST`
 * (`PROXY 127.0.0.1:<port>` or `DIRECT`), and any host resolver event naming it.
 */
async function summariseNetLog(file: string, host: string): Promise<NetLogSummary> {
  let text = (await readFile(file, 'utf8')).trimEnd();
  // A log stopped mid-write may lack its closing brackets.
  if (!text.endsWith('}')) text = `${text.replace(/,$/, '')}]}`;
  const log = JSON.parse(text) as NetLogFile;
  const typeName = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const sourceName = new Map(Object.entries(log.constants.logSourceType).map(([name, id]) => [id, name]));
  const streams = new Map<number, { url: string; privacyMode: string; proxy: string | null }>();
  const resolverEvents: NetLogSummary['resolverEvents'] = [];
  for (const event of log.events) {
    const type = typeName.get(event.type) ?? String(event.type);
    const source = sourceName.get(event.source.type) ?? String(event.source.type);
    const params = event.params ?? {};
    if (type === 'HTTP_STREAM_JOB_CONTROLLER' && typeof params['url'] === 'string') {
      const url = params['url'];
      if (new URL(url).hostname === host) streams.set(event.source.id, { url, privacyMode: String(params['privacy_mode'] ?? ''), proxy: null });
    }
    const stream = streams.get(event.source.id);
    if (stream && type === 'PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST' && typeof params['proxy_info'] === 'string') stream.proxy = params['proxy_info'];
    if (type.startsWith('HOST_RESOLVER') && JSON.stringify(params).toLowerCase().includes(host)) resolverEvents.push({ type, sourceType: source, sourceId: event.source.id });
  }
  return { streams: [...streams].map(([id, stream]) => ({ id, ...stream })), resolverEvents };
}

// ---- The suite ------------------------------------------------------------------------------------

let app: ElectronApplication;
let chrome: Page;
let origin: Awaited<ReturnType<typeof startOrigin>>;
let proxy: FakeProxy;
let tripwire: Tripwire;
let stun: Awaited<ReturnType<typeof startStunFake>>;
let profile = '';
let scratch = '';
const h = chromeHelpers(
  () => app,
  () => chrome,
);

const siteUrl = (pathname: string) => `http://${SITE_HOST}:${origin.port}${pathname}`;
const searchUrl = (query: string) => `http://${SEARCH_HOST}:${origin.port}/search?q=${encodeURIComponent(query).replace(/%20/g, '+')}`;
const sidebar = () => chrome.getByTestId('seo-sidebar');
const railItem = (panel: string) => chrome.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);

/** Opens the sidebar on `panel` (if it is not open on it already). */
async function openPanel(panel: 'serp' | 'changes'): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Every live WebContents of the location partition (the location tabs' pages). */
const locationContents = (): Promise<{ id: number; url: string }[]> =>
  app.evaluate(({ session, webContents }, partition) => {
    const own = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === own)
      .map((c) => ({ id: c.id, url: c.getURL() }));
  }, locationPartition(profile));

/** The location tab's WebContents id once it shows `url` and has stopped loading. */
async function locationTabAt(url: string): Promise<number> {
  await expect.poll(async () => (await locationContents()).filter((c) => c.url === url).length, { timeout: READ_WAIT }).toBe(1);
  const id = (await locationContents()).find((c) => c.url === url)!.id;
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id), { timeout: READ_WAIT }).toBe(false);
  return id;
}

/**
 * The ICE candidates a page gathers with a loopback STUN server (`a=candidate` lines and `onicecandidate`
 * strings), once gathering completes (at most 15 s), or at the first candidate with `firstOnly` (the fake
 * STUN server never answers, so a gathering that found an interface waits out its own timeout).
 */
const WEBRTC_PROBE = (stunPort: number, firstOnly = false) => `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] });
  const candidates = [];
  pc.onicecandidate = (event) => { if (event.candidate && event.candidate.candidate) candidates.push(event.candidate.candidate); };
  pc.createDataChannel('probe');
  await pc.setLocalDescription(await pc.createOffer());
  const complete = await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve(true);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(true); });
    if (${firstOnly}) pc.addEventListener('icecandidate', (event) => { if (event.candidate && event.candidate.candidate) resolve(false); });
    setTimeout(() => resolve(false), 15000);
  });
  const sdp = pc.localDescription ? pc.localDescription.sdp : '';
  pc.close();
  return { complete, candidates, sdpCandidates: sdp.split('\\r\\n').filter((line) => line.startsWith('a=candidate')) };
})()`;

type WebRtcResult = { complete: boolean; candidates: string[]; sdpCandidates: string[] };

/** The candidate types (`host`, `srflx`, `prflx`, `relay`) in a probe's answer. */
const candidateTypes = (result: WebRtcResult): string[] => [...result.candidates, ...result.sdpCandidates].map((line) => / typ (\w+)/.exec(line)?.[1] ?? '?');

/** Reads `sql` from the session database with a connection of its own (the app has it open). */
function query(sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(scratch, 'profile', DB_FILE_NAME), { readOnly: true, timeout: 5_000 });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test.beforeAll(async () => {
  const pack = signedTestPack();
  origin = await startOrigin(pack);
  proxy = await startFakeProxy({ hosts: { [SITE_HOST]: '127.0.0.1', [SEARCH_HOST]: '127.0.0.1' }, auth: AUTH });
  tripwire = await startTripwire();
  stun = await startStunFake();
  scratch = await mkdtemp(path.join(tmpdir(), 'frost-e2e-location-'));
  ({ app, page: chrome } = await launchApp(
    [
      // The site's name resolved directly lands on the tripwire (port included); the engine's on the origin.
      `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${tripwire.port},MAP ${SEARCH_HOST} 127.0.0.1`,
      `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST},${SEARCH_HOST}`,
      `--${SERP_E2E_PACK_URL_SWITCH}=http://${SEARCH_HOST}:${origin.port}${PACK_PATH}`,
      `--${SERP_E2E_PACK_KEY_SWITCH}=${pack.spki}`,
    ],
    // The proxy sign-in needs `os` protection: on Linux under Playwright (`--password-store=basic`) the
    // test-only stand-in keychain gives it (macOS's mock keychain and Windows' DPAPI already do).
    { userDataDir: path.join(scratch, 'profile'), mainPreload: [FAKE_KEYCHAIN] },
  ));
  await chrome.waitForLoadState('domcontentloaded');
  await h.chromeCaughtUp();
});

test.afterAll(async () => {
  await closeApp(app);
  await Promise.all([origin?.close(), proxy?.close(), tripwire?.close(), stun?.close()]);
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

test('location-profile-opens-a-badged-tab', async () => {
  await h.menu('settings');
  await expect(chrome.getByTestId('settings-view')).toBeVisible();
  await chrome.getByTestId('settings-nav-locations').click();
  await chrome.getByTestId('location-add').click();
  await chrome.getByTestId('location-label').fill(LABEL);
  await chrome.getByTestId('location-scheme').selectOption('http');
  await chrome.getByTestId('location-host').fill('127.0.0.1');
  await chrome.getByTestId('location-port').fill(String(proxy.port));
  await chrome.getByTestId('location-username').fill(AUTH.username);
  await chrome.getByTestId('location-password').fill(AUTH.password);
  await chrome.getByTestId('location-save').click();
  const row = chrome.getByTestId('location-row');
  await expect(row).toHaveCount(1);
  profile = (await row.getAttribute('data-profile'))!;
  expect(profile).toMatch(/^[0-9a-f-]{36}$/);
  // The sign-in stays in main: the page shows that one is saved, never its value.
  await expect(chrome.getByTestId('settings-view')).not.toContainText(AUTH.password);
  const tabsBefore = await h.strip().count();
  await row.getByTestId('location-new-tab').click();
  await expect(h.strip()).toHaveCount(tabsBefore + 1);
  if (await chrome.getByTestId('settings-view').isVisible()) await chrome.keyboard.press('Escape');
  await expect(chrome.getByTestId('settings-view')).toHaveCount(0);
  // The badge: on the location tab, with the profile's label and its title.
  const badge = h.activeTab().getByTestId('tab-location');
  await expect(badge).toHaveText(LOCATION_BADGE.text(LABEL));
  await expect(badge).toHaveAttribute('title', LOCATION_BADGE.title(LABEL));
});

test('location-leak-test-k-d', async () => {
  test.skip(profile === '', 'needs the profile from location-profile-opens-a-badged-tab');
  const netLogFile = path.join(scratch, 'location-netlog.json');
  await app.evaluate(async ({ session }, { partition, file }) => session.fromPartition(partition).netLog.startLogging(file, { captureMode: 'default' }), { partition: locationPartition(profile), file: netLogFile });
  const url = siteUrl('/page');
  await h.go(url);
  const id = await locationTabAt(url);
  // Every renderer request of the page went out: the image, the script, its fetch and its WebSocket.
  await expect.poll(() => h.run(id, '(() => { const img = document.getElementById("probe-img"); return [img && img.complete && img.naturalWidth, window.__probe && window.__probe.fetch, window.__probe && window.__probe.ws]; })()'), { timeout: READ_WAIT }).toEqual([1, 'fetched', 'open']);
  // The audit's disclosed fetches (robots.txt and the served HTML, from the browse session) reach the tripwire.
  await expect.poll(() => tripwire.requests().filter((r) => r.path === '/page').length, { timeout: AUDIT_WAIT }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => tripwire.requests().filter((r) => r.path === '/robots.txt').length, { timeout: AUDIT_WAIT }).toBeGreaterThanOrEqual(1);
  // WebRTC in the location tab (disable_non_proxied_udp): no host or server-reflexive candidate.
  const packetsBefore = stun.packets();
  const rtc = (await h.run(id, WEBRTC_PROBE(stun.port))) as WebRtcResult;
  expect(rtc.complete).toBe(true);
  await app.evaluate(async ({ session }, partition) => session.fromPartition(partition).netLog.stopLogging(), locationPartition(profile));

  // (1) The tripwire saw no leak: only the disclosed audit fetches, each classified.
  const browseUserAgent = await app.evaluate(({ session }, partition) => session.fromPartition(partition).getUserAgent(), BROWSE_PARTITION);
  const verdicts = tripwire.requests().map((request) => ({ request, verdict: classifyTripwireRequest(request, { pagePaths: ['/page'], userAgents: [browseUserAgent] }) }));
  test.info().annotations.push({ type: 'tripwire', description: JSON.stringify(verdicts.map((v) => [v.request.method, v.request.path, v.verdict])) });
  expect(verdicts.filter((v) => v.verdict === 'leak')).toEqual([]);
  expect(verdicts.map((v) => v.verdict)).toEqual(expect.arrayContaining(['audit-robots', 'audit-served-html']));

  // (2) Every request the real origin logged for the site carries the marker, or came through a tunnel the proxy opened.
  const tunnels = new Set(proxy.log.filter((r) => r.kind === 'connect' && r.upstreamPort !== undefined).map((r) => r.upstreamPort));
  const siteRequests = origin.log.filter((r) => r.host === SITE_HOST);
  test.info().annotations.push({ type: 'origin', description: JSON.stringify(siteRequests.map((r) => [r.method, r.path, r.marker ?? (tunnels.has(r.remotePort) ? 'tunnel' : 'DIRECT'), r.websocket ? 'ws' : ''])) });
  expect(siteRequests.map((r) => r.path)).toEqual(expect.arrayContaining(['/page', '/leak-probe/img.png', '/leak-probe/script.js', '/leak-probe/fetch', '/leak-probe/ws']));
  expect(siteRequests.filter((r) => r.marker !== FAKE_PROXY_MARKER.value && !tunnels.has(r.remotePort))).toEqual([]);

  // (3) The proxy asked for a sign-in, then the page came through signed in.
  const firstPage = proxy.log.findIndex((r) => r.target === `${SITE_HOST}:${origin.port}` && r.status === 200);
  expect(firstPage).toBeGreaterThan(0);
  expect(proxy.log.slice(0, firstPage).some((r) => r.status === 407)).toBe(true);
  test.info().annotations.push({ type: 'proxy', description: JSON.stringify(proxy.log.map((r) => [r.kind, r.target, r.status])) });

  // (4) WebRTC: no host or server-reflexive candidate, and nothing sent to the STUN server.
  test.info().annotations.push({ type: 'webrtc (location tab)', description: JSON.stringify({ ...rtc, stunPackets: stun.packets() - packetsBefore }) });
  expect(candidateTypes(rtc).filter((type) => type === 'host' || type === 'srflx' || type === 'prflx')).toEqual([]);
  expect(stun.packets() - packetsBefore).toBe(0);

  // (5) NetLog (global to the network service, so the browse session's audit fetches are in it too):
  // every stream the site's name opened went to the profile's proxy, except the disclosed audit fetches
  // (credentials omitted, so privacy mode on), which went direct; no host resolver event names the site.
  const net = await summariseNetLog(netLogFile, SITE_HOST);
  test.info().annotations.push({ type: 'netlog', description: JSON.stringify(net) });
  const viaProxy = `PROXY 127.0.0.1:${proxy.port}`;
  const direct = net.streams.filter((stream) => stream.proxy !== viaProxy);
  expect(direct.every((stream) => stream.proxy === 'DIRECT' && stream.privacyMode === 'enabled' && ['/robots.txt', '/page'].includes(new URL(stream.url).pathname))).toBe(true);
  for (const path of ['/page', '/leak-probe/img.png', '/leak-probe/script.js', '/leak-probe/fetch']) expect(net.streams.filter((stream) => stream.proxy === viaProxy).map((stream) => stream.url)).toContain(siteUrl(path));
  expect(net.streams).toContainEqual(expect.objectContaining({ url: `ws://${SITE_HOST}:${origin.port}/leak-probe/ws`, proxy: viaProxy }));
  expect(net.resolverEvents).toEqual([]);
});

test('location-webrtc-probe-is-not-vacuous', async () => {
  // The same probe in a home tab gathers candidates (or at least asks the STUN server), so an empty
  // answer in the location tab is the policy's doing, not the probe's. Machines differ (a runner with no
  // usable interface, or macOS Local Network privacy blocking the mDNS host candidate, gathers nothing):
  // what this one gathered is recorded either way, and a machine that gathered nothing skips the check
  // (annotated) rather than failing; where anything was gathered the assertion holds.
  await h.menu('new-tab');
  const url = `http://127.0.0.1:${origin.port}/webrtc`;
  await h.go(url);
  const id = await h.contentsIdAt(url);
  const packetsBefore = stun.packets();
  const rtc = (await h.run(id, WEBRTC_PROBE(stun.port, true))) as WebRtcResult;
  const types = candidateTypes(rtc);
  const stunPackets = stun.packets() - packetsBefore;
  test.info().annotations.push({ type: 'webrtc (home tab)', description: JSON.stringify({ ...rtc, types, stunPackets }) });
  if (types.length + stunPackets === 0) {
    test.info().annotations.push({ type: 'webrtc (home tab) gathered nothing', description: `${process.platform}: no candidate and no STUN packet in a home tab; the location tab's empty answer cannot be told apart from this machine's here` });
    test.skip(true, `this machine (${process.platform}) gathers no WebRTC candidate in a home tab (no usable interface, or macOS Local Network privacy), so the probe cannot be shown to be non-vacuous here`);
  }
  expect(types.length + stunPackets).toBeGreaterThan(0);
});

test('location-result-page-capture-records-the-location', async () => {
  test.skip(profile === '', 'needs the profile from location-profile-opens-a-badged-tab');
  // Back to the location tab (the profile's): its result page comes through the proxy too.
  await h.menu('close-tab');
  await expect(h.activeTab().getByTestId('tab-location')).toBeVisible();
  // The test pack (fetched by main, directly) so the synthetic engine is read as a result page.
  await openPanel('serp');
  const status = chrome.getByTestId('serp-pack-status');
  if ((await status.getAttribute('data-version')) !== String(PACK_VERSION)) {
    await chrome.getByTestId('serp-pack-update').click();
    await expect(status).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: READ_WAIT });
  }
  const url = searchUrl('green tea');
  await h.go(url);
  await locationTabAt(url);
  await expect(chrome.getByTestId('serp-panel')).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(chrome.getByTestId('serp-param-query')).toHaveText('green tea', { timeout: READ_WAIT });
  // The location tab's own request for the result page came through the proxy.
  expect(origin.log.filter((r) => r.host === SEARCH_HOST && r.path.startsWith('/search') && r.upgradeInsecure).map((r) => r.marker)).toEqual([FAKE_PROXY_MARKER.value]);
  await openPanel('changes');
  await expect(chrome.getByTestId('changes-capture')).toBeEnabled({ timeout: AUDIT_WAIT });
  await chrome.getByTestId('changes-capture').click();
  await expect(chrome.getByTestId('changes-capture-status')).toHaveAttribute('data-outcome', 'first', { timeout: READ_WAIT });
  // The stored version's search parameters carry the location (Decision 7): via the proxy, with its label.
  const versions = query('SELECT page_url, search_params FROM ci_versions').filter((row) => String(row['page_url']).includes(SEARCH_HOST));
  expect(versions).toHaveLength(1);
  expect(JSON.parse(String(versions[0]!['search_params']))).toMatchObject({ query: 'green tea', location: { via: 'proxy', label: LABEL } });
});

test('location-capture-refuses-an-ordinary-article', async () => {
  test.skip(profile === '', 'needs the profile from location-profile-opens-a-badged-tab');
  const versionsBefore = query('SELECT COUNT(*) AS n FROM ci_versions')[0]!['n'];
  const url = siteUrl('/article');
  await h.go(url);
  await locationTabAt(url);
  await openPanel('changes');
  await expect(chrome.getByTestId('changes-capture')).toBeEnabled({ timeout: AUDIT_WAIT });
  await chrome.getByTestId('changes-capture').click();
  await expect(chrome.getByTestId('changes-capture-status')).toHaveAttribute('data-outcome', 'refused', { timeout: READ_WAIT });
  await expect(chrome.getByTestId('changes-capture-status')).toHaveText(LOCATION_TAB_REFUSAL_MESSAGE);
  // Nothing stored.
  expect(query('SELECT COUNT(*) AS n FROM ci_versions')[0]!['n']).toBe(versionsBefore);
  // The article, too, reached the site only through the proxy (and the tripwire only by the audit).
  expect(origin.log.filter((r) => r.host === SITE_HOST && r.path === '/article').every((r) => r.marker === FAKE_PROXY_MARKER.value)).toBe(true);
  const browseUserAgent = await app.evaluate(({ session }, partition) => session.fromPartition(partition).getUserAgent(), BROWSE_PARTITION);
  expect(tripwire.requests().filter((request) => classifyTripwireRequest(request, { pagePaths: ['/page', '/article'], userAgents: [browseUserAgent] }) === 'leak')).toEqual([]);
});

test('location-tripwire-catches-a-direct-load', async () => {
  // The control: the same page loaded in a home tab goes direct, lands on the tripwire and is
  // classified a leak (a navigation), so the tripwire and its classifier can fail.
  const seen = tripwire.requests().length;
  await h.menu('new-tab');
  await expect(h.activeTab().getByTestId('tab-location')).toHaveCount(0);
  const url = siteUrl('/page');
  await h.go(url);
  await expect.poll(() => tripwire.requests().slice(seen).filter((request) => request.headers['upgrade-insecure-requests'] === '1').length, { timeout: READ_WAIT }).toBeGreaterThanOrEqual(1);
  const browseUserAgent = await app.evaluate(({ session }, partition) => session.fromPartition(partition).getUserAgent(), BROWSE_PARTITION);
  const navigations = tripwire
    .requests()
    .slice(seen)
    .filter((request) => request.headers['upgrade-insecure-requests'] === '1');
  expect(navigations.map((request) => classifyTripwireRequest(request, { pagePaths: ['/page'], userAgents: [browseUserAgent] }))).toEqual(navigations.map(() => 'leak'));
});
