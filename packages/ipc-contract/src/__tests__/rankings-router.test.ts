// Spec: specs/rankings.schema.ts (RankTableInputSchema, RankSeriesInputSchema, ReadingDatesInputSchema, CompareInputSchema,
// RankCsvInputSchema, RankTableSchema, RankSeriesSchema, ReadingDatesSchema, SerpComparisonSchema, CompareAnswerSchema,
// CopyCsvAnswerSchema, SaveCsvAnswerSchema), specs/rankings.spec.ts (RANKINGS_REFUSALS, RANK_LIMITS, MAX_READING_DATES),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/rankings.feature.md (Router; Export; Scenarios: every-rankings-procedure-enforces-sender,
// rankings-inputs-are-validated, rankings-answers-are-checked, rank-csv-save-asks-for-the-path)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { MAX_READING_DATES, RANK_LIMITS, type CompareAnswer, type RankPoint, type RankRow, type RankSeriesAnswer, type RankTableAnswer, type ReadingDatesAnswer, type SaveCsvAnswer } from '@app/specs/rankings.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type RankingsService } from '../index';

const WINDOW_ID = 7;
const PROJECT = '01890a5d-ac96-774b-bcce-b302099a8057';
const READING_A = '01890a5d-ac96-774b-bcce-b302099a8058';
const READING_B = '01890a5d-ac96-774b-bcce-b302099a8059';
const KEY = 'a'.repeat(64);
const PARAMS = { engine: 'google', engineLabel: 'Google', query: 'green tea', gl: 'de', hl: 'de', device: 'desktop', page: 1, offset: null, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' } as const;
const POINT: RankPoint = { readingId: READING_A, at: 1_000, outcome: 'ranked', position: 3, url: 'https://example.com/tea', organicRead: 10, page: 1, alsoIn: ['featured-snippet'] };
const ROW: RankRow = {
  searchKey: KEY,
  params: PARAMS,
  filters: { tbs: 'qdr:w' },
  saved: { id: READING_B, tags: ['tea'] },
  latest: POINT,
  previous: { ...POINT, position: 5 },
  change: 2,
  best: 3,
  points: [POINT],
  competitors: { 'rival.com': { ...POINT, position: 1 }, 'other.com': null },
};
const TABLE: RankTableAnswer = { status: 'ok', rows: [{ ...ROW, capped: false }], truncated: false, retention: { mode: 'versions', value: 5 }, site: { domain: 'example.com', subdomains: true }, competitors: ['rival.com', 'other.com'], tags: ['tea'] };
const SERIES: RankSeriesAnswer = { status: 'ok', searchKey: KEY, points: [POINT], capped: false };
const DATES: ReadingDatesAnswer = { status: 'ok', dates: [{ readingId: READING_A, at: 1_000, status: 'ready' }] };
const SIDE = { readingId: READING_A, at: 1_000, params: PARAMS, filters: {}, status: 'ready' as const, organicRead: 10, complete: true, features: ['featured-snippet' as const] };
const COMPARE: CompareAnswer = {
  status: 'ok',
  comparison: {
    a: SIDE,
    b: { ...SIDE, readingId: READING_B },
    rows: [{ domain: 'example.com', a: { position: 3, url: 'https://example.com/tea' }, b: { position: 1, url: null }, movement: 'up', change: 2, role: 'site' }],
    features: [{ type: 'featured-snippet', a: true, b: true }],
    site: { a: POINT, b: { ...POINT, readingId: READING_B, position: 1 } },
    truncated: false,
  },
};
const SAVED: SaveCsvAnswer = { status: 'saved', rows: 1 };

function fakeRankings() {
  return {
    table: vi.fn(async (_projectId: string, _range: string, _tag: string | null): Promise<RankTableAnswer> => TABLE),
    series: vi.fn(async (_projectId: string, _key: string, _range: string): Promise<RankSeriesAnswer> => SERIES),
    readingDates: vi.fn(async (_projectId: string, _key: string): Promise<ReadingDatesAnswer> => DATES),
    compare: vi.fn(async (_projectId: string, _a: string, _b: string): Promise<CompareAnswer> => COMPARE),
    copyCsv: vi.fn(async (_projectId: string, _kind: string, _range: string, _tag: string | null): Promise<number | null> => 1),
    saveCsv: vi.fn(async (_windowId: number | null, _projectId: string, _kind: string, _range: string, _tag: string | null): Promise<SaveCsvAnswer> => SAVED),
  } satisfies RankingsService;
}

/** Every rankings procedure, its type and a valid input. */
const PROCEDURES: Record<string, { type: 'query' | 'mutation'; input: unknown }> = {
  table: { type: 'query', input: { projectId: PROJECT, range: '30d' } },
  series: { type: 'query', input: { projectId: PROJECT, searchKey: KEY, range: 'all' } },
  readingDates: { type: 'query', input: { projectId: PROJECT, searchKey: KEY } },
  compare: { type: 'query', input: { projectId: PROJECT, a: READING_A, b: READING_B } },
  copyCsv: { type: 'mutation', input: { projectId: PROJECT, kind: 'table', range: '30d' } },
  saveCsv: { type: 'mutation', input: { projectId: PROJECT, kind: 'history', range: '7d', tag: 'tea' } },
};

function ctxFor(rankings: RankingsService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: rankings === undefined ? {} : { rankings },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { rankings: Record<string, (input?: unknown) => Promise<unknown>> }).rankings;
  const fn = caller?.[name];
  if (!fn) throw new Error(`no rankings.${name}`);
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

const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string; output?: unknown } }>;

describe('rankings router', () => {
  test('every-rankings-procedure-enforces-sender', async () => {
    const paths = Object.keys(procedures).filter((p) => p.startsWith('rankings.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `rankings.${n}`).sort());
    for (const [name, { type, input }] of Object.entries(PROCEDURES)) {
      expect(procedures[`rankings.${name}`]?._def.type, name).toBe(type);
      // No procedure name says "query" or names SQL (`db-only-in-main`).
      expect(name.toLowerCase(), name).not.toMatch(/query|sql|select/);
      // The sender is checked before anything (even a bad input, even the service).
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'app://evil']) {
        const rankings = fakeRankings();
        for (const given of [input, { bogus: true }, undefined]) expect((await errorOf(call(ctxFor(rankings, origin), name, given))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        for (const fn of Object.values(rankings)) expect(fn, name).not.toHaveBeenCalled();
      }
      // A frame that is not the window's main frame, and an unknown window, are refused too.
      const rankings = fakeRankings();
      const sub = { ...ctxFor(rankings), sender: { ...ctxFor(rankings).sender!, isMainFrame: false } };
      expect((await errorOf(call(sub, name, input))).code, name).toBe(IPC_SENDER_ERROR_CODE);
      const stranger = { ...ctxFor(rankings), sender: { ...ctxFor(rankings).sender!, windowId: 99 } };
      expect((await errorOf(call(stranger, name, input))).code, name).toBe(IPC_SENDER_ERROR_CODE);
      for (const fn of Object.values(rankings)) expect(fn, name).not.toHaveBeenCalled();
      // Without the service: fails closed, a masked internal error.
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    // The answers, from the app's own window; the arguments as the service takes them.
    const rankings = fakeRankings();
    await expect(call(ctxFor(rankings), 'table', { projectId: PROJECT, range: '30d' })).resolves.toEqual(TABLE);
    await expect(call(ctxFor(rankings), 'table', { projectId: PROJECT, range: 'all', tag: 'tea' })).resolves.toEqual(TABLE);
    expect(rankings.table.mock.calls).toEqual([
      [PROJECT, '30d', null],
      [PROJECT, 'all', 'tea'],
    ]);
    await expect(call(ctxFor(rankings), 'series', PROCEDURES.series!.input)).resolves.toEqual(SERIES);
    expect(rankings.series).toHaveBeenCalledExactlyOnceWith(PROJECT, KEY, 'all');
    await expect(call(ctxFor(rankings), 'readingDates', PROCEDURES.readingDates!.input)).resolves.toEqual(DATES);
    expect(rankings.readingDates).toHaveBeenCalledExactlyOnceWith(PROJECT, KEY);
    await expect(call(ctxFor(rankings), 'compare', PROCEDURES.compare!.input)).resolves.toEqual(COMPARE);
    expect(rankings.compare).toHaveBeenCalledExactlyOnceWith(PROJECT, READING_A, READING_B);
    await expect(call(ctxFor(rankings), 'copyCsv', PROCEDURES.copyCsv!.input)).resolves.toBe(1);
    expect(rankings.copyCsv).toHaveBeenCalledExactlyOnceWith(PROJECT, 'table', '30d', null);
    // Save CSV: main's dialog is parented to the sender's window; the renderer names no path.
    await expect(call(ctxFor(rankings), 'saveCsv', PROCEDURES.saveCsv!.input)).resolves.toEqual(SAVED);
    expect(rankings.saveCsv).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, PROJECT, 'history', '7d', 'tea');
  });

  test('rankings-inputs-are-validated', async () => {
    const bad: Record<string, unknown[]> = {
      table: [
        {},
        { projectId: 'nope', range: '30d' },
        { projectId: PROJECT },
        { projectId: PROJECT, range: '1d' },
        { projectId: PROJECT, range: '30d', tag: '' },
        { projectId: PROJECT, range: '30d', tag: 'x'.repeat(33) },
        { projectId: PROJECT, range: '30d', tag: 'a‮b' },
        { projectId: PROJECT, range: '30d', tag: 'a\nb' },
        { projectId: PROJECT, range: '30d', tag: null },
        { projectId: PROJECT, range: '30d', sql: 'SELECT 1' },
      ],
      series: [
        { projectId: PROJECT, range: 'all' },
        { projectId: PROJECT, searchKey: 'A'.repeat(64), range: 'all' },
        { projectId: PROJECT, searchKey: 'a'.repeat(63), range: 'all' },
        { projectId: PROJECT, searchKey: KEY, range: 'all', readingId: READING_A },
      ],
      readingDates: [{ projectId: PROJECT }, { projectId: PROJECT, searchKey: KEY, limit: 5_000 }, { searchKey: KEY }],
      compare: [
        { projectId: PROJECT, a: READING_A },
        { projectId: PROJECT, a: READING_A, b: 'nope' },
        // A reading id alone (no project) is never enough.
        { a: READING_A, b: READING_B },
        { projectId: PROJECT, a: READING_A, b: READING_B, otherProjectId: PROJECT },
      ],
      copyCsv: [{ projectId: PROJECT, kind: 'json', range: '30d' }, { projectId: PROJECT, range: '30d' }, { projectId: PROJECT, kind: 'table', range: '30d', text: '=1+1' }],
      // The renderer never names a path or a file name.
      saveCsv: [
        { projectId: PROJECT, kind: 'table', range: '30d', path: '/tmp/out.csv' },
        { projectId: PROJECT, kind: 'table', range: '30d', file: 'out.csv' },
        { projectId: PROJECT, kind: 'table', range: '30d', fileName: 'out.csv' },
        { projectId: PROJECT, kind: 'table', range: '30d', defaultPath: '/tmp' },
        { projectId: PROJECT, kind: 'table', range: '30d', windowId: 1 },
        { projectId: PROJECT, kind: 'table' },
      ],
    };
    for (const [name, inputs] of Object.entries(bad)) {
      for (const input of [...inputs, undefined, 'x', 1]) {
        const rankings = fakeRankings();
        expect((await errorOf(call(ctxFor(rankings), name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
        for (const fn of Object.values(rankings)) expect(fn).not.toHaveBeenCalled();
      }
    }
  });

  test('rankings-answers-are-checked', async () => {
    // Every procedure answers through an output schema of its own.
    for (const name of Object.keys(PROCEDURES)) expect(procedures[`rankings.${name}`]?._def.output, name).toBeDefined();
    // Refusals pass.
    for (const reason of ['not-found', 'store-failed', 'write-failed'] as const) {
      const rankings = fakeRankings();
      rankings.table.mockResolvedValueOnce({ status: 'refused', reason });
      await expect(call(ctxFor(rankings), 'table', PROCEDURES.table!.input)).resolves.toEqual({ status: 'refused', reason });
    }
    const cancelled = fakeRankings();
    cancelled.saveCsv.mockResolvedValueOnce({ status: 'cancelled' });
    await expect(call(ctxFor(cancelled), 'saveCsv', PROCEDURES.saveCsv!.input)).resolves.toEqual({ status: 'cancelled' });
    cancelled.copyCsv.mockResolvedValueOnce(null);
    await expect(call(ctxFor(cancelled), 'copyCsv', PROCEDURES.copyCsv!.input)).resolves.toBeNull();

    // Anything more, or out of bounds, is a masked internal error.
    const leaks: Record<string, unknown[]> = {
      table: [
        { ...TABLE, snapshot: { title: 'page text' } },
        { ...TABLE, rows: [{ ...ROW, capped: false, title: 'Green tea' }] },
        { ...TABLE, rows: [ROW] },
        { ...TABLE, capped: true },
        { ...TABLE, rows: [{ ...ROW, capped: false, latest: { ...POINT, title: 'Green tea' } }] },
        { ...TABLE, rows: [{ ...ROW, capped: false, latest: { ...POINT, url: 'javascript:alert(1)' } }] },
        { ...TABLE, rows: [{ ...ROW, capped: false, params: { ...PARAMS, url: 'file:///etc/passwd' } }] },
        { ...TABLE, rows: [{ ...ROW, capped: false, filters: { secret: 'x' } }] },
        { ...TABLE, rows: [{ ...ROW, capped: false, points: Array.from({ length: RANK_LIMITS.maxPointsPerSeries + 1 }, () => POINT) }] },
        { ...TABLE, rows: Array.from({ length: RANK_LIMITS.maxRows + 1 }, () => ({ ...ROW, capped: false })) },
        { ...TABLE, rows: [{ ...ROW, capped: false, competitors: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`rival${i}.com`, null])) }] },
        { ...TABLE, site: { domain: 'Example.COM', subdomains: true } },
        { ...TABLE, retention: { mode: 'sometimes', value: 1 } },
        { ...TABLE, path: '/home/user/x.csv' },
        { status: 'refused', reason: 'because' },
        { status: 'refused', reason: 'not-found', message: 'SELECT * FROM ci_serp_readings' },
      ],
      series: [{ ...SERIES, points: [{ ...POINT, outcome: 'great' }] }, { ...SERIES, readings: [] }],
      readingDates: [{ ...DATES, dates: Array.from({ length: MAX_READING_DATES + 1 }, () => DATES.dates[0]) }, { ...DATES, dates: [{ ...DATES.dates[0], snapshot: {} }] }],
      compare: [
        { ...COMPARE, comparison: { ...(COMPARE as { comparison: object }).comparison, html: '<b>' } },
        { ...COMPARE, comparison: { ...(COMPARE as unknown as { comparison: { rows: object[] } }).comparison, rows: [{ ...(COMPARE as unknown as { comparison: { rows: object[] } }).comparison.rows[0], title: 'x' }] } },
        { status: 'ok' },
      ],
      copyCsv: [-1, 1.5, 'a,b', { rows: 1 }],
      saveCsv: [{ status: 'saved', rows: 1, path: '/home/user/x.csv' }, { status: 'saved' }, { status: 'cancelled', file: 'x' }, { status: 'written' }],
    };
    for (const [name, answers] of Object.entries(leaks)) {
      for (const answer of answers) {
        const rankings = fakeRankings();
        (rankings[name as keyof typeof rankings] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(answer);
        const error = await errorOf(call(ctxFor(rankings), name, PROCEDURES[name]!.input));
        expect(error.code, `${name} ${JSON.stringify(answer).slice(0, 120)}`).toBe(IPC_INTERNAL_ERROR_CODE);
        expect(error.message).not.toMatch(/SELECT|\/home\/|page text/);
      }
    }
  });
});
