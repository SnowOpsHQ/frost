import { FIND_TEXT_MAX_CHARS } from '@app/specs/browser-polish.spec';
import type { FindState } from '@app/specs/browser-polish.schema';
import type { Tab, TabView } from './tab-model';

// Find in page: a part of the browser controller (spec `browser-polish.spec.ts`; acceptance
// `browser-polish.feature.md`, Find in page). Each tab keeps its own find bar: whether it is open, the
// text and case switch last run, and the latest `found-in-page` answer for the latest request. Main
// runs `webContents.findInPage` itself; the text comes from the chrome's find bar over `find.search`
// and is never written into the page. Only Electron *types* are imported.

type TabContents = TabView['webContents'];

export interface TabFindContext {
  /** The browser state changed (bump and wake `watch`). */
  changed(): void;
  /** The tab's live WebContents while it shows a page (not empty, not behind an error or crash panel), else `null`. */
  pageContents(tab: Tab): TabContents | null;
}

export interface TabFinds {
  /** `BrowserState.find` for `tab`: its open bar, else `null`. */
  state(tab: Tab | undefined): FindState | null;
  isOpen(tab: Tab | undefined): boolean;
  /**
   * Opens the tab's bar (or asks the chrome to focus it again: `focusSeq`); text kept from an earlier
   * bar is found again. `false` (nothing opened) for a tab that shows no page.
   */
  open(tab: Tab): boolean;
  /** A new find session for `text` (`''` stops the find); `false` if the tab's bar is not open. */
  query(tab: Tab, text: string, matchCase: boolean): boolean;
  /** The next or previous match; `false` without an open bar with text. */
  step(tab: Tab, forward: boolean): boolean;
  /** Closes the bar, clearing the page's find highlight (`stopFindInPage('clearSelection')`); `false` if it was not open. */
  close(tab: Tab): boolean;
  /** A new main-frame document committed in the tab: its bar closes. */
  navigated(tab: Tab): void;
  /** The tab's view is gone (closed, destroyed): its bar closes. */
  released(tab: Tab): void;
  /** Listens to the tab's new view for `found-in-page`; answers what removes the listener. */
  wire(tab: Tab, view: TabView): () => void;
}

interface Entry {
  open: boolean;
  text: string;
  matchCase: boolean;
  matches: number;
  active: number;
  focusSeq: number;
  /** The id `findInPage` answered for the latest request (`-1`: none); only its answers count. */
  request: number;
}

/** What `found-in-page` reports (Electron's `Result`). */
interface FoundInPage {
  readonly requestId?: unknown;
  readonly matches?: unknown;
  readonly activeMatchOrdinal?: unknown;
}

/** A count from an answer, or `previous` where it carries none (Chromium reports `-1` for "unchanged"). */
const count = (value: unknown, previous: number): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : previous);

export function createTabFinds(ctx: TabFindContext): TabFinds {
  const entries = new WeakMap<Tab, Entry>();
  /** One counter for every tab: a bar shown again after a tab switch never looks like a focus request. */
  let focusSeq = 0;

  const entryOf = (tab: Tab): Entry => {
    let entry = entries.get(tab);
    if (!entry) {
      entry = { open: false, text: '', matchCase: false, matches: 0, active: 0, focusSeq: 0, request: -1 };
      entries.set(tab, entry);
    }
    return entry;
  };

  const stop = (contents: TabContents | null): void => {
    try {
      contents?.stopFindInPage('clearSelection');
    } catch {
      // The page is going.
    }
  };

  /**
   * Runs the entry's text in the page (a new session, or a follow-up step); clears it for `''`. The
   * count on screen stays until the answer replaces it (no flash of "No results").
   */
  const run = (tab: Tab, entry: Entry, options: { readonly findNext: boolean; readonly forward: boolean }): void => {
    const contents = ctx.pageContents(tab);
    const clear = (): void => {
      entry.request = -1;
      entry.matches = 0;
      entry.active = 0;
    };
    if (entry.text === '' || !contents) {
      clear();
      stop(contents);
      return;
    }
    try {
      entry.request = contents.findInPage(entry.text, { ...options, matchCase: entry.matchCase });
    } catch {
      clear();
    }
  };

  const shut = (tab: Tab): boolean => {
    const entry = entries.get(tab);
    if (!entry?.open) return false;
    entry.open = false;
    entry.matches = 0;
    entry.active = 0;
    entry.request = -1;
    return true;
  };

  return {
    state(tab) {
      const entry = tab ? entries.get(tab) : undefined;
      if (!tab || !entry?.open) return null;
      return { tabId: tab.id, text: entry.text, matchCase: entry.matchCase, matches: entry.matches, active: entry.active, focusSeq: entry.focusSeq };
    },

    isOpen: (tab) => tab !== undefined && entries.get(tab)?.open === true,

    open(tab) {
      if (!ctx.pageContents(tab)) return false;
      const entry = entryOf(tab);
      focusSeq += 1;
      entry.focusSeq = focusSeq;
      if (!entry.open) {
        entry.open = true;
        run(tab, entry, { findNext: true, forward: true });
      }
      ctx.changed();
      return true;
    },

    query(tab, text, matchCase) {
      const entry = entries.get(tab);
      if (!entry?.open) return false;
      entry.text = [...text].slice(0, FIND_TEXT_MAX_CHARS).join('');
      entry.matchCase = matchCase;
      run(tab, entry, { findNext: true, forward: true });
      ctx.changed();
      return true;
    },

    step(tab, forward) {
      const entry = entries.get(tab);
      if (!entry?.open || entry.text === '' || !ctx.pageContents(tab)) return false;
      run(tab, entry, { findNext: false, forward });
      return entry.request >= 0;
    },

    close(tab) {
      if (!shut(tab)) return false;
      stop(ctx.pageContents(tab));
      ctx.changed();
      return true;
    },

    navigated(tab) {
      if (shut(tab)) ctx.changed();
    },

    released(tab) {
      shut(tab);
    },

    wire(tab, view) {
      const emitter = view.webContents as unknown as NodeJS.EventEmitter;
      const listener = (_event: unknown, result: FoundInPage): void => {
        const entry = entries.get(tab);
        if (!entry?.open || tab.view !== view || result?.requestId !== entry.request) return;
        const matches = count(result.matches, entry.matches);
        const active = Math.min(count(result.activeMatchOrdinal, entry.active), matches);
        if (matches === entry.matches && active === entry.active) return;
        entry.matches = matches;
        entry.active = active;
        ctx.changed();
      };
      emitter.on('found-in-page', listener);
      return () => emitter.off('found-in-page', listener);
    },
  };
}
