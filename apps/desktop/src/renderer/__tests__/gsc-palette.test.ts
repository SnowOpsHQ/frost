// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/gsc-panel.spec.ts (GSC_SCOPE_LABELS)
// Acceptance: specs/gsc-panel.feature.md (Palette)
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import type { GscQueryScope } from '@app/specs/gsc.spec';
import { gscPaletteSources } from '../gsc-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function setup(context: Partial<PaletteContext> = {}, scope: GscQueryScope = 'page') {
  let current = scope;
  const api = { scope: () => current, setScope: vi.fn((next: GscQueryScope) => void (current = next)) };
  const registry = createPaletteRegistry();
  registry.register(...gscPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null } as unknown as BrowserState;
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: null, sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const run = (id: string) => registry.resolve(ctx).find((a) => a.id === id)!.run(ctx);
  return { api, ctx, ids, run, chrome, registry };
}

describe('Search Console palette actions', () => {
  test('gsc-palette-actions', async () => {
    expect(FEATURE_PANEL_JUMPS).toContain('search-console');
    const { api, ids, run, chrome, registry } = setup();
    expect(ids()).toEqual(['panel.search-console', 'search-console.whole-property']);
    const jump = registry.resolve(setup().ctx)[0]!;
    expect(jump).toMatchObject({ label: 'Open Search Console panel', group: 'panels', focus: 'handler', icon: 'panel-search-console' });
    await run('panel.search-console');
    expect(chrome.openPanel).toHaveBeenCalledWith('search-console', { focus: true });

    await run('search-console.whole-property');
    expect(api.setScope).toHaveBeenCalledWith('property');
    expect(chrome.openPanel).toHaveBeenLastCalledWith('search-console', { focus: false });
    // Now the other scope is offered.
    expect(ids()).toEqual(['panel.search-console', 'search-console.this-page']);
    await run('search-console.this-page');
    expect(api.setScope).toHaveBeenLastCalledWith('page');

    // On a page that is not a web page only the jump is offered.
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).toEqual(['panel.search-console']);
    expect(setup({ tab: undefined }).ids()).toEqual(['panel.search-console']);
    expect(setup({ tab: tab({ crashed: true }) }).ids()).toEqual(['panel.search-console']);

    // The built-ins leave the panel's jump to it: one row for the panel.
    const builtins = createPaletteRegistry();
    builtins.register(...builtinPaletteSources({} as PaletteApi), ...gscPaletteSources(api));
    expect(builtins.ids().filter((id) => id === 'panel.search-console')).toHaveLength(1);
  });
});
