import { TRPCError } from '@trpc/server';
import { FindCloseInputSchema, FindSearchInputSchema, FindStepInputSchema, HistoryListInputSchema, HistoryRemoveInputSchema, SetSearchEngineInputSchema } from '@app/specs/browser-polish.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Browser polish ↔ main (Phase 2.5 Task 6; spec `browser-polish.schema.ts`; acceptance
// `browser-polish.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`;
// a context without the service fails closed with a masked internal error.

const requireFind = middleware(({ ctx, next }) => {
  const find = ctx.services?.find;
  if (!find) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'find service unavailable' });
  return next({ ctx: { ...ctx, find } });
});

const requireHistory = middleware(({ ctx, next }) => {
  const history = ctx.services?.history;
  if (!history) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'history service unavailable' });
  return next({ ctx: { ...ctx, history } });
});

const requireSettings = middleware(({ ctx, next }) => {
  const settings = ctx.services?.settings;
  if (!settings) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'settings service unavailable' });
  return next({ ctx: { ...ctx, settings } });
});

/** Find in page: `open` answers `null`; `search` / `step` / `close` whether the tab had an open bar. */
export const findRouter = router({
  open: publicProcedure
    .use(enforceSender)
    .use(requireFind)
    .mutation(({ ctx }) => {
      ctx.find.open();
      return null;
    }),
  search: publicProcedure
    .use(enforceSender)
    .use(requireFind)
    .input(FindSearchInputSchema)
    .mutation(({ ctx, input }) => ctx.find.search(input.tabId, input.text, input.matchCase) === true),
  step: publicProcedure
    .use(enforceSender)
    .use(requireFind)
    .input(FindStepInputSchema)
    .mutation(({ ctx, input }) => ctx.find.step(input.tabId, input.forward) === true),
  close: publicProcedure
    .use(enforceSender)
    .use(requireFind)
    .input(FindCloseInputSchema)
    .mutation(({ ctx, input }) => ctx.find.close(input.tabId) === true),
});

/**
 * The History view, the new-tab page and Reopen Closed Tab: `list` a page of visits, `jumpBackIn` the
 * tiles, `remove` / `clearAll` whether they deleted, `reopenClosedTab` the reopened tab's id (`null`:
 * none), `show` `null`.
 */
export const historyRouter = router({
  list: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .input(HistoryListInputSchema)
    .query(({ ctx, input }) => ctx.history.list(input.query, input.after, input.limit)),
  jumpBackIn: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .query(({ ctx }) => ctx.history.jumpBackIn()),
  remove: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .input(HistoryRemoveInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.history.remove(input.url)) === true),
  clearAll: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .mutation(async ({ ctx }) => (await ctx.history.clearAll()) === true),
  reopenClosedTab: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .mutation(({ ctx }) => {
      const id = ctx.history.reopenClosedTab();
      return typeof id === 'number' ? id : null;
    }),
  show: publicProcedure
    .use(enforceSender)
    .use(requireHistory)
    .mutation(({ ctx }) => {
      ctx.history.show();
      return null;
    }),
});

/** Local preferences: the search engine (`searchEngine` its id, `setSearchEngine` whether it was stored). */
export const settingsRouter = router({
  searchEngine: publicProcedure
    .use(enforceSender)
    .use(requireSettings)
    .query(({ ctx }) => ctx.settings.searchEngine()),
  setSearchEngine: publicProcedure
    .use(enforceSender)
    .use(requireSettings)
    .input(SetSearchEngineInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.settings.setSearchEngine(input.engine)) === true),
});
