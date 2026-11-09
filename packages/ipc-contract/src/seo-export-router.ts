import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { SeoExportInputSchema } from '@app/specs/seo-exports.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// SEO table exports ↔ main (Phase 11 Task 1, Decision 1; spec `seo-exports.schema.ts`; acceptance
// `seo-exports.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.

/** Hands the procedure main's `SeoExportService` (after `enforceSender`; fails closed without it). */
const requireSeoExport = middleware(({ ctx, next }) => {
  const seoExport = ctx.services?.seoExport;
  if (!seoExport) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'seo export service unavailable' });
  return next({ ctx: { ...ctx, seoExport } });
});

/**
 * `copyCsv` answers how many rows main wrote to its own clipboard (a non-negative integer), or
 * `null` when it wrote nothing (not the shown ready audit, no speed report). The chrome sends no text.
 */
export const seoExportRouter = router({
  copyCsv: publicProcedure
    .use(enforceSender)
    .use(requireSeoExport)
    .input(SeoExportInputSchema)
    .mutation(({ ctx, input }) => {
      const rows = ctx.seoExport.copyCsv(input.tabId, input.audit, input.kind, input.filter);
      return typeof rows === 'number' && Number.isInteger(rows) && rows >= 0 ? rows : null;
    }),
});
