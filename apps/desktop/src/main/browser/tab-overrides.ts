import { DEFAULT_TAB_OVERRIDES, isDefaultTabOverrides, type TabOverrides } from '@app/specs/render-profile.spec';
import type { CookieBlock, CookieBlockSession } from './cookie-block';
import { runCssOff, type CssOffTarget } from './css-off';
import type { Tab, TabView } from './tab-model';

// Tab overrides: a part of the browser controller (spec `render-profile.feature.md`, Tab overrides;
// Phase 11 Task 6, Decision 8). Each tab's CSS off, cookies off and browser geolocation, held per tab
// object (gone with the tab, never pinned or inherited), with:
// - the **override revision**, raised on every `set` and every time the document marker is set;
// - the **document marker** (`loadedUnderOverrides`), from the tab's main-frame navigation events:
//   set when a document commits, or is still loading, while any override is on, and (security-review
//   ruling, stricter than Decision 8's wording) whenever an override turns on while the tab shows a
//   committed document, loaded or not (CSS off or cookies off may already have changed what the
//   page did); cleared only when a navigation to a new document completes with no override on at any
//   point from its start to its completion (setting wins); same-document navigations and turning
//   overrides off leave it alone.
// Putting them into effect: the CDP part (geolocation, `document.cookie`) is handed to
// `render-profile.ts` (`applyCdp`), which sends the tab's one merged command list; CSS off runs its
// script in the tab's top frame on each new document (`css-off.ts`); cookies off registers the tab's
// WebContents with the cookie block on its own session (`cookie-block.ts`). Nothing here talks to a
// debugger.

type TabContents = TabView['webContents'];

export interface TabOverridesOptions {
  /** The tab's overrides changed: the CDP part goes into the tab's merged list (`render-profile.ts`). */
  readonly applyCdp: (tab: Tab, overrides: TabOverrides) => void;
  /** The HTTP cookie block (`cookie-block.ts`). */
  readonly cookieBlock: CookieBlock;
  /** Runs CSS off (`true`) or back on in a tab's top frame (default `runCssOff`); never rejects. */
  readonly cssOff?: (target: CssOffTarget, off: boolean) => Promise<boolean>;
  /** The browser state changed (bump and wake `watch`). */
  readonly changed: () => void;
}

/** A tab's overrides as `TabState` shows them. */
export interface TabOverridesState {
  readonly tabOverrides: TabOverrides;
  readonly loadedUnderOverrides: boolean;
  readonly overridesRevision: number;
}

export interface TabOverridesStore {
  /** Sets the tab's overrides (all off: back to normal); raises its revision and puts them into effect. */
  set(tab: Tab, overrides: TabOverrides): void;
  /** The tab's overrides now (all off for a tab that never had any). */
  get(tab: Tab): TabOverrides;
  /** `TabState.tabOverrides`, `loadedUnderOverrides` and `overridesRevision`. */
  state(tab: Tab): TabOverridesState;
  /** Listens to the tab's new view (its main-frame navigations); answers what removes the listeners. */
  wire(tab: Tab, view: TabView): () => void;
  /** The tab's view is gone (closed, crashed away): its cookie block goes with its WebContents. */
  released(tab: Tab): void;
}

interface Entry {
  overrides: TabOverrides;
  revision: number;
  marker: boolean;
  /** A main-frame navigation to a new document started and has not committed: an override was seen since its start. */
  nav: { saw: boolean } | null;
  /** The committed document is still loading: an override was seen since its navigation started. */
  loading: { saw: boolean } | null;
  contents: TabContents | null;
  /** The WebContents id registered with the cookie block, if any. */
  blocked: number | null;
  /** The tab's view has committed a main-frame document (it shows a page, loaded or loading). */
  committed: boolean;
}

/** Whether an override that was off in `before` is on in `after` (a new location counts once it is set from none). */
const turnedOn = (before: TabOverrides, after: TabOverrides): boolean =>
  (!before.cssDisabled && after.cssDisabled) || (!before.cookiesDisabled && after.cookiesDisabled) || (before.geolocation === null && after.geolocation !== null);

const anyOn = (overrides: TabOverrides): boolean => !isDefaultTabOverrides(overrides);

/** A WebContents' id and session, when it has them (a real tab's; test fakes may not). */
function blockTarget(contents: TabContents | null): { id: number; session: CookieBlockSession } | null {
  if (!contents) return null;
  try {
    if (contents.isDestroyed()) return null;
    const { id, session } = contents as unknown as { id?: unknown; session?: CookieBlockSession | null };
    return typeof id === 'number' && session?.webRequest ? { id, session } : null;
  } catch {
    return null;
  }
}

export function createTabOverrides(options: TabOverridesOptions): TabOverridesStore {
  const entries = new WeakMap<Tab, Entry>();
  const cssOff = options.cssOff ?? runCssOff;

  const entryOf = (tab: Tab): Entry => {
    let entry = entries.get(tab);
    if (!entry) {
      entry = { overrides: DEFAULT_TAB_OVERRIDES, revision: 0, marker: false, nav: null, loading: null, contents: null, blocked: null, committed: false };
      entries.set(tab, entry);
    }
    return entry;
  };

  const setMarker = (entry: Entry): void => {
    entry.marker = true;
    entry.revision += 1;
  };

  /** CSS off (or back on) in the tab's current document. */
  const runCss = (entry: Entry, off: boolean): void => {
    const contents = entry.contents;
    if (!contents || contents.isDestroyed()) return;
    void cssOff(contents as unknown as CssOffTarget, off);
  };

  /** The cookie block for the tab's current WebContents, as its overrides say. */
  const syncCookies = (entry: Entry): void => {
    const target = entry.overrides.cookiesDisabled ? blockTarget(entry.contents) : null;
    if (target === null) {
      if (entry.blocked !== null) options.cookieBlock.remove(entry.blocked);
      entry.blocked = null;
      return;
    }
    if (entry.blocked !== null && entry.blocked !== target.id) options.cookieBlock.remove(entry.blocked);
    options.cookieBlock.add(target.id, target.session);
    entry.blocked = target.id;
  };

  return {
    set(tab, overrides) {
      const entry = entryOf(tab);
      const before = entry.overrides;
      entry.overrides = overrides;
      entry.revision += 1;
      if (anyOn(overrides)) {
        if (entry.nav) entry.nav.saw = true;
        if (entry.loading) entry.loading.saw = true;
        // The document on screen is still loading (it loads under the override), or an override turned
        // on over a committed document (it may already have changed what the page did): marked.
        if (entry.loading || (entry.committed && turnedOn(before, overrides))) setMarker(entry);
      }
      syncCookies(entry);
      if (before.cssDisabled !== overrides.cssDisabled) runCss(entry, overrides.cssDisabled);
      options.applyCdp(tab, overrides);
      options.changed();
    },

    get: (tab) => entries.get(tab)?.overrides ?? DEFAULT_TAB_OVERRIDES,

    state(tab) {
      const entry = entries.get(tab);
      return entry ? { tabOverrides: entry.overrides, loadedUnderOverrides: entry.marker, overridesRevision: entry.revision } : { tabOverrides: DEFAULT_TAB_OVERRIDES, loadedUnderOverrides: false, overridesRevision: 0 };
    },

    wire(tab, view) {
      const entry = entryOf(tab);
      const contents = view.webContents;
      entry.contents = contents;
      entry.nav = null;
      entry.loading = null;
      entry.committed = false;
      syncCookies(entry);
      const emitter = contents as unknown as NodeJS.EventEmitter;
      const owns = (): boolean => entries.get(tab) === entry && entry.contents === contents;
      const listeners: [string, (...args: never[]) => void][] = [
        [
          'did-start-navigation',
          (details: { isMainFrame?: unknown; isSameDocument?: unknown }) => {
            if (!owns() || details?.isMainFrame !== true || details.isSameDocument === true) return;
            // Setting wins across overlapping navigations: what an earlier, uncommitted one saw is kept.
            entry.nav = { saw: (entry.nav?.saw ?? false) || anyOn(entry.overrides) };
          },
        ],
        [
          'did-navigate',
          () => {
            if (!owns()) return;
            // A new main-frame document committed (Electron reports the start first; without it, now decides).
            const saw = (entry.nav?.saw ?? false) || anyOn(entry.overrides);
            entry.nav = null;
            entry.loading = { saw };
            entry.committed = true;
            if (entry.overrides.cssDisabled) runCss(entry, true);
            if (saw) {
              setMarker(entry);
              options.changed();
            }
          },
        ],
        [
          'dom-ready',
          () => {
            // The document's stylesheets are all there now (the script is idempotent per document).
            if (owns() && entry.overrides.cssDisabled) runCss(entry, true);
          },
        ],
        [
          'did-fail-load',
          (_event: unknown, _code: unknown, _description: unknown, _url: unknown, isMainFrame: unknown) => {
            // A navigation that never committed leaves the document (and its marker) as it was.
            if (owns() && isMainFrame === true) entry.nav = null;
          },
        ],
        [
          'did-stop-loading',
          () => {
            if (!owns()) return;
            // The tab stopped loading with a main-frame navigation started and not committed: it ended
            // without a new document (a download, a 204), so what it saw goes with it. (A navigation
            // still to commit keeps the tab loading: Chromium counts it until it commits or ends.)
            entry.nav = null;
            const loading = entry.loading;
            entry.loading = null;
            // The navigation completed with no override on from its start to now: cleared.
            if (loading && !loading.saw && !anyOn(entry.overrides) && entry.marker) {
              entry.marker = false;
              options.changed();
            }
          },
        ],
      ];
      for (const [event, listener] of listeners) emitter.on(event, listener as (...args: unknown[]) => void);
      return () => {
        for (const [event, listener] of listeners) emitter.off(event, listener as (...args: unknown[]) => void);
      };
    },

    released(tab) {
      const entry = entries.get(tab);
      if (!entry) return;
      if (entry.blocked !== null) options.cookieBlock.remove(entry.blocked);
      entry.blocked = null;
      entry.contents = null;
      entry.nav = null;
      entry.loading = null;
      entry.committed = false;
    },
  };
}
