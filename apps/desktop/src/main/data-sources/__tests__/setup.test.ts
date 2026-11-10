// Spec: specs/data-sources.spec.ts (DATA_API_PARTITION, DATA_CREDENTIALS_FILE, DATA_API_E2E_SWITCH,
// LEGAL_GATES_E2E_SWITCH, LEGAL_GATE_IDS), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/data-sources.feature.md (data-api-e2e-seam-only-unpackaged, legal-gates-open-only-by-switch-unpackaged)
// · plan docs/plans/phase-12-big-bets.md, Decision 4 (in-memory `frost-data-api`), Task 1 (`index.ts`: setup, e2e seam)
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { DATA_API_E2E_SWITCH, DATA_API_PARTITION, DATA_CREDENTIALS_FILE, LEGAL_GATE_IDS, LEGAL_GATES_E2E_SWITCH } from '@app/specs/data-sources.spec';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import { setupDataSources } from '../index';
import { SERPAPI_KEY } from './fakes';

const USER_DATA = '/user-data';
const SEAM_BASE = 'http://127.0.0.1:41234';

/** `setupDataSources` with a fake `electron` (the agent's `key-never-leaves-main` pattern). */
function setup(packaged: boolean) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage();
  const partitions: string[] = [];
  const fetched: { url: string; init: RequestInit }[] = [];
  const logLines: string[] = [];
  const readSeamFile = vi.fn(() => JSON.stringify({ serpapi: SEAM_BASE }));
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
  });
  return { main, memory, partitions, fetched, logLines, readSeamFile };
}

describe('data sources setup', () => {
  test('data-sources-setup-packaged-ignores-both-seams', async () => {
    const { main, memory, partitions, fetched, readSeamFile } = setup(true);
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
  });

  test('data-sources-setup-uses-the-in-memory-partition', async () => {
    const { main, memory, partitions, fetched, readSeamFile, logLines } = setup(false);
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
});
