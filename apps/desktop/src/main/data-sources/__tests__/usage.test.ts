// Spec: specs/data-sources.spec.ts (DATA_USAGE_LIMITS, dataUsageMonth, DATA_SERP_PROVIDERS, DATA_SERP_PROVIDER_KEY,
// SERP_API_VENDOR_AVAILABLE, LEGAL_GATE_NOTE), specs/data-sources.schema.ts (DataUsageViewSchema,
// DataSerpProviderViewSchema, DATA_SET_SERP_PROVIDER_RESULTS)
// Acceptance: specs/data-sources.feature.md (Usage counter: data-usage-counts-every-request, data-usage-view;
// Settings › Data sources: settings-data-sources-serp-choice, resolveDataSerpProvider) · plan docs/plans/phase-12-big-bets.md, Decision 4
// ("a local usage counter"), Threat model "Hidden spend", Task 2
import { describe, expect, test, vi } from 'vitest';
import { DATA_API_REQUESTS, DATA_PROVIDERS, resolveDataSerpProvider, SERP_API_VENDOR_AVAILABLE, type DataProvider, type DataSerpProvider, type LegalGateId } from '@app/specs/data-sources.spec';
import { DataSerpProviderViewSchema, DataUsageViewSchema } from '@app/specs/data-sources.schema';
import { createDataApiClient, type DataApiBuild } from '../api-client';
import { createLegalGates } from '../gates';
import { createDataSourcesService } from '../service';
import { createDataUsageService } from '../usage';
import { allOpen, dataStore, DFS_LOGIN, FILE, DFS_PASSWORD, recordingFetch, SERPAPI_KEY, SERPER_KEY } from './fakes';

const SERPAPI_URL = DATA_API_REQUESTS.serpapi[0]!.url;
const serpapi: DataApiBuild = (secrets) => ({ method: 'GET', url: `${SERPAPI_URL}?${new URLSearchParams({ q: 'frost', api_key: secrets.serpapi! }).toString()}` });
const serper: DataApiBuild = (secrets) => ({ method: 'POST', url: DATA_API_REQUESTS.serper[0]!.url, headers: { 'x-api-key': secrets.serper!, 'content-type': 'application/json' }, body: '{"q":"frost"}' });

/** A counter fake that records each count in `events`, beside the fetches. */
function counter(events: string[]) {
  const counted: DataProvider[] = [];
  const countRequest = vi.fn(async (provider: DataProvider) => {
    counted.push(provider);
    events.push(`count ${provider}`);
  });
  return { counted, countRequest };
}

async function keyed() {
  const setup = dataStore();
  expect(await setup.store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
  expect(await setup.store.setKey('serper', SERPER_KEY)).toBe('stored');
  return setup;
}

describe('data usage counter', () => {
  test('data-usage-counts-every-request', async () => {
    const { store } = await keyed();
    const events: string[] = [];
    const { counted, countRequest } = counter(events);
    // The provider answers in turn: 200, 500, a redirect, a network failure, a body too large.
    const answers: (() => Response)[] = [
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('nope', { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('x'.repeat(16), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
    ];
    const { fetch, calls } = recordingFetch(() => {
      events.push('fetch');
      return answers[calls.length - 1]!();
    });
    const api = createDataApiClient({ store, isOpen: allOpen, fetch, countRequest, sleep: async () => undefined });

    const outcomes = [];
    for (let i = 0; i < answers.length; i += 1) outcomes.push(await api.dataApiRequest('serpapi', 'serp', serpapi));
    expect(outcomes.map((o) => (o.ok ? 'ok' : o.refusal))).toEqual(['ok', 'http-error', 'redirect', 'network', 'too-large']);
    // Every request that was sent counted once, each as it was handed to the fetch (council review).
    expect(calls).toHaveLength(5);
    expect(counted).toEqual(['serpapi', 'serpapi', 'serpapi', 'serpapi', 'serpapi']);
    expect(events).toEqual(Array.from({ length: 5 }, () => ['fetch', 'count serpapi']).flat());
    // A timeout counts too (it was sent).
    const slow = createDataApiClient({
      store,
      isOpen: allOpen,
      countRequest,
      timeoutMs: 5,
      sleep: async () => undefined,
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    expect(await slow.dataApiRequest('serper', 'serp', serper)).toMatchObject({ ok: false, refusal: 'timeout' });
    expect(counted).toEqual(['serpapi', 'serpapi', 'serpapi', 'serpapi', 'serpapi', 'serper']);
  });

  test('data-usage-refused-requests-never-count', async () => {
    const { store } = await keyed();
    const events: string[] = [];
    const { countRequest } = counter(events);
    const { fetch } = recordingFetch();
    const closed = (id: LegalGateId) => id !== 'serpapi';
    const api = createDataApiClient({ store, isOpen: closed, fetch, countRequest, sleep: async () => undefined });
    // `unavailable` (the gate), `not-allowed` (off the allowlist, a header, a build that throws), `no-key`.
    expect(await api.dataApiRequest('serpapi', 'serp', serpapi)).toMatchObject({ refusal: 'unavailable' });
    expect(await api.dataApiRequest('serper', 'serp', () => ({ method: 'POST', url: 'https://google.serper.dev/other' }))).toMatchObject({ refusal: 'not-allowed' });
    expect(await api.dataApiRequest('serper', 'serp', (s) => ({ method: 'POST', url: DATA_API_REQUESTS.serper[0]!.url, headers: { cookie: s.serper! } }))).toMatchObject({ refusal: 'not-allowed' });
    expect(
      await api.dataApiRequest('serper', 'serp', () => {
        throw new Error('no');
      }),
    ).toMatchObject({ refusal: 'not-allowed' });
    expect(await api.dataApiRequest('perplexity', 'ai-search', () => ({ method: 'POST', url: DATA_API_REQUESTS.perplexity[0]!.url }))).toMatchObject({ refusal: 'no-key' });
    // `no-keychain`: a key stored where a keychain worked, read where none protects it.
    const weak = dataStore({ weak: true });
    weak.memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { serper: weak.safe.blob(`frost-agent-key/2\nserper\n${SERPER_KEY}`, 'v11') } })), mode: 0o600 });
    const weakApi = createDataApiClient({ store: weak.store, isOpen: allOpen, fetch, countRequest, sleep: async () => undefined });
    expect(await weakApi.dataApiRequest('serper', 'serp', serper)).toMatchObject({ refusal: 'no-keychain' });
    // `busy`: with `maxWaitingPerProvider` waiting for their turn, one more is refused before a key is read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const busyApi = createDataApiClient({ store, isOpen: allOpen, fetch, countRequest, now: () => 1_000, sleep: () => gate });
    const first = await busyApi.dataApiRequest('serper', 'serp', serper);
    expect(first.ok).toBe(true);
    expect(events).toEqual(['count serper']);
    const waiting = Array.from({ length: 4 }, () => busyApi.dataApiRequest('serper', 'serp', serper));
    expect(await busyApi.dataApiRequest('serper', 'serp', serper)).toMatchObject({ refusal: 'busy' });
    expect(events).toEqual(['count serper']);
    release();
    await Promise.all(waiting);
    // The four that waited were sent, and counted.
    expect(events).toEqual(Array.from({ length: 5 }, () => 'count serper'));
  });

  test('data-api-stop-while-counting-never-sends-after-the-stop', async () => {
    // Council review (item 7): a Stop pressed while the usage count is being written must not be followed
    // by the paid request. Nothing is awaited between the last Stop check and the fetch, so the request
    // is either stopped before it (never sent, never counted) or sent and counted, then aborted in flight.
    const { store } = await keyed();
    const events: string[] = [];
    const stop = new AbortController();
    stop.signal.addEventListener('abort', () => events.push('stop'));
    let release!: () => void;
    const written = new Promise<void>((resolve) => (release = resolve));
    // The Stop arrives while the count is pending (the count is a disk write that takes a while).
    const countRequest = vi.fn(async (provider: DataProvider) => {
      events.push(`count ${provider}`);
      if (!stop.signal.aborted) stop.abort();
      await written;
    });
    const { fetch, calls } = recordingFetch((_url, init) => {
      events.push(init.signal?.aborted === true ? 'fetch (already stopped)' : 'fetch');
      return new Response('{"ok":true}', { status: 200 });
    });
    const api = createDataApiClient({ store, isOpen: allOpen, fetch, countRequest, sleep: async () => undefined });
    const pending = api.dataApiRequest('serpapi', 'serp', serpapi, { signal: stop.signal });
    await vi.waitFor(() => expect(countRequest).toHaveBeenCalledTimes(1));
    release();
    expect(await pending).toMatchObject({ ok: false, refusal: 'aborted' });
    // No request leaves after the Stop, and only a request that was handed to the transport is counted.
    const stoppedAt = events.indexOf('stop');
    expect(events.slice(stoppedAt).filter((event) => event.startsWith('fetch'))).toEqual([]);
    expect(countRequest).toHaveBeenCalledTimes(calls.length);
    // A Stop that fired before the request was handed over: never sent, never counted.
    const before = new AbortController();
    const unsent = createDataApiClient({ store, isOpen: allOpen, fetch, countRequest, sleep: async () => undefined, log: () => undefined });
    const counted = countRequest.mock.calls.length;
    const fetched = calls.length;
    before.abort();
    expect(await unsent.dataApiRequest('serpapi', 'serp', serpapi, { signal: before.signal })).toMatchObject({ ok: false, refusal: 'aborted' });
    expect(calls).toHaveLength(fetched);
    expect(countRequest).toHaveBeenCalledTimes(counted);
  });

  test('data-usage-count-failure-never-blocks-or-leaks', async () => {
    const { store } = await keyed();
    const { fetch, calls } = recordingFetch();
    const log = vi.fn<(line: string) => void>();
    const api = createDataApiClient({ store, isOpen: allOpen, fetch, log, sleep: async () => undefined, countRequest: async () => Promise.reject(new Error(`disk full ${SERPAPI_KEY}`)) });
    // The request is still sent (the counter is a record, not a gate) and the failure is logged without detail.
    expect(await api.dataApiRequest('serpapi', 'serp', serpapi)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(log.mock.calls.flat()).toContain('data api: serpapi usage not counted');
    expect(log.mock.calls.flat().join('\n')).not.toContain(SERPAPI_KEY);
  });
});

/** The settings repository's two members, in memory. */
function memorySetting(initial: DataSerpProvider | null = null) {
  let stored = initial;
  return {
    get stored() {
      return stored;
    },
    dataSerpProvider: vi.fn(async () => stored),
    setDataSerpProvider: vi.fn(async (provider: DataSerpProvider, _at: number) => {
      stored = provider;
      return true;
    }),
  };
}

function usageService(options: { isOpen?: (id: LegalGateId) => boolean; stored?: DataSerpProvider | null; counts?: Record<DataProvider, number[]> } = {}) {
  const setup = dataStore();
  const isOpen = options.isOpen ?? allOpen;
  const base = createDataSourcesService({ store: setup.store, isOpen });
  const settings = memorySetting(options.stored ?? null);
  const counts = vi.fn(async (months: readonly string[]) => options.counts ?? (Object.fromEntries(DATA_PROVIDERS.map((p) => [p, months.map(() => 0)])) as Record<DataProvider, number[]>));
  const now = () => Date.UTC(2027, 0, 15, 9);
  const service = createDataUsageService({ usage: { counts }, settings, status: () => base.status(), isOpen, now });
  return { ...setup, base, settings, counts, service };
}

describe('data usage view', () => {
  test('data-usage-view', async () => {
    const { service, counts } = usageService({ counts: { serpapi: [3, 41], dataforseo: [0, 2], serper: [0, 0], perplexity: [7, 0], 'openai-search': [0, 0] } });
    const view = await service.usage();
    // This UTC month and the one before (across a year boundary).
    expect(counts).toHaveBeenCalledWith(['2027-01', '2026-12']);
    expect(view).toEqual({
      thisMonth: '2027-01',
      lastMonth: '2026-12',
      providers: {
        serpapi: { thisMonth: 3, lastMonth: 41 },
        dataforseo: { thisMonth: 0, lastMonth: 2 },
        serper: { thisMonth: 0, lastMonth: 0 },
        perplexity: { thisMonth: 7, lastMonth: 0 },
        'openai-search': { thisMonth: 0, lastMonth: 0 },
      },
    });
    expect(DataUsageViewSchema.parse(view)).toEqual(view);
  });

  test('data-serp-provider-choice', async () => {
    // Open: SerpApi and DataForSEO; closed: Serper. Keys: SerpApi, Serper, DataForSEO's login only.
    const isOpen = (id: LegalGateId) => id === 'serpapi' || id === 'dataforseo';
    const { service, store, settings } = usageService({ isOpen });
    expect(await store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
    expect(await store.setKey('serper', SERPER_KEY)).toBe('stored');
    expect(await store.setKey('dataforseo-login', DFS_LOGIN)).toBe('stored');
    // Only vendors with an open gate and every slot set are offered; none stored yet, so the only
    // one offered is the answer (lead ruling, `resolveDataSerpProvider`).
    expect(await service.serpProvider()).toEqual({ provider: 'serpapi', choices: ['serpapi'] });
    // Main refuses a closed gate and a missing key; nothing is written.
    expect(await service.setSerpProvider('serper')).toBe('unavailable');
    expect(await service.setSerpProvider('dataforseo')).toBe('no-key');
    expect(settings.setDataSerpProvider).not.toHaveBeenCalled();
    expect(await service.setSerpProvider('serpapi')).toBe('stored');
    expect(settings.stored).toBe('serpapi');
    expect(await store.setKey('dataforseo-password', DFS_PASSWORD)).toBe('stored');
    expect(await service.serpProvider()).toEqual({ provider: 'serpapi', choices: ['serpapi', 'dataforseo'] });
    expect(await service.setSerpProvider('dataforseo')).toBe('stored');
    // A stored choice whose key went is not offered; with one vendor left, that one is used.
    expect(await store.clearKey('dataforseo-password')).toBe(true);
    const view = await service.serpProvider();
    expect(view).toEqual({ provider: 'serpapi', choices: ['serpapi'] });
    expect(DataSerpProviderViewSchema.parse(view)).toEqual(view);
    // A failed write is `failed`.
    settings.setDataSerpProvider.mockResolvedValueOnce(false);
    expect(await service.setSerpProvider('serpapi')).toBe('failed');
  });

  test('data-serp-provider-single-choice', async () => {
    // Lead ruling: exactly one vendor offered and none stored → that one; two offered → none until chosen.
    expect(resolveDataSerpProvider(null, ['serper'])).toBe('serper');
    expect(resolveDataSerpProvider('dataforseo', ['serper'])).toBe('serper');
    expect(resolveDataSerpProvider(null, ['serpapi', 'serper'])).toBeNull();
    expect(resolveDataSerpProvider('serper', ['serpapi', 'serper'])).toBe('serper');
    expect(resolveDataSerpProvider('serpapi', [])).toBeNull();
    const isOpen = (id: LegalGateId) => id === 'serper' || id === 'serpapi';
    const { service, store, settings } = usageService({ isOpen });
    expect(await service.serpProvider()).toEqual({ provider: null, choices: [] });
    expect(await store.setKey('serper', SERPER_KEY)).toBe('stored');
    expect(await service.serpProvider()).toEqual({ provider: 'serper', choices: ['serper'] });
    // Answered, not written: the setting stays as it was until the user picks.
    expect(settings.setDataSerpProvider).not.toHaveBeenCalled();
    expect(settings.stored).toBeNull();
    expect(await store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
    expect(await service.serpProvider()).toEqual({ provider: null, choices: ['serpapi', 'serper'] });
  });

  test('data-serp-provider-gates-ship-closed', async () => {
    // As shipped (packaged: no switch), every SERP vendor's gate is closed and main refuses the choice.
    for (const value of Object.values(SERP_API_VENDOR_AVAILABLE)) expect(value).toBe(false);
    const gates = createLegalGates({ packaged: true });
    const { service, settings } = usageService({ isOpen: (id) => gates.isOpen(id) });
    for (const provider of ['serpapi', 'dataforseo', 'serper'] as const) expect(await service.setSerpProvider(provider)).toBe('unavailable');
    expect(settings.setDataSerpProvider).not.toHaveBeenCalled();
    expect(await service.serpProvider()).toEqual({ provider: null, choices: [] });
  });
});
