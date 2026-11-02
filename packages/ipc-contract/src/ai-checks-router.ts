import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { AiChecksCheckNowInputSchema, AiChecksModeSchema, AiChecksSetModeInputSchema, AiChecksStateSchema, AiChecksTabInputSchema, AiChecksWatchInputSchema, type AiChecksState } from '@app/specs/ai-checks.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { AiChecksService } from './ai-checks-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The AI checks ↔ main (Phase 9 Task 10; spec `ai-checks.schema.ts`; acceptance
// `ai-checks.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`, takes
// a strict input and answers through a strict output schema, so a service answer carrying anything
// more (a key, a token) is a masked internal error, never forwarded. The renderer can't turn checks
// on by itself: `setMode` leaves `off` only through main's own consent dialog.

/** Hands the procedure main's `AiChecksService` (after `enforceSender`; fails closed without it). */
const requireAiChecks = middleware(({ ctx, next }) => {
  const aiChecks = ctx.services?.aiChecks;
  if (!aiChecks) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'ai checks service unavailable' });
  return next({ ctx: { ...ctx, aiChecks } });
});

/** The long-poll behind `aiChecks.watch` (as `checks.watch`): the state at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchAiChecks(aiChecks: AiChecksService, tabId: number, sinceVersion: number): Promise<AiChecksState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      aiChecks.watch(tabId, sinceVersion, release.signal),
      new Promise<AiChecksState>((resolve) => {
        timer = setTimeout(() => resolve(aiChecks.state(tabId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `state` / `watch`: the tab's `AiChecksState` (`watch` long-polls on `sinceVersion`); `setMode`: the
 * mode in effect afterwards; `checkNow`: whether a check runs or waits for its turn now.
 */
export const aiChecksRouter = router({
  state: publicProcedure
    .use(enforceSender)
    .use(requireAiChecks)
    .input(AiChecksTabInputSchema)
    .output(AiChecksStateSchema)
    .query(({ ctx, input }) => ctx.aiChecks.state(input.tabId)),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireAiChecks)
    .input(AiChecksWatchInputSchema)
    .output(AiChecksStateSchema)
    .query(({ ctx, input }) => watchAiChecks(ctx.aiChecks, input.tabId, input.sinceVersion)),
  setMode: publicProcedure
    .use(enforceSender)
    .use(requireAiChecks)
    .input(AiChecksSetModeInputSchema)
    .output(AiChecksModeSchema)
    .mutation(({ ctx, input }) => ctx.aiChecks.setMode(input.mode)),
  checkNow: publicProcedure
    .use(enforceSender)
    .use(requireAiChecks)
    .input(AiChecksCheckNowInputSchema)
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => (await ctx.aiChecks.checkNow(input.tabId, input.again === true)) === true),
});
