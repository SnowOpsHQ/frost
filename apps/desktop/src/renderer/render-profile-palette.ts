import type { TabState } from '@app/specs/browser.spec';
import { QUICK_RENDER_PROFILES, renderProfileSummary, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// Render profiles in the command palette (spec `render-profile.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API). One action per `QUICK_RENDER_PROFILES` entry sets it
// on the active tab, as the editor bar's quick chips do; "Reset render profile" is offered only while
// the tab has a profile, and "Pin profile to this site" only while it has one not yet pinned on a web
// page. Registered from `components/RenderProfile.tsx`; pure (the procedures are injected) so the
// availability rules are unit tested.

/** The procedures the actions call (a subset of `actions` in `ipc.ts`). */
export interface RenderProfilePaletteApi {
  setRenderProfile(tabId: number, profile: RenderProfile, pin: boolean): Promise<boolean>;
  clearRenderProfile(tabId: number): Promise<boolean>;
}

/** What the status line says after a set or reset that main refused. */
export const RENDER_PROFILE_NOT_SET = 'The render profile was not changed' as const;

const KEYWORDS = ['render profile', 'emulate', 'emulation', 'device', 'user agent', 'network'];

/** Whether `tab` shows an `http(s)` page (a pin belongs to its site). */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url);

function quickActions(api: RenderProfilePaletteApi): PaletteAction[] {
  return QUICK_RENDER_PROFILES.map(
    (quick): PaletteAction => ({
      id: `render.quick.${quick.id}`,
      label: `Render as ${quick.label}`,
      group: 'page',
      keywords: KEYWORDS,
      icon: 'render-profile',
      detail: () => renderProfileSummary(quick.profile),
      // Any tab (one with no page yet loads its first page under it); not offered while the tab
      // already renders with exactly this profile.
      available: (ctx) => ctx.tab !== undefined && !(ctx.tab.renderProfile !== null && sameRenderProfile(ctx.tab.renderProfile.profile, quick.profile)),
      run: async (ctx) => {
        const tab = ctx.tab!;
        // As the quick chips: the tab's own profile (never this site's pin).
        const ok = await api.setRenderProfile(tab.id, quick.profile, false);
        return ok ? `Render profile: ${quick.label}` : RENDER_PROFILE_NOT_SET;
      },
    }),
  );
}

/** The palette's render-profile actions, calling `api`. */
export function renderProfilePaletteSources(api: RenderProfilePaletteApi): PaletteSource[] {
  return [
    ...quickActions(api),
    {
      id: 'render.reset',
      label: 'Reset render profile',
      group: 'page',
      keywords: [...KEYWORDS, 'default', 'clear', 'unpin'],
      icon: 'render-profile',
      detail: (ctx) => (ctx.tab?.renderProfile ? renderProfileSummary(ctx.tab.renderProfile.profile) : null),
      available: (ctx) => ctx.tab !== undefined && ctx.tab.renderProfile !== null,
      run: async (ctx) => {
        const ok = await api.clearRenderProfile(ctx.tab!.id);
        return ok ? 'Render profile reset' : RENDER_PROFILE_NOT_SET;
      },
    },
    {
      id: 'render.pin',
      label: 'Pin profile to this site',
      group: 'page',
      keywords: [...KEYWORDS, 'pin', 'site', 'remember'],
      icon: 'render-profile',
      detail: (ctx) => (ctx.tab?.renderProfile ? renderProfileSummary(ctx.tab.renderProfile.profile) : null),
      available: (ctx) => onWebPage(ctx.tab) && ctx.tab.renderProfile !== null && !ctx.tab.renderProfile.pinned,
      run: async (ctx) => {
        const tab = ctx.tab!;
        const ok = await api.setRenderProfile(tab.id, tab.renderProfile!.profile, true);
        return ok ? 'Render profile pinned to this site' : RENDER_PROFILE_NOT_SET;
      },
    },
  ];
}
