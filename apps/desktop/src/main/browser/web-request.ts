import type {
  OnBeforeRedirectListenerDetails,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
  OnResponseStartedListenerDetails,
  OnSendHeadersListenerDetails,
  Session,
  WebRequestFilter,
} from 'electron';

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
//   Since Phase 2.5 Task 5 (`devtools.feature.md`, Request observers) the devtools drawer's recorder
//   subscribes too, with `observeRequests`: `onSendHeaders` and `onCompleted` are owned here as
//   well, and once a request observer exists every one of the five listens to every resource type
//   (`REQUEST_FILTER`); main-frame observers still get only `mainFrame` events.

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
  readonly webRequest: Pick<Session['webRequest'], 'onBeforeRedirect' | 'onResponseStarted' | 'onErrorOccurred'> & Partial<Pick<Session['webRequest'], 'onSendHeaders' | 'onCompleted'>>;
}

/** Every request of `http(s)` pages, of any resource type (`observeRequests`). */
export const REQUEST_FILTER: WebRequestFilter = { urls: ['http://*/*', 'https://*/*'] };

/** An observer of every request (the devtools drawer's recorder). Observers only: nothing it does can hold a request. */
export interface RequestObserver extends MainFrameObserver {
  /** The request's headers went out (`onSendHeaders`). */
  sent?(details: OnSendHeadersListenerDetails): void;
  /** The request finished (`onCompleted`). */
  completed?(details: OnCompletedListenerDetails): void;
}

interface Hub {
  readonly mainFrames: Set<MainFrameObserver>;
  readonly requests: Set<RequestObserver>;
  /** The listeners take every resource type (a request observer was added once). */
  wide: boolean;
}

const hubs = new WeakMap<ObservedSession, Hub>();

/** Calls `fn` for each observer; one observer throwing never keeps the event from the others. */
function each<T>(observers: ReadonlySet<T>, fn: (observer: T) => void): void {
  for (const observer of [...observers]) {
    try {
      fn(observer);
    } catch (error) {
      console.error('frost: main-frame observer failed', error);
    }
  }
}

/** Installs (or, widened, re-installs: each registration replaces the last) the session's listeners. */
function install(session: ObservedSession, hub: Hub): void {
  const filter = hub.wide ? REQUEST_FILTER : MAIN_FRAME_FILTER;
  // With the wide filter, main-frame observers keep seeing main-frame requests only.
  const mainFrame = (details: { resourceType?: string }): boolean => !hub.wide || details.resourceType === 'mainFrame';
  session.webRequest.onBeforeRedirect(filter, (details) => {
    if (mainFrame(details)) each(hub.mainFrames, (o) => o.redirected?.(details));
    each(hub.requests, (o) => o.redirected?.(details));
  });
  session.webRequest.onResponseStarted(filter, (details) => {
    if (mainFrame(details)) each(hub.mainFrames, (o) => o.responded?.(details));
    each(hub.requests, (o) => o.responded?.(details));
  });
  session.webRequest.onErrorOccurred(filter, (details) => {
    if (mainFrame(details)) each(hub.mainFrames, (o) => o.failed?.(details));
    each(hub.requests, (o) => o.failed?.(details));
  });
  if (!hub.wide) return;
  session.webRequest.onSendHeaders?.(REQUEST_FILTER, (details) => each(hub.requests, (o) => o.sent?.(details)));
  session.webRequest.onCompleted?.(REQUEST_FILTER, (details) => each(hub.requests, (o) => o.completed?.(details)));
}

function hubOf(session: ObservedSession): Hub {
  let hub = hubs.get(session);
  if (!hub) {
    hub = { mainFrames: new Set(), requests: new Set(), wide: false };
    hubs.set(session, hub);
    install(session, hub);
  }
  return hub;
}

/**
 * Adds `observer` to `session`'s main-frame events. The first observer installs the session's
 * single listener for each event (`MAIN_FRAME_FILTER`); later ones join it, so composing never
 * replaces a listener. Answers the function that removes `observer` (the listeners stay installed).
 */
export function observeMainFrames(session: ObservedSession, observer: MainFrameObserver): () => void {
  const hub = hubOf(session);
  hub.mainFrames.add(observer);
  return () => void hub.mainFrames.delete(observer);
}

/**
 * Adds `observer` to every request of `session` (any resource type; `devtools.feature.md`). The first
 * one widens the session's listeners to `REQUEST_FILTER` and adds `onSendHeaders` and `onCompleted`;
 * main-frame observers are unaffected. Answers the function that removes `observer`.
 */
export function observeRequests(session: ObservedSession, observer: RequestObserver): () => void {
  const hub = hubOf(session);
  if (!hub.wide) {
    hub.wide = true;
    install(session, hub);
  }
  hub.requests.add(observer);
  return () => void hub.requests.delete(observer);
}
