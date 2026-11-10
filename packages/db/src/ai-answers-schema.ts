import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The AI answers (Phase 12 Task 9; spec `specs/ai-answers.spec.ts`, `AI_ANSWERS_TABLES`, `AI_ANSWERS_LIMITS`;
// acceptance `specs/ai-answers.feature.md`, Storage). Migration `0242_ai_answers` creates exactly this
// table: one row per answer (the agent's `run_ai_search` or the view's own run), newest by `id`.
// Citations and cited domains are JSON text; `chat_id` is nullable. Device-local (not in `SYNC_TABLES`).
// Times are Unix milliseconds.

export const aiAnswers = sqliteTable(
  'ai_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    query: text('query').notNull(),
    engine: text('engine').notNull(),
    via: text('via').notNull(),
    provider: text('provider').notNull(),
    origin: text('origin').notNull(),
    answer: text('answer').notNull(),
    answerTruncated: integer('answer_truncated').notNull(),
    citationsJson: text('citations_json').notNull(),
    citationsTotal: integer('citations_total').notNull(),
    citedDomainsJson: text('cited_domains_json').notNull(),
    chatId: text('chat_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('ai_answers_created_at').on(table.createdAt)],
);
