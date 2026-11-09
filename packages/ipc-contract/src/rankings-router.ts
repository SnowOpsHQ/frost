import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  CompareAnswerSchema,
  CompareInputSchema,
  CopyCsvAnswerSchema,
  RankCsvInputSchema,
  RankSeriesInputSchema,
  RankSeriesSchema,
  RankTableInputSchema,
  RankTableSchema,
  ReadingDatesInputSchema,
  ReadingDatesSchema,
  SaveCsvAnswerSchema,
} from '@app/specs/rankings.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Rankings ↔ main (Phase 10 Task 5; spec `rankings.schema.ts`; acceptance `rankings.feature.md`,
// Router and Export). Every procedure starts `publicProcedure.use(enforceSender)`, then
// `requireRankings` (which fails closed without the service), takes a strict input (never a path or
// a file name) and answers through a strict schema, so an answer carrying anything more is a masked
// internal error, never forwarded. Save CSV parents main's save dialog to the sender's window.

/** Hands the procedure main's `RankingsService` (after `enforceSender`; fails closed without it). */
const requireRankings = middleware(({ ctx, next }) => {
  const rankings = ctx.services?.rankings;
  if (!rankings) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'rankings service unavailable' });
  return next({ ctx: { ...ctx, rankings } });
});

export const rankingsRouter = router({
  table: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(RankTableInputSchema)
    .output(RankTableSchema)
    .query(({ ctx, input }) => ctx.rankings.table(input.projectId, input.range, input.tag ?? null)),
  series: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(RankSeriesInputSchema)
    .output(RankSeriesSchema)
    .query(({ ctx, input }) => ctx.rankings.series(input.projectId, input.searchKey, input.range)),
  readingDates: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(ReadingDatesInputSchema)
    .output(ReadingDatesSchema)
    .query(({ ctx, input }) => ctx.rankings.readingDates(input.projectId, input.searchKey)),
  compare: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(CompareInputSchema)
    .output(CompareAnswerSchema)
    .query(({ ctx, input }) => ctx.rankings.compare(input.projectId, input.a, input.b)),
  copyCsv: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(RankCsvInputSchema)
    .output(CopyCsvAnswerSchema)
    .mutation(({ ctx, input }) => ctx.rankings.copyCsv(input.projectId, input.kind, input.range, input.tag ?? null)),
  saveCsv: publicProcedure
    .use(enforceSender)
    .use(requireRankings)
    .input(RankCsvInputSchema)
    .output(SaveCsvAnswerSchema)
    .mutation(({ ctx, input }) => ctx.rankings.saveCsv(typeof ctx.sender?.windowId === 'number' ? ctx.sender.windowId : null, input.projectId, input.kind, input.range, input.tag ?? null)),
});
