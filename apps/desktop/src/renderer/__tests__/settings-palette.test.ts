// Spec: specs/account-settings.spec.ts (SETTINGS_PALETTE_ACTIONS), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/account-settings.feature.md (Palette)
import { describe, expect, test, vi } from 'vitest';
import type { AccountStatus } from '@app/specs/account-state.schema';
import type { BrowserState } from '@app/specs/browser.spec';
import { browserPolishPaletteSources } from '../browser-polish-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { settingsPaletteSources, watchSettingsAvailability } from '../settings-palette';

const ctx = { state: null as BrowserState | null, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } } satisfies PaletteContext;

describe('Settings palette actions', () => {
  test('settings-palette-actions', async () => {
    const openSettings = vi.fn();
    let status: AccountStatus | null = 'signed-out';
    let gscConfigured: boolean | null = true;
    const registry = createPaletteRegistry();
    registry.register(...settingsPaletteSources({ openSettings, accountStatus: () => status, gscConfigured: () => gscConfigured }));
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
    // "Sign in to frost" only while signed out.
    for (const other of ['signed-in', 'confirming', 'awaiting-browser', 'unconfigured', null] as const) {
      status = other;
      expect(registry.resolve(ctx).map((a) => a.id), String(other)).toEqual(['settings.open', 'settings.search-console', 'settings.telemetry']);
    }
    // "Search Console settings" only while its section is shown: not once main says it is not configured
    // (before main answers it shows, as the section does); "Settings" always (it lands on the top).
    gscConfigured = null;
    expect(registry.resolve(ctx).map((a) => a.id)).toContain('settings.search-console');
    gscConfigured = false;
    expect(registry.resolve(ctx).map((a) => a.id)).toEqual(['settings.open', 'settings.telemetry']);
  });

  test('settings-palette-registers-with-others', () => {
    const yes = vi.fn(async () => true);
    const registry = createPaletteRegistry();
    expect(() =>
      registry.register(
        ...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi),
        ...browserPolishPaletteSources({ openFind: yes, reopenClosedTab: vi.fn(async () => 1), showHistory: yes, setSearchEngine: yes }),
        ...settingsPaletteSources({ openSettings: vi.fn(), accountStatus: () => 'signed-out', gscConfigured: () => true }),
      ),
    ).not.toThrow();
    const ids = registry.ids();
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('settings-palette-follows-main-while-open', () => {
    // Stores as `useSyncExternalStore` sees them: an answer calls the listeners.
    const fake = <T,>(first: T | null) => {
      let value = first;
      const listeners = new Set<() => void>();
      return { current: () => value, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)), answer: (next: T) => { value = next; for (const l of listeners) l(); }, count: () => listeners.size };
    };
    const account = fake<{ status: AccountStatus }>({ status: 'signed-out' });
    const gsc = fake<{ configured: boolean }>(null);
    const registry = createPaletteRegistry();
    registry.register(...settingsPaletteSources({ openSettings: vi.fn(), accountStatus: () => account.current()?.status ?? null, gscConfigured: () => gsc.current()?.configured ?? null }));
    registry.watch(watchSettingsAvailability([account, gsc]));
    // What an open palette does: resolve again whenever the registry says its inputs changed.
    let listed = registry.resolve(ctx).map((a) => a.id);
    expect(account.count()).toBe(0);
    const off = registry.subscribe(() => (listed = registry.resolve(ctx).map((a) => a.id)));
    expect(listed).toContain('settings.search-console');
    expect(listed).toContain('settings.sign-in');
    gsc.answer({ configured: false });
    expect(listed).not.toContain('settings.search-console');
    account.answer({ status: 'signed-in' });
    expect(listed).not.toContain('settings.sign-in');
    off();
    expect(account.count()).toBe(0);
    expect(gsc.count()).toBe(0);
  });
});
