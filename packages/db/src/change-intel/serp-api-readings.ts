import { eq, sql } from 'drizzle-orm';
import type { SessionDatabase } from '../client';
import { batch, insertWhere, isId, isTime, liveProject, pageKey } from './checks';
import { isCaptureReading, readingRow, type CaptureReadingInput } from './readings';
import { ciSerpReadings } from './workspace-schema';

// API readings (Phase 12 Task 4; spec `workspace-db.spec.ts`; acceptance `workspace-db.feature.md`, API
// readings (Phase 12); plan `docs/plans/phase-12-big-bets.md`, Decision 7). A SERP API's answer, mapped
// to a `SerpSnapshot` (Task 3), stored as an ordinary reading of the project with `source =
// 'serp-api'` and no capture. This is the **only** path that writes one: Phase 10's public
// `appendReading` and `appendCapture` still refuse every source but `capture`. Deleted only by a
// recorded purge (`purge.ts`, `ci_serp_api_purges`), and a recorded id never comes back (`0245`).

/** An API reading as main hands it in: the reading's own fields, plus its project, vendor URL and time. */
export interface AppendApiReadingInput extends CaptureReadingInput {
  readonly projectId: string;
  /** The vendor's canonical SERP request URL (`serpApiReadingPageUrl`; no query, no key), or `null`. */
  readonly pageUrl: string | null;
  readonly observedAt: number;
  readonly createdAt: number;
}

export interface ApiReadingOperations {
  /**
   * Writes a `serp-api` reading (`capture_id` `NULL`) into a live project; `false` and nothing
   * written for an invalid reading, a project that is not live, a taken id or a purged (recorded) one.
   */
  appendApiReading(input: AppendApiReadingInput): Promise<boolean>;
}

export function createApiReadingOperations(db: SessionDatabase): ApiReadingOperations {
  const exists = async (id: string): Promise<boolean> => (await db.select({ id: ciSerpReadings.id }).from(ciSerpReadings).where(eq(ciSerpReadings.id, id)).limit(1)).length > 0;

  return {
    async appendApiReading(input) {
      if (typeof input !== 'object' || input === null) return false;
      // Only what an API reading may carry: no capture, no other source.
      const { captureId, source } = input as { captureId?: unknown; source?: unknown };
      if ((captureId !== undefined && captureId !== null) || (source !== undefined && source !== 'serp-api')) return false;
      const { projectId, observedAt, createdAt } = input;
      const pageUrl = input.pageUrl === null ? null : pageKey(input.pageUrl);
      if (!isCaptureReading(input) || !isId(projectId) || (input.pageUrl !== null && pageUrl !== input.pageUrl) || !isTime(observedAt) || !isTime(createdAt)) return false;
      if (await exists(input.id)) return false;
      const row = readingRow(input, { projectId, captureId: null, source: 'serp-api', pageUrl, observedAt, createdAt });
      // Checked inside the insert: the project is live, the id is new and was never purged (the
      // `0245` trigger refuses a recorded id too; checked here so a refusal answers `false`).
      const condition = sql`${liveProject(projectId)} AND NOT EXISTS (SELECT 1 FROM ci_serp_readings WHERE id = ${input.id}) AND NOT EXISTS (SELECT 1 FROM ci_serp_api_purges WHERE reading_id = ${input.id})`;
      await batch(db, [insertWhere(db, ciSerpReadings, row, condition)]);
      return exists(input.id);
    },
  };
}
