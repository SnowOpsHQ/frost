// Spec: specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API)
// Acceptance: specs/seo-content.feature.md (Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { contentPaletteSources, onTargetQueryFocus, requestTargetQueryFocus, takeTargetQueryFocus, TARGET_QUERY_FOCUS_WINDOW_MS, type ContentPaletteApi } from '../content-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';
const TAKEN_AT = 1_760_000_000_000;

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function ready(page: { title?: string | null; description?: string | null } = {}): SeoAuditResponse {
  const title = page.title === undefined ? 'Tea, brewed well' : page.title;
  const description = page.description === undefined ? 'How to brew tea.' : page.description;
  const audit = {
    url: URL_A,
    takenAt: TAKEN_AT,
    page: { url: URL_A, title: title === null ? null : { text: title, length: title.length }, description: description === null ? null : { text: description, length: description.length } },
  } as unknown as SeoAudit;
  return { status: 'ready', url: URL_A, audit };
}

function setup(context: Partial<PaletteContext> = {}, answer = true) {
  const api = { copySnippetHtml: vi.fn(async () => answer), clearAllNotes: vi.fn(async () => answer) } satisfies ContentPaletteApi;
  const registry = createPaletteRegistry();
  registry.register(...contentPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state, tab: active, audit: ready(), sidebarOpen: false, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => registry.resolve(ctx).find((a) => a.id === id) ?? expect.fail(`${id} not available`);
  return { api, ctx, ids, get, chrome, registry };
}

describe('content palette actions', () => {
  test('palette-content-actions', async () => {
    const { api, ctx, ids, get, chrome } = setup();
    expect(ids()).toEqual(['panel.content', 'content.target-query', 'copy.snippet-html', 'content.delete-all-notes']);
    expect(get('panel.content')).toMatchObject({ label: 'Open Content panel', group: 'panels', focus: 'handler' });
    expect(get('content.target-query')).toMatchObject({ label: 'Set target query…', group: 'panels', focus: 'handler' });
    expect(get('copy.snippet-html')).toMatchObject({ label: 'Copy snippet as HTML', group: 'copy' });

    await get('panel.content').run(ctx);
    expect(chrome.openPanel).toHaveBeenLastCalledWith('content', { focus: true });

    takeTargetQueryFocus();
    await get('content.target-query').run(ctx);
    expect(chrome.openPanel).toHaveBeenLastCalledWith('content');
    expect(takeTargetQueryFocus()).toBe(true);

    // Copy as HTML: the page's own title and description of the shown audit, through main.
    expect(await get('copy.snippet-html').run(ctx)).toBe('Snippet copied as HTML');
    expect(api.copySnippetHtml).toHaveBeenCalledWith(3, { url: URL_A, takenAt: TAKEN_AT }, null);
    const refused = setup({}, false);
    expect(await refused.get('copy.snippet-html').run(refused.ctx)).toBe('Nothing was copied');
  });

  test('palette-content-availability', () => {
    // The jump is always offered (as every panel jump).
    expect(setup({ tab: undefined, audit: null }).ids()).toEqual(['panel.content', 'content.delete-all-notes']);
    expect(setup({ tab: tab({ url: '', title: '' }), audit: null }).ids()).toEqual(['panel.content', 'content.delete-all-notes']);
    // A web page whose audit is not ready yet, an error page, a non-web page: no query, no copy.
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).toEqual(['panel.content', 'content.delete-all-notes']);
    expect(setup({ tab: tab({ error: { code: -105, description: 'NAME_NOT_RESOLVED', url: URL_A } }) }).ids()).toEqual(['panel.content', 'content.delete-all-notes']);
    expect(setup({ tab: tab({ url: 'app://app/start' }) }).ids()).toEqual(['panel.content', 'content.delete-all-notes']);
    // The copy needs a title or a description.
    expect(setup({ audit: ready({ title: null, description: null }) }).ids()).toEqual(['panel.content', 'content.target-query', 'content.delete-all-notes']);
    expect(setup({ audit: ready({ title: '', description: null }) }).ids()).not.toContain('copy.snippet-html');
    expect(setup({ audit: ready({ title: null }) }).ids()).toContain('copy.snippet-html');
    expect(setup({ audit: ready({ description: null }) }).ids()).toContain('copy.snippet-html');
  });

  test('content-owns-its-panel-jump', () => {
    // FEATURE_PANEL_JUMPS: the built-ins leave the Content jump to this feature, so both register
    // in one registry (no duplicate id) and there is exactly one row for it.
    expect(FEATURE_PANEL_JUMPS).toContain('content');
    const { registry, ctx } = setup();
    registry.register(...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => undefined) }) as PaletteApi));
    expect(registry.resolve(ctx).filter((a) => a.id === 'panel.content').map((a) => a.label)).toEqual(['Open Content panel']);
  });

  // Phase 2.5 Task 3 review: "Delete all content notes…" (main confirms, then deletes).
  test('palette-delete-all-notes', async () => {
    const { api, ctx, get } = setup();
    const action = get('content.delete-all-notes');
    expect(action).toMatchObject({ label: 'Delete all content notes…', group: 'browser' });
    expect(await action.run(ctx)).toBe('Content notes deleted');
    expect(api.clearAllNotes).toHaveBeenCalledOnce();
    const kept = setup({ tab: undefined, audit: null }, false);
    expect(await kept.get('content.delete-all-notes').run(kept.ctx)).toBe('Nothing was deleted');
  });

  test('target-query-focus-request', () => {
    takeTargetQueryFocus();
    const heard = vi.fn();
    const stop = onTargetQueryFocus(heard);
    requestTargetQueryFocus(1_000);
    expect(heard).toHaveBeenCalledOnce();
    // Taken once.
    expect(takeTargetQueryFocus(1_000 + TARGET_QUERY_FOCUS_WINDOW_MS)).toBe(true);
    expect(takeTargetQueryFocus(1_000 + TARGET_QUERY_FOCUS_WINDOW_MS)).toBe(false);
    // A stale request never takes focus later.
    requestTargetQueryFocus(5_000);
    expect(takeTargetQueryFocus(5_000 + TARGET_QUERY_FOCUS_WINDOW_MS + 1)).toBe(false);
    stop();
    requestTargetQueryFocus(9_000);
    expect(heard).toHaveBeenCalledTimes(2);
    takeTargetQueryFocus();
  });
});
