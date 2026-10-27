import { dialog, session, type BaseWindow } from 'electron';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';

// Clear Browsing Data… (spec `browser-session-db.feature.md`, Clear browsing data): the
// application menu's item asks first, in a native message box main shows, then clears the visits,
// every permission decision (stored and in memory) with the prompt back-off, the browse
// partition's storage and cache, and the SEO auditor's robots.txt answers and recorded responses. It closes no tab and leaves the app UI's session alone.

/** What clearing is made of (injected, so the order and the failure handling are unit-tested). */
export interface ClearBrowsingDataParts {
  /** Asks the user; answers whether to clear. */
  confirm(): Promise<boolean>;
  /** Every remembered permission decision and the back-off, in memory (the broker). */
  forgetPermissionDecisions(): void;
  /** Every stored visit and decision (the session writer, after its earlier writes). */
  clearStoredData(): Promise<void>;
  /** The browse partition's storage and HTTP cache (`clearBrowseStorage`). */
  clearBrowseStorage(): Promise<void>;
  /** The SEO auditor's per-origin robots.txt answers and recorded tab responses (`seo-indexability.feature.md`). */
  forgetSeoCaches(): void;
  log(message: string): void;
}

/**
 * The menu item's action: asks, then (confirmed) runs every part in order, each on its own (one
 * failing is logged and the rest still run). Answers whether it cleared. While one runs, asking
 * again answers that same run (never two dialogs).
 */
export function createClearBrowsingData(parts: ClearBrowsingDataParts): () => Promise<boolean> {
  const attempt = async (what: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (error) {
      parts.log(`clear browsing data: clearing ${what} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  const clear = async (): Promise<boolean> => {
    let confirmed = false;
    await attempt('(the confirmation)', async () => {
      confirmed = await parts.confirm();
    });
    if (!confirmed) return false;
    await attempt('permission decisions', () => parts.forgetPermissionDecisions());
    await attempt('stored visits and decisions', () => parts.clearStoredData());
    await attempt('site storage and cache', () => parts.clearBrowseStorage());
    await attempt('robots.txt answers and recorded responses', () => parts.forgetSeoCaches());
    return true;
  };
  let running: Promise<boolean> | null = null;
  return () => {
    running ??= clear().finally(() => {
      running = null;
    });
    return running;
  };
}

/**
 * The confirmation: `dialog.showMessageBox` with `CLEAR_BROWSING_DATA.dialog`, parented to
 * `parent` (with none, an app-modal box). Only `CLEAR_BROWSING_DATA.confirmIndex` confirms.
 */
export async function confirmClearBrowsingData(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...CLEAR_BROWSING_DATA.dialog, buttons: [...CLEAR_BROWSING_DATA.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_BROWSING_DATA.confirmIndex;
}

/** Clears the browse partition's storage (cookies, local storage, IndexedDB, service workers …), then its HTTP cache. */
export async function clearBrowseStorage(): Promise<void> {
  const browse = session.fromPartition(BROWSE_PARTITION);
  await browse.clearStorageData();
  await browse.clearCache();
}
