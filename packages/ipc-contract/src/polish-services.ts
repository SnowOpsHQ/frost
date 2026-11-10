import type { HistoryClearRange, HistoryRetention, HistoryRetentionResult, SearchEngineId } from '@app/specs/browser-polish.spec';

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
  /** `list` only (Phase 11 Task 10): how many times frost recorded the page changing (`browser-polish.spec.ts`). */
  readonly changeCount?: number;
}

/** How long visits are kept, and whether visits to project pages are kept anyway (Phase 11 Task 10). */
export interface HistoryRetentionAnswer {
  readonly retention: HistoryRetention;
  readonly keepProjectPages: boolean;
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
  /**
   * One page of visits, newest first (pending visit writes are flushed first), each with its
   * `changeCount`; with `projectId`, only visits to that live project's live pages. Never rejects: an
   * empty page on failure.
   */
  list(query: string, after: HistoryCursorAnswer | null, limit?: number, projectId?: string): Promise<HistoryPageAnswer>;
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
  /** Phase 11 Task 10: the retention settings (their defaults when they cannot be read). Never rejects. */
  retention(): Promise<HistoryRetentionAnswer>;
  /**
   * Stores the retention settings and applies them at once. A change that would delete visits
   * (`historyRetentionDeletes`) asks first in main's own message box (`CONFIRM_HISTORY_RETENTION`):
   * `cancelled` stores nothing. `failed` when they could not be stored. Never rejects.
   */
  setRetention(settings: HistoryRetentionAnswer): Promise<HistoryRetentionResult>;
  /**
   * Clear by range: asks first in main's own message box (`CLEAR_HISTORY_RANGE`), then clears every
   * visit last seen within the range (pending ones written first) and the closed-tab stack. `true`
   * once cleared, `false` when cancelled or failed. Never rejects.
   */
  clearRange(range: HistoryClearRange): Promise<boolean>;
}

export interface SettingsService {
  searchEngine(): SearchEngineId;
  /** Stores the engine choice and uses it at once; `false` when it could not be stored. Never rejects. */
  setSearchEngine(engine: SearchEngineId): Promise<boolean>;
}
