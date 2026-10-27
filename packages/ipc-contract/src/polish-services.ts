import type { SearchEngineId } from '@app/specs/browser-polish.spec';

// Browser polish as the `find.*`, `history.*` and `settings.*` procedures see it (Phase 2.5 Task 6;
// acceptance `browser-polish.feature.md`). Main implements them (the browser controller, the
// session database, its own dialog); this package only knows the interfaces.

/** Find in page (`webContents.findInPage` in main); each acts on an open tab, `false` for any other id. */
export interface FindService {
  /** Opens the active tab's find bar (or focuses it again), as Mod+F does. */
  open(): void;
  /** Runs `text` as a new find session in the tab's open bar (`''` clears the highlights); `false` if it has none. */
  search(tabId: number, text: string, matchCase: boolean): boolean;
  /** The next (`forward`) or previous match of the tab's open bar; `false` if it has none or no text. */
  step(tabId: number, forward: boolean): boolean;
  /** Closes the tab's bar (`stopFindInPage('clearSelection')`) and focuses its page; `false` if it had none. */
  close(tabId: number): boolean;
}

/** One `recent_visits` row as the History view and the new-tab page see it. */
export interface HistoryVisitAnswer {
  readonly url: string;
  readonly title: string;
  readonly visitCount: number;
  readonly lastVisitAt: number;
}

export interface HistoryCursorAnswer {
  readonly lastVisitAt: number;
  readonly url: string;
}

export interface HistoryPageAnswer {
  readonly visits: readonly HistoryVisitAnswer[];
  /** Pass back as `after` for the next page; `null` on the last one. */
  readonly next: HistoryCursorAnswer | null;
}

export interface JumpBackInAnswer {
  readonly mostVisited: readonly HistoryVisitAnswer[];
  readonly recent: readonly HistoryVisitAnswer[];
}

export interface HistoryService {
  /** One page of visits, newest first (pending visit writes are flushed first). Never rejects: an empty page on failure. */
  list(query: string, after: HistoryCursorAnswer | null, limit?: number): Promise<HistoryPageAnswer>;
  /** The new-tab page's tiles. Never rejects. */
  jumpBackIn(): Promise<JumpBackInAnswer>;
  /** Deletes one URL's visit (stored and pending); `false` when nothing could be deleted. Never rejects. */
  remove(url: string): Promise<boolean>;
  /**
   * "Clear all history": asks first in main's own message box (`CLEAR_HISTORY`), then clears every
   * visit and the closed-tab stack. `true` once cleared, `false` when cancelled or failed. Never rejects.
   */
  clearAll(): Promise<boolean>;
  /** Reopens the most recently closed tab; its id, or `null` (none, no window, or `MAX_TABS`). */
  reopenClosedTab(): number | null;
  /** Asks the chrome to open the History view (bumps `BrowserState.historyViewSeq`). */
  show(): void;
}

export interface SettingsService {
  searchEngine(): SearchEngineId;
  /** Stores the engine choice and uses it at once; `false` when it could not be stored. Never rejects. */
  setSearchEngine(engine: SearchEngineId): Promise<boolean>;
}
