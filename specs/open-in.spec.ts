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

// The public-address checks moved to `private-address.spec.ts` (Phase 2.5 Task 2 review: one check,
// shared with main's bounded fetcher); re-exported here for the palette's callers.
export { isPublicAddress, isPublicHost, isPublicIpv4, isPublicIpv6, NON_PUBLIC_IPV4_BLOCKS, NON_PUBLIC_NAME_SUFFIXES, parseIpv4, parseIpv6 } from './private-address.spec';
import { isPublicHost } from './private-address.spec';

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
