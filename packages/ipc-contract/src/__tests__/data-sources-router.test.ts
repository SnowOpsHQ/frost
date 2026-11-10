// Spec: specs/data-sources.schema.ts (DataSourcesViewSchema, DataSourcesSetKeyInputSchema, DataSourcesClearKeyInputSchema,
// DATA_SET_KEY_RESULTS; Task 2: DataUsageViewSchema, DataSerpProviderViewSchema, DataSourcesSetSerpProviderInputSchema,
// DATA_SET_SERP_PROVIDER_RESULTS), specs/data-sources.spec.ts (DATA_PROVIDERS, DATA_SECRET_MAX_CHARS), specs/ipc-sender.spec.ts,
// specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/data-sources.feature.md (Keys; Usage counter: data-usage-view; settings-data-sources-serp-choice)
// · plan docs/plans/phase-12-big-bets.md, Task 1 (IPC), Task 2 (`usage`, the SERP vendor)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { DATA_PROVIDERS, DATA_SECRET_MAX_CHARS } from '@app/specs/data-sources.spec';
import type { DataSerpProviderView, DataSetKeyResult, DataSetSerpProviderResult, DataSourcesSetKeyInput, DataSourcesView, DataUsageView } from '@app/specs/data-sources.schema';
import { appRouter, createSenderPolicy, type DataSourcesService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const KEY = 'serpapi-0123456789abcdefSECRET';

const VIEW: DataSourcesView = {
  protection: 'os',
  providers: {
    serpapi: { hasKey: true, partial: false, available: false },
    dataforseo: { hasKey: false, partial: false, available: false },
    serper: { hasKey: false, partial: false, available: false },
    perplexity: { hasKey: false, partial: false, available: false },
    'openai-search': { hasKey: false, partial: false, available: false },
  },
};

const USAGE: DataUsageView = {
  thisMonth: '2026-11',
  lastMonth: '2026-10',
  providers: {
    serpapi: { thisMonth: 3, lastMonth: 12 },
    dataforseo: { thisMonth: 0, lastMonth: 0 },
    serper: { thisMonth: 0, lastMonth: 1 },
    perplexity: { thisMonth: 0, lastMonth: 0 },
    'openai-search': { thisMonth: 0, lastMonth: 0 },
  },
};
const SERP: DataSerpProviderView = { provider: 'serpapi', choices: ['serpapi'] };

function fakeService(overrides: Partial<DataSourcesService> = {}) {
  return {
    status: vi.fn(async (): Promise<DataSourcesView> => VIEW),
    setKey: vi.fn(async (_input: DataSourcesSetKeyInput): Promise<DataSetKeyResult> => 'stored'),
    clearKey: vi.fn(async (_provider: (typeof DATA_PROVIDERS)[number]) => true),
    usage: vi.fn(async (): Promise<DataUsageView> => USAGE),
    serpProvider: vi.fn(async (): Promise<DataSerpProviderView> => SERP),
    setSerpProvider: vi.fn(async (_provider: 'serpapi' | 'dataforseo' | 'serper'): Promise<DataSetSerpProviderResult> => 'stored'),
    ...overrides,
  } satisfies DataSourcesService;
}

function ctxFor(service: DataSourcesService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service === undefined ? {} : { dataSources: service },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { dataSources: Record<string, (input?: unknown) => Promise<unknown>> }).dataSources;
  return caller[name]!(input);
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const PROCEDURES: Record<string, unknown> = {
  status: undefined,
  setKey: { provider: 'serpapi', key: KEY },
  clearKey: { provider: 'serpapi' },
  usage: undefined,
  serpProvider: undefined,
  setSerpProvider: { provider: 'serpapi' },
};

describe('dataSources router', () => {
  test('data-sources-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('dataSources.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `dataSources.${n}`).sort());
    const service = fakeService();
    for (const [name, input] of Object.entries(PROCEDURES)) {
      expect((await errorOf(call(ctxFor(service, 'https://evil.example'), name, input))).code, name).toBe(IPC_SENDER_ERROR_CODE);
      // Fails closed without the service.
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    expect(service.setKey).not.toHaveBeenCalled();
    expect(service.clearKey).not.toHaveBeenCalled();
    expect(service.setSerpProvider).not.toHaveBeenCalled();
  });

  test('data-sources-inputs-bounded', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    expect(await call(ctx, 'setKey', { provider: 'serpapi', key: KEY })).toBe('stored');
    expect(await call(ctx, 'setKey', { provider: 'dataforseo', login: 'owner@frost.example' })).toBe('stored');
    expect(await call(ctx, 'setKey', { provider: 'dataforseo', password: KEY })).toBe('stored');
    expect(await call(ctx, 'clearKey', { provider: 'dataforseo' })).toBe(true);
    for (const input of [
      { provider: 'serpapi', key: `${KEY}\nsecond` },
      { provider: 'serpapi', key: `${KEY}\r` },
      { provider: 'serpapi', key: `${KEY}\u2028` },
      { provider: 'serpapi', key: 'x'.repeat(DATA_SECRET_MAX_CHARS * 2 + 1) },
      { provider: 'serpapi', key: '' },
      { provider: 'serpapi' },
      { provider: 'serpapi', key: KEY, extra: 1 },
      { provider: 'dataforseo' },
      { provider: 'dataforseo', key: KEY },
      { provider: 'dataforseo', login: 'a\nb' },
      { provider: 'nope', key: KEY },
      { provider: 'serpapi', key: 42 },
    ]) {
      const error = await errorOf(call(ctx, 'setKey', input));
      expect(error.code, JSON.stringify(input).slice(0, 60)).toBe('BAD_REQUEST');
    }
    for (const input of [{ provider: 'nope' }, {}, { provider: 'serpapi', extra: 1 }]) expect((await errorOf(call(ctx, 'clearKey', input))).code).toBe('BAD_REQUEST');
    expect(service.setKey).toHaveBeenCalledTimes(3);
  });

  test('data-sources-answers-are-checked', async () => {
    // A view carrying anything more (a key) is never forwarded; a result outside the set is `failed`.
    const leaky = fakeService({
      status: vi.fn(async () => ({ ...VIEW, providers: { ...VIEW.providers, serpapi: { hasKey: true, partial: false, available: true, key: KEY } } }) as unknown as DataSourcesView),
      setKey: vi.fn(async () => KEY as unknown as DataSetKeyResult),
      clearKey: vi.fn(async () => KEY as unknown as boolean),
    });
    const ctx = ctxFor(leaky);
    const error = await errorOf(call(ctx, 'status'));
    expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
    // The refused answer's key is in no part of the error.
    expect(`${error.message} ${String(error.cause ?? '')} ${JSON.stringify(error)} ${error.stack ?? ''}`).not.toContain(KEY);
    expect(await call(ctx, 'setKey', { provider: 'serpapi', key: KEY })).toBe('failed');
    expect(await call(ctx, 'clearKey', { provider: 'serpapi' })).toBe(false);
    expect(await call(ctxFor(fakeService()), 'status')).toEqual(VIEW);
    expect(await call(ctxFor(fakeService({ setKey: vi.fn(async () => 'unavailable' as const) })), 'setKey', { provider: 'serpapi', key: KEY })).toBe('unavailable');
  });

  test('data-sources-usage-and-serp-provider', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    expect(await call(ctx, 'usage')).toEqual(USAGE);
    expect(await call(ctx, 'serpProvider')).toEqual(SERP);
    expect(await call(ctx, 'setSerpProvider', { provider: 'dataforseo' })).toBe('stored');
    expect(service.setSerpProvider).toHaveBeenCalledWith('dataforseo');
    // Only a SERP vendor, nothing else.
    for (const input of [{ provider: 'perplexity' }, { provider: 'openai-search' }, { provider: 'nope' }, {}, { provider: 'serpapi', extra: 1 }, { provider: null }]) {
      expect((await errorOf(call(ctx, 'setSerpProvider', input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
    }
    expect(service.setSerpProvider).toHaveBeenCalledTimes(1);
    // Answers are checked: a malformed view is refused, an unknown result is `failed`.
    const odd = ctxFor(
      fakeService({
        usage: vi.fn(async () => ({ ...USAGE, providers: { ...USAGE.providers, serpapi: { thisMonth: -1, lastMonth: 0 } } })),
        serpProvider: vi.fn(async () => ({ provider: 'perplexity', choices: [] }) as unknown as DataSerpProviderView),
        setSerpProvider: vi.fn(async () => KEY as unknown as DataSetSerpProviderResult),
      }),
    );
    expect((await errorOf(call(odd, 'usage'))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    expect((await errorOf(call(odd, 'serpProvider'))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    expect(await call(odd, 'setSerpProvider', { provider: 'serpapi' })).toBe('failed');
    expect(await call(ctxFor(fakeService({ setSerpProvider: vi.fn(async () => 'unavailable' as const) })), 'setSerpProvider', { provider: 'serper' })).toBe('unavailable');
  });
});
