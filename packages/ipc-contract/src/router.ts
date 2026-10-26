import { TRPCError } from '@trpc/server';
import {
  BrowserStateSchema,
  NavigateInputSchema,
  PageBoundsSchema,
  WATCH_TIMEOUT_MS,
  WatchInputSchema,
  type BrowserState,
} from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { BrowserService } from './services';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Every procedure starts `publicProcedure.use(enforceSender)` (spec `ipc-sender.feature.md`,
// `every-procedure-enforces-sender`; Semgrep `ipc-sender-guard` in Task 5).

/**
 * Hands the procedure main's `BrowserService` (from the IPC context). Chained after
 * `enforceSender`, so a rejected sender never reaches it; a context without the service fails
 * with a masked internal error.
 */
const requireBrowser = middleware(({ ctx, next }) => {
  const browser = ctx.services?.browser;
  if (!browser) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'browser service unavailable' });
  return next({ ctx: { ...ctx, browser } });
});

/**
 * The long-poll behind `browser.watch` (spec `WATCH_TIMEOUT_MS`): the current state at once if it
 * is newer than `sinceVersion`, else the state from the service's next change, or the current
 * state after `WATCH_TIMEOUT_MS`. Either way the timer is cleared and the service's waiter released.
 */
async function watchState(browser: BrowserService, sinceVersion: number): Promise<BrowserState> {
  const current = browser.getState();
  if (current.version > sinceVersion) return current;
  // A version from the future (a stale or forged poll) waits for the next change, not forever.
  const since = Math.min(sinceVersion, current.version);
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.watch(since, release.signal),
      new Promise<BrowserState>((resolve) => {
        timer = setTimeout(() => resolve(browser.getState()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * Browser chrome ↔ main (spec `browser-chrome.feature.md`, Router). `navigate` answers whether a
 * navigation started; the other mutations answer `null`.
 */
const browserRouter = router({
  navigate: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(NavigateInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.navigate(input.input) === true),
  back: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.back();
      return null;
    }),
  forward: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.forward();
      return null;
    }),
  reload: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.reload();
      return null;
    }),
  stop: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.stop();
      return null;
    }),
  setPageBounds: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(PageBoundsSchema)
    .mutation(({ ctx, input }) => {
      ctx.browser.setPageBounds(input);
      return null;
    }),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(WatchInputSchema)
    .output(BrowserStateSchema)
    .query(({ ctx, input }) => watchState(ctx.browser, input.sinceVersion)),
});

export const appRouter = router({
  ping: publicProcedure.use(enforceSender).query(() => 'pong' as const),
  browser: browserRouter,
});

export type AppRouter = typeof appRouter;
