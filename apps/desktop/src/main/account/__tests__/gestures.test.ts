// Spec: specs/security-policy.spec.ts (USER_ACTIVATION_WINDOW_MS via trackUserGesture)
// Acceptance: specs/account-signin.feature.md (Gestures) · plan Global Constraint "The system browser opens
// only through openExternalIfAllowed … on a live user gesture in the app window that asked"
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { createWindowGestures, type GestureWindow } from '../gestures';

class FakeWindow extends EventEmitter implements GestureWindow {
  constructor(
    readonly id: number,
    readonly webContents = { id: id * 10 },
  ) {
    super();
  }
}

/** A tracker that records which contents it was given; `activate` stands in for a trusted input. */
function fakeTracker() {
  const live = new Map<object, boolean>();
  return {
    activate: (win: FakeWindow) => live.set(win.webContents, true),
    track: (contents: object) => {
      live.set(contents, false);
      return {
        consume: () => {
          const had = live.get(contents) === true;
          live.set(contents, false);
          return had;
        },
      };
    },
    tracked: (win: FakeWindow) => live.has(win.webContents),
  };
}

describe('window gestures', () => {
  test('gesture-per-app-window', () => {
    const app = new EventEmitter();
    const before = new FakeWindow(1);
    const tracker = fakeTracker();
    const gestures = createWindowGestures({ app, existing: () => [before], track: tracker.track });
    const later = new FakeWindow(2);
    app.emit('browser-window-created', {}, later);
    expect(tracker.tracked(before)).toBe(true);
    expect(tracker.tracked(later)).toBe(true);

    expect(gestures.consume(1)).toBe(false);
    tracker.activate(later);
    // Only for its own window, and once.
    expect(gestures.consume(1)).toBe(false);
    expect(gestures.consume(2)).toBe(true);
    expect(gestures.consume(2)).toBe(false);
    expect(gestures.consume(99)).toBe(false);

    tracker.activate(before);
    before.emit('closed');
    expect(gestures.consume(1)).toBe(false);

    // Tracking the same window twice is harmless; dispose stops tracking new ones.
    app.emit('browser-window-created', {}, later);
    gestures.dispose();
    const after = new FakeWindow(3);
    app.emit('browser-window-created', {}, after);
    expect(tracker.tracked(after)).toBe(false);
    expect(app.listenerCount('browser-window-created')).toBe(0);
  });
});
