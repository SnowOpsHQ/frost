// Spec: specs/ipc-sender.spec.ts · Acceptance: specs/ipc-sender.feature.md
import { getTRPCErrorShape, TRPCError } from '@trpc/server';
import { describe, expect, test } from 'vitest';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import {
  IPC_ACCEPTED_ORIGINS,
  IPC_SENDER_ERROR_CODE,
  type IpcSenderRejection,
} from '@app/specs/ipc-sender.spec';
import {
  appRouter,
  createContext,
  createSenderPolicy,
  enforceSender,
  senderRejection,
  type CreateContextOptions,
} from '../index';

const WINDOW_ID = 7;
const MAIN_FRAME_ID = 100;

interface SenderSetup {
  origin: string;
  isMainFrame: boolean;
  /** The sender frame's id; defaults to the main frame's id iff `isMainFrame`. */
  frameTreeNodeId?: number;
  windowKnown?: boolean;
  /** `false` → the window lookup (`BrowserWindow.fromWebContents`) found no window. */
  hasWindow?: boolean;
  /** `false` → the sender is a webContents hosted in the window, not the window's own. */
  isWindowContents?: boolean;
  noFrame?: boolean;
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  frameDestroyed?: boolean;
  frameDetached?: boolean;
  devServerUrl?: string;
}

/** Electron-shaped fakes for one IPC message: `event.sender`, `event.senderFrame`, its window. */
function optsFor(s: SenderSetup): CreateContextOptions {
  const sender = {
    id: 1,
    mainFrame: { frameTreeNodeId: MAIN_FRAME_ID },
    isDestroyed: () => s.contentsDestroyed === true,
  };
  const windowContents = s.isWindowContents === false ? { ...sender, id: 2 } : sender;
  const senderFrame = {
    origin: s.origin,
    frameTreeNodeId: s.frameTreeNodeId ?? (s.isMainFrame ? MAIN_FRAME_ID : MAIN_FRAME_ID + 1),
    parent: s.isMainFrame ? null : { frameTreeNodeId: MAIN_FRAME_ID },
    detached: s.frameDetached === true,
    isDestroyed: () => s.frameDestroyed === true,
  };
  const window = {
    id: WINDOW_ID,
    webContents: windowContents,
    isDestroyed: () => s.windowDestroyed === true,
  };
  return {
    sender,
    senderFrame: s.noFrame ? null : senderFrame,
    window: s.hasWindow === false ? null : window,
    policy: createSenderPolicy({
      knownWindowIds: new Set(s.windowKnown === false ? [] : [WINDOW_ID]),
      devServerUrl: s.devServerUrl,
    }),
  };
}

const ctxFor = (s: SenderSetup) => createContext(optsFor(s));
const appSender = { origin: APP_ORIGIN, isMainFrame: true } as const;

async function expectForbidden(ctx: unknown, reason: IpcSenderRejection, label: string = reason): Promise<void> {
  expect(senderRejection(ctx), label).toBe(reason);
  const caller = appRouter.createCaller(ctx as never);
  await expect(caller.ping(), label).rejects.toThrow(IPC_SENDER_ERROR_CODE);
}

describe('enforceSender', () => {
  test('ping returns pong for a valid app-window sender', async () => {
    const caller = appRouter.createCaller(ctxFor({ origin: 'app://app', isMainFrame: true }));
    expect(await caller.ping()).toBe('pong');
    expect(IPC_ACCEPTED_ORIGINS).toEqual([APP_ORIGIN]);
  });

  test('rejects-foreign-sender', async () => {
    const caller = appRouter.createCaller(ctxFor({ origin: 'https://evil.com', isMainFrame: true }));
    await expect(caller.ping()).rejects.toThrow('FORBIDDEN');
    const error = await caller.ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: IPC_SENDER_ERROR_CODE, message: IPC_SENDER_ERROR_CODE });
    expect(senderRejection(ctxFor({ origin: 'https://evil.com', isMainFrame: true }))).toBe('origin-not-allowed');
  });

  test('rejects-subframe-on-app-origin', async () => {
    await expectForbidden(ctxFor({ origin: APP_ORIGIN, isMainFrame: false }), 'not-main-frame');
    // Contrived: parent !== null but the main frame's id; the `parent === null` half must still hold.
    await expectForbidden(
      ctxFor({ origin: APP_ORIGIN, isMainFrame: false, frameTreeNodeId: MAIN_FRAME_ID }),
      'not-main-frame',
      'subframe with main-frame id',
    );
  });

  test('rejects-top-frame-that-is-not-the-main-frame', async () => {
    // parent === null but not this webContents' main frame (e.g. another contents' top frame).
    await expectForbidden(
      ctxFor({ origin: APP_ORIGIN, isMainFrame: true, frameTreeNodeId: MAIN_FRAME_ID + 50 }),
      'not-main-frame',
    );
  });

  test('rejects-embedded-view-sender', async () => {
    await expectForbidden(ctxFor({ ...appSender, isWindowContents: false }), 'not-window-contents');
  });

  test('rejects-unknown-window', async () => {
    await expectForbidden(ctxFor({ ...appSender, windowKnown: false }), 'unknown-window', 'unregistered window');
    await expectForbidden(ctxFor({ ...appSender, hasWindow: false }), 'unknown-window', 'no window');
  });

  test('rejects-destroyed-sender', async () => {
    await expectForbidden(ctxFor({ ...appSender, windowDestroyed: true }), 'sender-destroyed', 'window destroyed');
    await expectForbidden(ctxFor({ ...appSender, contentsDestroyed: true }), 'sender-destroyed', 'contents destroyed');
    await expectForbidden(ctxFor({ ...appSender, frameDestroyed: true }), 'sender-destroyed', 'frame destroyed');
    await expectForbidden(ctxFor({ ...appSender, frameDetached: true }), 'sender-destroyed', 'frame detached');

    // Electron throws "Object has been destroyed" on property access of a destroyed object.
    const opts = optsFor(appSender);
    const throwingWindow = {
      id: WINDOW_ID,
      get webContents(): never {
        throw new TypeError('Object has been destroyed');
      },
      isDestroyed: () => false,
    };
    await expectForbidden(createContext({ ...opts, window: throwingWindow }), 'sender-destroyed', 'throwing window');
  });

  test('rejects-missing-sender-frame', async () => {
    await expectForbidden(ctxFor({ ...appSender, noFrame: true }), 'no-sender-frame');
  });

  test('rejects-origin-lookalikes', async () => {
    const lookalikes = [
      'app://app.evil',
      'app://evil',
      'app://app/',
      'app://app:1',
      'app://APP',
      'APP://APP',
      'app://',
      'null',
      '',
      'file://',
      'https://app',
      'http://localhost:5173',
    ];
    for (const origin of lookalikes) {
      await expectForbidden(ctxFor({ origin, isMainFrame: true }), 'origin-not-allowed', origin);
    }
  });

  test('accepts-dev-server-origin-only-when-allowed', async () => {
    const devOrigin = 'http://localhost:5173';
    await expectForbidden(ctxFor({ origin: devOrigin, isMainFrame: true }), 'origin-not-allowed', 'not allowed');

    const devServerUrl = 'http://localhost:5173/';
    const dev = (origin: string) => ctxFor({ origin, isMainFrame: true, devServerUrl });
    expect(await appRouter.createCaller(dev(devOrigin)).ping()).toBe('pong');
    expect(await appRouter.createCaller(dev(APP_ORIGIN)).ping()).toBe('pong');
    for (const origin of ['http://localhost:5174', 'http://127.0.0.1:5173', 'https://localhost:5173', 'http://localhost']) {
      await expectForbidden(dev(origin), 'origin-not-allowed', origin);
    }
    // Still only the main frame of a known app window.
    await expectForbidden(ctxFor({ origin: devOrigin, isMainFrame: false, devServerUrl }), 'not-main-frame', 'dev subframe');
  });

  test('rejects-non-loopback-dev-server-url', () => {
    const bad = [
      'https://evil.com',
      'http://evil.com:5173',
      'https://localhost:5173',
      'http://user:pass@localhost:5173',
      'file:///tmp/x',
      'app://app',
      'not a url',
      '',
    ];
    for (const devServerUrl of bad) {
      expect(() => createSenderPolicy({ knownWindowIds: new Set(), devServerUrl }), devServerUrl).toThrow();
    }
    for (const devServerUrl of ['http://localhost:5173', 'http://127.0.0.1:5173/', 'http://[::1]:5173/index.html']) {
      expect(createSenderPolicy({ knownWindowIds: new Set(), devServerUrl }).allowedOrigins, devServerUrl).toHaveLength(2);
    }
    expect(createSenderPolicy({ knownWindowIds: new Set(), devServerUrl: undefined }).allowedOrigins).toEqual([APP_ORIGIN]);
  });

  test('fails-closed-without-context', async () => {
    const valid = ctxFor(appSender);
    const malformed: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['{}', {}],
      ['sender without policy', { sender: valid.sender }],
      ['policy without sender', { policy: valid.policy }],
      ['policy without origins', { ...valid, policy: { knownWindowIds: valid.policy.knownWindowIds } }],
      ['policy without windows', { ...valid, policy: { allowedOrigins: valid.policy.allowedOrigins } }],
    ];
    for (const [label, ctx] of malformed) {
      const reason = label === 'policy without sender' ? 'no-sender-frame' : 'no-context';
      await expectForbidden(ctx, reason, label);
    }
  });

  test('error-shape-hides-internals', async () => {
    const ctx = ctxFor({ origin: 'https://evil.com', isMainFrame: true });
    const error = await appRouter
      .createCaller(ctx)
      .ping()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    const shape = getTRPCErrorShape({
      config: appRouter._def._config,
      error: error as TRPCError,
      type: 'query',
      path: 'ping',
      input: undefined,
      ctx,
    });
    expect(shape.data).not.toHaveProperty('stack');
    expect(shape).toEqual({
      message: IPC_SENDER_ERROR_CODE,
      code: -32003,
      data: { code: IPC_SENDER_ERROR_CODE, httpStatus: 403, path: 'ping' },
    });
  });

  test('every-procedure-enforces-sender', async () => {
    const procedures = Object.keys(appRouter._def.procedures);
    expect(procedures.length).toBeGreaterThan(0);
    // Structural: `enforceSender` runs first, before any `.input()` parser or other middleware.
    const [guard] = enforceSender._middlewares;
    expect(guard).toBeTypeOf('function');
    for (const [path, procedure] of Object.entries(appRouter._def.procedures)) {
      const { middlewares } = (procedure as unknown as { _def: { middlewares: unknown[] } })._def;
      expect(middlewares[0], path).toBe(guard);
    }
    const foreign = ctxFor({ origin: 'https://evil.com', isMainFrame: true });
    for (const path of procedures) {
      const caller = appRouter.createCaller(foreign) as unknown as Record<string, unknown>;
      const call = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller);
      // No input: an `.input()` placed before `enforceSender` would fail BAD_REQUEST instead.
      const error = await Promise.resolve()
        .then(() => (call as (input?: unknown) => unknown)(undefined))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error, path).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code, path).toBe(IPC_SENDER_ERROR_CODE);
    }
  });
});
