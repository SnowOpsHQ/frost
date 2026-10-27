// Spec: specs/browser-polish.spec.ts (SEARCH_ENGINES, SEARCH_ENGINE_SET_MESSAGE, FIND_SHORTCUT, REOPEN_TAB_SHORTCUT, HISTORY_SHORTCUT),
// specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/browser-polish.feature.md (Palette, History view, New-tab page)
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { SEARCH_ENGINE_SET_MESSAGE } from '@app/specs/browser-polish.spec';
import { browserPolishPaletteSources, REOPEN_NOTHING, SEARCH_ENGINE_NOT_SET, type BrowserPolishPaletteApi } from '../browser-polish-palette';
import { appendPage, dayLabel, groupByDay, monogram, visitLabel } from '../history-view';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 4, url: 'https://www.example.com/a', title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function setup(active: TabState | undefined, extra: Partial<BrowserState> = {}, answers: { reopen?: number | null; engine?: boolean } = {}) {
  const api = {
    openFind: vi.fn(async () => null),
    reopenClosedTab: vi.fn(async () => (answers.reopen === undefined ? 7 : answers.reopen)),
    showHistory: vi.fn(async () => null),
    setSearchEngine: vi.fn(async () => answers.engine ?? true),
  } satisfies BrowserPolishPaletteApi;
  const registry = createPaletteRegistry();
  registry.register(...browserPolishPaletteSources(api));
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null, ...extra };
  const ctx: PaletteContext = { state, tab: active, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => registry.resolve(ctx).find((a) => a.id === id) ?? expect.fail(`${id} not available`);
  return { api, ctx, ids, get };
}

describe('browser polish palette actions', () => {
  test('polish-palette-availability', async () => {
    // A page: find; no closed tab: no reopen; the default engine (Google) is in use.
    const plain = setup(tab(), { closedTabCount: 0, searchEngine: 'google' });
    expect(plain.ids()).toEqual(['page.find', 'browser.history', 'settings.search-engine.bing', 'settings.search-engine.duckduckgo']);
    // No find on an empty tab or an error / crash panel.
    expect(setup(tab({ url: '' })).ids()).not.toContain('page.find');
    expect(setup(tab({ crashed: true })).ids()).not.toContain('page.find');
    expect(setup(tab({ error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: 'https://x.example/' } })).ids()).not.toContain('page.find');
    // A closed tab: reopen; another engine in use: Google is offered.
    const later = setup(tab(), { closedTabCount: 2, searchEngine: 'duckduckgo' });
    expect(later.ids()).toEqual(['page.find', 'tab.reopen-closed', 'browser.history', 'settings.search-engine.google', 'settings.search-engine.bing']);
    // Without the new state fields (an older main): the default engine, no reopen.
    expect(setup(tab()).ids()).not.toContain('settings.search-engine.google');

    const find = plain.get('page.find');
    expect(find.shortcut).toBe('Mod+F');
    expect(find.focus).toBe('handler');
    await find.run(plain.ctx);
    expect(plain.api.openFind).toHaveBeenCalledOnce();
    await plain.get('browser.history').run(plain.ctx);
    expect(plain.api.showHistory).toHaveBeenCalledOnce();
    expect(await later.get('tab.reopen-closed').run(later.ctx)).toBeNull();
    const none = setup(tab(), { closedTabCount: 1 }, { reopen: null });
    expect(await none.get('tab.reopen-closed').run(none.ctx)).toBe(REOPEN_NOTHING);
    expect(await plain.get('settings.search-engine.duckduckgo').run(plain.ctx)).toBe(SEARCH_ENGINE_SET_MESSAGE.replace('{engine}', 'DuckDuckGo'));
    expect(plain.api.setSearchEngine).toHaveBeenCalledWith('duckduckgo');
    const refused = setup(tab(), {}, { engine: false });
    expect(await refused.get('settings.search-engine.bing').run(refused.ctx)).toBe(SEARCH_ENGINE_NOT_SET);
  });
});

describe('history view helpers', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
  const visit = (url: string, lastVisitAt: number, title = '') => ({ url, title, visitCount: 1, lastVisitAt });

  test('history-groups-by-local-day', () => {
    const now = at(2026, 10, 27, 15);
    expect(dayLabel(at(2026, 10, 27, 1), now)).toBe('Today');
    expect(dayLabel(at(2026, 10, 26, 23), now)).toBe('Yesterday');
    expect(dayLabel(at(2026, 10, 20), now, 'en-US')).toBe('Tuesday, October 20, 2026');
    const days = groupByDay([visit('https://a.example/', at(2026, 10, 27, 9)), visit('https://b.example/', at(2026, 10, 27, 8)), visit('https://c.example/', at(2026, 10, 25))], now, 'en-US');
    expect(days.map((d) => [d.label, d.visits.length])).toEqual([
      ['Today', 2],
      ['Sunday, October 25, 2026', 1],
    ]);
  });

  test('history-labels-are-text', () => {
    expect(visitLabel(visit('https://www.example.com/x', 1, '  '))).toBe('www.example.com');
    expect(visitLabel(visit('https://www.example.com/x', 1, '<b>Tea</b>'))).toBe('<b>Tea</b>');
    expect(monogram('https://www.example.com/')).toBe('E');
    // The host as the URL serializes it (an IDN is punycode).
    expect(monogram('https://ünicode.example/')).toBe('X');
    expect(monogram('http://127.0.0.1:8080/')).toBe('1');
    expect(monogram('not a url')).toBe('?');
    // A later page never lists a URL twice.
    expect(appendPage([visit('https://a.example/', 2)], [visit('https://a.example/', 1), visit('https://b.example/', 1)]).map((v) => v.url)).toEqual(['https://a.example/', 'https://b.example/']);
  });
});
