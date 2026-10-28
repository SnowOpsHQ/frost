// Spec: specs/gsc.schema.ts (GscStatusSchema, GscWatchInputSchema, GscPerformanceQuerySchema, GscConnectResultSchema,
// GscPerformanceAnswerSchema, GscQueriesAnswerSchema, GscPropertiesAnswerSchema, GSC_CONNECT_RESULTS),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE), specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/gsc.feature.md (Router) · review focus "The renderer never sees a token"
// · plan Global Constraint "Tokens stay in main"
import { getTRPCErrorShape, TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import {
  GSC_CONNECT_RESULTS,
  type GscConnectResult,
  type GscPerformanceAnswer,
  type GscPerformanceQuery,
  type GscPropertiesAnswer,
  type GscPropertyForAnswer,
  type GscQueriesAnswer,
  type GscStatus,
} from '@app/specs/gsc.schema';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type GscIpcService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const FAKE_ACCESS = 'ya29.fake-access-token-0123456789';
const FAKE_REFRESH = '1//fake-refresh-token-0123456789';
const FAKE_CODE = '4/fake-code-0123456789abcdef';
const FAKE_VERIFIER = 'fake-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const FAKE_STATE = 'fake-state-0123456789abcdef';
const FAKE_SECRET = 'test-client-secret';
const SECRETS = [FAKE_ACCESS, FAKE_REFRESH, FAKE_CODE, FAKE_VERIFIER, FAKE_STATE, FAKE_SECRET];

const PROPERTY = { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' } as const;
const RANGE = { start: '2026-09-29', end: '2026-10-26' };
const QUERY: GscPerformanceQuery = { url: 'https://www.example.com/a', scope: 'page', days: 28 };
const PERFORMANCE: GscPerformanceAnswer = {
  status: 'ok',
  property: PROPERTY,
  scope: 'page',
  range: RANGE,
  rows: [{ date: '2026-10-01', clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }],
  totals: { clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 },
};
const QUERIES: GscQueriesAnswer = { status: 'ok', property: PROPERTY, scope: 'page', range: RANGE, rows: [{ query: 'frost', clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }] };

const gscStatus = (version: number, overrides: Partial<GscStatus> = {}): GscStatus => ({
  configured: true,
  entitled: true,
  connected: true,
  connecting: false,
  keychain: 'persistent',
  error: null,
  version,
  ...overrides,
});

function fakeGsc() {
  let release: ((s: GscStatus) => void) | null = null;
  const gsc = {
    status: vi.fn(() => gscStatus(3)),
    watch: vi.fn((since: number, signal?: AbortSignal) =>
      since < 3
        ? Promise.resolve(gscStatus(3))
        : new Promise<GscStatus>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(gscStatus(3)));
          }),
    ),
    connect: vi.fn(async (_windowId: number): Promise<GscConnectResult> => 'started'),
    cancelConnect: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
    properties: vi.fn(async (): Promise<GscPropertiesAnswer> => ({ status: 'ok', properties: [PROPERTY] })),
    propertyFor: vi.fn(async (_url: string): Promise<GscPropertyForAnswer> => ({ status: 'ok', property: PROPERTY })),
    performance: vi.fn(async (_query: GscPerformanceQuery): Promise<GscPerformanceAnswer> => PERFORMANCE),
    topQueries: vi.fn(async (_query: GscPerformanceQuery): Promise<GscQueriesAnswer> => QUERIES),
  } satisfies GscIpcService;
  return Object.assign(gsc, { push: (s: GscStatus) => release?.(s) });
}

/** Every gsc procedure, its type and a valid input. */
const GSC_PROCEDURES: Record<string, { type: 'query' | 'mutation'; input?: unknown }> = {
  status: { type: 'query' },
  watch: { type: 'query', input: { sinceVersion: -1 } },
  connect: { type: 'mutation' },
  cancelConnect: { type: 'mutation' },
  disconnect: { type: 'mutation' },
  properties: { type: 'query' },
  performance: { type: 'query', input: QUERY },
  topQueries: { type: 'query', input: QUERY },
};

function ctxFor(gsc: GscIpcService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: gsc === undefined ? {} : { gsc },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { gsc: Record<string, (input?: unknown) => Promise<unknown>> }).gsc;
  const fn = caller[name];
  if (!fn) throw new Error(`no gsc.${name}`);
  return fn(input);
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const shapeOf = (error: TRPCError, path: string) => getTRPCErrorShape({ config: appRouter._def._config, error, type: 'query', path, input: undefined, ctx: undefined });

afterEach(() => vi.useRealTimers());

describe('gsc router', () => {
  test('gsc-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('gsc.'));
    expect(paths.sort()).toEqual(Object.keys(GSC_PROCEDURES).map((n) => `gsc.${n}`).sort());
    for (const [name, { input }] of Object.entries(GSC_PROCEDURES)) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const gsc = fakeGsc();
        expect((await errorOf(call(ctxFor(gsc, origin), name, input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        for (const fn of Object.values(gsc)) if (vi.isMockFunction(fn)) expect(fn, name).not.toHaveBeenCalled();
      }
    }
    for (const [name, { type }] of Object.entries(GSC_PROCEDURES)) {
      expect((appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)[`gsc.${name}`]?._def.type, name).toBe(type);
    }
  });

  test('connect-passes-window-id', async () => {
    for (const result of GSC_CONNECT_RESULTS) {
      const gsc = fakeGsc();
      gsc.connect.mockResolvedValueOnce(result);
      await expect(call(ctxFor(gsc), 'connect')).resolves.toBe(result);
      expect(gsc.connect).toHaveBeenCalledExactlyOnceWith(WINDOW_ID);
    }
    const gsc = fakeGsc();
    await expect(call(ctxFor(gsc), 'cancelConnect')).resolves.toBe(true);
    await expect(call(ctxFor(gsc), 'disconnect')).resolves.toBe(true);
    await expect(call(ctxFor(gsc), 'properties')).resolves.toEqual({ status: 'ok', properties: [PROPERTY] });
    await expect(call(ctxFor(gsc), 'performance', QUERY)).resolves.toEqual(PERFORMANCE);
    expect(gsc.performance).toHaveBeenCalledExactlyOnceWith(QUERY);
    await expect(call(ctxFor(gsc), 'topQueries', { ...QUERY, scope: 'property', days: 90 })).resolves.toEqual(QUERIES);
    expect(gsc.topQueries).toHaveBeenCalledExactlyOnceWith({ ...QUERY, scope: 'property', days: 90 });
    gsc.performance.mockResolvedValueOnce({ status: 'unavailable', reason: 'not-entitled' });
    await expect(call(ctxFor(gsc), 'performance', QUERY)).resolves.toEqual({ status: 'unavailable', reason: 'not-entitled' });
  });

  test('gsc-inputs-validated', async () => {
    for (const [name, input] of [
      ['watch', { sinceVersion: -2 }],
      ['watch', { sinceVersion: 1, token: FAKE_ACCESS }],
      ['performance', { ...QUERY, days: 30 }],
      ['performance', { ...QUERY, url: 'file:///etc/passwd' }],
      ['performance', { ...QUERY, scope: 'site' }],
      ['topQueries', { ...QUERY, extra: 1 }],
      ['topQueries', undefined],
    ] as const) {
      const gsc = fakeGsc();
      expect((await errorOf(call(ctxFor(gsc), name, input))).code, name).toBe('BAD_REQUEST');
      for (const fn of [gsc.watch, gsc.performance, gsc.topQueries]) expect(fn).not.toHaveBeenCalled();
    }
  });

  test('gsc-outputs-are-strict', async () => {
    const bad: [string, (g: ReturnType<typeof fakeGsc>) => void][] = [
      ['status', (g) => g.status.mockReturnValue({ ...gscStatus(3), accessToken: FAKE_ACCESS } as GscStatus)],
      ['status', (g) => g.status.mockReturnValue({ ...gscStatus(3), connecting: true })],
      ['watch', (g) => g.watch.mockResolvedValue({ ...gscStatus(3), email: 'dana@example.com' } as GscStatus)],
      ['connect', (g) => g.connect.mockResolvedValue('opened' as GscConnectResult)],
      ['cancelConnect', (g) => g.cancelConnect.mockResolvedValue(FAKE_STATE as unknown as boolean)],
      ['disconnect', (g) => g.disconnect.mockResolvedValue({ refreshToken: FAKE_REFRESH } as unknown as boolean)],
      ['properties', (g) => g.properties.mockResolvedValue({ status: 'ok', properties: [{ ...PROPERTY, token: FAKE_ACCESS } as typeof PROPERTY] } as GscPropertiesAnswer)],
      ['performance', (g) => g.performance.mockResolvedValue({ ...PERFORMANCE, accessToken: FAKE_ACCESS } as GscPerformanceAnswer)],
      ['performance', (g) => g.performance.mockResolvedValue({ status: 'unavailable', reason: 'busy' } as unknown as GscPerformanceAnswer)],
      ['topQueries', (g) => g.topQueries.mockResolvedValue({ ...QUERIES, refreshToken: FAKE_REFRESH } as GscQueriesAnswer)],
    ];
    for (const [name, breakIt] of bad) {
      const gsc = fakeGsc();
      breakIt(gsc);
      const error = await errorOf(call(ctxFor(gsc), name, GSC_PROCEDURES[name]?.input));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
      const shape = shapeOf(error, `gsc.${name}`);
      for (const secret of SECRETS) expect(JSON.stringify(shape)).not.toContain(secret);
      expect(shape.message).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });

  test('gsc-watch-long-polls', async () => {
    const gsc = fakeGsc();
    await expect(call(ctxFor(gsc), 'status')).resolves.toEqual(gscStatus(3));
    await expect(call(ctxFor(gsc), 'watch', { sinceVersion: 1 })).resolves.toEqual(gscStatus(3));
    const next = call(ctxFor(gsc), 'watch', { sinceVersion: 3 });
    await vi.waitFor(() => expect(gsc.watch).toHaveBeenCalledTimes(2));
    gsc.push(gscStatus(4, { connected: false }));
    await expect(next).resolves.toMatchObject({ version: 4, connected: false });
    vi.useFakeTimers();
    const idle = call(ctxFor(gsc), 'watch', { sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(idle).resolves.toEqual(gscStatus(3));
    expect(gsc.watch.mock.calls.at(-1)?.[1]?.aborted).toBe(true);
  });

  test('gsc-without-service-fail-closed', async () => {
    for (const [name, { input }] of Object.entries(GSC_PROCEDURES)) {
      const error = await errorOf(call(ctxFor(undefined), name, input));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
      expect(shapeOf(error, `gsc.${name}`).message).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });

  test('answers-carry-no-secret', async () => {
    const statuses = [gscStatus(1, { connected: false, connecting: true }), gscStatus(2), gscStatus(3, { connected: false, error: 'scope-refused' })];
    for (const status of statuses) {
      const gsc = fakeGsc();
      gsc.status.mockReturnValue(status);
      gsc.watch.mockResolvedValue(status);
      for (const [name, { input }] of Object.entries(GSC_PROCEDURES)) {
        const text = JSON.stringify(await call(ctxFor(gsc), name, input));
        for (const secret of SECRETS) expect(text, `${name} v${status.version}`).not.toContain(secret);
      }
    }
    // A service that lets a token ride along is refused, masked; nothing is forwarded.
    for (const leak of [{ accessToken: FAKE_ACCESS }, { refreshToken: FAKE_REFRESH }, { code: FAKE_CODE }]) {
      const leaky = { ...fakeGsc(), performance: async () => ({ ...PERFORMANCE, ...leak }) as GscPerformanceAnswer };
      const error = await errorOf(call(ctxFor(leaky), 'performance', QUERY));
      expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
      for (const secret of SECRETS) expect(JSON.stringify(shapeOf(error, 'gsc.performance'))).not.toContain(secret);
    }
  });
});
