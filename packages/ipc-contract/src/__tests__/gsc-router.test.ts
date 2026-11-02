// Spec: specs/gsc.schema.ts (GscStatusSchema, GscWatchInputSchema, GscPerformanceQuerySchema, GscConnectResultSchema,
// GscPerformanceAnswerSchema, GscQueriesAnswerSchema, GscCountriesAnswerSchema, GscTargetPagesQuerySchema, GscTargetPagesAnswerSchema,
// GscPropertiesAnswerSchema, GSC_CONNECT_RESULTS),
// specs/gsc-inspection.schema.ts (GscInspectInputSchema, GscOpenInspectionLinkInputSchema, GscInspectionAnswerSchema, GSC_OPEN_LINK_RESULTS),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE), specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/gsc.feature.md (Router; Ranges and filters; Search targets), specs/gsc-inspection.feature.md (Router) · review focus "The renderer never sees a token"
// · plan Global Constraint "Tokens stay in main"
import { getTRPCErrorShape, TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import {
  GSC_CONNECT_RESULTS,
  type GscConnectResult,
  type GscCountriesAnswer,
  type GscPerformanceAnswer,
  type GscPerformanceQuery,
  type GscPropertiesAnswer,
  type GscPropertyForAnswer,
  type GscQueriesAnswer,
  type GscStatus,
  type GscTargetPagesAnswer,
  type GscTargetPagesQuery,
} from '@app/specs/gsc.schema';
import { GSC_OPEN_LINK_RESULTS, type GscInspectInput, type GscInspectionAnswer, type GscOpenLinkResult } from '@app/specs/gsc-inspection.schema';
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
const COUNTRIES: GscCountriesAnswer = { status: 'ok', property: PROPERTY, range: RANGE, countries: [{ country: 'gbr', clicks: 3, impressions: 40 }] };
const TARGET: GscTargetPagesQuery = { url: 'https://www.example.com/a', query: 'Green Tea', days: 28 };
const TARGET_PAGES: GscTargetPagesAnswer = {
  status: 'ok',
  property: PROPERTY,
  range: RANGE,
  query: 'green tea',
  rows: [
    { page: 'https://www.example.com/tea', clicks: 9, impressions: 90, ctr: 0.1, position: 2.5 },
    { page: 'https://www.example.com/a#brewing', clicks: 4, impressions: 70, ctr: 0.057, position: 3.1 },
  ],
  pagesRead: 2,
  thisPageRank: 2,
};
const INSPECT: GscInspectInput = { url: 'https://www.example.com/a' };
const LINK = 'https://search.google.com/search-console/inspect?resource_id=https%3A%2F%2Fwww.example.com%2F&id=https%3A%2F%2Fwww.example.com%2Fa';
const INSPECTION: GscInspectionAnswer = {
  status: 'ok',
  property: PROPERTY,
  url: INSPECT.url,
  inspectedAt: '2026-10-28T12:00:00.000Z',
  index: {
    verdict: { value: 'PASS' },
    coverageState: 'Submitted and indexed',
    robotsTxtState: { value: 'ALLOWED' },
    indexingState: { value: 'INDEXING_ALLOWED' },
    pageFetchState: { value: 'unknown', code: 'BRAND_NEW_STATE' },
    lastCrawlTime: '2026-10-20T08:15:30.000Z',
    crawledAs: null,
    googleCanonical: INSPECT.url,
    userCanonical: null,
  },
  richResults: { verdict: { value: 'FAIL' }, types: [{ type: 'FAQ', items: [{ name: 'q', issues: [{ message: 'Missing field', severity: { value: 'ERROR' } }] }] }] },
  link: LINK,
};

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
    countries: vi.fn(async (_query: GscPerformanceQuery): Promise<GscCountriesAnswer> => COUNTRIES),
    targetPages: vi.fn(async (_query: GscTargetPagesQuery): Promise<GscTargetPagesAnswer> => TARGET_PAGES),
    inspect: vi.fn(async (_input: GscInspectInput): Promise<GscInspectionAnswer> => INSPECTION),
    openInspectionLink: vi.fn(async (_windowId: number, _url: string): Promise<GscOpenLinkResult> => 'opened'),
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
  countries: { type: 'query', input: QUERY },
  targetPages: { type: 'query', input: TARGET },
  inspect: { type: 'mutation', input: INSPECT },
  openInspectionLink: { type: 'mutation', input: { url: INSPECT.url } },
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

  test('gsc-countries-procedure-enforces-sender', async () => {
    const proc = (appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)['gsc.countries'];
    expect(proc?._def.type).toBe('query');
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'app://evil']) {
      const gsc = fakeGsc();
      expect((await errorOf(call(ctxFor(gsc, origin), 'countries', QUERY))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(gsc.countries, origin).not.toHaveBeenCalled();
    }
    const gsc = fakeGsc();
    const input = { url: QUERY.url, scope: 'property', range: RANGE, device: 'MOBILE' } as const;
    await expect(call(ctxFor(gsc), 'countries', input)).resolves.toEqual(COUNTRIES);
    expect(gsc.countries).toHaveBeenCalledExactlyOnceWith(input);
    gsc.countries.mockResolvedValueOnce({ status: 'unavailable', reason: 'no-property' });
    await expect(call(ctxFor(gsc), 'countries', QUERY)).resolves.toEqual({ status: 'unavailable', reason: 'no-property' });
    // Its output is strict: a token riding along, or a malformed country, is a masked internal error.
    for (const bad of [{ ...COUNTRIES, accessToken: FAKE_ACCESS }, { ...COUNTRIES, countries: [{ country: 'GBR', clicks: 1, impressions: 1 }] }, { ...COUNTRIES, scope: 'page' }]) {
      const leaky = fakeGsc();
      leaky.countries.mockResolvedValue(bad as GscCountriesAnswer);
      const error = await errorOf(call(ctxFor(leaky), 'countries', QUERY));
      expect(error.code).toBe(IPC_INTERNAL_ERROR_CODE);
      for (const secret of SECRETS) expect(JSON.stringify(shapeOf(error, 'gsc.countries'))).not.toContain(secret);
    }
  });

  test('gsc-target-pages-enforces-sender', async () => {
    const proc = (appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)['gsc.targetPages'];
    expect(proc?._def.type).toBe('query');
    // Not refused by the `db-only-in-main` name rule (`session-store.test.ts`).
    expect('gsc.targetPages').not.toMatch(/sql|sqlite|database|db\b|exec|query|session/i);
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'app://evil']) {
      const gsc = fakeGsc();
      expect((await errorOf(call(ctxFor(gsc, origin), 'targetPages', TARGET))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(gsc.targetPages, origin).not.toHaveBeenCalled();
    }
    // The input as is (main normalises the query), a preset or a custom range.
    const gsc = fakeGsc();
    await expect(call(ctxFor(gsc), 'targetPages', TARGET)).resolves.toEqual(TARGET_PAGES);
    const custom = { url: TARGET.url, query: 'green tea', range: RANGE };
    await expect(call(ctxFor(gsc), 'targetPages', custom)).resolves.toEqual(TARGET_PAGES);
    expect(gsc.targetPages.mock.calls).toEqual([[TARGET], [custom]]);
    for (const answer of [
      { status: 'unavailable', reason: 'no-property' },
      { ...TARGET_PAGES, rows: [], pagesRead: 0, thisPageRank: null },
    ] as GscTargetPagesAnswer[]) {
      gsc.targetPages.mockResolvedValueOnce(answer);
      await expect(call(ctxFor(gsc), 'targetPages', TARGET)).resolves.toEqual(answer);
    }
    // Strict input: never reaches the service.
    for (const input of [
      undefined,
      { ...TARGET, query: '' },
      { ...TARGET, query: '   ' },
      { ...TARGET, query: 'q'.repeat(201) },
      { ...TARGET, url: 'file:///etc/passwd' },
      { ...TARGET, range: RANGE },
      { url: TARGET.url, query: 'tea' },
      { ...TARGET, scope: 'page' },
      { ...TARGET, country: 'gbr' },
      { ...TARGET, token: FAKE_ACCESS },
    ]) {
      const strict = fakeGsc();
      expect((await errorOf(call(ctxFor(strict), 'targetPages', input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
      expect(strict.targetPages).not.toHaveBeenCalled();
    }
    // Strict output: a token riding along, more than 10 rows, a rank past the pages read or a non-web page is a masked internal error.
    const row = TARGET_PAGES.rows[0]!;
    for (const bad of [
      { ...TARGET_PAGES, accessToken: FAKE_ACCESS },
      { ...TARGET_PAGES, rows: Array.from({ length: 11 }, () => row), pagesRead: 11 },
      { ...TARGET_PAGES, thisPageRank: 3 },
      { ...TARGET_PAGES, thisPageRank: 0 },
      { ...TARGET_PAGES, rows: [{ ...row, page: 'javascript:alert(1)' }] },
      { ...TARGET_PAGES, rows: [], pagesRead: 2 },
      { ...TARGET_PAGES, pagesRead: 37 },
      { ...TARGET_PAGES, scope: 'page' },
    ]) {
      const leaky = fakeGsc();
      leaky.targetPages.mockResolvedValue(bad as GscTargetPagesAnswer);
      const error = await errorOf(call(ctxFor(leaky), 'targetPages', TARGET));
      expect(error.code, JSON.stringify(bad).slice(0, 80)).toBe(IPC_INTERNAL_ERROR_CODE);
      for (const secret of SECRETS) expect(JSON.stringify(shapeOf(error, 'gsc.targetPages'))).not.toContain(secret);
    }
  });

  test('gsc-inspect-enforces-sender', async () => {
    const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
    expect(procedures['gsc.inspect']?._def.type).toBe('mutation');
    expect(procedures['gsc.openInspectionLink']?._def.type).toBe('mutation');
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'app://evil', 'https://search.google.com']) {
      const gsc = fakeGsc();
      expect((await errorOf(call(ctxFor(gsc, origin), 'inspect', INSPECT))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect((await errorOf(call(ctxFor(gsc, origin), 'openInspectionLink', { url: INSPECT.url }))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(gsc.inspect, origin).not.toHaveBeenCalled();
      expect(gsc.openInspectionLink, origin).not.toHaveBeenCalled();
    }
    // `inspect`: the input as is (with `fresh`); strict.
    const gsc = fakeGsc();
    await expect(call(ctxFor(gsc), 'inspect', INSPECT)).resolves.toEqual(INSPECTION);
    await expect(call(ctxFor(gsc), 'inspect', { ...INSPECT, fresh: true })).resolves.toEqual(INSPECTION);
    expect(gsc.inspect.mock.calls).toEqual([[INSPECT], [{ ...INSPECT, fresh: true }]]);
    gsc.inspect.mockResolvedValueOnce({ status: 'unavailable', reason: 'quota' });
    await expect(call(ctxFor(gsc), 'inspect', INSPECT)).resolves.toEqual({ status: 'unavailable', reason: 'quota' });
    // `openInspectionLink`: the sender's window ID and the page URL, nothing else; every result passes.
    for (const result of GSC_OPEN_LINK_RESULTS) {
      const opener = fakeGsc();
      opener.openInspectionLink.mockResolvedValueOnce(result);
      await expect(call(ctxFor(opener), 'openInspectionLink', { url: INSPECT.url })).resolves.toBe(result);
      expect(opener.openInspectionLink).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, INSPECT.url);
    }
    for (const [name, input] of [
      ['inspect', undefined],
      ['inspect', { url: 'file:///etc/passwd' }],
      ['inspect', { ...INSPECT, fresh: 'yes' }],
      ['inspect', { ...INSPECT, token: FAKE_ACCESS }],
      ['inspect', { url: 'x'.repeat(5_000) }],
      ['openInspectionLink', undefined],
      ['openInspectionLink', { url: INSPECT.url, link: LINK }],
      ['openInspectionLink', { link: LINK }],
      ['openInspectionLink', { url: 'javascript:alert(1)' }],
    ] as const) {
      const strict = fakeGsc();
      expect((await errorOf(call(ctxFor(strict), name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
      expect(strict.inspect).not.toHaveBeenCalled();
      expect(strict.openInspectionLink).not.toHaveBeenCalled();
    }
  });

  test('gsc-inspect-output-strict', async () => {
    const ok = INSPECTION as Extract<GscInspectionAnswer, { status: 'ok' }>;
    const bad: unknown[] = [
      { ...ok, accessToken: FAKE_ACCESS },
      { ...ok, index: { ...ok.index, sitemap: ['https://www.example.com/sitemap.xml'] } },
      { ...ok, index: { ...ok.index, coverageState: 'x'.repeat(501) } },
      { ...ok, index: { ...ok.index, verdict: { value: 'PARTIAL' } } },
      { ...ok, index: { ...ok.index, verdict: { value: 'unknown', code: 'lower case' } } },
      { ...ok, index: { ...ok.index, googleCanonical: 'javascript:alert(1)' } },
      { ...ok, index: { ...ok.index, lastCrawlTime: 'yesterday' } },
      { ...ok, link: 'https://evil.example/phish' },
      { ...ok, link: 'http://search.google.com/x' },
      { ...ok, mobileUsabilityResult: { verdict: 'PASS' } },
      { ...ok, richResults: { ...ok.richResults, types: [{ type: 'FAQ', items: Array.from({ length: 51 }, () => ({ name: 'q', issues: [] })) }] } },
      { status: 'unavailable', reason: 'busy' },
      { status: 'unavailable', reason: 'quota', refreshToken: FAKE_REFRESH },
    ];
    for (const answer of bad) {
      const leaky = fakeGsc();
      leaky.inspect.mockResolvedValue(answer as GscInspectionAnswer);
      const error = await errorOf(call(ctxFor(leaky), 'inspect', INSPECT));
      expect(error.code, JSON.stringify(answer).slice(0, 120)).toBe(IPC_INTERNAL_ERROR_CODE);
      const shape = shapeOf(error, 'gsc.inspect');
      expect(shape.message).toBe(IPC_INTERNAL_ERROR_CODE);
      for (const secret of [...SECRETS, 'evil.example']) expect(JSON.stringify(shape)).not.toContain(secret);
    }
    for (const result of ['opened-elsewhere', LINK, true, { opened: true }]) {
      const leaky = fakeGsc();
      leaky.openInspectionLink.mockResolvedValue(result as GscOpenLinkResult);
      const error = await errorOf(call(ctxFor(leaky), 'openInspectionLink', { url: INSPECT.url }));
      expect(error.code, String(result)).toBe(IPC_INTERNAL_ERROR_CODE);
      expect(JSON.stringify(shapeOf(error, 'gsc.openInspectionLink'))).not.toContain('search.google.com');
    }
  });

  test('performance-input-strict', async () => {
    const { days: _days, ...base } = QUERY;
    for (const name of ['performance', 'topQueries', 'countries'] as const) {
      for (const input of [
        { ...QUERY, range: RANGE }, // both `days` and `range`
        base, // neither
        { ...base, range: { start: RANGE.end, end: RANGE.start } },
        { ...base, range: { start: '2026-02-30', end: '2026-03-02' } },
        { ...base, range: { ...RANGE, days: 28 } },
        { ...base, range: RANGE, country: 'USA' },
        { ...base, range: RANGE, country: 'us' },
        { ...QUERY, device: 'mobile' },
        { ...QUERY, device: 'TV' },
        { ...QUERY, country: 'gbr', extra: 1 },
      ]) {
        const gsc = fakeGsc();
        expect((await errorOf(call(ctxFor(gsc), name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
        for (const fn of [gsc.performance, gsc.topQueries, gsc.countries]) expect(fn).not.toHaveBeenCalled();
      }
      // A custom range with both filters passes through as is.
      const gsc = fakeGsc();
      const input = { ...base, range: RANGE, country: 'gbr', device: 'TABLET' } as const;
      await call(ctxFor(gsc), name, input);
      expect(gsc[name]).toHaveBeenCalledExactlyOnceWith(input);
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
