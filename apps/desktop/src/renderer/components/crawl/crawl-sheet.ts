import { useSyncExternalStore } from 'react';
import type { CrawlScope } from '@app/specs/site-crawl.spec';

// Whether the site crawl sheet is open, and what it was opened for (Phase 12 Task 7; acceptance
// `site-crawl.feature.md`, Pages and Site structure: Entry points), per window, like the Projects sheet.
// It opens from the palette ("Crawl this site…", "Show site crawl") and from a project's "Site crawl"
// button, and closes on Close or Esc, on "Open in tab", and when another sheet opens (one at a time).

/** What the sheet was opened for: a site to crawl and the project it belongs to. `seq` makes each one new. */
export interface CrawlRequest {
  readonly seq: number;
  /** The start form's start URL (`null`: the active tab's site). */
  readonly startUrl: string | null;
  /** The project a crawl started here belongs to (`null`: none). */
  readonly projectId: string | null;
  /** The start form's scope (`null`: `host`). */
  readonly scope: CrawlScope | null;
}

interface Snapshot {
  readonly open: boolean;
  readonly request: CrawlRequest | null;
}

let snapshot: Snapshot = { open: false, request: null };
const listeners = new Set<() => void>();
const openedListeners = new Set<() => void>();

function set(next: Snapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the sheet (on `startUrl`, for `projectId`). */
export function openCrawl(options: { readonly startUrl?: string | null; readonly projectId?: string | null; readonly scope?: CrawlScope | null } = {}): void {
  set({ open: true, request: { seq: (snapshot.request?.seq ?? 0) + 1, startUrl: options.startUrl ?? null, projectId: options.projectId ?? null, scope: options.scope ?? null } });
  for (const listener of [...openedListeners]) listener();
}

export function closeCrawl(): void {
  if (snapshot.open) set({ open: false, request: snapshot.request });
}

/** Subscribes to the sheet's open requests; answers the unsubscribe. */
export function onCrawlOpened(listener: () => void): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

/** Whether the sheet is open, and its latest request. */
export function useCrawlSheet(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
