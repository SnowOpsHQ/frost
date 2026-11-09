// Test fixtures for the rank read model (spec: specs/rankings.feature.md): schema-valid SERP readings
// built from a short list of results, and observations of them.
import { createHash } from 'node:crypto';
import { SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import { isSerpFeature } from '@app/specs/serp.spec';
import { SerpSnapshotSchema } from '@app/specs/serp-snapshot.schema';
import { searchIdentityJson, type SearchParamsShape, type SerpFilters, type SerpObservation, type SerpReadyShape, type SerpResultShape, type SerpSnapshotShape } from '@app/specs/rankings.spec';

export const DAY = 86_400_000;
export const NOW = 1_780_000_000_000;

export const PARAMS: SearchParamsShape = { engine: 'google', engineLabel: 'Google', query: 'green tea', gl: 'de', hl: 'de', device: 'desktop', page: 1, offset: null, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' };

/** Main's key rule, as the model gets it injected (`SearchKeyOf`): SHA-256 of the identity JSON, the host read with `URL` here (a test may). */
export const keyOf = (params: SearchParamsShape, filters: SerpFilters): string | null => {
  try {
    return createHash('sha256').update(searchIdentityJson(params, filters, new URL(params.url).host)).digest('hex');
  } catch {
    return null;
  }
};

export const KEY = keyOf(PARAMS, {})!;

/** `{ query }` (and anything else) changed, with a matching canonical URL. */
export function paramsOf(change: Partial<SearchParamsShape> = {}): SearchParamsShape {
  const next = { ...PARAMS, ...change };
  return change.url !== undefined ? next : { ...next, url: `https://www.google.com/search?q=${encodeURIComponent(next.query)}&gl=de&hl=de${next.page > 1 ? `&start=${(next.page - 1) * 10}` : ''}` };
}

/** A result as a test names it: its type and link (owner domain: the host's last two labels, or as given). */
export interface Item {
  readonly type: SerpResultType;
  readonly url: string | null;
  readonly domain?: string | null;
  readonly title?: string;
}

export const organic = (url: string, domain?: string | null): Item => ({ type: 'organic', url, ...(domain !== undefined ? { domain } : {}) });

function ownerOf(url: string | null): string | null {
  if (url === null) return null;
  const labels = new URL(url).hostname.split('.');
  return labels.slice(-2).join('.');
}

/** A `ready` reading of `items` in page order (each feature item its own block), checked against `SerpSnapshotSchema`. */
export function ready(items: readonly Item[], options: { page?: number; complete?: boolean; params?: SearchParamsShape } = {}): SerpReadyShape {
  const page = options.page ?? 1;
  const params = options.params ?? paramsOf({ page });
  let organicN = 0;
  let adN = 0;
  let slot = 0;
  const features: { slot: number; type: SerpReadyShape['composition']['features'][number]['type']; results: number }[] = [];
  const results: SerpResultShape[] = items.map((item, index) => {
    const feature = isSerpFeature(item.type);
    if (feature && isSerpFeature(item.type)) features.push({ slot: ++slot, type: item.type, results: 1 });
    return {
      rank: index + 1,
      type: item.type,
      position: item.type === 'organic' ? ++organicN : item.type === 'ad' ? ++adN : null,
      featureSlot: feature ? slot : null,
      title: item.title ?? `Result ${index + 1}`,
      url: item.url,
      redirected: false,
      domain: item.domain !== undefined ? item.domain : ownerOf(item.url),
    };
  });
  const counts = Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, results.filter((r) => r.type === type).length])) as Record<SerpResultType, number>;
  const owned = results.filter((r) => r.type === 'organic' && r.domain !== null);
  const byDomain = new Map<string, number[]>();
  for (const r of owned) byDomain.set(r.domain!, [...(byDomain.get(r.domain!) ?? []), r.position!]);
  const domains = [...byDomain].map(([domain, positions]) => ({ domain, count: positions.length, share: positions.length / owned.length, positions, best: Math.min(...positions) }));
  domains.sort((a, b) => b.count - a.count || a.best - b.best);
  const snapshot: SerpReadyShape = {
    status: 'ready',
    params,
    packVersion: 3,
    results,
    composition: { counts, features },
    ownership: { page, organic: owned.length, complete: options.complete ?? true, domains },
    truncated: options.complete === false,
  };
  SerpSnapshotSchema.parse(snapshot);
  return snapshot;
}

export const UNREADABLE: SerpSnapshotShape = { status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 3 };

let next = 0;
/** An observation of `snapshot` at `at` (current key version, `capture` source unless changed). */
export function observe(snapshot: SerpSnapshotShape, at: number, change: Partial<SerpObservation> = {}): SerpObservation {
  next += 1;
  const params = snapshot.params ?? PARAMS;
  return { id: `r-${String(next).padStart(6, '0')}`, searchKey: keyOf(params, {})!, params, filters: {}, observedAt: at, source: 'capture', snapshot, ...change };
}

/** Ten organic results on other sites, with the site's result at `position` (when given). */
export function page(position: number | null, site = 'https://www.example.com/tea'): SerpReadyShape {
  const items: Item[] = [];
  for (let p = 1; p <= 10; p += 1) items.push(p === position ? organic(site) : organic(`https://other${p}.org/x`));
  return ready(items);
}
