import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { DEVTOOLS_WATCH_TIMEOUT_MS } from '@app/specs/devtools.spec';
import { DevtoolsPreserveInputSchema, DevtoolsSetOpenInputSchema, DevtoolsTabInputSchema, DevtoolsWatchInputSchema, RevealCookieInputSchema } from '@app/specs/devtools.schema';
import type { DevtoolsService } from './devtools-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The SEO devtools drawer ↔ main (Phase 2.5 Task 5; spec `devtools.schema.ts`; acceptance
// `devtools.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`; the
// drawer is read-only but for `clearSiteData`, which main confirms in its own dialog.

/** Hands the procedure main's `DevtoolsService` (after `enforceSender`; fails closed without it). */
const requireDevtools = middleware(({ ctx, next }) => {
  const devtools = ctx.services?.devtools;
  if (!devtools) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'devtools service unavailable' });
  return next({ ctx: { ...ctx, devtools } });
});

/** The long-poll behind `devtools.watch`: the next version, or the current one after `DEVTOOLS_WATCH_TIMEOUT_MS`. */
async function watchVersion(devtools: DevtoolsService, tabId: number, sinceVersion: number): Promise<number> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      devtools.watch(tabId, sinceVersion, release.signal),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(devtools.version(tabId)), DEVTOOLS_WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `watch` answers the tab's devtools version; `network`, `redirects`, `console` and `storage` its
 * data (masked); `revealCookie` whether that cookie is now shown; `clearSiteData` what happened
 * (`CLEAR_SITE_DATA_RESULTS`); `setOpen` and `setPreserveLog` `null` / whether the tab exists.
 */
export const devtoolsRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsWatchInputSchema)
    .query(({ ctx, input }) => watchVersion(ctx.devtools, input.tabId, input.sinceVersion)),
  network: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsTabInputSchema)
    .query(({ ctx, input }) => ctx.devtools.network(input.tabId)),
  redirects: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsTabInputSchema)
    .query(({ ctx, input }) => ctx.devtools.redirects(input.tabId)),
  console: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsTabInputSchema)
    .query(({ ctx, input }) => ctx.devtools.console(input.tabId)),
  storage: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsTabInputSchema)
    .query(({ ctx, input }) => ctx.devtools.storage(input.tabId)),
  revealCookie: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(RevealCookieInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.devtools.revealCookie(input.tabId, { name: input.name, domain: input.domain, path: input.path })) === true),
  clearSiteData: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsTabInputSchema)
    .mutation(({ ctx, input }) => ctx.devtools.clearSiteData(input.tabId)),
  setOpen: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsSetOpenInputSchema)
    .mutation(({ ctx, input }) => {
      ctx.devtools.setOpen(ctx.sender?.windowId ?? null, input.open);
      return null;
    }),
  setPreserveLog: publicProcedure
    .use(enforceSender)
    .use(requireDevtools)
    .input(DevtoolsPreserveInputSchema)
    .mutation(({ ctx, input }) => ctx.devtools.setPreserveLog(input.tabId, input.preserve) === true),
});
