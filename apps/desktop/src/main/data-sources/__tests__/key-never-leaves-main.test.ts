// Spec: specs/data-sources.spec.ts (DATA_PROVIDERS, DATA_API_REFUSALS), specs/data-sources.schema.ts
// (DataSourcesViewSchema, DataSourcesSetKeyInputSchema, DATA_SET_KEY_RESULTS), specs/ipc-sender.spec.ts
// Acceptance: specs/data-sources.feature.md (Keys: data-key-never-leaves-main) · plan docs/plans/phase-12-big-bets.md,
// Global constraints "Secrets", Threat model (an API key leaks)
import { describe, expect, test, vi } from 'vitest';
import { appRouter, createSenderPolicy, type IpcContext } from '@app/ipc-contract';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { DATA_PROVIDERS } from '@app/specs/data-sources.spec';
import { createDataApiClient } from '../api-client';
import { createDataSourcesService } from '../service';
import { ALL_SECRETS, allOpen, dataStore, DFS_LOGIN, DFS_PASSWORD, OPENAI_KEY, PERPLEXITY_KEY, recordingFetch, SERPAPI_KEY, SERPER_KEY } from './fakes';

const WINDOW_ID = 3;

type Caller = Record<string, (input?: unknown) => Promise<unknown>>;

describe('data keys never leave main', () => {
  test('data-key-never-leaves-main', async () => {
    const { store, log: storeLog, memory } = dataStore();
    const service = createDataSourcesService({ store, isOpen: allOpen });
    const ctx: IpcContext = {
      sender: { origin: APP_ORIGIN, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
      policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
      services: { dataSources: service },
    };
    const ipc = (appRouter.createCaller(ctx) as unknown as { dataSources: Caller }).dataSources;
    const answers: unknown[] = [];
    const errors: unknown[] = [];
    const call = async (name: string, input?: unknown) => {
      try {
        answers.push(await ipc[name]!(input));
      } catch (error) {
        errors.push(error);
      }
    };

    // Set every key over IPC (the only way a key crosses it: renderer → main).
    await call('setKey', { provider: 'serpapi', key: SERPAPI_KEY });
    await call('setKey', { provider: 'serper', key: ` ${SERPER_KEY} ` });
    await call('setKey', { provider: 'perplexity', key: PERPLEXITY_KEY });
    await call('setKey', { provider: 'openai-search', key: OPENAI_KEY });
    await call('setKey', { provider: 'dataforseo', login: DFS_LOGIN, password: DFS_PASSWORD });
    await call('status');
    // Refused inputs: their errors never quote the key.
    await call('setKey', { provider: 'serpapi', key: `${SERPAPI_KEY}\nsecond-line` });
    await call('setKey', { provider: 'serpapi', key: SERPAPI_KEY, extra: SERPAPI_KEY });
    await call('setKey', { provider: 'dataforseo', key: DFS_PASSWORD });
    await call('setKey', { provider: 'nope', key: SERPAPI_KEY });
    await call('setKey', { provider: 'serpapi', key: `${SERPAPI_KEY}${'x'.repeat(4096)}` });
    await call('clearKey', { provider: 'serper' });
    await call('status');

    expect(answers.slice(0, 5)).toEqual(['stored', 'stored', 'stored', 'stored', 'stored']);
    const view = answers[5] as { providers: Record<string, { hasKey: boolean }> };
    for (const provider of DATA_PROVIDERS) expect(view.providers[provider]!.hasKey, provider).toBe(true);
    expect(Object.keys(view).sort()).toEqual(['protection', 'providers']);
    expect(errors).toHaveLength(5);
    expect((answers.at(-1) as typeof view).providers.serper!.hasKey).toBe(false);

    // Requests: success, refusals and a throwing build.
    const clientLog = vi.fn<(line: string) => void>();
    const { fetch } = recordingFetch((url, init) => (url.includes('serpapi') ? new Response(`{"echo":"${init.method}"}`, { status: 200 }) : new Response(`{"error":"bad key ${OPENAI_KEY}"}`, { status: 401 })));
    const client = createDataApiClient({ store, isOpen: allOpen, fetch, log: clientLog, sleep: async () => undefined });
    answers.push(
      await client.dataApiRequest('serpapi', 'serp', (s) => ({ method: 'GET', url: `https://serpapi.com/search.json?${new URLSearchParams({ q: 'frost', api_key: s.serpapi! }).toString()}` })),
      await client.dataApiRequest('openai-search', 'ai-search', (s) => ({ method: 'POST', url: 'https://api.openai.com/v1/responses', headers: { authorization: `Bearer ${s['openai-search']}` }, body: '{}' })),
      await client.dataApiRequest('perplexity', 'ai-search', (s) => ({ method: 'POST', url: `https://api.perplexity.ai/v1/sonar?k=${s.perplexity}` })),
      await client.dataApiRequest('dataforseo', 'serp', (s) => {
        throw new Error(`boom ${s['dataforseo-password']}`);
      }),
      await client.dataApiRequest('serper', 'serp', () => ({ method: 'POST', url: 'https://google.serper.dev/search' })),
    );

    const everything = JSON.stringify({
      answers,
      errors: errors.map((error) => ({ message: (error as Error).message, cause: String((error as { cause?: unknown }).cause ?? ''), json: JSON.stringify(error) })),
      logs: [...storeLog.mock.calls, ...clientLog.mock.calls],
    });
    for (const secret of ALL_SECRETS) expect(everything, secret).not.toContain(secret);
    expect(everything).not.toContain(Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64'));
    // Nor is the file plaintext.
    for (const secret of ALL_SECRETS) expect(memory.text('/user-data/data-credentials.json') ?? '', secret).not.toContain(secret);
  });

  test('data-sources-service-has-no-way-to-read-a-key', () => {
    const { store } = dataStore();
    const service = createDataSourcesService({ store, isOpen: allOpen });
    expect(Object.keys(service).sort()).toEqual(['clearKey', 'setKey', 'status']);
  });
});
