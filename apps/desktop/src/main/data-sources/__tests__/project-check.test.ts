// Spec: specs/data-sources.spec.ts (DATA_CHECK_REFUSALS, DATA_CHECK_SEARCH_RESULTS, DATA_CHECK_STOP_REFUSALS,
// SERP_API_VENDOR_AVAILABLE, LEGAL_GATE_NOTE, resolveDataSerpProvider), specs/data-sources.schema.ts (DataCheckPlanSchema,
// DataCheckProjectAnswerSchema), specs/serp-api.spec.ts (serpApiReadingPageUrl), specs/workspace-db.spec.ts (SEARCH_KEY_VERSION)
// Acceptance: specs/data-sources.feature.md (Check via API: api-check-gated-off-refuses, api-check-is-user-initiated,
// api-check-says-the-count-first, api-check-joins-the-tab-series, api-check-partial-failure), specs/retention.feature.md
// (api-only-project-obeys-retention: retention after a check's writes), specs/projects.feature.md (Checking searches via a data API)
// · plan docs/plans/phase-12-big-bets.md, Decisions 4 and 7, As built (legal gates), Task 4
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { DATA_API_REQUESTS, LEGAL_GATE_NOTE, SERP_API_VENDOR_AVAILABLE, type LegalGateId } from '@app/specs/data-sources.spec';
import { DataCheckPlanSchema, DataCheckProjectAnswerSchema, type DataSerpProviderView } from '@app/specs/data-sources.schema';
import { serpApiReadingPageUrl } from '@app/specs/serp-api.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SEARCH_KEY_VERSION } from '@app/specs/workspace-db.spec';
import { paramsOf, savedSearchParams } from '../../changes/projects';
import { searchParamsForUrl } from '../../changes/serp-params';
import { searchKeyOf } from '../../changes/rankings';
import { SEARCH, captured, clock, setup, tick, type T } from '../../changes/__tests__/rankings-fixtures';
import { runSerpApiJob } from '../../serp/serp-api-parse';
import { createDataApiClient } from '../api-client';
import { createLegalGates } from '../gates';
import { createProjectCheck, type ProjectCheckDeps } from '../project-check';
import { allOpen, dataStore, recordingFetch, SERPAPI_KEY } from './fakes';

// Real SQLite files: Windows runners are slow at file I/O.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(HERE, '..', '..', 'serp', '__tests__', 'fixtures', 'serp-api', 'serpapi.json'), 'utf8');
const SERPAPI: DataSerpProviderView = { provider: 'serpapi', choices: ['serpapi'] };
const BLACK = savedSearchParams({ engine: 'google', query: 'black tea', country: 'de', language: 'de', device: 'desktop' })!;
const WHITE = savedSearchParams({ engine: 'google', query: 'white tea', country: 'us', language: 'en', device: 'mobile' })!;
/** A Bing search: no vendor takes it, so a check never counts or sends it. */
const BING = savedSearchParams({ engine: 'bing', query: 'green tea', country: 'de', language: 'de', device: 'desktop' })!;
/**
 * A Google search saved from google.de: Phase 3 reads it (so it is a saved search), but a vendor would
 * be asked the google.com search, whose key is another (`other-series`): never counted or sent.
 */
const ON_GOOGLE_DE = searchParamsForUrl('https://www.google.de/search?q=green+tea&gl=de&hl=de', 'desktop')!;

afterEach(() => {
  vi.useRealTimers();
});

/** A project with a site and the saved searches `searches` (in order); answers its id and the searches' ids. */
async function projectWith(t: T, searches: readonly SearchParams[]): Promise<{ id: string; searchIds: string[] }> {
  const created = (await t.repo.createProject('Tea', tick()))!;
  expect(await t.repo.setProjectSite(created.id, 'example.com', true)).toBe(true);
  const searchIds: string[] = [];
  for (const params of searches) searchIds.push((await t.repo.addQuery(created.id, params.query, canonicalJson(params), tick()))!.id);
  return { id: created.id, searchIds };
}

/** The check service over `t`'s store, a keyed data client whose fetch answers `answer`, and the SERP worker's job in-process. */
async function harness(t: T, options: { isOpen?: (id: LegalGateId) => boolean; view?: DataSerpProviderView; answer?: (url: string, init: RequestInit) => Response | Promise<Response>; keyed?: boolean; extra?: Partial<ProjectCheckDeps> } = {}) {
  const { store } = dataStore();
  if (options.keyed !== false) expect(await store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetch, calls } = recordingFetch(async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await (options.answer ?? (() => new Response(FIXTURE, { status: 200 })))(url, init);
    } finally {
      inFlight -= 1;
    }
  });
  const isOpen = options.isOpen ?? allOpen;
  const client = createDataApiClient({ store, isOpen, fetch, sleep: async () => undefined });
  const serpProvider = vi.fn(async () => options.view ?? SERPAPI);
  const parse = vi.fn(async (job: Parameters<ProjectCheckDeps['parse']>[0]) => runSerpApiJob(job));
  const afterWrite = vi.fn((_projectId: string) => undefined);
  const service = createProjectCheck({ store: t.repo, client, isOpen, serpProvider, parse, afterWrite, now: () => clock.now, ...options.extra });
  return { service, calls, fetch, serpProvider, parse, afterWrite, maxInFlight: () => maxInFlight };
}

describe('fixtures', () => {
  test('the google.de search is a saved search of another key', () => {
    expect(ON_GOOGLE_DE).not.toBeNull();
    expect(paramsOf(canonicalJson(ON_GOOGLE_DE))).toEqual(ON_GOOGLE_DE);
    expect(searchKeyOf(ON_GOOGLE_DE, {})).not.toBe(searchKeyOf(SEARCH, {}));
  });
});

const apiRows = (t: T, projectId: string) =>
  t.raw
    .prepare("SELECT id, capture_id AS captureId, source, search_key AS searchKey, search_key_version AS version, search_params AS params, filters, page_url AS pageUrl FROM ci_serp_readings WHERE project_id = ? AND source = 'serp-api' ORDER BY observed_at, id")
    .all(projectId)
    .map((row) => ({ ...row }));

describe('Check via API into a project', () => {
  test('api-check-gated-off-refuses', async () => {
    // The shipped constants: every SERP vendor closed, and main refuses whatever the renderer (or a stale view) says.
    expect(SERP_API_VENDOR_AVAILABLE).toEqual({ serpapi: false, dataforseo: false, serper: false });
    const gates = createLegalGates({ packaged: true });
    const t = setup();
    const { id } = await projectWith(t, [SEARCH, BLACK, WHITE]);
    const { service, calls, parse } = await harness(t, { isOpen: (gate) => gates.isOpen(gate) });
    const unavailable = { status: 'refused', reason: 'unavailable' };
    expect(DataCheckPlanSchema.parse(await service.checkPlan({ projectId: id }))).toEqual(unavailable);
    expect(DataCheckProjectAnswerSchema.parse(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 3 }))).toEqual(unavailable);
    expect(calls).toHaveLength(0);
    expect(parse).not.toHaveBeenCalled();
    expect(apiRows(t, id)).toEqual([]);
    // What the renderer shows for it is the legal note.
    const { DATA_CHECK_REFUSAL_MESSAGES } = await import('@app/specs/data-sources.spec');
    expect(DATA_CHECK_REFUSAL_MESSAGES.unavailable).toBe(LEGAL_GATE_NOTE);
  });

  test('api-check-vendor-is-mains', async () => {
    const t = setup();
    const { id } = await projectWith(t, [SEARCH]);
    // Gates open but no vendor with a key: `no-key`; several offered, none chosen: `no-provider`.
    const noKey = await harness(t, { view: { provider: null, choices: [] } });
    expect(await noKey.service.checkPlan({ projectId: id })).toEqual({ status: 'refused', reason: 'no-key' });
    const none = await harness(t, { view: { provider: null, choices: ['serpapi', 'serper'] } });
    expect(await none.service.checkPlan({ projectId: id })).toEqual({ status: 'refused', reason: 'no-provider' });
    expect(await none.service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 1 })).toEqual({ status: 'refused', reason: 'no-provider' });
    // The vendor named, its own gate closed (re-read at call time): `unavailable`.
    const closed = await harness(t, { isOpen: (gate) => gate !== 'serpapi' });
    expect(await closed.service.checkPlan({ projectId: id })).toEqual({ status: 'refused', reason: 'unavailable' });
    // A project that is not live; one with nothing a vendor can check.
    const open = await harness(t);
    expect(await open.service.checkPlan({ projectId: '01920000-0000-7000-8000-0000000000ff' })).toEqual({ status: 'refused', reason: 'not-found' });
    const bingOnly = await projectWith(t, [BING]);
    expect(await open.service.checkPlan({ projectId: bingOnly.id })).toEqual({ status: 'refused', reason: 'no-searches' });
    for (const h of [noKey, none, closed, open]) expect(h.calls).toHaveLength(0);
  });

  test('api-check-is-user-initiated', async () => {
    vi.useFakeTimers();
    const t = setup();
    const { id } = await projectWith(t, [SEARCH, BLACK, WHITE]);
    const { service, calls } = await harness(t);
    // Setting it up starts nothing: no timer, no request, however long frost stays open.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * 24 * 3_600_000);
    expect(calls).toHaveLength(0);
    expect(apiRows(t, id)).toEqual([]);
    // Only the procedure sends (one request per search).
    vi.useRealTimers();
    expect(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 3 })).toMatchObject({ status: 'checked' });
    expect(calls).toHaveLength(3);
  });

  test('api-check-says-the-count-first', async () => {
    const t = setup();
    const { id, searchIds } = await projectWith(t, [SEARCH, BING, BLACK, WHITE]);
    const { service, calls } = await harness(t);
    // The plan: the vendor and one request per search it can take (the Bing search is left out); nothing sent.
    expect(DataCheckPlanSchema.parse(await service.checkPlan({ projectId: id }))).toEqual({ status: 'ready', provider: 'serpapi', requests: 3 });
    expect(await service.checkPlan({ projectId: id, searchIds: [searchIds[0]!, searchIds[3]!] })).toEqual({ status: 'ready', provider: 'serpapi', requests: 2 });
    expect(await service.checkPlan({ projectId: id, searchIds: [searchIds[1]!] })).toEqual({ status: 'refused', reason: 'no-searches' });
    expect(calls).toHaveLength(0);
    // What the user confirmed must be main's plan: another count or vendor is `changed`, nothing sent.
    expect(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 4 })).toEqual({ status: 'refused', reason: 'changed' });
    expect(await service.checkProjectSearches({ projectId: id, provider: 'serper', requests: 3 })).toEqual({ status: 'refused', reason: 'changed' });
    expect(await service.checkProjectSearches({ projectId: id, searchIds: [searchIds[0]!], provider: 'serpapi', requests: 2 })).toEqual({ status: 'refused', reason: 'changed' });
    expect(calls).toHaveLength(0);
    expect(apiRows(t, id)).toEqual([]);
    // As confirmed: just those.
    const answer = DataCheckProjectAnswerSchema.parse(await service.checkProjectSearches({ projectId: id, searchIds: [searchIds[3]!], provider: 'serpapi', requests: 1 }));
    expect(answer).toEqual({ status: 'checked', provider: 'serpapi', results: [{ searchId: searchIds[3], result: 'stored' }] });
    expect(calls).toHaveLength(1);
  });

  test('api-check-joins-the-tab-series', async () => {
    const t = setup();
    const { id, searchIds } = await projectWith(t, [SEARCH, BLACK, WHITE]);
    // The first search was also captured in a tab.
    const tab = await captured(t, id, SEARCH);
    const { service, calls, afterWrite, maxInFlight } = await harness(t);
    const answer = DataCheckProjectAnswerSchema.parse(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 3 }));
    expect(answer).toEqual({ status: 'checked', provider: 'serpapi', results: searchIds.map((searchId) => ({ searchId, result: 'stored' })) });
    // One after another, through the data client (its allowlisted SerpApi request).
    expect(maxInFlight()).toBe(1);
    expect(calls.map((call) => new URL(call.url).origin + new URL(call.url).pathname)).toEqual(Array(3).fill(DATA_API_REQUESTS.serpapi[0]!.url));
    // One reading per search: `serp-api`, no capture, the saved search's key and parameters (no location), the vendor's URL.
    const rows = apiRows(t, id);
    expect(rows).toHaveLength(3);
    for (const [index, params] of [SEARCH, BLACK, WHITE].entries()) {
      const row = rows[index]!;
      expect(row).toMatchObject({ captureId: null, source: 'serp-api', searchKey: searchKeyOf(params, {}), version: SEARCH_KEY_VERSION, filters: '{}', pageUrl: serpApiReadingPageUrl('serpapi') });
      const stored = SearchParamsSchema.parse(JSON.parse(String(row['params'])));
      expect(stored).toEqual(params);
      expect('location' in stored).toBe(false);
    }
    // The tab capture's reading has the same key: one series, each point with its source.
    const tabKey = t.raw.prepare('SELECT search_key AS k FROM ci_serp_readings WHERE id = ?').get(tab.readingId)!['k'];
    expect(rows[0]!['searchKey']).toBe(tabKey);
    const table = await t.rankings.table(id, 'all', null);
    if (table.status !== 'ok') throw new Error('refused');
    expect(table.rows).toHaveLength(3);
    const row = table.rows.find((r) => r.searchKey === tabKey)!;
    expect(row.points.map((point) => [point.readingId, point.source ?? 'capture', point.provider ?? null])).toEqual([
      [tab.readingId, 'capture', null],
      [rows[0]!['id'], 'serp-api', 'serpapi'],
    ]);
    // Retention runs after the writes (once), as after a capture run.
    expect(afterWrite.mock.calls).toEqual([[id]]);
  });

  test('api-check-partial-failure', async () => {
    const t = setup();
    const { id, searchIds } = await projectWith(t, [SEARCH, BLACK, WHITE]);
    let n = 0;
    const { service, calls, afterWrite } = await harness(t, { answer: () => ((n += 1) === 2 ? new Response('oops', { status: 500 }) : new Response(FIXTURE, { status: 200 })) });
    const answer = DataCheckProjectAnswerSchema.parse(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 3 }));
    expect(answer).toEqual({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: searchIds[0], result: 'stored' },
        { searchId: searchIds[1], result: 'failed', outcome: 'request-failed', refusal: 'http-error', status: 500 },
        { searchId: searchIds[2], result: 'stored' },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(apiRows(t, id).map((row) => row['searchKey'])).toEqual([searchKeyOf(SEARCH, {}), searchKeyOf(WHITE, {})]);
    expect(afterWrite).toHaveBeenCalledOnce();

    // An account error from the vendor (401, 402, 403, 429) stops the check: the rest are not sent.
    for (const status of [401, 402, 403, 429]) {
      const account = await projectWith(t, [SEARCH, BLACK, WHITE]);
      const refusing = await harness(t, { answer: () => new Response('no', { status }) });
      expect(await refusing.service.checkProjectSearches({ projectId: account.id, provider: 'serpapi', requests: 3 }), String(status)).toEqual({
        status: 'checked',
        provider: 'serpapi',
        results: [
          { searchId: account.searchIds[0], result: 'failed', outcome: 'request-failed', refusal: 'http-error', status },
          { searchId: account.searchIds[1], result: 'skipped', reason: 'stopped' },
          { searchId: account.searchIds[2], result: 'skipped', reason: 'stopped' },
        ],
      });
      expect(refusing.calls, String(status)).toHaveLength(1);
      expect(refusing.afterWrite).not.toHaveBeenCalled();
    }

    // A refusal every request would get alike (no key): the rest are not sent, nothing is written, no retention.
    const other = await projectWith(t, [SEARCH, BLACK]);
    const unkeyed = await harness(t, { keyed: false });
    expect(await unkeyed.service.checkProjectSearches({ projectId: other.id, provider: 'serpapi', requests: 2 })).toEqual({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: other.searchIds[0], result: 'failed', outcome: 'request-failed', refusal: 'no-key' },
        { searchId: other.searchIds[1], result: 'skipped', reason: 'stopped' },
      ],
    });
    expect(unkeyed.calls).toHaveLength(0);
    expect(unkeyed.afterWrite).not.toHaveBeenCalled();

    // A reading the store refuses (the project deleted mid-check) is `not-stored`; the rest are skipped.
    const doomed = await projectWith(t, [SEARCH, BLACK]);
    const deleting = await harness(t, {
      answer: async () => {
        await t.repo.tombstoneProject(doomed.id, tick());
        return new Response(FIXTURE, { status: 200 });
      },
    });
    expect(await deleting.service.checkProjectSearches({ projectId: doomed.id, provider: 'serpapi', requests: 2 })).toEqual({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: doomed.searchIds[0], result: 'not-stored' },
        { searchId: doomed.searchIds[1], result: 'skipped', reason: 'stopped' },
      ],
    });
    expect(deleting.calls).toHaveLength(1);

    // An unexpected failure once sending began: still `checked`, what was stored stays, the rest are skipped.
    const flaky = await projectWith(t, [SEARCH, BLACK, WHITE]);
    let asked = 0;
    const store = Object.assign(Object.create(t.repo) as typeof t.repo, {
      project: vi.fn(async (projectId: string) => {
        asked += 1;
        // The plan's read, the first search's: fine; the second search's: the database fails.
        if (asked === 3) throw Object.assign(new Error('SQLITE_IOERR'), { code: 'SQLITE_IOERR' });
        return t.repo.project(projectId);
      }),
    });
    const failing = await harness(t, { extra: { store } });
    expect(DataCheckProjectAnswerSchema.parse(await failing.service.checkProjectSearches({ projectId: flaky.id, provider: 'serpapi', requests: 3 }))).toEqual({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: flaky.searchIds[0], result: 'stored' },
        { searchId: flaky.searchIds[1], result: 'skipped', reason: 'stopped' },
        { searchId: flaky.searchIds[2], result: 'skipped', reason: 'stopped' },
      ],
    });
    expect(failing.calls).toHaveLength(1);
    expect(apiRows(t, flaky.id)).toHaveLength(1);
    expect(failing.afterWrite.mock.calls).toEqual([[flaky.id]]);
  });

  test('api-check-counts-only-the-saved-series', async () => {
    // A search the vendor would be asked differently (another key) or can't take is never counted or sent.
    const t = setup();
    const { id, searchIds } = await projectWith(t, [SEARCH, ON_GOOGLE_DE, BING, BLACK]);
    const { service, calls } = await harness(t);
    expect(await service.checkPlan({ projectId: id })).toEqual({ status: 'ready', provider: 'serpapi', requests: 2 });
    expect(await service.checkPlan({ projectId: id, searchIds: [searchIds[1]!] })).toEqual({ status: 'refused', reason: 'no-searches' });
    expect(DataCheckProjectAnswerSchema.parse(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 2 }))).toEqual({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: searchIds[0], result: 'stored' },
        { searchId: searchIds[1], result: 'skipped', reason: 'other-series' },
        { searchId: searchIds[2], result: 'skipped', reason: 'unsupported' },
        { searchId: searchIds[3], result: 'stored' },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(apiRows(t, id).map((row) => row['searchKey'])).toEqual([searchKeyOf(SEARCH, {}), searchKeyOf(BLACK, {})]);
  });

  test('api-check-one-at-a-time', async () => {
    const t = setup();
    const { id } = await projectWith(t, [SEARCH]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { service, calls } = await harness(t, {
      answer: async () => {
        await held;
        return new Response(FIXTURE, { status: 200 });
      },
    });
    const first = service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 1 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 1 })).toEqual({ status: 'refused', reason: 'busy' });
    release();
    expect(await first).toMatchObject({ status: 'checked' });
    expect(await service.checkProjectSearches({ projectId: id, provider: 'serpapi', requests: 1 })).toMatchObject({ status: 'checked' });
  });
});
