import type { Migration } from './migrations';

// The AI answers (Phase 12 Task 9; spec `specs/ai-answers.spec.ts`, `AI_ANSWERS_TABLES`; acceptance
// `specs/ai-answers.feature.md`, Storage). Ids `0240`–`0249` are Phase 12's; this list is spread in
// `MIGRATIONS` in id order after the site crawl's `0240`/`0241` and before the data usage counter's
// `0243` (plan Global constraints). It creates exactly the table of `ai-answers-schema.ts`. The
// `CHECK`s spell out `AI_SEARCH_ENGINES`, `AI_SEARCH_VIAS`, `DATA_AI_SEARCH_PROVIDERS`,
// `AI_ANSWER_ORIGINS` and `AI_ANSWERS_LIMITS` as they are at the time of writing
// (`ai-answers.test.ts` checks they refuse what is not): an applied migration never changes, so a
// new engine, via or provider needs a table rebuild in a new migration.

export const AI_ANSWERS_MIGRATIONS: readonly Migration[] = [
  {
    id: '0242_ai_answers',
    sql: `
      CREATE TABLE ai_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL CHECK (typeof(query) = 'text' AND length(query) BETWEEN 1 AND 256),
        engine TEXT NOT NULL CHECK (engine IN ('perplexity', 'chatgpt', 'google-ai-mode')),
        via TEXT NOT NULL CHECK (via IN ('api')),
        provider TEXT NOT NULL CHECK (provider IN ('perplexity', 'openai-search')),
        origin TEXT NOT NULL CHECK (origin IN ('agent', 'view')),
        answer TEXT NOT NULL CHECK (typeof(answer) = 'text' AND length(answer) BETWEEN 1 AND 8000),
        answer_truncated INTEGER NOT NULL CHECK (answer_truncated IN (0, 1)),
        citations_json TEXT NOT NULL CHECK (typeof(citations_json) = 'text' AND length(citations_json) <= 40000 AND json_valid(citations_json) AND json_type(citations_json) = 'array'),
        citations_total INTEGER NOT NULL CHECK (typeof(citations_total) = 'integer' AND citations_total >= 0),
        cited_domains_json TEXT NOT NULL CHECK (typeof(cited_domains_json) = 'text' AND length(cited_domains_json) <= 6000 AND json_valid(cited_domains_json) AND json_type(cited_domains_json) = 'array'),
        chat_id TEXT CHECK (chat_id IS NULL OR (typeof(chat_id) = 'text' AND length(chat_id) BETWEEN 1 AND 64)),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
      );
      CREATE INDEX ai_answers_created_at ON ai_answers (created_at);
    `,
  },
];
