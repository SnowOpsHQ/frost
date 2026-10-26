/**
 * Web URLs: the one definition of "an `http(s)` URL" every part of frost uses (the browse guard,
 * the controller, the address bar, the session database, permission origins, the chrome's
 * security badge). Plain values and functions with no imports, so the chrome renderer can use them
 * without bundling Zod (whose eval probe the app's strict Trusted Types CSP blocks).
 * `browser.spec.ts` re-exports `BROWSABLE_SCHEMES`.
 */

/** Schemes a tab may load or navigate to (parsed, lowercased `URL.protocol`). */
export const BROWSABLE_SCHEMES = ['http:', 'https:'] as const;
export type BrowsableScheme = (typeof BROWSABLE_SCHEMES)[number];

/** `url` parsed, if it is a string naming an `http(s)` URL (`BROWSABLE_SCHEMES`) with a host; else `null`. Never throws. */
export function parseWebUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || url === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return (BROWSABLE_SCHEMES as readonly string[]).includes(parsed.protocol) && parsed.host !== '' ? parsed : null;
}

/** Whether `url` is an `http(s)` URL, the only kind a tab loads as a page. */
export function isWebUrl(url: unknown): boolean {
  return parseWebUrl(url) !== null;
}

/** `url`'s serialized origin if it is an `http(s)` URL, else `null`. */
export function webOrigin(url: unknown): string | null {
  return parseWebUrl(url)?.origin ?? null;
}

/** How the chrome badges a URL: `https:` is `secure`, `http:` `insecure`, anything else `none`. */
export type UrlSecurity = 'secure' | 'insecure' | 'none';
export function urlSecurity(url: unknown): UrlSecurity {
  const protocol = parseWebUrl(url)?.protocol;
  return protocol === 'https:' ? 'secure' : protocol === 'http:' ? 'insecure' : 'none';
}
