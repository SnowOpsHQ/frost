import type { BrowserWindow, WebContentsView } from 'electron';
import { WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH, type LoadError, type PageBounds, type TabState } from '@app/specs/browser.spec';
import { DEFAULT_ZOOM, ZOOM_FACTORS } from '@app/specs/page-commands.spec';

// The browser controller's tab model (`controller.ts`): what it keeps per tab and the strip state
// its parts share, plus pure helpers over them. Only Electron *types* are imported.

/** A tab's page view (`createTabView()`); it is attached to the window's `contentView`. */
export type TabView = WebContentsView;
/** The parts of the app window the controller uses. */
export type HostWindow = Pick<
  BrowserWindow,
  'contentView' | 'webContents' | 'getContentSize' | 'setTitle' | 'on' | 'once' | 'isDestroyed' | 'isFullScreen' | 'setFullScreen'
>;

/**
 * A tab's own state; its `permissionPrompt` comes from the broker and its `auditVersion` from the
 * SEO auditor when the state is read.
 */
export type PageState = Omit<TabState, 'permissionPrompt' | 'auditVersion'>;
export type FullscreenMode = NonNullable<TabState['fullscreen']>;

export interface Tab {
  readonly id: number;
  /**
   * Created on the first navigation; an empty tab has none (nothing to show or guard). Dropped
   * again when its WebContents is destroyed (the page called `window.close()`).
   */
  view: TabView | null;
  /** Removes this controller's listeners from `view`'s WebContents (a no-op without a view). */
  unlisten: () => void;
  /** The renderer died (`render-process-gone`); reported as not loading until the next load starts. */
  crashed: boolean;
  /** The last main-frame load failed (`did-fail-load`); cleared by the next main-frame commit. */
  error: LoadError | null;
  /** The page stopped responding (`unresponsive`) and has not responded since. */
  unresponsive: boolean;
  /**
   * HTML fullscreen (`enter-html-full-screen`): `notice` while the chrome's fullscreen banner shows
   * above the view, then `full` (the view covers the whole window); `null` when not fullscreen.
   */
  fullscreen: FullscreenMode | null;
  /** Ends the `notice` phase. */
  fullscreenTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The tab left HTML fullscreen (frost took it out, or Electron reported `leave-html-full-screen`)
   * but its document may still hold a fullscreen element: Electron can report leaving while the
   * renderer is still entering (macOS, Esc during the native animation), and a hidden page
   * completes its exit only once shown. The page is asked to leave once the window settled
   * (`fullscreen.ts`, `schedulePageExits`), and again whenever the view is shown, until it enters
   * fullscreen again or a new document commits (asking a page that is not fullscreen does nothing).
   */
  exitRequested: boolean;
  /** The tab whose page opened this one (popup placement), if any. */
  readonly openerId: number | null;
  /**
   * A restored tab's saved URL and title: loaded when the tab is first shown, and reported as its
   * state until its view commits something (a load in flight has no URL yet).
   */
  restored: { readonly url: string; readonly title: string } | null;
  state: PageState;
}

/** The strip and window state the controller's parts share (one object, mutated in place). */
export interface StripState {
  tabs: Tab[];
  activeTabId: number | null;
  win: HostWindow | null;
  /** The one view attached to the window: the active tab's, or none. */
  attached: TabView | null;
  pageBounds: PageBounds | null;
}

export function noop(): void {}

export function emptyTabState(id: number): PageState {
  return { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, fullscreen: null, zoom: DEFAULT_ZOOM };
}

/** A new empty tab, not yet in the strip. */
export function createTab(id: number, openerId: number | null = null): Tab {
  return {
    id,
    view: null,
    unlisten: noop,
    crashed: false,
    error: null,
    unresponsive: false,
    fullscreen: null,
    fullscreenTimer: undefined,
    exitRequested: false,
    openerId,
    restored: null,
    state: emptyTabState(id),
  };
}

function sameError(a: LoadError | null, b: LoadError | null): boolean {
  return a === b || (a !== null && b !== null && a.code === b.code && a.description === b.description && a.url === b.url);
}

export function sameTabState(a: PageState, b: PageState): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.crashed === b.crashed &&
    a.unresponsive === b.unresponsive &&
    a.fullscreen === b.fullscreen &&
    a.zoom === b.zoom &&
    sameError(a.error, b.error)
  );
}

/** Whether a tab's page view is shown: not while its error or crash panel is. */
export function showsPage(tab: { error: LoadError | null; crashed: boolean }): boolean {
  return tab.error === null && !tab.crashed;
}

/** `title` cut to `WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH` characters, the last one an ellipsis. */
export function capTitle(title: string): string {
  const chars = [...title];
  if (chars.length <= WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH) return title;
  return `${chars.slice(0, WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH - 1).join('')}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rounds `bounds` to integers and clamps them inside a `width`×`height` content area. */
export function clampPageBounds(bounds: PageBounds, [width, height]: readonly [number, number]): PageBounds {
  const x = clamp(Math.round(bounds.x), 0, width);
  const y = clamp(Math.round(bounds.y), 0, height);
  return {
    x,
    y,
    width: clamp(Math.round(bounds.width), 0, width - x),
    height: clamp(Math.round(bounds.height), 0, height - y),
  };
}

/**
 * `view`'s WebContents while it is alive, else `undefined`. Electron clears `view.webContents` once
 * the contents are destroyed (already inside their `destroyed` listeners), so never read it bare.
 */
export function aliveContents(view: TabView): TabView['webContents'] | undefined {
  const contents = view.webContents as TabView['webContents'] | undefined;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

/** A WebContents' zoom factor, inside `ZOOM_FACTORS`' range (`DEFAULT_ZOOM` if it is no number). */
export function zoomOf(contents: TabView['webContents']): number {
  const factor = contents.getZoomFactor();
  return Number.isFinite(factor) ? clamp(factor, ZOOM_FACTORS[0], ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!) : DEFAULT_ZOOM;
}
