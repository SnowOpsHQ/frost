import type { OnBeforeRedirectListenerDetails, OnErrorOccurredListenerDetails, OnResponseStartedListenerDetails, Session, WebRequestFilter } from 'electron';

// Main-frame request observers on the browse session (acceptance `seo-indexability.feature.md`,
// Response metadata). Electron holds **one** listener per `webRequest` event per session: a second
// registration silently replaces the first. So this module is the browse session's one owner of
// `onBeforeRedirect`, `onResponseStarted` and `onErrorOccurred`, and fans each event out to every
// observer added with `observeMainFrames`; nothing else may register those three on that session.
//
// Ownership of the sessions' `webRequest` events (keep in sync when adding one):
// - default session (the chrome's): `onBeforeRequest` — `protocol/requests.ts` (who may load
//   `app://`); `onHeadersReceived` — `security/register.ts` (the app CSP);
// - browse session (`persist:frost-browser`, the tabs'): `onBeforeRedirect`, `onResponseStarted`,
//   `onErrorOccurred` — here, for main-frame requests only (`MAIN_FRAME_FILTER`). No blocking
//   listener (`onBeforeRequest`, `onBeforeSendHeaders`, `onHeadersReceived`) is installed on it:
//   these are observers, so no request ever waits for main.

/** The requests observed: top-level documents of `http(s)` pages. */
export const MAIN_FRAME_FILTER: WebRequestFilter = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] };

export interface MainFrameObserver {
  /** The request is being redirected (`onBeforeRedirect`). */
  redirected?(details: OnBeforeRedirectListenerDetails): void;
  /** The response's first bytes and headers arrived (`onResponseStarted`). */
  responded?(details: OnResponseStartedListenerDetails): void;
  /** The request failed or was cancelled (`onErrorOccurred`). */
  failed?(details: OnErrorOccurredListenerDetails): void;
}

/** The parts of a session's `webRequest` this module registers. */
export interface ObservedSession {
  readonly webRequest: Pick<Session['webRequest'], 'onBeforeRedirect' | 'onResponseStarted' | 'onErrorOccurred'>;
}

const hubs = new WeakMap<ObservedSession, Set<MainFrameObserver>>();

/** Calls `fn` for each observer; one observer throwing never keeps the event from the others. */
function each(observers: ReadonlySet<MainFrameObserver>, fn: (observer: MainFrameObserver) => void): void {
  for (const observer of [...observers]) {
    try {
      fn(observer);
    } catch (error) {
      console.error('frost: main-frame observer failed', error);
    }
  }
}

/**
 * Adds `observer` to `session`'s main-frame events. The first observer installs the session's
 * single listener for each event (`MAIN_FRAME_FILTER`); later ones join it, so composing never
 * replaces a listener. Answers the function that removes `observer` (the listeners stay installed).
 */
export function observeMainFrames(session: ObservedSession, observer: MainFrameObserver): () => void {
  let observers = hubs.get(session);
  if (!observers) {
    const created = new Set<MainFrameObserver>();
    observers = created;
    hubs.set(session, created);
    session.webRequest.onBeforeRedirect(MAIN_FRAME_FILTER, (details) => each(created, (o) => o.redirected?.(details)));
    session.webRequest.onResponseStarted(MAIN_FRAME_FILTER, (details) => each(created, (o) => o.responded?.(details)));
    session.webRequest.onErrorOccurred(MAIN_FRAME_FILTER, (details) => each(created, (o) => o.failed?.(details)));
  }
  observers.add(observer);
  const owned = observers;
  return () => void owned.delete(observer);
}
