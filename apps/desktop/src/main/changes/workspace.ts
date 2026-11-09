import { canonicalJson } from '@app/change-intel';
import type { ChangeIntelRepository } from '@app/db';
import type { ProjectsService } from '@app/ipc-contract';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { BulkSearchesInputSchema } from '@app/specs/projects.schema';
import { bulkSearchInputs, normalizeSiteDomain, normalizeTags, splitBulkSearches, type BulkLineResult, type ProjectRefusal } from '@app/specs/projects.spec';
import type { SiteMatch } from '@app/specs/rankings.spec';
import { MULTI_PART_SUFFIXES } from '@app/specs/seo-speed.spec';
import { ENTRY_KINDS, MAX_PROJECT_TAGS, MAX_TAGS_PER_ENTRY } from '@app/specs/workspace-db.spec';
import { ownerDomain } from '../serp/serp-analyse';
import { savedSearchParams } from './projects';

// The project workspace (Phase 10 Task 4; spec `projects.spec.ts`, `projects.schema.ts`; acceptance
// `projects.feature.md`, Site and competitors, Tags, Bulk add, Favorites and sort): the `projects.*`
// procedures that set a project's favorite star, site and competitors, tag its pages and saved searches,
// and add saved searches in bulk, over `@app/db`'s workspace operations (`workspace-db.feature.md`).
// Domains and tags arrive as typed and are normalized here (`normalizeSiteDomain`, `normalizeTags`).
// Bulk add makes each search through the one saved-search path (`savedSearchParams`: `searchUrlFor` →
// `searchParamsForUrl`, local) and stores it as `addSearch` does: nothing is sent to any engine.
// A site or competitor that is a bare public suffix (`co.uk`: nothing registrable) is
// `invalid-domain`; an owner suffix of Phase 3 (`github.io`, `medium.com`) is its own owner and stays
// allowed (`medium.com` is a common competitor). A competitor is stored as its owner domain (`ownerDomain`), so `rival.com` and
// `shop.rival.com` are one competitor (the rank model matches competitors by owner, subdomains on).
// Unfiled has no site and no competitors (`unfiled`). Every method answers: a refusal is typed
// (`PROJECT_REFUSALS`), a database failure is `store-failed` and one log line (its code, never its message).

/** The workspace's `ProjectsService` methods (`projects-router.ts`). */
export const WORKSPACE_METHODS = ['setFavorite', 'setSite', 'addCompetitor', 'removeCompetitor', 'setTags', 'addSearches'] as const;
export type WorkspaceMethod = (typeof WORKSPACE_METHODS)[number];
export type WorkspaceService = Pick<ProjectsService, WorkspaceMethod>;

export interface WorkspaceServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/**
 * Whose positions a domain's are (plan Decision 7; `rankings.spec.ts`, `SiteMatch`): its owner by
 * Phase 3's rule (`ownerDomain`), the host as set, and whether any host of the owner counts.
 */
export function siteMatchOf(domain: string, subdomains: boolean): SiteMatch {
  return { owner: ownerDomain(domain), host: domain, subdomains };
}

/**
 * The owner domain of a normalized host (`ownerDomain`, Phase 3's rule), or `null` when there is
 * nothing registrable: the owner is itself a multi-part public suffix (`co.uk`, `com.au`;
 * `MULTI_PART_SUFFIXES`). Single-label suffixes (`com`) never get here (`normalizeSiteDomain`).
 */
export function registrableOwner(host: string): string | null {
  const owner = ownerDomain(host);
  return owner === '' || MULTI_PART_SUFFIXES.includes(owner) ? null : owner;
}

const refused = (reason: ProjectRefusal) => ({ status: 'refused' as const, reason });
/** An error's code or name: never its message. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);

  /** `run`'s answer, or `store-failed` (logged) when the database fails. */
  const guarded = async <T>(what: string, run: () => Promise<T>): Promise<T | ReturnType<typeof refused>> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return refused('store-failed');
    }
  };

  /** Whether `entryId` is a live page (`page`) or saved search (`search`) of the live project. */
  const entryIsLive = async (projectId: string, kind: (typeof ENTRY_KINDS)[number], entryId: string): Promise<boolean> => {
    if ((await store.project(projectId)) === null) return false;
    const entries = kind === 'page' ? await store.projectPages(projectId) : await store.projectQueries(projectId);
    return entries.some((entry) => entry.id === entryId);
  };

  return {
    setFavorite: (projectId, favorite) =>
      guarded('set favorite', async () => ((await store.setProjectFavorite(projectId, favorite === true)) ? { status: 'ok' as const } : refused('not-found'))),

    setSite: (projectId, domain, subdomains) =>
      guarded('set site', async () => {
        if (projectId === UNFILED_PROJECT_ID) return refused('unfiled');
        const site = domain === null ? null : normalizeSiteDomain(domain);
        if (domain !== null && (site === null || registrableOwner(site) === null)) return refused('invalid-domain');
        const on = subdomains !== false;
        if (!(await store.setProjectSite(projectId, site, on))) return refused('not-found');
        return { status: 'ok' as const, site: site === null ? null : { domain: site, subdomains: on } };
      }),

    addCompetitor: (projectId, domain) =>
      guarded('add competitor', async () => {
        if (projectId === UNFILED_PROJECT_ID) return refused('unfiled');
        const host = normalizeSiteDomain(domain);
        // Stored as its owner domain: one competitor per owner, whatever host was typed.
        const owner = host === null ? null : registrableOwner(host);
        if (owner === null) return refused('invalid-domain');
        if ((await store.project(projectId)) === null) return refused('not-found');
        const added = await store.addCompetitor(projectId, owner, now());
        return added === null ? refused('limit') : { status: 'added' as const, competitor: { id: added.id, domain: added.domain } };
      }),

    removeCompetitor: (projectId, competitorId) =>
      guarded('remove competitor', async () => {
        if (projectId === UNFILED_PROJECT_ID) return refused('unfiled');
        return (await store.removeCompetitor(projectId, competitorId, now())) ? { status: 'ok' as const } : refused('not-found');
      }),

    setTags: (projectId, entryKind, entryId, tags) =>
      guarded('set tags', async () => {
        const wanted = Array.isArray(tags) && tags.length <= MAX_TAGS_PER_ENTRY * 4 ? normalizeTags(tags) : null;
        if (wanted === null) return refused('invalid-tag');
        if (!ENTRY_KINDS.includes(entryKind)) return refused('not-found');
        const set = await store.setEntryTags({ projectId, entryKind, entryId, tags: wanted, now: now() });
        // The tags fit, so a refusal is an entry that is not live, or the project's distinct-tag cap.
        if (set === null) return refused((await entryIsLive(projectId, entryKind, entryId)) ? 'limit' : 'not-found');
        return { status: 'ok' as const, tags: set.map((tag) => tag.tag).sort() };
      }),

    addSearches: (projectId, searches) =>
      guarded('add searches', async () => {
        if (typeof searches !== 'object' || searches === null) return refused('invalid-query');
        const raw: unknown = searches.tags;
        const tags = Array.isArray(raw) && raw.length <= MAX_TAGS_PER_ENTRY * 4 ? normalizeTags(raw) : null;
        if (tags === null) return refused('invalid-tag');
        const { tags: _typed, ...form } = searches;
        const parsed = BulkSearchesInputSchema.omit({ tags: true }).safeParse(form);
        if (!parsed.success) return refused('invalid-query');
        if ((await store.project(projectId)) === null) return refused('not-found');
        // The tags must fit the project's distinct-tag cap before anything is stored.
        if (tags.length > 0 && new Set([...(await store.projectTags(projectId)).map((tag) => tag.tag), ...tags]).size > MAX_PROJECT_TAGS) return refused('limit');

        // What the project already holds, as `addSearch` stores it (canonical JSON of Phase 3's parameters).
        const held = new Set((await store.projectQueries(projectId)).map((query) => query.searchParamsJson));
        const lines: BulkLineResult[] = [];
        const addedIds: string[] = [];
        let full = false;
        for (const query of splitBulkSearches(parsed.data.text)) {
          if (full) {
            lines.push({ query, outcome: 'limit', added: 0 });
            continue;
          }
          // Every search of the line through the saved-search path first: one it cannot make stores none.
          const made = bulkSearchInputs(query, parsed.data).map(savedSearchParams);
          if (made.some((params) => params === null)) {
            lines.push({ query, outcome: 'invalid', added: 0 });
            continue;
          }
          let added = 0;
          for (const params of made) {
            const json = canonicalJson(params);
            if (held.has(json)) continue;
            const row = await store.addQuery(projectId, params!.query, json, now());
            if (row === null) {
              full = true;
              break;
            }
            held.add(json);
            addedIds.push(row.id);
            added += 1;
          }
          lines.push({ query, outcome: full ? 'limit' : added > 0 ? 'added' : 'exists', added });
        }
        if (tags.length > 0) {
          for (const entryId of addedIds) {
            if ((await store.setEntryTags({ projectId, entryKind: 'search', entryId, tags, now: now() })) === null) log('a bulk-added search could not be tagged');
          }
        }
        return { status: 'done' as const, lines };
      }),
  };
}
