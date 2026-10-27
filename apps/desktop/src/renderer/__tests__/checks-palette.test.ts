// Spec: specs/command-palette.spec.ts (Registration API, PALETTE_GROUPS), specs/seo-checks.spec.ts (ChecksState)
// Acceptance: specs/seo-checks.feature.md (Panels and palette)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { IDLE_HREFLANG_RUN, IDLE_LINK_RUN, IDLE_SITEMAP_RUN, type ChecksState } from '@app/specs/seo-checks.spec';
import { CHECKS_PALETTE_DETAIL, checksPaletteSources, type ChecksPaletteApi } from '../checks-palette';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function ready(links = 2, hreflang = 0): SeoAuditResponse {
  const audit = { url: URL_A, takenAt: 1, page: { linkList: Array.from({ length: links }, () => ({})) }, indexability: { hreflang: { entries: Array.from({ length: hreflang }, () => ({})) } } } as unknown as SeoAudit;
  return { status: 'ready', url: URL_A, audit };
}

function setup(context: Partial<PaletteContext> = {}, known?: ChecksState) {
  const api = { checkLinks: vi.fn(async () => true), checkSitemaps: vi.fn(async () => false), checkHreflang: vi.fn(async () => true), stop: vi.fn(async () => true), known: vi.fn(() => known) } satisfies ChecksPaletteApi;
  const registry = createPaletteRegistry();
  registry.register(...checksPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: ready(), sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => registry.resolve(ctx).find((a) => a.id === id) ?? expect.fail(`${id} not available`);
  return { api, ctx, ids, get, chrome };
}

describe('checks palette actions', () => {
  test('palette-checks-actions', async () => {
    const { api, ctx, ids, get, chrome } = setup();
    expect(ids()).toEqual(['checks.links', 'checks.sitemaps']);
    expect(get('checks.links')).toMatchObject({ label: 'Check links', group: 'audit', focus: 'handler' });
    // The palette says the sites can see the requests, as every check surface does.
    for (const id of ['checks.links', 'checks.sitemaps']) expect(get(id).detail?.(ctx)).toBe(CHECKS_PALETTE_DETAIL);
    await expect(get('checks.links').run(ctx)).resolves.toBe('Checking links');
    expect(chrome.openPanel).toHaveBeenLastCalledWith('links');
    expect(api.checkLinks).toHaveBeenCalledWith(3);
    await expect(get('checks.sitemaps').run(ctx)).resolves.toBe('The sitemap check could not start');
    expect(chrome.openPanel).toHaveBeenLastCalledWith('indexability');

    // hreflang needs annotations; Stop needs a running link check.
    const running: ChecksState = { version: 1, tabId: 3, url: URL_A, links: { ...IDLE_LINK_RUN, status: 'running' }, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN };
    const more = setup({ audit: ready(2, 3) }, running);
    expect(more.ids()).toEqual(['checks.links', 'checks.links-stop', 'checks.sitemaps', 'checks.hreflang']);
    await expect(more.get('checks.links-stop').run(more.ctx)).resolves.toBe('Link check stopped');
    expect(more.api.stop).toHaveBeenCalledWith(3, 'links');
    await expect(more.get('checks.hreflang').run(more.ctx)).resolves.toBe('Checking hreflang return links');

    // No web page, no ready audit or no links: not offered.
    expect(setup({ tab: tab({ url: 'about:blank' }) }).ids()).toEqual([]);
    expect(setup({ tab: tab({ crashed: true }) }).ids()).toEqual([]);
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).toEqual([]);
    expect(setup({ audit: ready(0) }).ids()).toEqual(['checks.sitemaps']);
  });
});
