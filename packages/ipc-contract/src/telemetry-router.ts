import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  RENDERER_ERROR_RATE_LIMIT,
  RendererErrorInputSchema,
  RendererErrorResultSchema,
  SetConsentInputSchema,
  TelemetryStateSchema,
  type RendererErrorResult,
} from '@app/specs/telemetry-consent.schema';
import type { TelemetryService } from './telemetry-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Telemetry settings and renderer errors ↔ main (Phase 4 Task 7; spec `telemetry-consent.schema.ts`;
// acceptance `telemetry.feature.md`, Desktop, Router). Every procedure starts
// `publicProcedure.use(enforceSender)`; every output is validated with a strict schema, so an answer
// carrying anything else (the DSN, the endpoint) is a masked internal error, never forwarded.

/** Hands the procedure main's `TelemetryService` (after `enforceSender`; fails closed without it). */
const requireTelemetry = middleware(({ ctx, next }) => {
  const telemetry = ctx.services?.telemetry;
  if (!telemetry) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'telemetry service unavailable' });
  return next({ ctx: { ...ctx, telemetry } });
});

/** Each service's fixed window of renderer reports (a new service, a new run, starts afresh). */
const reportWindows = new WeakMap<TelemetryService, { start: number; count: number }>();

/** Whether one more renderer report may reach `telemetry` now (`RENDERER_ERROR_RATE_LIMIT`, over all windows). */
function admitReport(telemetry: TelemetryService, now: number): boolean {
  let window = reportWindows.get(telemetry);
  // A new window when the last one is over (or the clock went back).
  if (!window || now - window.start >= RENDERER_ERROR_RATE_LIMIT.windowMs || now < window.start) {
    window = { start: now, count: 0 };
    reportWindows.set(telemetry, window);
  }
  if (window.count >= RENDERER_ERROR_RATE_LIMIT.maxReports) return false;
  window.count += 1;
  return true;
}

/**
 * - `state`: `TelemetryState` (consent, whether each channel is configured as booleans, version).
 * - `setConsent` (`{ channel, on }`): the new `TelemetryState`, after main's telemetry and the consent
 *   file changed.
 * - `reportError` (`RendererErrorInput`): `reported`, `dropped` (`errors` off or not configured) or
 *   `rate-limited` (more than `RENDERER_ERROR_RATE_LIMIT.maxReports` within `windowMs`; the service is
 *   not called).
 */
export const telemetryRouter = router({
  state: publicProcedure
    .use(enforceSender)
    .use(requireTelemetry)
    .output(TelemetryStateSchema)
    .query(({ ctx }) => ctx.telemetry.state()),
  setConsent: publicProcedure
    .use(enforceSender)
    .use(requireTelemetry)
    .input(SetConsentInputSchema)
    .output(TelemetryStateSchema)
    .mutation(({ ctx, input }) => ctx.telemetry.setConsent(input.channel, input.on)),
  reportError: publicProcedure
    .use(enforceSender)
    .use(requireTelemetry)
    .input(RendererErrorInputSchema)
    .output(RendererErrorResultSchema)
    .mutation(({ ctx, input }): RendererErrorResult => (admitReport(ctx.telemetry, Date.now()) ? ctx.telemetry.reportError(input) : 'rate-limited')),
});
