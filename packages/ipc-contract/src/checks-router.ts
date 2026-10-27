import { TRPCError } from '@trpc/server';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { ChecksStopInputSchema, ChecksTabInputSchema, ChecksWatchInputSchema } from '@app/specs/seo-checks.schema';
import type { ChecksState } from '@app/specs/seo-checks.spec';
import type { ChecksService } from './checks-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The link, sitemap and hreflang checks ↔ main (Phase 2.5 Task 7; spec `seo-checks.schema.ts`;
// acceptance `seo-checks.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.

/** Hands the procedure main's `ChecksService` (after `enforceSender`; fails closed without it). */
const requireChecks = middleware(({ ctx, next }) => {
  const checks = ctx.services?.checks;
  if (!checks) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'checks service unavailable' });
  return next({ ctx: { ...ctx, checks } });
});

/** The long-poll behind `checks.watch` (as `browser.watch`): the state at once if newer, else at the next push, else after `WATCH_TIMEOUT_MS`. */
async function watchChecks(checks: ChecksService, tabId: number, sinceVersion: number): Promise<ChecksState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      checks.watch(tabId, sinceVersion, release.signal),
      new Promise<ChecksState>((resolve) => {
        timer = setTimeout(() => resolve(checks.state(tabId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `watch` answers the tab's checks (`ChecksState`) once they change after `sinceVersion`;
 * `checkLinks`, `checkSitemaps` and `checkHreflang` whether that check runs now; `stop` whether one
 * was stopped.
 */
export const checksRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireChecks)
    .input(ChecksWatchInputSchema)
    .query(({ ctx, input }) => watchChecks(ctx.checks, input.tabId, input.sinceVersion)),
  checkLinks: publicProcedure
    .use(enforceSender)
    .use(requireChecks)
    .input(ChecksTabInputSchema)
    .mutation(({ ctx, input }) => ctx.checks.checkLinks(input.tabId) === true),
  checkSitemaps: publicProcedure
    .use(enforceSender)
    .use(requireChecks)
    .input(ChecksTabInputSchema)
    .mutation(({ ctx, input }) => ctx.checks.checkSitemaps(input.tabId) === true),
  checkHreflang: publicProcedure
    .use(enforceSender)
    .use(requireChecks)
    .input(ChecksTabInputSchema)
    .mutation(({ ctx, input }) => ctx.checks.checkHreflang(input.tabId) === true),
  stop: publicProcedure
    .use(enforceSender)
    .use(requireChecks)
    .input(ChecksStopInputSchema)
    .mutation(({ ctx, input }) => ctx.checks.stop(input.tabId, input.check) === true),
});
