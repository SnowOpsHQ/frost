import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { ROBOTS_FETCH_LIMITS } from '@app/specs/seo-indexability.spec';
import { SPEED_MEASURE_TIMEOUT_MS } from '@app/specs/seo-speed.spec';
import { AUDIT_DEBOUNCE_MS, AUDIT_MAX_WAIT_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import type { SeoUnavailableReason } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from '../browser/address';
import { aliveContents, type Tab, type TabView } from '../browser/tab-model';
import type { AnalysisResult } from './analysis';

// The SEO auditor: a part of the browser controller (spec `seo-sidebar.spec.ts`; acceptance
// `seo-sidebar.feature.md`, Auditor). It keeps the latest audit of each tab, keyed by the URL it
// was taken for without its `#fragment`, and audits only the **active** tab. The extractor's answer
// is never parsed or audited here, on the main thread: it goes to `analyse` (the analysis worker,
// `analysis.ts`) together with what `context` knows by then (the tab's response metadata, its
// origin's robots.txt, `seo-indexability.feature.md`, and its speed measurement, `seo-speed.feature.md`).
// The audit never waits for a slow input: while one is still on its way the page is analysed with a
// stand-in for it (robots.txt `pending`, no measurement), and analysed again once every input has
// settled (within `CONTEXT_TIMEOUT_MS`), if that run is still the tab's latest and the tab still
// shows its URL. That first, provisional audit is shown only when no ready audit of the URL is (a
// reload or a re-score keeps the one on screen until the final one, so the score does not flicker).
// The analysis answers the audit or why there is none: `did-finish-load` and
// main-frame `did-navigate-in-page` (SPA routes; a fragment-only change is ignored) schedule a run
// after `AUDIT_DEBOUNCE_MS` of quiet, or at most `AUDIT_MAX_WAIT_MS` after the first event of a
// burst; a background tab's events only mark its audit stale, and it is audited when it is shown.
// Every requested run has its own deadline: not answered after `EXTRACT_TIMEOUT_MS`, it is
// `unavailable` (`timeout`). At most one extraction is in flight per tab, even past a timeout (the
// page is still busy with it): later requests coalesce into one trailing run once it settles; a new
// document (`did-navigate`) releases the wait. Results for a URL the tab no longer shows, snapshots
// of another URL, and results of a superseded run are dropped (`audit-matches-current-url`). Every
// change of what `response` answers bumps the tab's `auditVersion` and the browser state's
// version, so `browser.watch` wakes the chrome.

export type TabContents = TabView['webContents'];

export interface TabAuditsOptions {
  /** Runs the extractor in the tab (`runExtractor`); resolves its raw, unvalidated answer. */
  readonly extract: (contents: TabContents) => Promise<unknown>;
  /**
   * Validates and audits an extractor answer off the main thread (main: the analysis worker,
   * `createAnalyzer`; it enforces `ANALYSIS_TIMEOUT_MS`). Never rejects.
   */
  readonly analyse: (raw: unknown, context?: unknown) => Promise<AnalysisResult>;
  /**
   * What main collects about the page beside the extractor (main: the tab's recorded response, its
   * origin's robots.txt and the speed measurement, a `PageContext`; `context-source.ts`), started
   * with each extraction. Without it nothing is collected.
   */
  readonly context?: (contents: TabContents) => ContextSource;
  readonly contextTimeoutMs?: number;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly timeoutMs?: number;
}

/** What `context` collected for one run (`TabAuditsOptions.context`). */
export interface ContextSource {
  /** What is known once the extraction answered: the context, and whether it is final (every input settled). */
  now(): { readonly context: unknown; readonly final: boolean };
  /**
   * The final context, when `now()` is not final: it settles once every input has (robots.txt within
   * `ROBOTS_FETCH_LIMITS.timeoutMs`, the measurement within `SPEED_MEASURE_TIMEOUT_MS`; the auditor
   * gives up after `contextTimeoutMs`).
   */
  readonly later: Promise<unknown> | null;
}

/** What made a page event: a load finished, or the URL changed in place (SPA route, fragment). */
export type PageEventKind = 'load' | 'in-page';

export interface TabAudits {
  /** A page event of `tab`: audit it soon if it is the active tab (an `in-page` change of the fragment only: not). */
  schedule(tab: Tab, kind: PageEventKind): void;
  /** `tab` committed a new document (`did-navigate`): an extraction in its old one no longer holds later runs back. */
  navigated(tab: Tab): void;
  /** `tab` became the active tab: audit it if it has no audit of its current URL, or that audit is stale. */
  activated(tab: Tab): void;
  /**
   * Audits `tab` again now (no debounce; after an extraction still in flight); `false` if it is not
   * auditable. With `keepShown` a ready audit of the same URL stays the answer until the new one
   * settles (no `pending` in between: the accessibility check's answer being scored, Task 6).
   */
  rerun(tab: Tab, keepShown?: boolean): boolean;
  /** Forgets `tab` (closed or its page gone): its timers are cleared, late results ignored. */
  forget(tab: Tab): void;
  /** What `seo.getAudit` answers for `tab` (`undefined`: no such tab). */
  response(tab: Tab | undefined): SeoAuditResponse;
  /** The tab's `auditVersion` (`0` before its first change). */
  version(tabId: number): number;
}

export interface TabAuditsContext {
  /** Whether `tab` is the active tab of an attached window. */
  isActive(tab: Tab): boolean;
  /** Whether `tab` is still open. */
  isOpen(tab: Tab): boolean;
  /** The browser state changed (bump and wake `watch`). */
  changed(): void;
}

interface Entry {
  /** The URL (`webContents.getURL()` without its fragment) `state` describes. */
  key: string;
  state: { readonly status: 'pending' } | { readonly status: 'ready'; readonly audit: SeoAudit } | { readonly status: 'unavailable'; readonly reason: SeoUnavailableReason };
  /** Something happened to the page while it was in the background (or its run was put off). */
  stale: boolean;
  version: number;
  /** The debounce timer, and when the current burst of events began (for the max wait). */
  timer: ReturnType<typeof setTimeout> | undefined;
  burstStart: number | undefined;
  /** The latest requested run's number; an older run's result is dropped. */
  run: number;
  /** The latest request's deadline, and the last run that missed it (its late result is ignored). */
  deadline: ReturnType<typeof setTimeout> | undefined;
  timedOut: number;
  /** The extraction in flight in the page (a token), if any; and whether a request waits for it. */
  inflight: object | null;
  queued: boolean;
}

type Auditable = { readonly ok: true; readonly contents: TabContents; readonly url: string; readonly key: string } | { readonly ok: false; readonly reason: SeoUnavailableReason };

/**
 * The longest the auditor waits for a run's final context (`ContextSource.later`) after its first
 * analysis: the slowest input's own deadline (robots.txt, the speed measurement) and a margin. Past
 * it the first audit stays.
 */
export const CONTEXT_TIMEOUT_MS = Math.max(ROBOTS_FETCH_LIMITS.timeoutMs, SPEED_MEASURE_TIMEOUT_MS) + 1_000;

/** `url` without its `#fragment`. */
export function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/** Whether `tab` shows a web page that can be audited, and its contents, URL and key if so. */
function auditable(tab: Tab): Auditable {
  if (tab.crashed) return { ok: false, reason: 'crashed' };
  if (tab.error) return { ok: false, reason: 'load-error' };
  const contents = tab.view ? aliveContents(tab.view) : undefined;
  if (!contents) return { ok: false, reason: 'no-page' };
  const url = contents.getURL();
  return isWebUrl(url) ? { ok: true, contents, url, key: withoutFragment(url) } : { ok: false, reason: 'no-page' };
}

export function createTabAudits(options: TabAuditsOptions | undefined, ctx: TabAuditsContext): TabAudits {
  const debounceMs = options?.debounceMs ?? AUDIT_DEBOUNCE_MS;
  const maxWaitMs = options?.maxWaitMs ?? AUDIT_MAX_WAIT_MS;
  const timeoutMs = options?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const contextTimeoutMs = options?.contextTimeoutMs ?? CONTEXT_TIMEOUT_MS;
  const entries = new Map<number, Entry>();

  const entryOf = (tab: Tab): Entry => {
    let entry = entries.get(tab.id);
    if (!entry) {
      entry = { key: '', state: { status: 'pending' }, stale: false, version: 0, timer: undefined, burstStart: undefined, run: 0, deadline: undefined, timedOut: 0, inflight: null, queued: false };
      entries.set(tab.id, entry);
    }
    return entry;
  };

  const bump = (entry: Entry): void => {
    entry.version += 1;
    ctx.changed();
  };

  /** Points `entry` at `key`; a new URL's audit is pending (and the chrome is told). */
  const retarget = (entry: Entry, key: string): void => {
    if (entry.key === key) return;
    entry.key = key;
    entry.state = { status: 'pending' };
    bump(entry);
  };

  const live = (tab: Tab, entry: Entry): boolean => entries.get(tab.id) === entry && ctx.isOpen(tab);

  /** Whether the page still shows `key` (else a result for it is dropped: its own event schedules the new URL's audit). */
  const stillAt = (tab: Tab, entry: Entry, key: string): boolean => {
    const now = auditable(tab);
    return now.ok && now.key === key && entry.key === key;
  };

  /** The outcome of the run that was for `key` (it is the latest run and has not timed out). */
  const settle = (entry: Entry, state: Entry['state']): void => {
    entry.state = state;
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    bump(entry);
  };

  const failed: AnalysisResult = { ok: false, reason: 'analysis-failed' };

  /** Whether run `run` (for `key`) is still the tab's latest and the tab still shows `key`. */
  const current = (tab: Tab, entry: Entry, key: string, run: number): boolean => entries.get(tab.id) === entry && entry.run === run && stillAt(tab, entry, key);

  /** Analyses `result` with `context` in the worker; never rejects. */
  const analyseWith = (result: unknown, context: unknown): Promise<AnalysisResult> => {
    try {
      return options!.analyse(result, context).catch(() => failed);
    } catch {
      return Promise.resolve(failed);
    }
  };

  /** What `source` knows now (a source that throws knows nothing). */
  const known = (source: ContextSource | undefined): { context: unknown; final: boolean } => {
    if (!source) return { context: undefined, final: true };
    try {
      const now = source.now();
      return { context: now.context, final: now.final || source.later === null };
    } catch {
      return { context: undefined, final: true };
    }
  };

  /**
   * The extraction of run `run` (for `key`) answered: an error settles now; an answer is analysed in
   * the worker with what the run's context knows now, and again with the final context once every
   * input has settled, if the run is still current. The first answer is provisional when the context
   * was not final: it is shown at once unless a ready audit of `key` already is (that one stays until
   * the final answer, or until the final context is given up on).
   */
  const extracted = (tab: Tab, entry: Entry, key: string, run: number, result: unknown, source: ContextSource | undefined): void => {
    if (!stillAt(tab, entry, key)) return;
    if (result instanceof Error) {
      settle(entry, { status: 'unavailable', reason: 'extraction-failed' });
      return;
    }
    // Extracted: the extraction deadline is met; the analysis has its own (`ANALYSIS_TIMEOUT_MS`).
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    const first = known(source);
    const later = first.final ? null : (source?.later ?? null);
    // A ready audit of this URL is on screen (a reload, a re-score): a provisional answer does not replace it.
    const holding = later !== null && entry.state.status === 'ready';
    void analyseWith(result, first.context).then((answer) => {
      // A newer run, a closed tab or a page that moved on: dropped.
      if (!current(tab, entry, key, run)) return;
      if (!answer.ok) {
        settle(entry, { status: 'unavailable', reason: answer.reason });
        return;
      }
      // An audit of another URL (the document changed under the run): dropped.
      if (withoutFragment(answer.audit.url) !== key) return;
      if (!holding) settle(entry, { status: 'ready', audit: answer.audit });
      if (later) refine(tab, entry, key, run, result, later, holding ? answer.audit : null);
    });
  };

  /**
   * Analyses run `run` again once its final context settles (at most `contextTimeoutMs` from now), if
   * it is still current. `held` is the provisional audit not shown yet: it is shown if there is no
   * better answer (the final context never came, or its analysis failed).
   */
  const refine = (tab: Tab, entry: Entry, key: string, run: number, result: unknown, later: Promise<unknown>, held: SeoAudit | null): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = {};
    const settled = Promise.race([later.catch(() => gaveUp), new Promise<unknown>((resolve) => (timer = setTimeout(() => resolve(gaveUp), contextTimeoutMs)))]).finally(() => clearTimeout(timer));
    const fallBack = (): void => {
      if (held && current(tab, entry, key, run) && entry.state.status === 'ready') settle(entry, { status: 'ready', audit: held });
    };
    void settled.then((context) => {
      if (context === gaveUp) return fallBack();
      if (!current(tab, entry, key, run) || entry.state.status !== 'ready') return;
      void analyseWith(result, context).then((answer) => {
        // Only a better answer for the same URL replaces the first one.
        if (!answer.ok || !current(tab, entry, key, run) || withoutFragment(answer.audit.url) !== key) return fallBack();
        settle(entry, { status: 'ready', audit: answer.audit });
      });
    });
  };

  /** Starts the extraction for the latest request now (no other one is in flight). */
  const launch = (tab: Tab, entry: Entry): void => {
    const target = auditable(tab);
    if (!target.ok || !options) return;
    const token = {};
    const run = entry.run;
    const key = target.key;
    entry.inflight = token;
    entry.queued = false;
    entry.stale = false;
    let extraction: Promise<unknown>;
    try {
      extraction = options.extract(target.contents);
    } catch (error) {
      extraction = Promise.reject(error);
    }
    // Collected beside the extraction (a source that throws collects nothing).
    let context: ContextSource | undefined;
    if (options.context) {
      try {
        context = options.context(target.contents);
        // Its final context may never be awaited (the first one was final, or the run moved on).
        context.later?.catch(() => undefined);
      } catch {
        context = undefined;
      }
    }
    void extraction
      .then(
        (value) => value,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
      .then((result) => {
        if (entries.get(tab.id) !== entry) return;
        if (entry.inflight === token) entry.inflight = null;
        if (entry.run === run && entry.timedOut !== run) extracted(tab, entry, key, run, result, context);
        // One trailing run for whatever was requested meanwhile.
        if (entry.queued && entry.inflight === null) {
          entry.queued = false;
          if (live(tab, entry) && ctx.isActive(tab)) request(tab, entry);
          else entry.stale = true;
        }
      });
  };

  /** A new run: its own deadline; launched now, or after the extraction in flight settles. */
  function request(tab: Tab, entry: Entry): void {
    const run = ++entry.run;
    const key = entry.key;
    clearTimeout(entry.deadline);
    entry.deadline = setTimeout(() => {
      if (entries.get(tab.id) !== entry || entry.run !== run || entry.key !== key) return;
      entry.timedOut = run;
      entry.state = { status: 'unavailable', reason: 'timeout' };
      bump(entry);
    }, timeoutMs);
    if (entry.inflight !== null) entry.queued = true;
    else launch(tab, entry);
  }

  const schedule = (tab: Tab, kind: PageEventKind): void => {
    if (!options) return;
    const target = auditable(tab);
    const existing = entries.get(tab.id);
    if (!target.ok) {
      if (existing) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
        existing.burstStart = undefined;
      }
      return;
    }
    if (!ctx.isActive(tab)) {
      // Audited when shown (`activated`).
      if (existing) existing.stale = true;
      return;
    }
    // Only the fragment changed: the audit (or the one under way) still holds.
    if (kind === 'in-page' && existing && existing.key === target.key && !existing.stale) return;
    const entry = entryOf(tab);
    retarget(entry, target.key);
    clearTimeout(entry.timer);
    const now = Date.now();
    entry.burstStart ??= now;
    const delay = Math.max(0, Math.min(debounceMs, entry.burstStart + maxWaitMs - now));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.burstStart = undefined;
      if (!live(tab, entry)) return;
      const current = auditable(tab);
      if (!current.ok) return;
      if (!ctx.isActive(tab)) {
        entry.stale = true;
        return;
      }
      retarget(entry, current.key);
      request(tab, entry);
    }, delay);
  };

  return {
    schedule,

    navigated(tab) {
      const entry = entries.get(tab.id);
      if (!entry) return;
      // The old document's extraction (and anything waiting on it) is moot.
      entry.inflight = null;
      entry.queued = false;
      clearTimeout(entry.deadline);
      entry.deadline = undefined;
    },

    activated(tab) {
      if (!options) return;
      const target = auditable(tab);
      if (!target.ok) return;
      const entry = entries.get(tab.id);
      const current = entry !== undefined && entry.key === target.key && !entry.stale;
      if (current && (entry.timer !== undefined || entry.inflight !== null || entry.queued || entry.state.status !== 'pending')) return;
      schedule(tab, 'load');
    },

    rerun(tab, keepShown = false) {
      if (!options) return false;
      const target = auditable(tab);
      if (!target.ok) return false;
      const entry = entryOf(tab);
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.burstStart = undefined;
      if (!keepShown || entry.key !== target.key || entry.state.status !== 'ready') {
        entry.key = target.key;
        entry.state = { status: 'pending' };
        bump(entry);
      }
      request(tab, entry);
      return true;
    },

    forget(tab) {
      const entry = entries.get(tab.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      clearTimeout(entry.deadline);
      entries.delete(tab.id);
    },

    response(tab) {
      if (!tab) return { status: 'unavailable', url: '', reason: 'no-tab' };
      const target = auditable(tab);
      if (!target.ok) return { status: 'unavailable', url: tab.state.url, reason: target.reason };
      const entry = entries.get(tab.id);
      const shown = displayUrl(target.url);
      // Only ever the audit of exactly the URL the tab shows now (its fragment aside).
      if (!entry || entry.key !== target.key) return { status: 'pending', url: shown };
      switch (entry.state.status) {
        case 'ready':
          return { status: 'ready', url: shown, audit: entry.state.audit };
        case 'unavailable':
          return { status: 'unavailable', url: shown, reason: entry.state.reason };
        default:
          return { status: 'pending', url: shown };
      }
    },

    version: (tabId) => entries.get(tabId)?.version ?? 0,
  };
}
