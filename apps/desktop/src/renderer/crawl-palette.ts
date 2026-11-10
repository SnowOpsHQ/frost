import { crawlSiteOf } from './crawl-view';
import type { PaletteSource } from './palette/registry';

// The site crawl in the command palette (Phase 12 Task 7; acceptance `site-crawl.feature.md`, Pages and
// Site structure: Entry points): "Crawl this site…" opens the crawl sheet with the active tab's site as
// the start URL (offered on an `http(s)` page), "Show site crawl" opens it as it was. Neither starts a
// crawl: the sheet's Start does, and only when main says a crawl is available. Registered from
// `components/crawl/CrawlSheet.tsx`; pure (the sheet is injected), so it is unit tested.

export interface CrawlPaletteApi {
  /** Opens the crawl sheet (on `startUrl`, the site to crawl). */
  open(request: { readonly startUrl?: string }): void;
}

const KEYWORDS = ['crawl', 'crawler', 'spider', 'site', 'pages', 'structure', 'audit', 'orphans', 'depth', 'sitemap', 'export', 'csv'];

export function crawlPaletteSources(api: CrawlPaletteApi): PaletteSource[] {
  return [
    {
      id: 'crawl.this-site',
      label: 'Crawl this site…',
      group: 'page',
      keywords: [...KEYWORDS, 'this', 'start'],
      icon: 'sitemap',
      focus: 'handler',
      available: (ctx) => crawlSiteOf(ctx.tab?.url) !== null,
      run: (ctx) => {
        const startUrl = crawlSiteOf(ctx.tab?.url);
        api.open(startUrl === null ? {} : { startUrl });
      },
    },
    {
      id: 'crawl.show',
      label: 'Show site crawl',
      group: 'browser',
      keywords: [...KEYWORDS, 'show', 'open', 'runs', 'results'],
      icon: 'sitemap',
      focus: 'handler',
      run: () => api.open({}),
    },
  ];
}
