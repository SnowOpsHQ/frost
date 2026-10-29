import type { SerpReadApi } from '@app/ipc-contract';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import type { SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { SERP_PACK_PUBLIC_KEYS } from '@app/specs/serp-selector-pack.spec';
import type { SerpDevice } from '@app/specs/serp.spec';
import { BUNDLED_PACK } from '../serp/bundled';
import { matchSerp } from '../serp/engines';
import { verifyPack } from '../serp/pack-verify';
import { storedPageUrl } from './snapshot';

// Phase 3's search parameters for change intelligence (acceptance `changes-diff.feature.md`, Search
// parameters; `changes-capture.feature.md`, Search parameters of a tab; `projects.feature.md`, Saved
// searches). Two sources, both Phase 3's own code, never edited here:
// - a tab's: its `SerpState` from `SerpReadApi.snapshot`, bound late (the changes and screenshots
//   services are made before `setupSerp` runs in `whenReady`). Only a finished reading of the page
//   being captured counts: the state's `url` (the page's own) must be that page in its stored form.
// - a saved search's: `matchSerp` over its URL with the bundled selector pack (verified once).

/** The search parameters of a tab's page (`pageUrl`: the page being captured, stored form); `null` for none. */
export type SearchParamsOf = (tabId: number, pageUrl: string) => SearchParams | null;

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/**
 * The search parameters a `SerpState` holds for tab `tabId` showing `pageUrl`: a `ready` reading's
 * `snapshot.params` or an `unreadable` one's `params`, checked with `SearchParamsSchema`; `null` for
 * `not-serp`, `pending`, `disabled`, a state of another tab or page, and anything that does not fit.
 * Only the parameters are validated (the rest of the reading is not recorded). Never throws.
 */
export function searchParamsOfState(state: unknown, tabId: number, pageUrl: string): SearchParams | null {
  const value = record(state);
  if (value === null || value.tabId !== tabId || typeof value.url !== 'string') return null;
  const page = storedPageUrl(pageUrl);
  if (page === null || storedPageUrl(value.url) !== page) return null;
  const params = value.status === 'ready' ? record(value.snapshot)?.params : value.status === 'unreadable' ? value.params : undefined;
  if (params === undefined || params === null) return null;
  const parsed = SearchParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
}

/** A `searchParamsOf` that answers `null` until `bind` gives it Phase 3's read API (main `index.ts`, after `setupSerp`). */
export interface LateSearchParams {
  readonly of: SearchParamsOf;
  bind(api: Pick<SerpReadApi, 'snapshot'>): void;
}

export function lateSearchParams(): LateSearchParams {
  let api: Pick<SerpReadApi, 'snapshot'> | null = null;
  return {
    of: (tabId, pageUrl) => {
      if (api === null) return null;
      try {
        return searchParamsOfState(api.snapshot(tabId), tabId, pageUrl);
      } catch {
        return null;
      }
    },
    bind: (next) => {
      api = next;
    },
  };
}

let bundled: SelectorPack | null | undefined;

/** The bundled selector pack, verified with its signature once (`null` when it does not verify: SERP reading is off then too). */
export function bundledPack(): SelectorPack | null {
  if (bundled === undefined) {
    const verified = verifyPack(BUNDLED_PACK.bytes, BUNDLED_PACK.signature, SERP_PACK_PUBLIC_KEYS);
    bundled = verified.ok ? verified.pack : null;
  }
  return bundled;
}

/** Phase 3's search parameters of result page `url` on `device` (`matchSerp`), by the bundled pack; `null` for any other URL. Never throws. */
export function searchParamsForUrl(url: string, device: SerpDevice, pack: SelectorPack | null = bundledPack()): SearchParams | null {
  if (pack === null) return null;
  const params = matchSerp(url, pack, device)?.params;
  if (params === undefined) return null;
  const parsed = SearchParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : null;
}
