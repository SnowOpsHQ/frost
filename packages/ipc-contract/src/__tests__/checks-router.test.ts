// Spec: specs/seo-checks.schema.ts (ChecksTabInputSchema, ChecksWatchInputSchema, ChecksStopInputSchema),
// specs/seo-checks.spec.ts (ChecksState), specs/ipc-sender.spec.ts, specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/seo-checks.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { IDLE_HREFLANG_RUN, IDLE_LINK_RUN, IDLE_SITEMAP_RUN, type ChecksState } from '@app/specs/seo-checks.spec';
import { appRouter, createSenderPolicy, type ChecksService, type IpcContext } from '../index';

afterEach(() => vi.useRealTimers());

const WINDOW_ID = 7;
const state = (version: number): ChecksState => ({ version, tabId: 1, url: 'https://example.com/', links: IDLE_LINK_RUN, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN });

function fakeChecks() {
  let release: ((s: ChecksState) => void) | null = null;
  const checks = {
    state: vi.fn((_tabId: number) => state(3)),
    watch: vi.fn((_tabId: number, since: number, signal?: AbortSignal) =>
      since < 3
        ? Promise.resolve(state(3))
        : new Promise<ChecksState>((resolve) => {
            release = resolve;
            signal?.addEventListener('abort', () => resolve(state(3)));
          }),
    ),
    checkLinks: vi.fn((tabId: number) => tabId === 1),
    checkSitemaps: vi.fn((tabId: number) => tabId === 1),
    checkHreflang: vi.fn((tabId: number) => tabId === 1),
    stop: vi.fn((_tabId: number, _check: string) => true),
  } satisfies ChecksService;
  return { checks, push: (s: ChecksState) => release?.(s) };
}

function ctxFor(checks: ChecksService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: checks === undefined ? {} : { checks },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { checks: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.checks[name];
  if (!fn) throw new Error(`no checks.${name}`);
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
  checkLinks: { tabId: 1 },
  checkSitemaps: { tabId: 1 },
  checkHreflang: { tabId: 1 },
  stop: { tabId: 1, check: 'links' },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (checks: ReturnType<typeof fakeChecks>['checks']) => {
  for (const fn of Object.values(checks)) expect(fn).not.toHaveBeenCalled();
};

describe('checks router', () => {
  test('checks-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('checks.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `checks.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const { checks } = fakeChecks();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          expect((await errorOf(procedure(ctxFor(checks, origin), name)(input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(checks);
      }
    }
  });

  test('checks-inputs-validated', async () => {
    const bad: Record<string, unknown[]> = {
      watch: [{ tabId: 1 }, { tabId: 1, sinceVersion: -2 }, { tabId: 1, sinceVersion: 1.5 }, { tabId: 0, sinceVersion: 0 }, { tabId: 1, sinceVersion: 0, extra: 1 }, undefined],
      checkLinks: [{ tabId: 0 }, { tabId: -1 }, { tabId: '1' }, { tabId: 1, links: ['http://127.0.0.1/'] }, {}, undefined],
      checkSitemaps: [{ tabId: 0 }, { tabId: 1, url: 'https://evil.test/sitemap.xml' }, undefined],
      checkHreflang: [{ tabId: 1.5 }, { tabId: 1, alternates: [] }, undefined],
      stop: [{ tabId: 1 }, { tabId: 1, check: 'all' }, { tabId: 1, check: 'links', extra: true }, undefined],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const { checks } = fakeChecks();
        expect((await errorOf(procedure(ctxFor(checks), name)(input))).code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(checks);
      }
    }
  });

  test('checks-without-service-fail-closed', async () => {
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    const { checks } = fakeChecks();
    await expect(procedure(ctxFor(checks), 'checkLinks')({ tabId: 1 })).resolves.toBe(true);
    await expect(procedure(ctxFor(checks), 'checkSitemaps')({ tabId: 2 })).resolves.toBe(false);
    await expect(procedure(ctxFor(checks), 'checkHreflang')({ tabId: 1 })).resolves.toBe(true);
    await expect(procedure(ctxFor(checks), 'stop')({ tabId: 1, check: 'sitemaps' })).resolves.toBe(true);
    expect(checks.stop).toHaveBeenCalledWith(1, 'sitemaps');
  });

  test('checks-watch-long-polls', async () => {
    const { checks, push } = fakeChecks();
    await expect(procedure(ctxFor(checks), 'watch')({ tabId: 1, sinceVersion: -1 })).resolves.toMatchObject({ version: 3 });
    const waiting = procedure(ctxFor(checks), 'watch')({ tabId: 1, sinceVersion: 3 });
    await vi.waitFor(() => expect(checks.watch).toHaveBeenCalledTimes(2));
    push(state(4));
    await expect(waiting).resolves.toMatchObject({ version: 4 });
    // Nothing changes: the current state after WATCH_TIMEOUT_MS, the waiter released.
    vi.useFakeTimers();
    const idle = procedure(ctxFor(checks), 'watch')({ tabId: 1, sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS - 1);
    expect(checks.state).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(idle).resolves.toMatchObject({ version: 3 });
    expect(checks.state).toHaveBeenCalledWith(1);
  });
});
