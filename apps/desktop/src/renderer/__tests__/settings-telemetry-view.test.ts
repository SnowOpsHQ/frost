// Spec: specs/account-settings.spec.ts (TELEMETRY_SETTINGS_TEXT), specs/telemetry-consent.schema.ts (TelemetryStateSchema),
// specs/telemetry-privacy.spec.ts (TELEMETRY_CHANNELS, DEFAULT_CONSENT)
// Acceptance: specs/account-settings.feature.md (Telemetry) · review focus "Telemetry UI matches behaviour"
import { describe, expect, test } from 'vitest';
import { TELEMETRY_SETTINGS_TEXT } from '@app/specs/account-settings.spec';
import { TelemetryStateSchema, type TelemetryState } from '@app/specs/telemetry-consent.schema';
import { DEFAULT_CONSENT, TELEMETRY_CHANNELS } from '@app/specs/telemetry-privacy.spec';
import { telemetrySection } from '../settings-telemetry-view';

function state(changes: Partial<TelemetryState> = {}): TelemetryState {
  return TelemetryStateSchema.parse({ consent: DEFAULT_CONSENT, configured: { usage: true, errors: true }, persisted: true, version: 0, ...changes });
}

describe('telemetry view model', () => {
  test('telemetry-view-two-toggles-default-off', () => {
    const section = telemetrySection(state());
    expect(section.toggles.map((t) => t.channel)).toEqual([...TELEMETRY_CHANNELS]);
    expect(section.toggles.map((t) => t.label)).toEqual(['Usage and performance', 'Crash and error reports']);
    for (const toggle of section.toggles) {
      expect(toggle.on, toggle.channel).toBe(false);
      expect(toggle.note).toBeNull();
      // What is sent: the version and platform; what is not: URLs, page content, identifiers.
      expect(toggle.sends).toMatch(/version/);
      expect(toggle.sends).toMatch(/operating system/);
      expect(toggle.never).toMatch(/URLs/);
      expect(toggle.never).toMatch(/page content/);
      expect(toggle.never).toMatch(/identif/);
    }
    expect(section.runOnly).toBeNull();
    expect(section.ready).toBe(true);
  });

  test('telemetry-view-reflects-main', () => {
    // Before main's first answer nothing is shown on, and the toggles wait.
    const before = telemetrySection(null);
    expect(before.ready).toBe(false);
    expect(before.toggles.every((t) => !t.on && t.note === null)).toBe(true);
    for (const consent of [{ usage: true, errors: false }, { usage: false, errors: true }, { usage: true, errors: true }]) {
      const section = telemetrySection(state({ consent }));
      expect(Object.fromEntries(section.toggles.map((t) => [t.channel, t.on]))).toEqual(consent);
    }
  });

  test('telemetry-view-not-configured', () => {
    const section = telemetrySection(state({ configured: { usage: false, errors: true }, consent: { usage: true, errors: false } }));
    const [usage, errors] = section.toggles;
    expect(usage).toMatchObject({ channel: 'usage', on: true, note: 'This build has no endpoint for this, so nothing is sent' });
    expect(errors!.note).toBeNull();
    expect(TELEMETRY_SETTINGS_TEXT.notConfigured).toBe(usage!.note);
  });

  test('telemetry-view-run-only', () => {
    expect(telemetrySection(state({ persisted: false, consent: { usage: true, errors: false } })).runOnly).toBe('Saved for this run only');
    expect(telemetrySection(null).runOnly).toBeNull();
  });
});
