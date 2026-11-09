// Comparing two SERP readings (Phase 10 Task 3; spec `specs/rankings.spec.ts`; acceptance
// `specs/rankings.feature.md`, Comparison): two dates of one search, or two searches, side by side per
// owner domain. Pure and total, bounded by `RANK_LIMITS.maxRows`.
import {
  RANK_LIMITS,
  type CompareMovement,
  type SearchParamsShape,
  type SerpComparison,
  type SerpComparisonPlace,
  type SerpComparisonRow,
  type SerpComparisonSide,
  type SerpFeatureType,
  type SerpFilters,
  type SerpObservation,
  type SiteMatch,
} from '@app/specs/rankings.spec';
import { competitorsOf, isFeature, isOrganic, isRecord, rankOf, readyResults, siteOf } from './rankings';

export interface CompareOptions {
  readonly site: SiteMatch | null;
  readonly competitors?: readonly SiteMatch[];
}

interface Side {
  readonly side: SerpComparisonSide;
  /** Each owner domain's best organic place. */
  readonly places: ReadonlyMap<string, SerpComparisonPlace>;
}

const lower = (domain: string): string => domain.toLowerCase().replace(/\.$/, '');

function sideOf(observation: unknown): Side {
  const record = isRecord(observation) ? observation : {};
  const results = readyResults(record.snapshot);
  const features: SerpFeatureType[] = [];
  const places = new Map<string, SerpComparisonPlace>();
  let organicRead = 0;
  for (const result of results ?? []) {
    if (isFeature(result)) {
      if (!features.includes(result.type)) features.push(result.type);
      continue;
    }
    if (!isOrganic(result)) continue;
    organicRead += 1;
    if (typeof result.domain !== 'string' || result.domain.length === 0) continue;
    const domain = lower(result.domain);
    const position = result.position as number;
    const known = places.get(domain);
    if (known === undefined || position < known.position) places.set(domain, { position, url: typeof result.url === 'string' ? result.url : null });
  }
  const snapshot = isRecord(record.snapshot) ? record.snapshot : {};
  return {
    side: {
      readingId: typeof record.id === 'string' ? record.id : '',
      at: typeof record.observedAt === 'number' && Number.isFinite(record.observedAt) ? record.observedAt : 0,
      params: isRecord(record.params) ? (record.params as SearchParamsShape) : null,
      filters: isRecord(record.filters) ? (record.filters as SerpFilters) : {},
      status: results === null ? 'unreadable' : 'ready',
      organicRead,
      complete: results !== null && isRecord(snapshot.ownership) && snapshot.ownership.complete === true,
      features,
    },
    places,
  };
}

function movementOf(a: SerpComparisonPlace | null, b: SerpComparisonPlace | null): CompareMovement {
  if (a === null) return 'new';
  if (b === null) return 'gone';
  return b.position < a.position ? 'up' : b.position > a.position ? 'down' : 'same';
}

/** Orders rows by B's position, then the `gone` rows by A's, then by domain. */
function byPlace(x: SerpComparisonRow, y: SerpComparisonRow): number {
  const rank = (row: SerpComparisonRow): [number, number] => (row.b !== null ? [0, row.b.position] : [1, row.a?.position ?? 0]);
  const [gx, px] = rank(x);
  const [gy, py] = rank(y);
  return gx - gy || px - py || (x.domain < y.domain ? -1 : x.domain > y.domain ? 1 : 0);
}

/**
 * Readings `a` (the left pick) and `b` side by side: per owner domain its best organic place on each
 * side and how it moved, the feature types each page has, and the site's own points. Never throws.
 */
export function compareSerps(a: SerpObservation, b: SerpObservation, options: CompareOptions): SerpComparison {
  const opts: Readonly<Record<string, unknown>> = isRecord(options) ? options : {};
  const site = siteOf(opts.site);
  const competitors = competitorsOf(opts.competitors);
  const left = sideOf(a);
  const right = sideOf(b);
  const siteOwner = site === null ? null : lower(site.owner);
  const competitorOwners = new Set(competitors.map((competitor) => lower(competitor.owner)));
  const domains = new Set([...left.places.keys(), ...right.places.keys()]);
  const all: SerpComparisonRow[] = [...domains].map((domain) => {
    const placeA = left.places.get(domain) ?? null;
    const placeB = right.places.get(domain) ?? null;
    return {
      domain,
      a: placeA,
      b: placeB,
      movement: movementOf(placeA, placeB),
      change: placeA !== null && placeB !== null ? placeA.position - placeB.position : null,
      role: domain === siteOwner ? 'site' : competitorOwners.has(domain) ? 'competitor' : null,
    };
  });
  all.sort(byPlace);
  const flagged = all.filter((row) => row.role !== null).length;
  let others = Math.max(0, RANK_LIMITS.maxRows - flagged);
  const rows = all.filter((row) => row.role !== null || others-- > 0).slice(0, RANK_LIMITS.maxRows);
  const types: SerpFeatureType[] = [];
  for (const type of [...left.side.features, ...right.side.features]) if (!types.includes(type)) types.push(type);
  return {
    a: left.side,
    b: right.side,
    rows,
    features: types.map((type) => ({ type, a: left.side.features.includes(type), b: right.side.features.includes(type) })),
    site: site === null ? null : { a: rankOf(a, site), b: rankOf(b, site) },
    truncated: rows.length < all.length,
  };
}
