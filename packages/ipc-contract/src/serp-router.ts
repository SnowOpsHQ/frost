import { TRPCError } from '@trpc/server';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { SerpClassifyInputSchema, SerpOutlinesInputSchema, SerpTabInputSchema, SerpWatchInputSchema, type SerpTabState } from '@app/specs/serp-service.schema';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import type { SerpService } from './serp-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The SERP overlay ↔ main (Phase 3 Task 4; spec `serp-service.schema.ts`; acceptance
// `serp-overlay.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.
// Task 5 adds the visibility probes (`visibility-probes.feature.md`, `serp-probes-procedures`):
// `runProbes`, `stopProbes`, `probes` and `watchProbes`, with the same strict tab inputs.

/** Hands the procedure main's `SerpService` (after `enforceSender`; fails closed without it). */
const requireSerp = middleware(({ ctx, next }) => {
  const serp = ctx.services?.serp;
  if (!serp) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'serp service unavailable' });
  return next({ ctx: { ...ctx, serp } });
});

/** The long-poll behind `serp.watch` (as `checks.watch`): the state at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchSerp(serp: SerpService, tabId: number, sinceVersion: number): Promise<SerpTabState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      serp.watch(tabId, sinceVersion, release.signal),
      new Promise<SerpTabState>((resolve) => {
        timer = setTimeout(() => resolve(serp.state(tabId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/** The long-poll behind `serp.watchProbes`, as `serp.watch`'s. */
async function watchProbes(serp: SerpService, tabId: number, sinceVersion: number): Promise<ProbesState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      serp.watchProbes(tabId, sinceVersion, release.signal),
      new Promise<ProbesState>((resolve) => {
        timer = setTimeout(() => resolve(serp.probes(tabId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `watch` and `state` answer the tab's `SerpTabState`; `setOutlines` whether its outlines are drawn
 * now; `packStatus` the pack in use, `checkPackUpdate` how the user's update check ended;
 * `intentState` where on-device intent stands, `enableIntent` how the user's "Enable" ended, and
 * `classify` a query's intent (local only); `runProbes` whether the tab's visibility probes run (the
 * only procedure here that fetches, and only on the user's action), `stopProbes` whether a run was
 * stopped, and `probes` / `watchProbes` the tab's `ProbesState`.
 */
export const serpRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpWatchInputSchema)
    .query(({ ctx, input }) => watchSerp(ctx.serp, input.tabId, input.sinceVersion)),
  state: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpTabInputSchema)
    .query(({ ctx, input }) => ctx.serp.state(input.tabId)),
  setOutlines: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpOutlinesInputSchema)
    .mutation(({ ctx, input }) => ctx.serp.setOutlines(input.tabId, input.on) === true),
  packStatus: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .query(({ ctx }) => ctx.serp.packStatus()),
  checkPackUpdate: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .mutation(({ ctx }) => ctx.serp.checkPackUpdate()),
  intentState: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .query(({ ctx }) => ctx.serp.intentState()),
  enableIntent: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .mutation(({ ctx }) => ctx.serp.enableIntent()),
  classify: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpClassifyInputSchema)
    .query(({ ctx, input }) => ctx.serp.classify(input.query)),
  runProbes: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpTabInputSchema)
    .mutation(({ ctx, input }) => ctx.serp.runProbes(input.tabId) === true),
  stopProbes: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpTabInputSchema)
    .mutation(({ ctx, input }) => ctx.serp.stopProbes(input.tabId) === true),
  probes: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpTabInputSchema)
    .query(({ ctx, input }) => ctx.serp.probes(input.tabId)),
  watchProbes: publicProcedure
    .use(enforceSender)
    .use(requireSerp)
    .input(SerpWatchInputSchema)
    .query(({ ctx, input }) => watchProbes(ctx.serp, input.tabId, input.sinceVersion)),
});
