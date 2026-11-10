import { sortedJson } from '@app/specs/rankings.spec';
import { DATA_API_REQUESTS, isDataSerpProvider, isLegalGateId, type LegalGateId } from '@app/specs/data-sources.spec';
import { searchLocaleFor, searchUrlFor } from '@app/specs/projects.spec';
import { SERP_API_LIMITS, SERP_API_OUTCOME_MESSAGES, SERP_API_PROVIDERS, dataForSeoLocationCode, type SerpApiOutcome, type SerpApiProvider } from '@app/specs/serp-api.spec';
import { SerpApiRequestSchema, type SerpApiCheck, type SerpApiJob, type SerpApiRequest } from '@app/specs/serp-api.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { bundledPack, searchParamsForUrl } from '../changes/serp-params';
import type { SerpApiJobAnswer } from '../serp/serp-api-parse';
import type { DataApiBuild, DataApiClient } from './api-client';

// "Check via API" for one search (Phase 12 Task 3; spec `serp-api.spec.ts`, `serp-api.schema.ts`;
// plan Decisions 4 and 7, Global constraints "Secrets", "Third-party requests" and "Untrusted text").
// `checkSearchViaApi(search, provider, deps)`:
// 1. refuses a vendor whose legal gate is closed (`unavailable`), before anything else;
// 2. validates the search (`SerpApiRequestSchema`) and refuses what the vendor cannot take
//    (`SERP_API_PROVIDERS`: engine, device; DataForSEO's language and place);
// 3. builds the search parameters exactly as a saved search's (`searchParamsForUrl(searchUrlFor(search),
//    device)` with the pack, the bundled one by default, checked as `savedSearchParams` checks them),
//    adding `location: { via: 'api', label }` when a location is given; `packVersion` is that pack's;
// 4. builds the vendor's request from those validated fields only (SerpApi's query with
//    `URLSearchParams`; DataForSEO's and Serper's JSON bodies) and sends it through Task 1's
//    `dataApiRequest` (the key read and the request sent inside its `withKey` closure);
// 5. has the SERP worker parse and map the answer (`parse`, job kind `api`): main never parses the
//    vendor's JSON, and only checks the snapshot's shape and that it is of this search.
// It answers the snapshot and the parameters, or a typed failure; it never throws and stores nothing
// (Task 4 writes the reading). Nothing here runs on a timer: each call follows a user action.

export interface SerpApiCheckDeps {
  /** Task 1's client (`dataApiRequest`), the one reviewed path to a vendor. */
  readonly client: Pick<DataApiClient, 'dataApiRequest'>;
  /** The legal gates (`gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
  /** The SERP worker's `api` job (`SerpAnalyzer.analyseApi`). */
  readonly parse: (job: SerpApiJob) => Promise<SerpApiJobAnswer>;
  /** The selector pack whose engine definition builds the search (default: the bundled pack, as saved searches). */
  readonly pack?: SelectorPack | null;
}

const fail = (outcome: Exclude<SerpApiOutcome, 'request-failed'>): SerpApiCheck => ({ ok: false, outcome, message: SERP_API_OUTCOME_MESSAGES[outcome] });

/** The canonical URL of `provider`'s SERP request (`DATA_API_REQUESTS`). */
const targetOf = (provider: SerpApiProvider): string => DATA_API_REQUESTS[provider].find((target) => target.purpose === 'serp')!.url;

/** The vendor's request for `params` (and the location as typed), or `null` when the vendor cannot take it. */
function buildFor(provider: SerpApiProvider, params: SearchParams, location: string | null): DataApiBuild | null {
  const url = targetOf(provider);
  const info = SERP_API_PROVIDERS[provider];
  switch (provider) {
    case 'serpapi': {
      const domain = new URL(params.url).hostname.replace(/^www\./, '');
      return (secrets) => {
        const query = new URLSearchParams();
        query.set('engine', params.engine);
        query.set('q', params.query);
        if (location !== null) query.set('location', location);
        if (params.gl !== null) query.set('gl', params.gl);
        if (params.hl !== null) query.set('hl', params.hl);
        query.set('google_domain', domain);
        query.set('device', params.device);
        query.set('api_key', secrets.serpapi ?? '');
        return { method: 'GET', url: `${url}?${query.toString()}`, headers: { accept: 'application/json' } };
      };
    }
    case 'dataforseo': {
      // DataForSEO needs a place and a language: the location as typed (`location_name`), else the
      // country's pinned `location_code` (`DATAFORSEO_COUNTRY_LOCATION_CODES`; one not listed is unsupported).
      const code = location === null && params.gl !== null ? dataForSeoLocationCode(params.gl) : null;
      if ((location === null && code === null) || params.hl === null) return null;
      const place = location !== null ? { location_name: location } : { location_code: code };
      const body = JSON.stringify([{ keyword: params.query, ...place, language_code: params.hl, device: params.device, depth: info.pageSize }]);
      return (secrets) => ({
        method: 'POST',
        url,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${secrets['dataforseo-login'] ?? ''}:${secrets['dataforseo-password'] ?? ''}`, 'utf8').toString('base64')}`,
        },
        body,
      });
    }
    case 'serper': {
      const body = JSON.stringify({ q: params.query, ...(params.gl !== null ? { gl: params.gl } : {}), ...(params.hl !== null ? { hl: params.hl } : {}), ...(location !== null ? { location } : {}) });
      return (secrets) => ({ method: 'POST', url, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': secrets.serper ?? '' }, body });
    }
  }
}

/** A saved search's parameters by `pack`, checked as `savedSearchParams` checks them; else `null`. */
function savedParamsBy(search: SerpApiRequest, pack: SelectorPack): SearchParams | null {
  const { location: _location, ...saved } = search;
  const params = searchParamsForUrl(searchUrlFor(saved), saved.device, pack);
  const { gl, hl } = searchLocaleFor(saved);
  return params !== null && params.engine === saved.engine && params.gl === gl && params.hl === hl && params.page === 1 ? params : null;
}

/** What a check would send (steps 1–3 of the header), or why it sends nothing. */
type Prepared =
  | { readonly ok: true; readonly provider: SerpApiProvider; readonly params: SearchParams; readonly pack: SelectorPack; readonly build: DataApiBuild }
  | { readonly ok: false; readonly outcome: Exclude<SerpApiOutcome, 'request-failed'> };

function prepare(search: unknown, provider: unknown, deps: Pick<SerpApiCheckDeps, 'isOpen' | 'pack'>): Prepared {
  // The gate first: nothing is validated, built, read or sent for a vendor that isn't offered.
  if (!isLegalGateId(provider) || !deps.isOpen(provider)) return { ok: false, outcome: 'unavailable' };
  if (!isDataSerpProvider(provider)) return { ok: false, outcome: 'unsupported' };
  const parsed = SerpApiRequestSchema.safeParse(search);
  if (!parsed.success) return { ok: false, outcome: 'invalid-search' };
  const request = parsed.data;
  const info = SERP_API_PROVIDERS[provider];
  if (!info.engines.includes(request.engine) || !info.devices.includes(request.device)) return { ok: false, outcome: 'unsupported' };

  const pack = deps.pack === undefined ? bundledPack() : deps.pack;
  if (pack === null) return { ok: false, outcome: 'invalid-search' };
  const saved = savedParamsBy(request, pack);
  if (saved === null) return { ok: false, outcome: 'invalid-search' };
  const location = request.location ?? null;
  const params: SearchParams = location === null ? saved : { ...saved, location: { via: 'api', label: location } };
  const build = buildFor(provider, params, location);
  if (build === null) return { ok: false, outcome: 'unsupported' };
  return { ok: true, provider, params, pack, build };
}

/**
 * The search parameters `checkSearchViaApi(search, provider)` would send and file its reading under,
 * or `null` when it would send nothing (its gate is closed, or the vendor can't take the search).
 * Task 4 counts a search only when these are exactly its saved parameters. Sends and reads nothing;
 * never throws.
 */
export function serpApiCheckParams(search: unknown, provider: unknown, deps: Pick<SerpApiCheckDeps, 'isOpen' | 'pack'>): SearchParams | null {
  try {
    const prepared = prepare(search, provider, deps);
    return prepared.ok ? prepared.params : null;
  } catch {
    return null;
  }
}

/** Checks `search` on `provider`'s API (see the header). Never throws. */
export async function checkSearchViaApi(search: unknown, provider: unknown, deps: SerpApiCheckDeps): Promise<SerpApiCheck> {
  try {
    const prepared = prepare(search, provider, deps);
    if (!prepared.ok) return fail(prepared.outcome);
    const { params, pack, build } = prepared;
    const answer = await deps.client.dataApiRequest(prepared.provider, 'serp', build);
    if (!answer.ok) return { ok: false, outcome: 'request-failed', refusal: answer.refusal, message: answer.message, ...(answer.status !== undefined ? { status: answer.status } : {}) };
    // The client caps the body; the length is checked again before it is posted (the worker checks its bytes).
    if (answer.body.length > SERP_API_LIMITS.maxResponseBytes) return fail('invalid-answer');

    const job: SerpApiJob = { provider: prepared.provider, body: answer.body, params, packVersion: pack.version };
    const mapped = await deps.parse(job).catch(() => null);
    if (mapped === null || typeof mapped !== 'object') return fail('invalid-answer');
    if (mapped.vendorError === true) return fail('vendor-error');
    const { snapshot } = mapped;
    if (snapshot?.status !== 'ready' && !(snapshot?.status === 'unreadable' && snapshot.reason === 'no-results')) return fail('invalid-answer');
    // Only a snapshot of this search, by this pack, is answered.
    if (snapshot.params === null || sortedJson(snapshot.params) !== sortedJson(params) || snapshot.packVersion !== pack.version) return fail('invalid-answer');
    const skipped = Number.isSafeInteger(mapped.skipped) && mapped.skipped >= 0 ? mapped.skipped : 0;
    return { ok: true, snapshot, params, skipped, url: answer.url };
  } catch {
    return fail('invalid-answer');
  }
}
