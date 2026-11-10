import { canonicalJson } from '@app/change-intel';
import type { ChangeIntelRepository } from '@app/db';
import { uuidv7 as defaultUuidv7 } from '@app/db';
import { DATA_CHECK_STOP_REFUSALS, DATA_CHECK_STOP_STATUSES, DATA_SERP_PROVIDERS, type DataCheckSkipReason, type DataSerpProvider, type LegalGateId } from '@app/specs/data-sources.spec';
import type { DataCheckPlan, DataCheckPlanInput, DataCheckProjectAnswer, DataCheckProjectInput, DataSerpProviderView } from '@app/specs/data-sources.schema';
import type { SavedSearchInput } from '@app/specs/projects.spec';
import { serpApiReadingPageUrl } from '@app/specs/serp-api.spec';
import type { SerpApiJob } from '@app/specs/serp-api.schema';
import type { SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { MAX_SERP_FILTERS_JSON_BYTES, MAX_SERP_READING_JSON_BYTES, SEARCH_KEY_VERSION } from '@app/specs/workspace-db.spec';
import { paramsOf } from '../changes/projects';
import { searchKeyOf } from '../changes/search-key';
import type { SerpApiJobAnswer } from '../serp/serp-api-parse';
import type { DataApiClient } from './api-client';
import { checkSearchViaApi, serpApiCheckParams } from './serp-api';

// "Check via API" for a project's saved searches (Phase 12 Task 4; acceptance `data-sources.feature.md`,
// Check via API; `projects.feature.md`, Checking searches via a data API; plan Decisions 4 and 7).
// - The vendor is main's, read again at every call (`serpProvider`: `resolveDataSerpProvider` over the
//   vendors offered); no SERP vendor gate open is `unavailable` (`LEGAL_GATE_NOTE`), whatever the
//   renderer asks. Task 3's `checkSearchViaApi` checks the vendor's gate again before each request.
// - `checkPlan` says what a check would send (the vendor, one request per saved search the vendor can
//   take **and** would be asked exactly as saved, `serpApiCheckParams`, so its reading joins that
//   search's own series: never a paid reading under another key) and sends nothing; `checkProjectSearches` plans again and refuses
//   `changed` unless that is what the user confirmed (the vendor and the count the confirm showed).
// - One check at a time (`busy`). The searches go one after another through the data client (its
//   spacing applies); each snapshot is stored with `appendApiReading` (`source = 'serp-api'`, no capture,
//   the saved search's own key, `page_url` the vendor's canonical request URL). A failed search is
//   reported and the next one still sent; after a refusal every request would get alike
//   (`DATA_CHECK_STOP_REFUSALS`), an account error from the vendor (`DATA_CHECK_STOP_STATUSES`), once
//   the project is gone, or after an unexpected failure once sending began, the rest are `skipped`
//   (`stopped`), never sent, and the answer is still `checked`. The searches not counted are answered
//   `skipped` with why (`unsupported`, `other-series`).
// - After a check that stored a reading, the project's retention is enforced (`afterWrite`).
// Nothing here runs on a timer or at startup: only the procedure starts a check. Never rejects.

export interface ProjectCheckDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: Pick<ChangeIntelRepository, 'project' | 'projectQueries' | 'appendApiReading'>;
  /** Task 1's client (`dataApiRequest`), the one reviewed path to a vendor. */
  readonly client: Pick<DataApiClient, 'dataApiRequest'>;
  /** The legal gates (`gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
  /** Task 2's "Check via API" vendor view (`dataSources.serpProvider`). */
  readonly serpProvider: () => Promise<DataSerpProviderView>;
  /** The SERP worker's `api` job (`serp.analyseApi`). */
  readonly parse: (job: SerpApiJob) => Promise<SerpApiJobAnswer>;
  /** Retention after a check stored readings (`projects-main.ts`: `retention.afterApiCheck`). */
  readonly afterWrite: (projectId: string) => void;
  /** The selector pack (default: the bundled one, as saved searches). */
  readonly pack?: SelectorPack | null;
  readonly now?: () => number;
  readonly uuid?: (at: number) => string;
  /** One line per check (never a key, a URL or a query). */
  readonly log?: (line: string) => void;
}

export interface ProjectCheckService {
  checkPlan(input: DataCheckPlanInput): Promise<DataCheckPlan>;
  checkProjectSearches(input: DataCheckProjectInput): Promise<DataCheckProjectAnswer>;
}

type Refused = Extract<DataCheckPlan, { status: 'refused' }>;
const refused = (reason: Refused['reason']): Refused => ({ status: 'refused', reason });

/** A saved search to check: its id and the search as `checkSearchViaApi` takes it. */
interface Target {
  readonly searchId: string;
  readonly search: SavedSearchInput;
}

/** A saved search asked for but not counted, and why. */
interface Excluded {
  readonly searchId: string;
  readonly reason: Exclude<DataCheckSkipReason, 'stopped'>;
}

type Planned =
  | { readonly ok: true; readonly provider: DataSerpProvider; readonly targets: readonly Target[]; readonly entries: readonly (Target | Excluded)[] }
  | { readonly ok: false; readonly answer: Refused };

const STOP: ReadonlySet<string> = new Set(DATA_CHECK_STOP_REFUSALS);
const STOP_STATUSES: ReadonlySet<number> = new Set(DATA_CHECK_STOP_STATUSES);
type SearchResult = Extract<DataCheckProjectAnswer, { status: 'checked' }>['results'][number];

/** An error's code or name: never its message. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

export function createProjectCheck(deps: ProjectCheckDeps): ProjectCheckService {
  const { store, isOpen } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? defaultUuidv7;
  const log = (line: string): void => deps.log?.(`data sources: ${line}`);
  const packDep = deps.pack === undefined ? {} : { pack: deps.pack };
  let running = false;

  /** The vendor and the saved searches a check of `input` would send, or why it sends none. */
  const plan = async (input: DataCheckPlanInput): Promise<Planned> => {
    // The legal gate first, read now: no SERP vendor offered in this build is `unavailable`.
    if (!DATA_SERP_PROVIDERS.some((provider) => isOpen(provider))) return { ok: false, answer: refused('unavailable') };
    const view = await deps.serpProvider();
    if (view.choices.length === 0) return { ok: false, answer: refused('no-key') };
    const provider = view.provider;
    if (provider === null) return { ok: false, answer: refused('no-provider') };
    if (!isOpen(provider)) return { ok: false, answer: refused('unavailable') };
    const project = await store.project(input.projectId);
    if (project === null || project.id !== input.projectId) return { ok: false, answer: refused('not-found') };
    const wanted = input.searchIds === undefined ? null : new Set(input.searchIds);
    const entries: (Target | Excluded)[] = [];
    for (const query of await store.projectQueries(input.projectId)) {
      if (query.projectId !== input.projectId || (wanted !== null && !wanted.has(query.id))) continue;
      // The saved search as it was saved (Phase 3's parameters of its URL; a tampered row is left out).
      const params = paramsOf(query.searchParamsJson);
      if (params === null) continue;
      const search: SavedSearchInput = { engine: params.engine as SavedSearchInput['engine'], query: params.query, country: params.gl, language: params.hl, device: params.device };
      // Counted only when the vendor would really be asked (its engine, device, country and language),
      // and asked exactly the saved search (else its reading would be filed under another key).
      const sent = serpApiCheckParams(search, provider, { isOpen, ...packDep });
      if (sent === null) entries.push({ searchId: query.id, reason: 'unsupported' });
      else if (canonicalJson(sent) !== canonicalJson(params)) entries.push({ searchId: query.id, reason: 'other-series' });
      else entries.push({ searchId: query.id, search });
    }
    const targets = entries.filter((entry): entry is Target => 'search' in entry);
    if (targets.length === 0) return { ok: false, answer: refused('no-searches') };
    return { ok: true, provider, targets, entries };
  };

  /** Stores one check's snapshot as an API reading; whether it was written. */
  const store1 = async (projectId: string, provider: DataSerpProvider, check: Extract<Awaited<ReturnType<typeof checkSearchViaApi>>, { ok: true }>): Promise<boolean> => {
    // No location in this task: an API reading's parameters are the saved search's exactly.
    if ('location' in check.params) return false;
    const searchKey = searchKeyOf(check.params, {});
    if (searchKey === null) return false;
    const readingJson = canonicalJson(check.snapshot);
    const filtersJson = canonicalJson({});
    if (Buffer.byteLength(readingJson, 'utf8') > MAX_SERP_READING_JSON_BYTES || Buffer.byteLength(filtersJson, 'utf8') > MAX_SERP_FILTERS_JSON_BYTES) return false;
    const at = now();
    return store.appendApiReading({
      id: uuid(at),
      projectId,
      searchKey,
      searchKeyVersion: SEARCH_KEY_VERSION,
      searchParamsJson: canonicalJson(check.params),
      filtersJson,
      status: check.snapshot.status,
      packVersion: check.snapshot.packVersion,
      readingJson,
      pageUrl: serpApiReadingPageUrl(provider),
      observedAt: at,
      createdAt: at,
    });
  };

  return {
    async checkPlan(input) {
      try {
        const planned = await plan(input);
        return planned.ok ? { status: 'ready', provider: planned.provider, requests: planned.targets.length } : planned.answer;
      } catch (error) {
        log(`a check could not be planned (${codeOf(error)})`);
        return refused('not-found');
      }
    },

    async checkProjectSearches(input) {
      if (running) return refused('busy');
      running = true;
      let stored = 0;
      // Outside the `try`: once anything was sent, the answer is `checked`, whatever fails after.
      const results: SearchResult[] = [];
      try {
        let planned: Planned;
        try {
          planned = await plan(input);
        } catch (error) {
          log(`a check could not be planned (${codeOf(error)})`);
          return refused('not-found');
        }
        if (!planned.ok) return planned.answer;
        // What the user confirmed is what runs.
        if (planned.provider !== input.provider || planned.targets.length !== input.requests) return refused('changed');
        const { provider, entries } = planned;
        let stop = false;
        for (const entry of entries) {
          const { searchId } = entry;
          if (!('search' in entry)) {
            results.push({ searchId, result: 'skipped', reason: entry.reason });
            continue;
          }
          let answered = false;
          try {
            // Once nothing more can succeed (no key, the gate closed, the account refused, the project gone), nothing more is sent.
            if (stop || (await store.project(input.projectId)) === null) {
              stop = true;
              continue;
            }
            const check = await checkSearchViaApi(entry.search, provider, { client: deps.client, isOpen, parse: deps.parse, ...packDep });
            if (!check.ok) {
              results.push({ searchId, result: 'failed', outcome: check.outcome, ...(check.refusal !== undefined ? { refusal: check.refusal } : {}), ...(check.status !== undefined ? { status: check.status } : {}) });
              answered = true;
              const accountError = check.refusal === 'http-error' && check.status !== undefined && STOP_STATUSES.has(check.status);
              if (check.outcome === 'unavailable' || (check.refusal !== undefined && STOP.has(check.refusal)) || accountError) stop = true;
              continue;
            }
            let written = false;
            try {
              written = await store1(input.projectId, provider, check);
            } catch (error) {
              log(`an API reading could not be stored (${codeOf(error)})`);
            }
            if (written) stored += 1;
            results.push({ searchId, result: written ? 'stored' : 'not-stored' });
            answered = true;
          } catch (error) {
            log(`a check stopped (${codeOf(error)})`);
            stop = true;
          } finally {
            if (!answered) results.push({ searchId, result: 'skipped', reason: 'stopped' });
          }
        }
        log(`checked ${planned.targets.length} searches via ${provider}: ${stored} stored`);
        return { status: 'checked', provider, results };
      } finally {
        running = false;
        // The project's retention, after its writes (as after a capture run's end).
        if (stored > 0) {
          try {
            deps.afterWrite(input.projectId);
          } catch (error) {
            log(`retention after a check could not start (${codeOf(error)})`);
          }
        }
      }
    },
  };
}
