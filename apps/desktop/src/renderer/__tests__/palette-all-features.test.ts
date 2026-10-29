// Spec: specs/command-palette.spec.ts (Registration API, FEATURE_PANEL_JUMPS)
// Acceptance: specs/command-palette.feature.md (Registry); Phase 2.5 Batch B integration: every
// feature's actions register together, and no action id is offered twice.
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { browserPolishPaletteSources } from '../browser-polish-palette';
import { checksPaletteSources } from '../checks-palette';
import { contentPaletteSources } from '../content-palette';
import { devtoolsPaletteSources } from '../devtools-palette';
import { gscPaletteSources } from '../gsc-palette';
import { javascriptPaletteSources } from '../javascript-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext, type PaletteSource } from '../palette/registry';
import { renderProfilePaletteSources } from '../render-profile-palette';
import { serpPaletteSources } from '../serp-palette';

const URL_A = 'https://www.example.com/a';
const READY: SeoAuditResponse = { status: 'ready', url: URL_A, audit: { url: URL_A, takenAt: 1, schema: { blocks: [] } } as unknown as SeoAudit };

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: URL_A, title: 'A', loading: false, canGoBack: true, canGoForward: true, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

/** Every feature's palette sources, as the chrome registers them (with inert fakes for their procedures). */
function everySource(): PaletteSource[] {
  const yes = vi.fn(async () => true);
  return [
    ...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi),
    ...renderProfilePaletteSources({ setRenderProfile: yes, clearRenderProfile: yes }),
    ...contentPaletteSources({ copySnippetHtml: yes, clearAllNotes: yes }),
    ...javascriptPaletteSources({ refetchServed: yes }),
    ...devtoolsPaletteSources(() => undefined),
    ...browserPolishPaletteSources({ openFind: yes, reopenClosedTab: vi.fn(async () => 1), showHistory: yes, setSearchEngine: yes }),
    ...checksPaletteSources({ checkLinks: yes, checkSitemaps: yes, checkHreflang: yes, stop: yes, known: () => undefined }),
    ...serpPaletteSources({ setOutlines: yes, checkPackUpdate: vi.fn(async () => 'not-newer' as const), enableIntent: vi.fn(async () => 'ready' as const), refreshIntent: yes, runProbes: yes, stopProbes: yes, knownSerp: () => undefined, knownProbes: () => undefined, knownIntent: () => undefined }),
    ...gscPaletteSources({ scope: () => 'page', setScope: vi.fn() }),
  ];
}

describe('palette actions of every feature', () => {
  test('palette-features-register-together', () => {
    const sources = everySource();
    const registry = createPaletteRegistry();
    // A duplicate static id would throw here (as at the chrome's module load).
    expect(() => registry.register(...sources)).not.toThrow();
    const active = tab();
    const state = { version: 1, tabs: [active], activeTabId: active.id, focusAddressBarSeq: 0, toggleSidebarSeq: 0, devtoolsToggleSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null, find: null, historyViewSeq: 0, closedTabCount: 1, searchEngine: 'google' } as BrowserState;
    const ctx: PaletteContext = { state, tab: active, audit: READY, sidebarOpen: true, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };
    // Every id any source offers, static or for this context: none twice (the registry would drop a dynamic duplicate silently).
    const offered = sources.flatMap((source) => (typeof source === 'function' ? source(ctx).map((action) => action.id) : [source.id]));
    const repeated = offered.filter((id, index) => offered.indexOf(id) !== index);
    expect(repeated).toEqual([]);
    // Each Batch B feature is there.
    const shown = registry.resolve(ctx).map((action) => action.id);
    for (const prefix of ['javascript.', 'devtools.', 'checks.', 'panel.javascript']) expect(shown.some((id) => id.startsWith(prefix)), prefix).toBe(true);
    expect(shown.some((id) => /find|history|reopen|search/.test(id))).toBe(true);
  });
});
