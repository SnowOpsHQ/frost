// Spec: specs/ipc-transport.spec.ts · Acceptance: specs/ipc-transport.feature.md
import { createTRPCClient, TRPCClientError } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import {
  IPC_BAD_ENVELOPE_ERROR_CODE,
  IPC_BRIDGE_KEY,
  IPC_BRIDGE_METHODS,
  IPC_CHANNEL,
  IPC_INTERNAL_ERROR_CODE,
  IPC_MAX_PATH_LENGTH,
  IPC_UNKNOWN_PROCEDURE_ERROR_CODE,
  type IpcResponseEnvelope,
} from '@app/specs/ipc-transport.spec';
import { appRouter, createSenderPolicy, type AppRouter, type IpcContext, type SenderPolicy } from '../../index';
import { enforceSender, publicProcedure, router } from '../../trpc';
import { attachIpcHandler, createIpcRequestHandler, type IpcInvokeEventLike } from '../main';
import { createIpcBridge, exposeIpcBridge, type IpcBridge } from '../preload';
import { ipcLink } from '../renderer';

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined) },
}));
vi.mock('electron', () => ({ ...electron, default: electron }));

const WINDOW_ID = 7;
const MAIN_FRAME_ID = 100;

interface FakeSender {
  origin?: string;
  frame?: 'none';
  windowKnown?: boolean;
}

/** One Electron-shaped invoke: `event.sender`, `event.senderFrame`, and the window it belongs to. */
function fakeSender(s: FakeSender = {}) {
  const frameState = { origin: s.origin ?? APP_ORIGIN, destroyed: false };
  const sender = { id: 1, mainFrame: { frameTreeNodeId: MAIN_FRAME_ID }, isDestroyed: () => false };
  const senderFrame = {
    get origin() {
      return frameState.origin;
    },
    frameTreeNodeId: MAIN_FRAME_ID,
    parent: null,
    detached: false,
    isDestroyed: () => frameState.destroyed,
  };
  const window = { id: WINDOW_ID, webContents: sender, isDestroyed: () => false };
  const event: IpcInvokeEventLike<typeof sender> = { sender, senderFrame: s.frame === 'none' ? null : senderFrame };
  const policy = createSenderPolicy({ knownWindowIds: new Set(s.windowKnown === false ? [] : [WINDOW_ID]) });
  return { event, frameState, window, policy };
}

function handlerFor(s: FakeSender = {}, r: Parameters<typeof createIpcRequestHandler>[0]['router'] = appRouter) {
  const f = fakeSender(s);
  const handle = createIpcRequestHandler({ router: r, policy: f.policy, fromWebContents: () => f.window });
  return { ...f, handle, call: (envelope: unknown) => handle(f.event, envelope) };
}

function expectError(response: IpcResponseEnvelope, code: string): void {
  expect(response).not.toHaveProperty('result');
  expect(response).toHaveProperty('error.data.code', code);
}

const FORBIDDEN_ENVELOPE = {
  error: { message: IPC_SENDER_ERROR_CODE, code: -32003, data: { code: IPC_SENDER_ERROR_CODE, httpStatus: 403 } },
};

const INTERNAL_ERROR_ENVELOPE = {
  error: { message: IPC_INTERNAL_ERROR_CODE, code: -32603, data: { code: IPC_INTERNAL_ERROR_CODE, httpStatus: 500 } },
};

const MALFORMED_ENVELOPES: readonly unknown[] = [
  undefined,
  null,
  'ping',
  42,
  [],
  ['query', 'ping'],
  {},
  { path: 'ping' },
  { type: 'subscription', path: 'ping' },
  { type: 'QUERY', path: 'ping' },
  { type: 'query' },
  { type: 'query', path: 1 },
  { type: 'query', path: '' },
  { type: 'query', path: 'a'.repeat(IPC_MAX_PATH_LENGTH + 1) },
  { type: 'query', path: 'a..b' },
  { type: 'query', path: '../x' },
  { type: 'query', path: 'a b' },
  { type: 'query', path: '.ping' },
  { type: 'query', path: 'ping', id: { x: 1 } },
  { type: 'query', path: 'ping', extra: true },
];

/** A router with a procedure that fails unexpectedly, for masking tests. */
// A strict input whose refusal Zod would describe by quoting what was sent (an unrecognized key).
const strictRouter = router({
  echo: publicProcedure
    .use(enforceSender)
    .input(z.strictObject({ name: z.string().max(8) }))
    .query(({ input }) => input.name),
});

const boomRouter = router({
  boom: publicProcedure.use(enforceSender).query(() => {
    throw new Error('secret /etc/x');
  }),
});

/** A router whose error formatter itself throws: only the handler's last-resort catch is left. */
const brokenFormatter = initTRPC.context<IpcContext>().create({
  errorFormatter: () => {
    throw new Error('formatter /etc/x');
  },
});
const brokenFormatterRouter = brokenFormatter.router({
  boom: brokenFormatter.procedure.query(() => {
    throw new Error('secret /etc/x');
  }),
});

/** Procedures whose output Electron IPC could not serialize (structured clone). */
const uncloneableRouter = router({
  fn: publicProcedure.use(enforceSender).query(() => () => 1),
  withFn: publicProcedure.use(enforceSender).query(() => ({ ok: true, run: () => 1 })),
});

describe('main handler', () => {
  test('registers-one-fixed-channel', () => {
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() };
    const f = fakeSender();
    const detach = attachIpcHandler({ router: appRouter, policy: f.policy, ipcMain, fromWebContents: () => f.window });
    expect(ipcMain.handle).toHaveBeenCalledTimes(1);
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNEL, expect.any(Function));
    expect(ipcMain.on).not.toHaveBeenCalled();
    detach();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNEL);
  });

  test('ping-returns-pong', async () => {
    const { call } = handlerFor();
    expect(await call({ id: 3, type: 'query', path: 'ping' })).toEqual({ id: 3, result: { data: 'pong' } });
    expect(await call({ type: 'query', path: 'ping', input: undefined })).toEqual({ result: { data: 'pong' } });
  });

  test('captures-sender-before-await', async () => {
    const { handle, event, frameState } = handlerFor();
    const pending = handle(event, { type: 'query', path: 'ping' });
    // After the handler returned (and before anything it awaits settles) the frame navigates away.
    frameState.origin = 'https://evil.com';
    frameState.destroyed = true;
    expect(await pending).toEqual({ result: { data: 'pong' } });

    // The converse: the verdict is the one at receive time, not a later one.
    const late = handlerFor({ origin: 'https://evil.com' });
    const rejected = late.handle(late.event, { type: 'query', path: 'ping' });
    late.frameState.origin = APP_ORIGIN;
    expectError(await rejected, IPC_SENDER_ERROR_CODE);
  });

  test('null-sender-frame-is-forbidden', async () => {
    const { call } = handlerFor({ frame: 'none' });
    let response: Promise<IpcResponseEnvelope> | undefined;
    expect(() => {
      response = call({ type: 'query', path: 'ping' });
    }).not.toThrow();
    expect(await response).toEqual(FORBIDDEN_ENVELOPE);
  });

  test('foreign-origin-is-forbidden', async () => {
    expect(await handlerFor({ origin: 'https://evil.com' }).call({ type: 'query', path: 'ping' })).toEqual(
      FORBIDDEN_ENVELOPE,
    );
    expect(await handlerFor({ windowKnown: false }).call({ type: 'query', path: 'ping' })).toEqual(FORBIDDEN_ENVELOPE);
  });

  test('foreign-sender-learns-nothing', async () => {
    const { call } = handlerFor({ origin: 'https://evil.com' });
    for (const envelope of [
      { id: 1, type: 'query', path: 'ping' },
      { id: 2, type: 'query', path: 'nope' },
      { id: 3, type: 'mutation', path: 'ping' },
      ...MALFORMED_ENVELOPES,
    ]) {
      expect(await call(envelope), JSON.stringify(envelope)).toEqual(FORBIDDEN_ENVELOPE);
    }
  });

  test('rejects-malformed-envelope', async () => {
    const { call } = handlerFor();
    for (const envelope of MALFORMED_ENVELOPES) {
      const response = await call(envelope);
      expectError(response, IPC_BAD_ENVELOPE_ERROR_CODE);
      expect(response, JSON.stringify(envelope) ?? 'undefined').not.toHaveProperty('id');
    }
  });

  test('unknown-path-is-not-found', async () => {
    const { call } = handlerFor();
    for (const path of ['nope', 'ping.deeper', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expectError(await call({ id: 9, type: 'query', path }), IPC_UNKNOWN_PROCEDURE_ERROR_CODE);
    }
    const wrongType = await call({ id: 9, type: 'mutation', path: 'ping' });
    expectError(wrongType, IPC_UNKNOWN_PROCEDURE_ERROR_CODE);
    expect(wrongType).toHaveProperty('id', 9);
  });

  test('error-envelope-has-no-internals', async () => {
    const { call } = handlerFor();
    const responses = [
      await handlerFor({ frame: 'none' }).call({ type: 'query', path: 'ping' }),
      await call(null),
      await call({ type: 'query', path: 'nope' }),
      await handlerFor({}, boomRouter).call({ type: 'query', path: 'boom' }),
    ];
    for (const response of responses) {
      if (!('error' in response)) throw new Error('expected an error envelope');
      expect(Object.keys(response).filter((k) => k !== 'id')).toEqual(['error']);
      expect(Object.keys(response.error).sort()).toEqual(['code', 'data', 'message']);
      expect(Object.keys(response.error.data).filter((k) => k !== 'path').sort()).toEqual(['code', 'httpStatus']);
      expect(JSON.stringify(response)).not.toMatch(/stack|cause|\/etc\/x|node_modules|\.ts:/);
      expect(typeof response.error.code).toBe('number');
    }
  });

  test('internal-errors-are-masked', async () => {
    const response = await handlerFor({}, boomRouter).call({ type: 'query', path: 'boom' });
    expectError(response, IPC_INTERNAL_ERROR_CODE);
    expect(response).toHaveProperty('error.message', IPC_INTERNAL_ERROR_CODE);
  });

  test('input-errors-are-masked', async () => {
    // Phase 5 Task 6a review: a refused input's message is its code, never Zod's text.
    const { call } = handlerFor({}, strictRouter);
    for (const input of [{ name: 'ok', 'secret-key-sk-0123456789': 1 }, { name: 'secret-value-too-long' }, { name: 5 }]) {
      const response = await call({ type: 'query', path: 'echo', input });
      expectError(response, 'BAD_REQUEST');
      expect(response).toHaveProperty('error.message', 'BAD_REQUEST');
      expect(JSON.stringify(response)).not.toMatch(/secret|sk-0123|Unrecognized|expected/);
    }
    expect(await call({ type: 'query', path: 'echo', input: { name: 'ok' } })).toStrictEqual({ result: { data: 'ok' } });
  });

  test('uncloneable-output-is-internal-error', async () => {
    const { call } = handlerFor({}, uncloneableRouter);
    for (const path of ['fn', 'withFn']) {
      const response = await call({ id: 4, type: 'query', path });
      expectError(response, IPC_INTERNAL_ERROR_CODE);
      expect(response).toHaveProperty('error.message', IPC_INTERNAL_ERROR_CODE);
      expect(response).toHaveProperty('id', 4);
      // The envelope itself is what Electron clones back to the renderer.
      expect(() => structuredClone(response)).not.toThrow();
    }
  });

  test('handler-never-rejects', async () => {
    const throwingWindow = createIpcRequestHandler({
      router: appRouter,
      policy: fakeSender().policy,
      fromWebContents: () => {
        throw new Error('destroyed');
      },
    });
    const throwingEvent = {
      get sender(): never {
        throw new Error('destroyed');
      },
      senderFrame: null,
    };
    const throwingPolicy = createIpcRequestHandler({
      router: appRouter,
      policy: null as unknown as SenderPolicy,
      fromWebContents: () => null,
    });
    const { event, call } = handlerFor();
    const cases: Array<() => Promise<IpcResponseEnvelope>> = [
      () => throwingWindow(event, { type: 'query', path: 'ping' }),
      () => throwingWindow(throwingEvent as unknown as typeof event, { type: 'query', path: 'ping' }),
      () => throwingPolicy(event, { type: 'query', path: 'ping' }),
      () => handlerFor({}, boomRouter).call({ type: 'query', path: 'boom' }),
      () => handlerFor({}, brokenFormatterRouter).call({ type: 'query', path: 'boom' }),
      () => handlerFor({ origin: 'https://evil.com' }, brokenFormatterRouter).call({ type: 'query', path: 'boom' }),
      ...MALFORMED_ENVELOPES.map((envelope) => () => call(envelope)),
    ];
    for (const run of cases) {
      let pending: Promise<IpcResponseEnvelope> | undefined;
      expect(() => {
        pending = run();
      }).not.toThrow();
      await expect(pending).resolves.toHaveProperty('error');
    }
    expectError(await cases[0]!(), IPC_SENDER_ERROR_CODE);
    expectError(await cases[1]!(), IPC_SENDER_ERROR_CODE);
    expectError(await cases[2]!(), IPC_SENDER_ERROR_CODE);
    // A throwing error formatter falls through to the last-resort envelope.
    expect(await cases[4]!()).toEqual(INTERNAL_ERROR_ENVELOPE);
    expect(await cases[5]!()).toEqual(INTERNAL_ERROR_ENVELOPE);
  });
});

describe('preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('bridge-exposes-only-invoke', () => {
    const bridge = createIpcBridge(electron.ipcRenderer);
    expect(Object.keys(bridge)).toEqual([...IPC_BRIDGE_METHODS]);
    expect(Object.isFrozen(bridge)).toBe(true);
  });

  test('bridge-uses-fixed-channel', async () => {
    const response = { result: { data: 'pong' } };
    electron.ipcRenderer.invoke.mockResolvedValueOnce(response);
    const bridge = createIpcBridge(electron.ipcRenderer);
    const envelope = { type: 'query', path: 'ping' };
    // A page passing its own channel (or extra arguments) cannot change what is sent.
    const invoke = bridge.invoke as (...args: unknown[]) => Promise<unknown>;
    await expect(invoke(envelope, 'evil:chan', 1)).resolves.toBe(response);
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(electron.ipcRenderer.invoke.mock.calls[0]).toEqual([IPC_CHANNEL, envelope]);
  });

  test('exposes-bridge-under-fixed-key', () => {
    exposeIpcBridge();
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, IpcBridge];
    expect(key).toBe(IPC_BRIDGE_KEY);
    expect(Object.keys(bridge)).toEqual([...IPC_BRIDGE_METHODS]);
  });
});

describe('renderer link', () => {
  /** A bridge wired straight to the main handler, as preload + Electron IPC do for real. */
  function wiredBridge(s: FakeSender = {}): IpcBridge {
    const { handle, event } = handlerFor(s);
    return { invoke: async (envelope) => structuredClone(await handle(event, structuredClone(envelope))) };
  }

  test('client-round-trip', async () => {
    const client = createTRPCClient<AppRouter>({ links: [ipcLink({ bridge: wiredBridge() })] });
    await expect(client.ping.query()).resolves.toBe('pong');
  });

  test('maps-error-envelope-to-trpc-client-error', async () => {
    const client = createTRPCClient<AppRouter>({ links: [ipcLink({ bridge: wiredBridge({ origin: 'https://evil.com' }) })] });
    const error = await client.ping.query().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({ message: IPC_SENDER_ERROR_CODE, data: { code: IPC_SENDER_ERROR_CODE } });
  });

  test('maps-bridge-failure-to-trpc-client-error', async () => {
    const bridges: IpcBridge[] = [
      { invoke: () => Promise.reject(new Error("Error invoking remote method 'app:trpc'")) },
      { invoke: async () => undefined },
      { invoke: async () => ({ result: 'pong' }) },
      { invoke: async () => ({ error: { message: 'x' } }) },
    ];
    for (const bridge of bridges) {
      const client = createTRPCClient<AppRouter>({ links: [ipcLink({ bridge })] });
      await expect(client.ping.query()).rejects.toBeInstanceOf(TRPCClientError);
    }
    // No bridge passed and none on the global object.
    expect(IPC_BRIDGE_KEY in globalThis).toBe(false);
    const client = createTRPCClient<AppRouter>({ links: [ipcLink()] });
    await expect(client.ping.query()).rejects.toBeInstanceOf(TRPCClientError);
  });
});
