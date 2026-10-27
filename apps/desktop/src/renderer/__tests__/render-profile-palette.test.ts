// Spec: specs/render-profile.spec.ts (QUICK_RENDER_PROFILES), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/render-profile.feature.md (Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES, type TabRenderProfile } from '@app/specs/render-profile.spec';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';
import { RENDER_PROFILE_NOT_SET, renderProfilePaletteSources, type RenderProfilePaletteApi } from '../render-profile-palette';

const PHONE_BOT = QUICK_RENDER_PROFILES.find((q) => q.id === 'googlebot-smartphone')!;

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 4, url: 'https://www.example.com/a', title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

const profiled = (over: Partial<TabRenderProfile> = {}): TabRenderProfile => ({ profile: PHONE_BOT.profile, source: 'tab', pinned: false, needsReload: false, status: 'active', ...over });

function setup(active: TabState | undefined, answer = true) {
  const api = {
    setRenderProfile: vi.fn(async () => answer),
    clearRenderProfile: vi.fn(async () => answer),
  } satisfies RenderProfilePaletteApi;
  const registry = createPaletteRegistry();
  registry.register(...renderProfilePaletteSources(api));
  const state: BrowserState = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
  const ctx: PaletteContext = { state, tab: active, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => registry.resolve(ctx).find((a) => a.id === id) ?? expect.fail(`${id} not available`);
  return { api, ctx, ids, get };
}

describe('render-profile palette actions', () => {
  test('palette-render-quick-profiles', async () => {
    const { api, ctx, ids, get } = setup(tab());
    expect(ids()).toEqual(QUICK_RENDER_PROFILES.map((q) => `render.quick.${q.id}`));
    for (const quick of QUICK_RENDER_PROFILES) {
      const action = get(`render.quick.${quick.id}`);
      expect(action.group).toBe('page');
      expect(action.label).toBe(`Render as ${quick.label}`);
      expect(await action.run(ctx)).toBe(`Render profile: ${quick.label}`);
      // The tab's own profile, never this site's pin.
      // The tab's own profile; the site's pin, if any, is left as it is (`pin` left out).
      expect(api.setRenderProfile).toHaveBeenLastCalledWith(4, quick.profile);
    }
    // Refused by main: the status line says nothing changed.
    const refused = setup(tab(), false);
    expect(await refused.get(`render.quick.${PHONE_BOT.id}`).run(refused.ctx)).toBe(RENDER_PROFILE_NOT_SET);
  });

  test('palette-render-availability', async () => {
    // No tab yet: nothing.
    expect(setup(undefined).ids()).toEqual([]);
    // No profile: no Reset, no Pin.
    const plain = setup(tab()).ids();
    expect(plain).not.toContain('render.reset');
    expect(plain).not.toContain('render.pin');
    // An empty tab can take a quick profile (its first load carries it), but has no site to pin to.
    expect(setup(tab({ url: '', title: '' })).ids()).toContain(`render.quick.${PHONE_BOT.id}`);
    expect(setup(tab({ url: '', title: '', renderProfile: profiled() })).ids()).not.toContain('render.pin');

    // With a profile: Reset and Pin; the quick profile it already has is not offered again.
    const withProfile = setup(tab({ renderProfile: profiled() }));
    expect(withProfile.ids()).toEqual(expect.arrayContaining(['render.reset', 'render.pin']));
    expect(withProfile.ids()).not.toContain(`render.quick.${PHONE_BOT.id}`);
    expect(withProfile.ids()).toContain('render.quick.no-javascript');
    expect(await withProfile.get('render.reset').run(withProfile.ctx)).toBe('Render profile reset');
    expect(withProfile.api.clearRenderProfile).toHaveBeenCalledWith(4);
    expect(await withProfile.get('render.pin').run(withProfile.ctx)).toBe('Render profile pinned to this site');
    expect(withProfile.api.setRenderProfile).toHaveBeenCalledWith(4, PHONE_BOT.profile, true);
    expect(withProfile.get('render.reset').detail?.(withProfile.ctx)).toBe('Phone 412×915 · Googlebot smartphone');

    // Already this site's pin (its own, or taken from the site): no Pin, still Reset.
    for (const state of [profiled({ pinned: true }), profiled({ source: 'site', pinned: true })]) {
      const pinned = setup(tab({ renderProfile: state })).ids();
      expect(pinned).toContain('render.reset');
      expect(pinned).not.toContain('render.pin');
    }
    // A custom profile is not a quick one: every quick profile is offered.
    const custom = setup(tab({ renderProfile: profiled({ profile: { ...DEFAULT_RENDER_PROFILE, cacheDisabled: true } }) })).ids();
    for (const quick of QUICK_RENDER_PROFILES) expect(custom).toContain(`render.quick.${quick.id}`);
  });
});
