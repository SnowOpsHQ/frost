import type { SavedSession } from '@app/db';
import { MAX_TABS } from '@app/specs/browser.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from './address';
import type { StripState, Tab } from './tab-model';

// The controller's side of the browser-session database (spec `browser-session-db.feature.md`):
// what the tab strip hands the session sink, and how a saved strip becomes tabs again.

/** Where the controller hands what the session database keeps (`browser-session-db.feature.md`). */
export interface SessionSink {
  /** The tab strip changed (only while a window is attached). */
  saveSession(session: SavedSession): void;
  /** A main-frame `http(s)` page committed at `url`. */
  recordVisit(url: string): void;
  /** The page at `url` (no error page) reported `title`. */
  updateVisitTitle(url: string, title: string): void;
}

export interface SessionSync {
  /** Hands the strip to the sink if it changed since the last save, while a window shows it. */
  save(): void;
  /** A window was attached: what it starts with is not a change, and saving resumes. */
  resume(): void;
  /** The window is closing: its final strip was saved, and nothing after it until `resume`. */
  pause(): void;
}

/** The strip as saved: each tab's URL and title, in order, and the active tab's index. */
function sessionSnapshot(strip: StripState): SavedSession {
  return {
    tabs: strip.tabs.map((tab) => ({ url: tab.state.url, title: tab.state.title })),
    activeIndex: Math.max(0, strip.tabs.findIndex((tab) => tab.id === strip.activeTabId)),
  };
}

export function createSessionSync(sink: SessionSink | undefined, strip: StripState, hasWindow: () => boolean): SessionSync {
  let paused = false;
  /** The strip last handed to `sink` (serialized), to save only real changes. */
  let lastSaved = '';
  return {
    save() {
      if (!sink || paused || !hasWindow()) return;
      const snapshot = sessionSnapshot(strip);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSaved) return;
      lastSaved = serialized;
      sink.saveSession(snapshot);
    },
    resume() {
      paused = false;
      lastSaved = JSON.stringify(sessionSnapshot(strip));
    },
    pause() {
      paused = true;
    },
  };
}

/**
 * The tabs a saved strip restores (`Restore`): non-`http(s)` URLs are skipped (defence in depth: the
 * database already dropped them and stripped userinfo), at most `MAX_TABS`; the saved active tab,
 * else (skipped) the next kept tab to its right, else the last. `null` if none is kept.
 * `newTab` makes each tab (it assigns the id).
 */
export function restoredStrip(saved: SavedSession, newTab: () => Tab): { tabs: Tab[]; activeTabId: number } | null {
  const restored: Tab[] = [];
  let activeIndex = -1;
  saved.tabs.forEach((entry, index) => {
    const raw = typeof entry.url === 'string' ? entry.url : null;
    if (raw === null || (raw !== '' && !isWebUrl(raw)) || restored.length >= MAX_TABS) return;
    const url = raw === '' ? '' : displayUrl(raw);
    if (activeIndex < 0 && index >= saved.activeIndex) activeIndex = restored.length;
    const tab = newTab();
    const title = typeof entry.title === 'string' ? entry.title : '';
    if (url !== '') {
      tab.restored = { url, title };
      tab.state = { ...tab.state, url, title };
    }
    restored.push(tab);
  });
  if (restored.length === 0) return null;
  return { tabs: restored, activeTabId: (restored[activeIndex] ?? restored[restored.length - 1])!.id };
}
