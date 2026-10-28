import { SERP_PARAM_LIMITS, type SerpDevice } from '@app/specs/serp.spec';
import type { PageParam, SelectorEngine, SelectorPack } from '@app/specs/serp-selector-pack.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';

// Result page detection (spec `serp.spec.ts`, "How a page is read", Detection;
// `serp-search-params.schema.ts`; acceptance `serp-overlay.feature.md`, Detection). Pure: a URL,
// the pack in use and the tab's device in, the engine and the page's search parameters out, or
// `null` when the URL is not a result page of any engine in the pack. Exact matches only: the
// scheme `http:` / `https:`, the host one of the engine's `hosts` (the URL parser lowercases it; a
// trailing dot is dropped, the port ignored), the pathname one of its `paths`, and a query
// parameter with a non-blank value. No prefix, subdomain or heuristic match, so `google.com/maps`,
// `bing.com/images/search` or `duckduckgo.com/?q=` are never result pages.

export interface SerpMatch {
  readonly engine: SelectorEngine;
  readonly params: SearchParams;
}

const L = SERP_PARAM_LIMITS;
/** Control characters and whitespace runs, collapsed to one space in a query. */
const SPACES = /[\s\u0000-\u001f\u007f]+/g;
const LOCALE = new RegExp(`^[a-z0-9_-]{1,${L.maxLocaleChars}}$`);
const WHOLE_NUMBER = /^\d{1,15}$/;

/** `text` cut to `max` UTF-16 code units, never leaving half a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head;
}

/** The query: the first of `names` present with a non-blank value, collapsed, trimmed and capped. */
function queryOf(search: URLSearchParams, names: readonly string[]): string | null {
  for (const name of names) {
    const value = search.get(name);
    if (value === null) continue;
    const query = cut(value.replace(SPACES, ' ').trim(), L.maxQueryChars).trim();
    if (query.length > 0) return query;
  }
  return null;
}

/** A country or language: the first of `names` present with a well-formed value, lowercased; else `null`. */
function localeOf(search: URLSearchParams, names: readonly string[] | undefined): string | null {
  for (const name of names ?? []) {
    const value = search.get(name)?.trim().toLowerCase();
    if (value !== undefined && LOCALE.test(value)) return value;
  }
  return null;
}

/**
 * The page number: 1 unless `page`'s parameter holds a whole number. An offset counts from
 * `offsetBase` in steps of `perPage` ((value − base) / perPage + 1, rounded down); a page parameter
 * is the number itself. Clamped to 1 … `maxPage`.
 */
function pageOf(search: URLSearchParams, page: PageParam | undefined): number {
  if (!page) return 1;
  const value = search.get(page.param)?.trim();
  if (value === undefined || !WHOLE_NUMBER.test(value)) return 1;
  const n = Number(value);
  const number = page.kind === 'offset' ? Math.floor((n - (page.offsetBase ?? 0)) / Math.max(1, page.perPage ?? 1)) + 1 : n;
  return Math.min(Math.max(number, 1), L.maxPage);
}

/**
 * Whether `url` is a result page of an engine in `pack`, and if so its engine and search parameters
 * (the device is the tab's, `SERP_DEVICE_OF_PRESET`). Never throws.
 */
export function matchSerp(url: string, pack: SelectorPack, device: SerpDevice): SerpMatch | null {
  if (typeof url !== 'string' || url.length > L.maxUrlChars) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.href.length > L.maxUrlChars) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // A host belongs to one engine at most (`SelectorPackSchema`).
  const engine = pack.engines.find((candidate) => candidate.hosts.includes(host));
  if (!engine || !engine.paths.includes(parsed.pathname)) return null;
  const search = parsed.searchParams;
  const query = queryOf(search, engine.params.query);
  if (query === null) return null;
  return {
    engine,
    params: {
      engine: engine.id,
      engineLabel: engine.label,
      query,
      gl: localeOf(search, engine.params.gl),
      hl: localeOf(search, engine.params.hl),
      device,
      page: pageOf(search, engine.params.page),
      url: parsed.href,
    },
  };
}
