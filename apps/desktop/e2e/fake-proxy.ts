// Test-only: a loopback stand-in for a user's own proxy (Phase 12 Task 10b / Task 11; acceptance
// `specs/location-profiles.feature.md`, End to end), and a tripwire for direct connections. Used by
// the unit test `src/main/location/__tests__/fake-proxy.test.ts` and, in Task 11, by
// `location.e2e.ts`'s leak test (K-D). It never reaches past loopback: every name it serves is mapped
// by the test to a loopback address, and any other name is refused (502), so CI makes no network call.
//
// - Plain HTTP (absolute-form requests): forwarded to the mapped address with the marker header
//   `x-frost-e2e-via: proxy` added (and `Proxy-Authorization` / `Proxy-Connection` removed), so the
//   origin can tell a proxied request from a direct one.
// - `CONNECT host:port` (HTTPS and WebSockets over TLS): tunnelled to the mapped address. Inside a
//   tunnel nothing can be added, so the proxy's own log is the evidence there.
// - Optional Basic auth: without the right `Proxy-Authorization`, 407 with
//   `Proxy-Authenticate: Basic realm="frost-e2e"` (Chromium then asks main's `login` listener).
// The proxy resolves names itself (as a real proxy does), so `--host-resolver-rules` in the app can
// point the same public-looking name at the tripwire: a connection the app makes directly lands there.
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';

/** The marker header the proxy adds to every plain-HTTP request it forwards. */
export const FAKE_PROXY_MARKER = { name: 'x-frost-e2e-via', value: 'proxy' } as const;
export const FAKE_PROXY_REALM = 'frost-e2e';

export interface FakeProxyRecord {
  readonly kind: 'http' | 'connect';
  /** `host:port` as asked (the public-looking name). */
  readonly target: string;
  /** What the proxy answered: 200 (forwarded / tunnelled), 407 (no or a wrong sign-in), 502 (a name it does not map). */
  readonly status: 200 | 407 | 502;
  /** Whether the request carried the right sign-in (always `true` without `auth`). */
  readonly authorized: boolean;
  /**
   * For a tunnel that opened (`connect`, 200): the local port of the proxy's own connection to the
   * origin, so the origin can tell a tunnelled request (which carries no marker) from a direct one.
   */
  readonly upstreamPort?: number;
}

export interface FakeProxyOptions {
  /** Each served name (lower case) and the loopback IP literal it stands for (anything else is refused); the requested port is kept. */
  readonly hosts: Readonly<Record<string, string>>;
  /** Require this Basic sign-in. */
  readonly auth?: { readonly username: string; readonly password: string };
  /** Listen here: a loopback IP literal (default `127.0.0.1`, a free port); anything else is refused. */
  readonly host?: string;
}

export interface FakeProxy {
  readonly port: number;
  /** `http://<bound loopback literal>:<port>` (a literal: the app never resolves the proxy's own name). */
  readonly url: string;
  /** Every request, in order. */
  readonly log: FakeProxyRecord[];
  close(): Promise<void>;
}

/** A loopback IP literal (`127.0.0.0/8` or `::1`): the only addresses the fakes listen on or forward to. */
export function isLoopbackLiteral(address: string): boolean {
  return /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(address) || address === '::1';
}

/** `http://<address>:<port>` for a bound loopback address (an IPv6 literal in brackets). */
function urlOf(bound: AddressInfo): string {
  return `http://${bound.family === 'IPv6' || bound.address.includes(':') ? `[${bound.address}]` : bound.address}:${bound.port}`;
}

function splitTarget(target: string): { name: string; port: number } | null {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { name: match[1]!.toLowerCase(), port } : null;
}

/** Closes `server` after destroying every socket it holds (Windows refuses a close with open sockets). */
function closer(server: { close(callback: () => void): unknown }, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
}

export async function startFakeProxy(options: FakeProxyOptions): Promise<FakeProxy> {
  // Loopback only, both ways: the fake never listens on, or forwards to, anything else (CI makes no network call).
  const listenOn = options.host ?? '127.0.0.1';
  if (!isLoopbackLiteral(listenOn)) throw new Error('fake proxy: listen on a loopback address only');
  for (const [name, address] of Object.entries(options.hosts)) {
    if (!isLoopbackLiteral(address)) throw new Error(`fake proxy: ${name} must map to a loopback address`);
  }
  const log: FakeProxyRecord[] = [];
  const sockets = new Set<Socket>();
  const expected = options.auth ? `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}` : null;
  const authorized = (header: string | string[] | undefined): boolean => expected === null || header === expected;
  const mapped = (name: string): string | null => (Object.hasOwn(options.hosts, name) ? options.hosts[name]! : null);

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = `${url.hostname}:${url.port || '80'}`;
    const ok = authorized(req.headers['proxy-authorization']);
    if (!ok) {
      log.push({ kind: 'http', target, status: 407, authorized: false });
      res.writeHead(407, { 'proxy-authenticate': `Basic realm="${FAKE_PROXY_REALM}"`, 'content-length': '0' }).end();
      return;
    }
    const address = url.protocol === 'http:' ? mapped(url.hostname.toLowerCase()) : null;
    if (address === null) {
      log.push({ kind: 'http', target, status: 502, authorized: true });
      res.writeHead(502, { 'content-length': '0' }).end();
      return;
    }
    log.push({ kind: 'http', target, status: 200, authorized: true });
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, [FAKE_PROXY_MARKER.name]: FAKE_PROXY_MARKER.value };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({ host: address, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = req.url ?? '';
    const parsed = splitTarget(target);
    if (!authorized(req.headers['proxy-authorization'])) {
      log.push({ kind: 'connect', target, status: 407, authorized: false });
      client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${FAKE_PROXY_REALM}"\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const address = parsed ? mapped(parsed.name) : null;
    if (!parsed || address === null) {
      log.push({ kind: 'connect', target, status: 502, authorized: true });
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const record: { -readonly [K in keyof FakeProxyRecord]: FakeProxyRecord[K] } = { kind: 'connect', target, status: 200, authorized: true };
    log.push(record);
    const upstream = connect(parsed.port, address, () => {
      record.upstreamPort = upstream.localPort;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    const end = (): void => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', end);
    client.on('error', end);
  });

  await new Promise<void>((resolve) => server.listen(0, listenOn, resolve));
  const bound = server.address() as AddressInfo;
  return { port: bound.port, url: urlOf(bound), log, close: closer(server, sockets) };
}

/** The request headers the tripwire keeps (`location-profiles.feature.md`, The tripwire), lower case. */
export const TRIPWIRE_HEADERS = ['host', 'user-agent', 'accept', 'upgrade-insecure-requests', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-site', 'cookie', 'upgrade'] as const;
export type TripwireHeader = (typeof TRIPWIRE_HEADERS)[number];

/** One request that reached the tripwire (a direct connection that sent an HTTP request head). */
export interface TripwireRequest {
  /** When its head was complete (`Date.now()`). */
  readonly at: number;
  /** The method, or `''` when the connection's first bytes were not an HTTP request (TLS, say). */
  readonly method: string;
  /** The request target as sent (origin form: path and query). */
  readonly path: string;
  /** The kept headers (`TRIPWIRE_HEADERS`) it carried, repeated values joined with `, `. */
  readonly headers: Readonly<Partial<Record<TripwireHeader, string>>>;
}

export interface Tripwire {
  readonly port: number;
  /** How many connections reached it (each one a direct connection that should have gone through the proxy). */
  connections(): number;
  /** Every request head that reached it, in order (Task 11's recorder: the leak test classifies them). */
  requests(): readonly TripwireRequest[];
  close(): Promise<void>;
}

/** How long the tripwire keeps a connection that sends nothing. */
const TRIPWIRE_IDLE_MS = 1_000;
/** The biggest request head the tripwire reads before it records what it has and hangs up. */
const MAX_HEAD_BYTES = 16 * 1024;

/** A request head (`METHOD target HTTP/1.x` and header lines), or `null` when the bytes are not one. */
function parseHead(head: string, at: number): TripwireRequest | null {
  const [requestLine = '', ...lines] = head.split('\r\n');
  const match = /^([A-Z]{1,16}) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) return null;
  const headers: Partial<Record<TripwireHeader, string>> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase() as TripwireHeader;
    if (!(TRIPWIRE_HEADERS as readonly string[]).includes(name)) continue;
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { at, method: match[1]!, path: match[2]!, headers };
}

/**
 * A listener that records every connection and every HTTP request head on it, and answers each
 * request `404` with no body (then hangs up): `--host-resolver-rules` maps the public-looking name
 * here, so only a direct connection (one that did not go through the proxy) can reach it. Bytes that
 * are not an HTTP request (TLS, say) are recorded as one request with an empty method.
 */
export async function startTripwire(host = '127.0.0.1'): Promise<Tripwire> {
  if (!isLoopbackLiteral(host)) throw new Error('tripwire: listen on a loopback address only');
  let count = 0;
  const recorded: TripwireRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    // A connection that sends nothing (a preconnect, a bare TCP probe) is counted, then dropped.
    socket.setTimeout(TRIPWIRE_IDLE_MS, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0 && buffered.length < MAX_HEAD_BYTES && /^[A-Z]{0,16}( |$)/.test(buffered.toString('latin1', 0, Math.min(buffered.length, 17)))) return;
      const at = Date.now();
      const parsed = end < 0 ? null : parseHead(buffered.toString('latin1', 0, end), at);
      recorded.push(parsed ?? { at, method: '', path: '', headers: {} });
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.removeAllListeners('data');
      socket.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return { port, connections: () => count, requests: () => recorded, close: closer(server, sockets) };
}
