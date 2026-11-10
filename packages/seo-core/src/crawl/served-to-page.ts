import type { ServedSnapshot } from '@app/specs/seo-javascript.schema';
import { SOCIAL_TAGS } from '@app/specs/seo-limits.spec';
import type { ExtractedSnapshot, PageImage, PageSocial } from '@app/specs/seo-snapshot.spec';

// The crawl's snapshot adapter (spec `site-crawl.spec.ts`, `CRAWL_RULE_IDS`; acceptance
// `site-crawl.feature.md`, The snapshot adapter; plan Decision 6 and Task 6b, which states each field).
// A crawled page is parsed as served HTML (`ServedSnapshot`, `served-parse.ts`) and audited with the
// rules that read the page snapshot (`PageSnapshot`): this fills one from the other. Every field the
// served snapshot holds is copied; images are mapped with no layout values; what served HTML cannot
// tell (social tags, the browser's view of security, microdata and RDFa) is a neutral default, and
// the rules reading it are not crawl rules. Pure: no clock (the fetch's time is passed in).

/** When the page was fetched (epoch ms) and how long the fetch took (ms): the snapshot's `extractedAt` and `durationMs`. */
export interface ServedFetchTiming {
  readonly extractedAt: number;
  readonly durationMs: number;
}

/** Every social tag `null` (the served snapshot does not read them; the social rules are excluded). */
const NO_SOCIAL = Object.fromEntries(SOCIAL_TAGS.map((tag) => [tag, null])) as PageSocial;

/** A served image as a page image: its `src` and `alt`, nothing measured (the rules reading layout are excluded). */
const imageOf = (image: ServedSnapshot['images'][number]): PageImage => ({ src: image.src, alt: image.alt, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false });

/**
 * The page snapshot of a served snapshot. Copied: `url`, `lang`, the titles, descriptions, robots
 * metas, canonicals, `ogUrl`, `viewport`, headings (no visibility check: a crawler sees hidden ones
 * too), links, `imageTotal`, JSON-LD, hreflang, `wordCount`, `textTruncated`, `partial`. Mapped:
 * `images`. Defaulted: `extractedAt` / `durationMs` (the fetch's), `social` (every tag `null`),
 * `security` (empty), `microdata` / `rdfa` (none). Omitted: `hiddenHeadings`, `blockingScripts`,
 * `visibleText`; and the served snapshot's own `leadText`, `noscript` and `nodes`.
 */
export function servedToPageSnapshot(served: ServedSnapshot, fetched: ServedFetchTiming): ExtractedSnapshot {
  return {
    url: served.url,
    extractedAt: fetched.extractedAt,
    durationMs: fetched.durationMs,
    lang: served.lang,
    titles: served.titles,
    titleTotal: served.titleTotal,
    metaDescriptions: served.metaDescriptions,
    metaDescriptionTotal: served.metaDescriptionTotal,
    metaRobots: served.metaRobots,
    canonicals: served.canonicals,
    canonicalTotal: served.canonicalTotal,
    ogUrl: served.ogUrl,
    social: { ...NO_SOCIAL },
    viewport: served.viewport,
    headings: served.headings,
    headingTotal: served.headingTotal,
    wordCount: served.wordCount,
    textTruncated: served.textTruncated,
    partial: served.partial,
    links: served.links,
    linkTotal: served.linkTotal,
    images: served.images.map(imageOf),
    imageTotal: served.imageTotal,
    security: { insecureResources: [], insecureResourceTotal: 0, resourcesTruncated: false, metaCsp: [], metaReferrer: null },
    jsonLd: served.jsonLd,
    jsonLdTotal: served.jsonLdTotal,
    microdata: [],
    microdataTotal: 0,
    rdfa: [],
    rdfaTotal: 0,
    hreflang: served.hreflang,
    hreflangTotal: served.hreflangTotal,
  };
}
