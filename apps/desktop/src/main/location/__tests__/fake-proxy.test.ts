// Spec: specs/location-profiles.feature.md (End to end: the fake proxy, the marker, the tripwire; Task 11's leak test, K-D)
// · plan docs/plans/phase-12-big-bets.md, Task 10b (fake-proxy.ts for Task 11)
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { FAKE_PROXY_MARKER, FAKE_PROXY_REALM, isLoopbackLiteral, startFakeProxy, startTripwire, type FakeProxy, type Tripwire } from '../../../../e2e/fake-proxy';

const NAME = 'site.frost-e2e.test';
const AUTH = { username: 'me', password: 'pw-1' };
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A loopback origin recording each request's headers. */
async function origin(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello ${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.unref();
  return { port: (server.address() as AddressInfo).port, seen };
}

async function proxy(auth = true): Promise<FakeProxy> {
  const started = await startFakeProxy({ hosts: { [NAME]: '127.0.0.1' }, ...(auth ? { auth: AUTH } : {}) });
  closers.push(() => started.close());
  return started;
}

/** A plain-HTTP request through the proxy (absolute form). */
function viaProxy(p: FakeProxy, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p.port, method: 'GET', path: url, headers: { host: new URL(url).host, connection: 'close', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('fake proxy (e2e helper)', () => {
  test('fake-proxy-maps-names-and-marks-requests', async () => {
    const site = await origin();
    const p = await proxy();
    // No sign-in: 407 with the Basic challenge, the origin never contacted.
    const challenged = await viaProxy(p, `http://${NAME}:${site.port}/a`);
    expect(challenged.status).toBe(407);
    expect(challenged.headers['proxy-authenticate']).toBe(`Basic realm="${FAKE_PROXY_REALM}"`);
    expect((await viaProxy(p, `http://${NAME}:${site.port}/a`, { 'proxy-authorization': basic('me', 'wrong') })).status).toBe(407);
    expect(site.seen).toEqual([]);
    // Signed in: forwarded to the mapped loopback origin, with the marker and without the sign-in.
    const ok = await viaProxy(p, `http://${NAME}:${site.port}/a?q=1`, { 'proxy-authorization': basic(AUTH.username, AUTH.password) });
    expect(ok).toMatchObject({ status: 200, body: 'hello /a?q=1' });
    expect(site.seen).toHaveLength(1);
    expect(site.seen[0]![FAKE_PROXY_MARKER.name]).toBe(FAKE_PROXY_MARKER.value);
    expect(site.seen[0]!.host).toBe(`${NAME}:${site.port}`);
    expect(site.seen[0]!['proxy-authorization']).toBeUndefined();
    // A name it does not map is refused: it never leaves loopback.
    expect((await viaProxy(p, `http://elsewhere.example:${site.port}/`, { 'proxy-authorization': basic(AUTH.username, AUTH.password) })).status).toBe(502);
    expect(site.seen).toHaveLength(1);
    expect(p.log.map((r) => [r.kind, r.status])).toEqual([
      ['http', 407],
      ['http', 407],
      ['http', 200],
      ['http', 502],
    ]);
  });

  test('fake-proxy-tunnels-connect', async () => {
    const site = await origin();
    const p = await proxy();
    const tunnel = (auth: string | null) =>
      new Promise<{ status: number; socket: import('node:net').Socket | null }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: `${NAME}:${site.port}`, headers: auth ? { 'proxy-authorization': auth } : {} });
        req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
        req.on('response', (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, socket: null });
        });
        req.on('error', reject);
        req.end();
      });
    const refused = await tunnel(null);
    expect(refused.status).toBe(407);
    refused.socket?.destroy();
    const open = await tunnel(basic(AUTH.username, AUTH.password));
    expect(open.status).toBe(200);
    const socket = open.socket!;
    const answer = await new Promise<string>((resolve) => {
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (text += chunk));
      socket.on('end', () => resolve(text));
      socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${NAME}:${site.port}\r\nConnection: close\r\n\r\n`);
    });
    socket.destroy();
    expect(answer).toContain('hello /tunnelled');
    // Inside a tunnel nothing is added (TLS in real use): the proxy's log is the evidence.
    expect(site.seen[0]![FAKE_PROXY_MARKER.name]).toBeUndefined();
    expect(p.log.map((r) => [r.kind, r.target, r.status])).toEqual([
      ['connect', `${NAME}:${site.port}`, 407],
      ['connect', `${NAME}:${site.port}`, 200],
    ]);
  });

  test('fake-proxy-tripwire-counts-direct-connections', async () => {
    const wire: Tripwire = await startTripwire();
    closers.push(() => wire.close());
    expect(wire.connections()).toBe(0);
    await new Promise<void>((resolve) => {
      const socket = connect(wire.port, '127.0.0.1');
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });
    await expect.poll(() => wire.connections()).toBe(1);
  });

  test('fake-proxy-is-loopback-only', async () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1']) expect(isLoopbackLiteral(address), address).toBe(true);
    for (const address of ['0.0.0.0', '10.0.0.1', 'localhost', '::', '192.168.1.1', 'example.com']) expect(isLoopbackLiteral(address), address).toBe(false);
    await expect(startFakeProxy({ hosts: { [NAME]: '127.0.0.1' }, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(startFakeProxy({ hosts: { [NAME]: '93.184.216.34' } })).rejects.toThrow(/loopback/);
    await expect(startFakeProxy({ hosts: { [NAME]: 'localhost' } })).rejects.toThrow(/loopback/);
    await expect(startTripwire('0.0.0.0')).rejects.toThrow(/loopback/);
    // The URL names the address it is bound to.
    const p = await proxy(false);
    expect(p.url).toBe(`http://127.0.0.1:${p.port}`);
  });
});
