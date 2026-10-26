import type { HighlightMode } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { aliveContents, showsPage, type Tab, type TabView } from '../browser/tab-model';
import { withoutFragment } from './auditor';

// Per-tab highlight mode, a part of the browser controller (spec `seo-sidebar.spec.ts`,
// `HIGHLIGHT_MODES`; acceptance `seo-panels.feature.md`, Highlight). `Tab.highlight` is reported in
// the tab's state; the overlay itself is drawn in the page by `paint` (`runHighlight`). It goes
// back to `off` when the page changes (a new document, a load error, a crash, the view released:
// nothing to remove, the overlay went with the document), when an in-page navigation leaves the
// URL it was drawn on, and when another tab becomes active (then the overlay is removed).

export type TabContents = TabView['webContents'];

export interface TabHighlights {
  /**
   * Sets `tab`'s overlay to `mode`: only for the active tab of an attached window, showing a web
   * page; `false` (a no-op) otherwise, or without a painter.
   */
  set(tab: Tab, mode: HighlightMode): boolean;
  /** `tab`'s document went (did-navigate, load error, crash, view released): back to `off`. */
  dropped(tab: Tab): void;
  /** `tab` navigated in place: `off` (and the overlay removed) when its URL, fragment aside, changed. */
  navigatedInPage(tab: Tab): void;
  /** `tab` is no longer the active tab: `off`, the overlay removed. */
  deactivated(tab: Tab): void;
}

export interface TabHighlightsContext {
  /** Draws (or removes, for `off`) the overlay in the page (`runHighlight`); `undefined`: highlight mode is unavailable. */
  readonly paint: ((contents: TabContents, mode: HighlightMode) => Promise<unknown>) | undefined;
  /** Whether `tab` is the active tab of an attached window. */
  isActive(tab: Tab): boolean;
  /** The browser state changed (bump and wake `watch`). */
  changed(): void;
}

function ignore(): void {}

export function createTabHighlights(ctx: TabHighlightsContext): TabHighlights {
  /** Each tab's latest `set` (a newer one supersedes what an older one does when it settles). */
  const latest = new WeakMap<Tab, number>();
  let seq = 0;
  const contentsOf = (tab: Tab): TabContents | undefined => (tab.view ? aliveContents(tab.view) : undefined);

  /** Back to `off`; the overlay removed from the page too when `remove` (its document is still there). */
  const reset = (tab: Tab, remove: boolean): void => {
    if (tab.highlight === 'off') return;
    tab.highlight = 'off';
    tab.highlightKey = '';
    const contents = remove ? contentsOf(tab) : undefined;
    if (contents && ctx.paint) ctx.paint(contents, 'off').catch(ignore);
    ctx.changed();
  };

  return {
    set(tab, mode) {
      const paint = ctx.paint;
      const contents = contentsOf(tab);
      if (!paint || !contents || !ctx.isActive(tab) || !showsPage(tab)) return false;
      const url = contents.getURL();
      if (!isWebUrl(url)) return false;
      const key = withoutFragment(url);
      const changed = tab.highlight !== mode;
      const run = ++seq;
      latest.set(tab, run);
      tab.highlight = mode;
      tab.highlightKey = mode === 'off' ? '' : key;
      const settle = (ok: boolean): void => {
        // A newer request replaces whatever this one drew.
        if (latest.get(tab) !== run || mode === 'off') return;
        const now = contentsOf(tab);
        const current = now === contents && tab.highlight === mode && withoutFragment(contents.getURL()) === key;
        // The page moved on (or was reset) while it ran: whatever it drew goes.
        if (!current && now === contents) paint(contents, 'off').catch(ignore);
        // It failed: nothing is drawn.
        else if (!ok && current) reset(tab, false);
      };
      paint(contents, mode).then(
        () => settle(true),
        () => settle(false),
      );
      if (changed) ctx.changed();
      return true;
    },
    dropped: (tab) => reset(tab, false),
    navigatedInPage(tab) {
      if (tab.highlight === 'off') return;
      const contents = contentsOf(tab);
      if (!contents || withoutFragment(contents.getURL()) !== tab.highlightKey) reset(tab, true);
    },
    deactivated: (tab) => reset(tab, true),
  };
}
