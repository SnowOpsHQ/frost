import {
  BROWSABLE_SCHEMES,
  LOOPBACK_HTTP_HOSTS,
  LOOPBACK_IPV4_PATTERN,
  SEARCH_URL_TEMPLATE,
} from '@app/specs/browser.spec';

// Pure address-bar resolution for `specs/address-bar.feature.md`. No Electron import.

export interface ResolvedAddress {
  readonly kind: 'url' | 'search';
  /** Always an `http:`/`https:` URL (`BROWSABLE_SCHEMES`). */
  readonly url: string;
}

/** `scheme:` at the start of the input (RFC 3986 scheme syntax). */
const SCHEME_PREFIX = /^([a-z][a-z\d+.-]*):/i;
/** A typed host with a port and no scheme (`localhost:5173`, `example.com:8080/x`, `[::1]:3000`). */
const HOST_WITH_PORT = /^(\[[^\]\s]*\]|[^\s/:?#[\]@]+):\d{1,5}(?:[/?#]|$)/;
/** A DNS label; the last label of a domain must also look like a TLD (letters or punycode). */
const DNS_LABEL = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z\d-]{1,59})$/;
/** Strict dotted-quad IPv4: four decimal octets 0–255, no leading zeros. */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const DOTTED_QUAD = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
/** A typed scheme-less authority: `host` (or `[ipv6]`) and an optional `:port`. */
const AUTHORITY = /^(\[[\da-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i;

function includes(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  return includes(LOOPBACK_HTTP_HOSTS, host) || LOOPBACK_IPV4_PATTERN.test(host);
}

/**
 * Whether a host **as typed** (lowercased, one trailing dot removed) is a web host: loopback, a
 * strict dotted quad, a bracketed IPv6 literal, or a domain with a letter TLD. Bare words and
 * numbers (`javascript`, `42`, `3.14`) are not — WHATWG parsing would otherwise turn numbers into
 * shorthand IPv4 (`0.0.0.42`).
 */
function isTypedWebHost(host: string): boolean {
  if (isLoopbackHost(host) || DOTTED_QUAD.test(host) || host.startsWith('[')) return true;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => DNS_LABEL.test(label)) && TLD.test(labels[labels.length - 1] ?? '');
}

function isValidPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  const n = Number(port);
  return n >= 1 && n <= 65_535;
}

/** The `SEARCH_URL_TEMPLATE` search for `query` (only ever its `q` parameter). */
export function searchUrl(query: string): string {
  return SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent(query));
}

function searchFor(query: string): ResolvedAddress {
  return { kind: 'search', url: searchUrl(query) };
}

/** Input typed with an explicit `http://`/`https://`: any URL with a non-empty host and a valid port. */
function explicitWebUrl(text: string): string | null {
  const parsed = tryParseUrl(text);
  if (!parsed || !includes(BROWSABLE_SCHEMES, parsed.protocol) || parsed.hostname === '') return null;
  // WHATWG serializes any zero port (`:0`, `:00`) as `'0'`.
  return parsed.port === '0' ? null : parsed.href;
}

/** Scheme-less input: the host is judged as typed, then `http:` (loopback) or `https:` is added. */
function schemelessWebUrl(text: string): string | null {
  const authority = /^[^/?#]*/.exec(text)?.[0] ?? '';
  if (authority.includes('@')) return null;
  const match = AUTHORITY.exec(authority);
  if (!match) return null;
  const host = (match[1] ?? '').toLowerCase().replace(/\.$/, '');
  if (!isValidPort(match[2]) || !isTypedWebHost(host)) return null;
  const parsed = tryParseUrl(`${isLoopbackHost(host) ? 'http' : 'https'}://${text}`);
  return parsed && includes(BROWSABLE_SCHEMES, parsed.protocol) ? parsed.href : null;
}

/**
 * Resolves what the user typed into the address bar (spec `address-bar.feature.md`): an
 * `http(s)` URL to load, a `SEARCH_URL_TEMPLATE` search for anything else (including every
 * non-web scheme: `javascript:`, `file:`, `app:`, `data:`, `chrome:` …), or `null` for empty input
 * (a no-op). Scheme-less loopback hosts get `http:`, every other scheme-less web host `https:`.
 */
export function resolveAddressInput(input: string): ResolvedAddress | null {
  const text = input.trim();
  if (text === '') return null;
  if (/\s/.test(text)) return searchFor(text);

  const scheme = SCHEME_PREFIX.exec(text)?.[1]?.toLowerCase();
  const typedScheme = scheme !== undefined && !HOST_WITH_PORT.test(text);
  const url = typedScheme
    ? includes(BROWSABLE_SCHEMES, `${scheme}:`)
      ? explicitWebUrl(text)
      : null
    : schemelessWebUrl(text);
  return url === null ? searchFor(text) : { kind: 'url', url };
}

/**
 * The form of a tab URL the chrome may show (state, address bar, window title): userinfo
 * (`user:pass@`) removed, so `https://paypal.com@evil.com/` reads `https://evil.com/`. Anything
 * that is not a URL with userinfo is returned unchanged.
 */
export function displayUrl(url: string): string {
  const parsed = tryParseUrl(url);
  if (!parsed || (parsed.username === '' && parsed.password === '')) return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}
