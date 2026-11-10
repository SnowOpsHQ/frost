// Spec: specs/help.spec.ts (WHATS_NEW_SEEN_SETTING_KEY, isAppVersion, APP_VERSION_MAX_CHARS)
// Acceptance: specs/help.feature.md (Decisions: What's New after a version change)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, test } from 'vitest';
import { APP_VERSION_MAX_CHARS, WHATS_NEW_SEEN_SETTING_KEY } from '@app/specs/help.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSettingsRepository, type SettingsRepository } from '../settings';

let raw: DatabaseSync;
let settings: SettingsRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  settings = createSettingsRepository(createDrizzle(raw));
});

test('whats-new-seen-version-setting', async () => {
  // Nothing stored: a first run.
  expect(await settings.whatsNewSeenVersion()).toBeNull();
  expect(await settings.setWhatsNewSeenVersion('1.2.0-beta.1', 5)).toBe(true);
  expect(await settings.whatsNewSeenVersion()).toBe('1.2.0-beta.1');
  expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(WHATS_NEW_SEEN_SETTING_KEY)?.['value']).toBe('1.2.0-beta.1');
  // Only an app version is written.
  for (const bad of ['latest', '', '1.2', `1.2.3-${'x'.repeat(APP_VERSION_MAX_CHARS)}`, 7 as unknown as string]) expect(await settings.setWhatsNewSeenVersion(bad, 6), String(bad)).toBe(false);
  expect(await settings.setWhatsNewSeenVersion('2.0.0', Number.NaN)).toBe(false);
  expect(await settings.whatsNewSeenVersion()).toBe('1.2.0-beta.1');
  // A tampered row reads as something else than any version: not null (not a first run), never the value.
  raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('<script>', WHATS_NEW_SEEN_SETTING_KEY);
  expect(await settings.whatsNewSeenVersion()).toBe('');
  // The search engine beside it is untouched.
  expect(await settings.searchEngine()).toBe('google');
});
