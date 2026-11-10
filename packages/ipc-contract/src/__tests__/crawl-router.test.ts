// Spec: specs/site-crawl.schema.ts (CrawlRunIdInputSchema, CrawlStartInputSchema, CrawlWatchInputSchema, CrawlWatchViewSchema,
// CrawlServiceAnswerSchema, CrawlPagesInputSchema, CrawlPagesAnswerSchema, CrawlStructureInputSchema,
// CrawlStructureAnswerSchema, CrawlCsvInputSchema, CrawlCsvAnswerSchema), specs/site-crawl.spec.ts (CRAWL_WATCH,
// CRAWL_PAGES_LIMITS), specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE),
// specs/data-sources.spec.ts (LEGAL_GATE_NOTE)
// Acceptance: specs/site-crawl.feature.md (Pages and Site structure, Task 7: The router) · plan
// docs/plans/phase-12-big-bets.md Task 7 (`crawl-router-enforces-sender`)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import type { CrawlCsvAnswer, CrawlPagesAnswer, CrawlStatusView, CrawlStructureAnswer, CrawlWatchView } from '@app/specs/site-crawl.schema';
import { CRAWL_PAGES_LIMITS, CRAWL_WATCH, type CrawlServiceAnswer } from '@app/specs/site-crawl.spec';
import { appRouter, createSenderPolicy, type CrawlIpcService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const RUN = '01900000-0000-7000-8000-0000000000a1';
const SETTINGS = { startUrl: 'https://example.com/', scope: 'host', include: [], exclude: [], maxPages: 500, intervalMs: 1_000, sitemaps: true };

const STATUS: CrawlStatusView = { available: false, activeRunId: null, runs: [] };
const PAGES: CrawlPagesAnswer = { status: 'ok', total: 0, offset: 0, rows: [] };
const STRUCTURE: CrawlStructureAnswer = { status: 'ok', tree: { prefix: null, nodes: [], more: 0 }, depths: [], orphans: { urls: [], total: 0 } };

function fakeService(overrides: Partial<CrawlIpcService> = {}) {
  return {
    status: vi.fn(async (): Promise<CrawlStatusView> => STATUS),
    watch: vi.fn(async (_since: number, _signal: AbortSignal, _sender: number | null): Promise<CrawlWatchView> => ({ version: 3, status: STATUS })),
    start: vi.fn(async (): Promise<CrawlServiceAnswer> => ({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE })),
    pause: vi.fn(async (): Promise<CrawlServiceAnswer> => ({ status: 'ok' })),
    resume: vi.fn(async (): Promise<CrawlServiceAnswer> => ({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE })),
    cancel: vi.fn(async (): Promise<CrawlServiceAnswer> => ({ status: 'ok' })),
    delete: vi.fn(async (): Promise<CrawlServiceAnswer> => ({ status: 'ok' })),
    pages: vi.fn(async (): Promise<CrawlPagesAnswer> => PAGES),
    structure: vi.fn(async (): Promise<CrawlStructureAnswer> => STRUCTURE),
    exportCsv: vi.fn(async (): Promise<CrawlCsvAnswer> => ({ status: 'cancelled' })),
    ...overrides,
  } satisfies CrawlIpcService;
}

function ctxFor(service: CrawlIpcService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service === undefined ? {} : { crawl: service },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { crawl: Record<string, (input?: unknown) => Promise<unknown>> }).crawl;
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

const SORTED = { filter: {}, sort: 'order', direction: 'asc' };
const PROCEDURES: Record<string, unknown> = {
  status: undefined,
  watch: { sinceVersion: 0 },
  start: { settings: SETTINGS, projectId: null },
  pause: { runId: RUN },
  resume: { runId: RUN },
  cancel: { runId: RUN },
  delete: { runId: RUN },
  pages: { runId: RUN, ...SORTED, offset: 0, limit: 50 },
  structure: { runId: RUN, prefix: null },
  exportCsv: { runId: RUN, ...SORTED },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('crawl router', () => {
  test('crawl-router-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('crawl.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `crawl.${n}`).sort());
    const service = fakeService();
    for (const [name, input] of Object.entries(PROCEDURES)) {
      expect((await errorOf(call(ctxFor(service, 'https://evil.example'), name, input))).code, name).toBe(IPC_SENDER_ERROR_CODE);
      // Fails closed without the service.
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    // From the app's own window, each answers.
    for (const [name, input] of Object.entries(PROCEDURES)) await expect(call(ctxFor(service), name, input), name).resolves.toBeDefined();
  });

  test('crawl-router-inputs-bounded', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    const bad: Record<string, unknown[]> = {
      watch: [undefined, { sinceVersion: -1 }, { sinceVersion: 1.5 }, { sinceVersion: 1, extra: true }],
      start: [
        undefined,
        { settings: SETTINGS },
        { settings: { ...SETTINGS, pattern: '.*' }, projectId: null },
        { settings: { ...SETTINGS, startUrl: 'file:///etc/passwd' }, projectId: null },
        { settings: { ...SETTINGS, startUrl: 'http://127.0.0.1:3000/', scope: 'site' }, projectId: null },
        { settings: { ...SETTINGS, include: ['^/blog.*'] }, projectId: null },
        { settings: { ...SETTINGS, maxPages: 10_001 }, projectId: null },
        { settings: SETTINGS, projectId: 'not-an-id' },
      ],
      pause: [{ runId: 'x' }, {}, { runId: RUN, extra: 1 }],
      delete: [{ runId: '../../etc' }],
      pages: [
        { runId: RUN, ...SORTED, offset: 0, limit: CRAWL_PAGES_LIMITS.maxPageSize + 1 },
        { runId: RUN, ...SORTED, offset: -1, limit: 50 },
        { runId: RUN, ...SORTED, offset: 0, limit: 0 },
        { runId: RUN, ...SORTED, sort: 'random()', offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { finding: 'not-a-crawl-rule' }, offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { finding: 'images-oversized' }, offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { status: '2xx OR 1=1' }, offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { depth: 11 }, offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { linksCut: false }, offset: 0, limit: 50 },
        { runId: RUN, ...SORTED, filter: { url: 'x' }, offset: 0, limit: 50 },
      ],
      structure: [{ runId: RUN }, { runId: RUN, prefix: 'https://example.com/blog' }, { runId: RUN, prefix: 'javascript:alert(1)/' }, { runId: RUN, prefix: `https://example.com/${'a'.repeat(2_100)}/` }],
      exportCsv: [{ runId: RUN, ...SORTED, path: '/tmp/x.csv' }, { runId: RUN, ...SORTED, fileName: 'x.csv' }, { runId: RUN }],
    };
    for (const [name, inputs] of Object.entries(bad)) {
      for (const input of inputs) expect((await errorOf(call(ctx, name, input))).code, `${name} ${JSON.stringify(input)?.slice(0, 80)}`).toBe('BAD_REQUEST');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    // Good inputs reach the service as sent (the window id from the sender, never from the renderer).
    await call(ctx, 'pages', { runId: RUN, filter: { status: '4xx', indexable: 'no', finding: 'title-missing', depth: 2, linksCut: true }, sort: 'score', direction: 'desc', offset: 200, limit: 200 });
    expect(service.pages).toHaveBeenCalledWith({ runId: RUN, filter: { status: '4xx', indexable: 'no', finding: 'title-missing', depth: 2, linksCut: true }, sort: 'score', direction: 'desc', offset: 200, limit: 200 });
    await call(ctx, 'exportCsv', { runId: RUN, ...SORTED });
    expect(service.exportCsv).toHaveBeenCalledWith(WINDOW_ID, { runId: RUN, ...SORTED });
    await call(ctx, 'structure', { runId: RUN, prefix: 'https://example.com/blog/' });
    expect(service.structure).toHaveBeenCalledWith({ runId: RUN, prefix: 'https://example.com/blog/' });
  });

  test('crawl-router-answers-are-checked', async () => {
    const leaky = fakeService({
      status: vi.fn(async () => ({ ...STATUS, secret: 'x' }) as unknown as CrawlStatusView),
      pages: vi.fn(async () => ({ ...PAGES, rows: Array.from({ length: CRAWL_PAGES_LIMITS.maxPageSize + 1 }, () => ({})) }) as unknown as CrawlPagesAnswer),
      structure: vi.fn(async () => ({ ...STRUCTURE, extra: 1 }) as unknown as CrawlStructureAnswer),
      start: vi.fn(async () => ({ status: 'started', runId: RUN, path: '/x' }) as unknown as CrawlServiceAnswer),
      exportCsv: vi.fn(async () => ({ status: 'saved', rows: 1, file: '/home/me/x.csv' }) as unknown as CrawlCsvAnswer),
    });
    const ctx = ctxFor(leaky);
    for (const name of ['status', 'pages', 'structure', 'start', 'exportCsv']) expect((await errorOf(call(ctx, name, PROCEDURES[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('crawl-router-start-passes-the-gate-through', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    expect(await call(ctx, 'start', PROCEDURES.start)).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    expect(await call(ctx, 'resume', PROCEDURES.resume)).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    expect(service.start).toHaveBeenCalledWith({ settings: SETTINGS, projectId: null });
    expect(service.resume).toHaveBeenCalledWith(RUN);
    expect(await call(ctx, 'cancel', PROCEDURES.cancel)).toEqual({ status: 'ok' });
    expect(service.cancel).toHaveBeenCalledWith(RUN);
  });

  test('crawl-watch-times-out-with-the-current-view', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const service = fakeService({
      watch: vi.fn(
        (_since: number, s: AbortSignal, _sender: number | null) =>
          new Promise<CrawlWatchView>((resolve) => {
            signal = s;
            s.addEventListener('abort', () => resolve({ version: 9, status: STATUS }));
          }),
      ),
    });
    const answer = call(ctxFor(service), 'watch', { sinceVersion: 9 });
    await vi.advanceTimersByTimeAsync(CRAWL_WATCH.timeoutMs - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ version: 9, status: STATUS });
    // The sender's window id, so main counts pending polls per window.
    expect(service.watch).toHaveBeenCalledWith(9, expect.any(AbortSignal), WINDOW_ID);
  });
});
