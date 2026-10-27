/** The parts of `WebContents` the registry reads. */
export interface WebContentsIdentity {
  readonly id: number;
}

/** The parts of `BrowserWindow` the registry uses. */
export interface TrackableWindow {
  readonly id: number;
  readonly webContents: WebContentsIdentity & { readonly devToolsWebContents: WebContentsIdentity | null };
  once(event: 'closed', listener: () => void): unknown;
}

export interface WindowRegistry {
  /** For the IPC sender policy (`createSenderPolicy({ knownWindowIds })`); live. */
  readonly knownWindowIds: ReadonlySet<number>;
  track(win: TrackableWindow): void;
  /**
   * True for the WebContents of a tracked, not-yet-closed window, or the DevTools WebContents
   * currently open for one (who may load `app://`: `APP_REQUEST_FILTER` in `specs/app-protocol.spec.ts`).
   */
  isAppWebContents(contents: WebContentsIdentity): boolean;
}

/**
 * The app's own windows, for the IPC sender policy and the `app://` request guard. Windows are
 * added by `track` and removed when they close.
 */
export function createWindowRegistry(): WindowRegistry {
  const knownWindowIds = new Set<number>();
  const tracked = new Map<number, TrackableWindow['webContents']>();
  return {
    knownWindowIds,
    track(win) {
      // Captured now: a destroyed window's properties throw.
      const id = win.id;
      const webContents = win.webContents;
      knownWindowIds.add(id);
      tracked.set(id, webContents);
      win.once('closed', () => {
        knownWindowIds.delete(id);
        tracked.delete(id);
      });
    },
    isAppWebContents(contents) {
      for (const webContents of tracked.values()) {
        if (webContents.id === contents.id || webContents.devToolsWebContents?.id === contents.id) return true;
      }
      return false;
    },
  };
}
