import { TRPCError } from '@trpc/server';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { UpdateChecks, UpdateState } from '@app/specs/update-client.spec';
import { UpdateNoInputSchema, UpdateSetChecksInputSchema, UpdateWatchInputSchema } from '@app/specs/update-router.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The update notice and setting ↔ main (Phase 7 Task 5; spec `update-router.schema.ts`,
// `update-client.spec.ts`; acceptance `update-client.feature.md`, Router). Every procedure starts
// `publicProcedure.use(enforceSender)`. Nothing past "check" happens without one of these calls, each
// a user action in the chrome: `download` (consent to fetch), `install` (reveal the verified file).

/** The update client as the `update.*` procedures see it. Main implements it (`apps/desktop/src/main/update/service.ts`). */
export interface UpdateService {
  /** The chrome-facing state (no path: the verified file's path stays in main). */
  state(): UpdateState;
  /** Resolves once the state's version exceeds `sinceVersion` (at once if it does), or when `signal` aborts. */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<UpdateState>;
  /** "Check for Updates" (a user action, so it checks with automatic checks off); the state after. */
  check(): Promise<UpdateState>;
  /** Starts downloading the offer (only from `available`); the state once it has started. */
  download(): Promise<UpdateState>;
  /** "Skip this version" (never for a required update); the state after. */
  skip(): Promise<UpdateState>;
  /** Turns automatic checks on or off (saved); the state after. */
  setChecks(checks: UpdateChecks): Promise<UpdateState>;
  /**
   * "Show file": on `ready` with `install: 'manual'`, reveals the verified file in the system file
   * manager (`shell.showItemInFolder`, never `openExternal`, never running it). Whether it did.
   */
  install(): Promise<boolean>;
}

/** Hands the procedure main's `UpdateService` (after `enforceSender`; fails closed without it). */
const requireUpdate = middleware(({ ctx, next }) => {
  const update = ctx.services?.update;
  if (!update) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'update service unavailable' });
  return next({ ctx: { ...ctx, update } });
});

/** The long-poll behind `update.watch` (as `checks.watch`): the state at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchUpdate(update: UpdateService, sinceVersion: number): Promise<UpdateState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      update.watch(sinceVersion, release.signal),
      new Promise<UpdateState>((resolve) => {
        timer = setTimeout(() => resolve(update.state()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `watch` answers `UpdateState` once it changes after `sinceVersion`; `check`, `download`, `skip` and
 * `setChecks` the state after their step; `install` whether the verified file was shown.
 */
export const updateRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateWatchInputSchema)
    .query(({ ctx, input }) => watchUpdate(ctx.update, input.sinceVersion)),
  check: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateNoInputSchema)
    .mutation(({ ctx }) => ctx.update.check()),
  download: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateNoInputSchema)
    .mutation(({ ctx }) => ctx.update.download()),
  skip: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateNoInputSchema)
    .mutation(({ ctx }) => ctx.update.skip()),
  setChecks: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateSetChecksInputSchema)
    .mutation(({ ctx, input }) => ctx.update.setChecks(input.checks)),
  install: publicProcedure
    .use(enforceSender)
    .use(requireUpdate)
    .input(UpdateNoInputSchema)
    .mutation(async ({ ctx }) => (await ctx.update.install()) === true),
});
