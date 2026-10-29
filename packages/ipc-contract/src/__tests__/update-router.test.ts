// Spec: specs/update-router.schema.ts (UpdateWatchInputSchema, UpdateSetChecksInputSchema, UpdateNoInputSchema),
// specs/update-client.spec.ts (UpdateState), specs/ipc-sender.spec.ts, specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/update-client.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import type { UpdateChecks, UpdateState } from '@app/specs/update-client.spec';
import { appRouter, createSenderPolicy, enforceSender, type IpcContext, type UpdateService } from '../index';

afterEach(() => vi.useRealTimers());

const WINDOW_ID = 7;
const state = (version: number, checks: UpdateChecks = 'on'): UpdateState => ({ version, currentVersion: '1.2.0', checks, lastCheckedAt: null, status: { kind: 'idle' } });

function fakeUpdate() {
  let release: ((s: UpdateState) => void) | null = null;
  const update = {
    state: vi.fn(() => state(3)),
    watch: vi.fn((since: number, signal?: AbortSignal) =>
      since < 3
        ? Promise.resolve(state(3))
        : new Promise<UpdateState>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(state(3)));
          }),
    ),
    check: vi.fn(async () => state(4)),
    download: vi.fn(async () => state(5)),
    skip: vi.fn(async () => state(6)),
    setChecks: vi.fn(async (checks: UpdateChecks) => state(7, checks)),
    install: vi.fn(async () => true),
  } satisfies UpdateService;
  return { update, push: (s: UpdateState) => release?.(s) };
}

function ctxFor(update: UpdateService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: update === undefined ? {} : { update },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { update: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.update[name];
  if (!fn) throw new Error(`no update.${name}`);
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
  watch: { sinceVersion: -1 },
  check: undefined,
  download: undefined,
  skip: undefined,
  setChecks: { checks: 'off' },
  install: undefined,
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (update: ReturnType<typeof fakeUpdate>['update']) => {
  for (const fn of Object.values(update)) expect(fn).not.toHaveBeenCalled();
};

describe('update router', () => {
  test('every-update-procedure-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('update.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `update.${n}`).sort());
    // Structural: `enforceSender` is each procedure's first middleware, before the input parser and `requireUpdate`.
    const [guard] = enforceSender._middlewares;
    for (const path of paths) {
      const { middlewares } = (appRouter._def.procedures as unknown as Record<string, { _def: { middlewares: unknown[] } }>)[path]!._def;
      expect(middlewares[0], path).toBe(guard);
    }
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'file://']) {
        const { update } = fakeUpdate();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined, { sinceVersion: 0 }, { checks: 'on' }]) {
          expect((await errorOf(procedure(ctxFor(update, origin), name)(input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        // Refused before the service is touched (not even `state()`).
        untouched(update);
      }
    }
  });

  test('update-without-service-fails-closed', async () => {
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    const { update } = fakeUpdate();
    await expect(procedure(ctxFor(update), 'check')()).resolves.toMatchObject({ version: 4 });
    await expect(procedure(ctxFor(update), 'download')()).resolves.toMatchObject({ version: 5 });
    await expect(procedure(ctxFor(update), 'skip')()).resolves.toMatchObject({ version: 6 });
    await expect(procedure(ctxFor(update), 'setChecks')({ checks: 'off' })).resolves.toMatchObject({ version: 7, checks: 'off' });
    expect(update.setChecks).toHaveBeenCalledWith('off');
    await expect(procedure(ctxFor(update), 'install')()).resolves.toBe(true);
    // Only a real `true` from the service is `true`.
    update.install.mockResolvedValueOnce('yes' as unknown as boolean);
    await expect(procedure(ctxFor(update), 'install')()).resolves.toBe(false);
  });

  test('update-inputs-validated', async () => {
    const bad: Record<string, unknown[]> = {
      watch: [{}, { sinceVersion: -2 }, { sinceVersion: 1.5 }, { sinceVersion: '3' }, { sinceVersion: Number.MAX_SAFE_INTEGER + 2 }, { sinceVersion: Number.NaN }, { sinceVersion: 0, extra: 1 }, undefined],
      check: [{}, { force: true }, 0, null, 'now'],
      download: [{}, { url: 'https://evil.test/frost.exe' }, null],
      skip: [{}, { version: '9.9.9' }, null],
      setChecks: [{}, { checks: 'never' }, { checks: true }, { checks: 'off', extra: 1 }, undefined],
      install: [{}, { path: '/bin/sh' }, null, 'open'],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const { update } = fakeUpdate();
        expect((await errorOf(procedure(ctxFor(update), name)(input))).code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(update);
      }
    }
  });

  test('update-watch-long-polls', async () => {
    const { update, push } = fakeUpdate();
    await expect(procedure(ctxFor(update), 'watch')({ sinceVersion: -1 })).resolves.toMatchObject({ version: 3 });
    const waiting = procedure(ctxFor(update), 'watch')({ sinceVersion: 3 });
    await vi.waitFor(() => expect(update.watch).toHaveBeenCalledTimes(2));
    push(state(4));
    await expect(waiting).resolves.toMatchObject({ version: 4 });
    // Nothing changes: the current state after WATCH_TIMEOUT_MS, the waiter released.
    vi.useFakeTimers();
    const idle = procedure(ctxFor(update), 'watch')({ sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS - 1);
    expect(update.state).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(idle).resolves.toMatchObject({ version: 3 });
    expect(update.state).toHaveBeenCalledTimes(1);
    const signal = update.watch.mock.calls.at(-1)?.[1];
    expect(signal?.aborted).toBe(true);
  });
});
