// Spec: specs/account-settings.spec.ts (SETTINGS_PALETTE_ACTIONS), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/account-settings.feature.md (Palette)
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';
import { browserPolishPaletteSources } from '../browser-polish-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { settingsPaletteSources } from '../settings-palette';

const ctx = { state: null as BrowserState | null, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } } satisfies PaletteContext;

describe('Settings palette actions', () => {
  test('settings-palette-actions', async () => {
    const openSettings = vi.fn();
    const registry = createPaletteRegistry();
    registry.register(...settingsPaletteSources({ openSettings }));
    const actions = registry.resolve(ctx);
    expect(actions.map((a) => [a.id, a.label])).toEqual([
      ['settings.open', 'Settings'],
      ['settings.sign-in', 'Sign in to frost'],
      ['settings.search-console', 'Search Console settings'],
      ['settings.telemetry', 'Telemetry settings'],
    ]);
    for (const action of actions) {
      expect(action.group).toBe('browser');
      expect(action.focus).toBe('handler');
      expect(action.keywords).toContain('settings');
    }
    const sections: string[] = [];
    for (const action of actions) {
      await action.run(ctx);
      sections.push(openSettings.mock.lastCall![0] as string);
    }
    expect(sections).toEqual(['account', 'account', 'search-console', 'telemetry']);
  });

  test('settings-palette-registers-with-others', () => {
    const yes = vi.fn(async () => true);
    const registry = createPaletteRegistry();
    expect(() =>
      registry.register(
        ...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi),
        ...browserPolishPaletteSources({ openFind: yes, reopenClosedTab: vi.fn(async () => 1), showHistory: yes, setSearchEngine: yes }),
        ...settingsPaletteSources({ openSettings: vi.fn() }),
      ),
    ).not.toThrow();
    const ids = registry.ids();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
