import type { Session, WebContents } from 'electron';
import { BROWSABLE_SCHEMES, BROWSE_BLANK_URL } from '@app/specs/browser.spec';

// The browse guard for tab WebContents (`specs/browser-chrome.feature.md`, "Session-classified
// guard"). Installed by the app-wide `web-contents-created` guard in `security/register.ts` for
// WebContents on the browse partition's session; Task 3 extends it.

/** Whether a tab may navigate or be redirected to `url`: `BROWSABLE_SCHEMES` or `about:blank`. */
export function isBrowsableNavigation(url: string): boolean {
  if (url === BROWSE_BLANK_URL) return true;
  try {
    return (BROWSABLE_SCHEMES as readonly string[]).includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Guards one browse-session WebContents:
 * - `will-frame-navigate` (any frame) and `will-redirect`: only `http:`/`https:`/`about:blank`;
 *   anything else is dropped, never opened externally.
 * - `window.open` / `target=_blank`: denied (Task 3 turns gesture-backed web opens into tabs).
 * - `<webview>`: refused.
 */
export function guardBrowseContents(contents: WebContents): void {
  const pinToWeb = (details: { url: string; preventDefault(): void }): void => {
    if (!isBrowsableNavigation(details.url)) details.preventDefault();
  };
  contents.on('will-frame-navigate', pinToWeb);
  contents.on('will-redirect', pinToWeb);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Session-wide policy of the browse partition: every permission request, check and device
 * permission is denied (Phase 0's deny-by-default; Task 4 adds per-origin prompts). The session's
 * `webRequest` slots are left free for Task 3.
 */
export function hardenBrowseSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}
