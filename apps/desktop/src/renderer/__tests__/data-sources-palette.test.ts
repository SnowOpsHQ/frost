// Spec: specs/command-palette.spec.ts (Registration API, PALETTE_ACTION_ID_PATTERN), specs/data-sources.spec.ts (DATA_CHECK_TEXT,
// DATA_PROVIDER_LABELS)
// Acceptance: specs/data-sources.feature.md (Check via API: api-check-palette-command), specs/projects.feature.md
// (Checking searches via a data API) · plan docs/plans/phase-12-big-bets.md, Task 4
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';
import { PALETTE_ACTION_ID_PATTERN } from '@app/specs/command-palette.spec';
import { DATA_CHECK_TEXT, type DataSerpProvider } from '@app/specs/data-sources.spec';
import type { DataSerpProviderView } from '@app/specs/data-sources.schema';
import { PROVIDER_REFRESH_MS, createSerpProviderCache, dataSourcesPaletteSources, onApiCheckRequest, requestApiCheck, takeApiCheckRequest } from '../data-sources-palette';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { projectsPaletteSources, retentionPaletteSources } from '../projects-palette';

const P1 = '01920000-0000-7000-8000-0000000000a1';
const state = { version: 1, tabs: [], activeTabId: null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null } as unknown as BrowserState;
const ctx: PaletteContext = { state, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } } as unknown as PaletteContext;

function setup(provider: DataSerpProvider | null, lastProject: string | undefined) {
  const api = { provider: vi.fn(() => provider), refresh: vi.fn(), lastProject: vi.fn(() => lastProject), openCheck: vi.fn() };
  const registry = createPaletteRegistry();
  // With the projects' own actions: no id is offered twice.
  registry.register(...projectsPaletteSources({ open: vi.fn(), lastProject: () => lastProject, startRun: vi.fn(async () => null) }, { rankCheckAvailable: true }), ...retentionPaletteSources({ open: vi.fn(), lastProject: () => lastProject, purgeNow: vi.fn(async () => null), compact: vi.fn(async () => null) }), ...dataSourcesPaletteSources(api));
  const mine = () => registry.resolve(ctx).filter((action) => action.id === 'data-sources.check-searches');
  return { api, registry, mine };
}

describe('data sources palette', () => {
  test('api-check-palette-command', async () => {
    // Offered only while main's view names a vendor and a project was opened.
    expect(setup(null, P1).mine()).toEqual([]);
    expect(setup('serpapi', undefined).mine()).toEqual([]);
    const { api, mine, registry } = setup('serpapi', P1);
    const [action] = mine();
    expect(action).toMatchObject({ id: 'data-sources.check-searches', label: 'Check searches via SerpApi', group: 'page', focus: 'handler' });
    expect(PALETTE_ACTION_ID_PATTERN.test(action!.id)).toBe(true);
    expect(setup('dataforseo', P1).mine()[0]!.label).toBe(DATA_CHECK_TEXT.palette('DataForSEO'));
    const ids = registry.resolve(ctx).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Each listing asks main again (the cache throttles it).
    expect(api.refresh).toHaveBeenCalled();
    // It never sends: it opens the project's Rankings view on the confirm.
    expect(await action!.run(ctx)).toBeNull();
    expect(api.openCheck).toHaveBeenCalledWith(P1);
  });

  test('serp-provider-cache-reads-main-throttled', async () => {
    let at = 1_000_000;
    const read = vi.fn(async (): Promise<DataSerpProviderView | null> => ({ provider: 'serper', choices: ['serper'] }));
    const cache = createSerpProviderCache(read, () => at);
    expect(cache.current()).toBeNull();
    cache.refresh();
    cache.refresh();
    await vi.waitFor(() => expect(cache.current()).toBe('serper'));
    expect(read).toHaveBeenCalledTimes(1);
    // Again only after the interval; a failed or odd answer is "none".
    at += PROVIDER_REFRESH_MS;
    read.mockRejectedValueOnce(new Error('ipc'));
    cache.refresh();
    await vi.waitFor(() => expect(cache.current()).toBeNull());
    at += PROVIDER_REFRESH_MS;
    read.mockResolvedValueOnce({ provider: 'perplexity', choices: [] } as unknown as DataSerpProviderView);
    cache.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(cache.current()).toBeNull();
    // A read that throws at once is caught too.
    at += PROVIDER_REFRESH_MS;
    const broken = createSerpProviderCache(() => {
      throw new TypeError('no ipc');
    });
    expect(() => broken.refresh()).not.toThrow();
  });

  test('api-check-request-is-taken-once', () => {
    const heard = vi.fn();
    const off = onApiCheckRequest(heard);
    requestApiCheck(P1);
    expect(heard).toHaveBeenCalledOnce();
    expect(takeApiCheckRequest('01920000-0000-7000-8000-0000000000ff')).toBe(false);
    expect(takeApiCheckRequest(P1)).toBe(true);
    expect(takeApiCheckRequest(P1)).toBe(false);
    off();
    requestApiCheck(P1);
    expect(heard).toHaveBeenCalledOnce();
    expect(takeApiCheckRequest(P1)).toBe(true);
  });
});
