import { SERP_PARAM_LIMITS, type SerpDevice } from '@app/specs/serp.spec';
import type { PageParam, RejectParam, SelectorEngine, SelectorPack, SelectorRedirect } from '@app/specs/serp-selector-pack.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';

// Result page detection (spec `serp.spec.ts`, "How a page is read", Detection;
// `serp-search-params.schema.ts`; acceptance `serp-overlay.feature.md`, Detection). Pure: a URL,
// the pack in use and the tab's device in, the engine and the page's search parameters out, or
// `null` when the URL is not a result page of any engine in the pack. Exact matches only: the
// scheme `http:` / `https:`, the host one of the engine's `hosts` (the URL parser lowercases it; a
// trailing dot is dropped, the port ignored), the pathname one of its `paths`, and a query
// parameter with a non-blank value, and no `params.reject` rule naming another vertical. No prefix,
// subdomain or heuristic match, so `google.com/maps`, `bing.com/images/search`,
// `google.com/search?tbm=isch` or `duckduckgo.com/?q=` are never result pages. The parameters'
// `url` is canonical: the engine host and path with only the known parameters, by the pack's names.

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

/** A parameter's name and the value recorded for it. */
type Named = { readonly name: string; readonly value: string };

/** The query: the first of `names` present with a non-blank value, collapsed, trimmed and capped. */
function queryOf(search: URLSearchParams, names: readonly string[]): Named | null {
  for (const name of names) {
    const value = search.get(name);
    if (value === null) continue;
    const query = cut(value.replace(SPACES, ' ').trim(), L.maxQueryChars).trim();
    if (query.length > 0) return { name, value: query };
  }
  return null;
}

/** A country or language: the first of `names` present with a well-formed value, lowercased; else `null`. */
function localeOf(search: URLSearchParams, names: readonly string[] | undefined): Named | null {
  for (const name of names ?? []) {
    const value = search.get(name)?.trim().toLowerCase();
    if (value !== undefined && LOCALE.test(value)) return { name, value };
  }
  return null;
}

/**
 * The page number, and the offset when the engine pages by offset: page 1 (and no offset) unless
 * `page`'s parameter holds a whole number. An offset counts from `offsetBase` in steps of `perPage`
 * ((value − base) / perPage + 1, rounded down; the offset clamped to `maxOffset`); a page parameter
 * is the number itself. The page is clamped to 1 … `maxPage`.
 */
function pageOf(search: URLSearchParams, page: PageParam | undefined): { page: number; offset: number | null; raw: Named | null } {
  if (!page) return { page: 1, offset: null, raw: null };
  const value = search.get(page.param)?.trim();
  if (value === undefined || !WHOLE_NUMBER.test(value)) return { page: 1, offset: null, raw: null };
  const n = Number(value);
  if (page.kind === 'offset') {
    const offset = Math.min(n, L.maxOffset);
    const number = Math.floor((offset - (page.offsetBase ?? 0)) / Math.max(1, page.perPage ?? 1)) + 1;
    return { page: Math.min(Math.max(number, 1), L.maxPage), offset, raw: { name: page.param, value: String(offset) } };
  }
  const number = Math.min(Math.max(n, 1), L.maxPage);
  return { page: number, offset: null, raw: { name: page.param, value: String(number) } };
}

/** Whether a reject rule refuses the URL: its parameter present with a value it names (or any), not one it excepts. */
function rejected(search: URLSearchParams, rules: readonly RejectParam[] | undefined): boolean {
  return (rules ?? []).some((rule) => {
    const raw = search.get(rule.param);
    if (raw === null) return false;
    const value = raw.trim().toLowerCase();
    if (rule.except?.includes(value)) return false;
    return rule.values === undefined || rule.values.includes(value);
  });
}

/** An engine's click redirects with their hosts resolved (absent: the engine's own), for the SERP worker's job (`SerpRedirectRulesSchema`). */
export type SerpRedirectRule = { readonly path: string; readonly param: string; readonly decode: SelectorRedirect['decode']; readonly hosts: readonly string[] };
export function redirectRules(engine: SelectorEngine): SerpRedirectRule[] {
  return (engine.redirects ?? []).map((rule) => ({ path: rule.path, param: rule.param, decode: rule.decode, hosts: [...(rule.hosts ?? engine.hosts)] }));
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
  if (query === null || rejected(search, engine.params.reject)) return null;
  const gl = localeOf(search, engine.params.gl);
  const hl = localeOf(search, engine.params.hl);
  const page = pageOf(search, engine.params.page);
  // The canonical URL: the engine host and path, the known parameters only.
  const canonical = new URLSearchParams();
  for (const named of [query, gl, hl, page.raw]) if (named !== null) canonical.append(named.name, named.value);
  const canonicalUrl = `${parsed.protocol}//${host}${parsed.pathname}?${canonical.toString()}`;
  if (canonicalUrl.length > L.maxUrlChars) return null;
  return {
    engine,
    params: { engine: engine.id, engineLabel: engine.label, query: query.value, gl: gl?.value ?? null, hl: hl?.value ?? null, device, page: page.page, offset: page.offset, url: canonicalUrl },
  };
}
