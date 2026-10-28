import { TRPCError } from '@trpc/server';
import { CaptureInputSchema, DiffInputSchema, HistoryInputSchema, PagesInputSchema, VersionInputSchema } from '@app/specs/changes.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The Changes panel ↔ main (Phase 6 Task 3; spec `changes.schema.ts`; acceptance
// `changes-capture.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.

/** Hands the procedure main's `ChangesService` (after `enforceSender`; fails closed without it). */
const requireChanges = middleware(({ ctx, next }) => {
  const changes = ctx.services?.changes;
  if (!changes) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'changes service unavailable' });
  return next({ ctx: { ...ctx, changes } });
});

/**
 * `capture` answers `CaptureAnswer` (captured, or refused with a reason); `history` the page's
 * versions newest first; `version` one version's snapshot (`null`: none); `diff` two versions' diff
 * (`null`: different lanes or unreadable); `pages` the captured pages.
 */
export const changesRouter = router({
  capture: publicProcedure
    .use(enforceSender)
    .use(requireChanges)
    .input(CaptureInputSchema)
    .mutation(({ ctx, input }) => ctx.changes.capture(input.tabId, input.projectId === undefined ? {} : { projectId: input.projectId })),
  history: publicProcedure
    .use(enforceSender)
    .use(requireChanges)
    .input(HistoryInputSchema)
    .query(({ ctx, input }) => ctx.changes.history(input)),
  version: publicProcedure
    .use(enforceSender)
    .use(requireChanges)
    .input(VersionInputSchema)
    .query(({ ctx, input }) => ctx.changes.version(input)),
  diff: publicProcedure
    .use(enforceSender)
    .use(requireChanges)
    .input(DiffInputSchema)
    .query(({ ctx, input }) => ctx.changes.diff(input)),
  pages: publicProcedure
    .use(enforceSender)
    .use(requireChanges)
    .input(PagesInputSchema)
    .query(({ ctx, input }) => ctx.changes.pages(input)),
});
