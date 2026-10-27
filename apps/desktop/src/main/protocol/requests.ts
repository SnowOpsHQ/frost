import type { Session } from 'electron';
import { APP_REQUEST_FILTER } from '@app/specs/app-protocol.spec';
import type { WebContentsIdentity } from '../app-windows';

// Who may load `app://` (spec `APP_REQUEST_FILTER` in `specs/app-protocol.spec.ts`; acceptance:
// `specs/app-protocol.feature.md`).

/**
 * Cancels every `app://` request in `session` that does not come from an app window (or its
 * DevTools), so no other page can embed the app's resources. Fails closed: no WebContents, or a
 * check that throws, cancels.
 *
 * The session holds a single `onBeforeRequest` listener; it is owned here. Do not register another.
 */
export function restrictAppRequests(session: Session, isAppWebContents: (contents: WebContentsIdentity) => boolean): void {
  session.webRequest.onBeforeRequest({ urls: [...APP_REQUEST_FILTER.urls] }, (details, callback) => {
    let allowed = false;
    try {
      allowed = details.webContents !== undefined && isAppWebContents(details.webContents);
    } catch {
      allowed = false;
    }
    callback({ cancel: !allowed });
  });
}
