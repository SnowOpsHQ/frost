import { dialog, session, type BaseWindow } from 'electron';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';

// Clear Browsing Data… (spec `browser-session-db.feature.md`, Clear browsing data): the
// application menu's item asks first, in a native message box main shows, then clears the visits,
// every permission decision (stored and in memory) with the prompt back-off, the render profiles
// pinned to sites (stored and in memory), the browse partition's storage and cache, and the SEO
// auditor's robots.txt answers and recorded responses. It keeps the Content panel's target queries
// and snippet drafts (the user's own work; the dialog says so) unless its checkbox is ticked. It closes no tab and leaves the app
// UI's session alone. The command palette's Clear Browsing Data runs this same action.

/** What clearing is made of (injected, so the order and the failure handling are unit-tested). */
export interface ClearBrowsingDataParts {
  /** Asks the user; answers whether to clear (`'with-content-notes'`: yes, and the dialog's checkbox was ticked). */
  confirm(): Promise<boolean | 'with-content-notes'>;
  /** Every remembered permission decision and the back-off, in memory (the broker). */
  forgetPermissionDecisions(): void;
  /** The AI agent's standing grants (per-site trust, like a permission; `clear-forgets-agent-grants`). Its chats are not cleared here. */
  forgetAgentGrants?(): Promise<unknown>;
  /** Every stored visit and decision (the session writer, after its earlier writes). */
  clearStoredData(): Promise<void>;
  /** The browse partition's storage and HTTP cache (`clearBrowseStorage`). */
  clearBrowseStorage(): Promise<void>;
  /** The SEO auditor's per-origin robots.txt answers and recorded tab responses (`seo-indexability.feature.md`). */
  forgetSeoCaches(): void;
  /** Every target query and snippet draft (`seo-content.spec.ts`); only when the checkbox was ticked. */
  clearContentNotes?(): Promise<void>;
  /** The closed-tab stack: with the stored visits, the history part ("Clear all history" runs it alone; `browser-polish.feature.md`). */
  forgetClosedTabs?(): void;
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
    let confirmed: boolean | 'with-content-notes' = false;
    await attempt('(the confirmation)', async () => {
      confirmed = await parts.confirm();
    });
    if (!confirmed) return false;
    await attempt('permission decisions', () => parts.forgetPermissionDecisions());
    await attempt('agent grants', () => parts.forgetAgentGrants?.());
    await attempt('recently closed tabs', () => parts.forgetClosedTabs?.());
    await attempt('stored visits and decisions', () => parts.clearStoredData());
    await attempt('site storage and cache', () => parts.clearBrowseStorage());
    await attempt('robots.txt answers and recorded responses', () => parts.forgetSeoCaches());
    if (confirmed === 'with-content-notes') await attempt('content notes', () => parts.clearContentNotes?.());
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
 * `parent` (with none, an app-modal box). Only `CLEAR_BROWSING_DATA.confirmIndex` confirms; with its
 * checkbox ticked the answer is `'with-content-notes'`.
 */
export async function confirmClearBrowsingData(parent: BaseWindow | null): Promise<boolean | 'with-content-notes'> {
  const options = { ...CLEAR_BROWSING_DATA.dialog, buttons: [...CLEAR_BROWSING_DATA.dialog.buttons] };
  const { response, checkboxChecked } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== CLEAR_BROWSING_DATA.confirmIndex) return false;
  return checkboxChecked ? 'with-content-notes' : true;
}

/** Clears the browse partition's storage (cookies, local storage, IndexedDB, service workers …), then its HTTP cache. */
export async function clearBrowseStorage(): Promise<void> {
  const browse = session.fromPartition(BROWSE_PARTITION);
  await browse.clearStorageData();
  await browse.clearCache();
}
