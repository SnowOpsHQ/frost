import { dialog, session, type BaseWindow } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { CLEAR_SITE_DATA } from '@app/specs/devtools.spec';

// "Clear this site's data" (spec `devtools.spec.ts`, `CLEAR_SITE_DATA`; acceptance
// `devtools.feature.md`, Storage): main's own confirmation and the clearing, on the browse
// partition only (never the app's session).

/**
 * The confirmation: `dialog.showMessageBox` with `CLEAR_SITE_DATA.dialog` and the origin in its
 * detail, parented to `parent` (with none, an app-modal box). Only `CLEAR_SITE_DATA.confirmIndex`
 * confirms; Cancel is the default and the Esc answer.
 */
export async function confirmClearSiteData(parent: BaseWindow | null, origin: string): Promise<boolean> {
  const options = { ...CLEAR_SITE_DATA.dialog, buttons: [...CLEAR_SITE_DATA.dialog.buttons], detail: CLEAR_SITE_DATA.detail(origin) };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_SITE_DATA.confirmIndex;
}

/** Clears `origin`'s cookies (its whole registrable domain, as Chromium does), storage and cache from the browse partition. */
export async function clearBrowseOrigin(origin: string): Promise<void> {
  await session.fromPartition(BROWSE_PARTITION).clearData({ origins: [origin], dataTypes: [...CLEAR_SITE_DATA.dataTypes] });
}

/** The browse partition's cookies for `url`. */
export function browseCookies(url: string): Promise<Electron.Cookie[]> {
  return session.fromPartition(BROWSE_PARTITION).cookies.get({ url });
}
