// When each tab last loaded (Phase 6 Task 3; acceptance `changes-capture.feature.md`, The
// service). The auditor keeps a tab's ready audit on screen through a same-URL reload until the new
// one settles, so a capture asks this instead: an audit taken before the tab's latest load is the
// previous load's, and is not captured. A load is what makes the auditor audit again: a new document
// (`did-navigate`), the end of a load (`did-finish-load`), or a main-frame move to another URL in
// the page (`did-navigate-in-page`; a fragment-only move is not one).

/** The events of a WebContents the tracker listens to. */
export interface LoadEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface LoadTimes {
  /** Starts listening to `contents` (once; again is a no-op). */
  watch(contents: LoadEvents): void;
  /** When `contents` last loaded (Unix ms, `now`'s clock), or `null` if it has not since it was watched. */
  loadedAt(contents: object): number | null;
}

const withoutFragment = (url: unknown): string => (typeof url === 'string' ? url.split('#')[0]! : '');

export function createLoadTimes(now: () => number = Date.now): LoadTimes {
  const times = new WeakMap<object, number>();
  const urls = new WeakMap<object, string>();
  const watched = new WeakSet<object>();
  return {
    watch(contents) {
      if (watched.has(contents)) return;
      watched.add(contents);
      contents.on('did-navigate', (_event, url) => {
        urls.set(contents, withoutFragment(url));
        times.set(contents, now());
      });
      contents.on('did-finish-load', () => times.set(contents, now()));
      contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (isMainFrame !== true || withoutFragment(url) === urls.get(contents)) return;
        urls.set(contents, withoutFragment(url));
        times.set(contents, now());
      });
    },
    loadedAt: (contents) => times.get(contents) ?? null,
  };
}
