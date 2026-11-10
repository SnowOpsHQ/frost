import { PURGE_REASONS } from '@app/specs/capture-db.spec';
import type { Migration } from '../migrations';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

// Phase 12 Task 4 (spec `workspace-db.spec.ts`, `SERP_API_READINGS_MIGRATION_IDS`; acceptance
// `workspace-db.feature.md`, API readings (Phase 12); plan `docs/plans/phase-12-big-bets.md`, Decision 7
// and Global constraints): API readings (`source = 'serp-api'`, no capture) can be deleted, by a
// recorded purge only. Phase 10's `0223` is never edited: its capture-only delete guard is dropped by
// name and recreated here with a second arm; `ci_serp_readings_no_update` and
// `ci_serp_readings_no_replace` are untouched. Plain portable SQL (`change-intel-sql-is-portable`).
// `serp-api-schema.ts` declares the table. Each record names its purge (`purge_id`: the `ci_purges` row's
// id when the purge also removed captured rows; an API-only purge writes no `ci_purges` row, so this
// table is its only, device-local, log), the purge's reason, the project and the time.

const SERP_API_READINGS = `
  CREATE TABLE ci_serp_api_purges (
    reading_id TEXT PRIMARY KEY NOT NULL CHECK (length(reading_id) = 36),
    purge_id TEXT NOT NULL CHECK (length(purge_id) = 36),
    reason TEXT NOT NULL CHECK (reason IN (${list(PURGE_REASONS)})),
    project_id TEXT NOT NULL CHECK (length(project_id) = 36),
    purged_at INTEGER NOT NULL
  );
  CREATE INDEX ci_serp_api_purges_project_id_purged_at ON ci_serp_api_purges (project_id, purged_at);
  CREATE TRIGGER ci_serp_api_purges_no_update BEFORE UPDATE ON ci_serp_api_purges
  BEGIN SELECT RAISE(ABORT, 'ci_serp_api_purges is append-only'); END;
  CREATE TRIGGER ci_serp_api_purges_no_delete BEFORE DELETE ON ci_serp_api_purges
  BEGIN SELECT RAISE(ABORT, 'ci_serp_api_purges is append-only'); END;
  DROP TRIGGER ci_serp_readings_capture_gone_only;
  CREATE TRIGGER ci_serp_readings_delete_guard BEFORE DELETE ON ci_serp_readings
  WHEN NOT (
    (OLD.source = 'capture' AND NOT EXISTS (SELECT 1 FROM ci_captures WHERE id = OLD.capture_id))
    OR (OLD.source = 'serp-api' AND EXISTS (SELECT 1 FROM ci_serp_api_purges WHERE reading_id = OLD.id))
  )
  BEGIN SELECT RAISE(ABORT, 'ci_serp_readings rows are deleted only once their capture is gone, or by a recorded purge'); END;
  CREATE TRIGGER ci_serp_readings_no_resurrect BEFORE INSERT ON ci_serp_readings
  WHEN EXISTS (SELECT 1 FROM ci_serp_api_purges WHERE reading_id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'ci_serp_readings row was purged'); END;
`;

/** Migration `0245_serp_api_readings` (`SERP_API_READINGS_MIGRATION_IDS`), spread in `MIGRATIONS` in id order. */
export const SERP_API_READINGS_MIGRATIONS: readonly Migration[] = [{ id: '0245_serp_api_readings', sql: SERP_API_READINGS }];
