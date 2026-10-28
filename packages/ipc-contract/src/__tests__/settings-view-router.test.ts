// Spec: specs/account-settings.schema.ts (SettingsViewWatchInputSchema, SettingsViewStateSchema), specs/ipc-sender.spec.ts,
// specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE), specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/account-settings.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SettingsViewState } from '@app/specs/account-settings.schema';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type SettingsViewService } from '../index';

const WINDOW_ID = 4;

function fakeService(seq = 0) {
  return {
    state: vi.fn((): SettingsViewState => ({ seq })),
    watch: vi.fn(async (since: number, _signal?: AbortSignal): Promise<SettingsViewState> => ({ seq: Math.max(seq, since + 1) })),
  } satisfies SettingsViewService;
}

function ctxFor(service: SettingsViewService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service === undefined ? {} : { settingsView: service },
  };
}

const watch = (ctx: IpcContext, input: unknown): Promise<unknown> =>
  (appRouter.createCaller(ctx) as unknown as { settingsView: { watch(input: unknown): Promise<unknown> } }).settingsView.watch(input);

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

afterEach(() => vi.useRealTimers());

describe('settings view router', () => {
  test('settings-view-procedures-enforce-sender', async () => {
    expect(Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('settingsView.'))).toEqual(['settingsView.watch']);
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
      const service = fakeService();
      expect((await errorOf(watch(ctxFor(service, origin), { sinceSeq: -1 }))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(service.watch).not.toHaveBeenCalled();
      expect(service.state).not.toHaveBeenCalled();
    }
    expect((await errorOf(watch(ctxFor(undefined), { sinceSeq: -1 }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    expect((appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)['settingsView.watch']?._def.type).toBe('query');
  });

  test('settings-view-watch-output-is-strict', async () => {
    const service = fakeService(3);
    expect(await watch(ctxFor(service), { sinceSeq: 7 })).toEqual({ seq: 8 });
    expect(service.watch).toHaveBeenCalledWith(7, expect.any(AbortSignal));

    // No change in time: the current state after WATCH_TIMEOUT_MS, and the waiter released.
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const waiting = fakeService(3);
    waiting.watch.mockImplementation((_since: number, s?: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const answer = watch(ctxFor(waiting), { sinceSeq: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    expect(await answer).toEqual({ seq: 3 });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();

    // Anything else in the answer is refused, not forwarded.
    for (const bad of [{ seq: 1, secret: 'x' }, { seq: -1 }, { seq: '1' }, {}]) {
      const poisoned = fakeService();
      poisoned.watch.mockResolvedValue(bad as unknown as SettingsViewState);
      expect((await errorOf(watch(ctxFor(poisoned), { sinceSeq: -1 }))).code, JSON.stringify(bad)).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    // The input is strict.
    for (const input of [undefined, {}, { sinceSeq: -2 }, { sinceSeq: 1.5 }, { sinceSeq: 0, window: 1 }]) {
      const fresh = fakeService();
      expect((await errorOf(watch(ctxFor(fresh), input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
      expect(fresh.watch).not.toHaveBeenCalled();
    }
  });
});
