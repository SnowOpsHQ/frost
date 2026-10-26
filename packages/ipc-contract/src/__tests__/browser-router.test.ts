// Spec: specs/browser.spec.ts (WATCH_TIMEOUT_MS, schemas), specs/ipc-sender.spec.ts
// Acceptance: specs/browser-chrome.feature.md (Router), specs/tabs.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADDRESS_INPUT_MAX_LENGTH, WATCH_TIMEOUT_MS, type BrowserState } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type BrowserService, type IpcContext } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;

function stateAt(version: number): BrowserState {
  return {
    version,
    tabs: [{ id: 1, url: 'https://example.com/', title: 'Example', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false }],
    activeTabId: 1,
    focusAddressBarSeq: 0,
    notice: null,
  };
}

function fakeService(version = 3) {
  let current = stateAt(version);
  let release: ((state: BrowserState) => void) | undefined;
  const service = {
    navigate: vi.fn((input: string) => input.trim() !== ''),
    newTab: vi.fn((): number | null => 2),
    closeTab: vi.fn((tabId: number) => tabId === 1),
    activateTab: vi.fn((tabId: number) => tabId === 1),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    setPageBounds: vi.fn(),
    getState: vi.fn(() => current),
    watch: vi.fn(
      (_since: number, _signal?: AbortSignal) =>
        new Promise<BrowserState>((resolve) => {
          release = resolve;
        }),
    ),
  } satisfies BrowserService;
  return {
    service,
    setState: (next: BrowserState) => {
      current = next;
    },
    /** Resolves the pending service watch, as a state change would. */
    change: (next: BrowserState) => {
      current = next;
      release?.(next);
    },
  };
}

function ctxFor(browser: BrowserService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: browser === undefined ? {} : { browser },
  };
}

/** `appRouter.browser.<name>` through a caller, as a plain function. */
function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { browser: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.browser[name];
  if (!fn) throw new Error(`no browser.${name}`);
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
  navigate: { input: 'example.com' },
  newTab: undefined,
  closeTab: { tabId: 1 },
  activateTab: { tabId: 1 },
  back: undefined,
  forward: undefined,
  reload: undefined,
  stop: undefined,
  setPageBounds: { x: 0, y: 48, width: 1280, height: 720 },
  watch: { sinceVersion: 0 },
};
const BROWSER_PROCEDURES = Object.keys(VALID_INPUT);

describe('browser router', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('browser-procedures-reject-foreign-sender-first', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('browser.'));
    expect(paths.sort()).toEqual(BROWSER_PROCEDURES.map((n) => `browser.${n}`).sort());
    for (const name of BROWSER_PROCEDURES) {
      const { service } = fakeService();
      const foreign = ctxFor(service, 'https://evil.com');
      // Malformed input too: the sender check runs before input parsing.
      for (const input of [VALID_INPUT[name], { bogus: true }, 42]) {
        const error = await errorOf(procedure(foreign, name)(input));
        expect(error.code, name).toBe(IPC_SENDER_ERROR_CODE);
      }
      for (const fn of Object.values(service)) expect(fn, name).not.toHaveBeenCalled();
    }
  });

  test('browser-procedures-validate-input', async () => {
    const malformed: Record<string, unknown[]> = {
      navigate: [undefined, 'example.com', { input: 1 }, { input: 'a', extra: 1 }, { input: 'x'.repeat(ADDRESS_INPUT_MAX_LENGTH + 1) }],
      setPageBounds: [
        undefined,
        { x: 0, y: 0, width: 1 },
        { x: 0, y: 0, width: Number.NaN, height: 1 },
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
        { x: '0', y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: 1, height: 1, z: 1 },
      ],
      watch: [undefined, { sinceVersion: -1 }, { sinceVersion: 1.5 }, { sinceVersion: '1' }, { sinceVersion: 1, extra: true }],
    };
    for (const [name, inputs] of Object.entries(malformed)) {
      for (const input of inputs) {
        const { service } = fakeService();
        const error = await errorOf(procedure(ctxFor(service), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      }
    }
    // An address of exactly the maximum length is accepted.
    const { service } = fakeService();
    await procedure(ctxFor(service), 'navigate')({ input: 'x'.repeat(ADDRESS_INPUT_MAX_LENGTH) });
    expect(service.navigate).toHaveBeenCalledTimes(1);
  });

  test('browser-procedures-call-service', async () => {
    const { service } = fakeService();
    const ctx = ctxFor(service);
    await procedure(ctx, 'navigate')({ input: 'example.com' });
    expect(service.navigate).toHaveBeenCalledExactlyOnceWith('example.com');
    for (const name of ['back', 'forward', 'reload', 'stop'] as const) {
      await procedure(ctx, name)();
      expect(service[name], name).toHaveBeenCalledTimes(1);
    }
    await procedure(ctx, 'setPageBounds')({ x: 0.5, y: 48, width: 1280, height: 720 });
    expect(service.setPageBounds).toHaveBeenCalledExactlyOnceWith({ x: 0.5, y: 48, width: 1280, height: 720 });
  });

  test('navigate-reports-whether-it-navigated', async () => {
    const { service } = fakeService();
    await expect(procedure(ctxFor(service), 'navigate')({ input: 'example.com' })).resolves.toBe(true);
    await expect(procedure(ctxFor(service), 'navigate')({ input: '   ' })).resolves.toBe(false);
  });

  test('tab-procedures-validate-tab-id', async () => {
    const malformed = [
      undefined,
      1,
      {},
      { tabId: 0 },
      { tabId: -1 },
      { tabId: 1.5 },
      { tabId: '1' },
      { tabId: Number.MAX_SAFE_INTEGER + 1 },
      { tabId: Number.NaN },
      { tabId: 1, extra: true },
      { id: 1 },
    ];
    for (const name of ['closeTab', 'activateTab']) {
      for (const input of malformed) {
        const { service } = fakeService();
        const error = await errorOf(procedure(ctxFor(service), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
      }
    }
  });

  test('tab-procedures-call-service', async () => {
    const { service } = fakeService();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'newTab')()).resolves.toBe(2);
    expect(service.newTab).toHaveBeenCalledTimes(1);
    service.newTab.mockReturnValueOnce(null);
    await expect(procedure(ctx, 'newTab')()).resolves.toBeNull();

    for (const name of ['closeTab', 'activateTab'] as const) {
      await expect(procedure(ctx, name)({ tabId: 1 }), name).resolves.toBe(true);
      expect(service[name]).toHaveBeenLastCalledWith(1);
      // An id that names no open tab is the service's no-op: `false`, not an error.
      await expect(procedure(ctx, name)({ tabId: 99 }), name).resolves.toBe(false);
      expect(service[name]).toHaveBeenLastCalledWith(99);
    }
  });

  test('missing-browser-service-is-internal-error', async () => {
    for (const name of BROWSER_PROCEDURES) {
      const error = await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });
});

describe('browser.watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('watch-returns-immediately-when-newer', async () => {
    const { service } = fakeService(3);
    await expect(procedure(ctxFor(service), 'watch')({ sinceVersion: 2 })).resolves.toEqual(stateAt(3));
    await expect(procedure(ctxFor(service), 'watch')({ sinceVersion: 0 })).resolves.toEqual(stateAt(3));
    expect(service.watch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('watch-resolves-on-version-change', async () => {
    const fake = fakeService(3);
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.service.watch).toHaveBeenCalledTimes(1);
    expect(fake.service.watch.mock.calls[0]?.[0]).toBe(3);
    fake.change(stateAt(4));
    await expect(pending).resolves.toEqual(stateAt(4));
    // The timeout is cleared and the service's watcher released.
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.service.watch.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  test('watch-times-out-with-current-state', async () => {
    const fake = fakeService(3);
    let result: unknown;
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 3 }).then((state) => {
      result = state;
    });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    // The state may have changed without the service's watch resolving (e.g. a missed wake-up):
    // the timeout answers with whatever is current then, not the state at call time.
    const later = { ...stateAt(3), tabs: [{ ...stateAt(3).tabs[0]!, title: 'Changed later' }] };
    fake.setState(later);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toEqual(later);
    expect(result).not.toEqual(stateAt(3));
    expect(fake.service.watch.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('watch-clamps-future-version-in-router', async () => {
    const fake = fakeService(3);
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 1_000_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.service.watch).toHaveBeenCalledTimes(1);
    expect(fake.service.watch.mock.calls[0]?.[0]).toBe(3);
    fake.change(stateAt(4));
    await expect(pending).resolves.toEqual(stateAt(4));
  });
});

describe('transport carries the browser service', () => {
  test('browser-procedures-call-service-over-transport', async () => {
    const { service } = fakeService(3);
    const sender = { id: 1, mainFrame: { frameTreeNodeId: 100 }, isDestroyed: () => false };
    const senderFrame = { origin: APP_ORIGIN, frameTreeNodeId: 100, parent: null, detached: false, isDestroyed: () => false };
    const window = { id: WINDOW_ID, webContents: sender, isDestroyed: () => false };
    const handle = createIpcRequestHandler({
      router: appRouter,
      policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
      fromWebContents: () => window,
      services: { browser: service },
    });
    expect(await handle({ sender, senderFrame }, { id: 1, type: 'query', path: 'browser.watch', input: { sinceVersion: 0 } })).toEqual({
      id: 1,
      result: { data: stateAt(3) },
    });
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'browser.navigate', input: { input: 'example.com' } })).toStrictEqual({
      result: { data: true },
    });
    // Other mutations answer `null` (never `undefined`, which a structured clone might drop).
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'browser.stop' })).toStrictEqual({ result: { data: null } });
    expect(service.navigate).toHaveBeenCalledExactlyOnceWith('example.com');
  });
});
