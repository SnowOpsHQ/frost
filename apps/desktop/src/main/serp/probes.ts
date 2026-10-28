import type { BoundedFetcher, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_HTML_TYPES } from '@app/specs/seo-javascript.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { MAX_PENDING_PROBE_WATCHES, PROBE_AGENTS, PROBE_KEEP_HEADERS, PROBE_LIMITS, probeUserAgent, type ProbeAgent, type ProbeOutcome, type ProbeStatus } from '@app/specs/visibility-probes.spec';
import type { ProbeJob, ProbeJobResult, ProbePageAnswer, ProbeRobotsAnswer, ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { mediaType } from '../seo/served';
import { diffsOf, pendingRow } from './probe-compare';

// The visibility probes of each tab (spec `visibility-probes.spec.ts`, How a run goes; answers
// `visibility-probes.schema.ts`; acceptance `visibility-probes.feature.md`, Runs; review focus
// `probes-are-bounded`). A run starts only on `run(tabId)` (the user's "Run visibility probes",
// `serp.runProbes`), for the active tab showing an `http(s)` page, and belongs to that tab's document
// and URL (fragment aside), as Phase 2.5's checks do (`seo/checks.ts`): a new document (`dropped`),
// an in-page move to another URL (`navigatedInPage`), a closed tab (`dropped`), Clear Browsing Data
// (`cancelAll`) or `dispose()` cancels it, aborting its requests, and its state goes. `stop` ends it
// and keeps what it found. One GET per agent (`PROBE_AGENTS`, never retried) through `fetcher` (the
// bounded fetcher's `checks` lane: private hosts only for a private page, caps per call), at most
// `PROBE_LIMITS.maxConcurrent` at once; robots.txt once from main's cached fetcher (`robots`); every
// answer parsed by `parse` (the SERP worker's probe jobs). Rows stream: each one read bumps
// `version` and wakes `watch`.

/** What the probes need to know about a tab, now. */
export interface ProbeTab {
  /** Its live page's WebContents id. */
  readonly contentsId: number;
  /** The page's URL now (`webContents.getURL()`). */
  readonly url: string;
  readonly active: boolean;
}

export interface ProbesOptions {
  /** The bounded fetcher's `checks` lane. */
  readonly fetcher: BoundedFetcher;
  /** The page origin's robots.txt (main's cached fetcher), `null` for none. */
  readonly robots: (pageUrl: string) => Promise<RobotsFetch | null>;
  /** Runs a probe job in the SERP worker (`ProbeParser.run`). Never rejects. */
  readonly parse: (job: ProbeJob) => Promise<ProbeJobResult>;
  /** The tab, or `null` when it names no open tab with a live page. */
  readonly tab: (tabId: number) => ProbeTab | null;
  readonly now?: () => number;
  /** The app's Chromium version, for the crawlers' user agents (default `process.versions.chrome`). */
  readonly chromeVersion?: string;
  readonly log?: (message: string) => void;
}

export interface Probes {
  /** "Run visibility probes" on `tabId`: `true` if a run is under way (started now, or already). */
  run(tabId: number): boolean;
  /** Stops the tab's run, keeping what it found: `true` if one was running. */
  stop(tabId: number): boolean;
  /** The tab's run for the page it shows now (`ProbesStateSchema`; `idle` without one). Never fetches. */
  state(tabId: number): ProbesState;
  /** The tab's state once `version` exceeds `sinceVersion` (at once if it does), or when `signal` aborts; at most `MAX_PENDING_PROBE_WATCHES` wait. */
  watch(tabId: number, sinceVersion: number, signal?: AbortSignal): Promise<ProbesState>;
  /** A page's document went (`did-navigate`, `destroyed`): its tab's run is cancelled. */
  dropped(contentsId: number): void;
  /** A page moved in place to `url`: cancelled when its URL (fragment aside) changed. */
  navigatedInPage(contentsId: number, url: string): void;
  /** Clear Browsing Data: every run is cancelled. */
  cancelAll(): void;
  /** The app is quitting: runs are cancelled, watchers answer, nothing runs again. */
  dispose(): void;
  /** How many `watch` calls wait. */
  pendingWatches(): number;
}

interface Entry {
  readonly tabId: number;
  readonly contentsId: number;
  /** The probed URL (the tab's, fragment aside). */
  readonly key: string;
  readonly controller: AbortController;
  status: ProbeStatus;
  rows: readonly ProbeRow[];
  robotsTxt: ProbesState['robotsTxt'];
  readonly startedAt: number;
  finishedAt: number | null;
}

const EMPTY = new Uint8Array(0);
const HTML_TYPES: readonly string[] = SERVED_HTML_TYPES;

/** `url` without its `#fragment`. */
const withoutFragment = (url: string): string => {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
};
const cut = (url: string): string => url.slice(0, SNAPSHOT_LIMITS.maxUrlChars);
const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

/** A fetch's outcome as a row's (`response` is decided by its status and type). */
function fetchOutcome(fetched: BoundedFetchResult): ProbeOutcome {
  switch (fetched.outcome) {
    case 'response':
      return 'ok';
    case 'private-address':
    case 'private-redirect':
    case 'too-many-redirects':
    case 'bad-redirect':
    case 'no-location':
    case 'timeout':
    case 'busy':
      return fetched.outcome;
    case 'aborted':
      return 'stopped';
    default:
      return 'unreachable';
  }
}

/** A row from what the fetcher answered (the parse's facts come later). */
function fetchedRow(agent: ProbeAgent, fetched: BoundedFetchResult, robots: ProbeRow['robots']): ProbeRow {
  const contentType = fetched.headers['content-type'] ?? null;
  return {
    ...pendingRow(agent.id),
    outcome: fetchOutcome(fetched),
    status: fetched.status,
    hops: fetched.chain.slice(0, PROBE_LIMITS.maxRedirects).map((hop) => ({ url: cut(hop.url), status: hop.status })),
    finalUrl: fetched.finalUrl === null ? null : cut(fetched.finalUrl),
    robots,
    contentType: contentType === null ? null : contentType.slice(0, 256),
    bytes: Math.min(fetched.body.byteLength, PROBE_LIMITS.maxBytes),
    truncated: fetched.truncated,
    durationMs: Math.max(0, Math.round(fetched.durationMs)),
  };
}

export function createProbes(options: ProbesOptions): Probes {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const chromeVersion = options.chromeVersion ?? process.versions.chrome ?? '';
  const agents = PROBE_AGENTS.slice(0, PROBE_LIMITS.maxFetches);
  const entries = new Map<number, Entry>();
  const waiters: { wake: () => void }[] = [];
  let version = 0;
  let disposed = false;

  const bump = (): void => {
    version += 1;
    for (const waiter of waiters.splice(0)) waiter.wake();
  };

  const parse = (job: ProbeJob): Promise<ProbeJobResult> => {
    try {
      return options.parse(job).catch((): ProbeJobResult => ({ ok: false, reason: 'parse-failed' }));
    } catch {
      return Promise.resolve({ ok: false, reason: 'parse-failed' });
    }
  };
  const robotsOf = (pageUrl: string): Promise<RobotsFetch | null> => {
    try {
      return options.robots(pageUrl).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  /** Replaces `agent`'s row of `entry`. */
  const setRow = (entry: Entry, row: ProbeRow): void => {
    entry.rows = entry.rows.map((existing) => (existing.agent === row.agent ? row : existing));
    bump();
  };

  /** Drops `tabId`'s run (its requests aborted). */
  const cancel = (tabId: number): void => {
    const entry = entries.get(tabId);
    if (!entry) return;
    entry.controller.abort();
    entries.delete(tabId);
    bump();
  };

  // ---- A run ------------------------------------------------------------------------------------

  /** robots.txt for the run, once, decided for every agent in the worker. */
  async function readRobots(entry: Entry, live: () => boolean): Promise<void> {
    const fetched = await robotsOf(entry.key);
    if (!live()) return;
    const answer = await parse({ kind: 'robots', url: entry.key, robots: fetched });
    if (!live()) return;
    const verdicts = answer.ok && answer.answer.kind === 'robots' ? (answer.answer as ProbeRobotsAnswer).verdicts : null;
    const unknown: ProbeRow['robots'] = { verdict: 'unknown', rule: null, groupAgents: [], groupLine: null, fallback: false };
    entry.robotsTxt = fetched ? { url: fetched.url, outcome: fetched.outcome } : null;
    entry.rows = entry.rows.map((row) => ({ ...row, robots: verdicts ? verdicts[row.agent] : unknown }));
    bump();
  }

  /** One agent's GET and the reading of its answer. */
  async function probe(entry: Entry, agent: ProbeAgent, live: () => boolean): Promise<void> {
    let fetched: BoundedFetchResult;
    try {
      fetched = await options.fetcher.fetch({
        url: entry.key,
        page: entry.key,
        method: 'GET',
        userAgent: probeUserAgent(agent, chromeVersion),
        accept: SERVED_ACCEPT,
        maxBytes: PROBE_LIMITS.maxBytes,
        timeoutMs: PROBE_LIMITS.timeoutMs,
        maxRedirects: PROBE_LIMITS.maxRedirects,
        readBody: is2xx,
        keepHeaders: [...PROBE_KEEP_HEADERS],
        maxHeaderChars: PROBE_LIMITS.maxHeaderChars,
        signal: entry.controller.signal,
      });
    } catch (error) {
      log(`probes: a fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      fetched = { url: entry.key, outcome: 'unreachable', status: null, finalUrl: null, redirects: 0, chain: [], headers: {}, body: EMPTY as Uint8Array<ArrayBuffer>, truncated: false, durationMs: 0 };
    }
    if (!live() || fetched.outcome === 'aborted') return;
    const robots = entry.rows.find((row) => row.agent === agent.id)?.robots ?? null;
    let row = fetchedRow(agent, fetched, robots);
    if (fetched.outcome === 'response') {
      const type = mediaType(fetched.headers['content-type']);
      const html = is2xx(fetched.status) && (type === null || HTML_TYPES.includes(type));
      const outcome: ProbeOutcome = !is2xx(fetched.status) ? 'http-status' : html ? 'ok' : 'not-html';
      const answer = await parse({
        kind: 'page',
        agent: agent.id,
        url: row.finalUrl ?? entry.key,
        contentType: row.contentType,
        xRobotsTag: fetched.headers['x-robots-tag'] ?? null,
        link: fetched.headers.link ?? null,
        html,
        body: html ? fetched.body : EMPTY,
      });
      if (!live()) return;
      const current = entry.rows.find((candidate) => candidate.agent === agent.id)?.robots ?? robots;
      if (answer.ok && answer.answer.kind === 'page') {
        const read = answer.answer as ProbePageAnswer;
        row = { ...row, outcome, robots: current, metaRobots: read.metaRobots, xRobotsTag: read.xRobotsTag, noindex: read.noindex, nofollow: read.nofollow, canonical: read.canonical, wordCount: read.wordCount, textHash: read.textHash, title: read.title };
      } else row = { ...row, outcome: html ? 'parse-failed' : outcome, robots: current };
    }
    setRow(entry, row);
  }

  /** Runs every agent, at most `maxConcurrent` at once, then robots.txt's answer; `done` when all are in. */
  async function go(entry: Entry): Promise<void> {
    const live = (): boolean => entries.get(entry.tabId) === entry && !entry.controller.signal.aborted;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < agents.length && live()) {
        const agent = agents[next++]!;
        await probe(entry, agent, live);
      }
    };
    await Promise.all([readRobots(entry, live), ...Array.from({ length: Math.min(PROBE_LIMITS.maxConcurrent, agents.length) }, lane)]);
    if (!live()) return;
    entry.status = 'done';
    entry.finishedAt = now();
    bump();
  }

  /** `tabId`'s entry if it is for the page the tab shows now. */
  const currentEntry = (tabId: number): { tab: ProbeTab | null; entry: Entry | undefined } => {
    const tab = options.tab(tabId);
    if (!tab || !parseWebUrl(tab.url)) return { tab, entry: undefined };
    const entry = entries.get(tabId);
    return { tab, entry: entry && entry.contentsId === tab.contentsId && entry.key === withoutFragment(tab.url) ? entry : undefined };
  };

  const state = (tabId: number): ProbesState => {
    const { tab, entry } = currentEntry(tabId);
    const url = tab && parseWebUrl(tab.url) ? cut(withoutFragment(tab.url)) : '';
    if (!entry) return { version, tabId, url, status: 'idle', rows: [], diffs: [], robotsTxt: null, startedAt: null, finishedAt: null };
    return { version, tabId, url: cut(entry.key), status: entry.status, rows: [...entry.rows], diffs: diffsOf(entry.rows), robotsTxt: entry.robotsTxt, startedAt: entry.startedAt, finishedAt: entry.finishedAt };
  };

  const entryOfContents = (contentsId: number): Entry | undefined => [...entries.values()].find((entry) => entry.contentsId === contentsId);

  return {
    run(tabId) {
      if (disposed) return false;
      const tab = options.tab(tabId);
      if (!tab || !tab.active || !parseWebUrl(tab.url)) return false;
      const key = withoutFragment(tab.url);
      const existing = entries.get(tabId);
      // One run per tab: asking again while it runs changes nothing.
      if (existing && existing.status === 'running' && existing.contentsId === tab.contentsId && existing.key === key) return true;
      existing?.controller.abort();
      const robotsUrl = `${parseWebUrl(key)!.origin}/robots.txt`;
      const entry: Entry = {
        tabId,
        contentsId: tab.contentsId,
        key,
        controller: new AbortController(),
        status: 'running',
        rows: agents.map((agent) => pendingRow(agent.id)),
        robotsTxt: { url: cut(robotsUrl), outcome: 'pending' },
        startedAt: now(),
        finishedAt: null,
      };
      entries.set(tabId, entry);
      bump();
      void go(entry).catch((error: unknown) => {
        log(`probes: a run failed: ${error instanceof Error ? error.message : String(error)}`);
        if (entries.get(tabId) === entry && entry.status === 'running') {
          entry.controller.abort();
          entry.status = 'stopped';
          entry.finishedAt = now();
          entry.rows = entry.rows.map((row) => (row.outcome === 'pending' ? { ...row, outcome: 'stopped' } : row));
          bump();
        }
      });
      return true;
    },

    stop(tabId) {
      const { entry } = currentEntry(tabId);
      if (!entry || entry.status !== 'running') return false;
      entry.controller.abort();
      entry.status = 'stopped';
      entry.finishedAt = now();
      entry.rows = entry.rows.map((row) => (row.outcome === 'pending' ? { ...row, outcome: 'stopped' } : row));
      bump();
      return true;
    },

    state,

    watch(tabId, sinceVersion, signal) {
      if (version > sinceVersion || disposed) return Promise.resolve(state(tabId));
      return new Promise<ProbesState>((resolve) => {
        const waiter = {
          wake: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(state(tabId));
          },
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(state(tabId));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        while (waiters.length > MAX_PENDING_PROBE_WATCHES) waiters.shift()!.wake();
      });
    },

    dropped(contentsId) {
      const entry = entryOfContents(contentsId);
      if (entry) cancel(entry.tabId);
    },

    navigatedInPage(contentsId, url) {
      const entry = entryOfContents(contentsId);
      if (entry && entry.key !== withoutFragment(url)) cancel(entry.tabId);
    },

    cancelAll() {
      for (const tabId of [...entries.keys()]) cancel(tabId);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const tabId of [...entries.keys()]) cancel(tabId);
      bump();
    },

    pendingWatches: () => waiters.length,
  };
}
