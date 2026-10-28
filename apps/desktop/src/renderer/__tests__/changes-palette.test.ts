// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/changes.spec.ts (CAPTURE_REFUSAL_MESSAGES)
// Acceptance: specs/changes-panel.feature.md (Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { CAPTURE_REFUSAL_MESSAGES, type CaptureAnswer } from '@app/specs/changes.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { changesPaletteSources, onPageCaptured } from '../changes-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';
const ID = '0190a000-0000-7000-8000-000000000001';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

const READY: SeoAuditResponse = { status: 'ready', url: URL_A, audit: { url: URL_A, takenAt: 1, indexability: { robots: { outcome: 'ok' } } } as unknown as SeoAudit };
const PROVISIONAL: SeoAuditResponse = { status: 'ready', url: URL_A, audit: { url: URL_A, takenAt: 1, indexability: { robots: { outcome: 'pending' } } } as unknown as SeoAudit };

function setup(context: Partial<PaletteContext> = {}, answer: CaptureAnswer | null = { status: 'captured', captureId: ID, versionId: ID, newVersion: true, changeCount: 2 }) {
  const api = { capture: vi.fn(async () => answer) };
  const registry = createPaletteRegistry();
  registry.register(...changesPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null } as BrowserState;
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: READY, sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  return { api, ctx, ids, chrome, registry };
}

describe('changes palette actions', () => {
  test('changes-palette-actions', async () => {
    expect(FEATURE_PANEL_JUMPS).toContain('changes');
    const { api, ctx, ids, chrome, registry } = setup();
    expect(ids()).toEqual(['panel.changes', 'changes.capture']);
    await registry.resolve(ctx)[0]!.run(ctx);
    expect(chrome.openPanel).toHaveBeenCalledWith('changes', { focus: true });
    // Capturing tells the panel to read its history again.
    const captured = vi.fn();
    const stop = onPageCaptured(captured);
    await expect(Promise.resolve(registry.resolve(ctx)[1]!.run(ctx))).resolves.toBe('Captured a new version: 2 changes.');
    expect(api.capture).toHaveBeenCalledWith(3);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith({ status: 'captured', captureId: ID, versionId: ID, newVersion: true, changeCount: 2 });
    stop();
    // Only on a loaded web page with a settled, ready audit (`canCapture`).
    expect(setup({ audit: PROVISIONAL }).ids()).toEqual(['panel.changes']);
    expect(setup({ tab: tab({ loading: true }) }).ids()).toEqual(['panel.changes']);
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).toEqual(['panel.changes']);
    expect(setup({ audit: null }).ids()).toEqual(['panel.changes']);
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).toEqual(['panel.changes']);
    expect(setup({ tab: tab({ crashed: true }) }).ids()).toEqual(['panel.changes']);
    expect(setup({ tab: undefined }).ids()).toEqual(['panel.changes']);
    // A refusal answers its message.
    const refused = setup({}, { status: 'refused', reason: 'no-audit' });
    await expect(Promise.resolve(refused.registry.resolve(refused.ctx)[1]!.run(refused.ctx))).resolves.toBe(CAPTURE_REFUSAL_MESSAGES['no-audit']);
    // The built-ins leave the panel's jump to it: one row for the panel.
    const builtins = createPaletteRegistry();
    builtins.register(...builtinPaletteSources({} as PaletteApi), ...changesPaletteSources(api));
    expect(builtins.ids().filter((id) => id === 'panel.changes')).toHaveLength(1);
  });
});
