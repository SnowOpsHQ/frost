/**
 * The URL side of rank tracking (Phase 10; plan Decisions 4 and 10; acceptance
 * `changes-capture.feature.md`, SERP reading): reading a result page's filters and its engine host, and
 * comparing a run tab's search with its target's. Zod-free, but it needs the WHATWG `URL`,
 * `URLSearchParams` and `TextEncoder` globals (main and the chrome renderer have them), so it is kept
 * out of `rankings.spec.ts`, which `@app/change-intel` type-checks as plain ECMAScript.
 */
import type { SearchEngineId } from './browser-polish.spec';
import { SERP_FILTER_PARAMS, sortedJson, type SearchParamsShape, type SerpFilters } from './rankings.spec';
import { MAX_SERP_FILTERS_JSON_BYTES } from './workspace-db.spec';

/** UTF-8 bytes of `text`. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The known filters of result page `pageUrl` for `engine` (pure; never throws): each name of
 * `SERP_FILTER_PARAMS[engine]` the URL has with a non-empty value (its first one), the value
 * lowercased, keys sorted. An unknown engine, or a URL that does not parse, has none (`{}`).
 * `null` when the set's JSON is larger than `MAX_SERP_FILTERS_JSON_BYTES`: no filter is ever dropped
 * to fit (that would file a filtered page under another series), so such a page has no filters to
 * record, and a capture of it stores no reading.
 */
export function serpFiltersOf(pageUrl: string, engine: string): SerpFilters | null {
  const names: readonly string[] = Object.prototype.hasOwnProperty.call(SERP_FILTER_PARAMS, engine) ? SERP_FILTER_PARAMS[engine as SearchEngineId] : [];
  if (names.length === 0) return {};
  let params: URLSearchParams;
  try {
    params = new URL(pageUrl).searchParams;
  } catch {
    return {};
  }
  const filters: Record<string, string> = {};
  for (const name of [...names].sort()) {
    const value = params.get(name)?.toLowerCase() ?? '';
    if (value !== '') filters[name] = value;
  }
  return utf8Bytes(sortedJson(filters)) > MAX_SERP_FILTERS_JSON_BYTES ? null : filters;
}

/**
 * The engine host of a result page's URL (`params.url`) as the search key takes it: lowercase, one
 * trailing dot removed, with its port only when the URL names a non-default one; `null` when the URL
 * does not parse.
 */
export function searchHostOf(url: string): string | null {
  try {
    const { hostname, port } = new URL(url);
    const name = hostname.toLowerCase().replace(/\.$/, '');
    return port === '' ? name : `${name}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Whether the tab's search is the run target's: same engine, engine host, query, `gl`, `hl` and page.
 * The device is not compared (a site's pin may set another; the capture records the one in effect).
 */
export function sameRunSearch(tabParams: SearchParamsShape, targetParams: SearchParamsShape): boolean {
  const host = searchHostOf(tabParams.url);
  return (
    host !== null &&
    host === searchHostOf(targetParams.url) &&
    tabParams.engine === targetParams.engine &&
    tabParams.query === targetParams.query &&
    tabParams.gl === targetParams.gl &&
    tabParams.hl === targetParams.hl &&
    tabParams.page === targetParams.page
  );
}
