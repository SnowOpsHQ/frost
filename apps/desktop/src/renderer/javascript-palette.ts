import type { TabState } from '@app/specs/browser.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { readyAudit, type PaletteSource } from './palette/registry';

// The JavaScript panel in the command palette (spec `seo-javascript.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open JavaScript panel" (the
// panel's jump, owned here) and "Fetch served HTML again" (main's `javascript.refetchServed`).
// Registered from `components/seo/JavaScript.tsx`; pure (the procedure is injected) so availability
// is unit tested.

export interface JavascriptPaletteApi {
  /** `javascript.refetchServed`; resolves whether a fresh fetch and audit started. */
  refetchServed(tabId: number): Promise<boolean>;
}

const KEYWORDS = ['javascript', 'js', 'served', 'rendered', 'html', 'source', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

/** The palette's JavaScript actions, calling `api`. */
export function javascriptPaletteSources(api: JavascriptPaletteApi): PaletteSource[] {
  return [
    {
      id: 'panel.javascript',
      label: 'Open JavaScript panel',
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'compare', 'diff', 'sidebar'],
      icon: 'panel-javascript',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('javascript', { focus: true }),
    },
    {
      id: 'javascript.refetch-served',
      label: 'Fetch served HTML again',
      group: 'panels',
      keywords: [...KEYWORDS, 'refetch', 'reload', 'compare', 'again'],
      icon: 'reload',
      available: (ctx) => onWebPage(ctx.tab) && readyAudit(ctx) !== null,
      run: async (ctx) => ((await api.refetchServed(ctx.tab!.id)) ? 'Fetching the served HTML again' : 'Could not fetch again'),
    },
  ];
}
