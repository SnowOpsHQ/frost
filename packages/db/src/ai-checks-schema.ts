import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The AI checks' answers (Phase 9 Task 10; spec `specs/ai-checks.spec.ts`, `AI_CHECKS_TABLES`;
// acceptance `specs/ai-checks.feature.md`, Storage). Migration `0210_seo_ai_checks` creates exactly
// this table. One row per page URL (fragment and userinfo dropped): the latest answer, the sha-256
// of the input it judged (`input_hash`), the answer itself as JSON (`AiCheckOutputSchema`), the
// model that gave it, and when (Unix milliseconds).

export const seoAiChecks = sqliteTable('seo_ai_checks', {
  url: text('url').primaryKey(),
  inputHash: text('input_hash').notNull(),
  resultJson: text('result_json').notNull(),
  modelId: text('model_id').notNull(),
  checkedAt: integer('checked_at').notNull(),
});
