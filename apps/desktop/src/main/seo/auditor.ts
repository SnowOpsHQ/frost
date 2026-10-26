import { runAudit, type SeoAudit, type SeoAuditResponse } from '@app/seo-core';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import type { SeoUnavailableReason } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from '../browser/address';
import { aliveContents, type Tab, type TabView } from '../browser/tab-model';
import { parseSnapshot } from './snapshot';

// The SEO auditor: a part of the browser controller (spec `seo-sidebar.spec.ts`; acceptance
// `seo-sidebar.feature.md`, Auditor). It keeps the latest audit of each tab, keyed by the URL it
// was taken for, and audits only the **active** tab: `did-finish-load` and main-frame
// `did-navigate-in-page` (SPA routes) schedule a run after `AUDIT_DEBOUNCE_MS` of quiet; a
// background tab's events only mark its audit stale, and it is audited when it is shown. A run that
// has not settled after `EXTRACT_TIMEOUT_MS` is `unavailable` (`timeout`). Results for a URL the
// tab no longer shows, and results of a superseded run, are dropped (`audit-matches-current-url`).
// Every change of what `response` answers bumps the tab's `auditVersion` and the browser state's
// version, so `browser.watch` wakes the chrome.

export type TabContents = TabView['webContents'];

export interface TabAuditsOptions {
  /** Runs the extractor in the tab (`runExtractor`); resolves its raw, unvalidated answer. */
  readonly extract: (contents: TabContents) => Promise<unknown>;
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
}

export interface TabAudits {
  /** A page event of `tab` (load finished, SPA route change): audit it soon if it is the active tab. */
  schedule(tab: Tab): void;
  /** `tab` became the active tab: audit it if it has no audit of its current URL, or that audit is stale. */
  activated(tab: Tab): void;
  /** Audits `tab` again at once (no debounce); `false` if it is not auditable. */
  rerun(tab: Tab): boolean;
  /** Forgets `tab` (closed or its page gone): its timer is cleared, late results ignored. */
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
  /** The URL (`webContents.getURL()`) `state` describes. */
  url: string;
  state: { readonly status: 'pending' } | { readonly status: 'ready'; readonly audit: SeoAudit } | { readonly status: 'unavailable'; readonly reason: SeoUnavailableReason };
  /** Something happened to the page since the last run started while it was in the background. */
  stale: boolean;
  version: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The latest run's number; an older run's result is dropped. */
  run: number;
  /** A run is in flight. */
  running: boolean;
}

type Auditable = { readonly ok: true; readonly contents: TabContents; readonly url: string } | { readonly ok: false; readonly reason: SeoUnavailableReason };

/** Whether `tab` shows a web page that can be audited, and its contents and URL if so. */
function auditable(tab: Tab): Auditable {
  if (tab.crashed) return { ok: false, reason: 'crashed' };
  if (tab.error) return { ok: false, reason: 'load-error' };
  const contents = tab.view ? aliveContents(tab.view) : undefined;
  if (!contents) return { ok: false, reason: 'no-page' };
  const url = contents.getURL();
  return isWebUrl(url) ? { ok: true, contents, url } : { ok: false, reason: 'no-page' };
}

const TIMED_OUT = Symbol('timeout');

export function createTabAudits(options: TabAuditsOptions | undefined, ctx: TabAuditsContext): TabAudits {
  const debounceMs = options?.debounceMs ?? AUDIT_DEBOUNCE_MS;
  const timeoutMs = options?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const entries = new Map<number, Entry>();

  const entryOf = (tab: Tab, url: string): Entry => {
    let entry = entries.get(tab.id);
    if (!entry) {
      entry = { url, state: { status: 'pending' }, stale: false, version: 0, timer: undefined, run: 0, running: false };
      entries.set(tab.id, entry);
    }
    return entry;
  };

  const bump = (entry: Entry): void => {
    entry.version += 1;
    ctx.changed();
  };

  /** Points `entry` at `url`; a new URL's audit is pending (and the chrome is told). */
  const retarget = (entry: Entry, url: string): void => {
    if (entry.url === url) return;
    entry.url = url;
    entry.state = { status: 'pending' };
    bump(entry);
  };

  const settle = (tab: Tab, entry: Entry, run: number, url: string, result: unknown): void => {
    // A closed tab, a superseded run, or a page that moved on: dropped.
    if (entries.get(tab.id) !== entry || entry.run !== run) return;
    entry.running = false;
    const now = auditable(tab);
    if (!now.ok || now.url !== url || entry.url !== url) return;
    if (result === TIMED_OUT) {
      entry.state = { status: 'unavailable', reason: 'timeout' };
    } else if (result instanceof Error) {
      entry.state = { status: 'unavailable', reason: 'extraction-failed' };
    } else {
      const parsed = parseSnapshot(result);
      entry.state = parsed.ok ? { status: 'ready', audit: runAudit(parsed.snapshot) } : { status: 'unavailable', reason: parsed.reason };
    }
    bump(entry);
  };

  /** Starts a run on `tab` now (it is auditable, active). */
  const start = (tab: Tab, contents: TabContents, url: string, entry: Entry): void => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.stale = false;
    entry.running = true;
    const run = ++entry.run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    let extraction: Promise<unknown>;
    try {
      extraction = options!.extract(contents);
    } catch (error) {
      extraction = Promise.reject(error);
    }
    void Promise.race([extraction.then((value) => value, (error: unknown) => (error instanceof Error ? error : new Error(String(error)))), timeout]).then((result) => {
      clearTimeout(timer);
      settle(tab, entry, run, url, result);
    });
  };

  const schedule = (tab: Tab): void => {
    if (!options) return;
    const target = auditable(tab);
    const existing = entries.get(tab.id);
    if (!target.ok) {
      if (existing) clearTimeout(existing.timer);
      return;
    }
    if (!ctx.isActive(tab)) {
      // Audited when shown (`activated`).
      if (existing) existing.stale = true;
      return;
    }
    const entry = entryOf(tab, target.url);
    retarget(entry, target.url);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entries.get(tab.id) !== entry || !ctx.isOpen(tab)) return;
      const now = auditable(tab);
      if (!now.ok) return;
      if (!ctx.isActive(tab)) {
        entry.stale = true;
        return;
      }
      retarget(entry, now.url);
      start(tab, now.contents, now.url, entry);
    }, debounceMs);
  };

  return {
    schedule,

    activated(tab) {
      if (!options) return;
      const target = auditable(tab);
      if (!target.ok) return;
      const entry = entries.get(tab.id);
      if (entry && entry.url === target.url && !entry.stale && (entry.timer !== undefined || entry.running || entry.state.status !== 'pending')) return;
      schedule(tab);
    },

    rerun(tab) {
      if (!options) return false;
      const target = auditable(tab);
      if (!target.ok) return false;
      const entry = entryOf(tab, target.url);
      entry.url = target.url;
      entry.state = { status: 'pending' };
      bump(entry);
      start(tab, target.contents, target.url, entry);
      return true;
    },

    forget(tab) {
      const entry = entries.get(tab.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entries.delete(tab.id);
    },

    response(tab) {
      if (!tab) return { status: 'unavailable', url: '', reason: 'no-tab' };
      const url = tab.state.url;
      const target = auditable(tab);
      if (!target.ok) return { status: 'unavailable', url, reason: target.reason };
      const entry = entries.get(tab.id);
      // Only ever the audit of exactly the URL the tab shows now.
      if (!entry || entry.url !== target.url) return { status: 'pending', url: displayUrl(target.url) };
      const shown = displayUrl(target.url);
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
