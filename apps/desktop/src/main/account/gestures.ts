import type { UserGesture } from '../security/gesture';

// Live user gestures per app window (acceptance `account-signin.feature.md`, Gestures; plan Global
// Constraint "The system browser opens only through `openExternalIfAllowed` … on a live user gesture
// in the app window that asked"). Every window is tracked from its creation (`browser-window-created`)
// with `trackUserGesture` (trusted `input-event`s only, `USER_ACTIVATION_WINDOW_MS`), so `signIn` can
// ask whether the window whose page called it was just clicked or typed in. No Electron import: main
// passes `app`, the existing windows and the tracker.

/** The parts of `BrowserWindow` read here. Its `id` is read once, at creation (it throws after destroy). */
export interface GestureWindow {
  readonly id: number;
  readonly webContents: object;
  once(event: 'closed', listener: () => void): unknown;
}

/** The parts of Electron's `app` used here. */
export interface GestureApp {
  on(event: 'browser-window-created', listener: (event: unknown, window: GestureWindow) => void): unknown;
  removeListener(event: 'browser-window-created', listener: (event: unknown, window: GestureWindow) => void): unknown;
}

export interface WindowGestures {
  /** Whether window `windowId` has a live, unspent activation; reading it spends it. */
  consume(windowId: number): boolean;
  /** Stops tracking new windows. */
  dispose(): void;
}

export function createWindowGestures(options: {
  readonly app: GestureApp;
  /** Windows that exist already (`BrowserWindow.getAllWindows()`). */
  readonly existing: () => readonly GestureWindow[];
  /** `(contents) => trackUserGesture(contents, () => performance.now())`. */
  readonly track: (contents: never) => UserGesture;
}): WindowGestures {
  const byWindow = new Map<number, UserGesture>();
  const add = (window: GestureWindow): void => {
    const id = window.id;
    if (byWindow.has(id)) return;
    byWindow.set(id, options.track(window.webContents as never));
    window.once('closed', () => byWindow.delete(id));
  };
  const onCreated = (_event: unknown, window: GestureWindow): void => add(window);
  options.app.on('browser-window-created', onCreated);
  for (const window of options.existing()) add(window);
  return {
    consume: (windowId) => byWindow.get(windowId)?.consume() === true,
    dispose: () => {
      options.app.removeListener('browser-window-created', onCreated);
    },
  };
}
