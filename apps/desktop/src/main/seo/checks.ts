import type { ChecksService } from '@app/ipc-contract';
import { blockedLink, checksContextOf, hreflangTargets, type PageLink, type SeoAuditResponse } from '@app/seo-core';
import {
  CHECKS_PUSH_INTERVAL_MS,
  HREFLANG_CHECK_LIMITS,
  IDLE_HREFLANG_RUN,
  IDLE_LINK_RUN,
  IDLE_SITEMAP_RUN,
  LINK_CHECK_LIMITS,
  MAX_PENDING_CHECK_WATCHES,
  SITEMAP_LIMITS,
  type CheckKind,
  type CheckRunStatus,
  type ChecksState,
  type HreflangAlternateResult,
  type HreflangRunState,
  type LinkCheckResult,
  type LinkRunState,
  type SitemapErrorKind,
  type SitemapFileReport,
  type SitemapRunState,
} from '@app/specs/seo-checks.spec';
import type { ChecksContext } from '@app/specs/seo-checks.schema';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { withoutFragment } from './auditor';
import type { ChecksAnalysisResult } from './checks-analyse';
import type { CheckFetch, CheckFetchResult } from './checks-fetch';
import { checkLink, planLinks, type LinkLimits } from './checks-links';
import { runBounded } from './checks-scheduler';
import { isPrivateHost } from './fetcher';

// The link, sitemap and hreflang checks of each tab (spec `seo-checks.spec.ts`; acceptance
// `seo-checks.feature.md`, Runs; review focus `link-checks-are-bounded`). A check runs only when the
// user asks (`checks.*`), for the active tab's ready audit, and belongs to that tab's document and URL
// (fragment aside): a new document (`dropped`), an in-page navigation to another URL or a closed tab
// cancels every run of the tab, aborting its requests. Stop ends one run and keeps what it found.
// Requests go through `fetch` (the bounded fetcher's `checks` lane, `fetcher.spec.ts`) and the
// scheduler (per-origin concurrency and rate limit, and the run's total); what a server sent is
// parsed by `analyse` (the checks' worker). Link results are
// cached per URL for the session (definite HTTP answers only). Progress is pushed at most every
// `CHECKS_PUSH_INTERVAL_MS` (a version bump that wakes `watch`); a finished run (done or stopped) asks
// the auditor to re-score the page (`rescore`), whose context then carries the checks (`contextFor`).

/** What the checks need to know about a tab, now. */
export interface ChecksTab {
  /** Its live page's WebContents id. */
  readonly contentsId: number;
  /** The page's URL now (`webContents.getURL()`). */
  readonly url: string;
  readonly active: boolean;
  /** Its render profile's `User-Agent`, `null` for frost's own. */
  readonly userAgent: string | null;
  readonly audit: SeoAuditResponse;
}

export interface ChecksOptions {
  readonly fetch: CheckFetch;
  /** Runs a checks job in the checks' analysis worker (`ChecksJobSchema`). Never rejects. */
  readonly analyse: (job: unknown) => Promise<ChecksAnalysisResult>;
  /** The page origin's robots.txt (main's cached fetcher), `null` for none. */
  readonly robots: (pageUrl: string) => Promise<RobotsFetch | null>;
  /** The tab, or `null` when it names no open tab with a live page. */
  readonly tab: (tabId: number) => ChecksTab | null;
  /** A run finished: re-score the tab's audit with the checks in its context. */
  readonly rescore: (tabId: number) => void;
  readonly now?: () => number;
  readonly linkLimits?: Partial<LinkLimits>;
  readonly sitemapLimits?: Partial<typeof SITEMAP_LIMITS>;
  readonly pushIntervalMs?: number;
}

export interface Checks extends ChecksService {
  /** A page's document went (did-navigate, destroyed): its tab's runs are cancelled. */
  dropped(contentsId: number): void;
  /** A page navigated in place to `url`: cancelled when its URL (fragment aside) changed. */
  navigatedInPage(contentsId: number, url: string): void;
  /** What the rules read for the page of `contentsId` at `url`: the finished runs (`undefined`: none). */
  contextFor(contentsId: number, url: string): ChecksContext | undefined;
  /** The broken link targets of that page's link check (the `broken` highlight). */
  brokenFor(contentsId: number): string[];
  /** Forgets the cached link results (Clear Browsing Data). */
  clearCache(): void;
  /** Cancels every running check (Clear Browsing Data): their requests are aborted. */
  cancelAll(): void;
  cacheSize(): number;
}

interface Entry {
  readonly tabId: number;
  readonly contentsId: number;
  readonly key: string;
  readonly pageLinks: readonly PageLink[];
  links: LinkRunState;
  sitemaps: SitemapRunState;
  hreflang: HreflangRunState;
  readonly controllers: Partial<Record<CheckKind, AbortController>>;
}

/** Cached results: definite HTTP answers only (a timeout or a refused connection may be gone next time). */
const cacheable = (result: LinkCheckResult): boolean => (result.kind === 'ok' || result.kind === 'redirect' || result.kind === 'broken') && (result.reason === null || result.reason === 'http-error' || result.reason === 'other-status');

const originOf = (url: string): string => new URL(url).origin;
const pagePrivate = (url: string): boolean => {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
};
const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

/** A failed fetch's sitemap error (`null`: a 2xx response). */
function sitemapFetchError(answer: CheckFetchResult): SitemapErrorKind | null {
  switch (answer.outcome) {
    case 'response':
      if (!is2xx(answer.status)) return 'http-error';
      return answer.truncated ? 'too-large' : null;
    case 'timeout':
      return 'timeout';
    case 'unreachable':
      return 'unreachable';
    default:
      return 'redirect';
  }
}

export function createChecks(options: ChecksOptions): Checks {
  const now = options.now ?? Date.now;
  const linkLimits: LinkLimits = { ...LINK_CHECK_LIMITS, ...options.linkLimits };
  const sitemapLimits = { ...SITEMAP_LIMITS, ...options.sitemapLimits };
  const pushIntervalMs = options.pushIntervalMs ?? CHECKS_PUSH_INTERVAL_MS;
  const entries = new Map<number, Entry>();
  const cache = new Map<string, LinkCheckResult>();
  /** Origins that answered HEAD with a fallback status this session. */
  const getOnly = new Set<string>();
  let version = 0;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  const waiters: { wake: () => void }[] = [];

  const wake = (): void => {
    clearTimeout(pushTimer);
    pushTimer = undefined;
    version += 1;
    for (const waiter of waiters.splice(0)) waiter.wake();
  };
  /** Something changed: wake the watchers now, or within `pushIntervalMs` (progress). */
  const push = (immediate: boolean): void => {
    if (immediate) wake();
    else pushTimer ??= setTimeout(wake, pushIntervalMs);
  };

  /** A cached result is per URL and user agent (a site may answer a crawler differently). */
  const cacheKey = (url: string, userAgent: string | null): string => [userAgent ?? '', url].join('\n');
  const remember = (url: string, userAgent: string | null, result: LinkCheckResult): void => {
    if (!cacheable(result)) return;
    const key = cacheKey(url, userAgent);
    cache.delete(key);
    cache.set(key, result);
    while (cache.size > linkLimits.cacheEntries) cache.delete(cache.keys().next().value!);
  };

  const abortAll = (entry: Entry): void => {
    for (const controller of Object.values(entry.controllers)) controller?.abort();
  };

  /** Drops `tabId`'s entry (its runs cancelled). */
  const cancel = (tabId: number): void => {
    const entry = entries.get(tabId);
    if (!entry) return;
    abortAll(entry);
    entries.delete(tabId);
    push(true);
  };

  /** The tab's entry for its current document and URL (a new one replaces one for another). */
  const entryFor = (tabId: number, tab: ChecksTab, links: readonly PageLink[]): Entry => {
    const key = withoutFragment(tab.url);
    const existing = entries.get(tabId);
    if (existing && existing.contentsId === tab.contentsId && existing.key === key) return existing;
    if (existing) abortAll(existing);
    const entry: Entry = { tabId, contentsId: tab.contentsId, key, pageLinks: links, links: IDLE_LINK_RUN, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN, controllers: {} };
    entries.set(tabId, entry);
    return entry;
  };

  /** Ends `kind`'s run of `entry` with `status`; a done or stopped one re-scores the page. */
  const finish = (entry: Entry, kind: CheckKind, status: CheckRunStatus): void => {
    delete entry.controllers[kind];
    if (kind === 'links') entry.links = { ...entry.links, status, finishedAt: now() };
    else if (kind === 'sitemaps') entry.sitemaps = { ...entry.sitemaps, status, finishedAt: now() };
    else entry.hreflang = { ...entry.hreflang, status, finishedAt: now() };
    push(true);
    if (status === 'done' || status === 'stopped') {
      try {
        options.rescore(entry.tabId);
      } catch {
        // The audit keeps its last score.
      }
    }
  };

  const analyse = (job: unknown): Promise<ChecksAnalysisResult> => {
    try {
      return options.analyse(job).catch(() => ({ ok: false, reason: 'analysis-failed' }) as const);
    } catch {
      return Promise.resolve({ ok: false, reason: 'analysis-failed' } as const);
    }
  };
  const robotsOf = (pageUrl: string): Promise<RobotsFetch | null> => {
    try {
      return options.robots(pageUrl).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  // ---- Link checks ----

  /** `fresh`: "Check again" on this page, every link asked afresh (the cache is not read, only written). */
  async function runLinks(entry: Entry, signal: AbortSignal, tab: ChecksTab, fresh: boolean): Promise<void> {
    const live = (): boolean => entries.get(entry.tabId) === entry && !signal.aborted;
    const plan = planLinks(entry.pageLinks, entry.key, linkLimits);
    const results = new Map<string, LinkCheckResult>(plan.skipped);
    const publish = (immediate = false): void => {
      entry.links = { ...entry.links, total: plan.order.length, settled: results.size, results: plan.order.filter((url) => results.has(url)).map((url) => results.get(url)!) };
      push(immediate);
    };
    publish(true);
    // Same-origin targets robots.txt disallows are reported, not fetched.
    const pageOrigin = originOf(entry.key);
    const same = plan.candidates.filter((url) => originOf(url) === pageOrigin);
    const blocked = new Set<string>();
    if (same.length > 0) {
      const robots = await robotsOf(entry.key);
      if (!live()) return;
      if (robots) {
        const answer = await analyse({ kind: 'robots', robots, urls: same });
        if (!live()) return;
        if (answer.ok && answer.kind === 'robots') same.forEach((url, index) => answer.robots.blocked[index] === true && blocked.add(url));
      }
    }
    const toFetch: string[] = [];
    for (const url of plan.candidates) {
      const cached = fresh ? undefined : cache.get(cacheKey(url, tab.userAgent));
      if (blocked.has(url)) results.set(url, blockedLink(url));
      else if (cached) results.set(url, { ...cached, cached: true });
      else toFetch.push(url);
    }
    publish();
    await runBounded(
      toFetch,
      originOf,
      async (url, runSignal) => {
        const result = await checkLink(url, { fetch: options.fetch, page: entry.key, userAgent: tab.userAgent, getOnly, signal: runSignal, limits: linkLimits, now });
        if (result === null || !live()) return;
        remember(url, tab.userAgent, result);
        results.set(url, result);
        publish();
      },
      { perOrigin: linkLimits.perOriginConcurrency, intervalMs: linkLimits.perOriginIntervalMs, maxConcurrency: linkLimits.maxConcurrency, signal, now },
    );
    if (live()) finish(entry, 'links', 'done');
  }

  // ---- Sitemaps ----

  async function runSitemaps(entry: Entry, signal: AbortSignal, tab: ChecksTab, canonical: string | null): Promise<void> {
    const live = (): boolean => entries.get(entry.tabId) === entry && !signal.aborted;
    // A page URL the worker's job cannot hold: the check cannot run (not every file "malformed").
    if (entry.key.length > SNAPSHOT_LIMITS.maxUrlChars) {
      finish(entry, 'sitemaps', 'failed');
      return;
    }
    const canonicalUrl = canonical !== null && canonical !== entry.key && canonical.length <= SNAPSHOT_LIMITS.maxUrlChars && isWebUrl(canonical) ? withoutFragment(canonical) : null;
    const robots = await robotsOf(entry.key);
    if (!live()) return;
    let sources: string[] = [];
    if (robots) {
      const answer = await analyse({ kind: 'robots', robots, urls: [] });
      if (!live()) return;
      if (answer.ok && answer.kind === 'robots') sources = [...answer.robots.sitemaps].slice(0, sitemapLimits.maxSources);
    }
    const source = sources.length > 0 ? 'robots' : 'fallback';
    if (sources.length === 0) sources = [`${originOf(entry.key)}/sitemap.xml`];
    const files: SitemapFileReport[] = [];
    const errors: { url: string; kind: SitemapErrorKind }[] = [];
    const lastmod = { invalid: 0, future: 0, samples: [] as string[] };
    let urlCount = 0;
    let listed: boolean | null = null;
    // Every sitemap found was read whole: else a page not found in them is not known to be missing.
    let complete = true;
    let downloaded = 0;
    const addError = (url: string, kind: SitemapErrorKind): void => {
      if (kind !== 'not-found') complete = false;
      if (errors.length < sitemapLimits.maxErrors) errors.push({ url: url.slice(0, SNAPSHOT_LIMITS.maxUrlChars), kind });
    };
    const publish = (): void => {
      const shownListed = listed === true ? true : complete ? listed : null;
      entry.sitemaps = { ...entry.sitemaps, source, files: [...files], urlCount, listed: shownListed, complete, lastmod: { ...lastmod, samples: [...lastmod.samples] }, errors: [...errors] };
      push(false);
    };
    publish();
    const queue = sources.map((url) => ({ url, depth: 0 }));
    const seen = new Set(sources);
    const allowPrivate = pagePrivate(entry.key);
    let last = Number.NEGATIVE_INFINITY;
    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;
      if (urlCount >= sitemapLimits.maxUrls) {
        addError(url, 'too-many-urls');
        break;
      }
      if (!allowPrivate && pagePrivate(url)) {
        files.push({ url, depth, type: null, status: null, gzip: false, entries: 0, error: 'redirect' });
        addError(url, 'redirect');
        publish();
        continue;
      }
      // The rate limit holds between files too.
      const wait = last + linkLimits.perOriginIntervalMs - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!live()) return;
      // The run's byte budget: each file gets what is left of it.
      const left = sitemapLimits.maxRunBytes - downloaded;
      if (left <= 0) {
        addError(url, 'over-budget');
        publish();
        continue;
      }
      last = now();
      const answer = await options.fetch(url, { method: 'GET', maxBytes: Math.min(sitemapLimits.maxBytes, left), timeoutMs: sitemapLimits.timeoutMs, maxRedirects: linkLimits.maxRedirects, page: entry.key, userAgent: tab.userAgent, signal });
      if (!live() || answer.outcome === 'aborted') return;
      downloaded += answer.body.byteLength;
      let error = sitemapFetchError(answer);
      if (error === 'too-large' && left < sitemapLimits.maxBytes) error = 'over-budget';
      const file: { -readonly [K in keyof SitemapFileReport]: SitemapFileReport[K] } = { url, depth, type: null, status: answer.status, gzip: false, entries: 0, error: null };
      if (error === null) {
        const parsed = await analyse({ kind: 'sitemap', bytes: answer.body, fileUrl: answer.finalUrl, pageUrl: entry.key, canonicalUrl, urlBudget: Math.max(0, sitemapLimits.maxUrls - urlCount), now: now() });
        if (!live()) return;
        if (!parsed.ok || parsed.kind !== 'sitemap') error = 'malformed';
        else {
          const read = parsed.sitemap;
          file.type = read.type;
          file.gzip = read.gzip;
          file.entries = read.entries;
          error = read.error;
          urlCount += read.counted;
          if (read.type === 'urlset') listed = (listed ?? false) || read.listed;
          lastmod.invalid += read.lastmodInvalid;
          lastmod.future += read.lastmodFuture;
          for (const sample of read.lastmodSamples) if (lastmod.samples.length < sitemapLimits.maxSamples) lastmod.samples.push(sample);
          for (const child of read.children) {
            if (seen.has(child)) continue;
            seen.add(child);
            if (depth + 1 > sitemapLimits.maxDepth) addError(child, 'too-deep');
            else if (files.length + 1 + queue.length >= sitemapLimits.maxFiles) addError(child, 'too-many-files');
            else queue.push({ url: child, depth: depth + 1 });
          }
        }
      }
      // A guessed /sitemap.xml (robots.txt declares none) that is not a sitemap: there is none, not a broken one.
      if (error !== null && source === 'fallback' && depth === 0) error = 'not-found';
      file.error = error;
      files.push(file);
      if (error !== null) addError(url, error);
      publish();
    }
    if (live()) finish(entry, 'sitemaps', 'done');
  }

  // ---- hreflang reciprocity ----

  async function runHreflang(entry: Entry, signal: AbortSignal, tab: ChecksTab, audit: Extract<SeoAuditResponse, { status: 'ready' }>['audit']): Promise<void> {
    const live = (): boolean => entries.get(entry.tabId) === entry && !signal.aborted;
    const plan = hreflangTargets(audit.indexability.hreflang, entry.key, audit.indexability.canonical.effective);
    const pageKeys = plan.pageKeys.filter((key) => key.length <= SNAPSHOT_LIMITS.maxUrlChars);
    const selfLangs = plan.selfLangs.slice(0, SNAPSHOT_LIMITS.maxHreflang);
    const results = new Map<string, HreflangAlternateResult>();
    const publish = (): void => {
      entry.hreflang = { ...entry.hreflang, over: plan.over, alternates: plan.targets.filter((target) => results.has(target.url)).map((target) => results.get(target.url)!) };
      push(false);
    };
    publish();
    const allowPrivate = pagePrivate(entry.key);
    await runBounded(
      plan.targets,
      (target) => originOf(target.url),
      async (target, runSignal) => {
        const base = { lang: target.lang, url: target.url, httpStatus: null, returnLangs: [] as string[] };
        if (!allowPrivate && pagePrivate(target.url)) {
          results.set(target.url, { ...base, status: 'skipped' });
          publish();
          return;
        }
        const answer = await options.fetch(target.url, { method: 'GET', maxBytes: HREFLANG_CHECK_LIMITS.maxBytes, timeoutMs: HREFLANG_CHECK_LIMITS.timeoutMs, maxRedirects: linkLimits.maxRedirects, page: entry.key, userAgent: tab.userAgent, signal: runSignal });
        if (!live() || answer.outcome === 'aborted') return;
        if (answer.outcome !== 'response' || !is2xx(answer.status)) {
          results.set(target.url, { ...base, status: answer.outcome === 'private-redirect' ? 'skipped' : 'unreachable', httpStatus: answer.status });
          publish();
          return;
        }
        const type = (answer.headers.contentType ?? '').toLowerCase();
        const html = type === '' || type.includes('html') || type.includes('xml');
        const parsed = await analyse({ kind: 'hreflang', bytes: html ? answer.body : new Uint8Array(0), url: answer.finalUrl, link: answer.headers.link?.slice(0, HREFLANG_CHECK_LIMITS.maxHeaderChars) ?? null, pageKeys, selfLangs });
        if (!live()) return;
        results.set(target.url, parsed.ok && parsed.kind === 'hreflang' ? { ...base, status: parsed.hreflang.status, httpStatus: answer.status, returnLangs: [...parsed.hreflang.returnLangs] } : { ...base, status: 'unreachable', httpStatus: answer.status });
        publish();
      },
      { perOrigin: linkLimits.perOriginConcurrency, intervalMs: linkLimits.perOriginIntervalMs, maxConcurrency: linkLimits.maxConcurrency, signal, now },
    );
    if (live()) finish(entry, 'hreflang', 'done');
  }

  // ---- Runs ----

  /** Starts `kind` for `tabId` (the active tab, with a ready audit of its current URL); `true` if it runs now. */
  const start = (tabId: number, kind: CheckKind): boolean => {
    const tab = options.tab(tabId);
    if (!tab || !tab.active || !isWebUrl(tab.url) || tab.audit.status !== 'ready') return false;
    const audit = tab.audit.audit;
    if (withoutFragment(audit.url) !== withoutFragment(tab.url)) return false;
    const entry = entryFor(tabId, tab, audit.page.linkList);
    const current = kind === 'links' ? entry.links : kind === 'sitemaps' ? entry.sitemaps : entry.hreflang;
    if (current.status === 'running') return true;
    // A check run before on this page: "Check again" asks afresh.
    const again = current.status !== 'idle';
    const controller = new AbortController();
    entry.controllers[kind] = controller;
    const begun = { status: 'running' as const, startedAt: now(), finishedAt: null };
    let run: Promise<void>;
    if (kind === 'links') {
      entry.links = { ...IDLE_LINK_RUN, ...begun };
      run = runLinks(entry, controller.signal, tab, again);
    } else if (kind === 'sitemaps') {
      entry.sitemaps = { ...IDLE_SITEMAP_RUN, ...begun };
      run = runSitemaps(entry, controller.signal, tab, audit.indexability.canonical.effective);
    } else {
      entry.hreflang = { ...IDLE_HREFLANG_RUN, ...begun };
      run = runHreflang(entry, controller.signal, tab, audit);
    }
    push(true);
    void run.catch(() => {
      if (entries.get(tabId) === entry && entry.controllers[kind] === controller && !controller.signal.aborted) finish(entry, kind, 'failed');
    });
    return true;
  };

  /** `tabId`'s entry if it is for the page it shows now. */
  const currentEntry = (tabId: number): { tab: ChecksTab | null; entry: Entry | undefined } => {
    const tab = options.tab(tabId);
    if (!tab || !isWebUrl(tab.url)) return { tab, entry: undefined };
    const entry = entries.get(tabId);
    return { tab, entry: entry && entry.contentsId === tab.contentsId && entry.key === withoutFragment(tab.url) ? entry : undefined };
  };

  const state = (tabId: number): ChecksState => {
    const { tab, entry } = currentEntry(tabId);
    const url = tab && isWebUrl(tab.url) ? withoutFragment(tab.url) : '';
    if (!entry) return { version, tabId, url, links: IDLE_LINK_RUN, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN };
    return { version, tabId, url, links: entry.links, sitemaps: entry.sitemaps, hreflang: entry.hreflang };
  };

  const entryOfContents = (contentsId: number): Entry | undefined => [...entries.values()].find((entry) => entry.contentsId === contentsId);

  return {
    state,

    watch(tabId, sinceVersion, signal) {
      if (version > sinceVersion) return Promise.resolve(state(tabId));
      return new Promise<ChecksState>((resolve) => {
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
        while (waiters.length > MAX_PENDING_CHECK_WATCHES) waiters.shift()!.wake();
      });
    },

    checkLinks: (tabId) => start(tabId, 'links'),
    checkSitemaps: (tabId) => start(tabId, 'sitemaps'),
    checkHreflang: (tabId) => start(tabId, 'hreflang'),

    stop(tabId, kind) {
      const { entry } = currentEntry(tabId);
      const controller = entry?.controllers[kind];
      if (!entry || !controller) return false;
      controller.abort();
      finish(entry, kind, 'stopped');
      return true;
    },

    dropped(contentsId) {
      const entry = entryOfContents(contentsId);
      if (entry) cancel(entry.tabId);
    },

    navigatedInPage(contentsId, url) {
      const entry = entryOfContents(contentsId);
      if (entry && entry.key !== withoutFragment(url)) cancel(entry.tabId);
    },

    contextFor(contentsId, url) {
      const entry = entryOfContents(contentsId);
      if (!entry || entry.key !== withoutFragment(url)) return undefined;
      const context = checksContextOf(entry, entry.pageLinks);
      return context.links === null && context.sitemaps === null && context.hreflang === null ? undefined : context;
    },

    brokenFor(contentsId) {
      const entry = entryOfContents(contentsId);
      return entry ? entry.links.results.filter((result) => result.kind === 'broken').map((result) => result.url) : [];
    },

    clearCache() {
      cache.clear();
      getOnly.clear();
    },

    cancelAll() {
      for (const tabId of [...entries.keys()]) cancel(tabId);
    },

    cacheSize: () => cache.size,
  };
}
