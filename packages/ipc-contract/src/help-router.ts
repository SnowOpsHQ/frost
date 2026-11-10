import { TRPCError } from '@trpc/server';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  DiagnosticsInputSchema,
  DiagnosticsReportSchema,
  DiagnosticsResultSchema,
  HelpOpenLinkInputSchema,
  HelpOpenResultSchema,
  HelpViewStateSchema,
  HelpWatchInputSchema,
  SaveDiagnosticsInputSchema,
  WhatsNewAnswerSchema,
  WhatsNewTakeAnswerSchema,
  type HelpViewState,
} from '@app/specs/whats-new.schema';
import type { HelpService } from './help-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Help ↔ main (Phase 11 Task 11, Decision 14; spec `whats-new.schema.ts`; acceptance `help.feature.md`,
// Router). Every procedure starts `publicProcedure.use(enforceSender)`, takes a strict input and
// answers through a strict output schema. The chrome never sends a URL: `openLink` names a Help page
// or a bundled release by its version, and main opens only on a live gesture in the sender's window.

/** Hands the procedure main's `HelpService` (after `enforceSender`; fails closed without it). */
const requireHelp = middleware(({ ctx, next }) => {
  const help = ctx.services?.help;
  if (!help) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'help service unavailable' });
  return next({ ctx: { ...ctx, help } });
});

/** The sender's window (`enforceSender` admitted only a known app window, so there is one). */
function senderWindow(windowId: number | null | undefined): number {
  if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
  return windowId;
}

/** The long-poll behind `help.watch`: the state at once if newer, else at the next request, else after `WATCH_TIMEOUT_MS`. */
async function watchHelp(help: HelpService, windowId: number, sinceSeq: number): Promise<HelpViewState> {
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      help.watch(windowId, sinceSeq, release.signal),
      new Promise<HelpViewState>((resolve) => {
        timer = setTimeout(() => resolve(help.state(windowId)), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * - `watch`: the sender window's Help menu requests (`HelpViewStateSchema`, long-polled on `sinceSeq`).
 * - `whatsNew`: the running version and the bundled notes; `takeWhatsNew`: whether to show them now.
 * - `openLink`: `help`, `issue` or a release's page by version (`HelpOpenResultSchema`).
 * - `diagnostics` (Task 12): a fresh scrubbed report and the id main keeps it under, for review
 *   (`DiagnosticsReportSchema`: bounded, no slash, backslash or at sign).
 * - `saveDiagnostics` (Task 12): the kept report by id (never text) through main's save dialog in the
 *   sender's window (`DiagnosticsResultSchema`).
 */
export const helpRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .input(HelpWatchInputSchema)
    .output(HelpViewStateSchema)
    .query(({ ctx, input }) => watchHelp(ctx.help, senderWindow(ctx.sender?.windowId), input.sinceSeq)),
  whatsNew: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .output(WhatsNewAnswerSchema)
    .query(({ ctx }) => ctx.help.whatsNew()),
  takeWhatsNew: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .output(WhatsNewTakeAnswerSchema)
    .mutation(({ ctx }) => ctx.help.takeWhatsNew()),
  openLink: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .input(HelpOpenLinkInputSchema)
    .output(HelpOpenResultSchema)
    .mutation(({ ctx, input }) => ctx.help.openLink(senderWindow(ctx.sender?.windowId), input)),
  diagnostics: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .input(DiagnosticsInputSchema)
    .output(DiagnosticsReportSchema)
    .mutation(({ ctx }) => ctx.help.diagnostics()),
  saveDiagnostics: publicProcedure
    .use(enforceSender)
    .use(requireHelp)
    .input(SaveDiagnosticsInputSchema)
    .output(DiagnosticsResultSchema)
    .mutation(({ ctx, input }) => ctx.help.saveDiagnostics(senderWindow(ctx.sender?.windowId), input)),
});
