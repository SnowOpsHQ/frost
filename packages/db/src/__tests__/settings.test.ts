// Spec: specs/help.spec.ts (WHATS_NEW_SEEN_SETTING_KEY, isAppVersion, APP_VERSION_MAX_CHARS)
// Acceptance: specs/help.feature.md (Decisions: What's New after a version change)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, test } from 'vitest';
import { APP_VERSION_MAX_CHARS, WHATS_NEW_SEEN_SETTING_KEY } from '@app/specs/help.spec';
import { AI_SEARCH_DEFAULT_ENGINE_KEY, AI_SEARCH_VIA_KEY } from '@app/specs/ai-search.spec';
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

// Phase 12 Task 8 (specs/ai-search.spec.ts: AI_SEARCH_VIA_KEY, AI_SEARCH_DEFAULT_ENGINE_KEY; ai-search.feature.md, Settings).
test('ai-search-settings-read-from-app-settings', async () => {
  // Nothing stored: every via unset (the API when usable), no default engine.
  expect(await settings.aiSearchSettings()).toEqual({ via: { perplexity: null, chatgpt: null, 'google-ai-mode': null }, defaultEngine: null });
  const put = raw.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  put.run(AI_SEARCH_VIA_KEY('perplexity'), 'off');
  put.run(AI_SEARCH_VIA_KEY('chatgpt'), 'api');
  put.run(AI_SEARCH_DEFAULT_ENGINE_KEY, 'chatgpt');
  expect(await settings.aiSearchSettings()).toEqual({ via: { perplexity: 'off', chatgpt: 'api', 'google-ai-mode': null }, defaultEngine: 'chatgpt' });
  // A tampered value reads as unset: never a via (`tab` is the deferred D1) or an unknown engine.
  put.run(AI_SEARCH_VIA_KEY('perplexity'), 'tab');
  put.run(AI_SEARCH_DEFAULT_ENGINE_KEY, 'bing');
  expect(await settings.aiSearchSettings()).toEqual({ via: { perplexity: null, chatgpt: 'api', 'google-ai-mode': null }, defaultEngine: null });
});
