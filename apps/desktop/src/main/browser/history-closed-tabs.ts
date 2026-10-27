import { CLOSED_TAB_HISTORY_MAX, CLOSED_TABS_MAX } from '@app/specs/browser-polish.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { aliveContents, type Tab, type TabView } from './tab-model';

// Reopen Closed Tab: a part of the browser controller (spec `browser-polish.spec.ts`; acceptance
// `browser-polish.feature.md`, Reopen closed tab). A session-local stack, in memory only, of the last
// `CLOSED_TABS_MAX` closed tabs that showed a page, and how one is captured and restored. Only
// Electron *types* are imported.

type TabContents = TabView['webContents'];

/** A back / forward entry kept: URL (`http(s)`, without userinfo) and title only, never page state. */
export interface ClosedEntry {
  readonly url: string;
  readonly title: string;
}

export interface ClosedTab {
  /** Where it was in the strip. */
  readonly index: number;
  readonly url: string;
  readonly title: string;
  /** Its back / forward entries (at most `CLOSED_TAB_HISTORY_MAX`), and which one it showed. */
  readonly entries: readonly ClosedEntry[];
  readonly activeIndex: number;
  /** The closed tab itself: its own render profile is taken from it (`TabRenderProfiles.inherit`). */
  readonly profileOf: Tab;
}

export interface ClosedTabStack {
  push(closed: ClosedTab): void;
  /** The most recently closed tab, left on the stack. */
  peek(): ClosedTab | undefined;
  pop(): ClosedTab | undefined;
  size(): number;
  /** Empties the stack; answers whether it held anything. */
  clear(): boolean;
}

export function createClosedTabStack(max: number = CLOSED_TABS_MAX): ClosedTabStack {
  const stack: ClosedTab[] = [];
  return {
    push(closed) {
      stack.push(closed);
      if (stack.length > max) stack.splice(0, stack.length - max);
    },
    peek: () => stack[stack.length - 1],
    pop: () => stack.pop(),
    size: () => stack.length,
    clear() {
      const had = stack.length > 0;
      stack.length = 0;
      return had;
    },
  };
}

/** `url` as an entry may keep it: an `http(s)` URL without userinfo, else `null`. */
function keptUrl(url: unknown): string | null {
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * `contents`' back / forward entries kept (web URLs only, at most `CLOSED_TAB_HISTORY_MAX` around the
 * active one) and the active one's index among them; `null` when its history can't be read.
 */
export function keptHistory(contents: TabContents): { readonly entries: ClosedEntry[]; readonly activeIndex: number } | null {
  let all: readonly { url?: unknown; title?: unknown }[];
  let active: number;
  try {
    all = contents.navigationHistory.getAllEntries();
    active = contents.navigationHistory.getActiveIndex();
  } catch {
    return null;
  }
  if (!Array.isArray(all) || !Number.isInteger(active) || active < 0 || active >= all.length) return null;
  const entries: ClosedEntry[] = [];
  let activeIndex = -1;
  all.forEach((entry, i) => {
    const url = keptUrl(entry?.url);
    if (url === null) return;
    if (i === active) activeIndex = entries.length;
    entries.push({ url, title: typeof entry.title === 'string' ? entry.title : '' });
  });
  if (activeIndex < 0) return null;
  // A window of entries around the active one.
  const start = Math.max(0, Math.min(activeIndex - Math.floor(CLOSED_TAB_HISTORY_MAX / 2), entries.length - CLOSED_TAB_HISTORY_MAX));
  return { entries: entries.slice(start, start + CLOSED_TAB_HISTORY_MAX), activeIndex: activeIndex - start };
}

/** What a tab being closed at strip position `index` leaves on the stack, or `null` (it showed no page). */
export function captureClosedTab(tab: Tab, index: number): ClosedTab | null {
  const url = keptUrl(tab.state.url) ?? keptUrl(tab.restored?.url);
  if (url === null) return null;
  const title = tab.state.url !== '' ? tab.state.title : (tab.restored?.title ?? '');
  const contents = tab.view ? aliveContents(tab.view) : undefined;
  const history = contents ? keptHistory(contents) : null;
  // The page on screen is the entry reopened (an error page's tab keeps the URL it shows).
  if (history && history.entries[history.activeIndex]?.url === url) return { index, url, title, ...history, profileOf: tab };
  return { index, url, title, entries: [{ url, title }], activeIndex: 0, profileOf: tab };
}

/**
 * Loads `closed` into a fresh tab's `contents` with its back / forward entries
 * (`navigationHistory.restore`); `false` when there is only one entry or the API is missing (the
 * caller then loads its URL).
 */
export function restoreClosedHistory(contents: TabContents, closed: ClosedTab): boolean {
  const history = contents.navigationHistory as Partial<Pick<TabContents['navigationHistory'], 'restore'>>;
  if (closed.entries.length < 2 || typeof history.restore !== 'function') return false;
  try {
    history.restore.call(contents.navigationHistory, { entries: closed.entries.map((e) => ({ url: e.url, title: e.title })), index: closed.activeIndex }).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
    return true;
  } catch {
    return false;
  }
}
