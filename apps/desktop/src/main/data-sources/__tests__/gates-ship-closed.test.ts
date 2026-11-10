// Spec: specs/data-sources.spec.ts (SERP_API_VENDOR_AVAILABLE, AI_SEARCH_PROVIDER_AVAILABLE, LEGAL_GATE_IDS,
// LEGAL_GATE_NOTE, DATA_API_REFUSAL_MESSAGES), specs/data-sources.schema.ts (DataSourcesView.available)
// Acceptance: specs/data-sources.feature.md (Legal gates: data-gates-ship-closed) · plan
// docs/plans/phase-12-big-bets.md, Decision 2 (L4, L5), As built (legal gates: main is the authority)
import { describe, expect, test, vi } from 'vitest';
import {
  AI_SEARCH_PROVIDER_AVAILABLE,
  DATA_API_REFUSAL_MESSAGES,
  DATA_API_REQUESTS,
  DATA_PROVIDERS,
  LEGAL_GATE_NOTE,
  SERP_API_VENDOR_AVAILABLE,
} from '@app/specs/data-sources.spec';
import { createDataApiClient } from '../api-client';
import { createLegalGates, SHIPPED_LEGAL_GATES } from '../gates';
import { createDataSourcesService } from '../service';
import { dataStore, DFS_LOGIN, DFS_PASSWORD, recordingFetch, SERPAPI_KEY } from './fakes';

describe('legal gates ship closed', () => {
  test('data-gates-ship-closed', async () => {
    // The shipped constants: every vendor and provider off (L4, L5), and the crawl placeholder off (L6, Task 5).
    expect(SERP_API_VENDOR_AVAILABLE).toEqual({ serpapi: false, dataforseo: false, serper: false });
    expect(AI_SEARCH_PROVIDER_AVAILABLE).toEqual({ perplexity: false, 'openai-search': false });
    expect(Object.values(SHIPPED_LEGAL_GATES).every((open) => open === false)).toBe(true);
    expect(DATA_API_REFUSAL_MESSAGES.unavailable).toBe(LEGAL_GATE_NOTE);

    const gates = createLegalGates({ packaged: true });
    expect(gates.isOpen('crawl')).toBe(false);
    const { store, memory } = dataStore();
    const service = createDataSourcesService({ store, isOpen: (id) => gates.isOpen(id) });

    // Setting a key for any gated provider: `unavailable`, nothing stored.
    for (const provider of DATA_PROVIDERS) {
      const input = provider === 'dataforseo' ? { provider, login: DFS_LOGIN, password: DFS_PASSWORD } : { provider, key: SERPAPI_KEY };
      expect(await service.setKey(input), provider).toBe('unavailable');
    }
    expect(memory.files.size).toBe(0);

    // The view says so; clearing is never gated.
    const view = await service.status();
    for (const provider of DATA_PROVIDERS) expect(view.providers[provider], provider).toEqual({ hasKey: false, available: false });
    expect(await store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
    expect(await service.clearKey('serpapi')).toBe(true);
    expect(await store.hasKey('serpapi')).toBe(false);

    // Every request: `unavailable`, before reading a key or sending anything.
    expect(await store.setKey('serpapi', SERPAPI_KEY)).toBe('stored');
    const withKey = vi.spyOn(store, 'withKey');
    const build = vi.fn();
    const { fetch, calls } = recordingFetch();
    const client = createDataApiClient({ store, isOpen: (id) => gates.isOpen(id), fetch, sleep: async () => undefined });
    for (const provider of DATA_PROVIDERS) {
      const target = DATA_API_REQUESTS[provider][0]!;
      const outcome = await client.dataApiRequest(provider, target.purpose, (secrets) => {
        build(secrets);
        return { method: target.method, url: target.url };
      });
      expect(outcome, provider).toEqual({ ok: false, refusal: 'unavailable', message: LEGAL_GATE_NOTE });
    }
    expect(withKey).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
