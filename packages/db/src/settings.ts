import { eq, sql } from 'drizzle-orm';
import { AI_CHECKS_SETTING_KEY, DEFAULT_AI_CHECK_MODE, isAiCheckMode, type AiCheckMode } from '@app/specs/ai-checks.spec';
import {
  DEFAULT_HISTORY_KEEP_PROJECT_PAGES,
  DEFAULT_HISTORY_RETENTION,
  DEFAULT_SEARCH_ENGINE,
  HISTORY_KEEP_PROJECT_PAGES_KEY,
  HISTORY_RETENTION_SETTING_KEY,
  isHistoryRetention,
  isSearchEngineId,
  SEARCH_ENGINE_SETTING_KEY,
  type HistoryRetention,
  type SearchEngineId,
} from '@app/specs/browser-polish.spec';
import type { SessionDatabase } from './client';
import { appSettings } from './settings-schema';

// Local preferences (Phase 2.5 Task 6; spec `browser-polish.spec.ts`; acceptance
// `browser-polish.feature.md`, Search engines): the search engine choice, and (Phase 9 Task 10,
// `ai-checks.spec.ts`) the AI checks mode. A value is checked on the way in (an unknown one is
// refused) and on the way out (a tampered row reads as the default: for AI checks, `off`).

export interface SettingsRepository {
  /** The stored engine, or `DEFAULT_SEARCH_ENGINE` when none (or an unknown one) is stored. */
  searchEngine(): Promise<SearchEngineId>;
  /** Stores the engine choice; `false` (nothing written) for anything but a `SEARCH_ENGINES` id. */
  setSearchEngine(engine: SearchEngineId, at: number): Promise<boolean>;
  /** The stored AI checks mode, or `DEFAULT_AI_CHECK_MODE` (`off`) when none (or an unknown one) is stored. */
  aiChecksMode(): Promise<AiCheckMode>;
  /** Stores the AI checks mode; `false` (nothing written) for anything but an `AI_CHECK_MODES` value. Main asks for consent first. */
  setAiChecksMode(mode: AiCheckMode, at: number): Promise<boolean>;
  /**
   * Phase 11 Task 10 (`browser-polish.spec.ts`, Decision 13): how long visits are kept and whether
   * visits to project pages are kept anyway; a missing or tampered value reads as its default.
   */
  historySettings(): Promise<HistorySettings>;
  /** Stores both; `false` (nothing written) for an unknown retention or a non-boolean. */
  setHistorySettings(settings: HistorySettings, at: number): Promise<boolean>;
}

export interface HistorySettings {
  readonly retention: HistoryRetention;
  readonly keepProjectPages: boolean;
}

/** Longest stored setting value read back (an engine id or a mode is short; anything longer is not one). */
const MAX_SETTING_CHARS = 64;

export function createSettingsRepository(db: SessionDatabase): SettingsRepository {
  const read = async (key: string): Promise<unknown> => {
    const [row] = await db
      .select({ value: sql<unknown>`substr(${appSettings.value}, 1, ${MAX_SETTING_CHARS})` })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return row?.value;
  };
  const write = (key: string, value: string, at: number) =>
    db
      .insert(appSettings)
      .values({ key, value, updatedAt: at })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: at } });
  return {
    async searchEngine() {
      const value = await read(SEARCH_ENGINE_SETTING_KEY);
      return isSearchEngineId(value) ? value : DEFAULT_SEARCH_ENGINE;
    },

    async setSearchEngine(engine, at) {
      if (!isSearchEngineId(engine) || !Number.isFinite(at)) return false;
      await write(SEARCH_ENGINE_SETTING_KEY, engine, at);
      return true;
    },

    async aiChecksMode() {
      const value = await read(AI_CHECKS_SETTING_KEY);
      return isAiCheckMode(value) ? value : DEFAULT_AI_CHECK_MODE;
    },

    async setAiChecksMode(mode, at) {
      if (!isAiCheckMode(mode) || !Number.isFinite(at)) return false;
      await write(AI_CHECKS_SETTING_KEY, mode, at);
      return true;
    },

    async historySettings() {
      const [retention, keep] = [await read(HISTORY_RETENTION_SETTING_KEY), await read(HISTORY_KEEP_PROJECT_PAGES_KEY)];
      return {
        retention: isHistoryRetention(retention) ? retention : DEFAULT_HISTORY_RETENTION,
        keepProjectPages: keep === '1' ? true : keep === '0' ? false : DEFAULT_HISTORY_KEEP_PROJECT_PAGES,
      };
    },

    async setHistorySettings({ retention, keepProjectPages }, at) {
      if (!isHistoryRetention(retention) || typeof keepProjectPages !== 'boolean' || !Number.isFinite(at)) return false;
      await db.batch([write(HISTORY_RETENTION_SETTING_KEY, retention, at), write(HISTORY_KEEP_PROJECT_PAGES_KEY, keepProjectPages ? '1' : '0', at)]);
      return true;
    },
  };
}
