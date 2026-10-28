import { TRPCError } from '@trpc/server';
import { SettingsViewStateSchema, SettingsViewWatchInputSchema, type SettingsViewState } from '@app/specs/account-settings.schema';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The Settings view's open requests from main (Phase 4 Task 9; spec `account-settings.schema.ts`;
// acceptance `account-settings.feature.md`, Router). The menu's "Settings…" (Mod+,) is main's; main
// raises a counter and the chrome long-polls it here. Every procedure starts
// `publicProcedure.use(enforceSender)`; the output is validated with a strict schema.

/** Main's Settings-view requests as the procedure sees them. */
export interface SettingsViewService {
  /** The current count of open requests. */
  state(): SettingsViewState;
  /**
   * Resolves with the state once `seq` exceeds `sinceSeq` (at once if it already does), or when
   * `signal` aborts. At most `MAX_PENDING_SETTINGS_WATCHES` wait; one more answers the oldest early.
   */
  watch(sinceSeq: number, signal?: AbortSignal): Promise<SettingsViewState>;
}

const requireSettingsView = middleware(({ ctx, next }) => {
  const settingsView = ctx.services?.settingsView;
  if (!settingsView) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'settings view service unavailable' });
  return next({ ctx: { ...ctx, settingsView } });
});

/** The long-poll (as `account.watch`): the state at once if newer, else at the next change, else after `WATCH_TIMEOUT_MS`. */
async function watchSettingsView(service: SettingsViewService, sinceSeq: number): Promise<SettingsViewState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      service.watch(sinceSeq, release.signal),
      new Promise<SettingsViewState>((resolve) => {
        timer = setTimeout(() => resolve(service.state()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

export const settingsViewRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireSettingsView)
    .input(SettingsViewWatchInputSchema)
    .output(SettingsViewStateSchema)
    .query(({ ctx, input }) => watchSettingsView(ctx.settingsView, input.sinceSeq)),
});
