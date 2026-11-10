// Spec: specs/data-sources.spec.ts (DATA_API_PARTITION, DATA_CREDENTIALS_FILE, DATA_API_E2E_SWITCH,
// LEGAL_GATES_E2E_SWITCH, LEGAL_GATE_IDS), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/data-sources.feature.md (data-api-e2e-seam-only-unpackaged, legal-gates-open-only-by-switch-unpackaged;
// Task 2: data-usage-counts-every-request, wired; Task 4: Check via API, wired)
// · plan docs/plans/phase-12-big-bets.md, Decision 4 (in-memory `frost-data-api`), Task 1 (`index.ts`: setup, e2e seam)
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { DATA_API_E2E_SWITCH, DATA_API_PARTITION, DATA_CREDENTIALS_FILE, LEGAL_GATE_IDS, LEGAL_GATES_E2E_SWITCH } from '@app/specs/data-sources.spec';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import { setupDataSources } from '../index';
import { SERPAPI_KEY } from './fakes';

const USER_DATA = '/user-data';
const SEAM_BASE = 'http://127.0.0.1:41234';
const NOW = Date.UTC(2026, 10, 10, 12);

/** `setupDataSources` with a fake `electron` (the agent's `key-never-leaves-main` pattern). */
function setup(packaged: boolean, extra: { checks?: Parameters<typeof setupDataSources>[0]['checks'] } = {}) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage();
  const partitions: string[] = [];
  const fetched: { url: string; init: RequestInit }[] = [];
  const logLines: string[] = [];
  const readSeamFile = vi.fn(() => JSON.stringify({ serpapi: SEAM_BASE }));
  // Task 2: the session store's usage counter and SERP vendor setting, as fakes.
  const usage = { increment: vi.fn(async (_provider: string, _at: number) => true), counts: vi.fn(async (months: readonly string[]) => Object.fromEntries(['serpapi', 'dataforseo', 'serper', 'perplexity', 'openai-search'].map((p) => [p, months.map(() => 0)])) as never) };
  const settings = { dataSerpProvider: vi.fn(async () => null), setDataSerpProvider: vi.fn(async () => true) };
  const switches: Record<string, string> = { [LEGAL_GATES_E2E_SWITCH]: LEGAL_GATE_IDS.join(','), [DATA_API_E2E_SWITCH]: '/tmp/frost-data-seam.json' };
  const main = setupDataSources({
    app: { isPackaged: packaged, getPath: () => USER_DATA, commandLine: { getSwitchValue: (name) => switches[name] ?? '' } },
    session: {
      fromPartition: (partition) => {
        partitions.push(partition);
        return {
          fetch: async (url, init) => {
            fetched.push({ url, init });
            return new Response('{}', { status: 200 });
          },
        };
      },
    },
    safeStorage: safe.storage,
    fs: memory.fs,
    platform: 'linux',
    readSeamFile,
    log: (line) => void logLines.push(line),
    usage,
    settings,
    now: () => NOW,
    ...extra,
  });
  return { main, memory, partitions, fetched, logLines, readSeamFile, usage, settings };
}

describe('data sources setup', () => {
  test('data-sources-setup-packaged-ignores-both-seams', async () => {
    const { main, memory, partitions, fetched, readSeamFile, usage } = setup(true);
    // Every gate keeps its shipped value (closed), and the seam file is never read.
    for (const id of LEGAL_GATE_IDS) expect(main.gates.isOpen(id), id).toBe(false);
    expect(readSeamFile).not.toHaveBeenCalled();
    const view = await main.service.status();
    for (const row of Object.values(view.providers)) expect(row.available).toBe(false);
    expect(await main.service.setKey({ provider: 'serpapi', key: SERPAPI_KEY })).toBe('unavailable');
    expect(memory.files.size).toBe(0);
    expect(await main.client.dataApiRequest('serpapi', 'serp', () => ({ method: 'GET', url: 'https://serpapi.com/search.json' }))).toMatchObject({ ok: false, refusal: 'unavailable' });
    expect(partitions).toEqual([]);
    expect(fetched).toEqual([]);
    // A refused request is never counted; the SERP vendor choice is refused too.
    expect(usage.increment).not.toHaveBeenCalled();
    expect(await main.service.setSerpProvider('serpapi')).toBe('unavailable');
  });

  test('data-sources-setup-uses-the-in-memory-partition', async () => {
    const { main, memory, partitions, fetched, readSeamFile, logLines, usage, settings } = setup(false);
    // Unpackaged: the switch opens the listed gates and the seam file is read once.
    for (const id of LEGAL_GATE_IDS) expect(main.gates.isOpen(id), id).toBe(true);
    expect(readSeamFile).toHaveBeenCalledTimes(1);
    expect(await main.service.setKey({ provider: 'serpapi', key: SERPAPI_KEY })).toBe('stored');
    expect([...memory.files.keys()]).toEqual([path.join(USER_DATA, DATA_CREDENTIALS_FILE)]);
    const outcome = await main.client.dataApiRequest('serpapi', 'serp', (s) => ({ method: 'GET', url: `https://serpapi.com/search.json?${new URLSearchParams({ q: 'frost', api_key: s.serpapi! }).toString()}` }));
    expect(outcome).toMatchObject({ ok: true, url: 'https://serpapi.com/search.json?q=frost' });
    // Exactly the in-memory `frost-data-api` session (no `persist:`), and the seam's loopback base.
    expect(partitions).toEqual([DATA_API_PARTITION]);
    expect(DATA_API_PARTITION).toBe('frost-data-api');
    expect(partitions.every((partition) => !partition.startsWith('persist:'))).toBe(true);
    expect(fetched.map((call) => call.url)).toEqual([`${SEAM_BASE}/search.json?q=frost&api_key=${SERPAPI_KEY}`]);
    expect(fetched[0]!.init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    // The request was counted once, for its provider, at main's time (Task 2).
    expect(usage.increment.mock.calls).toEqual([['serpapi', NOW]]);
    expect(await main.service.usage()).toMatchObject({ thisMonth: '2026-11', lastMonth: '2026-10' });
    expect(usage.counts).toHaveBeenCalledWith(['2026-11', '2026-10']);
    expect(await main.service.setSerpProvider('serpapi')).toBe('stored');
    expect(settings.setDataSerpProvider).toHaveBeenCalledWith('serpapi', NOW);
    // The data store logs as itself, never the key.
    expect(logLines.join('\n')).not.toContain(SERPAPI_KEY);
  });

  test('data-credentials-log-prefix', async () => {
    const { main, memory, logLines } = setup(false);
    memory.fs.readFile = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect((await main.service.status()).providers.serpapi.hasKey).toBe(false);
    expect(logLines).toContain('data credentials: the key file could not be read');
    expect(logLines.some((line) => line.startsWith('agent credentials:'))).toBe(false);
  });

  test('data-sources-setup-wires-check-via-api', async () => {
    const PROJECT = '01920000-0000-7000-8000-0000000000a1';
    const store = { project: vi.fn(async () => null), projectQueries: vi.fn(async () => []), appendApiReading: vi.fn(async () => false) };
    const checks = { store, parse: vi.fn(), afterWrite: vi.fn() };
    // Packaged (every gate closed as shipped): refused before anything is read.
    const shipped = setup(true, { checks });
    expect(await shipped.main.service.checkPlan({ projectId: PROJECT })).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(await shipped.main.service.checkProjectSearches({ projectId: PROJECT, provider: 'serpapi', requests: 1 })).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(store.project).not.toHaveBeenCalled();
    // Gates open (unpackaged switch), no key yet: main's own vendor view says so (Task 2's `serpProvider`).
    const open = setup(false, { checks });
    expect(await open.main.service.checkPlan({ projectId: PROJECT })).toEqual({ status: 'refused', reason: 'no-key' });
    expect(await open.main.service.setKey({ provider: 'serpapi', key: SERPAPI_KEY })).toBe('stored');
    expect(await open.main.service.checkPlan({ projectId: PROJECT })).toEqual({ status: 'refused', reason: 'not-found' });
    expect(store.project).toHaveBeenCalledWith(PROJECT);
    expect(open.fetched).toEqual([]);
    // Without the change store wired, both refuse and send nothing.
    const bare = setup(false);
    expect(await bare.main.service.checkPlan({ projectId: PROJECT })).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(await bare.main.service.checkProjectSearches({ projectId: PROJECT, provider: 'serpapi', requests: 1 })).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(checks.parse).not.toHaveBeenCalled();
  });
});
