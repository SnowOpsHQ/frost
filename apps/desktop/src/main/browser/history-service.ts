import type { HistoryRepository } from '@app/db';
import type { HistoryService, SettingsService } from '@app/ipc-contract';
import { DEFAULT_SEARCH_ENGINE, isSearchEngineId, type SearchEngineId } from '@app/specs/browser-polish.spec';

// The History view, the new-tab page, Reopen Closed Tab and the search engine setting in main (Phase
// 2.5 Task 6; acceptance `browser-polish.feature.md`). Reads go to `@app/db` after the session
// writer's pending visits are flushed; deletes go through the writer, so a visit still pending can't
// come back. "Clear all history" asks first in main and clears the history part of Clear Browsing
// Data (every visit and the closed-tab stack). Nothing here is reached by the page.

/** The session writer's history side (`SessionStore.writer`). */
export interface HistoryWriter {
  flush(): Promise<void>;
  deleteVisit(url: string): Promise<boolean>;
  clearHistory(): Promise<void>;
}

/** The browser controller's side. */
export interface HistoryTabs {
  reopenClosedTab(): number | null;
  showHistory(): void;
  forgetClosedTabs(): void;
}

export interface HistoryServiceOptions {
  readonly history: HistoryRepository;
  readonly writer: HistoryWriter;
  readonly tabs: HistoryTabs;
  /** Asks before "Clear all history" (`confirmClearHistory`); without it nothing is cleared. */
  readonly confirmClearAll?: () => Promise<boolean>;
  /** Where a failed database call is reported (it never reaches the chrome). */
  readonly log?: (message: string) => void;
}

/** "Clear all history": the history part of Clear Browsing Data (also run by it). */
export async function clearHistoryPart(writer: Pick<HistoryWriter, 'clearHistory'>, tabs: Pick<HistoryTabs, 'forgetClosedTabs'>): Promise<void> {
  tabs.forgetClosedTabs();
  await writer.clearHistory();
}

export function createHistoryService(options: HistoryServiceOptions): HistoryService {
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      options.log?.(`history: ${what} failed (${error instanceof Error ? error.message : 'unknown error'})`);
      return fallback;
    }
  };
  // Pending visits are written first, so the view lists the page just visited.
  const fresh = async <T>(read: () => Promise<T>): Promise<T> => {
    await options.writer.flush();
    return read();
  };
  let clearing: Promise<boolean> | null = null;
  return {
    list: (query, after, limit) => guarded('read', () => fresh(() => options.history.list({ query, after, ...(limit === undefined ? {} : { limit }) })), { visits: [], next: null }),
    jumpBackIn: () => guarded('read', () => fresh(() => options.history.jumpBackIn()), { mostVisited: [], recent: [] }),
    remove: (url) => guarded('delete', () => options.writer.deleteVisit(url), false),
    clearAll() {
      // While one runs, asking again answers that same run (never two dialogs).
      clearing ??= (async () => {
        const confirmed = await guarded('confirmation', () => options.confirmClearAll?.() ?? Promise.resolve(false), false);
        if (!confirmed) return false;
        return guarded(
          'clear',
          async () => {
            await clearHistoryPart(options.writer, options.tabs);
            return true;
          },
          false,
        );
      })().finally(() => {
        clearing = null;
      });
      return clearing;
    },
    reopenClosedTab: () => options.tabs.reopenClosedTab(),
    show: () => options.tabs.showHistory(),
  };
}

/** The search engine choice in main: loaded once at startup, stored at once on change. */
export interface SearchEngineSetting extends SettingsService {
  /** The stored choice, read before the first window opens (the default until then). */
  load(): Promise<void>;
}

export function createSearchEngineSetting(options: {
  readonly store: { searchEngine(): Promise<SearchEngineId>; setSearchEngine(engine: SearchEngineId, at: number): Promise<boolean> };
  /** The choice changed (the browser state reports it). */
  readonly changed: () => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}): SearchEngineSetting {
  let current: SearchEngineId = DEFAULT_SEARCH_ENGINE;
  const now = options.now ?? Date.now;
  return {
    async load() {
      try {
        const stored = await options.store.searchEngine();
        if (isSearchEngineId(stored)) current = stored;
      } catch (error) {
        options.log?.(`settings: read failed (${error instanceof Error ? error.message : 'unknown error'})`);
      }
    },
    searchEngine: () => current,
    async setSearchEngine(engine) {
      if (!isSearchEngineId(engine)) return false;
      let stored = false;
      try {
        stored = await options.store.setSearchEngine(engine, now());
      } catch (error) {
        options.log?.(`settings: write failed (${error instanceof Error ? error.message : 'unknown error'})`);
      }
      if (!stored) return false;
      if (current !== engine) {
        current = engine;
        options.changed();
      }
      return true;
    },
  };
}
