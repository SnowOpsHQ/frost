import type { Migration } from './migrations';

// The AI checks' answers (Phase 9 Task 10; ids `0210`–`0219` are Phase 9's), spread at the end of
// `MIGRATIONS` after Phase 8's `...AGENT_SKILL_PREFS_MIGRATIONS` (`0200`), so ids stay strictly
// increasing (each phase appends its list last, in phase order). It creates exactly the table of
// `ai-checks-schema.ts` (`AI_CHECKS_TABLES`).

export const AI_CHECKS_MIGRATIONS: readonly Migration[] = [
  {
    id: '0210_seo_ai_checks',
    sql: `
      CREATE TABLE seo_ai_checks (
        url TEXT PRIMARY KEY NOT NULL,
        input_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        model_id TEXT NOT NULL,
        checked_at INTEGER NOT NULL
      );
    `,
  },
];
