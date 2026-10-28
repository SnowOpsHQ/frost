// Spec: specs/serp-service.schema.ts (SerpTabInputSchema, SerpWatchInputSchema, SerpOutlinesInputSchema,
// SerpClassifyInputSchema, SerpTabStateSchema), specs/serp-service.spec.ts, specs/ipc-sender.spec.ts,
// specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/serp-overlay.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import type { IntentAnswer, IntentEnableOutcome, IntentState } from '@app/specs/intent-classifier.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import type { PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import { SerpTabStateSchema, type PackStatus, type SerpTabState } from '@app/specs/serp-service.schema';
import { appRouter, createSenderPolicy, type IpcContext, type SerpService } from '../index';

afterEach(() => vi.useRealTimers());

const WINDOW_ID = 7;
const PACK: PackStatus = { state: 'ready', version: 3, source: 'bundled', published: '2026-10-28', lastUpdate: null, checking: false };
const state = (version: number): SerpTabState => ({ version, tabId: 1, serp: { status: 'not-serp', tabId: 1, url: 'https://example.com/' }, outlines: false, intent: null, pack: PACK });

function fakeSerp() {
  let release: ((s: SerpTabState) => void) | null = null;
  const serp = {
    state: vi.fn((_tabId: number) => state(3)),
    watch: vi.fn((_tabId: number, since: number, signal?: AbortSignal) =>
      since < 3
        ? Promise.resolve(state(3))
        : new Promise<SerpTabState>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(state(3)));
          }),
    ),
    setOutlines: vi.fn((tabId: number, on: boolean) => tabId === 1 && on),
    packStatus: vi.fn(() => PACK),
    checkPackUpdate: vi.fn(async (): Promise<PackUpdateOutcome> => 'not-newer'),
    intentState: vi.fn((): IntentState => 'model-missing'),
    enableIntent: vi.fn(async (): Promise<IntentEnableOutcome> => 'ready'),
    classify: vi.fn(async (_query: string): Promise<IntentAnswer> => ({ state: 'model-missing' })),
  } satisfies SerpService;
  return { serp, push: (s: SerpTabState) => release?.(s) };
}

function ctxFor(serp: SerpService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: serp === undefined ? {} : { serp },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { serp: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.serp[name];
  if (!fn) throw new Error(`no serp.${name}`);
  return fn;
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const VALID_INPUT: Record<string, unknown> = {
  watch: { tabId: 1, sinceVersion: -1 },
  state: { tabId: 1 },
  setOutlines: { tabId: 1, on: true },
  packStatus: undefined,
  checkPackUpdate: undefined,
  intentState: undefined,
  enableIntent: undefined,
  classify: { query: 'best running shoes' },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (serp: ReturnType<typeof fakeSerp>['serp']) => {
  for (const fn of Object.values(serp)) expect(fn).not.toHaveBeenCalled();
};

describe('serp router', () => {
  test('serp-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('serp.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `serp.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const { serp } = fakeSerp();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          expect((await errorOf(procedure(ctxFor(serp, origin), name)(input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(serp);
      }
    }
    // A sender that is not one of the app's windows, or not its main frame, is refused too.
    const { serp } = fakeSerp();
    const foreign: IpcContext = { ...ctxFor(serp), sender: { origin: APP_ORIGIN, live: true, windowId: 99, isWindowContents: true, isMainFrame: true } };
    const subframe: IpcContext = { ...ctxFor(serp), sender: { origin: APP_ORIGIN, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: false } };
    for (const name of PROCEDURES) {
      for (const ctx of [foreign, subframe]) expect((await errorOf(procedure(ctx, name)(VALID_INPUT[name]))).code, name).toBe(IPC_SENDER_ERROR_CODE);
    }
    untouched(serp);
  });

  test('serp-inputs-validated', async () => {
    const bad: Record<string, unknown[]> = {
      watch: [{ tabId: 1 }, { tabId: 1, sinceVersion: -2 }, { tabId: 1, sinceVersion: 1.5 }, { tabId: 0, sinceVersion: 0 }, { tabId: 1, sinceVersion: 0, extra: 1 }, undefined],
      state: [{ tabId: 0 }, { tabId: -1 }, { tabId: '1' }, { tabId: 1, url: 'https://www.google.com/search?q=x' }, {}, undefined],
      setOutlines: [{ tabId: 1 }, { tabId: 1, on: 'yes' }, { tabId: 0, on: true }, { tabId: 1, on: true, layout: { results: 'body' } }, undefined],
      classify: [{}, { query: 1 }, { query: 'x'.repeat(10_000) }, { query: 'x', model: 'other' }, undefined],
    };
    for (const name of Object.keys(bad)) {
      for (const input of bad[name]!) {
        const { serp } = fakeSerp();
        expect((await errorOf(procedure(ctxFor(serp), name)(input))).code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(serp);
      }
    }
  });

  test('serp-without-service-fail-closed', async () => {
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    const { serp } = fakeSerp();
    const ctx = ctxFor(serp);
    await expect(procedure(ctx, 'state')({ tabId: 1 })).resolves.toEqual(state(3));
    expect(SerpTabStateSchema.safeParse(state(3)).success).toBe(true);
    await expect(procedure(ctx, 'setOutlines')({ tabId: 1, on: true })).resolves.toBe(true);
    await expect(procedure(ctx, 'setOutlines')({ tabId: 2, on: true })).resolves.toBe(false);
    expect(serp.setOutlines).toHaveBeenLastCalledWith(2, true);
    await expect(procedure(ctx, 'packStatus')()).resolves.toEqual(PACK);
    await expect(procedure(ctx, 'checkPackUpdate')()).resolves.toBe('not-newer');
    await expect(procedure(ctx, 'intentState')()).resolves.toBe('model-missing');
    await expect(procedure(ctx, 'enableIntent')()).resolves.toBe('ready');
    await expect(procedure(ctx, 'classify')({ query: 'best running shoes' })).resolves.toEqual({ state: 'model-missing' });
    expect(serp.classify).toHaveBeenCalledWith('best running shoes');
  });

  test('serp-watch-long-polls', async () => {
    const { serp, push } = fakeSerp();
    await expect(procedure(ctxFor(serp), 'watch')({ tabId: 1, sinceVersion: -1 })).resolves.toMatchObject({ version: 3 });
    const waiting = procedure(ctxFor(serp), 'watch')({ tabId: 1, sinceVersion: 3 });
    await vi.waitFor(() => expect(serp.watch).toHaveBeenCalledTimes(2));
    push(state(4));
    await expect(waiting).resolves.toMatchObject({ version: 4 });
    // Nothing changes: the current state after WATCH_TIMEOUT_MS, the waiter released.
    vi.useFakeTimers();
    const idle = procedure(ctxFor(serp), 'watch')({ tabId: 1, sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS - 1);
    expect(serp.state).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(idle).resolves.toMatchObject({ version: 3 });
    expect(serp.state).toHaveBeenCalledWith(1);
    const signal = serp.watch.mock.calls.at(-1)![2];
    expect(signal?.aborted).toBe(true);
  });
});
