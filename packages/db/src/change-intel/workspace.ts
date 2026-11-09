import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { MAX_PROJECT_PAGES, MAX_PROJECT_QUERIES, MAX_PROJECTS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  CAPTURE_CADENCES,
  DOMAIN_MAX_CHARS,
  ENTRY_KINDS,
  MAX_PROJECT_COMPETITORS,
  MAX_PROJECT_TAGS,
  MAX_TAGS_PER_ENTRY,
  TAG_MAX_CHARS,
  type CaptureCadence,
  type EntryKind,
} from '@app/specs/workspace-db.spec';
import type { SessionDatabase } from '../client';
import { batch, capped, insertWhere, isId, isOneOf, isTime, liveProject, trimmedText } from './checks';
import { uuidv7 } from './ids';
import { ciCaptures, ciProjects } from './schema';
import { ciEntryTags, ciProjectCompetitors } from './workspace-schema';

// The project workspace (Phase 10 Task 1; spec `workspace-db.spec.ts`; acceptance
// `workspace-db.feature.md`, Repository): competitors, tags on pages and saved searches, and the
// project's device-local flags. Competitors and tags are Phase 6's mutable rows (UUIDv7 ids,
// tombstoned with `deleted_at` and `updated_at`, never deleted, one live row per key). The flags are
// columns of `ci_projects`, which syncs last-writer-wins on `updated_at`: their setters change their
// own column only and **never** `updated_at`, so a device-local star never beats a real rename
// (Decision 9). Values are checked both ways; a tampered row is skipped.

export interface Competitor {
  readonly id: string;
  readonly projectId: string;
  readonly domain: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EntryTag {
  readonly id: string;
  readonly projectId: string;
  readonly entryKind: EntryKind;
  /** A `ci_project_pages` id (`page`) or a `ci_project_queries` id (`search`). */
  readonly entryId: string;
  readonly tag: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A live project's workspace flags (columns of `ci_projects`; defaults on rows from before `0220`). */
export interface ProjectWorkspace {
  readonly projectId: string;
  readonly favorite: boolean;
  /** The site's lowercase host, or `null` (no site set). */
  readonly siteDomain: string | null;
  /** Whether the site's subdomains count as the site (on by default). */
  readonly siteSubdomains: boolean;
  readonly cadence: CaptureCadence;
  readonly autoCapture: boolean;
}

export interface SetEntryTagsInput {
  readonly projectId: string;
  readonly entryKind: EntryKind;
  readonly entryId: string;
  /** The entry's tags after the call (duplicates collapse). */
  readonly tags: readonly string[];
  readonly now: number;
}

export interface WorkspaceOperations {
  /** Adds a competitor (its live row if it has one already); `null` if invalid, on Unfiled, past the cap or for a project that is not live. */
  addCompetitor(projectId: string, domain: string, now: number): Promise<Competitor | null>;
  /** Tombstones a live competitor of the project. */
  removeCompetitor(projectId: string, competitorId: string, now: number): Promise<boolean>;
  /** A project's live competitors, oldest first. */
  competitors(projectId: string): Promise<Competitor[]>;
  /**
   * Makes the entry's live tags exactly `tags` in one batch (the others tombstoned); answers them.
   * `null` (nothing written) for an entry that is not a live page or saved search of the live project,
   * an invalid tag, more than `MAX_TAGS_PER_ENTRY`, or a project that would hold more than
   * `MAX_PROJECT_TAGS` distinct tags.
   */
  setEntryTags(input: SetEntryTagsInput): Promise<EntryTag[] | null>;
  /** A project's live tags (every entry's), by entry, then tag. */
  projectTags(projectId: string): Promise<EntryTag[]>;
  /**
   * The startup sweep: tombstones the live competitors and tags of every tombstoned project (one
   * deleted through sync never runs `tombstoneProject` here), and the live tags of a tombstoned page
   * or saved search. Deletes nothing; answers how many rows it tombstoned.
   */
  tombstoneOrphanWorkspaceRows(now?: number): Promise<number>;
  /** The flag setters: a live project only; never `updated_at`. */
  setProjectFavorite(id: string, favorite: boolean): Promise<boolean>;
  /** A lowercase host of at most `DOMAIN_MAX_CHARS`, or `null`; never on Unfiled. */
  setProjectSite(id: string, domain: string | null, subdomains: boolean): Promise<boolean>;
  setProjectCadence(id: string, cadence: CaptureCadence): Promise<boolean>;
  setProjectAutoCapture(id: string, on: boolean): Promise<boolean>;
  /** A live project's flags. */
  projectWorkspace(id: string): Promise<ProjectWorkspace | null>;
  /** Every live project's flags, Unfiled first, then by creation (as `projects()`). */
  projectWorkspaces(): Promise<ProjectWorkspace[]>;
  /** The newest `source = 'project'` capture's time of the project (for "due"), or `null`. */
  lastProjectRunAt(projectId: string): Promise<number | null>;
}

/** A stored host: lowercase letters, digits, `-`, `_` in dot-separated labels (punycode for IDN), or a bracketed IPv6 literal. */
const HOST_PATTERN = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;
export const isDomain = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= DOMAIN_MAX_CHARS && HOST_PATTERN.test(value);
// Control characters are never part of a tag.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A tag: 1…`TAG_MAX_CHARS` code units, no white space around it, no control characters. */
export const isTag = (value: unknown): value is string => typeof value === 'string' && trimmedText(value, TAG_MAX_CHARS) === value && !CONTROL.test(value);
const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;

/** Most live tags a project can hold (every page and saved search at its cap). */
const MAX_PROJECT_TAG_ROWS = (MAX_PROJECT_PAGES + MAX_PROJECT_QUERIES) * MAX_TAGS_PER_ENTRY;

const competitorColumns = {
  id: ciProjectCompetitors.id,
  projectId: capped(ciProjectCompetitors.projectId, 36),
  domain: capped(ciProjectCompetitors.domain, DOMAIN_MAX_CHARS),
  createdAt: ciProjectCompetitors.createdAt,
  updatedAt: ciProjectCompetitors.updatedAt,
};
function competitorOf(row: { [K in keyof typeof competitorColumns]: unknown }): Competitor | null {
  const { id, projectId, domain, createdAt, updatedAt } = row;
  return isId(id) && isId(projectId) && isDomain(domain) && isTime(createdAt) && isTime(updatedAt) ? { id, projectId, domain, createdAt, updatedAt } : null;
}

const tagColumns = {
  id: ciEntryTags.id,
  projectId: capped(ciEntryTags.projectId, 36),
  entryKind: capped(ciEntryTags.entryKind, 16),
  entryId: capped(ciEntryTags.entryId, 36),
  tag: capped(ciEntryTags.tag, TAG_MAX_CHARS),
  createdAt: ciEntryTags.createdAt,
  updatedAt: ciEntryTags.updatedAt,
};
function tagOf(row: { [K in keyof typeof tagColumns]: unknown }): EntryTag | null {
  const { id, projectId, entryKind, entryId, tag, createdAt, updatedAt } = row;
  return isId(id) && isId(projectId) && isOneOf(ENTRY_KINDS, entryKind) && isId(entryId) && isTag(tag) && isTime(createdAt) && isTime(updatedAt) ? { id, projectId, entryKind, entryId, tag, createdAt, updatedAt } : null;
}

// Raw values (no Drizzle boolean mapping), so a tampered flag is seen.
const workspaceColumns = {
  id: ciProjects.id,
  favorite: sql<unknown>`${ciProjects.favorite}`,
  siteDomain: capped(ciProjects.siteDomain, DOMAIN_MAX_CHARS),
  siteSubdomains: sql<unknown>`${ciProjects.siteSubdomains}`,
  cadence: capped(ciProjects.captureCadence, 16),
  autoCapture: sql<unknown>`${ciProjects.autoCapture}`,
};
function workspaceOf(row: { [K in keyof typeof workspaceColumns]: unknown }): ProjectWorkspace | null {
  const { id, favorite, siteDomain, siteSubdomains, cadence, autoCapture } = row;
  if (!isId(id) || !isFlag(favorite) || !(siteDomain === null || isDomain(siteDomain)) || !isFlag(siteSubdomains) || !isOneOf(CAPTURE_CADENCES, cadence) || !isFlag(autoCapture)) return null;
  return { projectId: id, favorite: favorite === 1, siteDomain, siteSubdomains: siteSubdomains === 1, cadence, autoCapture: autoCapture === 1 };
}

const present = <T>(value: T | null): value is T => value !== null;

/** The entry is a live page or saved search of the project, checked inside the statement. */
const liveEntry = (projectId: string, kind: EntryKind, entryId: string): SQL =>
  kind === 'page'
    ? sql`EXISTS (SELECT 1 FROM ci_project_pages WHERE id = ${entryId} AND project_id = ${projectId} AND deleted_at IS NULL)`
    : sql`EXISTS (SELECT 1 FROM ci_project_queries WHERE id = ${entryId} AND project_id = ${projectId} AND deleted_at IS NULL)`;
const deletedProject = sql`project_id IN (SELECT p.id FROM ci_projects p WHERE p.deleted_at IS NOT NULL)`;

export function createWorkspaceOperations(db: SessionDatabase): WorkspaceOperations {
  /** Sets a live project's flag columns, leaving `updated_at` as it is (Decision 9). */
  const setFlags = async (id: string, set: Partial<typeof ciProjects.$inferInsert>): Promise<boolean> => {
    const rows = await db
      .update(ciProjects)
      .set(set)
      .where(and(eq(ciProjects.id, id), isNull(ciProjects.deletedAt)))
      .returning({ id: ciProjects.id });
    return rows.length > 0;
  };
  /** Whether the project is live and the entry is a live page or saved search of it. */
  const entryIsLive = async (projectId: string, kind: EntryKind, entryId: string): Promise<boolean> =>
    (
      await db
        .select({ id: ciProjects.id })
        .from(ciProjects)
        .where(and(eq(ciProjects.id, projectId), isNull(ciProjects.deletedAt), liveEntry(projectId, kind, entryId)))
        .limit(1)
    ).length > 0;
  const entryTags = async (projectId: string, kind: EntryKind, entryId: string) =>
    (
      await db
        .select(tagColumns)
        .from(ciEntryTags)
        .where(and(eq(ciEntryTags.projectId, projectId), eq(ciEntryTags.entryKind, kind), eq(ciEntryTags.entryId, entryId), isNull(ciEntryTags.deletedAt)))
        .orderBy(asc(ciEntryTags.createdAt), asc(ciEntryTags.id))
        .limit(MAX_PROJECT_TAG_ROWS)
    )
      .map(tagOf)
      .filter(present);
  const liveWorkspaces = (where: SQL | undefined) =>
    db
      .select(workspaceColumns)
      .from(ciProjects)
      .where(and(isNull(ciProjects.deletedAt), where))
      .orderBy(desc(sql`${ciProjects.id} = ${UNFILED_PROJECT_ID}`), asc(ciProjects.createdAt), asc(ciProjects.id))
      .limit(MAX_PROJECTS);

  const operations: WorkspaceOperations = {
    // ---- Competitors ----

    async addCompetitor(projectId, domain, now) {
      if (!isId(projectId) || projectId === UNFILED_PROJECT_ID || !isDomain(domain) || !isTime(now)) return null;
      // A project that is not live answers nothing, not even a row it still has.
      if ((await db.select({ id: ciProjects.id }).from(ciProjects).where(and(eq(ciProjects.id, projectId), isNull(ciProjects.deletedAt))).limit(1)).length === 0) return null;
      const live = and(eq(ciProjectCompetitors.projectId, projectId), eq(ciProjectCompetitors.domain, domain), isNull(ciProjectCompetitors.deletedAt));
      const [existing] = await db.select(competitorColumns).from(ciProjectCompetitors).where(live).limit(1);
      if (existing) return competitorOf(existing);
      const row = { id: uuidv7(now), projectId, domain, createdAt: now, updatedAt: now, deletedAt: null };
      const room = sql`(SELECT count(*) FROM ci_project_competitors WHERE project_id = ${projectId} AND deleted_at IS NULL) < ${MAX_PROJECT_COMPETITORS}`;
      await batch(db, [insertWhere(db, ciProjectCompetitors, row, sql`${liveProject(projectId)} AND ${room}`)]);
      const [added] = await db.select(competitorColumns).from(ciProjectCompetitors).where(eq(ciProjectCompetitors.id, row.id)).limit(1);
      return added ? competitorOf(added) : null;
    },

    async removeCompetitor(projectId, competitorId, now) {
      if (!isId(projectId) || !isId(competitorId) || !isTime(now)) return false;
      const rows = await db
        .update(ciProjectCompetitors)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(ciProjectCompetitors.id, competitorId), eq(ciProjectCompetitors.projectId, projectId), isNull(ciProjectCompetitors.deletedAt)))
        .returning({ id: ciProjectCompetitors.id });
      return rows.length > 0;
    },

    async competitors(projectId) {
      if (!isId(projectId)) return [];
      const rows = await db
        .select(competitorColumns)
        .from(ciProjectCompetitors)
        .where(and(eq(ciProjectCompetitors.projectId, projectId), isNull(ciProjectCompetitors.deletedAt)))
        .orderBy(asc(ciProjectCompetitors.createdAt), asc(ciProjectCompetitors.id))
        .limit(MAX_PROJECT_COMPETITORS);
      return rows.map(competitorOf).filter(present);
    },

    // ---- Tags ----

    async setEntryTags(input) {
      if (typeof input !== 'object' || input === null) return null;
      const { projectId, entryKind, entryId, tags, now } = input;
      if (!isId(projectId) || !isOneOf(ENTRY_KINDS, entryKind) || !isId(entryId) || !isTime(now) || !Array.isArray(tags) || tags.length > MAX_TAGS_PER_ENTRY * 4) return null;
      const wanted = [...new Set(tags)];
      if (wanted.length > MAX_TAGS_PER_ENTRY || !wanted.every(isTag)) return null;
      if (!(await entryIsLive(projectId, entryKind, entryId))) return null;

      const current = await entryTags(projectId, entryKind, entryId);
      const have = new Set(current.map((tag) => tag.tag));
      const removed = current.filter((tag) => !wanted.includes(tag.tag)).map((tag) => tag.tag);
      const added = wanted.filter((tag) => !have.has(tag));
      // The project's distinct live tags afterwards, within its cap.
      const others = await db
        .selectDistinct({ tag: capped(ciEntryTags.tag, TAG_MAX_CHARS) })
        .from(ciEntryTags)
        .where(and(eq(ciEntryTags.projectId, projectId), isNull(ciEntryTags.deletedAt), sql`NOT (${ciEntryTags.entryKind} = ${entryKind} AND ${ciEntryTags.entryId} = ${entryId})`))
        .limit(MAX_PROJECT_TAG_ROWS);
      if (new Set([...others.map((row) => row.tag), ...wanted]).size > MAX_PROJECT_TAGS) return null;
      if (removed.length + added.length === 0) return current;

      const gone = { deletedAt: now, updatedAt: now };
      const items = [];
      if (removed.length > 0) {
        items.push(
          db
            .update(ciEntryTags)
            .set(gone)
            .where(and(eq(ciEntryTags.entryKind, entryKind), eq(ciEntryTags.entryId, entryId), isNull(ciEntryTags.deletedAt), inArray(ciEntryTags.tag, removed))),
        );
      }
      for (const tag of added) {
        const row = { id: uuidv7(now), projectId, entryKind, entryId, tag, createdAt: now, updatedAt: now, deletedAt: null };
        // The caps again, inside the transaction (after the removals above).
        const condition = sql`${liveProject(projectId)} AND ${liveEntry(projectId, entryKind, entryId)}
          AND NOT EXISTS (SELECT 1 FROM ci_entry_tags WHERE entry_kind = ${entryKind} AND entry_id = ${entryId} AND tag = ${tag} AND deleted_at IS NULL)
          AND (SELECT count(*) FROM ci_entry_tags WHERE entry_kind = ${entryKind} AND entry_id = ${entryId} AND deleted_at IS NULL) < ${MAX_TAGS_PER_ENTRY}
          AND (EXISTS (SELECT 1 FROM ci_entry_tags WHERE project_id = ${projectId} AND tag = ${tag} AND deleted_at IS NULL)
            OR (SELECT count(DISTINCT tag) FROM ci_entry_tags WHERE project_id = ${projectId} AND deleted_at IS NULL) < ${MAX_PROJECT_TAGS})`;
        items.push(insertWhere(db, ciEntryTags, row, condition));
      }
      await batch(db, items);
      return entryTags(projectId, entryKind, entryId);
    },

    async projectTags(projectId) {
      if (!isId(projectId)) return [];
      const rows = await db
        .select(tagColumns)
        .from(ciEntryTags)
        .where(and(eq(ciEntryTags.projectId, projectId), isNull(ciEntryTags.deletedAt)))
        .orderBy(asc(ciEntryTags.entryKind), asc(ciEntryTags.entryId), asc(ciEntryTags.tag), asc(ciEntryTags.id))
        .limit(MAX_PROJECT_TAG_ROWS);
      return rows.map(tagOf).filter(present);
    },

    async tombstoneOrphanWorkspaceRows(now = Date.now()) {
      if (!isTime(now)) return 0;
      const gone = { deletedAt: now, updatedAt: now };
      const [competitors, tags] = await db.batch([
        db
          .update(ciProjectCompetitors)
          .set(gone)
          .where(and(isNull(ciProjectCompetitors.deletedAt), deletedProject))
          .returning({ id: ciProjectCompetitors.id }),
        db
          .update(ciEntryTags)
          .set(gone)
          .where(
            and(
              isNull(ciEntryTags.deletedAt),
              or(
                deletedProject,
                sql`(entry_kind = 'page' AND entry_id IN (SELECT g.id FROM ci_project_pages g WHERE g.deleted_at IS NOT NULL))`,
                sql`(entry_kind = 'search' AND entry_id IN (SELECT q.id FROM ci_project_queries q WHERE q.deleted_at IS NOT NULL))`,
              ),
            ),
          )
          .returning({ id: ciEntryTags.id }),
      ]);
      return competitors.length + tags.length;
    },

    // ---- Project flags (never `updated_at`) ----

    async setProjectFavorite(id, favorite) {
      if (!isId(id) || typeof favorite !== 'boolean') return false;
      return setFlags(id, { favorite });
    },

    async setProjectSite(id, domain, subdomains) {
      if (!isId(id) || id === UNFILED_PROJECT_ID || !(domain === null || isDomain(domain)) || typeof subdomains !== 'boolean') return false;
      return setFlags(id, { siteDomain: domain, siteSubdomains: subdomains });
    },

    async setProjectCadence(id, cadence) {
      if (!isId(id) || !isOneOf(CAPTURE_CADENCES, cadence)) return false;
      return setFlags(id, { captureCadence: cadence });
    },

    async setProjectAutoCapture(id, on) {
      if (!isId(id) || typeof on !== 'boolean') return false;
      return setFlags(id, { autoCapture: on });
    },

    async projectWorkspace(id) {
      if (!isId(id)) return null;
      const [row] = await liveWorkspaces(eq(ciProjects.id, id));
      return row ? workspaceOf(row) : null;
    },

    async projectWorkspaces() {
      return (await liveWorkspaces(undefined)).map(workspaceOf).filter(present);
    },

    async lastProjectRunAt(projectId) {
      if (!isId(projectId)) return null;
      const [row] = await db
        .select({ at: sql<unknown>`max(${ciCaptures.createdAt})` })
        .from(ciCaptures)
        .where(and(eq(ciCaptures.projectId, projectId), eq(ciCaptures.source, 'project')));
      return row && isTime(row.at) ? row.at : null;
    },
  };
  return operations;
}
