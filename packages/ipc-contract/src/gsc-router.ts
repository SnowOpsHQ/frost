import { TRPCError } from '@trpc/server';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import {
  GscActionResultSchema,
  GscConnectResultSchema,
  GscCountriesAnswerSchema,
  GscPerformanceAnswerSchema,
  GscPerformanceQuerySchema,
  GscPropertiesAnswerSchema,
  GscQueriesAnswerSchema,
  GscStatusSchema,
  GscWatchInputSchema,
  type GscStatus,
} from '@app/specs/gsc.schema';
import { GscInspectInputSchema, GscInspectionAnswerSchema, GscOpenInspectionLinkInputSchema, GscOpenLinkResultSchema } from '@app/specs/gsc-inspection.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { GscIpcService } from './gsc-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Search Console ↔ main (Phase 4 Task 8; spec `gsc.schema.ts`; acceptance `gsc.feature.md`, Router).
// Every procedure starts `publicProcedure.use(enforceSender)`. Every output is validated with a strict
// schema, so a service answer that carries anything else (a token, a code) is a masked internal error,
// never forwarded. Search Console is not gated (`UNGATED_FEATURES`); a service that answers
// `{ status: 'unavailable', reason: 'not-entitled' }` (wire compatibility) is forwarded as is, never `FORBIDDEN`.

/** Hands the procedure main's `GscIpcService` (after `enforceSender`; fails closed without it). */
const requireGsc = middleware(({ ctx, next }) => {
  const gsc = ctx.services?.gsc;
  if (!gsc) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'gsc service unavailable' });
  return next({ ctx: { ...ctx, gsc } });
});

/** The long-poll behind `gsc.watch` (as `account.watch`): the status at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchGsc(gsc: GscIpcService, sinceVersion: number): Promise<GscStatus> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      gsc.watch(sinceVersion, release.signal),
      new Promise<GscStatus>((resolve) => {
        timer = setTimeout(() => resolve(gsc.status()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * - `status` / `watch`: the connection (`GscStatusSchema`; `watch` long-polls on `sinceVersion`).
 * - `connect`: starts connecting a Google account for the sender's window (`GscConnectResult`;
 *   `needs-gesture` without a live user gesture there).
 * - `cancelConnect`, `disconnect`: a boolean (see `GscIpcService`).
 * - `properties`: the verified properties; `performance` / `topQueries` / `countries`
 *   (`GscPerformanceQuerySchema`: exactly one of `days` and `range`, optional `country` / `device`):
 *   a page's or its property's performance, top queries and countries with data. Each `ok` or
 *   `unavailable` with a reason.
 * - `inspect` (`GscInspectInputSchema`): Google's URL Inspection of a page (`GscInspectionAnswerSchema`).
 *   A mutation: it spends Google's per-site quota, and runs only when the user asks.
 * - `openInspectionLink` (`GscOpenInspectionLinkInputSchema`: the page, never the link): opens main's
 *   own cached Search Console link for that page on a live gesture in the sender's window
 *   (`GscOpenLinkResult`).
 */
export const gscRouter = router({
  status: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .output(GscStatusSchema)
    .query(({ ctx }) => ctx.gsc.status()),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscWatchInputSchema)
    .output(GscStatusSchema)
    .query(({ ctx, input }) => watchGsc(ctx.gsc, input.sinceVersion)),
  connect: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .output(GscConnectResultSchema)
    .mutation(({ ctx }) => {
      // `enforceSender` admitted only a known app window, so there is a window ID.
      const windowId = ctx.sender?.windowId;
      if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
      return ctx.gsc.connect(windowId);
    }),
  cancelConnect: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .output(GscActionResultSchema)
    .mutation(({ ctx }) => ctx.gsc.cancelConnect()),
  disconnect: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .output(GscActionResultSchema)
    .mutation(({ ctx }) => ctx.gsc.disconnect()),
  properties: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .output(GscPropertiesAnswerSchema)
    .query(({ ctx }) => ctx.gsc.properties()),
  performance: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscPerformanceQuerySchema)
    .output(GscPerformanceAnswerSchema)
    .query(({ ctx, input }) => ctx.gsc.performance(input)),
  topQueries: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscPerformanceQuerySchema)
    .output(GscQueriesAnswerSchema)
    .query(({ ctx, input }) => ctx.gsc.topQueries(input)),
  countries: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscPerformanceQuerySchema)
    .output(GscCountriesAnswerSchema)
    .query(({ ctx, input }) => ctx.gsc.countries(input)),
  inspect: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscInspectInputSchema)
    .output(GscInspectionAnswerSchema)
    .mutation(({ ctx, input }) => ctx.gsc.inspect(input)),
  openInspectionLink: publicProcedure
    .use(enforceSender)
    .use(requireGsc)
    .input(GscOpenInspectionLinkInputSchema)
    .output(GscOpenLinkResultSchema)
    .mutation(({ ctx, input }) => {
      // `enforceSender` admitted only a known app window, so there is a window ID (as `connect`).
      const windowId = ctx.sender?.windowId;
      if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
      return ctx.gsc.openInspectionLink(windowId, input.url);
    }),
});
