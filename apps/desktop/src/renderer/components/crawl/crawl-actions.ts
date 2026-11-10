// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { CrawlCsvAnswer, CrawlCsvInput, CrawlPagesAnswer, CrawlPagesInput, CrawlStartInput, CrawlStructureAnswer, CrawlStructureInput, CrawlWatchView } from '@app/specs/site-crawl.schema';
import type { CrawlServiceAnswer } from '@app/specs/site-crawl.spec';
import { ipc } from '../../ipc';

// The crawl sheet's calls to main (Phase 12 Task 7; the sender-guarded `crawl.*` procedures). Each answers
// main's answer, or `null` when the call failed (the sheet says so); `watch` rejects, so the long-poll rests
// and asks again.

export const crawlActions = {
  watch: (sinceVersion: number): Promise<CrawlWatchView> => ipc.crawl.watch.query({ sinceVersion }),
  start: (input: CrawlStartInput): Promise<CrawlServiceAnswer | null> => ipc.crawl.start.mutate(input).catch(() => null),
  pause: (runId: string): Promise<CrawlServiceAnswer | null> => ipc.crawl.pause.mutate({ runId }).catch(() => null),
  resume: (runId: string): Promise<CrawlServiceAnswer | null> => ipc.crawl.resume.mutate({ runId }).catch(() => null),
  cancel: (runId: string): Promise<CrawlServiceAnswer | null> => ipc.crawl.cancel.mutate({ runId }).catch(() => null),
  delete: (runId: string): Promise<CrawlServiceAnswer | null> => ipc.crawl.delete.mutate({ runId }).catch(() => null),
  pages: (input: CrawlPagesInput): Promise<CrawlPagesAnswer | null> => ipc.crawl.pages.query(input).catch(() => null),
  structure: (input: CrawlStructureInput): Promise<CrawlStructureAnswer | null> => ipc.crawl.structure.query(input).catch(() => null),
  exportCsv: (input: CrawlCsvInput): Promise<CrawlCsvAnswer | null> => ipc.crawl.exportCsv.mutate(input).catch(() => null),
};
