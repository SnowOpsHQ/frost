import { AUDIT_TABLES, CAPTURE_SOURCES, CAPTURED_TABLES, RETENTION_MODES, PURGE_REASONS, SCREENSHOT_KINDS, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import type { Migration } from '../migrations';

// The change-intelligence tables (Phase 6 Task 1; spec `capture-db.spec.ts`; acceptance
// `capture-db.feature.md`, Schema and Immutability; the contract is the plan's Schema section).
// Plain SQLite only, so the schema moves to libSQL unchanged (`change-intel-sql-is-portable`). No
// foreign keys: a version's parent and a screenshot's capture may be purged first, and a sync
// inserts rows in any order. `schema.ts` declares exactly these tables.

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const id = 'id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36)';

const TABLES = `
  CREATE TABLE ci_projects (
    ${id},
    name TEXT NOT NULL,
    render_profile TEXT,
    retention_mode TEXT NOT NULL CHECK (retention_mode IN (${list(RETENTION_MODES)})),
    retention_value INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE ci_project_pages (
    ${id},
    project_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX ci_project_pages_project_id ON ci_project_pages (project_id);
  CREATE UNIQUE INDEX ci_project_pages_live_url ON ci_project_pages (project_id, url) WHERE deleted_at IS NULL;
  CREATE TABLE ci_project_queries (
    ${id},
    project_id TEXT NOT NULL,
    query TEXT NOT NULL,
    search_params TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX ci_project_queries_project_id ON ci_project_queries (project_id);
  CREATE UNIQUE INDEX ci_project_queries_live_query ON ci_project_queries (project_id, query, search_params) WHERE deleted_at IS NULL;
  CREATE TABLE ci_versions (
    ${id},
    lane_key TEXT NOT NULL,
    page_url TEXT NOT NULL,
    render_profile TEXT,
    search_params TEXT,
    snapshot TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    snapshot_bytes INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    parent_version_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ci_versions_lane_key_created_at ON ci_versions (lane_key, created_at);
  CREATE INDEX ci_versions_page_url_created_at ON ci_versions (page_url, created_at);
  CREATE TABLE ci_captures (
    ${id},
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    lane_key TEXT NOT NULL,
    page_url TEXT NOT NULL,
    render_profile TEXT,
    render_profile_partial INTEGER NOT NULL CHECK (render_profile_partial IN (0, 1)),
    search_params TEXT,
    source TEXT NOT NULL CHECK (source IN (${list(CAPTURE_SOURCES)})),
    audit_taken_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ci_captures_project_id_created_at ON ci_captures (project_id, created_at);
  CREATE INDEX ci_captures_version_id ON ci_captures (version_id);
  CREATE INDEX ci_captures_page_url_created_at ON ci_captures (page_url, created_at);
  CREATE TABLE ci_diffs (
    ${id},
    lane_key TEXT NOT NULL,
    from_version_id TEXT NOT NULL,
    to_version_id TEXT NOT NULL,
    engine_version INTEGER NOT NULL,
    diff TEXT NOT NULL,
    summary TEXT NOT NULL,
    change_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ci_diffs_to_version_id ON ci_diffs (to_version_id);
  CREATE TABLE ci_screenshots (
    ${id},
    project_id TEXT NOT NULL,
    page_url TEXT NOT NULL,
    capture_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN (${list(SCREENSHOT_KINDS)})),
    rect TEXT,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    segments INTEGER NOT NULL,
    render_profile TEXT,
    search_params TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ci_screenshots_project_id_created_at ON ci_screenshots (project_id, created_at);
  CREATE INDEX ci_screenshots_page_url_created_at ON ci_screenshots (page_url, created_at);
  CREATE INDEX ci_screenshots_sha256 ON ci_screenshots (sha256);
  CREATE TABLE ci_purges (
    ${id},
    reason TEXT NOT NULL CHECK (reason IN (${list(PURGE_REASONS)})),
    project_id TEXT,
    policy TEXT,
    captures INTEGER NOT NULL,
    versions INTEGER NOT NULL,
    diffs INTEGER NOT NULL,
    screenshots INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ci_tombstones (
    ${id},
    purge_id TEXT NOT NULL,
    table_name TEXT NOT NULL CHECK (table_name IN (${list(CAPTURED_TABLES)})),
    row_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (table_name, row_id)
  );
  CREATE INDEX ci_tombstones_purge_id ON ci_tombstones (purge_id);
  INSERT INTO ci_projects (id, name, render_profile, retention_mode, retention_value, created_at, updated_at, deleted_at)
    VALUES ('${UNFILED_PROJECT_ID}', '${UNFILED_PROJECT_NAME}', NULL, 'forever', NULL, 0, 0, NULL);
`;

// Captured rows: never updated; deleted only once a tombstone of a recorded purge names them; a
// purged id never comes back.
const captured = (table: string) => `
  CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  CREATE TRIGGER ${table}_purge_only BEFORE DELETE ON ${table}
  WHEN NOT EXISTS (SELECT 1 FROM ci_tombstones t JOIN ci_purges p ON p.id = t.purge_id WHERE t.table_name = '${table}' AND t.row_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, '${table} rows are deleted only by a recorded purge'); END;
  CREATE TRIGGER ${table}_no_resurrect BEFORE INSERT ON ${table}
  WHEN EXISTS (SELECT 1 FROM ci_tombstones WHERE table_name = '${table}' AND row_id = NEW.id)
  BEGIN SELECT RAISE(ABORT, '${table} row was purged'); END;
`;

// The purge audit: never changed.
const audit = (table: string) => `
  CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
  CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

// A version goes only once no capture points at it: a purge deletes its captures first, in the same
// transaction, so a capture that raced in after the purge was planned aborts the purge instead of
// being left pointing at nothing.

// Mutable rows: tombstoned with deleted_at (so a sync can carry it), never deleted.
const mutable = (table: string) => `
  CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} rows are tombstoned with deleted_at, never deleted'); END;
`;

const GUARDS = `
  ${CAPTURED_TABLES.map(captured).join('')}
  ${AUDIT_TABLES.map(audit).join('')}
  ${['ci_projects', 'ci_project_pages', 'ci_project_queries'].map(mutable).join('')}
  CREATE TRIGGER ci_versions_unreferenced_only BEFORE DELETE ON ci_versions
  WHEN EXISTS (SELECT 1 FROM ci_captures WHERE version_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'ci_versions row still has captures'); END;
  CREATE TRIGGER ci_projects_unfiled_stays BEFORE UPDATE ON ci_projects
  WHEN OLD.id = '${UNFILED_PROJECT_ID}' AND (NEW.deleted_at IS NOT NULL OR NEW.id IS NOT OLD.id)
  BEGIN SELECT RAISE(ABORT, 'the Unfiled project cannot be deleted or re-keyed'); END;
`;

/** Migrations `0040`–`0041` (Phase 6's range is `0040`–`0059`), appended to `MIGRATIONS`. */
export const CHANGE_INTEL_MIGRATIONS: readonly Migration[] = [
  { id: '0040_change_intelligence', sql: TABLES },
  { id: '0041_change_intelligence_guards', sql: GUARDS },
];
