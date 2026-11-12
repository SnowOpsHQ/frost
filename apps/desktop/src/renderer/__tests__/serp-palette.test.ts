// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/intent-classifier.spec.ts
// (INTENT_ENABLE_PROMPT, INTENT_ENABLE_MESSAGES), specs/serp-selector-pack.spec.ts (PACK_UPDATE_MESSAGES),
// specs/visibility-probes.spec.ts (PROBE_DISCLOSURE), specs/serp-param-editor.spec.ts (TRACK_REFUSAL_MESSAGES),
// specs/ai-destinations.spec.ts (AI_SEARCH_DESTINATIONS, AI_DESTINATION_NOTE, openDestinationMessage)
// Acceptance: specs/serp-panels.feature.md (Command palette; Edit search, Command palette; Open in an AI engine, Command palette)
import { describe, expect, test, vi } from 'vitest';
import { AI_DESTINATION_NOTE, AI_SEARCH_DESTINATIONS, OPEN_DESTINATION_REFUSAL_MESSAGES, openDestinationMessage } from '@app/specs/ai-destinations.spec';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { INTENT_ENABLE_MESSAGES, INTENT_ENABLE_PROMPT, type IntentState } from '@app/specs/intent-classifier.spec';
import { TRACK_REFUSAL_MESSAGES } from '@app/specs/serp-param-editor.spec';
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
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', highlightPhrase: null, renderProfile: null, tabOverrides: { cssDisabled: false, cookiesDisabled: false, geolocation: null }, loadedUnderOverrides: false, overridesRevision: 0, overridesStatus: 'active', ...changes };
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

const probes = (status: ProbesState['status']): ProbesState => ({ version: 1, tabId: 3, url: URL_A, status, rows: [], diffs: [], robotsTxt: [], llmsTxt: null, startedAt: null, finishedAt: null });

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
    openEditor: vi.fn(),
    openDestination: vi.fn(async (_tabId: number, _destination: string) => ({ status: 'opened' as const, tabId: 11 })),
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
    // The palette restores no focus for it, so the panel takes it (issue #25: not left on <body>).
    expect(ready.action('serp.outline').focus).toBe('handler');
    expect(ready.chrome.openPanel).toHaveBeenCalledWith('serp', { focus: true });
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
    expect(action('probes.run').focus).toBe('handler');
    expect(chrome.openPanel).toHaveBeenCalledWith('visibility', { focus: true });
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

  test('serp-palette-edit-and-track', async () => {
    const pending = (url: string, engine = 'google', paramNames: SerpTabState['paramNames'] = null): SerpTabState =>
      ({
        version: 1,
        tabId: 3,
        serp: { status: 'pending', tabId: 3, documentSeq: 1, url, params: { engine, engineLabel: 'Engine', query: 'tea', gl: null, hl: null, device: 'desktop', page: 1, offset: null, url } },
        outlines: false,
        intent: null,
        pack: PACK,
        paramNames,
      }) as SerpTabState;
    // On a known result page: both; it opens the SERP panel on the editor.
    const known = setup({}, { serp: pending(URL_A) });
    expect(known.ids()).toEqual(expect.arrayContaining(['serp.edit', 'serp.track']));
    expect(known.action('serp.edit').label).toBe('Edit search…');
    expect(known.action('serp.track').label).toBe('Track this search…');
    await known.action('serp.edit').run(known.ctx);
    expect(known.chrome.openPanel).toHaveBeenLastCalledWith('serp');
    expect(known.api.openEditor).toHaveBeenLastCalledWith(3, 'edit');
    await known.action('serp.track').run(known.ctx);
    expect(known.api.openEditor).toHaveBeenLastCalledWith(3, 'track');
    // A search a saved search cannot be: the reason, and nothing opens.
    const filtered = setup({ tab: tab({ url: 'https://www.google.com/search?q=tea&tbs=qdr:w' }) }, { serp: pending('https://www.google.com/search?q=tea&tbs=qdr:w') });
    await expect(Promise.resolve(filtered.action('serp.track').run(filtered.ctx))).resolves.toBe(TRACK_REFUSAL_MESSAGES.filters);
    const german = setup({ tab: tab({ url: 'https://www.google.de/search?q=tea' }) }, { serp: pending('https://www.google.de/search?q=tea') });
    await expect(Promise.resolve(german.action('serp.track').run(german.ctx))).resolves.toBe(TRACK_REFUSAL_MESSAGES.address);
    expect(german.api.openEditor).not.toHaveBeenCalled();
    // Another engine: editable only with the pack's names from main.
    expect(setup({}, { serp: pending('http://search.frost-e2e.net/find?q=tea', 'synthetic') }).ids()).not.toContain('serp.edit');
    expect(setup({}, { serp: pending('http://search.frost-e2e.net/find?q=tea', 'synthetic', { query: 'q', gl: 'gl', hl: null }) }).ids()).toContain('serp.edit');
    // Not on a page known not to be a result page, nor before the chrome has seen one.
    for (const context of [setup({}, { serp: serpState('not-serp') }), setup(), setup({ tab: undefined })]) {
      expect(context.ids()).not.toContain('serp.edit');
      expect(context.ids()).not.toContain('serp.track');
    }
  });

  test('serp-palette-ai-destinations', async () => {
    const IDS = AI_SEARCH_DESTINATIONS.map((d) => `serp.open-in-${d.id}`);
    // On a known result page (pending, ready, or unreadable with its parameters): one action per destination.
    for (const known of [serpState('pending'), serpState('ready', { serp: { status: 'ready', tabId: 3, documentSeq: 1, url: URL_A, readAt: 1, snapshot: { params: { engine: 'google', engineLabel: 'Google', query: 'tea', gl: null, hl: null, device: 'desktop', page: 1, offset: null, url: URL_A } } } as unknown as SerpTabState['serp'] })]) {
      expect(setup({}, { serp: known }).ids(), known.serp.status).toEqual(expect.arrayContaining(IDS));
    }
    // Not on a page known not to be a result page, before the chrome has seen one, without a tab,
    // on a non-web page, or for a state of another tab.
    for (const context of [setup({}, { serp: serpState('not-serp') }), setup(), setup({ tab: undefined }, { serp: serpState('pending') }), setup({ tab: tab({ url: 'about:blank' }) }, { serp: serpState('pending') }), setup({ tab: tab({ id: 4 }) }, { serp: serpState('pending') })]) {
      for (const id of IDS) expect(context.ids()).not.toContain(id);
    }
    const { ctx, action, api } = setup({}, { serp: serpState('pending') });
    for (const [index, destination] of AI_SEARCH_DESTINATIONS.entries()) {
      const item = action(`serp.open-in-${destination.id}`);
      expect(item.label).toBe(`Open search in ${destination.label}`);
      expect(item.group).toBe('open-in');
      // It asks first, with the note; nothing is called until it runs.
      const confirm = item.confirm!(ctx)!;
      expect(confirm.note).toBe(AI_DESTINATION_NOTE);
      expect(confirm.message).toContain(destination.label);
      expect(api.openDestination).toHaveBeenCalledTimes(index);
      // Running it names the tab and the table id only.
      await expect(Promise.resolve(item.run(ctx))).resolves.toBe(openDestinationMessage(destination, { status: 'opened', tabId: 11 }));
      expect(api.openDestination).toHaveBeenLastCalledWith(3, destination.id);
      expect((api.openDestination as ReturnType<typeof vi.fn>).mock.lastCall).toHaveLength(2);
    }
    expect(api.openDestination).toHaveBeenCalledTimes(AI_SEARCH_DESTINATIONS.length);
    // Main's refusals and an IPC failure are reported.
    const refused = setup({}, { serp: serpState('pending') });
    (refused.api.openDestination as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'refused', reason: 'no-tab' }).mockResolvedValueOnce({ status: 'refused', reason: 'no-search' }).mockResolvedValueOnce(null);
    const perplexity = () => refused.action('serp.open-in-perplexity');
    await expect(Promise.resolve(perplexity().run(refused.ctx))).resolves.toBe(OPEN_DESTINATION_REFUSAL_MESSAGES['no-tab']);
    await expect(Promise.resolve(perplexity().run(refused.ctx))).resolves.toBe(OPEN_DESTINATION_REFUSAL_MESSAGES['no-search']);
    await expect(Promise.resolve(perplexity().run(refused.ctx))).resolves.toBe(OPEN_DESTINATION_REFUSAL_MESSAGES['no-tab']);
  });
});
