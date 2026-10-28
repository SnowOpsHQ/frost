// Spec: specs/account-settings.spec.ts (TELEMETRY_SETTINGS_TEXT, SPAN_ATTRIBUTE_WORDS, SCRUB_RULE_WORDS, settingsRetryDelay),
// specs/telemetry-consent.schema.ts (TelemetryStateSchema), specs/telemetry-privacy.spec.ts (TELEMETRY_CHANNELS,
// DEFAULT_CONSENT, SPAN_ATTRIBUTE_ALLOWLIST, SCRUB_RULE_IDS)
// Acceptance: specs/account-settings.feature.md (Telemetry) · review focus "Telemetry UI matches behaviour"
import { describe, expect, test } from 'vitest';
import { SCRUB_RULE_WORDS, SPAN_ATTRIBUTE_WORDS, settingsRetryDelay, TELEMETRY_SETTINGS_TEXT } from '@app/specs/account-settings.spec';
import { TelemetryStateSchema, type TelemetryState } from '@app/specs/telemetry-consent.schema';
import { DEFAULT_CONSENT, SCRUB_RULE_IDS, SPAN_ATTRIBUTE_ALLOWLIST, TELEMETRY_CHANNELS } from '@app/specs/telemetry-privacy.spec';
import { telemetrySection, type TelemetrySection } from '../settings-telemetry-view';

function state(changes: Partial<TelemetryState> = {}): TelemetryState {
  return TelemetryStateSchema.parse({ consent: DEFAULT_CONSENT, configured: { usage: true, errors: true }, persisted: true, version: 0, ...changes });
}
const ready = (section: TelemetrySection) => {
  if (section.kind !== 'ready') throw new Error(`not ready: ${section.kind}`);
  return section;
};
const answered = (changes: Partial<TelemetryState> = {}) => ready(telemetrySection({ state: state(changes), failed: false }));

describe('telemetry view model', () => {
  test('telemetry-view-two-toggles-default-off', () => {
    const section = answered();
    expect(section.toggles.map((t) => t.channel)).toEqual([...TELEMETRY_CHANNELS]);
    expect(section.toggles.map((t) => t.label)).toEqual(['Usage and performance', 'Crash and error reports']);
    for (const toggle of section.toggles) {
      expect(toggle.on, toggle.channel).toBe(false);
      expect(toggle.note).toBeNull();
      expect(toggle.description).toMatch(/version/);
      expect(toggle.description).toMatch(/operating system/);
      // Honest about the network: the server sees the address.
      expect(toggle.description).toContain(TELEMETRY_SETTINGS_TEXT.ipAddress);
    }
    const [usage, errors] = section.toggles;
    expect(usage!.description).toMatch(/starting up/);
    expect(usage!.description).toMatch(/commands and SEO panels/);
    // Errors does not promise what scrubbing cannot (page content in a message).
    expect(errors!.description).not.toMatch(/page content/);
    expect(errors!.description).toMatch(/scrubbed of/);
    expect(section.runOnly).toBeNull();
  });

  test('telemetry-view-copy-follows-allowlist', () => {
    // The word tables cover exactly what can leave: a key added to (or removed from) the allowlist fails here.
    expect(Object.keys(SPAN_ATTRIBUTE_WORDS).sort()).toEqual(Object.keys(SPAN_ATTRIBUTE_ALLOWLIST).sort());
    expect(Object.keys(SCRUB_RULE_WORDS).sort()).toEqual([...SCRUB_RULE_IDS].sort());
    const [usage, errors] = answered().toggles;
    for (const words of Object.values(SPAN_ATTRIBUTE_WORDS)) expect(usage!.description).toContain(words);
    for (const words of Object.values(SCRUB_RULE_WORDS)) expect(errors!.description).toContain(words);
    for (const words of ['URLs', 'email addresses', 'file paths', 'host names', 'IP addresses', 'tokens']) expect(errors!.description).toContain(words);
  });

  test('telemetry-view-reflects-main', () => {
    // Before main's first answer: no switches at all (nothing claims "off").
    expect(telemetrySection({ state: null, failed: false })).toEqual({ kind: 'loading', message: 'Loading…' });
    for (const consent of [{ usage: true, errors: false }, { usage: false, errors: true }, { usage: true, errors: true }]) {
      expect(Object.fromEntries(answered({ consent }).toggles.map((t) => [t.channel, t.on]))).toEqual(consent);
    }
  });

  test('telemetry-view-read-failure', () => {
    const failed = telemetrySection({ state: null, failed: true });
    expect(failed).toEqual({ kind: 'failed', message: TELEMETRY_SETTINGS_TEXT.failed });
    expect(failed).not.toHaveProperty('toggles');
    // Retried with backoff.
    expect([settingsRetryDelay(1), settingsRetryDelay(2), settingsRetryDelay(3)]).toEqual([1_000, 2_000, 4_000]);
    // A later answer wins over an earlier failure.
    expect(telemetrySection({ state: state(), failed: true }).kind).toBe('ready');
  });

  test('telemetry-view-not-configured', () => {
    const [usage, errors] = answered({ configured: { usage: false, errors: true }, consent: { usage: true, errors: false } }).toggles;
    expect(usage).toMatchObject({ channel: 'usage', on: true, note: 'This build has no endpoint for this, so nothing is sent' });
    expect(errors!.note).toBeNull();
  });

  test('telemetry-view-run-only', () => {
    expect(answered({ persisted: false, consent: { usage: true, errors: false } }).runOnly).toBe('Saved for this run only');
  });
});
