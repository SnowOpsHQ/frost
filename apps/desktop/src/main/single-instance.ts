// One frost per profile (spec `browser-session-db.feature.md`, Single instance): two instances on
// the same `userData` would each save their own tab strip over the other's. A second launch hands
// over to the first (which shows its window) and quits. No Electron imports: the app and windows
// are injected, so this runs under Vitest.
//
// Both `second-instance` and (macOS) `activate` wait for `started`: startup restores the saved
// session and opens the first window after the app is ready, and an event in between must neither
// open a window before the restore nor a second one next to it.

/** The parts of Electron's `app` used here. */
export interface InstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance' | 'activate', listener: () => void): unknown;
}

/** What showing or reopening the window needs. */
export interface WindowOptions {
  readonly windows: () => readonly ShowableWindow[];
  readonly openWindow: () => void;
  /**
   * Resolves once startup is complete (session restored, first window opened); rejects when it
   * failed (the app is quitting: nothing is shown or opened).
   */
  readonly started: Promise<unknown>;
}

/** The parts of a `BrowserWindow` used here. */
export interface ShowableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Takes the profile's single-instance lock. Without it (another frost has this profile) the app
 * quits and `false` is answered: the caller must start nothing (not even open the database).
 * With it, a later launch on the same profile shows this instance's window once startup is
 * complete: restored if minimized and focused, or opened if there is none (macOS).
 */
export function claimSingleInstance(app: InstanceApp, options: WindowOptions): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    void options.started.then(() => {
      const win = options.windows().find((w) => !w.isDestroyed());
      if (!win) {
        options.openWindow();
        return;
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }, quitting);
  });
  return true;
}

/**
 * The `catch` for startup after the lock is taken: a failed startup is logged, handed to `report`
 * (telemetry: caught here, it is no longer an unhandled rejection telemetry would see) and the app
 * quits. Left running with no window it would keep the lock, and every later launch would hand over
 * to it and show nothing. Quitting runs the same `will-quit` handlers (the session store's flush,
 * telemetry's) as any quit; a `report` that throws does not stop it.
 */
export function quitOnStartupFailure(app: Pick<InstanceApp, 'quit'>, report: (error: unknown) => void): (error: unknown) => void {
  return (error) => {
    console.error('startup failed', error);
    try {
      report(error);
    } catch {
      // Reporting never stops the quit.
    }
    app.quit();
  };
}

/** Startup after the lock is taken: `started` for whatever waits on it, `run` to run it. */
export interface Startup {
  /**
   * Resolves once startup completes; rejects with its error when it fails (the app then quits).
   * Never an unhandled rejection, even with nothing waiting on it.
   */
  readonly started: Promise<void>;
  /**
   * Runs startup's `body` (the `whenReady` chain up to the first window): it completes and `started`
   * resolves, or it throws or rejects and `started` rejects, then `quitOnStartupFailure(app, report)`.
   * Never rejects itself.
   */
  run(body: () => Promise<void>, report: (error: unknown) => void): Promise<void>;
}

/** Main's one startup (spec `startup-completes`, `startup-failure-quits`). */
export function createStartup(app: Pick<InstanceApp, 'quit'>): Startup {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const started = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // Handled once here: telemetry may be unconfigured (and not wait on it) and no later launch may come.
  started.catch(() => undefined);
  return {
    started,
    run: (body, report) =>
      Promise.resolve()
        .then(body)
        .then(resolve, async (error: unknown) => {
          // Telemetry's `app.start` span ends as an error a few callbacks after this. With no window
          // open, `quit()` runs `will-quit` (and telemetry's flush of what is queued) inside the call,
          // so the quit waits a task: the ended span is then queued and sent in that flush.
          reject(error);
          await new Promise<void>((done) => setImmediate(done));
          quitOnStartupFailure(app, report)(error);
        }),
  };
}

/** macOS: the dock icon (`activate`) opens a window when none is open, once startup is complete. */
export function reopenOnActivate(app: InstanceApp, options: WindowOptions): void {
  app.on('activate', () => {
    void options.started.then(() => {
      if (!options.windows().some((w) => !w.isDestroyed())) options.openWindow();
    }, quitting);
  });
}

/** A failed startup (`started` rejected) quits the app: a later launch or the dock icon shows nothing. */
function quitting(): void {}
