import { DATA_CHECK_TEXT, DATA_PROVIDER_LABELS, isDataSerpProvider, type DataSerpProvider } from '@app/specs/data-sources.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { DataSerpProviderView } from '@app/specs/data-sources.schema';
import type { PaletteSource } from './palette/registry';

// "Check searches via <provider>" in the command palette (Phase 12 Task 4; acceptance
// `data-sources.feature.md`, Check via API: api-check-palette-command; `projects.feature.md`, Checking
// searches via a data API). Offered only while main's view names a vendor (`dataSources.serpProvider`:
// a legal gate open and a key set) and a project was opened this session; it never sends by itself: it
// opens that project's Rankings view on the same confirm the "Check via API" button shows. Registered
// from `components/changes/Rankings.tsx`; pure (main's view and the sheet are injected) so availability
// is unit tested. Also here: the cache of main's view the palette reads (the registry asks synchronously),
// and the request the palette leaves for the Rankings view.

export interface DataSourcesPaletteApi {
  /** The vendor main's view named when last read (`null`: none, or not read yet). */
  provider(): DataSerpProvider | null;
  /** Reads main's view again, in the background (at most once per `PROVIDER_REFRESH_MS`). */
  refresh(): void;
  /** The project last opened in the sheet (`undefined`: none this session). */
  lastProject(): string | undefined;
  /** Opens the project's Rankings view on the "Check via API" confirm. */
  openCheck(projectId: string): void;
}

const KEYWORDS = ['check', 'api', 'data', 'source', 'serp', 'rankings', 'rank', 'positions', 'searches', 'provider', 'serpapi', 'dataforseo', 'serper'];

/** The palette's "Check searches via <provider>", calling `api`. */
export function dataSourcesPaletteSources(api: DataSourcesPaletteApi): PaletteSource[] {
  return [
    () => {
      // Each listing asks main again (throttled): the next one follows a key or a choice made meanwhile.
      api.refresh();
      const provider = api.provider();
      const projectId = api.lastProject();
      if (provider === null || projectId === undefined) return [];
      return [
        {
          id: 'data-sources.check-searches',
          label: DATA_CHECK_TEXT.palette(DATA_PROVIDER_LABELS[provider]),
          group: 'page',
          keywords: KEYWORDS,
          icon: 'panel-changes',
          focus: 'handler',
          run: () => {
            api.openCheck(projectId);
            return null;
          },
        },
      ];
    },
  ];
}

/** The least time between two reads of main's view by the palette. */
export const PROVIDER_REFRESH_MS = 5_000;

export interface SerpProviderCache {
  current(): DataSerpProvider | null;
  refresh(): void;
}

/** Main's "Check via API" vendor, as last read through `read` (a failed or malformed read: none). */
export function createSerpProviderCache(read: () => Promise<DataSerpProviderView | null>, now: () => number = Date.now): SerpProviderCache {
  let provider: DataSerpProvider | null = null;
  let lastRead = Number.NEGATIVE_INFINITY;
  let reading = false;
  return {
    current: () => provider,
    refresh() {
      const at = now();
      if (reading || at - lastRead < PROVIDER_REFRESH_MS) return;
      reading = true;
      lastRead = at;
      void Promise.resolve()
        .then(read)
        .then(
          (view) => {
            provider = view !== null && isDataSerpProvider(view.provider) ? view.provider : null;
          },
          () => {
            provider = null;
          },
        )
        .finally(() => {
          reading = false;
        });
    },
  };
}

// ---- The palette's request to the Rankings view -------------------------------------------------

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Asks the Rankings view of `projectId` to show the "Check via API" confirm (it never sends by itself). */
export function requestApiCheck(projectId: string): void {
  pending = projectId;
  for (const listener of [...listeners]) listener();
}

/** Whether a confirm was asked for `projectId`; the request is taken (answered once). */
export function takeApiCheckRequest(projectId: string): boolean {
  if (pending !== projectId) return false;
  pending = null;
  return true;
}

/** Subscribes to the palette's requests; answers the unsubscribe. */
export function onApiCheckRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
