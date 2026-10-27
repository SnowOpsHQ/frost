import type { TabState } from '@app/specs/browser.spec';
import type { CheckKind, ChecksState } from '@app/specs/seo-checks.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { readyAudit, type PaletteSource } from './palette/registry';

// The checks in the command palette (spec `seo-checks.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API): "Check links", "Check sitemaps" and "Check hreflang
// return links" (each opens its panel and starts the check, as its button does), and "Stop link
// check" while one runs. Registered from `components/seo/LinkChecks.tsx`; pure (the procedures and
// the known state are injected) so availability is unit tested.

export interface ChecksPaletteApi {
  checkLinks(tabId: number): Promise<boolean>;
  checkSitemaps(tabId: number): Promise<boolean>;
  checkHreflang(tabId: number): Promise<boolean>;
  stop(tabId: number, check: CheckKind): Promise<boolean>;
  /** The last checks state the chrome saw for a tab (`undefined`: none yet). */
  known(tabId: number): ChecksState | undefined;
}

const KEYWORDS = ['check', 'seo', 'status', 'crawl'];
/** Every check surface says the sites can see the requests (`CHECKS_VISIBILITY_NOTICE`, shortened for the palette's second line). */
export const CHECKS_PALETTE_DETAIL = 'Sends requests the checked sites can see';
const detail = (): string => CHECKS_PALETTE_DETAIL;

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

export function checksPaletteSources(api: ChecksPaletteApi): PaletteSource[] {
  return [
    {
      id: 'checks.links',
      label: 'Check links',
      group: 'audit',
      keywords: [...KEYWORDS, 'broken links', '404', 'redirects', 'link checker'],
      icon: 'panel-links',
      detail,
      focus: 'handler',
      available: (ctx) => onWebPage(ctx.tab) && readyAudit(ctx) !== null && readyAudit(ctx)!.page.linkList.length > 0,
      run: async (ctx) => {
        ctx.chrome.openPanel('links');
        return (await api.checkLinks(ctx.tab!.id)) ? 'Checking links' : 'The link check could not start';
      },
    },
    {
      id: 'checks.links-stop',
      label: 'Stop link check',
      group: 'audit',
      keywords: [...KEYWORDS, 'cancel', 'links'],
      icon: 'stop',
      available: (ctx) => onWebPage(ctx.tab) && api.known(ctx.tab.id)?.links.status === 'running',
      run: async (ctx) => ((await api.stop(ctx.tab!.id, 'links')) ? 'Link check stopped' : 'No link check was running'),
    },
    {
      id: 'checks.sitemaps',
      label: 'Check sitemaps',
      group: 'audit',
      keywords: [...KEYWORDS, 'sitemap.xml', 'xml sitemap', 'indexability', 'listed'],
      icon: 'sitemap',
      detail,
      focus: 'handler',
      available: (ctx) => onWebPage(ctx.tab) && readyAudit(ctx) !== null,
      run: async (ctx) => {
        ctx.chrome.openPanel('indexability');
        return (await api.checkSitemaps(ctx.tab!.id)) ? 'Checking sitemaps' : 'The sitemap check could not start';
      },
    },
    {
      id: 'checks.hreflang',
      label: 'Check hreflang return links',
      group: 'audit',
      keywords: [...KEYWORDS, 'hreflang', 'reciprocal', 'alternate', 'international', 'language'],
      icon: 'panel-indexability',
      detail,
      focus: 'handler',
      available: (ctx) => onWebPage(ctx.tab) && (readyAudit(ctx)?.indexability.hreflang.entries.length ?? 0) > 0,
      run: async (ctx) => {
        ctx.chrome.openPanel('indexability');
        return (await api.checkHreflang(ctx.tab!.id)) ? 'Checking hreflang return links' : 'The hreflang check could not start';
      },
    },
  ];
}
