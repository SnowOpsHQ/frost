import type { CrawlCsvAnswer, CrawlCsvInput, CrawlPagesAnswer, CrawlPagesInput, CrawlStartInput, CrawlStatusView, CrawlStructureAnswer, CrawlStructureInput, CrawlWatchView } from '@app/specs/site-crawl.schema';
import type { CrawlServiceAnswer } from '@app/specs/site-crawl.spec';

// The site crawl as the `crawl.*` procedures see it (Phase 12 Task 7; spec `site-crawl.spec.ts`,
// `site-crawl.schema.ts`; acceptance `site-crawl.feature.md`, Pages and Site structure). Main implements
// it (`apps/desktop/src/main/crawl/ipc.ts`) over its crawl service and the crawl tables; this package only
// knows the interface. Every method answers and none rejects. `start` and `resume` are main's to refuse
// while the L6 gate is closed (`unavailable`, with `LEGAL_GATE_NOTE`): the procedures pass that answer
// through. Pages and the tree are read in SQL, a page or a level at a time; no method answers a full list,
// and none takes a path or a file name (the CSV goes where the user picks in main's own dialog).

export interface CrawlIpcService {
  /** The crawl view: whether a crawl may start (`available`), the running run, the runs (newest first). */
  status(): Promise<CrawlStatusView>;
  /**
   * The view with the change counter it was read at, once the counter passes `sinceVersion` (at once if
   * it already has); when `signal` aborts (the procedure's `CRAWL_WATCH.timeoutMs`), or when the same
   * `sender` (its window id) has more than `CRAWL_WATCH.maxPending` polls waiting (its oldest), the
   * current view. Another window's poll never evicts this one.
   */
  watch(sinceVersion: number, signal: AbortSignal, sender: number | null): Promise<CrawlWatchView>;
  start(input: CrawlStartInput): Promise<CrawlServiceAnswer>;
  pause(runId: string): Promise<CrawlServiceAnswer>;
  resume(runId: string): Promise<CrawlServiceAnswer>;
  cancel(runId: string): Promise<CrawlServiceAnswer>;
  delete(runId: string): Promise<CrawlServiceAnswer>;
  /** One page of a run's pages, filtered and sorted in SQL. */
  pages(input: CrawlPagesInput): Promise<CrawlPagesAnswer>;
  /** One level of a run's path tree, its click-depth histogram and its sitemap orphans. */
  structure(input: CrawlStructureInput): Promise<CrawlStructureAnswer>;
  /**
   * The run's pages the filter selects, as CSV, written where the user picks in main's save dialog
   * (parented to `windowId`), the dialog first, then the rows appended a batch at a time; one export at a
   * time (`exporting`).
   */
  exportCsv(windowId: number | null, input: CrawlCsvInput): Promise<CrawlCsvAnswer>;
}
