// Acceptance: specs/browser-session-db.feature.md (Single instance)
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { claimSingleInstance, createStartup, quitOnStartupFailure, reopenOnActivate, type ShowableWindow } from '../single-instance';

class FakeApp extends EventEmitter {
  ready = true;
  constructor(readonly gotLock: boolean) {
    super();
  }
  requestSingleInstanceLock = vi.fn(() => this.gotLock);
  quit = vi.fn();
  isReady = () => this.ready;
}

function fakeWindow(state: { minimized?: boolean; destroyed?: boolean } = {}) {
  return {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
  } satisfies ShowableWindow;
}

describe('single instance', () => {
  test('second-instance-quits', () => {
    const app = new FakeApp(false);
    const openWindow = vi.fn();
    expect(claimSingleInstance(app, { windows: () => [], openWindow, started: Promise.resolve() })).toBe(false);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.listenerCount('second-instance')).toBe(0);
  });

  test('second-instance-shows-existing-window', async () => {
    const app = new FakeApp(true);
    let windows: ShowableWindow[] = [];
    const openWindow = vi.fn();
    expect(claimSingleInstance(app, { windows: () => windows, openWindow, started: Promise.resolve() })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();

    // A minimized window is restored and focused.
    const win = fakeWindow({ minimized: true });
    windows = [fakeWindow({ destroyed: true }), win];
    app.emit('second-instance');
    await settle();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();

    // No window (macOS, after the last one closed): one is opened.
    windows = [];
    app.emit('second-instance');
    await settle();
    expect(openWindow).toHaveBeenCalledOnce();
  });

  test('second-instance-waits-for-startup', async () => {
    const app = new FakeApp(true);
    const startup = deferred();
    let windows: ShowableWindow[] = [];
    const openWindow = vi.fn();
    claimSingleInstance(app, { windows: () => windows, openWindow, started: startup.promise });
    // Ready, but the session is still being restored and no window is open yet.
    app.emit('second-instance');
    await settle();
    expect(openWindow).not.toHaveBeenCalled();
    // Startup opens its window and completes: the waiting launch shows that one.
    const win = fakeWindow();
    windows = [win];
    startup.resolve();
    await settle();
    expect(openWindow).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  test('activate-waits-for-startup', async () => {
    const app = new FakeApp(true);
    const startup = deferred();
    let windows: ShowableWindow[] = [];
    const openWindow = vi.fn(() => {
      windows = [fakeWindow()];
    });
    reopenOnActivate(app, { windows: () => windows, openWindow, started: startup.promise });
    app.emit('activate');
    await settle();
    expect(openWindow).not.toHaveBeenCalled();
    windows = [fakeWindow()];
    startup.resolve();
    await settle();
    expect(openWindow).not.toHaveBeenCalled();
    // After startup, with every window closed (macOS), the dock icon opens one.
    windows = [fakeWindow({ destroyed: true })];
    app.emit('activate');
    await settle();
    expect(openWindow).toHaveBeenCalledOnce();
    app.emit('activate');
    await settle();
    expect(openWindow).toHaveBeenCalledOnce();
  });

  test('startup-failure-quits', async () => {
    const app = new FakeApp(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failure = new Error('session store failed to open');
      const report = vi.fn<(error: unknown) => void>();
      await Promise.reject(failure).catch(quitOnStartupFailure(app, report));
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]).toContain(failure);
      // Reported (telemetry's will-quit hold then flushes it) before the quit.
      expect(report).toHaveBeenCalledExactlyOnceWith(failure);
      expect(app.quit).toHaveBeenCalledOnce();
      expect(report.mock.invocationCallOrder[0]).toBeLessThan(app.quit.mock.invocationCallOrder[0]!);
    } finally {
      error.mockRestore();
    }
  });

  test('startup-completes', async () => {
    const app = new FakeApp(true);
    const startup = createStartup(app);
    const report = vi.fn<(error: unknown) => void>();
    const body = vi.fn(async () => undefined);
    await startup.run(body, report);
    expect(body).toHaveBeenCalledOnce();
    expect(await state(startup.started)).toBe('resolved');
    expect(report).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    // Main runs its one whenReady chain through it (index.ts is the Electron entry: a source check).
    const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');
    expect(main).toMatch(/createStartup\(app\)/);
    expect(main).toMatch(/runStartup\(async \(\) => \{\s*await app\.whenReady\(\);/);
    expect(main.match(/app\.whenReady\(\)/g)).toHaveLength(1);
    expect(main).not.toMatch(/void app\.whenReady\(\)/);
  });

  test('startup-failure-quits: a failed run rejects started, reports and quits', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const fail of [
        (failure: Error) => () => Promise.reject(failure),
        // A body that throws before it returns a promise.
        (failure: Error) => () => {
          throw failure;
        },
      ]) {
        const app = new FakeApp(true);
        const startup = createStartup(app);
        const failure = new Error('session store failed to open');
        const report = vi.fn<(error: unknown) => void>();
        await startup.run(fail(failure), report);
        // Nothing waits on `started` (telemetry unconfigured, no later launch): still not unhandled.
        await settle();
        expect(unhandled).not.toHaveBeenCalled();
        expect(await state(startup.started)).toBe('rejected');
        await expect(startup.started).rejects.toBe(failure);
        expect(report).toHaveBeenCalledExactlyOnceWith(failure);
        expect(app.quit).toHaveBeenCalledOnce();
      }
    } finally {
      process.off('unhandledRejection', unhandled);
      error.mockRestore();
    }
  });

  test('startup-failure-quits: a later launch or the dock icon shows nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const app = new FakeApp(true);
      const startup = createStartup(app);
      const win = fakeWindow();
      const openWindow = vi.fn();
      const options = { windows: () => [win], openWindow, started: startup.started };
      claimSingleInstance(app, options);
      reopenOnActivate(app, options);
      // One waits from before the failure, one arrives after it.
      app.emit('second-instance');
      await startup.run(() => Promise.reject(new Error('boom')), () => undefined);
      app.emit('second-instance');
      app.emit('activate');
      await settle();
      expect(openWindow).not.toHaveBeenCalled();
      expect(win.show).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      error.mockRestore();
    }
  });

  test('startup-failure-quits even when reporting throws', async () => {
    const app = new FakeApp(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const report = vi.fn<(error: unknown) => void>(() => {
        throw new Error('reporter broke');
      });
      await Promise.reject(new Error('boom')).catch(quitOnStartupFailure(app, report));
      expect(report).toHaveBeenCalledOnce();
      expect(app.quit).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Whether `promise` has settled once pending promise callbacks have run: answers at once, instead of
 * a test timeout for one that never settles. (`pending` waits a task: an already-resolved promise
 * would win the race against a settled one's second callback.)
 */
const state = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => 'resolved', () => 'rejected'), new Promise<string>((resolve) => setImmediate(() => resolve('pending')))]);

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
