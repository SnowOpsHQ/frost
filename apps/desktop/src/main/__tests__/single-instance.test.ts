// Acceptance: specs/browser-session-db.feature.md (Single instance)
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { claimSingleInstance, type ShowableWindow } from '../single-instance';

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
    expect(claimSingleInstance(app, { windows: () => [], openWindow })).toBe(false);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.listenerCount('second-instance')).toBe(0);
  });

  test('second-instance-shows-existing-window', () => {
    const app = new FakeApp(true);
    let windows: ShowableWindow[] = [];
    const openWindow = vi.fn();
    expect(claimSingleInstance(app, { windows: () => windows, openWindow })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();

    // A minimized window is restored and focused.
    const win = fakeWindow({ minimized: true });
    windows = [fakeWindow({ destroyed: true }), win];
    app.emit('second-instance');
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();

    // No window (macOS, after the last one closed): one is opened.
    windows = [];
    app.emit('second-instance');
    expect(openWindow).toHaveBeenCalledOnce();

    // Before the app is ready, nothing is opened (startup opens the window itself).
    app.ready = false;
    app.emit('second-instance');
    expect(openWindow).toHaveBeenCalledOnce();
  });
});
