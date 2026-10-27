import { OPEN_IN_URL_MAX_LENGTH, type OpenInTemplate } from '@app/specs/command-palette.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// "Open in" URLs (spec `command-palette.spec.ts`, `OPEN_IN_TEMPLATES` and `SITE_FILES`; acceptance
// `command-palette.feature.md`, Open in). Pure. A tool's URL is its template's fixed `https:` origin
// and path with the page URL as one URL-encoded query value: built with `URL` / `URLSearchParams`,
// never by pasting text into a URL string, so nothing in the page URL can reach the host or path.

/** Name suffixes that never resolve on the public internet. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/** An IPv4 address as a number, from a dotted quad (`URL` has normalised shorthand forms already). */
function ipv4(hostname: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!;
}

/** Loopback, private, link-local, shared (CGN) and "this network" IPv4 blocks. */
function privateIpv4(value: number): boolean {
  const a = Math.floor(value / 16_777_216);
  const b = Math.floor(value / 65_536) % 256;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Loopback, unspecified, unique-local, link-local and IPv4-mapped private IPv6 literals (`[…]`). */
function privateIpv6(literal: string): boolean {
  const address = literal.slice(1, -1).toLowerCase();
  if (address === '::1' || address === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) return privateIpv4(parseInt(mapped[1]!, 16) * 65_536 + parseInt(mapped[2]!, 16));
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const v4 = ipv4(dotted[1]!);
    return v4 === null || privateIpv4(v4);
  }
  return false;
}

/**
 * Whether `hostname` (`URL.hostname`) names a public host: not `localhost`, a loopback, private or
 * link-local address, a single-label name, or a name under a suffix that never resolves publicly.
 * Literal checks only (no DNS).
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost') return false;
  if (host.startsWith('[')) return !privateIpv6(host);
  const v4 = ipv4(host);
  if (v4 !== null) return !privateIpv4(v4);
  if (!host.includes('.')) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
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

/**
 * `template`'s URL for the page at `pageUrl`: its fixed origin and path, its fixed params, and the
 * page URL (`pageUrlToSend`) as the `urlParam` value. `null` when the page cannot be sent or the
 * result would not fit `browser.openBackgroundTab` (`OPEN_IN_URL_MAX_LENGTH`).
 */
export function openInUrl(template: OpenInTemplate, pageUrl: string): string | null {
  const page = pageUrlToSend(pageUrl);
  if (page === null) return null;
  const url = new URL(template.path, template.origin);
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

/** The host shown in an "Open in" row (where the page URL is sent). */
export function templateHost(template: OpenInTemplate): string {
  return new URL(template.origin).host;
}
