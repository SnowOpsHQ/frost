// Fakes for the crawl run tests (Task 6b; acceptance specs/site-crawl.feature.md, Runs, frontier, resume and the
// served-HTML audit): a fake site answered by a fake page fetcher (no network, no timers), the session store in a
// temporary directory, and the crawl worker's page job run in this process.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemorySessionStore, openSessionStore, type SessionStore } from '@app/db';
import { defaultCrawlSettings, type CrawlSettings } from '@app/specs/site-crawl.schema';
import type { CrawlPageJob } from '@app/specs/site-crawl.schema';
import { analyseCrawlPage, type CrawlPageResult } from '../analyse';
import type { CrawlFetchOptions, CrawlPageFetch, CrawlRobotsState } from '../fetch';
import { pacingKey, type CrawlClock, type Pacing } from '../politeness';
import { createCrawlScope } from '../scope';

const encoder = new TextEncoder();

/** One fake page: HTML (with its status and media type), a redirect to another host, or a fetch outcome with no answer. */
export type FakePage =
  | { readonly html: string; readonly status?: number; readonly contentType?: string | null; readonly headers?: Record<string, string> }
  | { readonly redirectTo: string; readonly status?: number }
  | { readonly outcome: 'deferred' | 'blocked-by-robots' | 'unreachable' | 'timeout' }
  | { readonly slowDown: true; readonly status: 429 };

export const ALLOWED: CrawlRobotsState = { fetch: null, crawl: 'allowed', googlebot: 'allowed', unreachable: false, crawlDelayMs: null };

/** An HTML page with `links` (hrefs as written) and a title. */
export function htmlPage(title: string, links: readonly string[] = [], extra = ''): FakePage {
  return { html: `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="A page of the fake site called ${title}."></head><body><h1>${title}</h1>${extra}${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</body></html>` };
}

/** The fetch a fake page answers for `url`. */
export function fetchOf(url: string, page: FakePage | undefined, at: number): CrawlPageFetch {
  const base = { url, redirects: 0, chain: [], refusedUrl: null, redirectTarget: null, xRobotsTag: [], truncated: false, durationMs: 5, robots: ALLOWED, slowDown: false };
  const none = (outcome: CrawlPageFetch['outcome']): CrawlPageFetch => ({ ...base, outcome, status: null, finalUrl: null, headers: {}, body: new Uint8Array(0), bytes: 0, startedAt: outcome === 'deferred' ? null : at, slowDown: outcome === 'deferred' });
  if (page === undefined) return none('unreachable');
  if ('outcome' in page) return none(page.outcome);
  if ('slowDown' in page) return { ...base, outcome: 'response', status: 429, finalUrl: url, headers: { 'content-type': 'text/html' }, body: new Uint8Array(0), bytes: 0, startedAt: at, slowDown: true };
  if ('redirectTo' in page) {
    const status = page.status ?? 301;
    return { ...base, outcome: 'redirected', status, finalUrl: page.redirectTo, redirects: 1, chain: [{ url, status, location: page.redirectTo }], redirectTarget: page.redirectTo, headers: {}, body: new Uint8Array(0), bytes: 0, startedAt: at };
  }
  const body = encoder.encode(page.html) as Uint8Array<ArrayBuffer>;
  const contentType = page.contentType === undefined ? 'text/html; charset=utf-8' : page.contentType;
  return { ...base, outcome: 'response', status: page.status ?? 200, finalUrl: url, headers: { ...(contentType === null ? {} : { 'content-type': contentType }), ...page.headers }, body, bytes: body.byteLength, startedAt: at };
}

/**
 * A fake crawl fetcher over `site` (URL → page): records every URL it fetched; `hold` keeps a URL's fetch
 * open until released (or aborted). It asks `beforeRequest` as the real one does (after the hold, before
 * answering: `false` answers `aborted`, nothing fetched). With `pacing`, each fetch runs in the real
 * per-host pacing (`schedule`, then `report`), so its table is the crawler's to count.
 */
export function fakeFetcher(site: (url: string) => FakePage | undefined, now: () => number, options: { readonly pacing?: Pacing } = {}) {
  const fetched: string[] = [];
  const holds = new Map<string, { started: Promise<void>; markStarted: () => void; release: () => void; released: Promise<void> }>();
  return {
    fetched,
    /** Holds `url`'s next fetch open: `started` settles once it began, `release()` lets it answer. */
    hold(url: string) {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const entry = { started, markStarted, release, released };
      holds.set(url, entry);
      return entry;
    },
    forRun(settings: CrawlSettings) {
      const politeness = options.pacing?.forRun(settings.intervalMs);
      const answer = async (url: string, signal: AbortSignal | undefined, fetchOptions: CrawlFetchOptions): Promise<CrawlPageFetch> => {
        const held = holds.get(url);
        if (held) {
          holds.delete(url);
          held.markStarted();
          await Promise.race([held.released, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))]);
          if (signal?.aborted) return { ...fetchOf(url, site(url), now()), outcome: 'aborted' };
        }
        if (fetchOptions.beforeRequest && !(await fetchOptions.beforeRequest(pacingKey(url) ?? ''))) return { ...fetchOf(url, undefined, now()), outcome: 'aborted' };
        fetched.push(url);
        return fetchOf(url, site(url), now());
      };
      return {
        scope: createCrawlScope(settings),
        ...(politeness ? { politeness } : {}),
        async fetchPage(url: string, signal?: AbortSignal, fetchOptions: CrawlFetchOptions = {}): Promise<CrawlPageFetch> {
          if (!politeness) return answer(url, signal, fetchOptions);
          const host = pacingKey(url)!;
          return politeness.schedule(
            host,
            async () => {
              const result = await answer(url, signal, fetchOptions);
              politeness.report(host, { status: result.status, retryAfter: null });
              return result;
            },
            signal,
          );
        },
      };
    },
  };
}

/** The crawl worker's page job, in this process (what `analysis-worker.ts` runs for a `crawl` job). */
export const inProcessAnalyse = async (job: CrawlPageJob): Promise<CrawlPageResult> => analyseCrawlPage(job);

/** The session store in a temporary directory, a read-only raw handle on it, and its cleanup. */
export function tempStore(): { store: SessionStore; raw: DatabaseSync; count: (sql: string, ...args: (string | number)[]) => number; close: () => Promise<void> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-crawl-'));
  const store = openSessionStore({ dir });
  const raw = new DatabaseSync(store.file, { readOnly: true });
  return {
    store,
    raw,
    count: (sql, ...args) => Number((raw.prepare(sql).get(...args) as { n: number }).n),
    close: async () => {
      raw.close();
      // Closed before the directory goes: Windows refuses to delete an open file.
      await store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * The session store in memory, and its cleanup: for tests whose subject is not the database file.
 * `tempStore` flushes every write to the disk, and a test that writes hundreds of rows one by one
 * has timed out on Windows CI runners for that alone.
 */
export function memoryStore(): { store: SessionStore; close: () => Promise<void> } {
  const store = openMemorySessionStore();
  return { store, close: () => store.close() };
}

/** Settings for a crawl of `startUrl` (sitemaps off unless asked). */
export const settingsFor = (startUrl: string, changes: Partial<CrawlSettings> = {}): CrawlSettings => ({ ...defaultCrawlSettings(startUrl), sitemaps: false, ...changes });

/** A clock that moves one second per read (timestamps only: the crawler sets no timer). */
export function fakeClock(start = 1_800_000_000_000) {
  let at = start;
  return () => (at += 1_000);
}

/**
 * A fake clock with timers (for the real crawl fetcher's pacing): time moves only when a timer fires or
 * the test sets it. `settle(promise)` lets promises run, then fires the earliest timer, until `promise` settles.
 */
export function timerClock(start = 1_800_000_000_000) {
  let time = start;
  let serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: CrawlClock = {
    now: () => time,
    setTimeout(fn, ms) {
      const id = ++serial;
      timers.set(id, { at: time + Math.max(0, ms), fn });
      return () => timers.delete(id);
    },
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 10_000; i++) {
      await flush();
      if (done) return promise;
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next) break;
      timers.delete(next[0]);
      time = Math.max(time, next[1].at);
      next[1].fn();
    }
    throw new Error('never settled');
  }
  return { clock, now: () => time, advance: (ms: number) => (time += ms), pending: () => timers.size, settle };
}
