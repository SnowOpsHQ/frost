/**
 * "Open in" URLs and the public-host checks behind them (Phase 2.5 Task 4; acceptance
 * `command-palette.feature.md`, Open in). Plain functions with no Zod, shared by main (which builds
 * and opens the URL: `browser.openTool`) and the chrome (which offers the rows). The template table
 * is `OPEN_IN_TEMPLATES` in `command-palette.spec.ts`.
 *
 * A tool's URL is its template's fixed `https:` origin and path with the page URL as one URL-encoded
 * query value: built with `URL` / `URLSearchParams`, never by pasting text into a URL string, so
 * nothing in the page URL can reach the host or the path.
 */
import { OPEN_IN_URL_MAX_LENGTH, type OpenInTemplate } from './command-palette.spec';
import { parseWebUrl } from './web-url.spec';

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
 * literal, a single-label name, or a name under `NON_PUBLIC_NAME_SUFFIXES`. Literal checks only (no
 * DNS: main checks the address the page actually came from, `browser.openTool`).
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost') return false;
  if (host.startsWith('[')) return isPublicAddress(host);
  const v4 = parseIpv4(host);
  if (v4 !== null) return isPublicIpv4(v4);
  if (!host.includes('.')) return false;
  return !NON_PUBLIC_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

/**
 * The page URL an external tool is sent: the `http(s)` `url` with any user name, password and
 * fragment removed, and only for a public host; else `null`.
 */
export function pageUrlToSend(url: string): string | null {
  const parsed = parseWebUrl(url);
  if (!parsed || !isPublicHost(parsed.hostname)) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href;
}

/** Whether the URL sent would carry a query string (the palette says so). */
export function sendsQuery(url: string): boolean {
  const page = pageUrlToSend(url);
  return page !== null && new URL(page).search !== '';
}

/**
 * `template`'s URL for the page at `pageUrl`: its fixed origin and path, its fixed params, and the
 * page URL (`pageUrlToSend`) as the `urlParam` value. `null` when the page cannot be sent, the
 * result would not fit `browser.openBackgroundTab` (`OPEN_IN_URL_MAX_LENGTH`), or the template
 * itself is malformed (its built URL is not exactly its own `https:` origin and path).
 */
export function openInUrl(template: OpenInTemplate, pageUrl: string): string | null {
  const page = pageUrlToSend(pageUrl);
  if (page === null) return null;
  let url: URL;
  try {
    url = new URL(template.path, template.origin);
  } catch {
    return null;
  }
  const params = new URLSearchParams();
  params.set(template.urlParam, page);
  for (const [key, value] of Object.entries(template.params)) params.set(key, value);
  url.search = params.toString();
  url.hash = '';
  // Belt and braces: the fixed parts are exactly the template's.
  if (url.protocol !== 'https:' || url.origin !== template.origin || url.pathname !== template.path) return null;
  return url.href.length <= OPEN_IN_URL_MAX_LENGTH ? url.href : null;
}

/** `file.path` on the page's own `http(s)` origin (scheme, host and port), or `null`. */
export function siteFileUrl(file: { readonly path: string }, pageUrl: string): string | null {
  const page = parseWebUrl(pageUrl);
  if (!page) return null;
  const url = new URL(file.path, page.origin);
  return url.origin === page.origin ? url.href : null;
}

/** The host a template sends the page URL to. */
export function templateHost(template: OpenInTemplate): string {
  return new URL(template.origin).host;
}
