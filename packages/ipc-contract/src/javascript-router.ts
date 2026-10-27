import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { RefetchServedInputSchema } from '@app/specs/seo-javascript.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The JavaScript panel ↔ main (Phase 2.5 Task 2; spec `seo-javascript.schema.ts`; acceptance
// `seo-javascript.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.

/** Main's served-HTML service as the `javascript.*` procedures see it. */
export interface JavascriptService {
  /**
   * "Fetch again": forgets the tab's served HTML for its current URL and audits it again (only the
   * active tab showing a web page); `false` (a no-op) otherwise.
   */
  refetchServed(tabId: number): boolean;
}

/** Hands the procedure main's `JavascriptService` (after `enforceSender`; fails closed without it). */
const requireJavascript = middleware(({ ctx, next }) => {
  const javascript = ctx.services?.javascript;
  if (!javascript) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'javascript service unavailable' });
  return next({ ctx: { ...ctx, javascript } });
});

/** `refetchServed` answers whether a fresh fetch and audit started. */
export const javascriptRouter = router({
  refetchServed: publicProcedure
    .use(enforceSender)
    .use(requireJavascript)
    .input(RefetchServedInputSchema)
    .mutation(({ ctx, input }) => ctx.javascript.refetchServed(input.tabId) === true),
});
