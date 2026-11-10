import type { AuthenticationResponseDetails, AuthInfo } from 'electron';
import { proxyAuthKey } from '@app/specs/location-profiles.spec';

// Proxy authentication for location tabs (Phase 12 Task 10b; plan Decision 11, Threat model "Proxy
// credentials answer a site's auth prompt"; acceptance `location-profiles.feature.md`, Behaviour and
// Q7). The one `login` listener in main (`no-login-listener-cancels`: no other module listens for
// it). Electron 45's `app` `login` event: `(event, webContents | null, authenticationResponseDetails,
// authInfo, callback)`; its default is to cancel every authentication.
//
// It answers **only** when all hold: `authInfo.isProxy`; `webContents` is a live WebContents whose
// session is a prepared location profile's partition (`proxyOf`); `authInfo.host:port` is that
// profile's proxy (`proxyAuthKey`); it is the request's first attempt (a rejected sign-in is never
// sent again in a loop); and a sign-in is stored. The answer is given from inside the key store's
// closure (`withCredentials`): the username and password never leave it. Everything else is
// cancelled explicitly (`preventDefault()` and `callback()` with no arguments, which Electron
// documents as cancelling and returning the auth error to the page), so frost never relies on the
// default. Nothing about a request (its URL, realm or host) is logged.

/** The profile whose partition `session` is, and its proxy; `null` for any other session. */
export interface LocationProxyOf {
  (session: unknown): { readonly profileId: string; readonly host: string; readonly port: number } | null;
}

export interface ProxyLoginDeps {
  readonly proxyOf: LocationProxyOf;
  /** `LocationSecrets.withCredentials`. */
  readonly withCredentials: <T>(profileId: string, fn: (username: string, password: string) => T) => Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }>;
  /** One line per failure (never a value or a URL). */
  readonly log?: (line: string) => void;
}

type LoginCallback = (username?: string, password?: string) => void;
export type LoginListener = (event: { preventDefault(): void }, webContents: unknown, details: Partial<AuthenticationResponseDetails> | undefined, authInfo: Partial<AuthInfo> | undefined, callback: LoginCallback) => void;

/** The session of a live WebContents, else `undefined` (never throws). */
function sessionOf(contents: unknown): unknown {
  try {
    if (contents === null || typeof contents !== 'object') return undefined;
    const live = contents as { isDestroyed?: () => boolean; session?: unknown };
    if (typeof live.isDestroyed === 'function' && live.isDestroyed()) return undefined;
    return live.session;
  } catch {
    return undefined;
  }
}

export function createProxyLogin(deps: ProxyLoginDeps): LoginListener {
  const log = (line: string): void => deps.log?.(`location: ${line}`);
  return (event, webContents, details, authInfo, callback) => {
    // Every path answers: from here on the request waits for this listener alone.
    event.preventDefault();
    let answered = false;
    const cancel = (): void => {
      if (answered) return;
      answered = true;
      try {
        callback();
      } catch {
        // The request is already gone.
      }
    };
    try {
      if (authInfo?.isProxy !== true || details?.firstAuthAttempt !== true) return cancel();
      const proxy = deps.proxyOf(sessionOf(webContents));
      if (proxy === null || typeof authInfo.host !== 'string' || typeof authInfo.port !== 'number') return cancel();
      if (proxyAuthKey(authInfo.host, authInfo.port) !== proxyAuthKey(proxy.host, proxy.port)) return cancel();
      void deps
        .withCredentials(proxy.profileId, (username, password) => {
          if (answered) return;
          answered = true;
          callback(username, password);
        })
        .then((found) => {
          if (!found.ok) cancel();
        })
        .catch(() => {
          log('a proxy sign-in could not be read');
          cancel();
        });
    } catch {
      cancel();
    }
  };
}

/** The part of Electron's `app` the listener is installed on. */
export interface LoginApp {
  on(event: 'login', listener: LoginListener): unknown;
}

/** Installs the one `login` listener (main, once). */
export function installProxyLogin(app: LoginApp, deps: ProxyLoginDeps): LoginListener {
  const listener = createProxyLogin(deps);
  app.on('login', listener);
  return listener;
}
