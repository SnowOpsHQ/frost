/**
 * The SERP service, its procedures and the outlines (Phase 3 Task 4; Zod side
 * `serp-service.schema.ts`; acceptance `serp-overlay.feature.md`, Router, Service and Outlines).
 * Main's `apps/desktop/src/main/serp/service.ts` keeps each tab's reading of the result page it
 * shows (`SerpState`), wired by `setup.ts`; the chrome reaches it only through the `serp.*`
 * procedures (`packages/ipc-contract/src/serp-router.ts`, every one `enforceSender`-first), and
 * Phase 5 through `SerpReadApi` (`packages/ipc-contract/src/serp-service.ts`).
 *
 * ## The service
 * - **Only pages the user loads, only tabs.** A browse-session tab's page is read after its
 *   `did-finish-load`, and after an in-page navigation (`did-navigate-in-page`, main frame) to
 *   another search (another canonical URL, `SearchParams.url`) once the page has been quiet for
 *   `SERP_INPAGE_DEBOUNCE_MS` (a result page that updates itself in place). An in-page move within
 *   the same search (a fragment, a tracking token) keeps the reading and the outlines. Detection is `matchSerp` with the pack in use and the tab's device
 *   (its render profile, `SERP_DEVICE_OF_PRESET`); any other page is `not-serp` and is never read.
 *   frost never requests a search engine.
 * - **Per tab, per document.** A tab's reading belongs to its WebContents, its document
 *   (`TabState.documentSeq`), its search and its device: a new document, an in-page move to another
 *   search or to a page that is not a result page, a closed tab or Clear Browsing Data drops it. A tab that shows a result page with no reading of
 *   its own (a pack swap, a render profile change, a tab loaded before frost read it) is read when
 *   its state is next asked for, once it has finished loading (`pending` until then).
 * - **Bounded waits.** The reader is abandoned after `SERP_READ_TIMEOUT_MS` (`timeout`); its answer
 *   is analysed in the SERP worker. Every change bumps one `version` and wakes the `serp.watch`
 *   long-polls; at most `MAX_PENDING_SERP_WATCHES` wait (one more answers the oldest early), and
 *   each answers after `WATCH_TIMEOUT_MS` anyway. A reader answer whose analysis timed out (an overrun
 *   worker, a job dropped from a full queue, `SERP_ANALYSIS_MAX_QUEUED`) is transient: it is read
 *   once more, then stays `pending` until next asked for; never "couldn't read".
 * - **Selector updates are live.** "Check for selector updates" is `checkForUpdate()` (a user
 *   action); a newer pack (installed, or a stored one verified at start) replaces every reading:
 *   outlines go, the active tab is read again at once, the others when next asked for.
 * - **Intent stays local.** The current query of a `ready` reading is classified by the on-device
 *   classifier while it is `ready` (and once per reading while it is `unavailable`, so a restarted
 *   process recovers; never in a loop); otherwise the answer is the classifier's state
 *   (`model-missing` …). Nothing downloads but the user's "Enable on-device intent"
 *   (`enableIntent()`, `ensureModel()`). Answers are kept per query for the session
 *   (`SERP_INTENT_CACHE_SIZE`; Clear Browsing Data forgets them: queries are browsing data).
 *
 * ## Outlines
 * "Outline features on the page" draws each read result's box (its block's `box` element, else the
 * item) with its type's label, in the tab's isolated SERP world (`SERP_WORLD_ID`), as Phase 2's
 * highlight draws its overlay: one host element of its own, a closed shadow root, inline styles set
 * through the CSSOM. The overlay reads the page itself with the same fixed reader and the pack's
 * layout (never a page value as code), so the boxes follow the page: it reads again after scrolling
 * and resizing, at most once per frame and no sooner than `SERP_OUTLINE_LIMITS.minIntervalMs` (or
 * four times the last pass's cost) after the last. Only for the active tab and a `ready` reading.
 * It is drawn only on the document main means (the paint script compares its URL, the fragment
 * aside, so a paint that crossed a navigation installs nothing), and its DOM calls use its own
 * world's prototypes, so a page's named elements cannot break it. It is removed by a new document, an
 * in-page move to another search (one within the same search keeps it), a tab switch (checked every
 * `SERP_OUTLINE_ACTIVE_POLL_MS` while one is drawn), a pack swap, Clear Browsing Data or the toggle,
 * always with an off paint sent to the page (harmless on a fresh document); when the page removes
 * its host, or is left, it ends and the tab's outlines are off.
 *
 * Clean-room: the labels, colours, limits and timings are frost's own.
 *
 * Plain values and types, Zod-free, so the chrome renderer can import them.
 */
import { CHECKS_FETCHER_LIMITS } from './fetcher.spec';
import { SERP_RESULT_TYPE_LABELS, type SerpResultType } from './serp-selector-pack.spec';

/**
 * The SERP lane (Phase 3 Task 5 review; `fetcher.spec.ts`, Lanes): what the SERP features fetch on
 * the user's request (the visibility probes, "Check for selector updates", the intent model's
 * download) goes through a bounded fetcher of their own, created by `setup.ts` over main's hop and
 * resolver, so every rule of `fetcher.spec.ts` holds (browse session, cookies omitted, private-address
 * refusal and DNS check, caps, per-origin rate limit). It has the `checks` lane's per-origin limits
 * and its own per-origin queues: a link, sitemap or hreflang check filling the `checks` lane's slots
 * on a site never makes a probe wait (and time out, as its deadline counts the queue) behind it. The
 * cost, as for the lanes: a site may see this lane's requests beside the others'.
 */
export const SERP_FETCHER_LIMITS = CHECKS_FETCHER_LIMITS;

/** An in-page navigation to another search is read once the page has been quiet this long (a new one restarts it). */
export const SERP_INPAGE_DEBOUNCE_MS = 400;

/** `serp.watch` long-polls waiting at most (one more answers the oldest early). */
export const MAX_PENDING_SERP_WATCHES = 8;

/** Intent answers kept per query for the session (the oldest goes first). */
export const SERP_INTENT_CACHE_SIZE = 32;

/** How often main checks the active tab while an outline is drawn (a tab switch removes it). */
export const SERP_OUTLINE_ACTIVE_POLL_MS = 250;

/**
 * How the outlines are bounded:
 * - `maxBoxes`: boxes drawn at most (an organic result or an ad is one box each, a feature block
 *   one box);
 * - `minIntervalMs`: the least time between two reading passes after the first (scrolling and
 *   resizing are coalesced); a pass that cost more stretches it to four times its cost.
 */
export const SERP_OUTLINE_LIMITS = {
  maxBoxes: 120,
  minIntervalMs: 200,
} as const;

/** The isolated world's global property holding the outline state (the SERP world's own, apart from the highlight's). */
export const SERP_OUTLINE_KEY = '__frostSerpOutline' as const;

/**
 * Each result type's outline colour and label. Organic results and ads are numbered by their own
 * count (`Organic 3`, `Ad 1`, as `position`); a feature block takes its type's label.
 */
export const SERP_OUTLINE_STYLES: Readonly<Record<SerpResultType, { readonly color: string; readonly label: string }>> = {
  organic: { color: '#2563eb', label: 'Organic' },
  ad: { color: '#b45309', label: SERP_RESULT_TYPE_LABELS.ad },
  'featured-snippet': { color: '#7c3aed', label: SERP_RESULT_TYPE_LABELS['featured-snippet'] },
  'people-also-ask': { color: '#0d9488', label: SERP_RESULT_TYPE_LABELS['people-also-ask'] },
  'local-pack': { color: '#16a34a', label: SERP_RESULT_TYPE_LABELS['local-pack'] },
  video: { color: '#dc2626', label: SERP_RESULT_TYPE_LABELS.video },
  images: { color: '#db2777', label: SERP_RESULT_TYPE_LABELS.images },
  'top-stories': { color: '#ea580c', label: SERP_RESULT_TYPE_LABELS['top-stories'] },
  'knowledge-panel': { color: '#4f46e5', label: SERP_RESULT_TYPE_LABELS['knowledge-panel'] },
  shopping: { color: '#ca8a04', label: SERP_RESULT_TYPE_LABELS.shopping },
  'ai-overview': { color: '#0891b2', label: SERP_RESULT_TYPE_LABELS['ai-overview'] },
  'related-searches': { color: '#64748b', label: SERP_RESULT_TYPE_LABELS['related-searches'] },
};

/** What a tab's SERP state can be (`SerpStateSchema.status`). */
export const SERP_STATE_STATUSES = ['not-serp', 'pending', 'ready', 'unreadable', 'disabled'] as const;
export type SerpStateStatus = (typeof SERP_STATE_STATUSES)[number];

/** What the panel says for a page that is not a result page. */
export const SERP_NOT_SERP_MESSAGE = 'Not a search result page.';
