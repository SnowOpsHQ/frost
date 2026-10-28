import type { RendererErrorInput, RendererErrorResult, TelemetryState } from '@app/specs/telemetry-consent.schema';
import type { TelemetryChannel } from '@app/specs/telemetry-privacy.spec';

// Telemetry as the `telemetry.*` procedures see it (Phase 4 Task 7; spec `telemetry-consent.schema.ts`;
// acceptance `telemetry.feature.md`, Desktop). Main implements it (`apps/desktop/src/main/telemetry/
// install.ts`); this package only knows the interface. No member answers the build's DSN or endpoint:
// `configured` says only whether each exists.

export interface TelemetryService {
  /** Consent per channel, whether this build has each endpoint, and the state's version (`TelemetryStateSchema`). */
  state(): TelemetryState;
  /**
   * Turns `channel` on or off and answers the new state. Synchronous: main's telemetry has changed
   * (off: its queue dropped, its request in flight aborted) and the consent file is written when it
   * returns. Turning on needs a live user gesture in window `windowId` (the IPC sender's; `null`
   * without one): without it nothing changes and the state is answered as it was. Off never needs one.
   */
  setConsent(channel: TelemetryChannel, on: boolean, windowId: number | null): TelemetryState;
  /**
   * Hands an error the chrome did not handle to the `errors` channel (which scrubs it): `reported`,
   * or `dropped` when `errors` is off or not configured. The router rate-limits before calling it.
   */
  reportError(input: RendererErrorInput): RendererErrorResult;
}
