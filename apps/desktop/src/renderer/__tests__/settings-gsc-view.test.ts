// Spec: specs/account-settings.spec.ts (GSC_SETTINGS_TEXT), specs/gsc.spec.ts (GscStatus, GSC_ERRORS, GSC_CONNECT_RESULTS),
// specs/gsc.schema.ts (GscStatusSchema)
// Acceptance: specs/account-settings.feature.md (Search Console)
import { describe, expect, test } from 'vitest';
import { GSC_SETTINGS_TEXT } from '@app/specs/account-settings.spec';
import { GSC_CONNECT_RESULTS, GSC_ERRORS, GscStatusSchema, type GscStatus } from '@app/specs/gsc.schema';
import { GSC_ERROR_MESSAGES, gscConnectResultMessage, gscSection } from '../settings-gsc-view';

function status(changes: Partial<GscStatus> = {}): GscStatus {
  return GscStatusSchema.parse({ configured: true, entitled: true, connected: false, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });
}

describe('Search Console view model', () => {
  test('gsc-view-unconfigured', () => {
    expect(gscSection(status({ configured: false, entitled: false }))).toEqual({ kind: 'unconfigured', headline: null, message: "Search Console isn't configured in this build", buttons: [], error: null, keychain: null });
    expect(gscSection(status({ configured: false, keychain: 'memory-only', error: 'network' }))).toMatchObject({ kind: 'unconfigured', error: null, keychain: null });
  });

  test('gsc-view-never-needs-an-account', () => {
    // Search Console is not gated (2026-10-29): `entitled` changes nothing the section shows.
    for (const changes of [{}, { connected: true }, { connecting: true }] as Partial<GscStatus>[]) {
      expect(gscSection(status({ ...changes, entitled: false }))).toEqual(gscSection(status(changes)));
    }
    expect(gscSection(status({ entitled: false })).buttons).toEqual(['connect']);
    const words = [...Object.values(GSC_SETTINGS_TEXT), ...Object.values(GSC_ERROR_MESSAGES), ...GSC_CONNECT_RESULTS.map(gscConnectResultMessage)];
    for (const text of words) expect(String(text)).not.toMatch(/\bPro\b|plan|sign in/i);
  });

  test('gsc-view-connect-disconnect', () => {
    const idle = gscSection(status());
    expect(idle).toMatchObject({ kind: 'not-connected', buttons: ['connect'] });
    expect(idle.message).toMatch(/read-only/);
    expect(gscSection(status({ connecting: true }))).toMatchObject({ kind: 'connecting', buttons: ['cancel'], message: GSC_SETTINGS_TEXT.connecting });
    const connected = gscSection(status({ connected: true }));
    expect(connected).toMatchObject({ kind: 'connected', headline: 'Connected', buttons: ['disconnect'] });
    expect(connected.message).toMatch(/read-only/);
  });

  test('gsc-view-errors-and-keychain', () => {
    const seen = new Set<string>();
    for (const error of GSC_ERRORS) {
      const shown = gscSection(status({ error })).error;
      expect(shown, error).toBe(GSC_ERROR_MESSAGES[error]);
      seen.add(shown!);
    }
    expect(seen.size).toBe(GSC_ERRORS.length);
    expect(gscConnectResultMessage('started')).toBeNull();
    for (const result of GSC_CONNECT_RESULTS.filter((r) => r !== 'started')) expect(gscConnectResultMessage(result), result).toMatch(/\w{3,}/);
    expect(gscSection(status({ connected: true, keychain: 'memory-only' })).keychain).toBe('This system has no keychain; Search Console will be disconnected when frost quits');
    expect(gscSection(status({ connected: true })).keychain).toBeNull();
    expect(gscSection(status({ connecting: true, keychain: 'memory-only' })).keychain).toBe(GSC_SETTINGS_TEXT.keychain);
    // Nothing connected: nothing to lose at quit, no notice.
    expect(gscSection(status({ keychain: 'memory-only' })).keychain).toBeNull();
    expect(gscSection(status({ entitled: false, keychain: 'memory-only' })).keychain).toBeNull();
  });
});
