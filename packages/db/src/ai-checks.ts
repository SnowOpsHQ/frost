import { desc, eq, notInArray, sql } from 'drizzle-orm';
import { AI_CHECK_LIMITS } from '@app/specs/ai-checks.spec';
import { AiCheckOutputSchema, AiCheckResultSchema, type AiCheckResult } from '@app/specs/ai-checks.schema';
import type { SessionDatabase } from './client';
import { seoAiChecks } from './ai-checks-schema';

// The AI checks' answers (Phase 9 Task 10; spec `specs/ai-checks.spec.ts`; acceptance
// `specs/ai-checks.feature.md`, Storage): one row per page URL, at most
// `AI_CHECK_LIMITS.maxStoredUrls` (the most recently checked), removed by Clear Browsing Data.
// Every value is checked both ways (`AiCheckResultSchema`): an invalid answer is refused, and a
// tampered row reads as no answer.

export interface AiChecksRepository {
  /** The stored answer for `url`, or `null` (none, or a row that is not a well-formed answer). */
  get(url: string): Promise<AiCheckResult | null>;
  /** Stores `result` in place of its URL's, then keeps the newest `maxStoredUrls`; `false` (nothing written) for an invalid one. */
  put(result: AiCheckResult): Promise<boolean>;
  /** Clear Browsing Data: every answer goes. */
  clear(): Promise<void>;
}

/** Longest `result_json` read back (one over is not an answer): the answer's own caps, generously. */
const MAX_RESULT_JSON_CHARS = 4_096;

export function createAiChecksRepository(db: SessionDatabase): AiChecksRepository {
  const prune = () => {
    const kept = db.select({ url: seoAiChecks.url }).from(seoAiChecks).orderBy(desc(seoAiChecks.checkedAt), desc(seoAiChecks.url)).limit(AI_CHECK_LIMITS.maxStoredUrls);
    return db.delete(seoAiChecks).where(notInArray(seoAiChecks.url, kept));
  };
  return {
    async get(url) {
      if (typeof url !== 'string' || url.length > AI_CHECK_LIMITS.maxUrlChars) return null;
      // A tampered file may hold values of any size: read no more of each than an answer can be (one over).
      const [row] = await db
        .select({
          url: seoAiChecks.url,
          inputHash: sql<unknown>`substr(${seoAiChecks.inputHash}, 1, 65)`,
          resultJson: sql<unknown>`substr(${seoAiChecks.resultJson}, 1, ${MAX_RESULT_JSON_CHARS + 1})`,
          modelId: sql<unknown>`substr(${seoAiChecks.modelId}, 1, 257)`,
          checkedAt: seoAiChecks.checkedAt,
        })
        .from(seoAiChecks)
        .where(eq(seoAiChecks.url, url))
        .limit(1);
      if (!row || typeof row.resultJson !== 'string' || row.resultJson.length > MAX_RESULT_JSON_CHARS) return null;
      let output: unknown;
      try {
        output = JSON.parse(row.resultJson);
      } catch {
        return null;
      }
      const parsed = AiCheckResultSchema.safeParse({ url: row.url, inputHash: row.inputHash, modelId: row.modelId, checkedAt: row.checkedAt, output });
      return parsed.success ? parsed.data : null;
    },

    async put(result) {
      const parsed = AiCheckResultSchema.safeParse(result);
      if (!parsed.success) return false;
      const { url, inputHash, modelId, checkedAt, output } = parsed.data;
      // Only the answer's own keys are stored (strict: nothing else rides along).
      const resultJson = JSON.stringify(AiCheckOutputSchema.parse(output));
      if (resultJson.length > MAX_RESULT_JSON_CHARS) return false;
      await db.batch([
        db.insert(seoAiChecks).values({ url, inputHash, resultJson, modelId, checkedAt }).onConflictDoUpdate({ target: seoAiChecks.url, set: { inputHash, resultJson, modelId, checkedAt } }),
        prune(),
      ]);
      return true;
    },

    async clear() {
      await db.delete(seoAiChecks);
    },
  };
}
