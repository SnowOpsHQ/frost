import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { SetTabOverridesInputSchema } from '@app/specs/render-profile.schema.spec';
import type { TabOverrides } from '@app/specs/render-profile.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Tab overrides ↔ main (Phase 11 Task 6, Decision 8; spec `render-profile.schema.spec.ts`; acceptance
// `render-profile.feature.md`, Tab overrides: Procedure). Every procedure starts
// `publicProcedure.use(enforceSender)`.

/** Main's tab overrides (the browser controller's): CSS off, cookies off and geolocation for one tab. */
export interface TabOverridesService {
  /** Sets the tab's overrides (all off: back to normal); `false` for an id that names no open tab. */
  set(tabId: number, overrides: TabOverrides): boolean;
}

/** Hands the procedure main's `TabOverridesService` (after `enforceSender`; fails closed without it). */
const requireTabOverrides = middleware(({ ctx, next }) => {
  const tabOverrides = ctx.services?.tabOverrides;
  if (!tabOverrides) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'tab overrides service unavailable' });
  return next({ ctx: { ...ctx, tabOverrides } });
});

/** `set` answers whether the tab's overrides were set. */
export const tabOverridesRouter = router({
  set: publicProcedure
    .use(enforceSender)
    .use(requireTabOverrides)
    .input(SetTabOverridesInputSchema)
    .mutation(({ ctx, input }) => ctx.tabOverrides.set(input.tabId, input.overrides) === true),
});
