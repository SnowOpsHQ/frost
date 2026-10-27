import { A11Y_TIMEOUT_MS, IDLE_A11Y_RUN, type A11yFailReason, type AccessibilityRunState } from '@app/specs/seo-compliance.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { aliveContents, showsPage, type Tab, type TabView } from '../browser/tab-model';
import { withoutFragment } from './auditor';
import { withinSize } from './a11y';

// Per-tab accessibility runs, a part of the browser controller (spec `seo-compliance.spec.ts`,
// `A11Y_RUN_STATUSES`, `A11Y_TIMEOUT_MS`; acceptance `seo-compliance.feature.md`, Run lifecycle).
// A run starts only on request (`seo.runAccessibility`), for the active tab showing a web page, and
// belongs to that tab's document and URL (fragment aside). At most one run is in flight per tab: a
// request while one runs is answered `true` and changes nothing. A run not answered within
// `timeoutMs` is `timed-out`; a new document (`did-navigate`), an in-page navigation to another
// URL, an error or crash panel, or a closed tab cancels it and the tab goes back to `idle`. A
// cancelled, timed-out or superseded run's late answer is dropped. An answer is kept (unparsed;
// main only checks its size, `withinSize`) and handed to the analysis worker beside the next
// snapshot (`PageContext.accessibility`), so `answered` asks the auditor to score it: the audit is
// re-run at once for the active tab (keeping the current audit on screen), or when the tab is next
// shown.

export type TabContents = TabView['webContents'];

/**
 * Runs the check in a page (`runAccessibilityCheck`); its answer is page data, checked here and
 * validated in the worker. `stillCurrent` says whether the run is still for the requested document
 * and URL: the runner checks it before injecting and before running.
 */
export type A11yRunner = (contents: TabContents, stillCurrent: () => boolean) => Promise<unknown>;

export interface TabA11yContext {
  /** The runner; `undefined`: the check is unavailable (`start` answers `false`). */
  readonly runner: A11yRunner | undefined;
  readonly timeoutMs?: number;
  /** Whether `tab` is the active tab of an attached window. */
  isActive(tab: Tab): boolean;
  /** Whether `tab` is still open. */
  isOpen(tab: Tab): boolean;
  /** A run's state changed (bump the tab's audit version and wake `watch`). */
  changed(): void;
  /** A run answered: score it (re-audit `tab` with the answer in its context). */
  answered(tab: Tab): void;
  /** The current time (epoch ms); `Date.now` by default. */
  now?(): number;
}

export interface TabA11y {
  /** Starts a run for `tab` (the active tab showing a web page); `true` if one is running now. */
  start(tab: Tab): boolean;
  /** `tab`'s run state for the URL it shows now (`idle` for any other URL). */
  state(tab: Tab): AccessibilityRunState;
  /** `tab`'s kept answer if it is for `url` (fragment aside) and the document it shows now; `null` otherwise. */
  resultFor(tab: Tab, url: string): unknown;
  /** `tab`'s document went (did-navigate, load error, crash, view released): cancelled, back to `idle`. */
  dropped(tab: Tab): void;
  /** `tab` navigated in place: cancelled and back to `idle` when its URL (fragment aside) changed. */
  navigatedInPage(tab: Tab): void;
  /** Forgets `tab` (closed). */
  forget(tab: Tab): void;
  /** How many times `tab`'s run state changed (added to its `auditVersion`). */
  version(tabId: number): number;
}

interface Entry {
  key: string;
  run: number;
  state: AccessibilityRunState;
  result: unknown;
  /** The WebContents the run was for (a tab's view can be replaced). */
  contents: TabContents | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  version: number;
}

export function createTabA11y(ctx: TabA11yContext): TabA11y {
  const timeoutMs = ctx.timeoutMs ?? A11Y_TIMEOUT_MS;
  const now = ctx.now ?? Date.now;
  const entries = new Map<number, Entry>();
  let seq = 0;
  const contentsOf = (tab: Tab): TabContents | undefined => (tab.view ? aliveContents(tab.view) : undefined);

  const bump = (entry: Entry): void => {
    entry.version += 1;
    ctx.changed();
  };

  /** Back to `idle`: whatever runs is cancelled (its answer will not match `run`), the answer forgotten. */
  const reset = (tabId: number): void => {
    const entry = entries.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.run = ++seq;
    entry.result = null;
    entry.key = '';
    if (entry.state.status === 'idle') return;
    entry.state = IDLE_A11Y_RUN;
    bump(entry);
  };

  const finish = (entry: Entry, status: 'done' | 'timed-out' | 'failed', reason: A11yFailReason | null = null): void => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.state = { status, startedAt: entry.state.startedAt, finishedAt: now(), reason };
    bump(entry);
  };

  /** The answer's kind: a summary to keep, `busy`, or unusable. */
  const classify = (answer: unknown): 'keep' | 'busy' | 'too-large' | 'bad' => {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return 'bad';
    if ((answer as { busy?: unknown }).busy === true) return 'busy';
    return withinSize(answer) ? 'keep' : 'too-large';
  };

  return {
    start(tab) {
      const contents = contentsOf(tab);
      if (!ctx.runner || !contents || !ctx.isActive(tab) || !showsPage(tab)) return false;
      const url = contents.getURL();
      if (!isWebUrl(url)) return false;
      const key = withoutFragment(url);
      let entry = entries.get(tab.id);
      if (entry && entry.key === key && entry.state.status === 'running') return true;
      if (!entry) {
        entry = { key, run: 0, state: IDLE_A11Y_RUN, result: null, contents, timer: undefined, version: 0 };
        entries.set(tab.id, entry);
      }
      const owned = entry;
      const run = ++seq;
      owned.run = run;
      owned.key = key;
      owned.contents = contents;
      owned.result = null;
      owned.state = { status: 'running', startedAt: now(), finishedAt: null, reason: null };
      clearTimeout(owned.timer);
      owned.timer = setTimeout(() => {
        if (entries.get(tab.id) === owned && owned.run === run) finish(owned, 'timed-out');
      }, timeoutMs);
      bump(owned);
      /** Still the run in force, for the same document and URL. */
      const current = (): boolean => entries.get(tab.id) === owned && owned.run === run && owned.state.status === 'running' && ctx.isOpen(tab) && contentsOf(tab) === contents && withoutFragment(contents.getURL()) === key;
      let answer: Promise<unknown>;
      try {
        answer = ctx.runner(contents, current);
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => {
          if (!current()) return;
          const kind = classify(value);
          if (kind === 'keep') {
            owned.result = value;
            finish(owned, 'done');
            ctx.answered(tab);
          } else {
            finish(owned, 'failed', kind === 'busy' ? 'busy' : kind === 'too-large' ? 'too-large' : 'script-error');
          }
        },
        () => {
          if (current()) finish(owned, 'failed', 'script-error');
        },
      );
      return true;
    },

    state(tab) {
      const entry = entries.get(tab.id);
      const contents = contentsOf(tab);
      if (!entry || !contents || entry.key !== withoutFragment(contents.getURL())) return IDLE_A11Y_RUN;
      return entry.state;
    },

    resultFor(tab, url) {
      const entry = entries.get(tab.id);
      if (!entry || entry.state.status !== 'done' || entry.contents !== contentsOf(tab) || entry.key !== withoutFragment(url)) return null;
      return entry.result;
    },

    dropped: (tab) => reset(tab.id),

    navigatedInPage(tab) {
      const entry = entries.get(tab.id);
      const contents = contentsOf(tab);
      if (entry && entry.key !== '' && (!contents || withoutFragment(contents.getURL()) !== entry.key)) reset(tab.id);
    },

    forget(tab) {
      const entry = entries.get(tab.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entries.delete(tab.id);
    },

    version: (tabId) => entries.get(tabId)?.version ?? 0,
  };
}
