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
const HOST_WITH_PORT = /^(\[[^\]\s]*\]|[^\s/:?#[\]]+):\d{1,5}(?:[/?#]|$)/;
/** A DNS label; the last label of a domain must also look like a TLD (letters or punycode). */
const DNS_LABEL = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z\d-]{1,59})$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

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

function isLoopbackHost(hostname: string): boolean {
  return includes(LOOPBACK_HTTP_HOSTS, hostname) || LOOPBACK_IPV4_PATTERN.test(hostname);
}

/** Whether a parsed hostname looks like a real web host (not a bare word such as `javascript`). */
function isWebHost(hostname: string): boolean {
  if (isLoopbackHost(hostname) || IPV4.test(hostname) || hostname.startsWith('[')) return true;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => DNS_LABEL.test(label)) && TLD.test(labels[labels.length - 1] ?? '');
}

function searchFor(query: string): ResolvedAddress {
  return { kind: 'search', url: SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent(query)) };
}

/** A browsable URL for `candidate`, or `null` (bad syntax, another scheme, or no web host). */
function webUrl(candidate: string): string | null {
  const parsed = tryParseUrl(candidate);
  if (!parsed || !includes(BROWSABLE_SCHEMES, parsed.protocol) || !isWebHost(parsed.hostname)) return null;
  return parsed.href;
}

/**
 * Resolves what the user typed into the address bar (spec `address-bar.feature.md`): an
 * `http(s)` URL to load, a `SEARCH_URL_TEMPLATE` search for anything else (including every
 * non-web scheme: `javascript:`, `file:`, `app:`, `data:`, `chrome:` …), or `null` for empty input
 * (a no-op). Scheme-less loopback hosts get `http:`, every other scheme-less host `https:`.
 */
export function resolveAddressInput(input: string): ResolvedAddress | null {
  const text = input.trim();
  if (text === '') return null;
  if (/\s/.test(text)) return searchFor(text);

  const scheme = SCHEME_PREFIX.exec(text)?.[1]?.toLowerCase();
  const typedScheme = scheme !== undefined && !HOST_WITH_PORT.test(text);
  if (typedScheme) {
    const url = includes(BROWSABLE_SCHEMES, `${scheme}:`) ? webUrl(text) : null;
    return url === null ? searchFor(text) : { kind: 'url', url };
  }

  const probe = tryParseUrl(`http://${text}`);
  if (!probe || !isWebHost(probe.hostname)) return searchFor(text);
  const url = webUrl(`${isLoopbackHost(probe.hostname) ? 'http' : 'https'}://${text}`);
  return url === null ? searchFor(text) : { kind: 'url', url };
}
