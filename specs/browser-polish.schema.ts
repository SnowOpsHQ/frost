/**
 * Browser polish (Phase 2.5 Task 6; acceptance `browser-polish.feature.md`, Router): the find bar's
 * state in `BrowserState` and the `find.*`, `history.*` and `settings.*` procedures' inputs.
 * Main-only (Zod): the chrome imports the plain values of `browser-polish.spec.ts` and this module's
 * types only. Every procedure is `enforceSender`-first; these schemas are strict, so an unknown key,
 * an over-long value or a non-`http(s)` URL is refused before a service is called.
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { CLOSED_TABS_MAX, FIND_TEXT_MAX_CHARS, HISTORY_PAGE_SIZE, HISTORY_QUERY_MAX_CHARS, SEARCH_ENGINE_IDS } from './browser-polish.spec';
import { isWebUrl } from './web-url.spec';

const tabId = z.int().positive();
const visitUrl = z.string().min(1).max(MAX_STORED_URL_LENGTH).refine(isWebUrl, { message: 'not an http(s) URL' });

/**
 * The active tab's open find bar (`BrowserState.find`; `null` while it is closed): the tab it belongs
 * to, the text and the case switch as main last ran them, the match count and the active match's
 * ordinal from the latest `found-in-page` answer (`0` until one came), and `focusSeq`, bumped each
 * time the bar should take keyboard focus (Mod+F again, the menu, the palette).
 */
export const FindStateSchema = z.strictObject({
  tabId,
  text: z.string().max(FIND_TEXT_MAX_CHARS),
  matchCase: z.boolean(),
  matches: z.int().nonnegative(),
  active: z.int().nonnegative(),
  focusSeq: z.int().nonnegative(),
});
export type FindState = z.infer<typeof FindStateSchema>;

/**
 * The fields browser polish adds to `BrowserStateSchema` (merged in `browser.spec.ts`). Optional, so
 * other features' state fakes need not grow; main always sends them.
 */
export const BrowserPolishStateShape = {
  find: FindStateSchema.nullable().optional(),
  /** Bumped each time main asks the chrome to open the History view (menu, Mod+Y, palette). */
  historyViewSeq: z.int().nonnegative().optional(),
  /** How many closed tabs Reopen Closed Tab can bring back (`CLOSED_TABS_MAX` at most). */
  closedTabCount: z.int().nonnegative().max(CLOSED_TABS_MAX).optional(),
  /** The engine address-bar searches use. */
  searchEngine: z.enum(SEARCH_ENGINE_IDS).optional(),
} as const;

/** `find.search`: run `text` (a new find session) in the tab; `''` clears the highlights. */
export const FindSearchInputSchema = z.strictObject({ tabId, text: z.string().max(FIND_TEXT_MAX_CHARS), matchCase: z.boolean() });
export type FindSearchInput = z.infer<typeof FindSearchInputSchema>;

/** `find.step`: the next (`forward`) or previous match of the tab's open find bar. */
export const FindStepInputSchema = z.strictObject({ tabId, forward: z.boolean() });
export type FindStepInput = z.infer<typeof FindStepInputSchema>;

/** `find.close`: closes the tab's find bar (`stopFindInPage('clearSelection')`). */
export const FindCloseInputSchema = z.strictObject({ tabId });
export type FindCloseInput = z.infer<typeof FindCloseInputSchema>;

/** Where a History page starts: after this visit (newest first: older, or as old with a smaller URL). */
export const HistoryCursorSchema = z.strictObject({ lastVisitAt: z.int().nonnegative(), url: z.string().min(1).max(MAX_STORED_URL_LENGTH) });
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>;

/** `history.list`: one page of visits matching `query` (`''`: all), after `after` (`null`: the newest). */
export const HistoryListInputSchema = z.strictObject({
  query: z.string().max(HISTORY_QUERY_MAX_CHARS),
  after: HistoryCursorSchema.nullable(),
  limit: z.int().min(1).max(HISTORY_PAGE_SIZE).optional(),
});
export type HistoryListInput = z.infer<typeof HistoryListInputSchema>;

/** `history.remove`: deletes one URL's visit. */
export const HistoryRemoveInputSchema = z.strictObject({ url: visitUrl });
export type HistoryRemoveInput = z.infer<typeof HistoryRemoveInputSchema>;

/** `settings.setSearchEngine`: one of `SEARCH_ENGINES`. */
export const SetSearchEngineInputSchema = z.strictObject({ engine: z.enum(SEARCH_ENGINE_IDS) });
export type SetSearchEngineInput = z.infer<typeof SetSearchEngineInputSchema>;
