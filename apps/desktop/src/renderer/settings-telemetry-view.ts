// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { TelemetryState } from '@app/specs/telemetry-consent.schema';
import type { ScrubRuleId, SpanAttributeKey, TelemetryChannel } from '@app/specs/telemetry-privacy.spec';
import { SCRUB_RULE_WORDS, SPAN_ATTRIBUTE_WORDS, TELEMETRY_SETTINGS_TEXT, wordList } from '@app/specs/account-settings.spec';

// The Settings view's Telemetry section as a view model (Phase 4 Task 9; acceptance
// `account-settings.feature.md`, Telemetry; review focus "Telemetry UI matches behaviour"). Pure: a
// switch is on exactly when main's `consent` says so; until main answered there are no switches. The
// copy is built from what can leave: every allowlisted span attribute, every scrub rule.

export interface TelemetryToggleView {
  readonly channel: TelemetryChannel;
  readonly label: string;
  /** What is sent and what is done to it, in plain words. */
  readonly description: string;
  /** Main's consent now. */
  readonly on: boolean;
  /** "This build has no endpoint …" when the build cannot send this channel, else `null`. */
  readonly note: string | null;
}

export type TelemetrySection =
  | { readonly kind: 'loading'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly intro: string;
      readonly toggles: readonly TelemetryToggleView[];
      /** "Saved for this run only" when main could not save the choice, else `null`. */
      readonly runOnly: string | null;
    };

/** The usage copy: every `SPAN_ATTRIBUTE_ALLOWLIST` key's words. */
export function usageDescription(): string {
  const carried = wordList((Object.keys(SPAN_ATTRIBUTE_WORDS) as SpanAttributeKey[]).map((key) => SPAN_ATTRIBUTE_WORDS[key]));
  return `Records frost's own operations, such as starting up and the commands and SEO panels you use. Each report carries only ${carried}. Never URLs, page content, search terms or account details. ${TELEMETRY_SETTINGS_TEXT.ipAddress}`;
}

/** The errors copy: what every `SCRUB_RULES` rule removes. */
export function errorsDescription(): string {
  const removed = wordList((Object.keys(SCRUB_RULE_WORDS) as ScrubRuleId[]).map((id) => SCRUB_RULE_WORDS[id]));
  return `When something in frost fails unexpectedly: the error's type, its message and where in frost's code it happened, with frost's version and your operating system. Messages and stack traces are scrubbed of ${removed} before they are sent. ${TELEMETRY_SETTINGS_TEXT.ipAddress}`;
}

/** The channels in order. */
export const TELEMETRY_CHANNEL_TEXT: readonly { readonly channel: TelemetryChannel; readonly label: string; readonly description: string }[] = Object.freeze([
  { channel: 'usage', label: 'Usage and performance', description: usageDescription() },
  { channel: 'errors', label: 'Crash and error reports', description: errorsDescription() },
]);

/** The Telemetry section for main's answer (`state` `null`: not yet; `failed`: the last read failed). */
export function telemetrySection(read: { readonly state: TelemetryState | null; readonly failed: boolean }): TelemetrySection {
  const { state } = read;
  if (state === null) return read.failed ? { kind: 'failed', message: TELEMETRY_SETTINGS_TEXT.failed } : { kind: 'loading', message: TELEMETRY_SETTINGS_TEXT.loading };
  return {
    kind: 'ready',
    intro: TELEMETRY_SETTINGS_TEXT.intro,
    toggles: TELEMETRY_CHANNEL_TEXT.map((text) => ({
      ...text,
      on: state.consent[text.channel],
      note: state.configured[text.channel] ? null : TELEMETRY_SETTINGS_TEXT.notConfigured,
    })),
    runOnly: state.persisted ? null : TELEMETRY_SETTINGS_TEXT.runOnly,
  };
}
