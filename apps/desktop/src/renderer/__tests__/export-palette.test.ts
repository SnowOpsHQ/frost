// Spec: specs/seo-exports.spec.ts (SEO_EXPORT_KINDS, SEO_EXPORT_LABELS), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/seo-exports.feature.md (Panels and palette)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { exportPaletteSources, exportStatus, type ExportPaletteApi } from '../export-palette';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';

const URL_A = 'https://www.example.com/a';
const TAKEN_AT = 1_760_000_000_000;

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', highlightPhrase: null, renderProfile: null, ...changes };
}

function ready(changes: { images?: { alt: unknown }[]; headings?: number; performance?: boolean } = {}): SeoAuditResponse {
  const audit = {
    url: URL_A,
    takenAt: TAKEN_AT,
    page: { imageList: changes.images ?? [{ alt: null }, { alt: { text: 'x', length: 1 } }], headings: Array.from({ length: changes.headings ?? 2 }, () => ({ level: 2, text: 'H' })) },
    performance: changes.performance === false ? null : {},
  } as unknown as SeoAudit;
  return { status: 'ready', url: URL_A, audit };
}

function setup(context: Partial<PaletteContext> = {}, answer: number | null | 'failed' = 2) {
  const api = { copySeoCsv: vi.fn(async () => answer) } satisfies ExportPaletteApi;
  const registry = createPaletteRegistry();
  registry.register(...exportPaletteSources(api));
  const active = 'tab' in context ? context.tab : tab();
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
  const ctx: PaletteContext = { state, tab: active, audit: ready(), sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() }, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => registry.resolve(ctx).find((a) => a.id === id) ?? expect.fail(`${id} not available`);
  return { api, ctx, ids, get };
}

const ALL = ['export.images', 'export.images-missing-alt', 'export.headings', 'export.speed'];

describe('export palette actions', () => {
  test('export-actions-need-the-shown-audit-and-rows', () => {
    expect(setup().ids()).toEqual(ALL);
    // No ready audit, or not a web page: none.
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).toEqual([]);
    expect(setup({ tab: tab({ url: 'app://app/newtab' }) }).ids()).toEqual([]);
    expect(setup({ tab: tab({ error: { code: -105, description: 'x', url: URL_A } as unknown as TabState['error'] }) }).ids()).toEqual([]);
    // Nothing to export: that action is left out (no images missing alt, no headings, no speed report).
    expect(setup({ audit: ready({ images: [{ alt: { text: 'x', length: 1 } }] }) }).ids()).not.toContain('export.images-missing-alt');
    expect(setup({ audit: ready({ headings: 0 }) }).ids()).not.toContain('export.headings');
    expect(setup({ audit: ready({ performance: false }) }).ids()).not.toContain('export.speed');
  });

  test('export-actions-call-main-with-the-shown-ref', async () => {
    const { api, ctx, get } = setup();
    const shown = { url: URL_A, takenAt: TAKEN_AT };
    expect(await get('export.images').run(ctx)).toBe('Copied 2 images as CSV');
    expect(api.copySeoCsv).toHaveBeenLastCalledWith(3, shown, 'images', undefined);
    await get('export.images-missing-alt').run(ctx);
    expect(api.copySeoCsv).toHaveBeenLastCalledWith(3, shown, 'images', 'missing-alt');
    await get('export.headings').run(ctx);
    expect(api.copySeoCsv).toHaveBeenLastCalledWith(3, shown, 'headings', undefined);
    await get('export.speed').run(ctx);
    expect(api.copySeoCsv).toHaveBeenLastCalledWith(3, shown, 'speed', undefined);
    // Main wrote nothing (the audit changed): the status line says so.
    const stale = setup({}, null);
    expect(await stale.get('export.headings').run(stale.ctx)).toBe('Nothing copied: the audit changed');
    // Speed too: its action exists only with a measurement, so `null` means the audit changed.
    expect(await stale.get('export.speed').run(stale.ctx)).toBe('Nothing copied: the audit changed');
    // An IPC failure is not reported as a changed audit.
    const failed = setup({}, 'failed');
    expect(await failed.get('export.images').run(failed.ctx)).toBe('Couldn’t copy');
    expect(exportStatus('headings', 1)).toBe('Copied 1 heading as CSV');
    expect(exportStatus('images', 1_234)).toBe('Copied 1,234 images as CSV');
  });
});
