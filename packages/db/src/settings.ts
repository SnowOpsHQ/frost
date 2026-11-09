import { eq, sql } from 'drizzle-orm';
import { AI_CHECKS_SETTING_KEY, DEFAULT_AI_CHECK_MODE, isAiCheckMode, type AiCheckMode } from '@app/specs/ai-checks.spec';
import { DEFAULT_SEARCH_ENGINE, isSearchEngineId, SEARCH_ENGINE_SETTING_KEY, type SearchEngineId } from '@app/specs/browser-polish.spec';
import { RANK_RUN_DISCLOSURE_SETTING_KEY } from '@app/specs/projects.spec';
import type { SessionDatabase } from './client';
import { appSettings } from './settings-schema';

// Local preferences (Phase 2.5 Task 6; spec `browser-polish.spec.ts`; acceptance
// `browser-polish.feature.md`, Search engines): the search engine choice, and (Phase 9 Task 10,
// `ai-checks.spec.ts`) the AI checks mode, and (Phase 10 Task 8, `projects.spec.ts`) whether the rank
// run disclosure was answered Continue on this install. A value is checked on the way in (an unknown one
// is refused) and on the way out (a tampered row reads as the default: for AI checks, `off`; for the
// disclosure, not accepted, so main asks again).

export interface SettingsRepository {
  /** The stored engine, or `DEFAULT_SEARCH_ENGINE` when none (or an unknown one) is stored. */
  searchEngine(): Promise<SearchEngineId>;
  /** Stores the engine choice; `false` (nothing written) for anything but a `SEARCH_ENGINES` id. */
  setSearchEngine(engine: SearchEngineId, at: number): Promise<boolean>;
  /** The stored AI checks mode, or `DEFAULT_AI_CHECK_MODE` (`off`) when none (or an unknown one) is stored. */
  aiChecksMode(): Promise<AiCheckMode>;
  /** Stores the AI checks mode; `false` (nothing written) for anything but an `AI_CHECK_MODES` value. Main asks for consent first. */
  setAiChecksMode(mode: AiCheckMode, at: number): Promise<boolean>;
  /** Whether `RANK_RUN_DISCLOSURE` was answered Continue on this install; anything but the stored mark reads `false`. */
  rankRunDisclosureAccepted(): Promise<boolean>;
  /** Remembers that it was (main asked first); `false` (nothing written) for a time that is not finite. */
  setRankRunDisclosureAccepted(at: number): Promise<boolean>;
}

/** The value `RANK_RUN_DISCLOSURE_SETTING_KEY` holds once the disclosure was answered Continue. */
const DISCLOSURE_ACCEPTED = 'accepted';

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

    async rankRunDisclosureAccepted() {
      return (await read(RANK_RUN_DISCLOSURE_SETTING_KEY)) === DISCLOSURE_ACCEPTED;
    },

    async setRankRunDisclosureAccepted(at) {
      if (!Number.isFinite(at)) return false;
      await write(RANK_RUN_DISCLOSURE_SETTING_KEY, DISCLOSURE_ACCEPTED, at);
      return true;
    },
  };
}
