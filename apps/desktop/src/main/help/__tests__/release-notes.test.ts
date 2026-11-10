// Spec: specs/whats-new.schema.ts (ReleaseNotesSchema, RELEASE_NOTES_LIMITS), specs/help.spec.ts (WHATS_NEW_SEEN_SETTING_KEY, isAppVersion)
// Acceptance: specs/help.feature.md (Release notes: release-notes-valid-and-current-version-present,
// release-notes-bundled-not-read-from-disk, whats-new-once-after-version-change)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { RELEASE_NOTES_LIMITS, ReleaseNotesSchema, type ReleaseNotes } from '@app/specs/whats-new.schema';
import packageJson from '../../../../package.json';
import bundledJson from '../../../../release-notes.json';
import { loadReleaseNotes } from '../release-notes';
import { createWhatsNew, type WhatsNewSettings } from '../whats-new';

const HELP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('release notes', () => {
  test('release-notes-valid-and-current-version-present', () => {
    const parsed = ReleaseNotesSchema.safeParse(bundledJson);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const notes = parsed.data!;
    expect(notes.releases.map((release) => release.version)).toContain(packageJson.version);
    // Main's own load gives the same (validated) notes.
    expect(loadReleaseNotes()).toEqual(notes);

    // The schema's bounds.
    const base = notes.releases[0]!;
    const one = (changes: Record<string, unknown>) => ReleaseNotesSchema.safeParse({ releases: [{ ...base, ...changes }] }).success;
    expect(one({ url: 'https://github.com/SnowOpsHQ/frost/releases/tag/v1.0.0' })).toBe(true);
    for (const url of [
      'https://evil.example/SnowOpsHQ/frost/releases',
      'https://github.com/SnowOpsHQ/frostbite/releases',
      'https://github.com/SnowOpsHQ/frost/releases?from=app',
      'https://github.com/SnowOpsHQ/frost/releases#x',
      'http://github.com/SnowOpsHQ/frost/releases',
      'https://user@github.com/SnowOpsHQ/frost/releases',
      'https://github.com/SnowOpsHQ/frost',
      'https://github.com/SnowOpsHQ/frost/../other/x',
    ])
      expect(one({ url }), url).toBe(false);
    expect(one({ items: ['x'.repeat(RELEASE_NOTES_LIMITS.maxItemChars)] })).toBe(true);
    expect(one({ items: ['x'.repeat(RELEASE_NOTES_LIMITS.maxItemChars + 1)] })).toBe(false);
    expect(one({ items: Array.from({ length: RELEASE_NOTES_LIMITS.maxItems + 1 }, (_, i) => `item ${i}`) })).toBe(false);
    expect(one({ items: [] })).toBe(false);
    expect(one({ items: ['two\nlines'] })).toBe(false);
    expect(one({ version: 'latest' })).toBe(false);
    expect(one({ date: '9 Nov 2026' })).toBe(false);
    expect(one({ extra: true })).toBe(false);
    const many = Array.from({ length: RELEASE_NOTES_LIMITS.maxReleases + 1 }, (_, i) => ({ ...base, version: `0.0.${1000 - i}` }));
    expect(ReleaseNotesSchema.safeParse({ releases: many }).success).toBe(false);
    expect(ReleaseNotesSchema.safeParse({ releases: many.slice(0, RELEASE_NOTES_LIMITS.maxReleases) }).success).toBe(true);
    expect(ReleaseNotesSchema.safeParse({ releases: [base, base] }).success).toBe(false);
    // Newest first.
    expect(ReleaseNotesSchema.safeParse({ releases: [{ ...base, version: '0.0.1', date: '2026-01-01' }, { ...base, version: '0.0.2', date: '2026-02-01' }] }).success).toBe(false);
  });

  test('release-notes-bundled-not-read-from-disk', () => {
    const sources = readdirSync(HELP_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(path.join(HELP_DIR, name), 'utf8')] as const);
    expect(sources.length).toBeGreaterThan(0);
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
      expect(source, name).not.toMatch(/\breadFile(Sync)?\b|\bcreateReadStream\b|getAppPath|process\.resourcesPath/);
    }
    // The notes come in through one static JSON import, bundled by Vite.
    const loader = sources.find(([name]) => name === 'release-notes.ts')![1];
    expect(loader).toMatch(/^import \w+ from '(\.\.\/){3}release-notes\.json';$/m);
    // Invalid notes never reach What's New.
    const log = vi.fn();
    expect(loadReleaseNotes({ releases: [{ version: '1.0.0' }] }, log)).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("what's new", () => {
  function settings(stored: string | null, options: { failRead?: boolean } = {}) {
    const state = { stored, writes: [] as string[] };
    const api: WhatsNewSettings = {
      whatsNewSeenVersion: vi.fn(async () => {
        if (options.failRead) throw new Error('database gone');
        return state.stored;
      }),
      setWhatsNewSeenVersion: vi.fn(async (version: string) => {
        state.stored = version;
        state.writes.push(version);
        return true;
      }),
    };
    return { state, api };
  }
  const NOTES: ReleaseNotes = {
    releases: [
      { version: '1.2.0', date: '2026-11-01', title: 'New', items: ['A thing'] },
      { version: '1.1.0', date: '2026-10-01', title: 'Old', items: ['Another thing'] },
    ],
  };

  test('whats-new-once-after-version-change', async () => {
    // First run: the version is recorded; nothing shows.
    const first = settings(null);
    const fresh = createWhatsNew({ version: '1.2.0', notes: NOTES, settings: first.api, now: () => 5 });
    expect(await fresh.take()).toBe(false);
    expect(first.state.writes).toEqual(['1.2.0']);
    expect(fresh.answer()).toEqual({ currentVersion: '1.2.0', releases: NOTES.releases });

    // The same version: nothing, nothing written.
    const same = settings('1.2.0');
    expect(await createWhatsNew({ version: '1.2.0', notes: NOTES, settings: same.api, now: () => 5 }).take()).toBe(false);
    expect(same.state.writes).toEqual([]);

    // Another version stored: shown once (the first chrome to ask), and the running version recorded.
    const updated = settings('1.1.0');
    const whatsNew = createWhatsNew({ version: '1.2.0', notes: NOTES, settings: updated.api, now: () => 5 });
    const [a, b] = await Promise.all([whatsNew.take(), whatsNew.take()]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await whatsNew.take()).toBe(false);
    expect(updated.state.writes).toEqual(['1.2.0']);

    // A stored value that is not a version (the setting reads it as ''): counts as another version.
    const tampered = settings('');
    expect(await createWhatsNew({ version: '1.2.0', notes: NOTES, settings: tampered.api, now: () => 5 }).take()).toBe(true);
    expect(tampered.state.writes).toEqual(['1.2.0']);

    // A running version that is not a version: What's New is off, nothing read or stored.
    const odd = settings('1.1.0');
    const off = createWhatsNew({ version: 'dev', notes: NOTES, settings: odd.api, now: () => 5 });
    expect(await off.take()).toBe(false);
    expect(odd.api.whatsNewSeenVersion).not.toHaveBeenCalled();
    expect(odd.state.writes).toEqual([]);
    expect(off.answer()).toEqual({ currentVersion: null, releases: NOTES.releases });

    // A version the notes don't list: nothing to show (the version is still recorded).
    const unlisted = settings('1.1.0');
    expect(await createWhatsNew({ version: '1.3.0', notes: NOTES, settings: unlisted.api, now: () => 5 }).take()).toBe(false);
    expect(unlisted.state.writes).toEqual(['1.3.0']);
    // No notes (invalid at startup): nothing, and nothing listed.
    const none = createWhatsNew({ version: '1.2.0', notes: null, settings: settings('1.1.0').api, now: () => 5 });
    expect(await none.take()).toBe(false);
    expect(none.answer()).toEqual({ currentVersion: '1.2.0', releases: [] });
    // A failed read: nothing shows, nothing written.
    const broken = settings('1.1.0', { failRead: true });
    const log = vi.fn();
    expect(await createWhatsNew({ version: '1.2.0', notes: NOTES, settings: broken.api, now: () => 5, log }).take()).toBe(false);
    expect(broken.state.writes).toEqual([]);
    expect(log).toHaveBeenCalled();
  });
});
