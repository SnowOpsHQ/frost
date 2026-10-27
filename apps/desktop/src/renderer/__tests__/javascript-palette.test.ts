// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API)
// Acceptance: specs/seo-javascript.feature.md (Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { javascriptPaletteSources } from '../javascript-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

const READY: SeoAuditResponse = { status: 'ready', url: URL_A, audit: { url: URL_A, takenAt: 1 } as unknown as SeoAudit };

function setup(context: Partial<PaletteContext> = {}, answer = true) {
  const api = { refetchServed: vi.fn(async () => answer) };
  const registry = createPaletteRegistry();
  registry.register(...javascriptPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: READY, sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  return { api, ctx, ids, chrome, registry };
}

describe('javascript palette actions', () => {
  test('javascript-palette-actions', async () => {
    expect(FEATURE_PANEL_JUMPS).toContain('javascript');
    const { api, ctx, ids, chrome, registry } = setup();
    expect(ids()).toEqual(['panel.javascript', 'javascript.refetch-served']);
    await registry.resolve(ctx)[0]!.run(ctx);
    expect(chrome.openPanel).toHaveBeenCalledWith('javascript', { focus: true });
    await expect(Promise.resolve(registry.resolve(ctx)[1]!.run(ctx))).resolves.toBe('Fetching the served HTML again');
    expect(api.refetchServed).toHaveBeenCalledWith(3);
    // Only on a web page with a ready audit.
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).toEqual(['panel.javascript']);
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).toEqual(['panel.javascript']);
    expect(setup({ tab: tab({ crashed: true }) }).ids()).toEqual(['panel.javascript']);
    const refused = setup({}, false);
    await expect(Promise.resolve(refused.registry.resolve(refused.ctx)[1]!.run(refused.ctx))).resolves.toBe('Could not fetch again');
    // The built-ins leave the panel's jump to it: one row for the panel.
    const builtins = createPaletteRegistry();
    builtins.register(...builtinPaletteSources({} as PaletteApi), ...javascriptPaletteSources(api));
    expect(builtins.ids().filter((id) => id === 'panel.javascript')).toHaveLength(1);
  });
});
