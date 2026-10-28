// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/intent-classifier.spec.ts
// (INTENT_ENABLE_PROMPT, INTENT_ENABLE_MESSAGES), specs/serp-selector-pack.spec.ts (PACK_UPDATE_MESSAGES),
// specs/visibility-probes.spec.ts (PROBE_DISCLOSURE)
// Acceptance: specs/serp-panels.feature.md (Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { INTENT_ENABLE_MESSAGES, INTENT_ENABLE_PROMPT, type IntentState } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES } from '@app/specs/serp-selector-pack.spec';
import type { PackStatus, SerpTabState } from '@app/specs/serp-service.schema';
import { PROBE_DISCLOSURE } from '@app/specs/visibility-probes.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { serpPaletteSources, type SerpPaletteApi } from '../serp-palette';

const URL_A = 'https://www.google.com/search?q=tea';
const PACK: PackStatus = { state: 'ready', version: 2, source: 'remote', published: '2026-10-28', lastUpdate: null, checking: false };

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function serpState(status: 'ready' | 'not-serp' | 'pending', changes: Partial<SerpTabState> = {}): SerpTabState {
  const serp =
    status === 'not-serp'
      ? { status, tabId: 3, url: 'https://tea.example/' }
      : status === 'pending'
        ? { status, tabId: 3, documentSeq: 1, url: URL_A, params: { engine: 'google', engineLabel: 'Google', query: 'tea', gl: null, hl: null, device: 'desktop', page: 1, offset: null, url: URL_A } }
        : { status, tabId: 3, documentSeq: 1, url: URL_A, readAt: 1, snapshot: {} };
  return { version: 1, tabId: 3, serp, outlines: false, intent: null, pack: PACK, ...changes } as SerpTabState;
}

const probes = (status: ProbesState['status']): ProbesState => ({ version: 1, tabId: 3, url: URL_A, status, rows: [], diffs: [], robotsTxt: [], startedAt: null, finishedAt: null });

interface Known {
  serp?: SerpTabState;
  probes?: ProbesState;
  intent?: IntentState;
}

function setup(context: Partial<PaletteContext> = {}, known: Known = {}) {
  const api: SerpPaletteApi = {
    setOutlines: vi.fn(async (_tabId: number, on: boolean) => on),
    checkPackUpdate: vi.fn(async () => 'installed' as const),
    enableIntent: vi.fn(async () => 'ready' as const),
    refreshIntent: vi.fn(async () => 'ready' as const),
    runProbes: vi.fn(async () => true),
    stopProbes: vi.fn(async () => true),
    knownSerp: () => known.serp,
    knownProbes: () => known.probes,
    knownIntent: () => known.intent,
  };
  const registry = createPaletteRegistry();
  registry.register(...serpPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null } as unknown as BrowserState;
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: null, sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const action = (id: string) => registry.resolve(ctx).find((a) => a.id === id)!;
  return { api, ctx, ids, chrome, registry, action };
}

const JUMPS = ['panel.serp', 'panel.visibility'];

describe('SERP palette actions', () => {
  test('serp-palette-jumps', async () => {
    expect(FEATURE_PANEL_JUMPS).toEqual(expect.arrayContaining(['serp', 'visibility']));
    // Always offered, even without a tab.
    expect(setup({ tab: undefined }).ids()).toEqual(expect.arrayContaining(JUMPS));
    const { ctx, chrome, action } = setup();
    expect(action('panel.serp').label).toBe('Open SERP panel');
    expect(action('panel.visibility').label).toBe('Open Visibility panel');
    await action('panel.serp').run(ctx);
    expect(chrome.openPanel).toHaveBeenLastCalledWith('serp', { focus: true });
    await action('panel.visibility').run(ctx);
    expect(chrome.openPanel).toHaveBeenLastCalledWith('visibility', { focus: true });
    // The built-ins leave both jumps to this feature: one row each.
    const both = createPaletteRegistry();
    both.register(...builtinPaletteSources({} as PaletteApi), ...serpPaletteSources(setup().api));
    for (const id of JUMPS) expect(both.ids().filter((other) => other === id), id).toHaveLength(1);
  });

  test('serp-palette-outlines', async () => {
    // Not known yet: offered on a web page (main decides).
    expect(setup().ids()).toContain('serp.outline');
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).not.toContain('serp.outline');
    expect(setup({ tab: tab({ crashed: true }) }).ids()).not.toContain('serp.outline');
    expect(setup({}, { serp: serpState('not-serp') }).ids()).not.toContain('serp.outline');
    expect(setup({}, { serp: serpState('pending') }).ids()).not.toContain('serp.outline');
    const ready = setup({}, { serp: serpState('ready') });
    expect(ready.ids()).toContain('serp.outline');
    expect(ready.ids()).not.toContain('serp.outline-hide');
    expect(ready.action('serp.outline').label).toBe('Outline SERP features');
    await expect(Promise.resolve(ready.action('serp.outline').run(ready.ctx))).resolves.toBe('Outlining SERP features');
    expect(ready.chrome.openPanel).toHaveBeenCalledWith('serp');
    expect(ready.api.setOutlines).toHaveBeenCalledWith(3, true);
    // A known state of another tab says nothing about this one.
    expect(setup({}, { serp: { ...serpState('not-serp'), tabId: 9 } }).ids()).toContain('serp.outline');
    const drawn = setup({}, { serp: serpState('ready', { outlines: true }) });
    expect(drawn.ids()).not.toContain('serp.outline');
    expect(drawn.ids()).toContain('serp.outline-hide');
    expect(drawn.action('serp.outline-hide').label).toBe('Hide SERP outlines');
    await expect(Promise.resolve(drawn.action('serp.outline-hide').run(drawn.ctx))).resolves.toBe('SERP outlines hidden');
    expect(drawn.api.setOutlines).toHaveBeenCalledWith(3, false);
    const refused = setup({}, { serp: serpState('ready') });
    (refused.api.setOutlines as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(Promise.resolve(refused.action('serp.outline').run(refused.ctx))).resolves.toBe('Nothing to outline on this page');
  });

  test('serp-palette-pack-update', async () => {
    const { ctx, action, api } = setup();
    expect(action('serp.check-pack-update').label).toBe('Check for selector updates');
    await expect(Promise.resolve(action('serp.check-pack-update').run(ctx))).resolves.toBe(PACK_UPDATE_MESSAGES.installed);
    expect(api.checkPackUpdate).toHaveBeenCalledTimes(1);
    // Offered without a tab, and while known to be ready; not while checking or disabled.
    expect(setup({ tab: undefined }).ids()).toContain('serp.check-pack-update');
    expect(setup({}, { serp: serpState('not-serp', { pack: { ...PACK, checking: true } }) }).ids()).not.toContain('serp.check-pack-update');
    expect(setup({}, { serp: serpState('not-serp', { pack: { ...PACK, state: 'disabled' } }) }).ids()).not.toContain('serp.check-pack-update');
    const failed = setup();
    (failed.api.checkPackUpdate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(Promise.resolve(failed.action('serp.check-pack-update').run(failed.ctx))).resolves.toBe(PACK_UPDATE_MESSAGES.unreachable);
  });

  test('serp-palette-intent', async () => {
    // Not known yet, or missing: offered; otherwise not.
    expect(setup().ids()).toContain('serp.enable-intent');
    expect(setup({}, { intent: 'model-missing' }).ids()).toContain('serp.enable-intent');
    for (const state of ['ready', 'downloading', 'unavailable'] as const) expect(setup({}, { intent: state }).ids(), state).not.toContain('serp.enable-intent');
    const { ctx, action, api } = setup({}, { intent: 'model-missing' });
    expect(action('serp.enable-intent').label).toBe('Enable on-device intent');
    // It asks first, stating size, host and licence.
    const confirm = action('serp.enable-intent').confirm!(ctx)!;
    expect(confirm.message).toBe(INTENT_ENABLE_PROMPT);
    expect(confirm.confirmLabel).toBe('Download and enable');
    expect(api.enableIntent).not.toHaveBeenCalled();
    await expect(Promise.resolve(action('serp.enable-intent').run(ctx))).resolves.toBe(INTENT_ENABLE_MESSAGES.ready);
    expect(api.enableIntent).toHaveBeenCalledTimes(1);
    // What the palette knows is refreshed after the answer.
    expect(api.refreshIntent).toHaveBeenCalledTimes(1);
    expect((api.refreshIntent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan((api.enableIntent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    const failed = setup();
    (failed.api.enableIntent as ReturnType<typeof vi.fn>).mockResolvedValue('integrity');
    await expect(Promise.resolve(failed.action('serp.enable-intent').run(failed.ctx))).resolves.toBe(INTENT_ENABLE_MESSAGES.integrity);
  });

  test('serp-palette-probes', async () => {
    const { ctx, action, api, chrome, ids } = setup();
    expect(ids()).toContain('probes.run');
    expect(ids()).not.toContain('probes.stop');
    expect(action('probes.run').label).toBe('Run visibility probes');
    const confirm = action('probes.run').confirm!(ctx)!;
    expect(confirm.note).toBe(PROBE_DISCLOSURE);
    expect(confirm.confirmLabel).toBe('Run probes');
    await expect(Promise.resolve(action('probes.run').run(ctx))).resolves.toBe('Running visibility probes');
    expect(chrome.openPanel).toHaveBeenCalledWith('visibility');
    expect(api.runProbes).toHaveBeenCalledWith(3);
    // Only on a web page; not while a run is under way (Stop instead).
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).not.toContain('probes.run');
    expect(setup({ tab: undefined }).ids()).not.toContain('probes.run');
    const running = setup({}, { probes: probes('running') });
    expect(running.ids()).not.toContain('probes.run');
    expect(running.ids()).toContain('probes.stop');
    expect(running.action('probes.stop').label).toBe('Stop visibility probes');
    await expect(Promise.resolve(running.action('probes.stop').run(running.ctx))).resolves.toBe('Visibility probes stopped');
    expect(running.api.stopProbes).toHaveBeenCalledWith(3);
    expect(setup({}, { probes: probes('done') }).ids()).toContain('probes.run');
    const refused = setup();
    (refused.api.runProbes as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(Promise.resolve(refused.action('probes.run').run(refused.ctx))).resolves.toBe('The probes could not start');
  });
});
