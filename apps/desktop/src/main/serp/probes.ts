import { LLMS_TXT_ACCEPT, LLMS_TXT_CACHED_OUTCOMES, LLMS_TXT_TEXT_TYPES, type LlmsTxtOutcome } from '@app/specs/ai-readiness.spec';
import type { LlmsTxtAnswer, LlmsTxtJob, LlmsTxtJobResult, LlmsTxtState } from '@app/specs/ai-readiness.schema';
import type { BoundedFetcher, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT, SERVED_HTML_TYPES } from '@app/specs/seo-javascript.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { isPrivateHost } from '@app/specs/private-address.spec';
import { LLMS_TXT_LIMITS, MAX_PENDING_PROBE_WATCHES, PROBE_AGENTS, PROBE_KEEP_HEADERS, PROBE_LIMITS, PROBE_SEPARATE_HEADERS, probeUserAgent, type ProbeAgent, type ProbeOutcome, type ProbeStatus } from '@app/specs/visibility-probes.spec';
import type { ProbeJob, ProbeJobResult, ProbePageAnswer, ProbeRobotsAnswer, ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { isPrivatePage } from '../seo/fetcher';
import { mediaType } from '../seo/served';
import { diffsOf, pendingRow, robotsVerdictOf } from './probe-compare';

// The visibility probes of each tab (spec `visibility-probes.spec.ts`, How a run goes; answers
// `visibility-probes.schema.ts`; acceptance `visibility-probes.feature.md`, Runs; review focus
// `probes-are-bounded`). A run starts only on `run(tabId)` (the user's "Run visibility probes",
// `serp.runProbes`), for the active tab showing an `http(s)` page, and belongs to that tab's document
// and URL (fragment aside), as Phase 2.5's checks do (`seo/checks.ts`): a new document (`dropped`),
// an in-page move to another URL (`navigatedInPage`), a closed tab (`dropped`), Clear Browsing Data
// (`cancelAll`) or `dispose()` cancels it, aborting its requests, and its state goes. `stop` ends it
// and keeps what it found. One GET per agent (`PROBE_AGENTS`, never retried, at most
// `PROBE_LIMITS.maxRedirects` hops) through `fetcher` (the SERP lane, `SERP_FETCHER_LIMITS`: private
// hosts only for a private page, caps per call, `X-Robots-Tag` values kept apart), at most
// `PROBE_LIMITS.maxConcurrent` at once; robots.txt from main's cached fetcher (`robots`), once per
// origin an agent ended on (never a private host's for a public page), each agent judged on its own
// final URL; every answer parsed by `parse` (the probes' SERP worker), whose jobs the run's signal
// ends on Stop or cancel. Rows stream: each one read bumps `version` and wakes `watch`.
//
// `/llms.txt` (Phase 9 Task 7, `ai-readiness.spec.ts`): one more call per run, after the agents' in the
// same lanes (so still at most `maxConcurrent` at once), for `<tab origin>/llms.txt` only, with frost's
// own user agent and `LLMS_TXT_LIMITS`, through the same `fetcher` (its private-address rules, the tab's
// URL as the page) and the run's signal; a 2xx text body is read in the worker (an `llms-txt` job). Its
// answer is kept per origin (`LLMS_TXT_CACHED_OUTCOMES`, `cacheTtlMs`, at most `maxCacheEntries`), so a
// run whose origin's answer is kept asks nothing and shows it at once; `clearCache()` (Clear Browsing
// Data) forgets them. A run is `done` once its agents and its `/llms.txt` are in.

/** What the probes need to know about a tab, now. */
export interface ProbeTab {
  /** Its live page's WebContents id. */
  readonly contentsId: number;
  /** The page's URL now (`webContents.getURL()`). */
  readonly url: string;
  readonly active: boolean;
}

export interface ProbesOptions {
  /** The SERP lane (`SERP_FETCHER_LIMITS`): a bounded fetcher of the SERP's own over main's hop. */
  readonly fetcher: BoundedFetcher;
  /** A page origin's robots.txt (main's cached fetcher), `null` for none. */
  readonly robots: (pageUrl: string) => Promise<RobotsFetch | null>;
  /** Runs a probe or `llms-txt` job in the probes' SERP worker (`ProbeParser.run`), ended by the run's `signal`. Never rejects. */
  readonly parse: (job: ProbeJob | LlmsTxtJob, signal?: AbortSignal) => Promise<ProbeJobResult | LlmsTxtJobResult>;
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
  /** Clear Browsing Data: the kept `/llms.txt` answers are forgotten. */
  clearCache(): void;
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
  /** The robots.txt files read, one per origin judged. */
  robotsTxt: ProbesState['robotsTxt'];
  /** Each origin's robots.txt, asked once per run. */
  readonly robots: Map<string, Promise<RobotsFetch | null>>;
  /** The tab origin's `/llms.txt`: pending, read by this run, or the answer kept from an earlier one. */
  llmsTxt: LlmsTxtState;
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

const LLMS_TEXT_TYPES: readonly string[] = LLMS_TXT_TEXT_TYPES;
const LLMS_CACHED: ReadonlySet<LlmsTxtOutcome> = new Set(LLMS_TXT_CACHED_OUTCOMES);

/** `url`'s `/llms.txt` while it is asked. */
const pendingLlms = (url: string): LlmsTxtState => ({ url, outcome: 'pending', status: null, bytes: 0, truncated: false, title: null, sections: 0, links: 0, findings: [], partial: false, readAt: null });

/** A fetch's ending as an `/llms.txt` outcome (`response` is decided by its status and type). */
function llmsFetchOutcome(fetched: BoundedFetchResult): LlmsTxtOutcome {
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

/** A row from what the fetcher answered (the parse's facts and robots.txt's verdict come later). */
function fetchedRow(agent: ProbeAgent, fetched: BoundedFetchResult): ProbeRow {
  const contentType = fetched.headers['content-type'] ?? null;
  return {
    ...pendingRow(agent.id),
    outcome: fetchOutcome(fetched),
    status: fetched.status,
    hops: fetched.chain.slice(0, PROBE_LIMITS.maxRedirects).map((hop) => ({ url: cut(hop.url), status: hop.status })),
    finalUrl: fetched.finalUrl === null ? null : cut(fetched.finalUrl),
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
  /** The kept `/llms.txt` answers, by origin (oldest first). */
  const llmsCache = new Map<string, { readonly state: LlmsTxtState; readonly at: number }>();
  const waiters: { wake: () => void }[] = [];
  let version = 0;
  let disposed = false;

  const bump = (): void => {
    version += 1;
    for (const waiter of waiters.splice(0)) waiter.wake();
  };

  const parse = (job: ProbeJob | LlmsTxtJob, signal: AbortSignal): Promise<ProbeJobResult | LlmsTxtJobResult> => {
    try {
      return options.parse(job, signal).catch((): ProbeJobResult => ({ ok: false, reason: 'parse-failed' }));
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

  /**
   * `origin`'s robots.txt for the run: asked once (main's cached fetcher), listed in `robotsTxt` with
   * when the run got it. `null`: none (an origin on a private host while the page is not is never asked).
   */
  function robotsFor(entry: Entry, origin: string, live: () => boolean): Promise<RobotsFetch | null> {
    const known = entry.robots.get(origin);
    if (known) return known;
    const url = cut(`${origin}/robots.txt`);
    let asked: Promise<RobotsFetch | null>;
    if (!isPrivatePage(entry.key) && isPrivateHost(new URL(origin).hostname)) asked = Promise.resolve(null);
    else {
      entry.robotsTxt = [...entry.robotsTxt, { url, outcome: 'pending', readAt: null }];
      bump();
      asked = robotsOf(`${origin}/`).then((fetched) => {
        if (live()) {
          entry.robotsTxt = entry.robotsTxt.map((file) => (file.url === url ? { url, outcome: fetched?.outcome ?? 'unreachable', readAt: now() } : file));
          bump();
        }
        return fetched;
      });
    }
    entry.robots.set(origin, asked);
    return asked;
  }

  /** `agent`'s robots.txt verdict for the URL it ended on (its origin's file, judged in the worker). */
  async function judgeRobots(entry: Entry, agent: ProbeAgent, url: string, live: () => boolean): Promise<ProbeRow['robots']> {
    const target = parseWebUrl(url) ?? parseWebUrl(entry.key)!;
    const fetched = await robotsFor(entry, target.origin, live);
    if (!live()) return null;
    const answer = await parse({ kind: 'robots', agent: agent.id, url: target.href, robots: fetched }, entry.controller.signal);
    return answer.ok && answer.answer.kind === 'robots' ? (answer.answer as ProbeRobotsAnswer).robots : robotsVerdictOf('unknown');
  }

  /** One agent's GET and the reading of its answer (robots.txt for the URL it ended on, and its headers and body). */
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
        separateHeaders: [...PROBE_SEPARATE_HEADERS],
        maxHeaderChars: PROBE_LIMITS.maxHeaderChars,
        signal: entry.controller.signal,
      });
    } catch (error) {
      log(`probes: a fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      fetched = { url: entry.key, outcome: 'unreachable', status: null, finalUrl: null, redirects: 0, chain: [], headers: {}, body: EMPTY as Uint8Array<ArrayBuffer>, truncated: false, durationMs: 0 };
    }
    if (!live() || fetched.outcome === 'aborted') return;
    let row = fetchedRow(agent, fetched);
    const judged = judgeRobots(entry, agent, row.finalUrl ?? entry.key, live);
    if (fetched.outcome === 'response') {
      const type = mediaType(fetched.headers['content-type']);
      const html = is2xx(fetched.status) && (type === null || HTML_TYPES.includes(type));
      const outcome: ProbeOutcome = !is2xx(fetched.status) ? 'http-status' : html ? 'ok' : 'not-html';
      const answer = await parse(
        {
          kind: 'page',
          agent: agent.id,
          url: row.finalUrl ?? entry.key,
          contentType: row.contentType,
          xRobotsTag: fetched.headers['x-robots-tag'] ?? null,
          link: fetched.headers.link ?? null,
          html,
          body: html ? fetched.body : EMPTY,
        },
        entry.controller.signal,
      );
      if (!live()) return;
      if (answer.ok && answer.answer.kind === 'page') {
        const read = answer.answer as ProbePageAnswer;
        row = {
          ...row,
          outcome,
          metaRobots: read.metaRobots,
          xRobotsTag: read.xRobotsTag,
          noindex: read.noindex,
          nofollow: read.nofollow,
          canonical: read.canonical,
          canonicals: read.canonicals,
          wordCount: read.wordCount,
          textHash: read.textHash,
          textSignature: read.textSignature,
          textTruncated: read.textTruncated,
          partial: read.partial,
          title: read.title,
        };
      } else row = { ...row, outcome: html ? 'parse-failed' : outcome };
    }
    const robots = await judged;
    if (!live()) return;
    setRow(entry, { ...row, robots });
  }

  /** `origin`'s kept `/llms.txt` answer, if it is still fresh. */
  const cachedLlms = (origin: string): LlmsTxtState | null => {
    const kept = llmsCache.get(origin);
    if (!kept) return null;
    if (now() - kept.at <= LLMS_TXT_LIMITS.cacheTtlMs) return kept.state;
    llmsCache.delete(origin);
    return null;
  };
  const keepLlms = (origin: string, state: LlmsTxtState): void => {
    if (!LLMS_CACHED.has(state.outcome)) return;
    llmsCache.delete(origin);
    llmsCache.set(origin, { state, at: now() });
    while (llmsCache.size > LLMS_TXT_LIMITS.maxCacheEntries) llmsCache.delete(llmsCache.keys().next().value!);
  };

  /** The tab origin's `/llms.txt`: one GET as frost (never an agent's user agent), a 2xx text body read in the worker. */
  async function llmsTxt(entry: Entry, origin: string, live: () => boolean): Promise<void> {
    const url = entry.llmsTxt.url;
    let fetched: BoundedFetchResult;
    try {
      fetched = await options.fetcher.fetch({
        url,
        page: entry.key,
        method: 'GET',
        userAgent: null,
        accept: LLMS_TXT_ACCEPT,
        maxBytes: LLMS_TXT_LIMITS.maxBytes,
        timeoutMs: LLMS_TXT_LIMITS.timeoutMs,
        maxRedirects: LLMS_TXT_LIMITS.maxRedirects,
        readBody: is2xx,
        keepHeaders: ['content-type'],
        signal: entry.controller.signal,
      });
    } catch (error) {
      log(`probes: the llms.txt fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      fetched = { url, outcome: 'unreachable', status: null, finalUrl: null, redirects: 0, chain: [], headers: {}, body: EMPTY as Uint8Array<ArrayBuffer>, truncated: false, durationMs: 0 };
    }
    if (!live() || fetched.outcome === 'aborted') return;
    let state: LlmsTxtState = { ...entry.llmsTxt, outcome: llmsFetchOutcome(fetched), status: fetched.status, bytes: Math.min(fetched.body.byteLength, LLMS_TXT_LIMITS.maxBytes), truncated: fetched.truncated };
    if (fetched.outcome === 'response') {
      const type = mediaType(fetched.headers['content-type']);
      if (!is2xx(fetched.status)) state = { ...state, outcome: fetched.status === 404 || fetched.status === 410 ? 'missing' : 'http-status', bytes: 0 };
      else if (type !== null && !LLMS_TEXT_TYPES.includes(type)) state = { ...state, outcome: 'not-text' };
      else {
        const contentType = fetched.headers['content-type'] ?? null;
        const answer = await parse({ kind: 'llms-txt', url: cut(fetched.finalUrl ?? url), contentType: contentType === null ? null : contentType.slice(0, PROBE_LIMITS.maxHeaderChars), body: fetched.body }, entry.controller.signal);
        if (!live()) return;
        if (answer.ok && answer.answer.kind === 'llms-txt') {
          const read = answer.answer as LlmsTxtAnswer;
          state = { ...state, outcome: read.findings.length > 0 ? 'malformed' : 'ok', title: read.title, sections: read.sections, links: read.links, findings: read.findings, partial: read.partial };
        } else state = { ...state, outcome: 'parse-failed' };
      }
    }
    state = { ...state, readAt: now() };
    entry.llmsTxt = state;
    keepLlms(origin, state);
    bump();
  }

  /** Runs every agent, then the origin's `/llms.txt` unless its answer is kept, at most `maxConcurrent` at once; `done` when all are in. */
  async function go(entry: Entry, askLlms: boolean): Promise<void> {
    const live = (): boolean => entries.get(entry.tabId) === entry && !entry.controller.signal.aborted;
    const origin = parseWebUrl(entry.key)!.origin;
    // The tab's own robots.txt is asked at once (most agents end on its origin).
    void robotsFor(entry, origin, live);
    const jobs: (() => Promise<void>)[] = agents.map((agent) => () => probe(entry, agent, live));
    if (askLlms) jobs.push(() => llmsTxt(entry, origin, live));
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < jobs.length && live()) await jobs[next++]!();
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_LIMITS.maxConcurrent, jobs.length) }, lane));
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
    if (!entry) return { version, tabId, url, status: 'idle', rows: [], diffs: [], robotsTxt: [], llmsTxt: null, startedAt: null, finishedAt: null };
    return { version, tabId, url: cut(entry.key), status: entry.status, rows: [...entry.rows], diffs: diffsOf(entry.rows), robotsTxt: [...entry.robotsTxt], llmsTxt: entry.llmsTxt, startedAt: entry.startedAt, finishedAt: entry.finishedAt };
  };

  /** Marks a stopped run: what was not finished reads `stopped`. */
  const stopEntry = (entry: Entry): void => {
    entry.status = 'stopped';
    entry.finishedAt = now();
    entry.rows = entry.rows.map((row) => (row.outcome === 'pending' ? { ...row, outcome: 'stopped' } : row));
    if (entry.llmsTxt.outcome === 'pending') entry.llmsTxt = { ...entry.llmsTxt, outcome: 'stopped' };
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
      const origin = parseWebUrl(key)!.origin;
      const kept = cachedLlms(origin);
      const entry: Entry = {
        tabId,
        contentsId: tab.contentsId,
        key,
        controller: new AbortController(),
        status: 'running',
        rows: agents.map((agent) => pendingRow(agent.id)),
        robotsTxt: [],
        robots: new Map(),
        llmsTxt: kept ?? pendingLlms(cut(`${origin}/llms.txt`)),
        startedAt: now(),
        finishedAt: null,
      };
      entries.set(tabId, entry);
      bump();
      void go(entry, kept === null).catch((error: unknown) => {
        log(`probes: a run failed: ${error instanceof Error ? error.message : String(error)}`);
        if (entries.get(tabId) === entry && entry.status === 'running') {
          entry.controller.abort();
          stopEntry(entry);
          bump();
        }
      });
      return true;
    },

    stop(tabId) {
      const { entry } = currentEntry(tabId);
      if (!entry || entry.status !== 'running') return false;
      entry.controller.abort();
      stopEntry(entry);
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

    clearCache() {
      llmsCache.clear();
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
