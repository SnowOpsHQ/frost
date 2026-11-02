// Spec: specs/ai-checks.schema.ts (AiChecksStateSchema, AiChecksTabInputSchema, AiChecksWatchInputSchema,
// AiChecksSetModeInputSchema, AiChecksCheckNowInputSchema, AiChecksModeSchema), specs/ai-checks.spec.ts (AI_CHECK_MODES),
// specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/ai-checks.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import type { AiCheckMode } from '@app/specs/ai-checks.spec';
import type { AiChecksState } from '@app/specs/ai-checks.schema';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type AiChecksService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const URL_A = 'https://www.example.com/tea';
const READY: AiChecksState = {
  version: 4,
  tabId: 1,
  mode: 'on-request',
  model: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' },
  url: URL_A,
  check: {
    status: 'ready',
    cached: false,
    result: {
      url: URL_A,
      inputHash: 'c'.repeat(64),
      modelId: 'anthropic/claude-sonnet-5-5',
      checkedAt: 1_000,
      output: { pageType: 'article', intent: 'informational', quality: 'strong', qualityReason: 'Clear steps.', suggestedTarget: 'brew green tea' },
    },
  },
};

function fakeAiChecks(state: AiChecksState = READY) {
  return {
    state: vi.fn((_tabId: number): AiChecksState => state),
    watch: vi.fn(async (_tabId: number, _since: number): Promise<AiChecksState> => state),
    setMode: vi.fn(async (mode: AiCheckMode): Promise<AiCheckMode> => mode),
    checkNow: vi.fn(async (_tabId: number, _again: boolean) => true),
  } satisfies AiChecksService;
}

/** Every aiChecks procedure, its type and a valid input. */
const PROCEDURES: Record<string, { type: 'query' | 'mutation'; input: unknown }> = {
  state: { type: 'query', input: { tabId: 1 } },
  watch: { type: 'query', input: { tabId: 1, sinceVersion: -1 } },
  setMode: { type: 'mutation', input: { mode: 'automatic' } },
  checkNow: { type: 'mutation', input: { tabId: 1 } },
};

function ctxFor(aiChecks: AiChecksService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: aiChecks === undefined ? {} : { aiChecks },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { aiChecks: Record<string, (input?: unknown) => Promise<unknown>> }).aiChecks;
  const fn = caller[name];
  if (!fn) throw new Error(`no aiChecks.${name}`);
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

describe('aiChecks router', () => {
  test('enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('aiChecks.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `aiChecks.${n}`).sort());
    for (const [name, { type, input }] of Object.entries(PROCEDURES)) {
      expect((appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)[`aiChecks.${name}`]?._def.type, name).toBe(type);
      // The sender is checked before anything (even a bad input, even the service).
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'app://evil']) {
        const aiChecks = fakeAiChecks();
        for (const given of [input, { bogus: true }, undefined]) expect((await errorOf(call(ctxFor(aiChecks, origin), name, given))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        for (const fn of Object.values(aiChecks)) expect(fn, name).not.toHaveBeenCalled();
      }
      // Without the service: a masked internal error.
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    // The answers, from the app's own window.
    const aiChecks = fakeAiChecks();
    await expect(call(ctxFor(aiChecks), 'state', { tabId: 1 })).resolves.toEqual(READY);
    await expect(call(ctxFor(aiChecks), 'watch', { tabId: 1, sinceVersion: 3 })).resolves.toEqual(READY);
    expect(aiChecks.watch).toHaveBeenCalledWith(1, 3, expect.any(AbortSignal));
    await expect(call(ctxFor(aiChecks), 'setMode', { mode: 'automatic' })).resolves.toBe('automatic');
    expect(aiChecks.setMode).toHaveBeenCalledExactlyOnceWith('automatic');
    await expect(call(ctxFor(aiChecks), 'checkNow', { tabId: 1 })).resolves.toBe(true);
    await expect(call(ctxFor(aiChecks), 'checkNow', { tabId: 1, again: true })).resolves.toBe(true);
    expect(aiChecks.checkNow.mock.calls).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  test('outputs-strict', async () => {
    // Strict inputs: nothing more, nothing malformed reaches the service.
    const bad: Record<string, unknown[]> = {
      state: [{}, { tabId: 0 }, { tabId: 1.5 }, { tabId: '1' }, { tabId: 1, url: URL_A }],
      watch: [{ tabId: 1 }, { tabId: 1, sinceVersion: -2 }, { tabId: 1, sinceVersion: 0, extra: 1 }],
      setMode: [{}, { mode: 'always' }, { mode: 'automatic', consented: true }, { mode: 'off', windowId: 1 }],
      checkNow: [{}, { tabId: 1, again: 'yes' }, { tabId: 1, route: 'gateway' }, { tabId: 1, modelId: 'openai/gpt-5' }, { tabId: 1, input: 'page text' }],
    };
    for (const [name, inputs] of Object.entries(bad)) {
      for (const input of inputs) {
        const aiChecks = fakeAiChecks();
        expect((await errorOf(call(ctxFor(aiChecks), name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
        for (const fn of Object.values(aiChecks)) expect(fn).not.toHaveBeenCalled();
      }
    }
    // Strict outputs: a state carrying anything more (a key riding along), or a malformed answer, is masked.
    const leaks: AiChecksState[] = [
      { ...READY, apiKey: 'sk-ant-secret' } as never,
      { ...READY, model: { ...READY.model!, key: 'sk-ant-secret' } } as never,
      { ...READY, check: { ...READY.check, input: 'page text' } } as never,
      { ...READY, check: { status: 'ready', cached: false, result: { ...(READY.check as { result: object }).result, output: { ...(READY.check as { result: { output: object } }).result.output, html: '<a href=x>' } } } } as never,
      { ...READY, check: { status: 'unavailable', reason: 'because' } } as never,
      { ...READY, mode: 'always' } as never,
    ];
    for (const state of leaks) {
      for (const name of ['state', 'watch']) {
        const error = await errorOf(call(ctxFor(fakeAiChecks(state)), name, PROCEDURES[name]!.input));
        expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
        expect(error.message).not.toContain('sk-ant-secret');
      }
    }
    const odd = fakeAiChecks();
    odd.setMode.mockResolvedValueOnce('everything' as never);
    expect((await errorOf(call(ctxFor(odd), 'setMode', { mode: 'automatic' }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    // A non-boolean answer to checkNow is read as false, never forwarded.
    odd.checkNow.mockResolvedValueOnce({ started: true } as never);
    await expect(call(ctxFor(odd), 'checkNow', { tabId: 1 })).resolves.toBe(false);
  });
});
