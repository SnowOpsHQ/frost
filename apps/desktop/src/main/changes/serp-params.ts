import type { SerpReadApi } from '@app/ipc-contract';
import type { SerpRunVerdict } from '@app/specs/rankings.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpStateSchema, type SerpState } from '@app/specs/serp-service.schema';
import { SerpSnapshotSchema, type SerpSnapshot } from '@app/specs/serp-snapshot.schema';
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
// Phase 10 (`changes-capture.feature.md`, SERP reading) reads two more things from the same state, bound
// the same way: the tab's whole reading of the page (`readingOf`, stored with a capture) and a run's
// verdict on its landed page (`verdictOf`, `SERP_RUN_VERDICTS`).

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

/** A tab's SERP reading of its page (`pageUrl`: stored form); `null` for none. */
export type SerpReadingOf = (tabId: number, pageUrl: string) => SerpSnapshot | null;
/** What a tab's SERP state says of its page (`pageUrl`: stored form); `pending` when it says nothing of it. */
export type SerpVerdictOf = (tabId: number, pageUrl: string) => SerpRunVerdict;

/**
 * `state` when it is a `SerpState` (`SerpStateSchema`) of tab `tabId` showing `pageUrl` (both in
 * stored form; a `disabled` state has no page and is of every page); else `null`. Never throws.
 */
function stateOfPage(state: unknown, tabId: number, pageUrl: string): SerpState | null {
  const value = record(state);
  if (value === null || value.tabId !== tabId) return null;
  const parsed = SerpStateSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.status === 'disabled') return parsed.data;
  const page = storedPageUrl(pageUrl);
  return page !== null && storedPageUrl(parsed.data.url) === page ? parsed.data : null;
}

/**
 * The reading a `SerpState` holds for tab `tabId` showing `pageUrl`, as a capture stores it: a `ready`
 * state's snapshot, or an `unreadable` one rebuilt as `{ status: 'unreadable', reason, params,
 * packVersion }` (`null` when it has no parameters: no search key), validated with
 * `SerpSnapshotSchema`; `null` for `pending`, `not-serp`, `disabled`, a state of another tab or page,
 * and anything that does not fit. Never throws.
 */
export function serpReadingOfState(state: unknown, tabId: number, pageUrl: string): SerpSnapshot | null {
  const found = stateOfPage(state, tabId, pageUrl);
  let reading: unknown;
  if (found?.status === 'ready') reading = found.snapshot;
  else if (found?.status === 'unreadable' && found.params !== null) reading = { status: 'unreadable', reason: found.reason, params: found.params, packVersion: found.packVersion };
  else return null;
  const parsed = SerpSnapshotSchema.safeParse(reading);
  return parsed.success ? parsed.data : null;
}

/**
 * A run's verdict on tab `tabId`'s page `pageUrl` (`SERP_RUN_VERDICTS`): the state's status for that
 * tab and page (`disabled` whatever the page); `pending` for a state of another tab or page and for
 * anything that does not fit `SerpStateSchema`. Never `null`; never throws.
 */
export function serpVerdictOfState(state: unknown, tabId: number, pageUrl: string): SerpRunVerdict {
  return stateOfPage(state, tabId, pageUrl)?.status ?? 'pending';
}

/**
 * A `searchParamsOf`, `readingOf` and `verdictOf` that answer none (`null`; `pending` for the verdict)
 * until `bind` gives them Phase 3's read API (main `index.ts`, after `setupSerp`).
 */
export interface LateSearchParams {
  readonly of: SearchParamsOf;
  readonly readingOf: SerpReadingOf;
  readonly verdictOf: SerpVerdictOf;
  bind(api: Pick<SerpReadApi, 'snapshot'>): void;
}

export function lateSearchParams(): LateSearchParams {
  let api: Pick<SerpReadApi, 'snapshot'> | null = null;
  /** `read` over the tab's state, or `none` while unbound or when the read API throws. */
  const over =
    <T>(read: (state: unknown, tabId: number, pageUrl: string) => T, none: T) =>
    (tabId: number, pageUrl: string): T => {
      if (api === null) return none;
      try {
        return read(api.snapshot(tabId), tabId, pageUrl);
      } catch {
        return none;
      }
    };
  return {
    of: over(searchParamsOfState, null),
    readingOf: over(serpReadingOfState, null),
    verdictOf: over<SerpRunVerdict>(serpVerdictOfState, 'pending'),
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

/**
 * Whether `url` is an `http(s)` URL on one of the bundled pack's engine hosts **and** one of that
 * engine's result `paths` (Google and Bing `/search`; DuckDuckGo `/`, `/html`, `/html/`), whatever its
 * parameters (the pack's `reject` rules are not applied: Google `udm=50` or `tbm=isch`, DuckDuckGo
 * `ia=images` still send a search to the engine). A run treats such a page target as a search
 * (`capture-run.ts`, `queriesAnEngine`): disclosed, paced and gated. Any other page on an engine's host
 * (Google Maps, DuckDuckGo `/about`) is an ordinary page. Never throws.
 */
export function isEngineResultPath(url: string, pack: SelectorPack | null = bundledPack()): boolean {
  if (pack === null || typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // An engine's bare home page (DuckDuckGo's result path is `/`) sends no search: a page (council review).
  if (parsed.pathname === '/' && (parsed.searchParams.get('q') ?? '').trim() === '') return false;
  return pack.engines.some((engine) => engine.hosts.includes(host) && engine.paths.includes(parsed.pathname));
}
