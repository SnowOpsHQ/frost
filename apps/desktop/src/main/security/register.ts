import { app, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import {
  hasTransientActivation,
  isActivationInput,
  isAllowedAppNavigation,
  isAppUrl,
  isPermissionGranted,
  parseExternalUrl,
  resolveExternalOpen,
  withAppCsp,
} from './policy';

// Electron wiring for `specs/security-policy.spec.ts` (acceptance: `specs/external-url.feature.md`).

export interface SecurityOptions {
  /** Vite dev-server URL; pass it only when unpackaged under `electron-forge start`. */
  devServerUrl?: string | undefined;
  /** Monotonic clock in ms for gesture timing; injectable for tests. */
  now?: () => number;
}

const guarded = new WeakSet<WebContents>();

/** The installed app-wide guard: the one source of WebContents guard options. */
let appWide: { options: SecurityOptions; listener: (event: unknown, contents: WebContents) => void } | undefined;

function sameOptions(a: SecurityOptions, b: SecurityOptions): boolean {
  return a.devServerUrl === b.devServerUrl && a.now === b.now;
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
 * The session holds a single `onHeadersReceived` listener; it is owned here. In Electron 45 it fires
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

  registerAppWideGuards(resolved);
  guardWebContents(win.webContents, resolved);
}

/**
 * Guards every WebContents created from now on, so none is ever left on Electron defaults. This is
 * the only place WebContents guard options come from: calling it again with equal options is a
 * no-op, with different options it throws.
 */
export function registerAppWideGuards(options: SecurityOptions = {}): void {
  if (installedAppWide()) {
    resolveOptions(options);
    return;
  }
  const listener = (_event: unknown, contents: WebContents) => guardWebContents(contents, options);
  appWide = { options, listener };
  app.on('web-contents-created', listener);
}

/**
 * Per-WebContents guards (idempotent; only reached via the app-wide options above):
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

  const now = options.now ?? (() => performance.now());
  let lastActivationAt: number | undefined;
  contents.on('input-event', (_event, input) => {
    if (isActivationInput(input.type)) lastActivationAt = now();
  });
  const consumeUserGesture = (): boolean => {
    const userGesture = hasTransientActivation(lastActivationAt, now());
    lastActivationAt = undefined;
    return userGesture;
  };

  contents.setWindowOpenHandler(({ url }) => {
    const userGesture = consumeUserGesture();
    const target = parseExternalUrl(url);
    if (target && resolveExternalOpen(url, { userGesture }) === 'allow') {
      shell.openExternal(target.href).catch((err: unknown) => console.error('openExternal failed', err));
    }
    return { action: 'deny' };
  });

  const pinToApp = (details: { url: string; preventDefault(): void }): void => {
    if (!isAllowedAppNavigation(details.url, options)) details.preventDefault();
  };
  contents.on('will-frame-navigate', pinToApp);
  contents.on('will-redirect', pinToApp);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
