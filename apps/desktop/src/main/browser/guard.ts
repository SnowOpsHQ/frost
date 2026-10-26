import type { Session, WebContents } from 'electron';
import { BROWSE_BLANK_URL } from '@app/specs/browser.spec';
import { BLANK_ABOUT_PATH, SUBFRAME_ONLY_URLS } from '@app/specs/browse-guard.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { resolveExternalOpen } from '../security/policy';
import { openExternalIfAllowed, trackUserGesture } from '../security/gesture';
import type { BrowsePermissionHandlers } from './permissions';

// The browse guard for tab WebContents (`specs/browse-guard.feature.md`; the session-classified
// install is `browser-chrome.feature.md`). Installed by the app-wide `web-contents-created` guard
// in `security/register.ts` for WebContents on the browse partition's session.

function includes(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/** Whether `url` is `about:blank`, with any query or fragment (`BLANK_ABOUT_PATH`). */
function isAboutBlank(url: string): boolean {
  if (url === BROWSE_BLANK_URL) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' && parsed.pathname === BLANK_ABOUT_PATH;
  } catch {
    return false;
  }
}

/**
 * Whether a tab's frame may navigate or be redirected to `url`: `BROWSABLE_SCHEMES` or
 * `about:blank` (any query/fragment) in any frame, plus `SUBFRAME_ONLY_URLS` (`about:srcdoc`) in
 * subframes. `data:`, `blob:` and every other scheme are denied in every frame.
 */
export function isAllowedBrowseNavigation(url: string, { isMainFrame }: { isMainFrame: boolean }): boolean {
  if (isAboutBlank(url)) return true;
  if (!isMainFrame && includes(SUBFRAME_ONLY_URLS, url)) return true;
  return isWebUrl(url);
}

export type BrowseVerdict = 'allow' | 'open-externally' | 'drop';

/**
 * What to do with a renderer navigation (`will-frame-navigate`) or redirect (`will-redirect`) of a
 * tab's frame. Browsable → `allow` (the gesture is not read). A non-browsable navigation is
 * dropped, and, if the tab's main frame started it, handed to the Phase 0 external-open policy
 * (`resolveExternalOpen`, which reads the gesture). A non-browsable redirect (the server chose it)
 * or a navigation a subframe or nothing started is dropped without reading the gesture, so a
 * click in the top frame cannot be spent by a subframe.
 */
export function judgeBrowseNavigation(
  url: string,
  ctx: { isMainFrame: boolean; isRedirect: boolean; mainFrameInitiated: boolean; userGesture: () => boolean },
): BrowseVerdict {
  if (isAllowedBrowseNavigation(url, ctx)) return 'allow';
  if (ctx.isRedirect || !ctx.mainFrameInitiated) return 'drop';
  return resolveExternalOpen(url, { userGesture: ctx.userGesture() }) === 'allow' ? 'open-externally' : 'drop';
}

/** The fields of a `WebFrameMain` used to recognise the main frame. */
interface FrameRef {
  readonly frameTreeNodeId: number;
  readonly parent: unknown;
}

/**
 * Whether `initiator` (`will-frame-navigate`'s) is `contents`' main frame: no parent and the main
 * frame's frame tree node. `null` / `undefined` (no initiating frame, or it is gone) is not.
 */
function isMainFrameOf(contents: WebContents, initiator: FrameRef | null | undefined): boolean {
  if (!initiator) return false;
  try {
    return initiator.parent === null && initiator.frameTreeNodeId === contents.mainFrame.frameTreeNodeId;
  } catch {
    // The WebContents or its main frame is gone.
    return false;
  }
}

export type PopupVerdict = 'tab' | 'open-externally' | 'drop';

/**
 * What to do with a tab's `window.open` / `target=_blank` (never an Electron window): with a real
 * gesture an `http(s)` URL becomes a background tab and an allowlisted external URL (`mailto:`)
 * goes to the Phase 0 external-open policy; anything else, or no gesture, is dropped.
 */
export function judgeBrowsePopup(url: string, userGesture: boolean): PopupVerdict {
  if (!userGesture) return 'drop';
  if (isWebUrl(url)) return 'tab';
  if (isAboutBlank(url)) return 'drop';
  return resolveExternalOpen(url, { userGesture }) === 'allow' ? 'open-externally' : 'drop';
}

/** What the browse guard asks of the rest of main (the browser controller). */
export interface BrowseGuardHooks {
  /** Opens `url` in a new background tab next to the tab whose WebContents is `opener`. */
  openTab?(opener: WebContents, url: string): void;
}

/**
 * Guards one browse-session WebContents (spec `browse-guard.feature.md`):
 * - `will-frame-navigate` (any frame) and `will-redirect`: pinned by `judgeBrowseNavigation`; a
 *   dropped navigation the main frame started, to an allowlisted external scheme, on a real gesture
 *   is opened externally.
 * - Popups carry no frame (`HandlerDetails`), so their gesture stays per WebContents (accepted
 *   risk, `browse-guard.feature.md`, Gesture attribution).
 * - `window.open` / `target=_blank`: always `{ action: 'deny' }`; `judgeBrowsePopup` decides
 *   whether a background tab opens (through `hooks.openTab`) or the URL is opened externally.
 * - `<webview>`: refused.
 * - `beforeunload` cannot keep the user on the page: every `will-prevent-unload` is prevented.
 */
export function guardBrowseContents(contents: WebContents, options: { now: () => number; hooks?: BrowseGuardHooks | undefined }): void {
  const gesture = trackUserGesture(contents, options.now);

  const pin =
    (isRedirect: boolean) =>
    (details: { url: string; isMainFrame: boolean; initiator?: FrameRef | null; preventDefault(): void }): void => {
      // The verdict reads (and consumes) the gesture only if it needs it; keep what it read.
      let userGesture = false;
      const consume = (): boolean => (userGesture = gesture.consume());
      const mainFrameInitiated = !isRedirect && isMainFrameOf(contents, details.initiator);
      const verdict = judgeBrowseNavigation(details.url, { isMainFrame: details.isMainFrame, isRedirect, mainFrameInitiated, userGesture: consume });
      if (verdict === 'allow') return;
      details.preventDefault();
      // The shared flow re-checks the URL and that gesture before opening.
      if (verdict === 'open-externally') openExternalIfAllowed(details.url, userGesture);
    };
  contents.on('will-frame-navigate', pin(false));
  contents.on('will-redirect', pin(true));

  contents.setWindowOpenHandler(({ url }) => {
    const userGesture = gesture.consume();
    const verdict = judgeBrowsePopup(url, userGesture);
    if (verdict === 'tab') options.hooks?.openTab?.(contents, url);
    else if (verdict === 'open-externally') openExternalIfAllowed(url, userGesture);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());

  // Without this Electron cancels the unload a page's `beforeunload` asks to stop (no dialog), so a
  // page could block navigating away from it and reloading.
  contents.on('will-prevent-unload', (event) => event.preventDefault());
}

/** What the browse session reports to, and asks of, the rest of main. */
export interface BrowseSessionHooks {
  /** A download was cancelled (raise the `download-blocked` notice). */
  onDownloadBlocked?(contents: WebContents | null | undefined): void;
  /**
   * Per-origin permission prompts (`permissions.feature.md`, `createBrowsePermissionHandlers`).
   * Without them every permission request and check is denied.
   */
  permissions?: BrowsePermissionHandlers | undefined;
}

/**
 * Session-wide policy of the browse partition: permission requests and checks go to the
 * per-origin prompt handlers (`hooks.permissions`; deny-all without them, which also keeps
 * Electron's `openExternal` permission denied); device permissions (HID, serial, USB) are always
 * denied; every `file:` request fails; every download is cancelled (no download manager in Phase 1). No certificate-verify proc
 * is installed: Chromium's verifier decides, and the app-wide `certificate-error` handler never
 * overrides it (`security/register.ts`).
 */
export function hardenBrowseSession(session: Session, hooks: BrowseSessionHooks = {}): void {
  const permissions = hooks.permissions;
  if (permissions) {
    session.setPermissionRequestHandler((contents, permission, callback, details) => permissions.request(contents, permission, callback, details));
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      permissions.check(contents, permission, requestingOrigin, details),
    );
  } else {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
  }
  session.setDevicePermissionHandler(() => false);
  // Backstop for `file:` (`browse-guard.feature.md`): the navigation guards and Chromium already
  // keep pages off it, but a load main starts (`loadURL`, e.g. a future bug in restore) passes no
  // navigation guard. This session's own `file:` handler fails every such request; other sessions
  // (the app UI's) keep theirs.
  session.protocol.handle('file', () => Response.error());
  session.on('will-download', (event, item, contents) => {
    event.preventDefault();
    item.cancel();
    hooks.onDownloadBlocked?.(contents);
  });
}
