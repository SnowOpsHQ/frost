import type { DevtoolsService } from '@app/ipc-contract';
import { DEVTOOLS_WATCH_EVICTED, MAX_PENDING_DEVTOOLS_WATCHES, REDIRECT_KEY_HEADERS, ROBOTS_VERDICT_BATCH, type NetworkHeader, type RedirectTraceAnswer } from '@app/specs/devtools.spec';
import type { ResponseMeta, RobotsFetch } from '@app/specs/seo-snapshot.spec';
import type { RequestObserver } from '../browser/web-request';
import { createConsoleLog, type ConsoleLog, type ConsoleMessage } from './console-log';
import { createNetworkLog, type NetworkLog } from './network-log';
import type { RobotsVerdictsResult } from './robots-verdicts';
import { createSiteStorage, type CookieLike, type SiteStorage } from './storage';

// The SEO devtools drawer's main side (spec `devtools.spec.ts`; acceptance `devtools.feature.md`):
// the network recorder (a `webRequest` subscriber), each tab's console and Storage reveals, the
// redirect trace from Phase 2's response recorder, and the per-tab version the `devtools.watch`
// long-poll waits on. Only Electron *types* reach it: the tab lookup, the cookie store, the dialog,
// the robots.txt fetcher and the analysis worker are injected, so it runs under Vitest with fakes.

/** The parts of a tab's WebContents the service listens to and reads. */
export interface DevtoolsContents {
  readonly id: number;
  getURL(): string;
  isDestroyed(): boolean;
  on(event: 'did-navigate', listener: (event: unknown, url: string, ...rest: unknown[]) => void): unknown;
  on(event: 'console-message', listener: (details: ConsoleMessage, ...rest: unknown[]) => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface DevtoolsServiceOptions {
  /** The open tab's live WebContents, `null` for an id that names no open tab (or a tab without a page view). */
  readonly contentsOf: (tabId: number) => DevtoolsContents | null;
  /** The app window's active tab (`DEVTOOLS_TAB_SCOPE`: the only one served), `null` for none. */
  readonly activeTabId: () => number | null;
  /** The open tab showing WebContents `contentsId`, `null` for none. */
  readonly tabIdOf: (contentsId: number) => number | null;
  /** Phase 2's response recorder (`seo/responses.ts`): the committed main-frame response. */
  readonly responses: { responseFor(contentsId: number, url: string): ResponseMeta | null };
  /** The robots.txt fetcher (`seo/robots-fetch.ts`), once the browse session exists. */
  readonly robots: () => { get(pageUrl: string): Promise<RobotsFetch | null> } | null;
  /** The analysis worker's robots.txt verdict job (`Analyzer.robotsVerdicts`). */
  readonly robotsVerdicts: (job: { robots: RobotsFetch; urls: string[] }) => Promise<RobotsVerdictsResult>;
  /** The browse partition's cookies for `url`. */
  readonly cookies: (url: string) => Promise<readonly CookieLike[]>;
  /** Main's "Clear this site's data" dialog (`CLEAR_SITE_DATA`); `true` to clear. */
  readonly confirmClearSiteData: (origin: string) => Promise<boolean>;
  /** Clears the origin's data from the browse partition. */
  readonly clearOrigin: (origin: string) => Promise<void>;
  /** Whether app window `windowId` is still open. */
  readonly liveWindow: (windowId: number) => boolean;
  readonly log?: (message: string) => void;
}

export interface DevtoolsMain extends DevtoolsService {
  /** The network recorder, for `observeRequests` on the browse session. */
  readonly observer: RequestObserver;
  /** Listens to a tab's WebContents: navigations, console messages, its end. */
  watchContents(contents: DevtoolsContents): void;
  /** Forgets every log and reveal (Clear Browsing Data). */
  clear(): void;
  /** For tests. */
  readonly parts: { readonly network: NetworkLog; readonly console: ConsoleLog; readonly storage: SiteStorage };
}

interface Waiter {
  readonly tabId: number;
  readonly since: number;
  readonly resolve: (version: number) => void;
}

export function createDevtoolsService(options: DevtoolsServiceOptions): DevtoolsMain {
  // One sequence for every change, so a tab's version never goes back (even when its WebContents is replaced).
  let sequence = 0;
  const versions = new Map<number, number>();
  const waiters: Waiter[] = [];
  const openWindows = new Set<number>();

  const versionOfContents = (contentsId: number | undefined): number => (contentsId === undefined ? 0 : (versions.get(contentsId) ?? 0));
  const contents = (tabId: number): DevtoolsContents | null => {
    // Only the active tab is served (`DEVTOOLS_TAB_SCOPE`): any other id is no tab.
    if (tabId !== options.activeTabId()) return null;
    const found = options.contentsOf(tabId);
    return found && !found.isDestroyed() ? found : null;
  };
  const version = (tabId: number): number => versionOfContents(contents(tabId)?.id);

  const changed = (contentsId: number): void => {
    versions.set(contentsId, ++sequence);
    const tabId = options.tabIdOf(contentsId);
    if (tabId === null) return;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (waiter.tabId !== tabId || sequence <= waiter.since) continue;
      waiters.splice(i, 1);
      waiter.resolve(sequence);
    }
  };

  const network = createNetworkLog({ changed });
  const consoleLog = createConsoleLog({ changed });
  const storage = createSiteStorage({ cookies: options.cookies, confirmClear: options.confirmClearSiteData, clearOrigin: options.clearOrigin, changed, log: options.log });

  const updateCapture = (): void => {
    for (const id of [...openWindows]) if (!options.liveWindow(id)) openWindows.delete(id);
    network.setFullCapture(openWindows.size > 0);
  };

  // ---- robots.txt verdicts: one worker job at a time, for the page origin's crawlable requests ----
  let robotsRunning = false;
  const resolveRobots = (contentsId: number, pageUrl: string): void => {
    if (robotsRunning) return;
    const pending = network.robotsPending(contentsId).slice(0, ROBOTS_VERDICT_BATCH);
    if (pending.length === 0) return;
    robotsRunning = true;
    void (async () => {
      const verdicts = new Map<number, 'allowed' | 'blocked' | 'unknown'>();
      try {
        const fetcher = options.robots();
        const robots = fetcher ? await fetcher.get(pageUrl).catch(() => null) : null;
        // Still being fetched elsewhere: ask again with a later query.
        if (robots?.outcome === 'pending') return;
        const answer = robots ? await options.robotsVerdicts({ robots, urls: pending.map((p) => p.url) }) : null;
        pending.forEach((p, i) => {
          const verdict = answer?.ok ? answer.verdicts[i] : null;
          verdicts.set(p.key, verdict === true ? 'allowed' : verdict === false ? 'blocked' : 'unknown');
        });
      } catch {
        for (const p of pending) verdicts.set(p.key, 'unknown');
      } finally {
        robotsRunning = false;
        network.setRobots(contentsId, verdicts);
      }
    })();
  };

  const keyHeaders = (headers: readonly { name: string; value: string; truncated?: boolean }[]): NetworkHeader[] =>
    headers.filter((h) => (REDIRECT_KEY_HEADERS as readonly string[]).includes(h.name)).map((h) => ({ name: h.name, value: h.value, masked: false, truncated: h.truncated === true }));

  const service: DevtoolsMain = {
    observer: network,
    parts: { network, console: consoleLog, storage },

    watchContents(tab) {
      const id = tab.id;
      // A main-frame navigation committed another document (`did-navigate`: main frame, cross-document
      // only). A navigation that never commits (a 204, a download, one cancelled) resets nothing.
      tab.on('did-navigate', (_event, url) => {
        network.committed(id, typeof url === 'string' ? url : '');
        consoleLog.reset(id);
        storage.committed(id);
      });
      tab.on('console-message', (details) => consoleLog.add(id, details ?? {}));
      tab.once('destroyed', () => {
        network.forget(id);
        consoleLog.forget(id);
        storage.forget(id);
        versions.delete(id);
      });
    },

    version,

    watch(tabId, sinceVersion, signal) {
      // Not the active tab: nothing will ever change for the chrome there.
      if (tabId !== options.activeTabId()) return Promise.resolve(0);
      const current = version(tabId);
      if (current > sinceVersion) return Promise.resolve(current);
      return new Promise<number>((resolve) => {
        const waiter: Waiter = { tabId, since: Math.min(sinceVersion, current), resolve };
        waiters.push(waiter);
        while (waiters.length > MAX_PENDING_DEVTOOLS_WATCHES) {
          const oldest = waiters.shift()!;
          // Pushed out: a marker, never a version, so the chrome backs off before asking again.
          oldest.resolve(DEVTOOLS_WATCH_EVICTED);
        }
        const abort = (): void => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          resolve(version(tabId));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },

    network(tabId, since = 0) {
      const tab = contents(tabId);
      if (!tab) return { status: 'no-tab', tabId };
      const rows = network.rows(tab.id, since);
      if (!rows) return { status: 'ready', tabId, pageUrl: tab.getURL(), rev: 0, full: true, more: false, entries: [], removed: [], dropped: 0, notKept: 0, overBudget: { entries: 0, bytes: 0 }, preserve: false };
      resolveRobots(tab.id, rows.pageUrl || tab.getURL());
      return { status: 'ready', tabId, ...rows, pageUrl: rows.pageUrl || tab.getURL() };
    },

    requestHeaders(tabId, key) {
      const tab = contents(tabId);
      return tab ? network.headers(tab.id, key) : { status: 'gone' };
    },

    redirects(tabId): RedirectTraceAnswer {
      const tab = contents(tabId);
      if (!tab) return { status: 'no-tab' };
      const meta = options.responses.responseFor(tab.id, tab.getURL());
      if (!meta) return { status: 'none' };
      const hops = meta.redirects.map((hop) => {
        const headers = network.mainFrameHeaders(tab.id, hop.url, hop.location);
        return { url: hop.url, status: hop.status, location: hop.location, internal: hop.internal, headers: headers ?? [], headersRecorded: headers !== null };
      });
      const final = network.mainFrameHeaders(tab.id, meta.url, null);
      return { status: 'ready', url: meta.url, source: meta.source, hops, hopTotal: meta.redirectTotal, finalStatus: meta.status, finalHeaders: final ?? keyHeaders(meta.headers) };
    },

    console(tabId) {
      const tab = contents(tabId);
      if (!tab) return { status: 'no-tab' };
      return { status: 'ready', ...(consoleLog.snapshot(tab.id) ?? { entries: [], total: 0, dropped: 0 }) };
    },

    async storage(tabId) {
      const tab = contents(tabId);
      if (!tab) return { status: 'no-tab' };
      return storage.storage(tab.id, tab.getURL());
    },

    async revealCookie(tabId, cookie) {
      const tab = contents(tabId);
      return tab ? storage.reveal(tab.id, tab.getURL(), cookie) : false;
    },

    async clearSiteData(tabId) {
      const tab = contents(tabId);
      return tab ? storage.clearSiteData(tab.id, tab.getURL()) : 'refused';
    },

    setOpen(windowId, open) {
      if (windowId !== null) {
        if (open) openWindows.add(windowId);
        else openWindows.delete(windowId);
      }
      updateCapture();
    },

    setPreserveLog(tabId, preserve) {
      const tab = contents(tabId);
      if (!tab) return false;
      network.setPreserve(tab.id, preserve);
      return true;
    },

    clear() {
      network.clear();
      consoleLog.clear();
      storage.clear();
    },
  };
  return service;
}
