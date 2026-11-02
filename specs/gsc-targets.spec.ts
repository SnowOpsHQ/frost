/**
 * Search targets in the Content panel (Phase 9 Task 5; SL-020; acceptance `seo-content.feature.md`,
 * "Search Console targets"; plan Decision 7). Plain values with no Zod, so the chrome renderer can use
 * them: its strict Trusted Types CSP blocks Zod's eval probe. The read's schemas
 * (`GscTargetPagesQuerySchema`, `GscTargetPagesAnswerSchema`) and its limits (`GSC_LIMITS.maxTargetPages`,
 * `GSC_TARGET_PAGES_READ_ROWS`, `normalizeGscQuery`) are in `gsc.schema.ts` / `gsc.spec.ts`.
 *
 * Both parts are facts, never targets (the "Information, not targets" rule of `seo-content.feature.md`):
 * - **Suggestions**: the page's top search queries (`gsc.topQueries`, page scope, the Search Console
 *   panel's range, no country or device filter), at most `GSC_TARGET_SUGGESTIONS`, each with "Use as
 *   target" (`content.setTarget`, carrying the notes' generation).
 * - **Query→page check**: for the saved target query, the property's pages Google showed for it
 *   (`gsc.targetPages`), this page marked.
 *
 * Nothing shows (the panel is as before) while Search Console is unconfigured or not connected.
 * Clean-room: frost's own words.
 */
import type { GscUnavailableReason } from './gsc.spec';

/** How many of the page's top queries are offered as targets. */
export const GSC_TARGET_SUGGESTIONS = 5;

/**
 * The query→page check waits until the target query has not changed for this long (it is saved after
 * the notes' own delay), so typing a query reads Search Console once, not once per pause.
 */
export const GSC_TARGET_CHECK_DELAY_MS = 1_000;

/**
 * What the section says. `{range}` is the panel's range phrase (`GSC_RANGE_TEXT`), `{query}` the
 * normalised query (Google's own, lowercase), `{host}` the page's host, `{rank}` / `{pages}` / `{max}`
 * numbers; the chrome fills them in. Strings from Google (queries, page URLs) are rendered as inert,
 * bidi-isolated text.
 */
export const GSC_TARGETS_COPY = Object.freeze({
  suggestionsTitle: 'Queries from Search Console',
  suggestionsNote: 'This page’s top search queries {range}, the Search Console panel’s range.',
  noSuggestions: 'Search Console reported no queries for this page {range}. Google hides rare queries.',
  useAsTarget: 'Use as target',
  /** The button's accessible name. */
  useAsTargetLabel: 'Use “{query}” as the target query',
  currentTarget: 'Target',
  pagesTitle: 'Pages Google showed for this query',
  thisPage: 'This page',
  thisPageRank: 'This page is #{rank} of the {pages} Google showed for “{query}” {range}.',
  notThisPage: 'This page is not among the {pages} Google showed for “{query}” {range}.',
  readCap: 'frost reads the top {max} pages.',
  noPages: 'Google reported no pages for “{query}” {range}. Google hides rare queries.',
  facts: 'Information, not a target: no rule, score or colour depends on it.',
  loading: 'Reading Search Console…',
  /** Each unavailable answer's words; `null`: the whole section is hidden (as when not connected). */
  reasons: Object.freeze({
    unconfigured: null,
    'not-entitled': null,
    'not-connected': null,
    'not-a-web-page': null,
    'no-property': 'None of your Search Console properties covers {host}.',
    'auth-expired': 'Google no longer accepts this connection. Reconnect in Settings.',
    quota: 'Search Console’s usage limit was reached. Try again in a minute.',
    network: 'frost couldn’t reach Google.',
    invalid: 'Search Console answered something frost couldn’t read.',
  } satisfies Readonly<Record<GscUnavailableReason, string | null>>),
} as const);
