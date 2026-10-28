import { registrableDomain } from '@app/seo-core';
import { SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import { isSerpFeature, type SerpUnreadableReason } from '@app/specs/serp.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpReadSchema, SerpSnapshotSchema, type SerpComposition, type SerpOwnership, type SerpReadBlock, type SerpResult, type SerpSnapshot } from '@app/specs/serp-snapshot.schema';

// SERP analysis (spec `serp-snapshot.schema.ts`, the result model; `serp.spec.ts`; acceptance
// `serp-overlay.feature.md`, Analysis). Pure, and run only in the SERP worker (`serp-worker.ts`),
// never on Electron's main thread: the reader's raw answer and the search parameters in, a
// validated `SerpSnapshot` out. Never throws.
// - The answer is page data: it is validated with `SerpReadSchema` first, and the parameters and
//   pack version (from main, over a structured clone) with theirs; anything that fails is
//   `invalid-answer`. A reader failure is `unreadable` with the reader's reason; a timeout's partial
//   blocks are never analysed.
// - Ranks over every result in document order; organic positions 1 … n and ad positions 1 … k, each
//   their own count; each feature block a slot (1, 2, … in document order).
// - Composition: results per type (every type) and the feature blocks in order.
// - Ownership: the organic results with a domain, grouped by registrable domain, sorted by count
//   (most first), then best position, then name. Ads are not counted.
// - The snapshot is validated again (`SerpSnapshotSchema`) before it leaves.

export interface SerpAnalysisContext {
  /** The page's search parameters (`matchSerp`), validated here again. */
  readonly params: unknown;
  /** The version of the pack the page was read with. */
  readonly packVersion: unknown;
}

/** The registrable domain of `url`'s host, or `null`. */
function domainOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    const host = new URL(url).hostname;
    const domain = host === '' ? '' : registrableDomain(host);
    return domain.length > 0 && domain.length <= 253 ? domain : null;
  } catch {
    return null;
  }
}

function results(blocks: readonly SerpReadBlock[]): { results: SerpResult[]; composition: SerpComposition } {
  const out: SerpResult[] = [];
  const counts = Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, 0])) as Record<SerpResultType, number>;
  const features: SerpComposition['features'] = [];
  let organic = 0;
  let ads = 0;
  for (const block of blocks) {
    const slot = isSerpFeature(block.type) ? features.length + 1 : null;
    if (slot !== null && isSerpFeature(block.type)) features.push({ slot, type: block.type, results: block.items.length });
    for (const item of block.items) {
      counts[block.type] += 1;
      const position = block.type === 'organic' ? ++organic : block.type === 'ad' ? ++ads : null;
      out.push({ rank: out.length + 1, type: block.type, position, featureSlot: slot, title: item.title, url: item.url, domain: domainOf(item.url) });
    }
  }
  return { results: out, composition: { counts, features } };
}

function ownership(all: readonly SerpResult[], page: number): SerpOwnership {
  const organic = all.filter((result) => result.type === 'organic' && result.domain !== null && result.position !== null);
  const byDomain = new Map<string, number[]>();
  for (const result of organic) {
    const positions = byDomain.get(result.domain!) ?? [];
    positions.push(result.position!);
    byDomain.set(result.domain!, positions);
  }
  const domains = [...byDomain].map(([domain, positions]) => ({ domain, count: positions.length, share: positions.length / organic.length, positions, best: Math.min(...positions) }));
  domains.sort((a, b) => b.count - a.count || a.best - b.best || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { page, organic: organic.length, domains };
}

/** Analyses the reader's raw answer for the page with `context`'s parameters. */
export function analyseSerp(raw: unknown, context: SerpAnalysisContext): SerpSnapshot {
  const parsedParams = SearchParamsSchema.safeParse(context?.params);
  const params: SearchParams | null = parsedParams.success ? parsedParams.data : null;
  const version = context?.packVersion;
  const packVersion = typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 ? version : null;
  const unreadable = (reason: SerpUnreadableReason): SerpSnapshot => ({ status: 'unreadable', reason, params, packVersion });
  if (params === null || packVersion === null) return unreadable('invalid-answer');

  const read = SerpReadSchema.safeParse(raw);
  if (!read.success) return unreadable('invalid-answer');
  if (!read.data.ok) return unreadable(read.data.reason);
  if (read.data.blocks.length === 0) return unreadable('no-results');

  const { results: all, composition } = results(read.data.blocks);
  const snapshot = SerpSnapshotSchema.safeParse({
    status: 'ready',
    params,
    packVersion,
    results: all,
    composition,
    ownership: ownership(all, params.page),
    truncated: read.data.stats.truncated,
  });
  return snapshot.success ? snapshot.data : unreadable('invalid-answer');
}
