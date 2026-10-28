import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import type { ClientIpSource } from './app';
import { CLIENT_IP_HEADER } from './auth';
import { mappedIpv4, parseProxyEntry, rateLimitKey } from './ip';

// The client key for the backend's own rate limits (the desktop endpoints), by the same rules
// better-auth applies to its endpoints (`README.md`, `CLIENT_IP_HEADER` / `TRUSTED_PROXIES`): the TCP
// peer; or, behind a reverse proxy, its header. With trusted proxies the forwarded chain is walked
// from the right past them (the leftmost entries are the client's to choose); without, only a
// single-value header is trusted. The address becomes a key with `rateLimitKey` (IPv6 by /64,
// IPv4-mapped as IPv4). No trustworthy address → one shared bucket, `unknown`.

export const UNKNOWN_CLIENT = 'unknown';

/** `TRUSTED_PROXIES` as a block list (`env.ts` has already refused a malformed entry). */
function proxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const parsed = parseProxyEntry(entry);
    if (!parsed) continue;
    if (parsed.prefix === undefined) list.addAddress(parsed.address, parsed.type);
    else list.addSubnet(parsed.address, parsed.prefix, parsed.type);
  }
  return list;
}

/** Is `hop` one of the trusted proxies (an IPv4-mapped hop checked as its IPv4)? */
function isTrusted(list: BlockList, hop: string): boolean {
  const plain = mappedIpv4(hop) ?? hop;
  return list.check(plain, isIP(plain) === 6 ? 'ipv6' : 'ipv4');
}

const keyOf = (address: string | undefined): string => (address ? (rateLimitKey(address) ?? UNKNOWN_CLIENT) : UNKNOWN_CLIENT);

/** A resolver of `c`'s rate-limit key for `source`; the proxy list is parsed once. */
export function clientIpResolver(source: ClientIpSource): (c: Context) => string {
  if (source.kind === 'peer') return (c) => keyOf(source.address(c));
  const trusted = source.trustedProxies?.length ? proxyList(source.trustedProxies) : undefined;
  return (c) => {
    const chain = (c.req.header(source.header) ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (!trusted) return chain.length === 1 ? keyOf(chain[0]) : UNKNOWN_CLIENT;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const hop = chain[i] ?? '';
      if (isIP(hop) === 0) return UNKNOWN_CLIENT;
      if (!isTrusted(trusted, hop)) return keyOf(hop);
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
