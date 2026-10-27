// Spec: specs/devtools.schema.ts (the devtools.* inputs), specs/devtools.spec.ts (COOKIE_LIMITS, DEVTOOLS_WATCH_TIMEOUT_MS), specs/ipc-sender.spec.ts
// Acceptance: specs/devtools.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { COOKIE_LIMITS, DEVTOOLS_WATCH_TIMEOUT_MS, type NetworkLogAnswer } from '@app/specs/devtools.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type DevtoolsService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const NETWORK: NetworkLogAnswer = { status: 'ready', tabId: 1, pageUrl: 'https://example.com/', entries: [], dropped: 0, notKept: 0, preserve: false };

function fakeDevtools() {
  return {
    version: vi.fn((_tabId: number) => 3),
    watch: vi.fn(async (_tabId: number, _since: number, _signal: AbortSignal) => 4),
    network: vi.fn((_tabId: number) => NETWORK),
    redirects: vi.fn((_tabId: number) => ({ status: 'none' as const })),
    console: vi.fn((_tabId: number) => ({ status: 'ready' as const, entries: [], total: 0, dropped: 0 })),
    storage: vi.fn(async (_tabId: number) => ({ status: 'no-page' as const })),
    revealCookie: vi.fn(async (tabId: number, _cookie: { name: string; domain: string; path: string }) => tabId === 1),
    clearSiteData: vi.fn(async (_tabId: number) => 'cancelled' as const),
    setOpen: vi.fn((_windowId: number | null, _open: boolean) => undefined),
    setPreserveLog: vi.fn((tabId: number, _preserve: boolean) => tabId === 1),
  } satisfies DevtoolsService;
}

function ctxFor(devtools: DevtoolsService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: devtools === undefined ? {} : { devtools },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { devtools: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.devtools[name];
  if (!fn) throw new Error(`no devtools.${name}`);
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

const COOKIE = { name: 'sid', domain: 'example.com', path: '/' };
const VALID_INPUT: Record<string, unknown> = {
  watch: { tabId: 1, sinceVersion: 0 },
  network: { tabId: 1 },
  redirects: { tabId: 1 },
  console: { tabId: 1 },
  storage: { tabId: 1 },
  revealCookie: { tabId: 1, ...COOKIE },
  clearSiteData: { tabId: 1 },
  setOpen: { open: true },
  setPreserveLog: { tabId: 1, preserve: true },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (devtools: ReturnType<typeof fakeDevtools>) => {
  for (const fn of Object.values(devtools)) expect(fn).not.toHaveBeenCalled();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('devtools router', () => {
  test('devtools-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('devtools.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `devtools.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const devtools = fakeDevtools();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          const error = await errorOf(procedure(ctxFor(devtools, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(devtools);
      }
    }
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('devtools-inputs-validated', async () => {
    const badTab = [{ tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, {}, undefined, { tabId: 1, extra: true }];
    const bad: Record<string, unknown[]> = {
      watch: [...badTab.map((t) => ({ sinceVersion: 0, ...(t as object) })), { tabId: 1 }, { tabId: 1, sinceVersion: -1 }, { tabId: 1, sinceVersion: 0.5 }],
      network: badTab,
      redirects: badTab,
      console: badTab,
      storage: badTab,
      clearSiteData: [...badTab, { tabId: 1, origin: 'https://evil.com' }],
      revealCookie: [
        { tabId: 1 },
        { tabId: 1, name: 'sid', domain: 'example.com' },
        { tabId: 1, ...COOKIE, name: 'n'.repeat(COOKIE_LIMITS.maxNameChars + 1) },
        { tabId: 1, ...COOKIE, domain: 'd'.repeat(COOKIE_LIMITS.maxDomainChars + 1) },
        { tabId: 1, ...COOKIE, path: '/'.repeat(COOKIE_LIMITS.maxPathChars + 1) },
        { tabId: 1, ...COOKIE, value: 'x' },
        { tabId: 0, ...COOKIE },
      ],
      setOpen: [{}, { open: 'yes' }, { open: true, windowId: 3 }, undefined],
      setPreserveLog: [{ tabId: 1 }, { tabId: 1, preserve: 1 }, { tabId: 0, preserve: true }, { tabId: 1, preserve: true, all: true }],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const devtools = fakeDevtools();
        const error = await errorOf(procedure(ctxFor(devtools), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(devtools);
      }
    }
  });

  test('devtools-procedures-call-the-service', async () => {
    const devtools = fakeDevtools();
    const call = (name: string) => procedure(ctxFor(devtools), name)(VALID_INPUT[name]);
    await expect(call('watch')).resolves.toBe(4);
    expect(devtools.watch).toHaveBeenCalledWith(1, 0, expect.any(AbortSignal));
    // The waiter is released once answered.
    expect(devtools.watch.mock.calls[0]![2].aborted).toBe(true);
    await expect(call('network')).resolves.toEqual(NETWORK);
    expect(devtools.network).toHaveBeenCalledExactlyOnceWith(1);
    await expect(call('redirects')).resolves.toEqual({ status: 'none' });
    await expect(call('console')).resolves.toEqual({ status: 'ready', entries: [], total: 0, dropped: 0 });
    await expect(call('storage')).resolves.toEqual({ status: 'no-page' });
    await expect(call('revealCookie')).resolves.toBe(true);
    expect(devtools.revealCookie).toHaveBeenCalledExactlyOnceWith(1, COOKIE);
    await expect(procedure(ctxFor(devtools), 'revealCookie')({ tabId: 2, ...COOKIE })).resolves.toBe(false);
    await expect(call('clearSiteData')).resolves.toBe('cancelled');
    expect(devtools.clearSiteData).toHaveBeenCalledExactlyOnceWith(1);
    await expect(call('setOpen')).resolves.toBeNull();
    // The sender's own window, never one the chrome names.
    expect(devtools.setOpen).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, true);
    await expect(call('setPreserveLog')).resolves.toBe(true);
    expect(devtools.setPreserveLog).toHaveBeenCalledExactlyOnceWith(1, true);

    // `watch` times out with the current version.
    vi.useFakeTimers();
    devtools.watch.mockImplementationOnce(() => new Promise<number>(() => undefined));
    const pending = call('watch');
    await vi.advanceTimersByTimeAsync(DEVTOOLS_WATCH_TIMEOUT_MS);
    await expect(pending).resolves.toBe(3);
    expect(devtools.version).toHaveBeenCalledWith(1);
  });
});
