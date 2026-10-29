// A local fake update feed for the update client's tests (specs/update-client.feature.md), reusable
// by the e2e suite: a Node `http` server on 127.0.0.1 (random port) that records every request it
// sees, envelopes signed with an Ed25519 key generated per run (over `UPDATE_SIGNATURE_CONTEXT`, as
// `pnpm sign:update-manifest` signs), and a Node transport for the client's getter. Never contacts
// another host: an `https:` URL is only reachable through `nodeTransport`'s `https` map, which sends
// it as plain HTTP to a local port (so tests can exercise the `https:`-only rules without TLS).
// The e2e suite starts it over TLS instead (`startFakeFeed({ tls })`, a per-run self-signed
// certificate), so Electron's own `net` reaches it as a real `https:` server.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { UPDATE_SIGNATURE_CONTEXT } from '@app/specs/update-manifest.spec';
import type { UpdateHop } from '../fetch';

/** A request the fake feed received. */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  /** Lowercase names, as Node parsed them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Names and values in the order they arrived. */
  readonly rawHeaders: readonly string[];
}

/** What the fake feed answers on a path. */
export type FakeRoute =
  | { readonly status?: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: Uint8Array | string }
  | { readonly redirect: string; readonly status?: number }
  /** Sends the headers, then stalls without a body byte (for idle timeouts). */
  | { readonly stall: true; readonly headers?: Readonly<Record<string, string>> }
  | ((request: http.IncomingMessage, response: http.ServerResponse) => void);

export interface FakeFeed {
  /** `http://127.0.0.1:<port>` (`https:` when started with `tls`). */
  readonly origin: string;
  readonly port: number;
  readonly requests: SeenRequest[];
  route(path: string, route: FakeRoute): void;
  close(): Promise<void>;
}

export async function startFakeFeed(options: { readonly tls?: { readonly cert: string; readonly key: string } } = {}): Promise<FakeFeed> {
  const routes = new Map<string, FakeRoute>();
  const requests: SeenRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const handler = (request: http.IncomingMessage, response: http.ServerResponse) => {
    const path = request.url ?? '/';
    requests.push({ method: request.method ?? '', path, headers: { ...request.headers }, rawHeaders: [...request.rawHeaders] });
    open.add(response);
    response.on('close', () => open.delete(response));
    const route = routes.get(path);
    if (route === undefined) {
      response.writeHead(404).end();
    } else if (typeof route === 'function') {
      route(request, response);
    } else if ('redirect' in route) {
      response.writeHead(route.status ?? 302, { Location: route.redirect }).end();
    } else if ('stall' in route) {
      response.writeHead(200, { ...route.headers });
      response.flushHeaders();
    } else {
      response.writeHead(route.status ?? 200, { ...route.headers }).end(route.body ?? '');
    }
  };
  const server = options.tls === undefined ? http.createServer(handler) : https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `${options.tls === undefined ? 'http' : 'https'}://127.0.0.1:${port}`,
    port,
    requests,
    route: (path, route) => void routes.set(path, route),
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of open) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A signing key generated for this run, and the trusted-keys map that trusts only it. */
export interface TestSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  /** SPKI DER, base64 (the form `UPDATE_PUBLIC_KEYS` holds). */
  readonly spki: string;
  readonly keys: Readonly<Record<string, string>>;
}

export function testSigningKey(keyId = 'test-key'): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { keyId, privateKey, spki, keys: { [keyId]: spki } };
}

/** The envelope bytes the feed serves for `manifest` (its JSON bytes signed over the context prefix). */
export function signEnvelope(manifest: unknown, key: Pick<TestSigningKey, 'keyId' | 'privateKey'>): Uint8Array {
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = sign(null, Buffer.concat([Buffer.from(UPDATE_SIGNATURE_CONTEXT, 'utf8'), payload]), key.privateKey);
  return Buffer.from(JSON.stringify({ format: 1, keyId: key.keyId, payload: payload.toString('base64'), signature: signature.toString('base64') }), 'utf8');
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** `count` deterministic pseudo-random bytes (an artifact's content). */
export function artifactBytes(count: number, seed = 1): Buffer {
  const bytes = Buffer.alloc(count);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < count; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The tests' transport, with the getter's contract (`UpdateHop`): one `GET`, never following a
 * redirect, sending only the `User-Agent` it is given (Node adds `Host` and, with no agent,
 * `Connection: close`). `http:` URLs go where they say (the getter only lets loopback ones
 * through); an `https:` URL whose host is in `https` is sent as plain HTTP to that local port with
 * its own `Host`; any other `https:` URL fails as unreachable.
 */
export function nodeTransport(options: { readonly https?: Readonly<Record<string, number>> } = {}): UpdateHop & { readonly urls: string[] } {
  const urls: string[] = [];
  const hop: UpdateHop = (url, signal, userAgent) =>
    new Promise((resolve, reject) => {
      urls.push(url);
      const target = new URL(url);
      let port: number;
      let hostname = target.hostname;
      if (target.protocol === 'http:') {
        port = Number(target.port || 80);
        hostname = hostname.replace(/^\[|\]$/g, '');
      } else {
        const mapped = options.https?.[target.hostname];
        if (mapped === undefined) {
          reject(new Error('unreachable'));
          return;
        }
        port = mapped;
        hostname = '127.0.0.1';
      }
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const request = http.request({ host: hostname, port, path: `${target.pathname}${target.search}`, method: 'GET', agent: false, headers: { 'User-Agent': userAgent, Host: target.host } });
      const onAbort = () => {
        request.destroy();
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      request.on('response', (response) => {
        response.on('error', () => undefined);
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          const location = response.headers.location;
          response.destroy();
          resolve({ kind: 'redirect', status, location: typeof location === 'string' && location !== '' ? location : null });
          return;
        }
        resolve({ kind: 'response', status, headers: response.headers as Record<string, string | string[]>, body: response, cancel: () => response.destroy() });
      });
      request.end();
    });
  return Object.assign(hop, { urls });
}

/** A resolver from a fixed table (a name not in it does not resolve). */
export function tableResolver(table: Readonly<Record<string, readonly string[]>>): ((host: string) => Promise<readonly string[] | null>) & { readonly asked: string[] } {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    const addresses = table[host];
    if (addresses === undefined) throw new Error('ENOTFOUND');
    return addresses;
  };
  return Object.assign(resolve, { asked });
}

/** A fresh manifest (released now, expiring in 30 days) for `version` with one artifact per given platform. */
export function manifestFor(version: string, now: number, artifacts: Record<string, { url: string; sha256: string; size: number }>, extra: Record<string, unknown> = {}) {
  return {
    format: 1,
    version,
    releasedAt: new Date(now - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    notes: `frost ${version}\n\n- Fixes.`,
    rolloutPercent: 100,
    artifacts,
    ...extra,
  };
}
