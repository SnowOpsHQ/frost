/**
 * Private (non-public) addresses: the one check frost uses wherever an address must be public
 * (Phase 2.5 Task 2 review). Main's bounded fetcher (`fetcher.spec.ts`: robots.txt, the served HTML,
 * link, sitemap and hreflang checks) refuses a private host, literal or resolved, unless the page the
 * request is for is itself on one; the command palette's "Open in" sends only a page on a public host
 * (`open-in.spec.ts`). Plain functions with no imports, so the chrome renderer can use them too.
 *
 * Not public:
 * - IPv4 (`NON_PUBLIC_IPV4_BLOCKS`): 0/8, 10/8, 100.64/10 (shared CGN space, used by overlay VPNs),
 *   127/8, 169.254/16, 172.16/12, 192.0.0/24, the documentation nets 192.0.2/24, 198.51.100/24 and
 *   203.0.113/24, 192.168/16, 198.18/15, multicast 224/4 and reserved 240/4 (with 255.255.255.255);
 * - IPv6 (`isPublicIpv6`): `::` and `::1`, IPv4-compatible `::a.b.c.d` (deprecated, never public),
 *   IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` judged by the IPv4 address
 *   they embed, discard-only `100::/64`, documentation `2001:db8::/32` and `3fff::/20`, unique local
 *   `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10` and multicast `ff00::/8`;
 * - names (`isPublicHost`): `localhost`, a single label (resolved through local search domains), and
 *   names under `NON_PUBLIC_NAME_SUFFIXES`; trailing dots are ignored (`example.com..`).
 */

/**
 * Name suffixes that never resolve on the public internet, or are reserved for tests, docs and
 * local use (RFC 2606, RFC 6761, RFC 6762, RFC 7686, RFC 8375, and common LAN conventions).
 */
export const NON_PUBLIC_NAME_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.corp', '.lan', '.home.arpa', '.test', '.example', '.invalid', '.onion'] as const;

/**
 * IPv4 blocks that are not public unicast (`[address, prefix length]`): "this network", RFC 1918,
 * shared CGN space, loopback, link-local, IETF protocol assignments, the three documentation nets,
 * benchmarking, multicast and reserved (with the broadcast address).
 */
export const NON_PUBLIC_IPV4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const satisfies readonly (readonly [string, number])[];

/** A strict dotted-quad IPv4 address (four decimal octets, no leading zeros) as a 32-bit number, else `null`. */
export function parseIpv4(text: string): number | null {
  const octet = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const parts = new RegExp(`^${octet}\\.${octet}\\.${octet}\\.${octet}$`).exec(text);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  return ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!;
}

const IPV4_BLOCKS = NON_PUBLIC_IPV4_BLOCKS.map(([base, prefix]) => ({ base: parseIpv4(base)!, size: 2 ** (32 - prefix) }));

/** Whether the IPv4 address (a 32-bit number) is public unicast. */
export function isPublicIpv4(value: number): boolean {
  return !IPV4_BLOCKS.some(({ base, size }) => value >= base && value < base + size);
}

/**
 * An IPv6 address (without brackets or zone) as its eight 16-bit groups, else `null`. Takes `::`
 * compression and a trailing dotted IPv4 part.
 */
export function parseIpv6(text: string): number[] | null {
  let rest = text.toLowerCase();
  const zone = rest.indexOf('%');
  if (zone >= 0) rest = rest.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(rest)) return null;
  let tail: number[] = [];
  const lastColon = rest.lastIndexOf(':');
  if (rest.includes('.')) {
    const v4 = parseIpv4(rest.slice(lastColon + 1));
    if (v4 === null || lastColon < 0) return null;
    tail = [Math.floor(v4 / 65_536), v4 % 65_536];
    rest = rest.slice(0, lastColon + 1);
    if (rest.endsWith(':') && !rest.endsWith('::')) rest = rest.slice(0, -1);
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const after = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || after === null) return null;
  const known = head.length + after.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...head, ...tail] : null;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...after, ...tail];
}

/**
 * Whether the IPv6 address (eight groups) is public unicast. Not public: unspecified and loopback,
 * IPv4-compatible (`::a.b.c.d`, deprecated), IPv4-mapped and NAT64 (`64:ff9b::/96`) addresses of a
 * non-public IPv4 address, discard-only (`100::/64`), documentation (`2001:db8::/32`), unique local
 * (`fc00::/7`), link-local (`fe80::/10`), site-local (`fec0::/10`) and multicast (`ff00::/8`).
 */
export function isPublicIpv6(g: readonly number[]): boolean {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = () => isPublicIpv4(g[6]! * 65_536 + g[7]!);
  if (zeros(0, 6)) return false;
  if (zeros(0, 5) && g[5] === 0xffff) return embedded();
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embedded();
  if (g[0] === 0x100 && zeros(1, 4)) return false;
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false;
  // Documentation (RFC 9637).
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return false;
  // 6to4: the IPv4 address in its second and third groups.
  if (g[0] === 0x2002) return isPublicIpv4(g[1]! * 65_536 + g[2]!);
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return true;
}

/**
 * Whether `address` (an IP as Chromium reports it: `1.2.3.4`, `::1`, `[::1]`) is a public unicast
 * address. Anything unparsable is not.
 */
export function isPublicAddress(address: string): boolean {
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = parseIpv4(text);
  if (v4 !== null) return isPublicIpv4(v4);
  const v6 = parseIpv6(text);
  return v6 !== null && isPublicIpv6(v6);
}

/**
 * Whether `hostname` (`URL.hostname`) names a public host: not `localhost`, a non-public IP
 * literal, a single-label name, or a name under `NON_PUBLIC_NAME_SUFFIXES`. Literal checks only:
 * main's fetcher resolves names too (`fetcher.spec.ts`), and "Open in" checks the address the page
 * actually came from (`browser.openTool`).
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === '' || host === 'localhost') return false;
  if (host.startsWith('[')) return isPublicAddress(host);
  const v4 = parseIpv4(host);
  if (v4 !== null) return isPublicIpv4(v4);
  if (!host.includes('.')) return false;
  return !NON_PUBLIC_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

/** Whether `hostname` (`URL.hostname`) is a private host: not `isPublicHost`. */
export function isPrivateHost(hostname: string): boolean {
  return !isPublicHost(hostname);
}

/** Whether `address` (a resolved IP) is private: not `isPublicAddress` (anything unparsable is private). */
export function isPrivateAddress(address: string): boolean {
  return !isPublicAddress(address);
}

/** Whether `hostname` is an IP literal (`1.2.3.4`, `[::1]`): nothing to resolve. */
export function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, '');
  return parseIpv4(host) !== null || (host.startsWith('[') && host.endsWith(']'));
}
