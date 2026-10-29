import type { TabState } from '@app/specs/browser.spec';
import type { GscQueryScope } from '@app/specs/gsc.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// The Search Console panel in the command palette (Phase 4 Task 10; acceptance `gsc-panel.feature.md`,
// Palette; `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Search Console
// panel" (the panel's jump, owned here), and "Search Console: whole property" / "Search Console: this
// page", which set the panel's scope and open it. Registered from `components/seo/GscPanel.tsx`; pure
// (the scope store is injected) so availability is unit tested.

export interface GscPaletteApi {
  scope(): GscQueryScope;
  setScope(scope: GscQueryScope): void;
}

const KEYWORDS = ['search console', 'gsc', 'google', 'clicks', 'impressions', 'ctr', 'position', 'performance', 'traffic', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

function scopeAction(api: GscPaletteApi, scope: GscQueryScope): PaletteAction {
  return {
    id: scope === 'property' ? 'search-console.whole-property' : 'search-console.this-page',
    label: scope === 'property' ? 'Search Console: whole property' : 'Search Console: this page',
    group: 'panels',
    keywords: [...KEYWORDS, scope === 'property' ? 'site' : 'page', 'scope'],
    icon: 'panel-search-console',
    available: (ctx) => onWebPage(ctx.tab) && api.scope() !== scope,
    run: (ctx) => {
      api.setScope(scope);
      ctx.chrome.openPanel('search-console', { focus: false });
    },
  };
}

/** The palette's Search Console actions, using `api` for the panel's scope. */
export function gscPaletteSources(api: GscPaletteApi): PaletteSource[] {
  return [
    {
      id: 'panel.search-console',
      label: 'Open Search Console panel',
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'sidebar'],
      icon: 'panel-search-console',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('search-console', { focus: true }),
    },
    scopeAction(api, 'property'),
    scopeAction(api, 'page'),
  ];
}
