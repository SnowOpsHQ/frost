import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  CrawlCsvAnswerSchema,
  CrawlCsvInputSchema,
  CrawlPagesAnswerSchema,
  CrawlPagesInputSchema,
  CrawlRunIdInputSchema,
  CrawlServiceAnswerSchema,
  CrawlStartInputSchema,
  CrawlStatusViewSchema,
  CrawlStructureAnswerSchema,
  CrawlStructureInputSchema,
  CrawlWatchInputSchema,
  CrawlWatchViewSchema,
  type CrawlWatchView,
} from '@app/specs/site-crawl.schema';
import { CRAWL_WATCH } from '@app/specs/site-crawl.spec';
import type { CrawlIpcService } from './crawl-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The site crawl ↔ main (Phase 12 Task 7; spec `site-crawl.schema.ts`; acceptance `site-crawl.feature.md`,
// Pages and Site structure: The router). Every procedure starts `publicProcedure.use(enforceSender)`, then
// `requireCrawl` (which fails closed without the service), takes a strict, bounded input (run ids are
// UUIDv7s, pages at most `CRAWL_PAGES_LIMITS.maxPageSize`, filters and sorts from closed lists, never a
// path or a file name) and answers through a strict schema, so an answer carrying anything more is a
// masked internal error, never forwarded. `start` and `resume` pass main's answer through: main refuses
// them while the L6 gate is closed. The CSV's save dialog is parented to the sender's window.

/** Hands the procedure main's `CrawlIpcService` (after `enforceSender`; fails closed without it). */
const requireCrawl = middleware(({ ctx, next }) => {
  const crawl = ctx.services?.crawl;
  if (!crawl) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'crawl service unavailable' });
  return next({ ctx: { ...ctx, crawl } });
});

/** The long-poll behind `crawl.watch`, as `browser.watch`'s: the service's answer, or the current view after `CRAWL_WATCH.timeoutMs`. */
async function watchCrawl(crawl: CrawlIpcService, sinceVersion: number, sender: number | null): Promise<CrawlWatchView> {
  const release = new AbortController();
  const timer = setTimeout(() => release.abort(), CRAWL_WATCH.timeoutMs);
  try {
    return await crawl.watch(sinceVersion, release.signal, sender);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

const runProcedure = publicProcedure.use(enforceSender).use(requireCrawl).input(CrawlRunIdInputSchema).output(CrawlServiceAnswerSchema);

export const crawlRouter = router({
  status: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .output(CrawlStatusViewSchema)
    .query(({ ctx }) => ctx.crawl.status()),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .input(CrawlWatchInputSchema)
    .output(CrawlWatchViewSchema)
    // Pending polls are counted per sender window, so one window never evicts another's.
    .query(({ ctx, input }) => watchCrawl(ctx.crawl, input.sinceVersion, typeof ctx.sender?.windowId === 'number' ? ctx.sender.windowId : null)),
  start: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .input(CrawlStartInputSchema)
    .output(CrawlServiceAnswerSchema)
    .mutation(({ ctx, input }) => ctx.crawl.start(input)),
  pause: runProcedure.mutation(({ ctx, input }) => ctx.crawl.pause(input.runId)),
  resume: runProcedure.mutation(({ ctx, input }) => ctx.crawl.resume(input.runId)),
  cancel: runProcedure.mutation(({ ctx, input }) => ctx.crawl.cancel(input.runId)),
  delete: runProcedure.mutation(({ ctx, input }) => ctx.crawl.delete(input.runId)),
  pages: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .input(CrawlPagesInputSchema)
    .output(CrawlPagesAnswerSchema)
    .query(({ ctx, input }) => ctx.crawl.pages(input)),
  structure: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .input(CrawlStructureInputSchema)
    .output(CrawlStructureAnswerSchema)
    .query(({ ctx, input }) => ctx.crawl.structure(input)),
  exportCsv: publicProcedure
    .use(enforceSender)
    .use(requireCrawl)
    .input(CrawlCsvInputSchema)
    .output(CrawlCsvAnswerSchema)
    .mutation(({ ctx, input }) => ctx.crawl.exportCsv(typeof ctx.sender?.windowId === 'number' ? ctx.sender.windowId : null, input)),
});
