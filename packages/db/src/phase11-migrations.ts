import { MAX_RECT_JSON_BYTES, MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES } from '@app/specs/capture-db.spec';
import type { Migration } from './migrations';

// Phase 11's migrations (ids `0230`–`0239` are Phase 11's; Decision 18 of
// `docs/plans/phase-11-practitioner-tooling.md`), spread **last** in `MIGRATIONS`, after every earlier
// phase's block, so ids stay strictly increasing. Kept in id order: Task 8's `0230` goes before `0231`.

export const PHASE11_MIGRATIONS: readonly Migration[] = [
  {
    // Task 8 (Decision 10): chat history. `archived_at` (when the user archived the chat, `NULL`:
    // not archived) hides it from the default list; `title_by_user` (0 or 1) marks a title the user
    // gave, which a save carrying the automatic one never replaces (`agent-chats.ts`). Neither touches
    // `updated_at`, so the retention and the `MAX_STORED_CHATS` cap apply to archived chats as to any.
    id: '0230_agent_chat_lifecycle',
    sql: `
      ALTER TABLE agent_chats ADD COLUMN archived_at INTEGER;
      ALTER TABLE agent_chats ADD COLUMN title_by_user INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Task 7 (Decision 9): the local-only link from an edited screenshot to its source
    // (`capture-db.spec.ts`, `SCREENSHOT_EDIT_TABLES`; `change-intel/schema.ts`, `screenshotEdits`).
    // Not synced, not append-only. When the copy's row is deleted (a purge, or a synced tombstone), the
    // trigger removes the link. The link outlives its source (council round 1): a copy whose source has
    // gone stays an edited copy (its own retention lane, labelled Edited), its `source_id` dangling.
    id: '0231_screenshot_edits',
    sql: `
      CREATE TABLE screenshot_edits (
        screenshot_id TEXT PRIMARY KEY NOT NULL CHECK (length(screenshot_id) = 36),
        source_id TEXT NOT NULL CHECK (length(source_id) = 36 AND source_id <> screenshot_id),
        crop TEXT CHECK (crop IS NULL OR length(CAST(crop AS BLOB)) <= ${MAX_RECT_JSON_BYTES}),
        ops TEXT NOT NULL CHECK (length(CAST(ops AS BLOB)) <= ${MAX_SCREENSHOT_EDIT_OPS_JSON_BYTES}),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
      );
      CREATE INDEX screenshot_edits_source_id ON screenshot_edits (source_id);
      CREATE TRIGGER screenshot_edits_follow_screenshots AFTER DELETE ON ci_screenshots
      BEGIN
        DELETE FROM screenshot_edits WHERE screenshot_id = OLD.id;
      END;
    `,
  },
];
