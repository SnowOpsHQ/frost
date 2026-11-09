// The rank read model (Phase 10 Task 3; spec `specs/rankings.spec.ts`; acceptance
// `specs/rankings.feature.md`): positions, change, best, trend points and CSV rows from stored SERP
// readings, the same way for any source. Pure and total: plain ECMAScript over the Zod-free shapes,
// no I/O, no `URL`, no hash (the current search key of an older-version reading is injected,
// `SearchKeyOf`), and garbage in any input is skipped, never thrown on.
import {
  MAX_PROJECT_COMPETITORS,
  RANK_CSV_COLUMNS,
  RANK_HISTORY_CSV_COLUMNS,
  RANK_LIMITS,
  RANK_OUTCOMES,
  SEARCH_KEY_VERSION,
  SERP_FEATURE_TYPES,
  rangeStart,
  type RankCsvKind,
  type RankPoint,
  type RankRange,
  type RankRow,
  type RankTable,
  type SavedSearchRef,
  type SearchKeyOf,
  type SearchParamsShape,
  type SerpFeatureType,
  type SerpFilters,
  type SerpObservation,
  type SiteMatch,
} from '@app/specs/rankings.spec';

/** Whose positions, which competitors, and the key rule for older readings. */
interface RankModelBase {
  readonly site: SiteMatch | null;
  /** Each matched as the site is; keyed by `host`; the first `MAX_PROJECT_COMPETITORS`, a repeated host once. */
  readonly competitors?: readonly SiteMatch[];
  /** The current-version key of a reading of another key version (Decision 4). */
  readonly keyOf?: SearchKeyOf;
}

/**
 * The range: none (every point), or a `RankRange` with the time it ends at (`now`, Unix ms), which is
 * then required, so a caller cannot ask for a range and silently get every point.
 */
export type RankRangeOptions = { readonly range?: undefined; readonly now?: number } | { readonly range: RankRange; readonly now: number };

/** What every read of the model takes. */
export type RankModelOptions = RankModelBase & RankRangeOptions;

export type RankTableOptions = RankModelOptions & {
  /** The project's saved searches, in its order; listed first. */
  readonly saved?: readonly SavedSearchRef[];
  /** Only saved searches carrying this tag. */
  readonly tag?: string | null;
};

/** A cell of a CSV row (`rankCsvRows`): Task 5 formats it. */
export type RankCsvCell = string | number;

/** The SERP feature types, so the model never lists anything else in `alsoIn`. */
const FEATURE_TYPES: ReadonlySet<string> = new Set<string>(SERP_FEATURE_TYPES);

// ---- Guards (every input may be garbage) ---------------------------------------------------------

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Whether `value` is enough of an observation to be read: string id and key, a finite time, a parameters object. */
function isObservation(value: unknown): value is SerpObservation {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.searchKey) && typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) && isRecord(value.params);
}

/** The usable site matches of `value` (a `SiteMatch` with a non-empty owner and host). */
export function siteOf(value: unknown): SiteMatch | null {
  if (!isRecord(value) || !isNonEmptyString(value.owner) || !isNonEmptyString(value.host)) return null;
  return { owner: value.owner, host: value.host, subdomains: value.subdomains !== false };
}

/** The first `MAX_PROJECT_COMPETITORS` usable competitors, a repeated host once. */
export function competitorsOf(value: unknown): SiteMatch[] {
  if (!Array.isArray(value)) return [];
  const out: SiteMatch[] = [];
  for (const entry of value) {
    const match = siteOf(entry);
    if (match === null || out.some((seen) => seen.host === match.host)) continue;
    out.push(match);
    if (out.length === MAX_PROJECT_COMPETITORS) break;
  }
  return out;
}

const optionsOf = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});

// ---- Whose result it is (Decision 7) -------------------------------------------------------------

/** A host compared lowercase, one trailing dot removed. */
const normalHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');
/** One leading `www.` removed. */
const withoutWww = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host);

/**
 * The host of `url` (plain string parsing; the model has no `URL`): after `scheme://`, up to the first
 * `/`, `?` or `#`, without a `user@` part (everything up to the **last** `@`) or `:port`; lowercase,
 * one trailing dot removed. `null` without one, or when that part holds a `\` (never in a URL `URL`
 * wrote; parsers disagree on it). Exact for the stored URLs, which Phase 3 wrote through `URL`.
 */
export function hostOfUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme === null) return null;
  const rest = url.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  let authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.includes('\\')) return null;
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d*$/, '');
  const name = normalHost(host);
  return name.length > 0 ? name : null;
}

/**
 * Whether result `result` is `site`'s: its owner domain (subdomains on), or its URL's exact host give or
 * take one `www.` (off). Either way the result must have a domain: Phase 3 gives none to a link it
 * could not use (a redirect it could not unwrap), and such a result is never the site's.
 */
export function matchesSite(result: Readonly<Record<string, unknown>>, site: SiteMatch): boolean {
  if (!isNonEmptyString(result.domain)) return false;
  if (site.subdomains) return normalHost(result.domain) === normalHost(site.owner);
  const host = hostOfUrl(result.url);
  return host !== null && withoutWww(host) === withoutWww(normalHost(site.host));
}

// ---- One reading (Decision 6) --------------------------------------------------------------------

/** The results of a `ready` reading (objects only), or `null` when it is not one. */
export function readyResults(snapshot: unknown): Readonly<Record<string, unknown>>[] | null {
  if (!isRecord(snapshot) || snapshot.status !== 'ready' || !Array.isArray(snapshot.results)) return null;
  return snapshot.results.filter(isRecord);
}

/** An organic result with a position (page-local). */
export const isOrganic = (result: Readonly<Record<string, unknown>>): boolean => result.type === 'organic' && isPositiveInt(result.position);
/** A SERP feature result (never a position). */
export const isFeature = (result: Readonly<Record<string, unknown>>): result is Readonly<Record<string, unknown>> & { type: SerpFeatureType } => typeof result.type === 'string' && FEATURE_TYPES.has(result.type);

/** The reading's result page: its snapshot's `params.page`, else the observation's, else 1. */
function pageOf(observation: Readonly<Record<string, unknown>>): number {
  const snapshot = observation.snapshot;
  const fromSnapshot = isRecord(snapshot) && isRecord(snapshot.params) ? snapshot.params.page : undefined;
  if (isPositiveInt(fromSnapshot)) return fromSnapshot;
  const fromObservation = isRecord(observation.params) ? observation.params.page : undefined;
  return isPositiveInt(fromObservation) ? fromObservation : 1;
}

/** `site`'s point on one reading (Decision 6); total over any input. */
export function rankOf(observation: SerpObservation, site: SiteMatch | null): RankPoint {
  const record = optionsOf(observation);
  const base = {
    readingId: typeof record.id === 'string' ? record.id : '',
    at: typeof record.observedAt === 'number' ? record.observedAt : 0,
    page: pageOf(record),
  };
  const results = readyResults(record.snapshot);
  const organic = results === null ? [] : results.filter(isOrganic);
  const match = siteOf(site);
  if (match === null) return { ...base, outcome: 'no-site', position: null, url: null, organicRead: organic.length, alsoIn: [] };
  if (results === null) return { ...base, outcome: 'unreadable', position: null, url: null, organicRead: 0, alsoIn: [] };
  const alsoIn: SerpFeatureType[] = [];
  for (const result of results) if (isFeature(result) && !alsoIn.includes(result.type) && matchesSite(result, match)) alsoIn.push(result.type);
  let best: Readonly<Record<string, unknown>> | null = null;
  for (const result of organic) if (matchesSite(result, match) && (best === null || (result.position as number) < (best.position as number))) best = result;
  if (best !== null) {
    return { ...base, outcome: 'ranked', position: best.position as number, url: typeof best.url === 'string' ? best.url : null, organicRead: organic.length, alsoIn };
  }
  const snapshot = record.snapshot as Readonly<Record<string, unknown>>;
  const complete = isRecord(snapshot.ownership) && snapshot.ownership.complete === true;
  return { ...base, outcome: complete ? 'not-found' : 'unknown', position: null, url: null, organicRead: organic.length, alsoIn };
}

// ---- Series (Decision 4: the key and its version) ------------------------------------------------

/** The key a reading is filed under: its stored key at the current version (or none given), else the injected current key. */
function seriesKeyOf(observation: SerpObservation, keyOf: unknown): string {
  const version = observation.searchKeyVersion;
  if (version === undefined || version === SEARCH_KEY_VERSION || typeof keyOf !== 'function') return observation.searchKey;
  try {
    const key: unknown = (keyOf as SearchKeyOf)(observation.params, isRecord(observation.filters) ? (observation.filters as SerpFilters) : {});
    return isNonEmptyString(key) ? key : observation.searchKey;
  } catch {
    return observation.searchKey;
  }
}

const byTime = (a: SerpObservation, b: SerpObservation): number => a.observedAt - b.observedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The valid observations grouped by series key (each group oldest first), duplicate ids skipped (the first kept). */
function groups(observations: unknown, keyOf: unknown): Map<string, SerpObservation[]> {
  const out = new Map<string, SerpObservation[]>();
  if (!Array.isArray(observations)) return out;
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!isObservation(observation) || seen.has(observation.id)) continue;
    seen.add(observation.id);
    const key = seriesKeyOf(observation, keyOf);
    const group = out.get(key);
    if (group === undefined) out.set(key, [observation]);
    else group.push(observation);
  }
  for (const group of out.values()) group.sort(byTime);
  return out;
}

/** The range's start for `options` (every point when the range or `now` is missing or not valid). */
function startOf(options: Readonly<Record<string, unknown>>): number {
  return typeof options.now === 'number' && typeof options.range === 'string' ? rangeStart(options.range as RankRange, options.now) : 0;
}

/**
 * One series within the range: its points (oldest first, at most the newest `maxPointsPerSeries`) and
 * its best `ranked` position over **every** reading in the range (taken before the cut).
 */
function seriesOf(group: readonly SerpObservation[], site: SiteMatch | null, start: number): { points: RankPoint[]; best: number | null } {
  const all = group.filter((observation) => observation.observedAt >= start).map((observation) => rankOf(observation, site));
  let best: number | null = null;
  for (const point of all) if (point.outcome === 'ranked' && point.position !== null && (best === null || point.position < best)) best = point.position;
  return { points: all.slice(-RANK_LIMITS.maxPointsPerSeries), best };
}

/** The points of search `searchKey` for the site (oldest first, within the range, bounded). */
export function rankSeries(observations: readonly SerpObservation[], searchKey: string, options: RankModelOptions): RankPoint[] {
  const opts = optionsOf(options);
  const group = groups(observations, opts.keyOf).get(searchKey);
  return group === undefined ? [] : seriesOf(group, siteOf(opts.site), startOf(opts)).points;
}

// ---- Change and the table (Decision 5) ------------------------------------------------------------

/** How a search moved between its `previous` and `latest` points: only between two `ranked` ones (positions gained); `lost`, `new`, else none. */
export function changeOf(previous: RankPoint | null, latest: RankPoint | null): RankRow['change'] {
  if (previous === null || latest === null) return null;
  if (previous.outcome === 'ranked' && latest.outcome === 'ranked') return (previous.position as number) - (latest.position as number);
  if (previous.outcome === 'ranked' && latest.outcome === 'not-found') return 'lost';
  if (previous.outcome === 'not-found' && latest.outcome === 'ranked') return 'new';
  return null;
}

function rowOf(key: string, group: readonly SerpObservation[], saved: SavedSearchRef | null, site: SiteMatch | null, competitors: readonly SiteMatch[], start: number): RankRow {
  const newest = group.at(-1) ?? null;
  const latest = newest === null ? null : rankOf(newest, site);
  const before = group.at(-2);
  const previous = before === undefined ? null : rankOf(before, site);
  const { points, best } = seriesOf(group, site, start);
  return {
    searchKey: key,
    params: newest?.params ?? (saved as SavedSearchRef).params,
    filters: newest !== null ? (isRecord(newest.filters) ? newest.filters : {}) : isRecord(saved?.filters) ? saved.filters : {},
    saved: saved === null ? null : { id: saved.id, tags: saved.tags },
    latest,
    previous,
    change: changeOf(previous, latest),
    best,
    points,
    competitors: Object.fromEntries(competitors.map((competitor) => [competitor.host, newest === null ? null : rankOf(newest, competitor)])),
  };
}

/** A usable saved search, its tags strings only. */
function savedOf(value: unknown): SavedSearchRef | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.searchKey) || !isRecord(value.params)) return null;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  return { id: value.id, searchKey: value.searchKey, params: value.params as SearchParamsShape, filters: isRecord(value.filters) ? (value.filters as SerpFilters) : {}, tags };
}

/**
 * The rank table (Decision 5): saved searches first (their order; a repeated key once), then searches
 * seen only in readings (newest latest reading first, then key); `tag` keeps tagged saved searches
 * only; at most `RANK_LIMITS.maxRows` rows.
 */
export function rankTable(observations: readonly SerpObservation[], options: RankTableOptions): RankTable {
  const opts = optionsOf(options);
  const site = siteOf(opts.site);
  const competitors = competitorsOf(opts.competitors);
  const start = startOf(opts);
  const series = groups(observations, opts.keyOf);
  const tag = typeof opts.tag === 'string' ? opts.tag : null;
  const rows: RankRow[] = [];
  let total = 0;
  const listed = new Set<string>();
  for (const entry of Array.isArray(opts.saved) ? opts.saved : []) {
    const saved = savedOf(entry);
    if (saved === null || listed.has(saved.searchKey)) continue;
    listed.add(saved.searchKey);
    if (tag !== null && !saved.tags.includes(tag)) continue;
    total += 1;
    if (rows.length < RANK_LIMITS.maxRows) rows.push(rowOf(saved.searchKey, series.get(saved.searchKey) ?? [], saved, site, competitors, start));
  }
  if (tag === null) {
    const observed = [...series].filter(([key]) => !listed.has(key));
    observed.sort(([keyA, a], [keyB, b]) => b.at(-1)!.observedAt - a.at(-1)!.observedAt || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
    total += observed.length;
    for (const [key, group] of observed.slice(0, Math.max(0, RANK_LIMITS.maxRows - rows.length))) rows.push(rowOf(key, group, null, site, competitors, start));
  }
  return { rows, truncated: total > rows.length };
}

// ---- The table read in parts (Phase 10 Task 5) ------------------------------------------------------

/**
 * One search's parts as main reads them, per key and bounded (`rankings.feature.md`, Router): its
 * newest readings whatever the range (`recent`: at least the two newest, any order) and the site's
 * points over the range (`points`: `rankOf` of each reading in range, any order), so a long history is
 * never loaded whole and each reading's snapshot is dropped once its point is taken.
 */
export interface RankRowParts {
  readonly searchKey: string;
  readonly saved: SavedSearchRef | null;
  readonly recent: readonly SerpObservation[];
  readonly points: readonly RankPoint[];
}

const OUTCOMES: ReadonlySet<string> = new Set<string>(RANK_OUTCOMES);
/** Whether `value` is enough of a point to keep: a string reading id, a finite time and a known outcome. */
const isPoint = (value: unknown): value is RankPoint => isRecord(value) && isNonEmptyString(value.readingId) && typeof value.at === 'number' && Number.isFinite(value.at) && typeof value.outcome === 'string' && OUTCOMES.has(value.outcome);
const byPointTime = (a: RankPoint, b: RankPoint): number => a.at - b.at || (a.readingId < b.readingId ? -1 : a.readingId > b.readingId ? 1 : 0);

/**
 * One rank table row from its parts (as `rankTable` builds it from every reading): `latest`, `previous`
 * and `change` from the two newest of `recent` that are of this series (`keyOf` for an older key
 * version), `competitors` on the latest; `points` the given points within the range (oldest first, a
 * reading once, the newest `maxPointsPerSeries`) and `best` over all of them. `null` with neither a
 * reading nor a saved search (no parameters to show). Total: garbage never throws.
 */
export function rankRowOf(parts: RankRowParts, options: RankModelOptions): RankRow | null {
  const input = optionsOf(parts);
  const opts = optionsOf(options);
  const searchKey = input.searchKey;
  if (!isNonEmptyString(searchKey)) return null;
  const site = siteOf(opts.site);
  const competitors = competitorsOf(opts.competitors);
  const start = startOf(opts);
  const saved = input.saved === null || input.saved === undefined ? null : savedOf(input.saved);
  const group = groups(input.recent, opts.keyOf).get(searchKey) ?? [];
  const newest = group.at(-1) ?? null;
  if (newest === null && saved === null) return null;
  const latest = newest === null ? null : rankOf(newest, site);
  const before = group.at(-2);
  const previous = before === undefined ? null : rankOf(before, site);
  const seen = new Set<string>();
  const inRange: RankPoint[] = [];
  for (const point of Array.isArray(input.points) ? (input.points as unknown[]) : []) {
    if (!isPoint(point) || seen.has(point.readingId) || point.at < start) continue;
    seen.add(point.readingId);
    inRange.push(point);
  }
  inRange.sort(byPointTime);
  let best: number | null = null;
  for (const point of inRange) if (point.outcome === 'ranked' && isPositiveInt(point.position) && (best === null || point.position < best)) best = point.position;
  return {
    searchKey,
    params: newest?.params ?? (saved as SavedSearchRef).params,
    filters: newest !== null ? (isRecord(newest.filters) ? newest.filters : {}) : isRecord(saved?.filters) ? saved.filters : {},
    saved: saved === null ? null : { id: saved.id, tags: saved.tags },
    latest,
    previous,
    change: changeOf(previous, latest),
    best,
    points: inRange.slice(-RANK_LIMITS.maxPointsPerSeries),
    competitors: Object.fromEntries(competitors.map((competitor) => [competitor.host, newest === null ? null : rankOf(newest, competitor)])),
  };
}

// ---- CSV rows (Task 5 formats them) -------------------------------------------------------------

/** An ISO 8601 time, or empty when `at` is not a valid date. */
function isoOf(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const filtersText = (filters: unknown): string =>
  isRecord(filters)
    ? Object.keys(filters)
        .sort()
        .map((name) => `${name}=${text(filters[name])}`)
        .join(' ')
    : '';

/** The search columns both exports start with: search, engine, country, language, device, page, filters. */
function searchCells(row: RankRow): RankCsvCell[] {
  const params = optionsOf(row.params);
  return [text(params.query), text(params.engine), text(params.gl), text(params.hl), text(params.device), isPositiveInt(params.page) ? params.page : 1, filtersText(row.filters)];
}

const positionCell = (point: RankPoint | null | undefined): RankCsvCell => (point?.outcome === 'ranked' && typeof point.position === 'number' ? point.position : '');

/**
 * CSV rows of the rank table, the header first: `table` (`RANK_CSV_COLUMNS` and one column per
 * competitor host, one line per row) or `history` (`RANK_HISTORY_CSV_COLUMNS`, one line per point).
 * Plain strings and numbers with ISO dates; no escaping or formula guard (Task 5's `csvCell`).
 */
export function rankCsvRows(rows: readonly RankRow[], kind: RankCsvKind): RankCsvCell[][] {
  const list = Array.isArray(rows) ? rows.filter((row): row is RankRow => isRecord(row)).slice(0, RANK_LIMITS.maxRows) : [];
  if (kind === 'history') {
    const out: RankCsvCell[][] = [[...RANK_HISTORY_CSV_COLUMNS]];
    for (const row of list) {
      const search = searchCells(row);
      const points = Array.isArray(row.points) ? row.points.filter((point): point is RankPoint => isRecord(point)).slice(-RANK_LIMITS.maxPointsPerSeries) : [];
      for (const point of points) {
        out.push([...search, isoOf(point.at), text(point.outcome), positionCell(point), typeof point.organicRead === 'number' ? point.organicRead : '', text(point.url), Array.isArray(point.alsoIn) ? point.alsoIn.join('; ') : '']);
      }
    }
    return out;
  }
  const hosts: string[] = [];
  for (const row of list) {
    for (const host of isRecord(row.competitors) ? Object.keys(row.competitors) : []) {
      if (!hosts.includes(host) && hosts.length < MAX_PROJECT_COMPETITORS) hosts.push(host);
    }
  }
  const out: RankCsvCell[][] = [[...RANK_CSV_COLUMNS, ...hosts]];
  for (const row of list) {
    const latest = isRecord(row.latest) ? row.latest : null;
    const tags = isRecord(row.saved) && Array.isArray(row.saved.tags) ? row.saved.tags.join('; ') : '';
    const change = typeof row.change === 'number' || typeof row.change === 'string' ? row.change : '';
    const competitors: Readonly<Record<string, unknown>> = isRecord(row.competitors) ? row.competitors : {};
    out.push([
      ...searchCells(row),
      tags,
      text(latest?.outcome),
      positionCell(latest),
      change,
      typeof row.best === 'number' ? row.best : '',
      text(latest?.url),
      latest === null ? '' : isoOf(latest.at),
      ...hosts.map((host) => positionCell(competitors[host] as RankPoint | null | undefined)),
    ]);
  }
  return out;
}
