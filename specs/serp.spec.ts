/**
 * SERP reading (Phase 3 Task 3; acceptance `serp-overlay.feature.md`; review focus
 * `serp-reader-is-bounded`). frost reads a search result page the user has loaded in a tab, with the
 * selector pack in use (`serp-selector-pack.spec.ts`), and says what the page is made of and who owns
 * it. Implemented by `apps/desktop/src/main/serp/`: `engines.ts` (is this URL a result page, and its
 * search parameters), `read-script.ts` (the fixed reader, run in the tab's isolated SERP world),
 * `serp-analyse.ts` (the analysis, pure) run by `serp-worker.ts` in a `worker_threads` worker of the
 * SERP's own (`serp-analysis.cjs`, driven by `serp-analyzer.ts`). The raw answer and the snapshot are
 * `serp-snapshot.schema.ts`; the search parameters `serp-search-params.schema.ts`.
 *
 * ## How a page is read
 * - **Detection.** A URL is a result page when its scheme is `http:` or `https:`, its host is one of
 *   an engine's `hosts` exactly (case-insensitive, a trailing dot ignored, the port ignored), its
 *   pathname one of its `paths` exactly, one of its query parameter names is present with a
 *   non-blank value, and no `params.reject` rule names another vertical (images, news, videos):
 *   a pack describes web results only. Nothing else is matched: no prefix, no subdomain, no
 *   heuristic. The recorded URL is canonical: the engine's host and path with the known
 *   parameters only (query, country, language, page), never the engine's session tokens.
 * - **The reader is data-driven and fixed.** One function frost ships, serialised with the engine's
 *   `layout` and `SERP_READ_LIMITS` as JSON arguments (never a selector concatenated into code), run
 *   in `SERP_WORLD_ID`. It checks every selector first (an invalid one is `bad-selector`), then the
 *   `results` anchor (`no-container` when it does not match), then each block's containers across
 *   the whole document and their items. It reads text (text nodes, collapsed and capped) and the
 *   resolved `href` of HTML links (`http:` / `https:` only) and nothing else. Every DOM method and
 *   getter it uses is taken from the prototypes of its own world when it starts and called with
 *   `.call`, so a page element named like a method (`<form name="querySelector">`, which shadows
 *   `document.querySelector` in every world) cannot stand in for it.
 * - **Precedence: the most specific block wins, then pack order.** An item a block finds is skipped
 *   when its closest match of another block's `container` lies inside this block's container (a
 *   featured snippet's link inside the organic area is the snippet's, not an organic result), when
 *   its closest match of the block's own `notInside` lies inside the container (a feature the pack
 *   does not read, so it is never counted as organic), and when it is, or is inside, an item already
 *   taken (by an earlier block in pack order, or earlier in the same block: nested matches count
 *   once). A block that names a `title` takes no item without one.
 * - **Links are read as they are.** An engine's click redirect (`/url?q=`, `/ck/a?u=`, `/l/?uddg=`)
 *   is unwrapped by the SERP worker with the engine's `redirects` (data: path, parameter, encoding),
 *   never by the reader; a destination that is not a valid `http:` / `https:` URL leaves the link as
 *   read with no domain, so it never counts towards ownership.
 * - **Document order.** Every item taken is sorted by document order; consecutive items of the same
 *   block and container form one answered block. So the organic results around a block of related
 *   questions are answered as organic, related questions, organic, in the order the page shows them.
 * - **Never guess.** A required block (the pack's `required`) that takes no item, or a page where no
 *   block takes any, is unreadable (`no-results`). There is no fallback that classifies anyway.
 * - **Bounded.** Counts, strings, node visits and time are capped while reading
 *   (`SERP_READ_LIMITS`): each block takes at most `maxItemsPerBlock` items, then everything taken
 *   is sorted by document order and cut to `maxResults` (the bottom of the page goes first, so a
 *   broad block can never starve the organic results above it; past a cap the read is `truncated`,
 *   and `organicCut` when organic results were among those cut). Past the node or time budget the
 *   read stops (`timeout`). The budget is
 *   checked between DOM calls: one native `querySelectorAll` cannot be interrupted, so a page of
 *   100,000 matches costs that one match, then stops at the next check. The answer is validated
 *   again in the worker (`SerpReadSchema`) before anything is derived from it.
 *
 * Clean-room: the reasons, messages, limits and the result model are frost's own, from SEO practice.
 *
 * Plain values and types, Zod-free, so the chrome renderer (messages, devices) can import them.
 */
import type { DevicePresetId } from './render-profile.spec';
import type { SerpResultType } from './serp-selector-pack.spec';

/**
 * The isolated world the SERP reader (and Task 4's outlines) run in
 * (`webContents.executeJavaScriptInIsolatedWorld`): one of frost's own, apart from the SEO
 * extractor's (`SEO_WORLD_ID`, 1207), axe's (`A11Y_WORLD_ID`, 1216), the speed observer's
 * (`SPEED_WORLD_ID`, 1250) and the fullscreen guard's (1001), so the page's scripts never reach it.
 */
export const SERP_WORLD_ID = 1_301;

/**
 * How the reader is bounded (applied by `readSerp` while it reads, and again by `SerpReadSchema`):
 * - `maxBlocks`: blocks answered (runs of consecutive items of one block and container);
 * - `maxContainersPerBlock`: containers one pack block looks at;
 * - `maxItemsPerBlock`: items one pack block takes in all its containers;
 * - `maxResults`: items answered in all, the first in document order (a real result page holds a
 *   few dozen);
 * - `maxTitleChars`: a title, after whitespace is collapsed; `maxTextReadChars`: raw text read for
 *   one title before collapsing (a huge text node is read only this far);
 * - `maxUrlChars`: a link; a longer one is no link (a cut URL is a wrong one);
 * - `maxNodesVisited`: elements and text nodes the reader looks at in all (containers, candidate
 *   items, claim checks, text nodes); past it the read stops (`timeout`);
 * - `budgetMs`: the reader's time budget from its start (`performance.now()`); past it the read
 *   stops (`timeout`). Well below `SERP_READ_TIMEOUT_MS`;
 * - `maxCoordinate`: a box's coordinates and sizes (CSS px); a larger or non-finite one is no box.
 *   An item's box is its block's `box` element (or the item itself), in document coordinates.
 */
export const SERP_READ_LIMITS = {
  maxBlocks: 64,
  maxContainersPerBlock: 16,
  maxItemsPerBlock: 50,
  maxResults: 100,
  maxTitleChars: 300,
  maxTextReadChars: 2_048,
  maxUrlChars: 2_048,
  maxNodesVisited: 20_000,
  budgetMs: 150,
  maxCoordinate: 1_000_000,
} as const;
export type SerpReadLimits = { readonly [K in keyof typeof SERP_READ_LIMITS]: number };

/** A reader run whose promise has not settled after this long is abandoned (`timeout`; Task 4). */
export const SERP_READ_TIMEOUT_MS = 2_000;

/**
 * The SERP worker's hard timeout per analysis (`serp-analyzer.ts`): past it the worker is
 * terminated, that reading is unreadable (`timeout`), and the next analysis spawns a new worker.
 */
export const SERP_ANALYSIS_TIMEOUT_MS = 2_000;

/**
 * Jobs waiting for the SERP worker at most (`serp-analyzer.ts`); one more drops the oldest waiting
 * job, which ends `timeout` (a newer reading of the tab supersedes it anyway).
 */
export const SERP_ANALYSIS_MAX_QUEUED = 8;

/**
 * What the panel says when a reader cap cut organic results (`ownership.complete` is `false`):
 * composition and ownership cover only what was read.
 */
export const SERP_TRUNCATED_NOTE = 'This page has more results than frost reads. Composition and ownership cover the first results only.';

/**
 * Shared-hosting domains whose subdomains are separate sites (frost's own short list, applied
 * before `registrableDomain` when ownership is grouped): `alice.github.io` and `bob.github.io` are
 * two owners, not one `github.io`. A host that is one of these itself stays as it is.
 */
export const SERP_OWNER_SUFFIXES = [
  'github.io',
  'gitlab.io',
  'blogspot.com',
  'wordpress.com',
  'substack.com',
  'medium.com',
  'tumblr.com',
  'wixsite.com',
  'weebly.com',
  'squarespace.com',
  'myshopify.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'azurewebsites.net',
  'fly.dev',
  'onrender.com',
  'glitch.me',
  'neocities.org',
  'carrd.co',
] as const;

/**
 * Why a result page could not be read (the panel's "Couldn't read this layout", with the reason):
 * - `no-container`: the pack's results area (`layout.results`) is not on the page;
 * - `no-results`: a required block took no result, or no block took any;
 * - `bad-selector`: a selector in the pack is not valid CSS for this browser;
 * - `timeout`: the page was too large to read within the node or time budget (or its analysis ran
 *   past `SERP_ANALYSIS_TIMEOUT_MS`);
 * - `invalid-answer`: the reader's answer, or the search parameters, failed validation in the worker
 *   (or the worker failed);
 * - `pack-invalid`: the bundled selector pack failed verification, so SERP reading is off.
 */
export const SERP_UNREADABLE_REASONS = ['no-container', 'no-results', 'bad-selector', 'timeout', 'invalid-answer', 'pack-invalid'] as const;
export type SerpUnreadableReason = (typeof SERP_UNREADABLE_REASONS)[number];

/** The reasons the reader itself answers (the others come from the worker or the pack store). */
export const SERP_READ_FAILURES = ['no-container', 'no-results', 'bad-selector', 'timeout'] as const satisfies readonly SerpUnreadableReason[];
export type SerpReadFailure = (typeof SERP_READ_FAILURES)[number];

/** What the panel says under "Couldn't read this layout", per reason. */
export const SERP_UNREADABLE_MESSAGES: Readonly<Record<SerpUnreadableReason, string>> = {
  'no-container': 'The results area frost’s selectors look for isn’t on this page. The engine may have changed its layout.',
  'no-results': 'frost’s selectors found no results it can name on this page. The engine may have changed its layout.',
  'bad-selector': 'A selector in frost’s selector pack isn’t valid on this page, so nothing was read.',
  timeout: 'This page is too large to read within frost’s limits.',
  'invalid-answer': 'What frost read from this page didn’t pass its checks, so nothing is shown.',
  'pack-invalid': 'SERP reading is off: the selectors bundled with frost failed verification. Reinstalling frost restores them.',
};

/** The device a result page was served for (`SearchParamsSchema.device`). */
export const SERP_DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export type SerpDevice = (typeof SERP_DEVICES)[number];

export const SERP_DEVICE_LABELS: Readonly<Record<SerpDevice, string>> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' };

/**
 * The device of a tab's render profile (`render-profile.spec.ts`, `DevicePresetId`): no emulation
 * (`none`, the window's own size on this computer) and the desktop preset are `desktop`, the phone
 * preset `mobile`, the tablet preset `tablet`.
 */
export const SERP_DEVICE_OF_PRESET: Readonly<Record<DevicePresetId, SerpDevice>> = { none: 'desktop', desktop: 'desktop', phone: 'mobile', tablet: 'tablet' };

/**
 * How the search parameters are bounded (`SearchParamsSchema`, `matchSerp`):
 * - `maxQueryChars`: the query, after whitespace is collapsed (a longer one is cut to it);
 * - `maxLocaleChars`: a country or language value (`gl`, `hl`); one longer, or not letters, digits,
 *   `-` and `_`, is not recorded (`null`);
 * - `maxPage`: the page number (a larger one is clamped to it);
 * - `maxOffset`: an offset parameter's value (`start=20`; a larger one is clamped to it);
 * - `maxUrlChars`: the result page's URL; a longer URL is not matched at all.
 */
export const SERP_PARAM_LIMITS = {
  maxQueryChars: 512,
  maxLocaleChars: 16,
  maxPage: 100,
  maxOffset: 10_000,
  maxUrlChars: 4_096,
} as const;

/**
 * The result types that are SERP features: every type but `organic` and `ad`. Each feature block
 * takes a slot of its own (`featureSlot`, 1, 2, … in document order); organic results and ads take
 * positions in their own counts instead.
 */
export const SERP_FEATURE_TYPES = ['featured-snippet', 'people-also-ask', 'local-pack', 'video', 'images', 'top-stories', 'knowledge-panel', 'shopping', 'ai-overview', 'related-searches'] as const satisfies readonly Exclude<SerpResultType, 'organic' | 'ad'>[];
export type SerpFeatureType = (typeof SERP_FEATURE_TYPES)[number];
export const isSerpFeature = (type: SerpResultType): type is SerpFeatureType => type !== 'organic' && type !== 'ad';
