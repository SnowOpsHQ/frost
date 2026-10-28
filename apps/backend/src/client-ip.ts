import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import type { ClientIpSource } from './app';
import { CLIENT_IP_HEADER } from './auth';

// The client IP for the backend's own rate limits (the desktop endpoints), by the same rules
// better-auth applies to its endpoints (`README.md`, `CLIENT_IP_HEADER` / `TRUSTED_PROXIES`): the TCP
// peer; or, behind a reverse proxy, its header. With trusted proxies the forwarded chain is walked
// from the right past them (the leftmost entries are the client's to choose); without, only a
// single-value header is trusted. No trustworthy address → one shared bucket, `unknown`.

export const UNKNOWN_CLIENT = 'unknown';

function proxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/', 2);
    const family = isIP(address);
    if (family === 0) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    try {
      if (prefix === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(prefix), type);
    } catch {
      // A malformed entry trusts nothing.
    }
  }
  return list;
}

const familyOf = (address: string): 'ipv4' | 'ipv6' => (isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** A resolver of `c`'s client IP for `source`; the proxy list is parsed once. */
export function clientIpResolver(source: ClientIpSource): (c: Context) => string {
  if (source.kind === 'peer') {
    return (c) => {
      const address = source.address(c);
      return address && isIP(address) !== 0 ? address : UNKNOWN_CLIENT;
    };
  }
  const trusted = source.trustedProxies?.length ? proxyList(source.trustedProxies) : undefined;
  return (c) => {
    const chain = (c.req.header(source.header) ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (!trusted) {
      const [only] = chain;
      return chain.length === 1 && only && isIP(only) !== 0 ? only : UNKNOWN_CLIENT;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const hop = chain[i] ?? '';
      if (isIP(hop) === 0) return UNKNOWN_CLIENT;
      if (!trusted.check(hop, familyOf(hop))) return hop;
    }
    return UNKNOWN_CLIENT;
  };
}

/**
 * For a request handed to better-auth: with the TCP peer as the source, `CLIENT_IP_HEADER` is the
 * peer's address, replacing whatever the client sent (it never chooses its own rate-limit key). With
 * a proxy header as the source, better-auth reads that header itself.
 */
export function stampClientIp(headers: Headers, c: Context, source: ClientIpSource): void {
  if (source.kind !== 'peer') return;
  headers.delete(CLIENT_IP_HEADER);
  const address = source.address(c);
  if (address) headers.set(CLIENT_IP_HEADER, address);
}
