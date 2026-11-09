import { CAPTURE_CADENCES, DOMAIN_MAX_CHARS, ENTRY_KINDS, SERP_READING_SOURCES, SERP_READING_STATUSES } from '@app/specs/workspace-db.spec';
import type { Migration } from '../migrations';
import { mutable, noReplace } from './migrations';

// Phase 10's tables (Task 1; spec `workspace-db.spec.ts`; acceptance `workspace-db.feature.md`): the
// project workspace (new `ci_projects` columns, competitors, tags) and the SERP readings stored with
// captures. Ids `0220`–`0229` are Phase 10's (`0224`–`0229` spare), spread last in `MIGRATIONS` after
// Phase 9's `0210`. Plain SQLite 3.45 SQL only (`LIBSQL_SQLITE_VERSION`), as Phase 6's; no foreign
// keys. `workspace-schema.ts` declares exactly these tables, and `schema.ts` the new `ci_projects`
// columns. Phase 6's `0040`/`0041` are never edited: the guards reuse its exported helpers.

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const id = 'id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36)';
const flag = (column: string, value: 0 | 1) => `ALTER TABLE ci_projects ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${value} CHECK (${column} IN (0, 1));`;

const PROJECT_WORKSPACE = `
  ${flag('favorite', 0)}
  ALTER TABLE ci_projects ADD COLUMN site_domain TEXT CHECK (site_domain IS NULL OR length(site_domain) BETWEEN 1 AND ${DOMAIN_MAX_CHARS});
  ${flag('site_subdomains', 1)}
  ALTER TABLE ci_projects ADD COLUMN capture_cadence TEXT NOT NULL DEFAULT 'off' CHECK (capture_cadence IN (${list(CAPTURE_CADENCES)}));
  ${flag('auto_capture', 0)}
  CREATE TABLE ci_project_competitors (
    ${id},
    project_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX ci_project_competitors_project_id ON ci_project_competitors (project_id);
  CREATE UNIQUE INDEX ci_project_competitors_live_domain ON ci_project_competitors (project_id, domain) WHERE deleted_at IS NULL;
  CREATE TABLE ci_entry_tags (
    ${id},
    project_id TEXT NOT NULL,
    entry_kind TEXT NOT NULL CHECK (entry_kind IN (${list(ENTRY_KINDS)})),
    entry_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX ci_entry_tags_project_id ON ci_entry_tags (project_id);
  CREATE UNIQUE INDEX ci_entry_tags_live_tag ON ci_entry_tags (entry_kind, entry_id, tag) WHERE deleted_at IS NULL;
`;

// Competitors and tags: Phase 6's mutable rows (tombstoned, never deleted; one live row per key).
const PROJECT_WORKSPACE_GUARDS = `
  ${mutable('ci_project_competitors', ['project_id', 'domain'])}
  ${mutable('ci_entry_tags', ['entry_kind', 'entry_id', 'tag'])}
`;

// A reading per capture at most (the unique partial index on `capture_id`); a `capture` reading
// always names its capture. `serp-api` is reserved now (a later CHECK change needs a table rebuild).
const SERP_READINGS = `
  CREATE TABLE ci_serp_readings (
    ${id},
    project_id TEXT NOT NULL,
    capture_id TEXT,
    source TEXT NOT NULL CHECK (source IN (${list(SERP_READING_SOURCES)})),
    search_key TEXT NOT NULL,
    search_key_version INTEGER NOT NULL,
    search_params TEXT NOT NULL,
    filters TEXT NOT NULL,
    page_url TEXT,
    status TEXT NOT NULL CHECK (status IN (${list(SERP_READING_STATUSES)})),
    pack_version INTEGER,
    reading TEXT NOT NULL,
    reading_bytes INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (source <> 'capture' OR capture_id IS NOT NULL)
  );
  CREATE INDEX ci_serp_readings_project_id_search_key_observed_at ON ci_serp_readings (project_id, search_key, observed_at);
  CREATE UNIQUE INDEX ci_serp_readings_capture_id ON ci_serp_readings (capture_id) WHERE capture_id IS NOT NULL;
`;

// Readings are append-only, with their own delete guard (they are not in `CAPTURED_TABLES`: its
// tombstone CHECK is frozen in `0040`). The no-replace guard covers the unique `capture_id` index as
// well as the id: `REPLACE` deletes a conflicting row through any unique index without firing a
// DELETE trigger (`recursive_triggers` = 0), so an `INSERT OR REPLACE` with a fresh id and a taken
// capture id would otherwise remove the original behind `_capture_gone_only`. Phase 12's `0245`
// drops `ci_serp_readings_capture_gone_only` by this name.
const SERP_READINGS_GUARDS = `
  CREATE TRIGGER ci_serp_readings_no_update BEFORE UPDATE ON ci_serp_readings
  BEGIN SELECT RAISE(ABORT, 'ci_serp_readings is append-only'); END;
  ${noReplace('ci_serp_readings', ' OR (NEW.capture_id IS NOT NULL AND EXISTS (SELECT 1 FROM ci_serp_readings WHERE capture_id = NEW.capture_id))')}
  CREATE TRIGGER ci_serp_readings_capture_gone_only BEFORE DELETE ON ci_serp_readings
  WHEN NOT (OLD.source = 'capture' AND NOT EXISTS (SELECT 1 FROM ci_captures WHERE id = OLD.capture_id))
  BEGIN SELECT RAISE(ABORT, 'ci_serp_readings rows are deleted only once their capture is gone'); END;
`;

/** Migrations `0220`–`0223` (`WORKSPACE_MIGRATION_IDS`), spread last in `MIGRATIONS`. */
export const WORKSPACE_MIGRATIONS: readonly Migration[] = [
  { id: '0220_project_workspace', sql: PROJECT_WORKSPACE },
  { id: '0221_project_workspace_guards', sql: PROJECT_WORKSPACE_GUARDS },
  { id: '0222_serp_readings', sql: SERP_READINGS },
  { id: '0223_serp_readings_guards', sql: SERP_READINGS_GUARDS },
];
