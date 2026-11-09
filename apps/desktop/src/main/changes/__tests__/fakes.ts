import { runAudit, type SeoAudit } from '@app/seo-core';
import { PAGE_REGIONS, type PageRegion } from '@app/specs/capture.spec';
import type { RegionAnswer, RegionTextAnswer } from '@app/specs/changes.spec';
import type { SerpRunVerdict } from '@app/specs/rankings.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpReady } from '@app/specs/serp-snapshot.schema';
import { SERP_RESULT_TYPES } from '@app/specs/serp-selector-pack.spec';
import { NO_PAGE_CONTEXT, PageSnapshotSchema, type ExtractedSnapshot, type PageContext } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import type { SearchParamsOf } from '../serp-params';
import { storedPageUrl } from '../snapshot';

// Change-intelligence fixtures: a real audit of a page, a region answer as the extraction gives it, and
// Phase 3's SERP reading of a result page (a valid ready snapshot; a run's ready verdicts).

/** The audit `runAudit` makes of `rawSnapshot(url, changes)` (with `context`, else none collected). */
export function auditOf(url: string, changes: Partial<ExtractedSnapshot> = {}, context: PageContext = NO_PAGE_CONTEXT): SeoAudit {
  return runAudit({ ...PageSnapshotSchema.parse(rawSnapshot(url, changes)), ...context });
}

/** One region's text, untruncated: `text` is its blocks joined, words counted by spaces. */
export function regionText(blocks: string[] = [], truncated = false): RegionTextAnswer {
  return { words: blocks.reduce((sum, block) => sum + block.split(' ').length, 0), blocks, truncated, text: blocks.join('\n') };
}

/** A valid region answer for `url`: an h1 and two paragraphs in `main`, one nav link, the rest empty. */
export function regionAnswer(url: string, regions: Partial<Record<PageRegion, RegionTextAnswer>> = {}, changes: Partial<RegionAnswer> = {}): RegionAnswer {
  return {
    url,
    partial: false,
    headings: [{ level: 1, text: 'Main heading', region: 'main' }],
    links: { total: 1, internal: 1, external: 0, nofollow: 0, list: [{ href: 'https://example.com/other', text: 'Other page', rel: '', region: 'nav' }] },
    regions: {
      ...(Object.fromEntries(PAGE_REGIONS.map((region) => [region, regionText()])) as Record<PageRegion, RegionTextAnswer>),
      main: regionText(['Main heading', 'A first paragraph about tea.', 'A second paragraph about biscuits.']),
      ...regions,
    },
    ...changes,
  };
}

/** A valid ready SERP reading of `params` (`SerpReadySchema`): one organic result of example.com. */
export function readyReading(params: SearchParams, changes: Partial<SerpReady> = {}): SerpReady {
  const counts = Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, type === 'organic' ? 1 : 0])) as SerpReady['composition']['counts'];
  return {
    status: 'ready',
    params,
    packVersion: 3,
    results: [{ rank: 1, type: 'organic', position: 1, featureSlot: null, title: 'Green tea guide', url: 'https://example.com/tea', redirected: false, domain: 'example.com' }],
    composition: { counts, features: [] },
    ownership: { page: params.page, organic: 1, complete: true, domains: [{ domain: 'example.com', count: 1, share: 1, positions: [1], best: 1 }] },
    truncated: false,
    ...changes,
  };
}

/**
 * A run whose SERP readings are all ready (`CaptureRunDeps.serpVerdictOf` and `searchParamsOf`): every
 * landed page's verdict is `ready`, and its search parameters are those of the target with that URL
 * (stored form), else `null`.
 */
export function readySerpFor(targets: readonly { readonly url: string; readonly searchParams: SearchParams | null }[]): { serpVerdictOf: () => SerpRunVerdict; searchParamsOf: SearchParamsOf } {
  return {
    serpVerdictOf: () => 'ready',
    searchParamsOf: (_tabId, pageUrl) => targets.find((target) => storedPageUrl(target.url) === pageUrl)?.searchParams ?? null,
  };
}
