// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { TelemetryState } from '@app/specs/telemetry-consent.schema';
import type { TelemetryChannel } from '@app/specs/telemetry-privacy.spec';
import { TELEMETRY_SETTINGS_TEXT } from '@app/specs/account-settings.spec';

// The Settings view's Telemetry section as a view model (Phase 4 Task 9; acceptance
// `account-settings.feature.md`, Telemetry; review focus "Telemetry UI matches behaviour"). Pure: a
// toggle is on exactly when main's `consent` says so; before main's first answer none is shown on.

export interface TelemetryToggleView {
  readonly channel: TelemetryChannel;
  readonly label: string;
  /** What is sent, in plain words. */
  readonly sends: string;
  /** What is never sent. */
  readonly never: string;
  /** Main's consent now (`false` before main answered). */
  readonly on: boolean;
  /** "This build has no endpoint …" when the build cannot send this channel, else `null`. */
  readonly note: string | null;
}

export interface TelemetrySection {
  readonly intro: string;
  readonly toggles: readonly TelemetryToggleView[];
  /** "Saved for this run only" when main could not save the choice, else `null`. */
  readonly runOnly: string | null;
  /** Whether main has answered (the toggles are disabled until then). */
  readonly ready: boolean;
}

/** The channels in order, with what each sends and never sends (`SPAN_ATTRIBUTE_ALLOWLIST`, the package's scrubbing). */
export const TELEMETRY_CHANNEL_TEXT: readonly { readonly channel: TelemetryChannel; readonly label: string; readonly sends: string; readonly never: string }[] = Object.freeze([
  {
    channel: 'usage',
    label: 'Usage and performance',
    sends: "How long frost's own operations take and whether they worked (such as starting up), with frost's version and your operating system.",
    never: 'Never URLs, page content, search terms, or anything that identifies you or this computer.',
  },
  {
    channel: 'errors',
    label: 'Crash and error reports',
    sends: "When something in frost fails unexpectedly: the error's type, message and where in frost's code it happened, with frost's version and your operating system.",
    never: 'URLs, email addresses, file paths and tokens are removed first; never page content or identifiers.',
  },
]);

/** The Telemetry section for `state` (`null`: main has not answered yet). */
export function telemetrySection(state: TelemetryState | null): TelemetrySection {
  return {
    intro: TELEMETRY_SETTINGS_TEXT.intro,
    toggles: TELEMETRY_CHANNEL_TEXT.map((text) => ({
      ...text,
      on: state?.consent[text.channel] === true,
      note: state !== null && !state.configured[text.channel] ? TELEMETRY_SETTINGS_TEXT.notConfigured : null,
    })),
    runOnly: state !== null && !state.persisted ? TELEMETRY_SETTINGS_TEXT.runOnly : null,
    ready: state !== null,
  };
}
