import type { HistoryRepository, HistorySettings, SettingsRepository } from '@app/db';
import type { HistoryService, SettingsService } from '@app/ipc-contract';
import {
  DEFAULT_HISTORY_KEEP_PROJECT_PAGES,
  DEFAULT_HISTORY_RETENTION,
  DEFAULT_SEARCH_ENGINE,
  HISTORY_RETENTION_INTERVAL_MS,
  historyClearSince,
  historyRetentionCutoff,
  historyRetentionDeletes,
  isHistoryRetention,
  isSearchEngineId,
  type HistoryClearRange,
  type HistoryRetentionResult,
  type SearchEngineId,
} from '@app/specs/browser-polish.spec';

// The History view, the new-tab page, Reopen Closed Tab and the search engine setting in main (Phase
// 2.5 Task 6; acceptance `browser-polish.feature.md`). Reads go to `@app/db` after the session
// writer's pending visits are flushed; deletes go through the writer, so a visit still pending can't
// come back. "Clear all history" asks first in main and clears the history part of Clear Browsing
// Data (every visit and the closed-tab stack). Nothing here is reached by the page.
// Phase 11 Task 10 (Decision 13): the retention settings live in `app_settings`; main prunes with them
// at start, then once a day (an injected scheduler), and at once when they change. "Clear by range"
// asks in main too, writes pending visits first, then clears the rows last seen in the range.

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
  readonly history: Pick<HistoryRepository, 'list' | 'jumpBackIn'> & Partial<Pick<HistoryRepository, 'prune' | 'clearSince'>>;
  readonly writer: HistoryWriter;
  readonly tabs: HistoryTabs;
  /** Asks before "Clear all history" (`confirmClearHistory`); without it nothing is cleared. */
  readonly confirmClearAll?: () => Promise<boolean>;
  /** Asks before clearing a range (`confirmClearHistoryRange`); without it nothing is cleared. */
  readonly confirmClearRange?: (range: HistoryClearRange) => Promise<boolean>;
  /**
   * Asks before a retention change that would delete visits (`confirmHistoryRetention`, from the stored
   * settings to the new ones); without it such a change is never stored.
   */
  readonly confirmRetention?: (stored: HistorySettings, next: HistorySettings) => Promise<boolean>;
  /**
   * The retention settings (`app_settings`). With them (and `history.prune`) the service prunes at
   * once, then every `HISTORY_RETENTION_INTERVAL_MS`; without them it never prunes.
   */
  readonly settings?: Pick<SettingsRepository, 'historySettings' | 'setHistorySettings'>;
  readonly now?: () => number;
  /** Runs `run` every `ms` until the returned stop is called (default: an unref'd `setInterval`). */
  readonly every?: (run: () => void, ms: number) => () => void;
  /** Where a failed database call is reported (it never reaches the chrome). */
  readonly log?: (message: string) => void;
}

/** Main's history service: the `history.*` procedures', plus the retention run for tests and shutdown. */
export interface MainHistoryService extends HistoryService {
  /** The prune at start (settled; resolves at once without settings). */
  readonly started: Promise<void>;
  /** Prunes now with the stored settings (one run at a time). */
  applyRetention(): Promise<void>;
  /** Stops the daily run. */
  stop(): void;
}

const DEFAULT_HISTORY_SETTINGS: HistorySettings = { retention: DEFAULT_HISTORY_RETENTION, keepProjectPages: DEFAULT_HISTORY_KEEP_PROJECT_PAGES };

function defaultEvery(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** "Clear all history": the history part of Clear Browsing Data (also run by it). */
export async function clearHistoryPart(writer: Pick<HistoryWriter, 'clearHistory'>, tabs: Pick<HistoryTabs, 'forgetClosedTabs'>): Promise<void> {
  tabs.forgetClosedTabs();
  await writer.clearHistory();
}

export function createHistoryService(options: HistoryServiceOptions): MainHistoryService {
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
  let clearingRange: Promise<boolean> | null = null;
  let retentionChange: Promise<void> = Promise.resolve();
  const now = options.now ?? Date.now;
  const settings = options.settings;
  const prune = options.history.prune?.bind(options.history);
  const clearSince = options.history.clearSince?.bind(options.history);
  const readSettings = (): Promise<HistorySettings> => (settings ? guarded('settings read', () => settings.historySettings(), DEFAULT_HISTORY_SETTINGS) : Promise.resolve(DEFAULT_HISTORY_SETTINGS));
  /** One prune at a time: a later request runs after the one under way. */
  let retentionTail: Promise<void> = Promise.resolve();
  const applyRetention = (): Promise<void> => {
    retentionTail = retentionTail.then(async () => {
      if (!settings || !prune) return;
      const { retention, keepProjectPages } = await readSettings();
      const before = historyRetentionCutoff(retention, now());
      if (before === null) return;
      await guarded(
        'prune',
        async () => {
          await options.writer.flush();
          await prune(before, keepProjectPages);
        },
        undefined,
      );
    });
    return retentionTail;
  };
  const started = applyRetention();
  const stop = settings && prune ? (options.every ?? defaultEvery)(() => void applyRetention(), HISTORY_RETENTION_INTERVAL_MS) : () => {};
  return {
    started,
    applyRetention,
    stop,
    list: (query, after, limit, projectId) =>
      guarded('read', () => fresh(() => options.history.list({ query, after, ...(limit === undefined ? {} : { limit }), ...(projectId === undefined ? {} : { projectId }) })), { visits: [], next: null }),
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
    retention: readSettings,
    setRetention(next) {
      // One change at a time (never two dialogs); a later one waits for the one under way.
      const run = retentionChange.then(async (): Promise<HistoryRetentionResult> => {
        if (!settings || !isHistoryRetention(next.retention) || typeof next.keepProjectPages !== 'boolean') return 'failed';
        const wanted: HistorySettings = { retention: next.retention, keepProjectPages: next.keepProjectPages };
        // A change that would delete visits asks in main first: the chrome's own UI is never trusted to have asked.
        const current = await guarded<HistorySettings | null>('settings read', () => settings.historySettings(), null);
        if (current === null) return 'failed';
        if (historyRetentionDeletes(current, wanted)) {
          const confirmed = await guarded('confirmation', () => options.confirmRetention?.(current, wanted) ?? Promise.resolve(false), false);
          if (!confirmed) return 'cancelled';
        }
        const stored = await guarded('settings write', () => settings.setHistorySettings(wanted, now()), false);
        if (stored !== true) return 'failed';
        void applyRetention();
        return 'stored';
      });
      retentionChange = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    clearRange(range) {
      // While one runs, asking again answers that same run (never two dialogs).
      clearingRange ??= (async () => {
        if (!clearSince) return false;
        const confirmed = await guarded('confirmation', () => options.confirmClearRange?.(range) ?? Promise.resolve(false), false);
        if (!confirmed) return false;
        return guarded(
          'clear range',
          async () => {
            // Pending visits are written first, so one in the range is cleared with the rest.
            await options.writer.flush();
            options.tabs.forgetClosedTabs();
            await clearSince(historyClearSince(range, now()));
            return true;
          },
          false,
        );
      })().finally(() => {
        clearingRange = null;
      });
      return clearingRange;
    },
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
