import type { ContextMenuParams } from 'electron';
import { IGNORED_LOAD_ERROR_CODES } from '@app/specs/browse-guard.spec';
import { FULLSCREEN_EXIT_KEY } from '@app/specs/permissions.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from './address';
import type { Fullscreen } from './fullscreen';
import type { SessionSink } from './session-sync';
import type { KeyInput } from './shortcuts';
import { aliveContents, type HostWindow, type Tab, type TabView } from './tab-model';

// What the controller hears from a tab's WebContents (specs `browser-chrome.feature.md`,
// `browse-guard.feature.md`, `permissions.feature.md`, `browser-session-db.feature.md`,
// `page-commands.feature.md`): the listeners `wireTabView` adds, and what each one does.

/**
 * WebContents events after which a tab's state is re-read (plus `did-start-loading`, `did-navigate`,
 * `did-fail-load` and `render-process-gone`, below).
 */
const STATE_EVENTS = ['did-stop-loading', 'did-navigate-in-page', 'page-title-updated'] as const;

/** A right-click in a tab's page, as handed to `BrowserControllerOptions.contextMenu`. */
export interface TabContextMenuRequest {
  /** The tab's WebContents (its page was clicked). */
  readonly contents: TabView['webContents'];
  readonly params: ContextMenuParams;
  readonly window: HostWindow;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** What the listeners act on (the controller). */
export interface TabEventContext {
  /** Whether `tab` is still in the strip. */
  isOpen(tab: Tab): boolean;
  /** The attached window, if any. */
  window(): HostWindow | null;
  /** Re-reads `tab`'s state from its WebContents (bumping the version on a real change). */
  refresh(tab: Tab): void;
  /** The state changed. */
  changed(): void;
  /** Denies `tab`'s pending prompts; answers whether it had any. */
  denyPrompts(tab: Tab): boolean;
  readonly fullscreen: Fullscreen;
  applyBounds(tab: Tab): void;
  readonly session: SessionSink | undefined;
  /** Stops `tab`'s page while it loads (not in fullscreen). */
  stopLoading(tab: Tab): void;
  /** Takes a reserved tab or page shortcut from `before-input-event`. */
  takeShortcut(event: { preventDefault(): void }, input: KeyInput): void;
  /** Closes the tab (its page closed itself). */
  removeTab(tabId: number): void;
  readonly contextMenu: ((request: TabContextMenuRequest) => void) | undefined;
}

/** Whether no modifier key is held. */
function unmodified(input: KeyInput): boolean {
  return !input.control && !input.meta && !input.alt && !input.shift;
}

/**
 * Listens to `view`'s WebContents for `tab`; answers the function that removes every listener.
 * Events count only while `view` is still this open tab's: a closed tab's (or a dropped view's)
 * pending or late events are ignored, and its listeners are removed on release as well.
 */
export function wireTabView(tab: Tab, view: TabView, ctx: TabEventContext): () => void {
  const owns = (): boolean => tab.view === view && ctx.isOpen(tab);
  const emitter = view.webContents as unknown as NodeJS.EventEmitter;
  const listeners: [string, (...args: unknown[]) => void][] = [];
  const listen = <A extends unknown[]>(event: string, listener: (...args: A) => void): void => {
    const guarded = (...args: A): void => {
      if (owns()) listener(...args);
    };
    emitter.on(event, guarded);
    listeners.push([event, guarded as (...args: unknown[]) => void]);
  };
  const { session, fullscreen } = ctx;

  for (const event of STATE_EVENTS) listen(event, () => ctx.refresh(tab));
  // Visits (`browser-session-db.feature.md`): main-frame `http(s)` commits; a page's title
  // updates its visit, never an error page's.
  const recordVisit = (url: unknown): void => {
    if (typeof url === 'string' && isWebUrl(url)) session?.recordVisit(url);
  };
  listen('did-navigate-in-page', (_event: unknown, url: unknown, isMainFrame: unknown) => {
    if (isMainFrame === true) recordVisit(url);
  });
  listen('page-title-updated', () => {
    const url = view.webContents.getURL();
    if (session && tab.error === null && !tab.crashed && tab.state.title !== '' && isWebUrl(url)) session.updateVisitTitle(url, tab.state.title);
  });
  listen('did-start-loading', () => {
    tab.crashed = false;
    ctx.refresh(tab);
  });
  // A main-frame page committed (Electron emits `did-navigate` only for non-error pages): the
  // old document's permission prompts are denied, and the new one is not fullscreen.
  listen('did-navigate', (_event: unknown, url: unknown) => {
    // Loading what was open at the last launch (its saved URL) is not a new visit.
    const restoring = tab.restored !== null && url === tab.restored.url;
    tab.error = null;
    tab.restored = null;
    tab.exitRequested = false;
    if (ctx.denyPrompts(tab)) ctx.changed();
    if (fullscreen.clear(tab)) ctx.applyBounds(tab);
    ctx.refresh(tab);
    if (!restoring) recordVisit(url);
  });
  // Main-frame load failures show the error panel; `ERR_ABORTED` (a dropped navigation, a stop,
  // a download) and subframe failures do not.
  listen('did-fail-load', (_event: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
    if (isMainFrame && Number.isInteger(code) && code < 0 && !(IGNORED_LOAD_ERROR_CODES as readonly number[]).includes(code)) {
      tab.error = { code, description: String(description), url: displayUrl(String(validatedUrl)) };
      tab.restored = null;
      // An error page replaces the document that asked.
      if (ctx.denyPrompts(tab)) ctx.changed();
    }
    ctx.refresh(tab);
  });
  listen('render-process-gone', () => {
    tab.crashed = true;
    tab.unresponsive = false;
    if (ctx.denyPrompts(tab)) ctx.changed();
    ctx.refresh(tab);
  });
  // HTML fullscreen (granted without a prompt, `permissions.spec.ts`): the window goes
  // fullscreen; the chrome's notice banner shows first, then the page's view covers it all.
  listen('enter-html-full-screen', () => fullscreen.entered(tab));
  // Electron leaves HTML fullscreen on its own too (it handles Esc before `before-input-event`):
  // the page is asked to leave as well, since its document may still be entering.
  listen('leave-html-full-screen', () => fullscreen.left(tab));
  // Esc always leaves fullscreen: taken before the page can see (and swallow) it, and left from
  // main at once, whether or not the page cooperates.
  // The key-up of that Esc is kept from the page too (frost already left fullscreen on key-down).
  let escapeTaken = false;
  listen('before-input-event', (event: { preventDefault(): void }, input: KeyInput) => {
    if (input.key !== FULLSCREEN_EXIT_KEY) return;
    if (input.type === 'keyUp' && escapeTaken) {
      escapeTaken = false;
      event.preventDefault();
      return;
    }
    if (tab.fullscreen === null) {
      // Not fullscreen: Esc stops a loading page (`page-commands.feature.md`) and still reaches it.
      if (input.type === 'keyDown' && unmodified(input)) ctx.stopLoading(tab);
      return;
    }
    event.preventDefault();
    if (input.type !== 'keyDown') return;
    escapeTaken = true;
    fullscreen.leave(tab);
  });
  // A hang is the tab's own state: the status bar reports it while the tab is shown.
  listen('unresponsive', () => {
    tab.unresponsive = true;
    ctx.refresh(tab);
  });
  listen('responsive', () => {
    tab.unresponsive = false;
    ctx.refresh(tab);
  });
  // The page closed itself (`window.close()`): its tab closes like any other.
  listen('destroyed', () => ctx.removeTab(tab.id));
  // Reserved tab and page shortcuts are taken before the page can see (and cancel) them.
  listen('before-input-event', (event: { preventDefault(): void }, input: KeyInput) => ctx.takeShortcut(event, input));
  // A right-click in the page: main shows the context menu for it.
  listen('context-menu', (_event: unknown, params: ContextMenuParams) => {
    const contents = aliveContents(view);
    const win = ctx.window();
    if (!contents || !ctx.contextMenu || !win || win.isDestroyed()) return;
    ctx.contextMenu({
      contents,
      params,
      window: win,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
  });

  return () => {
    for (const [event, listener] of listeners) emitter.off(event, listener);
  };
}
