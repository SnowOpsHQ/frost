import { app, session as electronSession, type BrowserWindow, type Session, type WebContents } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { guardBrowseContents, type BrowseGuardHooks } from '../browser/guard';
import { openExternalIfAllowed, trackUserGesture } from './gesture';
import { isAllowedAppNavigation, isAppUrl, isPermissionGranted, withAppCsp } from './policy';

// Electron wiring for `specs/security-policy.spec.ts` (acceptance: `specs/external-url.feature.md`).

export interface SecurityOptions {
  /** Vite dev-server URL; pass it only when unpackaged under `electron-forge start`. */
  devServerUrl?: string | undefined;
  /** Monotonic clock in ms for gesture timing; injectable for tests. */
  now?: () => number;
  /**
   * What the browse guard (tabs' WebContents) asks of the browser controller: gesture-backed popups
   * become background tabs (`browse-guard.feature.md`). Without it, popups open nothing.
   */
  browse?: BrowseGuardHooks | undefined;
}

const guarded = new WeakSet<WebContents>();
/** Sessions whose downloads `registerSecurity` already cancels (its listener is added once). */
const downloadsRefused = new WeakSet<Session>();

/** The installed app-wide guard: the one source of WebContents guard options. */
let appWide: { options: SecurityOptions; listener: (event: unknown, contents: WebContents) => void } | undefined;

function sameOptions(a: SecurityOptions, b: SecurityOptions): boolean {
  return a.devServerUrl === b.devServerUrl && a.now === b.now && a.browse === b.browse;
}

/** The installed app-wide guard, if its listener is still attached to `app`. */
function installedAppWide(): typeof appWide {
  return appWide && app.listeners('web-contents-created').includes(appWide.listener) ? appWide : undefined;
}

/**
 * Checks `options` against the installed app-wide guard and returns the options to guard with:
 * `options` (or the installed ones when omitted). Throws on a conflict rather than silently
 * keeping the first registration's options.
 */
function resolveOptions(options: SecurityOptions | undefined): SecurityOptions {
  const installed = installedAppWide();
  if (!installed) return options ?? {};
  if (options && !sameOptions(options, installed.options)) {
    throw new Error('security: conflicting SecurityOptions; app-wide guards are already installed with different options');
  }
  return installed.options;
}

/**
 * Applies the session-wide policy (deny-by-default permissions, `app://` CSP) and makes sure the
 * app-wide WebContents guards are installed (with `options`), then guards `win` — which was created
 * before this call, so `web-contents-created` may have fired before the guards existed. Omitting
 * `options` reuses the installed ones; differing options throw (spec `rejects-conflicting-security-options`).
 *
 * The session holds a single `onHeadersReceived` listener; it is owned here (its single
 * `onBeforeRequest` listener is owned by `protocol/requests.ts`). In Electron 45 it fires
 * for, and its headers are enforced on, `protocol.handle` responses (verified against the built
 * bundle); the `app://` handler (Task 4) should still set `appCspHeader()` on its own `Response`
 * as defense in depth.
 */
export function registerSecurity(session: Session, win: BrowserWindow, options?: SecurityOptions): void {
  const resolved = resolveOptions(options);

  session.setPermissionRequestHandler((_contents, permission, callback) => callback(isPermissionGranted(permission)));
  session.setPermissionCheckHandler((_contents, permission) => isPermissionGranted(permission));
  session.setDevicePermissionHandler(() => false);

  session.webRequest.onHeadersReceived((details, callback) => {
    if (!isAppUrl(details.url)) return callback({});
    callback({ responseHeaders: withAppCsp(details.responseHeaders) });
  });

  // The chrome never downloads anything (spec `browse-guard.feature.md`, app-session-cancels-downloads).
  if (!downloadsRefused.has(session)) {
    downloadsRefused.add(session);
    session.on('will-download', (event, item) => {
      event.preventDefault();
      item.cancel();
    });
  }

  registerAppWideGuards(resolved);
  guardWebContents(win.webContents, resolved);
}

/**
 * Guards every WebContents created from now on, so none is ever left on Electron defaults. Each is
 * classified at creation by session: browse-partition contents (tabs) get the browse guard
 * (`browser/guard.ts`), everything else the app pin below. This is the only place WebContents
 * guard options come from: calling it again with equal options is a no-op, with different options
 * it throws.
 */
export function registerAppWideGuards(options: SecurityOptions = {}): void {
  if (installedAppWide()) {
    resolveOptions(options);
    return;
  }
  const listener = (_event: unknown, contents: WebContents) => {
    if (isBrowseContents(contents)) guardBrowseOnce(contents, options);
    else guardWebContents(contents, options);
  };
  appWide = { options, listener };
  app.on('web-contents-created', listener);
  refuseBadCertificates();
}

/**
 * Certificates (spec `browse-guard.feature.md`): a certificate error is always refused, for every
 * WebContents (`preventDefault` + `callback(false)`, never `true`; Electron's default also refuses,
 * this makes it explicit), and no client certificate is ever sent (Electron's default picks the
 * first one from the store).
 */
function refuseBadCertificates(): void {
  app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
}

/**
 * Classifies a new WebContents by its session (spec `browser-chrome.feature.md`): `true` only for
 * the browse partition's session. Anything else — the default session, another partition, a
 * missing or throwing `session` — is app content and keeps the app pin (fail closed).
 */
function isBrowseContents(contents: WebContents): boolean {
  try {
    const ses: unknown = contents.session;
    return ses !== undefined && ses !== null && ses === electronSession.fromPartition(BROWSE_PARTITION);
  } catch {
    return false;
  }
}

function guardBrowseOnce(contents: WebContents, options: SecurityOptions): void {
  if (guarded.has(contents)) return;
  guarded.add(contents);
  guardBrowseContents(contents, { now: options.now ?? (() => performance.now()), hooks: options.browse });
}

/**
 * Per-WebContents guards for app content (idempotent; only reached via the app-wide options above):
 * - `window.open` / `target=_blank` never creates a window; the URL goes to `shell.openExternal`
 *   only if allowlisted and backed by a live, unconsumed trusted activation input. Activation is
 *   per-WebContents, not per-frame (spec known limit, revisit in Phase 1).
 * - `will-frame-navigate` (main frame and subframes; `will-navigate` is main-frame-only) and
 *   `will-redirect` are pinned to the app origin (plus the dev server in dev). Off-origin
 *   navigations are dropped, not forwarded to `openExternal`.
 * - `<webview>` attachment is always refused.
 */
function guardWebContents(contents: WebContents, options: SecurityOptions): void {
  if (guarded.has(contents)) return;
  guarded.add(contents);

  const gesture = trackUserGesture(contents, options.now ?? (() => performance.now()));

  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url, gesture.consume());
    return { action: 'deny' };
  });

  const pinToApp = (details: { url: string; preventDefault(): void }): void => {
    if (!isAllowedAppNavigation(details.url, options)) details.preventDefault();
  };
  contents.on('will-frame-navigate', pinToApp);
  contents.on('will-redirect', pinToApp);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
