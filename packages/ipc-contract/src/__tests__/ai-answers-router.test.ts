// Spec: specs/ai-answers.schema.ts (AiAnswersListInputSchema, AiAnswerIdInputSchema, AiAnswersRunInputSchema,
// AiAnswersRunAnswerSchema, AiAnswersSetRetentionInputSchema, AiAnswersSetViaInputSchema,
// AiAnswersSetDefaultEngineInputSchema, AiAnswersViewSchema, AiAnswerRecordSchema, AiAnswersListAnswerSchema),
// specs/ai-answers.spec.ts (AI_ANSWERS_LIMITS, AI_SEARCH_SETTING_RESULTS), specs/ipc-sender.spec.ts,
// specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE), specs/data-sources.spec.ts (LEGAL_GATE_NOTE)
// Acceptance: specs/ai-answers.feature.md (Router) · plan docs/plans/phase-12-big-bets.md Task 9
// (`ai-answers-router-enforces-sender`)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { AI_ANSWERS_LIMITS } from '@app/specs/ai-answers.spec';
import type { AiAnswerRecord, AiAnswersListAnswer, AiAnswersRunAnswer, AiAnswersView } from '@app/specs/ai-answers.schema';
import { appRouter, createSenderPolicy, type AiAnswersService, type IpcContext } from '../index';

const WINDOW_ID = 7;

const VIEW: AiAnswersView = {
  retention: '30d',
  defaultEngine: null,
  engines: [
    { engine: 'perplexity', provider: 'perplexity', available: false, hasKey: false, via: null, usable: false },
    { engine: 'chatgpt', provider: 'openai-search', available: false, hasKey: false, via: null, usable: false },
    { engine: 'google-ai-mode', provider: null, available: false, hasKey: false, via: null, usable: false },
  ],
};
const RECORD: AiAnswerRecord = {
  id: 3,
  query: 'green tea',
  engine: 'perplexity',
  via: 'api',
  provider: 'perplexity',
  origin: 'view',
  answer: 'Keep it airtight.',
  answerTruncated: false,
  citations: [{ url: 'https://tea.example/storage', title: 'Storing tea' }],
  citationsTotal: 1,
  citedDomains: ['tea.example'],
  chatId: null,
  createdAt: 1_798_000_000_000,
};
const LIST: AiAnswersListAnswer = { rows: [], more: false, total: 0 };
const REFUSED: AiAnswersRunAnswer = { status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE };

function fakeService(overrides: Partial<AiAnswersService> = {}) {
  return {
    view: vi.fn(async (): Promise<AiAnswersView> => VIEW),
    list: vi.fn(async (): Promise<AiAnswersListAnswer> => LIST),
    get: vi.fn(async (): Promise<AiAnswerRecord | null> => RECORD),
    run: vi.fn(async (): Promise<AiAnswersRunAnswer> => REFUSED),
    delete: vi.fn(async () => true),
    deleteAll: vi.fn(async () => true),
    setRetention: vi.fn(async () => true),
    setVia: vi.fn(async () => 'ok' as const),
    setDefaultEngine: vi.fn(async () => 'unavailable' as const),
    ...overrides,
  } satisfies AiAnswersService;
}

function ctxFor(service: AiAnswersService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service === undefined ? {} : { aiAnswers: service },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { aiAnswers: Record<string, (input?: unknown) => Promise<unknown>> }).aiAnswers;
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
  view: undefined,
  list: { limit: 50 },
  get: { id: 3 },
  run: { query: 'green tea', engine: 'perplexity' },
  delete: { id: 3 },
  deleteAll: undefined,
  setRetention: { retention: '7d' },
  setVia: { engine: 'chatgpt', via: 'off' },
  setDefaultEngine: { engine: null },
};

describe('ai answers router', () => {
  test('ai-answers-router-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('aiAnswers.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `aiAnswers.${n}`).sort());
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

  test('ai-answers-router-inputs-bounded', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    const bad: Record<string, unknown[]> = {
      list: [undefined, { limit: 0 }, { limit: AI_ANSWERS_LIMITS.maxPageSize + 1 }, { limit: 10, beforeId: 0 }, { limit: 10, beforeId: 1.5 }, { limit: 10, extra: 1 }],
      get: [undefined, { id: 0 }, { id: -1 }, { id: '3' }, { id: 3, extra: true }],
      run: [
        undefined,
        { query: '' },
        { query: '   ' },
        { query: 'q'.repeat(257) },
        { query: 'line\nbreak' },
        { query: 'bidi‮' },
        { query: 'tea', engine: 'bing' },
        { query: 'tea', via: 'api' },
        { query: 'tea', engine: 'perplexity', model: 'gpt-5' },
      ],
      delete: [{ id: 'x' }, {}],
      setRetention: [{ retention: '1y' }, {}, { retention: 'off', extra: 1 }],
      setVia: [{ engine: 'chatgpt', via: 'tab' }, { engine: 'bing', via: 'api' }, { engine: 'chatgpt' }],
      setDefaultEngine: [{}, { engine: 'bing' }, { engine: undefined }],
    };
    for (const [name, inputs] of Object.entries(bad)) {
      for (const input of inputs) expect((await errorOf(call(ctx, name, input))).code, `${name} ${JSON.stringify(input)?.slice(0, 80)}`).toBe('BAD_REQUEST');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    // Good inputs reach the service as sent.
    await call(ctx, 'run', { query: 'green tea' });
    expect(service.run).toHaveBeenCalledWith({ query: 'green tea' });
    await call(ctx, 'list', { limit: 10, beforeId: 40 });
    expect(service.list).toHaveBeenCalledWith({ limit: 10, beforeId: 40 });
    await call(ctx, 'setVia', { engine: 'perplexity', via: 'api' });
    expect(service.setVia).toHaveBeenCalledWith('perplexity', 'api');
    await call(ctx, 'setDefaultEngine', { engine: 'chatgpt' });
    expect(service.setDefaultEngine).toHaveBeenCalledWith('chatgpt');
    await call(ctx, 'setRetention', { retention: 'off' });
    expect(service.setRetention).toHaveBeenCalledWith('off');
    await call(ctx, 'get', { id: 9 });
    expect(service.get).toHaveBeenCalledWith(9);
    await call(ctx, 'delete', { id: 9 });
    expect(service.delete).toHaveBeenCalledWith(9);
    // The gate's refusal passes through as main said it.
    expect(await call(ctx, 'run', PROCEDURES.run)).toEqual(REFUSED);
  });

  test('ai-answers-router-answers-are-checked', async () => {
    const leaky = fakeService({
      view: vi.fn(async () => ({ ...VIEW, key: 'sk-x' }) as unknown as AiAnswersView),
      get: vi.fn(async () => ({ ...RECORD, html: '<b>' }) as unknown as AiAnswerRecord),
      list: vi.fn(async () => ({ ...LIST, rows: Array.from({ length: AI_ANSWERS_LIMITS.maxPageSize + 1 }, () => ({})) }) as unknown as AiAnswersListAnswer),
      run: vi.fn(async () => ({ status: 'ok', answer: { ...RECORD, citations: [{ url: 'https://x.example/', title: 'x', key: 'k' }] } }) as unknown as AiAnswersRunAnswer),
    });
    const ctx = ctxFor(leaky);
    for (const name of ['view', 'get', 'list', 'run']) expect((await errorOf(call(ctx, name, PROCEDURES[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    // Results outside their fixed sets fall back; booleans stay booleans; a missing answer is `null`.
    const odd = fakeService({ setVia: vi.fn(async () => 'maybe' as never), delete: vi.fn(async () => 'yes' as never), get: vi.fn(async () => null) });
    expect(await call(ctxFor(odd), 'setVia', PROCEDURES.setVia)).toBe('failed');
    expect(await call(ctxFor(odd), 'delete', PROCEDURES.delete)).toBe(false);
    expect(await call(ctxFor(odd), 'get', PROCEDURES.get)).toBeNull();
  });
});
