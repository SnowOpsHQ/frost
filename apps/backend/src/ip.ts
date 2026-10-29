import { isIP } from 'node:net';

// Pure IP helpers (no better-auth import, so `env.ts` can use them): `TRUSTED_PROXIES` entries and
// rate-limit keys. Keys follow better-auth's own rules for its endpoints: IPv6 grouped by /64 (a
// client usually holds a whole /64), an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its IPv4.

export interface ProxyEntry {
  readonly address: string;
  /** Prefix length, when the entry is a CIDR range. */
  readonly prefix: number | undefined;
  readonly type: 'ipv4' | 'ipv6';
}

/** A `TRUSTED_PROXIES` entry: an IP, or `IP/<digits>` within the family's bits. Anything else is `null`. */
export function parseProxyEntry(entry: string): ProxyEntry | null {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return null;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (slash === -1) return { address, prefix: undefined, type };
  const prefixText = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 6 ? 128 : 32)) return null;
  return { address, prefix, type };
}

/** The eight 16-bit groups of an IPv6 address (zone dropped, a dotted IPv4 tail expanded), or `null`. */
export function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  let parts: string[];
  const gap = text.indexOf('::');
  if (gap === -1) {
    parts = text.split(':');
  } else {
    const head = text.slice(0, gap) === '' ? [] : text.slice(0, gap).split(':');
    const rest = text.slice(gap + 2) === '' ? [] : text.slice(gap + 2).split(':');
    parts = [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
  }
  if (parts.length !== 8) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

/** The IPv4 inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), else `null`. */
export function mappedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g || g.slice(0, 5).some((x) => x !== 0) || g[5] !== 0xffff) return null;
  const [hi = 0, lo = 0] = [g[6], g[7]];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** The rate-limit key of a client address: IPv4 as is, IPv4-mapped as IPv4, other IPv6 as its /64; `null` if not an IP. */
export function rateLimitKey(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;
  const mapped = mappedIpv4(address);
  if (mapped) return mapped;
  const g = ipv6Groups(address);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : null;
}
