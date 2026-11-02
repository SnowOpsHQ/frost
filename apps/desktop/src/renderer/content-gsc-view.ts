// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscPerformanceQuery, GscQueriesAnswer, GscTargetPagesAnswer, GscTargetPagesQuery } from '@app/specs/gsc.schema';
import { GSC_TARGET_SUGGESTIONS, GSC_TARGETS_COPY } from '@app/specs/gsc-targets.spec';
import { GSC_TARGET_PAGES_READ_ROWS, normalizeGscQuery, type GscStatus, type GscUnavailableReason } from '@app/specs/gsc.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { capQuery } from './content-view';
import { formatCount, formatMetric, withoutFragment, type GscPeriod } from './gsc-view';
import { hostOf } from './security';

// Search Console targets in the Content panel as a view model (Phase 9 Task 5; spec `gsc-targets.spec.ts`;
// acceptance `seo-content.feature.md`, "Search Console targets"). Pure: main's connection (`gsc.watch`),
// the page, the saved target query, the Search Console panel's period and the answers become what the
// section shows, and what it reads. Nothing shows and nothing is read unless Search Console is
// configured and connected and the page is `http(s)`: then the panel is exactly as before. Queries and
// page URLs from Google pass through unchanged, to be rendered as inert, bidi-isolated text. Nothing
// here is a rule, a score or a tone: another page leading is a fact like this page leading.

/** Whether the section shows (and reads) at all: configured, connected and an `http(s)` page. */
export function contentGscShown(gsc: GscStatus | null, url: string): boolean {
  // `gsc.entitled` is not read: always true from main (Search Console is not gated).
  return gsc !== null && gsc.configured && gsc.connected && isWebUrl(url);
}

/** The suggestions' read: `gsc.topQueries` for the page (no fragment), page scope, the panel's period, no filter. */
export function suggestionsQuery(url: string, period: GscPeriod): GscPerformanceQuery {
  return { url: withoutFragment(url), scope: 'page', ...period };
}

/** The query→page check's read for the saved target, or `null` when there is no target to check. */
export function targetPagesQuery(url: string, target: string, period: GscPeriod): GscTargetPagesQuery | null {
  if (normalizeGscQuery(target) === '') return null;
  return { url: withoutFragment(url), query: target, ...period };
}

/** What identifies a read (the input and the connection): a new key reads again. */
export const readKey = (input: object, connection: number): string => JSON.stringify([input, connection]);

/** An unavailable answer's words (`{host}` filled), or `null` when the section hides. */
function reasonText(reason: GscUnavailableReason, url: string): string | null {
  const text = GSC_TARGETS_COPY.reasons[reason];
  return text === null ? null : text.replace('{host}', () => hostOf(url) || url);
}

/** `"1 page"`, `"120 pages"`. */
const pagesLabel = (n: number): string => `${formatCount(n)} ${n === 1 ? 'page' : 'pages'}`;

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

// ---- Suggestions --------------------------------------------------------------------------------

export interface GscSuggestionItem {
  /** Google's query (inert text). */
  readonly query: string;
  /** What "Use as target" stores (capped at `TARGET_QUERY_MAX_CHARS`). */
  readonly target: string;
  readonly clicks: string;
  readonly impressions: string;
  /** It is the saved target already (normalised): marked, no button. */
  readonly isTarget: boolean;
  /** The button's accessible name. */
  readonly label: string;
}

export type GscSuggestionsView =
  | { readonly state: 'loading'; readonly message: string }
  | { readonly state: 'list'; readonly note: string; readonly items: readonly GscSuggestionItem[] }
  | { readonly state: 'empty' | 'unavailable'; readonly message: string };

/** The suggestions for `answer` (`null`: not answered yet), the saved `target` marked; `null`: hidden. */
export function suggestionsView(answer: GscQueriesAnswer | null, target: string, url: string, rangePhrase: string): GscSuggestionsView | null {
  if (answer === null) return { state: 'loading', message: GSC_TARGETS_COPY.loading };
  if (answer.status === 'unavailable') {
    const message = reasonText(answer.reason, url);
    return message === null ? null : { state: 'unavailable', message };
  }
  if (answer.rows.length === 0) return { state: 'empty', message: fill(GSC_TARGETS_COPY.noSuggestions, { range: rangePhrase }) };
  const saved = normalizeGscQuery(target);
  return {
    state: 'list',
    note: fill(GSC_TARGETS_COPY.suggestionsNote, { range: rangePhrase }),
    items: answer.rows.slice(0, GSC_TARGET_SUGGESTIONS).map((row) => ({
      query: row.query,
      target: capQuery(row.query),
      clicks: formatMetric('clicks', row.clicks),
      impressions: formatMetric('impressions', row.impressions),
      isTarget: saved !== '' && normalizeGscQuery(row.query) === saved,
      label: fill(GSC_TARGETS_COPY.useAsTargetLabel, { query: row.query }),
    })),
  };
}

// ---- The query→page check -----------------------------------------------------------------------

export interface GscTargetPageItem {
  readonly rank: number;
  /** Google's page URL (inert text, never a link). */
  readonly page: string;
  readonly clicks: string;
  readonly impressions: string;
  readonly position: string;
  /** This page (rank `thisPageRank`). */
  readonly thisPage: boolean;
}

export type GscTargetPagesView =
  | { readonly state: 'loading'; readonly message: string }
  | { readonly state: 'list'; readonly items: readonly GscTargetPageItem[]; readonly summary: string; readonly cap: string | null; readonly facts: string }
  | { readonly state: 'no-data' | 'unavailable'; readonly message: string };

/** The check for `answer` (`null`: not answered yet); `null`: hidden. */
export function targetPagesView(answer: GscTargetPagesAnswer | null, url: string, rangePhrase: string): GscTargetPagesView | null {
  if (answer === null) return { state: 'loading', message: GSC_TARGETS_COPY.loading };
  if (answer.status === 'unavailable') {
    const message = reasonText(answer.reason, url);
    return message === null ? null : { state: 'unavailable', message };
  }
  const values = { query: answer.query, range: rangePhrase, pages: pagesLabel(answer.pagesRead) };
  if (answer.pagesRead === 0) return { state: 'no-data', message: fill(GSC_TARGETS_COPY.noPages, values) };
  const rank = answer.thisPageRank;
  return {
    state: 'list',
    items: answer.rows.map((row, i) => ({
      rank: i + 1,
      page: row.page,
      clicks: formatMetric('clicks', row.clicks),
      impressions: formatMetric('impressions', row.impressions),
      position: formatMetric('position', row.position),
      thisPage: rank === i + 1,
    })),
    summary: rank === null ? fill(GSC_TARGETS_COPY.notThisPage, values) : fill(GSC_TARGETS_COPY.thisPageRank, { ...values, rank: formatCount(rank) }),
    cap: answer.pagesRead >= GSC_TARGET_PAGES_READ_ROWS ? fill(GSC_TARGETS_COPY.readCap, { max: formatCount(GSC_TARGET_PAGES_READ_ROWS) }) : null,
    facts: GSC_TARGETS_COPY.facts,
  };
}
