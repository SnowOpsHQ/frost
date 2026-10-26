// Acceptance: specs/browser-session-db.feature.md (Single instance)
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { claimSingleInstance, reopenOnActivate, type ShowableWindow } from '../single-instance';

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
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
