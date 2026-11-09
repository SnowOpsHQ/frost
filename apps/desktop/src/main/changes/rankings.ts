import { compareSerps, rankCsvRows, rankOf, rankRowOf, rankSeries } from '@app/change-intel';
import type { ChangeIntelRepository, ReadingDateRow, StoredReading } from '@app/db';
import type { RankingsService } from '@app/ipc-contract';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { normalizeTag } from '@app/specs/projects.spec';
import { SerpFiltersSchema, StoredReadingSchema } from '@app/specs/rankings.schema';
import {
  MAX_RANK_TABLE_READ_BYTES,
  MAX_READING_DATES,
  RANK_LIMITS,
  rangeStart,
  rankCsvFileName,
  type RankCsvKind,
  type RankingsRefusal,
  type RankPoint,
  type RankRange,
  type RankTableAnswer,
  type RankTableRow,
  type ReadingDate,
  type SavedSearchRef,
  type SerpObservation,
  type SiteMatch,
} from '@app/specs/rankings.spec';
import { SearchParamsSchema } from '@app/specs/serp-search-params.schema';
import { MAX_PROJECT_COMPETITORS, MAX_PROJECT_TAGS, MAX_READINGS_PER_READ, SEARCH_KEY_VERSION } from '@app/specs/workspace-db.spec';
import path from 'node:path';
import { paramsOf, storedDomain, tagsOf } from './projects';
import { rankCsvText, writeOwnerOnly } from './rank-csv';
import { searchKeyOf } from './search-key';
import { siteMatchOf } from './workspace';

// The rankings service (Phase 10 Task 5; spec `rankings.spec.ts`, `rankings.schema.ts`; acceptance
// `rankings.feature.md`, Router and Export): the rank table, a search's series, its reading dates, a
// comparison of two readings and the CSV exports, over `@app/db`'s readings (`workspace-db.feature.md`)
// and `@app/change-intel`'s pure read model (`rankTable`, `rankSeries`, `compareSerps`, `rankCsvRows`).
// - Every read is of one **live** project (`store.project`; else `not-found`), and no reading is read by
//   id alone: `compare` refuses a reading of any other project.
// - Before reading, the project's capture-sourced orphans are swept (`deleteOrphanReadings(projectId)`;
//   a failed sweep is logged and the read goes on: the repository's reads skip them too).
// - Every stored reading is parsed with `StoredReadingSchema` (its snapshot with `SerpSnapshotSchema`)
//   and must name the project asked for; one that fails is skipped, never thrown.
// - Bounded: the table is read per search (its two newest readings, then its points in the range,
//   at most `RANK_LIMITS.maxPointsPerSeries`, within `MAX_RANK_TABLE_READ_BYTES` for the whole table),
//   each reading reduced to its point at once; a series reads at most `maxPointsPerSeries`, the dates
//   only ids, times and statuses (`readingDates`), and the model bounds rows (`RANK_LIMITS`).
// - CSV is formatted here (`rank-csv.ts`, `csvCell`) and goes to main's clipboard, or to the file the
//   user picks in main's own save dialog (`rank-dialogs.ts`), written owner-only. No path ever comes
//   from the renderer.
// Every method answers: a database failure is `store-failed` and one log line (the error's code or
// name, never its message).

/** What the service reads (`SessionStore.changeIntel`). */
export type RankingsStore = Pick<
  ChangeIntelRepository,
  'project' | 'projectWorkspace' | 'competitors' | 'projectQueries' | 'projectTags' | 'readings' | 'countReadings' | 'readingDates' | 'readingSearches' | 'reading' | 'deleteOrphanReadings'
>;

export interface RankingsServiceDeps {
  readonly store: RankingsStore;
  /** Main's clipboard (Copy CSV); without it nothing is copied (`null`). */
  readonly clipboard?: { writeText(text: string): void };
  /**
   * Main's save dialog (`rank-dialogs.ts`): parented to app window `windowId` (else the focused one),
   * offering `defaultName`; the absolute path the user chose, or `null` (cancelled). Without it,
   * nothing is ever written (`cancelled`).
   */
  readonly chooseCsvPath?: (windowId: number | null, defaultName: string, kind: RankCsvKind) => Promise<string | null>;
  /** Writes the CSV to the chosen file (default: `writeOwnerOnly`, `mode: 0o600`). */
  readonly writeCsv?: (file: string, text: string) => Promise<void>;
  /** The rank table read's byte budget (default `MAX_RANK_TABLE_READ_BYTES`; tests pass a smaller one). */
  readonly tableReadBytes?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/**
 * The current-version search key of a search (Decision 4), the one function captures store it with
 * (`search-key.ts`); injected into the read model for readings of an older key version.
 */
export { searchKeyOf };

/** An error's code or name: never its message (it may hold URLs, paths or SQL). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

/** The objects of a store answer (anything else in it is skipped). */
const objects = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter((item): item is T => typeof item === 'object' && item !== null) : []);

/** A refusal (`RANKINGS_REFUSALS`). */
const refused = (reason: RankingsRefusal) => ({ status: 'refused' as const, reason });

/** `json` parsed, else `undefined` (never throws). */
function parsed(json: unknown): unknown {
  if (typeof json !== 'string') return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored reading of `projectId` checked with `StoredReadingSchema`, as the read model takes it; else `null` (skipped). */
function observationOf(row: unknown, projectId: string): SerpObservation | null {
  if (typeof row !== 'object' || row === null) return null;
  const stored = row as Partial<StoredReading>;
  const checked = StoredReadingSchema.safeParse({
    id: stored.id,
    projectId: stored.projectId,
    captureId: stored.captureId,
    source: stored.source,
    searchKey: stored.searchKey,
    searchKeyVersion: stored.searchKeyVersion,
    params: parsed(stored.searchParamsJson),
    filters: parsed(stored.filtersJson),
    pageUrl: stored.pageUrl,
    status: stored.status,
    packVersion: stored.packVersion,
    snapshot: parsed(stored.readingJson),
    observedAt: stored.observedAt,
  });
  if (!checked.success || checked.data.projectId !== projectId) return null;
  const { id, searchKey, searchKeyVersion, params, filters, observedAt, source, snapshot } = checked.data;
  return { id, searchKey, searchKeyVersion, params, filters, observedAt, source, snapshot };
}

/** Newest first by `(observedAt, id)`, as the repository answers. */
const newestFirst = (a: SerpObservation, b: SerpObservation): number => b.observedAt - a.observedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The key a reading is filed under (as the model files it): its stored key under the current rule, else its key today. */
function keyOfObservation(observation: SerpObservation): string {
  if (observation.searchKeyVersion === undefined || observation.searchKeyVersion === SEARCH_KEY_VERSION) return observation.searchKey;
  try {
    return searchKeyOf(observation.params, observation.filters) ?? observation.searchKey;
  } catch {
    return observation.searchKey;
  }
}

/** The project's site and competitors, read and checked (a stored value not in its normalized form is ignored). */
interface ProjectView {
  readonly retention: { readonly mode: 'forever' | 'versions' | 'days'; readonly value: number | null };
  readonly site: { readonly domain: string; readonly subdomains: boolean } | null;
  readonly siteMatch: SiteMatch | null;
  readonly competitors: readonly string[];
  readonly competitorMatches: readonly SiteMatch[];
}

export function createRankingsService(deps: RankingsServiceDeps): RankingsService {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`rankings: ${message}`);
  const writeCsv = deps.writeCsv ?? writeOwnerOnly;
  const tableReadBytes = deps.tableReadBytes ?? MAX_RANK_TABLE_READ_BYTES;

  /** The live project's view, or `null` (not live, or not a project). */
  const projectView = async (projectId: string): Promise<ProjectView | null> => {
    const project = await store.project(projectId);
    if (project === null || project.id !== projectId) return null;
    const workspace = projectId === UNFILED_PROJECT_ID ? null : await store.projectWorkspace(projectId);
    const domain = workspace === null || workspace.projectId !== projectId ? null : storedDomain(workspace.siteDomain);
    const site = domain === null || workspace === null ? null : { domain, subdomains: workspace.siteSubdomains === true };
    const competitors: string[] = [];
    if (projectId !== UNFILED_PROJECT_ID) {
      for (const competitor of objects<{ projectId: unknown; domain: unknown }>(await store.competitors(projectId))) {
        const host = competitor.projectId === projectId && typeof competitor.domain === 'string' ? storedDomain(competitor.domain) : null;
        if (host !== null && !competitors.includes(host) && competitors.length < MAX_PROJECT_COMPETITORS) competitors.push(host);
      }
    }
    return {
      retention: { mode: project.retention.mode, value: project.retention.value },
      site,
      siteMatch: site === null ? null : siteMatchOf(site.domain, site.subdomains),
      competitors,
      competitorMatches: competitors.map((host) => siteMatchOf(host, true)),
    };
  };

  /** Deletes the project's capture-sourced orphans first; a failure is logged, and the read goes on. */
  const sweep = async (projectId: string): Promise<void> => {
    try {
      await store.deleteOrphanReadings(projectId);
    } catch (error) {
      log(`the orphan readings sweep failed (${codeOf(error)})`);
    }
  };

  /** The live project (swept), or `null`. */
  const liveProject = async (projectId: string): Promise<ProjectView | null> => {
    const view = await projectView(projectId);
    if (view !== null) await sweep(projectId);
    return view;
  };

  /** The rows a store read answered (objects only), and their stored bytes. */
  const storeRows = (rows: unknown): { rows: Partial<StoredReading>[]; bytes: number } => {
    const list = objects<Partial<StoredReading>>(rows).slice(0, MAX_READINGS_PER_READ);
    return { rows: list, bytes: list.reduce((sum, row) => sum + (typeof row.readingBytes === 'number' && Number.isFinite(row.readingBytes) && row.readingBytes > 0 ? row.readingBytes : 0), 0) };
  };

  /** Each stored rows' reading of `projectId`, checked, filed under `searchKey` (as the model files it); the rest skipped. */
  const checkedOf = (rows: readonly unknown[], projectId: string, searchKey: string): SerpObservation[] =>
    rows.flatMap((row) => {
      const observation = observationOf(row, projectId);
      return observation !== null && keyOfObservation(observation) === searchKey ? [observation] : [];
    });

  /**
   * The project's searches as the reads take them: each current key → the stored keys its readings are
   * under (itself, and older-version keys whose parameters and filters have it today), most recently
   * observed first (`readingSearches`).
   */
  const searchKeys = async (projectId: string): Promise<Map<string, Set<string>>> => {
    const out = new Map<string, Set<string>>();
    for (const search of objects<Awaited<ReturnType<RankingsStore['readingSearches']>>[number]>(await store.readingSearches(projectId))) {
      if (typeof search.searchKey !== 'string' || !/^[0-9a-f]{64}$/.test(search.searchKey)) continue;
      let key = search.searchKey;
      if (search.searchKeyVersion !== SEARCH_KEY_VERSION) {
        const params = SearchParamsSchema.safeParse(parsed(search.searchParamsJson));
        const filters = SerpFiltersSchema.safeParse(parsed(search.filtersJson));
        key = (params.success && filters.success ? searchKeyOf(params.data, filters.data) : null) ?? search.searchKey;
      }
      const stored = out.get(key);
      if (stored === undefined) out.set(key, new Set([search.searchKey]));
      else stored.add(search.searchKey);
    }
    return out;
  };

  /** The stored keys of search `searchKey` (itself first). */
  const storedKeysOf = (keys: ReadonlyMap<string, ReadonlySet<string>>, searchKey: string): string[] => [...new Set([searchKey, ...(keys.get(searchKey) ?? [])])];

  /** One search's readings (newest first, checked), from each of its stored keys, at most `limit` of them. */
  const searchObservations = async (projectId: string, searchKey: string, filter: { from?: number; limit: number }): Promise<SerpObservation[]> => {
    const found = new Map<string, SerpObservation>();
    for (const key of storedKeysOf(await searchKeys(projectId), searchKey)) {
      const { rows } = storeRows(await store.readings({ projectId, searchKey: key, limit: filter.limit, ...(filter.from === undefined ? {} : { from: filter.from }) }));
      for (const observation of checkedOf(rows, projectId, searchKey)) found.set(observation.id, observation);
    }
    return [...found.values()].sort(newestFirst).slice(0, filter.limit);
  };

  /** The project's saved searches as the table takes them (checked parameters, their key, their tags), and every tag they carry. */
  const savedSearches = async (projectId: string): Promise<{ saved: SavedSearchRef[]; tags: string[] }> => {
    const tags = objects<Awaited<ReturnType<RankingsStore['projectTags']>>[number]>(await store.projectTags(projectId));
    const saved: SavedSearchRef[] = [];
    const all = new Set<string>();
    for (const query of objects<Awaited<ReturnType<RankingsStore['projectQueries']>>[number]>(await store.projectQueries(projectId))) {
      if (query.projectId !== projectId || typeof query.id !== 'string' || typeof query.searchParamsJson !== 'string') continue;
      const params = paramsOf(query.searchParamsJson);
      const key = params === null ? null : searchKeyOf(params, {});
      if (params === null || key === null) continue;
      const entryTags = tagsOf(tags, 'search', query.id);
      for (const tag of entryTags) all.add(tag);
      saved.push({ id: query.id, searchKey: key, params, filters: {}, tags: entryTags });
    }
    return { saved, tags: [...all].sort().slice(0, MAX_PROJECT_TAGS) };
  };

  /**
   * The rank table of a live project, read per search and bounded (`rankings.feature.md`, Router):
   * the rows' keys first (saved searches, then searches seen in readings, at most `maxRows`), then for
   * each row in turn its two newest readings (whatever the range) and its points in the range (the
   * range pushed into SQL, at most `maxPointsPerSeries`, within what is left of the table's byte
   * budget), each reading reduced to its point at once.
   */
  const table = async (projectId: string, range: RankRange, tag: string | null): Promise<RankTableAnswer> => {
    const view = await liveProject(projectId);
    if (view === null) return refused('not-found');
    const at = now();
    const start = rangeStart(range, at);
    const from = start > 0 ? start : undefined;
    const { saved, tags } = await savedSearches(projectId);
    const keys = await searchKeys(projectId);
    const wanted = tag === null ? null : (normalizeTag(tag) ?? tag);

    // The rows' keys: saved searches first (in order; a repeated key once; the tag's only), then the
    // searches seen only in readings, most recently observed first (none with a tag).
    const listed = new Set<string>();
    const order: { key: string; saved: SavedSearchRef | null }[] = [];
    for (const entry of saved) {
      if (listed.has(entry.searchKey)) continue;
      listed.add(entry.searchKey);
      if (wanted === null || entry.tags.includes(wanted)) order.push({ key: entry.searchKey, saved: entry });
    }
    if (wanted === null) for (const key of keys.keys()) if (!listed.has(key)) order.push({ key, saved: null });

    let spent = 0;
    const rows: RankTableRow[] = [];
    for (const { key, saved: entry } of order.slice(0, RANK_LIMITS.maxRows)) {
      const stored = storedKeysOf(keys, key);
      // (a) Its two newest readings, whatever the range: latest, previous and change.
      const recentRows: Partial<StoredReading>[] = [];
      for (const storedKey of stored) {
        const read = storeRows(await store.readings({ projectId, searchKey: storedKey, limit: 2 }));
        spent += read.bytes;
        recentRows.push(...read.rows);
      }
      const recent = checkedOf(recentRows, projectId, key).sort(newestFirst).slice(0, 2);
      // (b) Its points in the range, within what is left of the byte budget; each reading reduced to its point.
      let available = 0;
      for (const storedKey of stored) available += await store.countReadings({ projectId, searchKey: storedKey, ...(from === undefined ? {} : { from }) });
      let returned = 0;
      const points: RankPoint[] = [];
      if (spent < tableReadBytes) {
        for (const storedKey of stored) {
          const left = tableReadBytes - spent;
          if (left <= 0) break;
          const read = storeRows(await store.readings({ projectId, searchKey: storedKey, limit: RANK_LIMITS.maxPointsPerSeries, maxBytes: left, ...(from === undefined ? {} : { from }) }));
          spent += read.bytes;
          returned += read.rows.length;
          for (const observation of checkedOf(read.rows, projectId, key)) points.push(rankOf(observation, view.siteMatch));
        }
      } else {
        // The budget is spent: no points beyond its newest readings.
        const inRange = recentRows.filter((row) => typeof row.observedAt === 'number' && row.observedAt >= start);
        returned = inRange.length;
        for (const observation of checkedOf(inRange, projectId, key)) points.push(rankOf(observation, view.siteMatch));
      }
      const row = rankRowOf({ searchKey: key, saved: entry, recent, points }, { site: view.siteMatch, competitors: view.competitorMatches, keyOf: searchKeyOf, range, now: at });
      // Capped when the store held more in the range than it answered (counted before any row was skipped as tampered).
      if (row !== null) rows.push({ ...row, capped: available > Math.min(returned, RANK_LIMITS.maxPointsPerSeries) });
    }
    return { status: 'ok', rows, truncated: order.length > RANK_LIMITS.maxRows, retention: view.retention, site: view.site, competitors: view.competitors, tags };
  };

  /** `run`'s answer, or `fallback` (logged by the error's code) when anything throws. */
  const guarded = async <A>(what: string, run: () => Promise<A>, fallback: A): Promise<A> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return fallback;
    }
  };

  /** The CSV of the table (`kind`), with its line count (header aside); `null` for a project that is not live. */
  const csvOf = async (projectId: string, kind: RankCsvKind, range: RankRange, tag: string | null): Promise<{ text: string; rows: number } | RankingsRefusal> => {
    const answer = await table(projectId, range, tag);
    if (answer.status !== 'ok') return answer.reason;
    const cells = rankCsvRows(answer.rows, kind);
    return { text: rankCsvText(cells), rows: Math.max(0, cells.length - 1) };
  };

  return {
    table: (projectId, range, tag) => guarded('the rank table', () => table(projectId, range, tag), refused('store-failed')),

    series: (projectId, searchKey, range) =>
      guarded(
        'a rank series',
        async () => {
          const view = await liveProject(projectId);
          if (view === null) return refused('not-found');
          const at = now();
          const from = rangeStart(range, at);
          const read = await searchObservations(projectId, searchKey, { limit: RANK_LIMITS.maxPointsPerSeries, ...(from > 0 ? { from } : {}) });
          return { status: 'ok' as const, searchKey, points: rankSeries(read, searchKey, { site: view.siteMatch, keyOf: searchKeyOf, range, now: at }) };
        },
        refused('store-failed'),
      ),

    readingDates: (projectId, searchKey) =>
      guarded(
        'the reading dates',
        async () => {
          if ((await liveProject(projectId)) === null) return refused('not-found');
          // Ids, times and statuses only: no reading JSON is loaded for the picker.
          const found = new Map<string, ReadingDate>();
          for (const key of storedKeysOf(await searchKeys(projectId), searchKey)) {
            for (const row of objects<ReadingDateRow>(await store.readingDates({ projectId, searchKey: key, limit: MAX_READING_DATES }))) {
              if (typeof row.id === 'string' && typeof row.observedAt === 'number' && (row.status === 'ready' || row.status === 'unreadable')) found.set(row.id, { readingId: row.id, at: row.observedAt, status: row.status });
            }
          }
          const dates = [...found.values()].sort((a, b) => b.at - a.at || (a.readingId < b.readingId ? 1 : a.readingId > b.readingId ? -1 : 0)).slice(0, MAX_READING_DATES);
          return { status: 'ok' as const, dates };
        },
        refused('store-failed'),
      ),

    compare: (projectId, a, b) =>
      guarded(
        'a comparison',
        async () => {
          const view = await liveProject(projectId);
          if (view === null) return refused('not-found');
          // Each reading by id, then held to this project: another project's reading is not found.
          const left = observationOf(await store.reading(a), projectId);
          const right = observationOf(await store.reading(b), projectId);
          if (left === null || right === null || left.id !== a || right.id !== b) return refused('not-found');
          return { status: 'ok' as const, comparison: compareSerps(left, right, { site: view.siteMatch, competitors: view.competitorMatches }) };
        },
        refused('store-failed'),
      ),

    copyCsv: (projectId, kind, range, tag) =>
      guarded(
        'Copy CSV',
        async () => {
          if (deps.clipboard === undefined) return null;
          const csv = await csvOf(projectId, kind, range, tag);
          if (typeof csv === 'string') return null;
          deps.clipboard.writeText(csv.text);
          return csv.rows;
        },
        null,
      ),

    saveCsv: async (windowId, projectId, kind, range, tag) => {
      // The CSV first: a project that is not live is refused before any dialog.
      const csv = await guarded('Save CSV', () => csvOf(projectId, kind, range, tag), 'store-failed' as const);
      if (typeof csv === 'string') return refused(csv);
      if (deps.chooseCsvPath === undefined) return { status: 'cancelled' as const };
      let file: string | null;
      try {
        file = await deps.chooseCsvPath(windowId, rankCsvFileName(kind, now()), kind);
      } catch (error) {
        log(`the save dialog failed (${codeOf(error)})`);
        return refused('write-failed');
      }
      // Only an absolute path the dialog answered; anything else writes nothing.
      if (typeof file !== 'string' || file === '' || !path.isAbsolute(file)) return { status: 'cancelled' as const };
      try {
        await writeCsv(file, csv.text);
        return { status: 'saved' as const, rows: csv.rows };
      } catch (error) {
        log(`the CSV file could not be written (${codeOf(error)})`);
        return refused('write-failed');
      }
    },
  };
}
