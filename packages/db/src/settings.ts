import { eq, sql } from 'drizzle-orm';
import { DEFAULT_SEARCH_ENGINE, isSearchEngineId, SEARCH_ENGINE_SETTING_KEY, type SearchEngineId } from '@app/specs/browser-polish.spec';
import type { SessionDatabase } from './client';
import { appSettings } from './settings-schema';

// Local preferences (Phase 2.5 Task 6; spec `browser-polish.spec.ts`; acceptance
// `browser-polish.feature.md`, Search engines): the search engine choice. A value is checked on the
// way in (an unknown engine is refused) and on the way out (a tampered row reads as the default).

export interface SettingsRepository {
  /** The stored engine, or `DEFAULT_SEARCH_ENGINE` when none (or an unknown one) is stored. */
  searchEngine(): Promise<SearchEngineId>;
  /** Stores the engine choice; `false` (nothing written) for anything but a `SEARCH_ENGINES` id. */
  setSearchEngine(engine: SearchEngineId, at: number): Promise<boolean>;
}

/** Longest stored setting value read back (an engine id is short; anything longer is not one). */
const MAX_SETTING_CHARS = 64;

export function createSettingsRepository(db: SessionDatabase): SettingsRepository {
  return {
    async searchEngine() {
      const [row] = await db
        .select({ value: sql<unknown>`substr(${appSettings.value}, 1, ${MAX_SETTING_CHARS})` })
        .from(appSettings)
        .where(eq(appSettings.key, SEARCH_ENGINE_SETTING_KEY))
        .limit(1);
      return row && isSearchEngineId(row.value) ? row.value : DEFAULT_SEARCH_ENGINE;
    },

    async setSearchEngine(engine, at) {
      if (!isSearchEngineId(engine) || !Number.isFinite(at)) return false;
      await db
        .insert(appSettings)
        .values({ key: SEARCH_ENGINE_SETTING_KEY, value: engine, updatedAt: at })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: engine, updatedAt: at } });
      return true;
    },
  };
}
