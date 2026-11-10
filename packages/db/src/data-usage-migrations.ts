import type { Migration } from './migrations';

// The data API usage counter (Phase 12 Task 2; spec `specs/data-sources.spec.ts`, `DATA_USAGE_TABLES`;
// acceptance `specs/data-sources.feature.md`, Usage counter). Ids `0240`–`0249` are Phase 12's; this
// list is spread in `MIGRATIONS` in id order after Phase 11's block (plan Global constraints): after
// the site crawl's `0240`/`0241` and, once it lands, the AI answers' `0242`. It creates exactly the
// table of `data-usage-schema.ts`. The `CHECK`s spell out `DATA_PROVIDERS` and
// `DATA_USAGE_LIMITS.maxRequests` as they are at the time of writing (`data-usage.test.ts` checks they
// accept exactly them): an applied migration never changes, so a new provider needs a table rebuild
// in a new migration.

export const DATA_USAGE_MIGRATIONS: readonly Migration[] = [
  {
    id: '0243_data_api_usage',
    sql: `
      CREATE TABLE data_api_usage (
        provider TEXT NOT NULL CHECK (provider IN ('serpapi', 'dataforseo', 'serper', 'perplexity', 'openai-search')),
        month TEXT NOT NULL CHECK (length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(month, 6, 2) BETWEEN '01' AND '12'),
        requests INTEGER NOT NULL CHECK (typeof(requests) = 'integer' AND requests BETWEEN 0 AND 2147483647),
        PRIMARY KEY (provider, month)
      );
    `,
  },
];
