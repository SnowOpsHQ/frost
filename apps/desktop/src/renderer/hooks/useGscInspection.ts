import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { GscOpenLinkResult } from '@app/specs/gsc-inspection.spec';
import type { GscStatus } from '@app/specs/gsc.spec';
import { createGscInspectionStore, gscInspectionKey, type GscInspectionEntry } from '../gsc-inspection-view';
import { ipc } from '../ipc';
import { gscStore, useGscStatus } from '../settings-hooks';

// URL Inspection's cards (Phase 9 Task 4; acceptance `gsc-inspection.feature.md`, Card): one shared
// entry per page (the URL without its fragment) for every tab and both cards (Indexability's "Google's
// view" and Schema's "Detected by Google"), so they show the same answer from one request. Mounting a
// card reads `gsc.watch` only; `gsc.inspect` is sent only by `inspect` (a click, or the palette).
// "Open in Search Console" names the page: main opens its own cached link, the chrome never sees it.

/** The chrome's one store (both cards and the palette share it; a failed call reads as `invalid`). */
export const gscInspectionStore = createGscInspectionStore((input) => ipc.gsc.inspect.mutate(input));

/** The palette's view of it (`gsc-palette.ts`): main's connection as last answered, and asking for a page. */
export const gscInspectPaletteApi = {
  status: (): GscStatus | null => gscStore.current(),
  inspect: (url: string): void => gscInspectionStore.inspect(url, false),
};

export interface GscInspection {
  /** `gsc.watch` (`null` until main answers). */
  readonly status: GscStatus | null;
  /** The page's shared entry (`null`: nothing asked). */
  readonly entry: GscInspectionEntry | null;
  /** Asks main about the page (`fresh`: past its cache, "Inspect again"). */
  readonly inspect: (fresh: boolean) => void;
  /** Asks main to open the Search Console page of its answer for the page (`no-link` on an IPC failure). */
  readonly openLink: () => Promise<GscOpenLinkResult>;
}

export function useGscInspection(url: string): GscInspection {
  const status = useGscStatus();
  const version = status?.version ?? null;
  useEffect(() => {
    if (version !== null) gscInspectionStore.sync(version);
  }, [version]);
  const key = gscInspectionKey(url);
  const entry = useSyncExternalStore(gscInspectionStore.subscribe, () => gscInspectionStore.get(key));
  const inspect = useCallback((fresh: boolean) => gscInspectionStore.inspect(key, fresh), [key]);
  const openLink = useCallback(() => ipc.gsc.openInspectionLink.mutate({ url: key }).catch((): GscOpenLinkResult => 'no-link'), [key]);
  return { status, entry, inspect, openLink };
}
