import type { HighlightMode, TextHighlightTarget } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { aliveContents, showsPage, type Tab, type TabView } from '../browser/tab-model';
import { withoutFragment } from './auditor';
import { TEXT_HIGHLIGHT_MODES } from './highlight';

// Per-tab highlight mode, a part of the browser controller (spec `seo-sidebar.spec.ts`,
// `HIGHLIGHT_MODES`; acceptance `seo-panels.feature.md`, Highlight). `Tab.highlight` is reported in
// the tab's state; the overlay itself is drawn in the page by `paint` (`runHighlight`). It goes
// back to `off` when the page changes (a new document, a load error, a crash, the view released:
// nothing to remove, the overlay went with the document), when an in-page navigation leaves the
// URL it was drawn on, when another tab becomes active (then the overlay is removed), and when the
// page itself removes the overlay's host (the overlay reports it: `ended` settles with `removed`).
// A text mode (`sentences`) boxes the texts the context hands in for the tab (main's own ready
// audit, `textTargets`); with none to box it is refused like an inactive tab.

export type TabContents = TabView['webContents'];

export interface TabHighlights {
  /**
   * Sets `tab`'s overlay to `mode`: only for the active tab of an attached window, showing a web
   * page, and for a text mode only with texts to box; `false` (a no-op) otherwise, or without a painter.
   */
  set(tab: Tab, mode: HighlightMode): boolean;
  /** `tab`'s document went (did-navigate, load error, crash, view released): back to `off`. */
  dropped(tab: Tab): void;
  /** `tab` navigated in place: `off` (and the overlay removed) when its URL, fragment aside, changed. */
  navigatedInPage(tab: Tab): void;
  /** `tab` is no longer the active tab: `off`, the overlay removed. */
  deactivated(tab: Tab): void;
}

/** Draws the overlay in a page and waits for it to end (`runHighlight`, `watchHighlight`). Their answers are page data: checked, never trusted. */
export interface HighlightPainter {
  /**
   * Draws (or removes, for `off`) the overlay; resolves `{ mode, boxes }` once drawn (`mode` `off`:
   * nothing is). `textTargets`: the texts a text mode boxes (`[]` for the others).
   */
  paint(contents: TabContents, mode: HighlightMode, textTargets: readonly TextHighlightTarget[]): Promise<unknown>;
  /** Resolves why the current overlay ended (`removed`: the page took it out). */
  ended(contents: TabContents): Promise<unknown>;
}

export interface TabHighlightsContext {
  /** The painter; `undefined`: highlight mode is unavailable. */
  readonly painter: HighlightPainter | undefined;
  /** Whether `tab` is the active tab of an attached window. */
  isActive(tab: Tab): boolean;
  /** The texts `mode` boxes in `tab`'s page, from main's own data (`sentences`: its ready audit's difficult sentences; `[]` for other modes). */
  textTargets(tab: Tab, mode: HighlightMode): readonly TextHighlightTarget[];
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
    if (contents && ctx.painter) ctx.painter.paint(contents, 'off', []).catch(ignore);
    ctx.changed();
  };

  return {
    set(tab, mode) {
      const painter = ctx.painter;
      const contents = contentsOf(tab);
      if (!painter || !contents || !ctx.isActive(tab) || !showsPage(tab)) return false;
      const url = contents.getURL();
      if (!isWebUrl(url)) return false;
      const textTargets = TEXT_HIGHLIGHT_MODES.includes(mode) ? ctx.textTargets(tab, mode) : [];
      if (TEXT_HIGHLIGHT_MODES.includes(mode) && textTargets.length === 0) return false;
      const key = withoutFragment(url);
      const changed = tab.highlight !== mode;
      const run = ++seq;
      latest.set(tab, run);
      tab.highlight = mode;
      tab.highlightKey = mode === 'off' ? '' : key;
      const isCurrent = (): boolean => latest.get(tab) === run && contentsOf(tab) === contents && tab.highlight === mode && withoutFragment(contents.getURL()) === key;
      const settle = (answer: unknown, ok: boolean): void => {
        // A newer request replaces whatever this one drew.
        if (latest.get(tab) !== run || mode === 'off') return;
        const current = isCurrent();
        // The page moved on (or was reset) while it ran: whatever it drew goes.
        if (!current && contentsOf(tab) === contents) {
          painter.paint(contents, 'off', []).catch(ignore);
          return;
        }
        if (!current) return;
        // It failed, or drew nothing (the page took the host away at once).
        const drawn = ok && typeof answer === 'object' && answer !== null && (answer as { mode?: unknown }).mode === mode;
        if (!drawn) {
          reset(tab, false);
          return;
        }
        // Drawn: if the page removes it later, the tab's mode goes back to off.
        painter.ended(contents).then((reason) => {
          if (reason === 'removed' && isCurrent()) reset(tab, false);
        }, ignore);
      };
      painter.paint(contents, mode, textTargets).then(
        (answer) => settle(answer, true),
        () => settle(undefined, false),
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
