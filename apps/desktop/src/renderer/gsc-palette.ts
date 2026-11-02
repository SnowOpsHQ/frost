import type { TabState } from '@app/specs/browser.spec';
import type { GscQueryScope, GscStatus } from '@app/specs/gsc.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// The Search Console panel in the command palette (Phase 4 Task 10; acceptance `gsc-panel.feature.md`,
// Palette; `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Search Console
// panel" (the panel's jump, owned here), and "Search Console: whole property" / "Search Console: this
// page", which set the panel's scope and open it; "Search Console: clear filters" (Phase 9 Task 3),
// offered while a country or device filter is set. Registered from `components/seo/GscPanel.tsx`;
// pure (the prefs store is injected) so availability is unit tested. "Inspect this page in Search
// Console" (Phase 9 Task 4; `gsc-inspection.feature.md`, Palette) asks Google's URL Inspection for the
// page and opens Indexability, where "Google's view" shows the answer; registered from
// `components/seo/GscInspectionCard.tsx`.

export interface GscPaletteApi {
  scope(): GscQueryScope;
  setScope(scope: GscQueryScope): void;
  /** A country or device filter is set. */
  filtered(): boolean;
  clearFilters(): void;
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
    {
      id: 'search-console.clear-filters',
      label: 'Search Console: clear filters',
      group: 'panels',
      keywords: [...KEYWORDS, 'filter', 'country', 'device', 'reset'],
      icon: 'panel-search-console',
      available: (ctx) => onWebPage(ctx.tab) && api.filtered(),
      run: (ctx) => {
        api.clearFilters();
        ctx.chrome.openPanel('search-console', { focus: false });
      },
    },
  ];
}

export interface GscInspectPaletteApi {
  /** `gsc.watch` as last answered (`null`: not yet). */
  status(): GscStatus | null;
  /** Asks main about the page (`gsc.inspect({ url })`, the shared entry the cards show). */
  inspect(url: string): void;
}

/**
 * "Inspect this page in Search Console": on a web page, unless main answered that Search Console is
 * unconfigured or not connected (before it answered, it is offered and the card shows what main says).
 */
export function gscInspectPaletteSources(api: GscInspectPaletteApi): PaletteSource[] {
  return [
    {
      id: 'search-console.inspect-page',
      label: 'Inspect this page in Search Console',
      group: 'panels',
      keywords: [...KEYWORDS, 'url inspection', 'inspect', 'indexed', 'index', 'canonical', 'rich results', 'crawl'],
      icon: 'panel-search-console',
      available: (ctx) => {
        if (!onWebPage(ctx.tab)) return false;
        const status = api.status();
        return status === null || (status.configured && status.connected);
      },
      run: (ctx) => {
        api.inspect(ctx.tab!.url);
        ctx.chrome.openPanel('indexability', { focus: false });
      },
    },
  ];
}
