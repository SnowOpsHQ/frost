// Spec: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_LIMITS, PROBE_KEEP_HEADERS, MAX_PENDING_PROBE_WATCHES, probeUserAgent),
// specs/visibility-probes.schema.ts (ProbesStateSchema, ProbeJobResult), specs/fetcher.spec.ts (BoundedFetcher, CHECKS_FETCHER_LIMITS),
// specs/private-address.spec.ts, specs/seo-javascript.spec.ts (SERVED_ACCEPT)
// Acceptance: specs/visibility-probes.feature.md (Runs); review focus probes-are-bounded
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BoundedFetchRequest, BoundedFetchResult, BoundedFetcher } from '@app/specs/fetcher.spec';
import { SERVED_ACCEPT } from '@app/specs/seo-javascript.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { MAX_PENDING_PROBE_WATCHES, PROBE_AGENTS, PROBE_KEEP_HEADERS, PROBE_LIMITS, PROBE_SEPARATE_HEADERS, probeUserAgent } from '@app/specs/visibility-probes.spec';
import { ProbesStateSchema, type ProbeJob, type ProbeJobResult, type ProbesState } from '@app/specs/visibility-probes.schema';
import type { AnalysisWorker } from '../../seo/analysis';
import { createBoundedFetcher, type Hop } from '../../seo/fetcher';
import { runProbeJob } from '../probe-parse';
import { createProbeParser } from '../probe-parser';
import { createProbes, type ProbeTab } from '../probes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'https://www.example.com/guide/shoes';
const CHROME = '140.0.7339.80';
const enc = (text: string) => new TextEncoder().encode(text);
const HTML = (words: string) => enc(`<!doctype html><title>Shoes</title><link rel="canonical" href="${PAGE}"><body><p>${words}</p></body>`);

afterEach(() => vi.useRealTimers());

const result = (request: BoundedFetchRequest, extra: Partial<BoundedFetchResult> = {}): BoundedFetchResult => ({
  url: request.url,
  outcome: 'response',
  status: 200,
  finalUrl: request.url,
  redirects: 0,
  chain: [],
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: HTML('best running shoes for trails') as Uint8Array<ArrayBuffer>,
  truncated: false,
  durationMs: 3,
  ...extra,
});

/** A `checks` lane whose answers the test gives, one call at a time (an abort answers `aborted`). */
function controlledFetcher() {
  const calls: { request: BoundedFetchRequest; answer: (extra?: Partial<BoundedFetchResult>) => void; settled: boolean }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.fn(
    (request: BoundedFetchRequest) =>
      new Promise<BoundedFetchResult>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const call = {
          request,
          settled: false,
          answer: (extra: Partial<BoundedFetchResult> = {}) => {
            if (call.settled) return;
            call.settled = true;
            inFlight -= 1;
            resolve(result(request, extra));
          },
        };
        request.signal?.addEventListener('abort', () => call.answer({ outcome: 'aborted', status: null, finalUrl: null, body: new Uint8Array() as Uint8Array<ArrayBuffer> }), { once: true });
        calls.push(call);
      }),
  );
  const fetcher: BoundedFetcher = { fetch, load: () => ({ running: inFlight, queued: 0 }) };
  return { fetcher, fetch, calls, maxInFlight: () => maxInFlight, open: () => calls.filter((call) => !call.settled) };
}

const ROBOTS: RobotsFetch = { url: 'https://www.example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://www.example.com/robots.txt', redirects: 0, body: enc('User-agent: GPTBot\nDisallow: /\n'), truncated: false };
/** Main's robots.txt fetcher: the example site's file for its origin, none to obey elsewhere. */
const robotsFor = async (url: string): Promise<RobotsFetch> => {
  const origin = new URL(url).origin;
  return origin === 'https://www.example.com' ? ROBOTS : { ...ROBOTS, url: `${origin}/robots.txt`, finalUrl: null, outcome: 'unavailable', status: 404, body: new Uint8Array() };
};

function harness(options: { fetcher?: BoundedFetcher; tabs?: Record<number, ProbeTab | null>; parse?: (job: ProbeJob, signal?: AbortSignal) => Promise<ProbeJobResult> } = {}) {
  const controlled = controlledFetcher();
  const fetcher = options.fetcher ?? controlled.fetcher;
  const tabs: Record<number, ProbeTab | null> = options.tabs ?? { 1: { contentsId: 11, url: `${PAGE}#top`, active: true }, 2: { contentsId: 22, url: PAGE, active: false } };
  const robots = vi.fn(robotsFor);
  const parse = vi.fn(options.parse ?? (async (job: ProbeJob) => runProbeJob(job)));
  let clock = 1_000;
  const probes = createProbes({ fetcher, robots, parse, tab: (tabId) => tabs[tabId] ?? null, now: () => clock++, chromeVersion: CHROME });
  return { probes, robots, parse, tabs, ...controlled, fetch: options.fetcher ? (fetcher.fetch as ReturnType<typeof vi.fn>) : controlled.fetch };
}

const valid = (state: ProbesState): ProbesState => {
  const parsed = ProbesStateSchema.safeParse(state);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return state;
};
const rowOf = (state: ProbesState, agent: string) => state.rows.find((row) => row.agent === agent)!;

describe('visibility probes', () => {
  test('probes-are-bounded', async () => {
    const h = harness();
    expect(h.probes.run(1)).toBe(true);
    // At most 2 at once: the rest start as answers come in.
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    while (h.calls.length < PROBE_AGENTS.length || h.open().length > 0) {
      await vi.waitFor(() => expect(h.open().length).toBeGreaterThan(0));
      h.open()[0]!.answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await vi.waitFor(() => expect(h.probes.state(1).status).toBe('done'));
    expect(h.maxInFlight()).toBe(PROBE_LIMITS.maxConcurrent);
    expect(h.fetch).toHaveBeenCalledTimes(PROBE_LIMITS.maxFetches);
    // One GET per agent, its user agent, the tab URL (fragment aside) as the page, the caps, the headers.
    expect(h.calls.map((call) => call.request.userAgent ?? null)).toEqual(PROBE_AGENTS.map((agent) => probeUserAgent(agent, CHROME)));
    for (const { request } of h.calls) {
      expect(request).toMatchObject({ url: PAGE, page: PAGE, method: 'GET', accept: SERVED_ACCEPT, maxBytes: PROBE_LIMITS.maxBytes, timeoutMs: PROBE_LIMITS.timeoutMs, maxRedirects: 3, keepHeaders: [...PROBE_KEEP_HEADERS], separateHeaders: [...PROBE_SEPARATE_HEADERS], maxHeaderChars: PROBE_LIMITS.maxHeaderChars });
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.readBody?.(200)).toBe(true);
      expect(request.readBody?.(404)).toBe(false);
    }
    // robots.txt once (every agent ended on the tab's origin), from main's fetcher; GPTBot disallowed, the rest allowed.
    expect(h.robots).toHaveBeenCalledTimes(1);
    expect(h.robots).toHaveBeenCalledWith('https://www.example.com/');
    const done = valid(h.probes.state(1));
    expect(rowOf(done, 'gptbot').robots?.verdict).toBe('disallowed');
    expect(done.diffs.find((diff) => diff.agent === 'gptbot')?.facts).toEqual(['robots']);

    // Through the real bounded fetcher: the private-address rule is the fetcher's, with the tab URL as the page.
    const hopCalls: string[] = [];
    const hop: Hop = async (url, _signal, options) => {
      hopCalls.push(url);
      if (url === `${PAGE}` && options?.userAgent?.includes('Googlebot')) return { kind: 'redirect', status: 302, location: 'http://127.0.0.1/admin' };
      const body = HTML('hello');
      return {
        kind: 'response',
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: (async function* () {
          yield body;
        })(),
        cancel: () => undefined,
      };
    };
    const resolve = async (host: string) => (host === 'intranet.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
    const real = createBoundedFetcher({ hop, resolve, limits: { perOriginIntervalMs: 0 } });
    const tabs: Record<number, ProbeTab> = {
      1: { contentsId: 11, url: PAGE, active: true },
      2: { contentsId: 22, url: 'https://intranet.example.com/', active: true },
      3: { contentsId: 33, url: 'http://localhost:3000/', active: true },
    };
    const r = harness({ fetcher: real, tabs });
    expect(r.probes.run(1)).toBe(true);
    await vi.waitFor(() => expect(r.probes.state(1).status).toBe('done'));
    const publicRun = valid(r.probes.state(1));
    expect(rowOf(publicRun, 'googlebot')).toMatchObject({ outcome: 'private-redirect', status: 302 });
    expect(rowOf(publicRun, 'browser')).toMatchObject({ outcome: 'ok', status: 200, wordCount: 1 });
    expect(hopCalls.filter((url) => url.includes('127.0.0.1'))).toEqual([]);
    // A public name that resolves to a private address: never requested.
    expect(r.probes.run(2)).toBe(true);
    await vi.waitFor(() => expect(r.probes.state(2).status).toBe('done'));
    expect(r.probes.state(2).rows.map((row) => row.outcome)).toEqual(PROBE_AGENTS.map(() => 'private-address'));
    expect(hopCalls.filter((url) => url.includes('intranet'))).toEqual([]);
    // A private page (a dev server) may be probed.
    expect(r.probes.run(3)).toBe(true);
    await vi.waitFor(() => expect(r.probes.state(3).status).toBe('done'));
    expect(r.probes.state(3).rows.map((row) => row.outcome)).toEqual(PROBE_AGENTS.map(() => 'ok'));
  });

  test('probes-only-on-user-action', async () => {
    const h = harness({ tabs: { 1: { contentsId: 11, url: PAGE, active: true }, 2: { contentsId: 22, url: PAGE, active: false }, 3: { contentsId: 33, url: 'about:blank', active: true }, 4: { contentsId: 44, url: 'app://frost/', active: true } } });
    h.probes.dropped(11);
    h.probes.navigatedInPage(11, `${PAGE}?x=1`);
    expect(valid(h.probes.state(1))).toMatchObject({ status: 'idle', url: PAGE, rows: [], diffs: [], robotsTxt: [], startedAt: null, finishedAt: null });
    const aborted = new AbortController();
    const watching = h.probes.watch(1, 10, aborted.signal);
    aborted.abort();
    await expect(watching).resolves.toMatchObject({ status: 'idle' });
    // A background tab, a tab without a web page, an unknown tab: nothing runs.
    expect(h.probes.run(2)).toBe(false);
    expect(h.probes.run(3)).toBe(false);
    expect(h.probes.run(4)).toBe(false);
    expect(h.probes.run(99)).toBe(false);
    expect(valid(h.probes.state(3))).toMatchObject({ status: 'idle', url: '' });
    expect(valid(h.probes.state(99))).toMatchObject({ status: 'idle', url: '', tabId: 99 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.robots).not.toHaveBeenCalled();
    expect(h.parse).not.toHaveBeenCalled();
    h.probes.dispose();
    expect(h.probes.run(1)).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  test('probes-one-run-per-tab', async () => {
    const h = harness();
    expect(h.probes.run(1)).toBe(true);
    expect(h.probes.run(1)).toBe(true);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toHaveLength(2);
    expect(h.robots).toHaveBeenCalledTimes(1);
    while (h.probes.state(1).status === 'running') {
      for (const call of h.open()) call.answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.probes.state(1).status).toBe('done');
    expect(h.fetch).toHaveBeenCalledTimes(6);
    // A finished run can be run again (afresh).
    expect(h.probes.run(1)).toBe(true);
    expect(h.probes.state(1)).toMatchObject({ status: 'running' });
    expect(h.probes.state(1).rows.every((row) => row.outcome === 'pending')).toBe(true);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(8));
    expect(h.robots).toHaveBeenCalledTimes(2);
  });

  test('probes-rows-stream', async () => {
    const h = harness();
    const v0 = h.probes.state(1).version;
    h.probes.run(1);
    const started = valid(h.probes.state(1));
    expect(started.version).toBeGreaterThan(v0);
    expect(started).toMatchObject({ status: 'running', url: PAGE, startedAt: expect.any(Number), finishedAt: null, diffs: [] });
    expect(started.rows.map((row) => [row.agent, row.outcome])).toEqual(PROBE_AGENTS.map((agent) => [agent.id, 'pending']));
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    // The baseline answers: its row fills in, the version moves; no diff yet.
    const before = h.probes.state(1).version;
    h.calls[0]!.answer();
    await vi.waitFor(() => expect(rowOf(h.probes.state(1), 'browser').outcome).toBe('ok'));
    const one = valid(h.probes.state(1));
    expect(one.version).toBeGreaterThan(before);
    expect(rowOf(one, 'browser')).toMatchObject({ status: 200, finalUrl: PAGE, title: 'Shoes', canonical: PAGE, wordCount: 5, noindex: false, contentType: 'text/html; charset=utf-8', truncated: false, textTruncated: false, partial: false, hops: [], robots: { url: 'https://www.example.com/robots.txt', verdict: 'allowed' } });
    expect(rowOf(one, 'browser').textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowOf(one, 'browser').textSignature).toHaveLength(64);
    // The robots.txt read, as served to frost, with when the run got it.
    expect(one.robotsTxt).toEqual([{ url: 'https://www.example.com/robots.txt', outcome: 'ok', readAt: expect.any(Number) }]);
    // Googlebot is redirected, and told noindex in its own header.
    h.calls[1]!.answer({ redirects: 1, chain: [{ url: PAGE, status: 301, location: `${PAGE}/` }], finalUrl: `${PAGE}/`, headers: { 'content-type': 'text/html', 'x-robots-tag': 'googlebot: noindex' } });
    await vi.waitFor(() => expect(rowOf(h.probes.state(1), 'googlebot').outcome).toBe('ok'));
    const two = valid(h.probes.state(1));
    expect(rowOf(two, 'googlebot')).toMatchObject({ hops: [{ url: PAGE, status: 301 }], finalUrl: `${PAGE}/`, xRobotsTag: { general: [], agent: ['noindex'] }, noindex: true });
    expect(two.diffs).toEqual([{ agent: 'googlebot', facts: ['finalUrl', 'redirects', 'noindex'], textSimilarity: 1, contentTruncated: false }]);
    // A 403 for one agent, a PDF for another.
    await vi.waitFor(() => expect(h.calls).toHaveLength(4));
    h.calls[2]!.answer({ status: 403, body: new Uint8Array() as Uint8Array<ArrayBuffer>, headers: {} });
    h.calls[3]!.answer({ headers: { 'content-type': 'application/pdf', 'x-robots-tag': 'noindex' }, body: enc('%PDF-1.4') as Uint8Array<ArrayBuffer> });
    await vi.waitFor(() => expect(rowOf(h.probes.state(1), 'gptbot').outcome).toBe('not-html'));
    const four = valid(h.probes.state(1));
    expect(rowOf(four, 'bingbot')).toMatchObject({ outcome: 'http-status', status: 403, wordCount: null, textHash: null, noindex: false });
    expect(rowOf(four, 'gptbot')).toMatchObject({ outcome: 'not-html', status: 200, noindex: true, bytes: 8, wordCount: null, metaRobots: null });
    await vi.waitFor(() => expect(h.calls).toHaveLength(6));
    h.calls[4]!.answer();
    h.calls[5]!.answer({ outcome: 'timeout', status: null, finalUrl: null, body: new Uint8Array() as Uint8Array<ArrayBuffer> });
    await vi.waitFor(() => expect(h.probes.state(1).status).toBe('done'));
    const done = valid(h.probes.state(1));
    expect(done.finishedAt).toEqual(expect.any(Number));
    expect(rowOf(done, 'perplexitybot')).toMatchObject({ outcome: 'timeout', status: null, noindex: null, robots: { verdict: 'allowed' } });
    expect(rowOf(done, 'gptbot').robots?.verdict).toBe('disallowed');
    expect(done.diffs.map((diff) => diff.agent)).toEqual(['googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot']);
  });

  test('probes-stop-keeps-rows', async () => {
    const h = harness();
    h.probes.run(1);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    h.calls[0]!.answer();
    await vi.waitFor(() => expect(rowOf(h.probes.state(1), 'browser').outcome).toBe('ok'));
    await vi.waitFor(() => expect(h.calls).toHaveLength(3));
    expect(h.probes.stop(1)).toBe(true);
    // The requests in flight are aborted; nothing more starts.
    expect(h.calls.slice(1).every((call) => call.request.signal?.aborted)).toBe(true);
    const stopped = valid(h.probes.state(1));
    expect(stopped).toMatchObject({ status: 'stopped', finishedAt: expect.any(Number) });
    expect(stopped.rows.map((row) => row.outcome)).toEqual(['ok', 'stopped', 'stopped', 'stopped', 'stopped', 'stopped']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.calls).toHaveLength(3);
    expect(h.probes.state(1)).toEqual(stopped);
    expect(h.probes.stop(1)).toBe(false);
    expect(h.probes.stop(2)).toBe(false);
  });

  test('probes-cancel-on-new-document', async () => {
    const cancels: [string, (h: ReturnType<typeof harness>) => void][] = [
      ['new document', (h) => h.probes.dropped(11)],
      ['in-page move', (h) => h.probes.navigatedInPage(11, `${PAGE}?page=2`)],
      [
        'closed tab',
        (h) => {
          h.tabs[1] = null;
          h.probes.dropped(11);
        },
      ],
      ['clear browsing data', (h) => h.probes.cancelAll()],
      ['dispose', (h) => h.probes.dispose()],
    ];
    for (const [name, cancel] of cancels) {
      const h = harness();
      h.probes.run(1);
      await vi.waitFor(() => expect(h.calls, name).toHaveLength(2));
      // The same URL with another fragment keeps the run.
      h.probes.navigatedInPage(11, `${PAGE}#reviews`);
      h.probes.dropped(999);
      expect(h.probes.state(1).status, name).toBe('running');
      const before = h.probes.state(1).version;
      cancel(h);
      expect(h.calls.every((call) => call.request.signal?.aborted), name).toBe(true);
      const state = valid(h.probes.state(1));
      expect(state, name).toMatchObject({ status: 'idle', rows: [], diffs: [] });
      expect(state.version, name).toBeGreaterThan(before);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.calls, name).toHaveLength(2);
      expect(h.probes.state(1).status, name).toBe('idle');
    }
    // A late parse answer after a new document is dropped.
    let release: (value: ProbeJobResult) => void = () => undefined;
    const slow = harness({ parse: (job) => (job.kind === 'page' ? new Promise<ProbeJobResult>((resolve) => (release = resolve)) : Promise.resolve(runProbeJob(job))) });
    slow.probes.run(1);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(2));
    slow.calls[0]!.answer();
    await vi.waitFor(() => expect(slow.parse.mock.calls.some(([job]) => job.kind === 'page')).toBe(true));
    slow.probes.dropped(11);
    release({ ok: false, reason: 'parse-failed' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(slow.probes.state(1)).toMatchObject({ status: 'idle', rows: [] });
  });

  test('probes-watch-wakes-capped', async () => {
    const h = harness();
    await expect(h.probes.watch(1, -1)).resolves.toMatchObject({ status: 'idle' });
    const version = h.probes.state(1).version;
    const waiting = h.probes.watch(1, version);
    expect(h.probes.pendingWatches()).toBe(1);
    h.probes.run(1);
    await expect(waiting).resolves.toMatchObject({ status: 'running' });
    const now = h.probes.state(1).version;
    const aborted = new AbortController();
    const onAbort = h.probes.watch(1, now, aborted.signal);
    aborted.abort();
    await expect(onAbort).resolves.toMatchObject({ status: 'running' });
    expect(h.probes.pendingWatches()).toBe(0);
    const many = Array.from({ length: MAX_PENDING_PROBE_WATCHES + 1 }, () => h.probes.watch(1, now));
    expect(h.probes.pendingWatches()).toBe(MAX_PENDING_PROBE_WATCHES);
    await expect(many[0]).resolves.toMatchObject({ version: now });
    h.probes.dispose();
    for (const watch of many) await expect(watch).resolves.toMatchObject({ tabId: 1 });
    expect(h.probes.pendingWatches()).toBe(0);
    await expect(h.probes.watch(1, Number.MAX_SAFE_INTEGER)).resolves.toMatchObject({ tabId: 1 });
  });

  test('probes-parse-in-worker', async () => {
    class FakeWorker extends EventEmitter implements AnalysisWorker {
      readonly posted: { id: number; kind: string; job: ProbeJob }[] = [];
      terminated = false;
      postMessage(message: unknown): void {
        this.posted.push(message as never);
      }
      terminate(): Promise<number> {
        this.terminated = true;
        return Promise.resolve(1);
      }
      unref(): void {}
      answer(result?: unknown): void {
        const job = this.posted.at(-1)!;
        this.emit('message', { id: job.id, result: result ?? runProbeJob(job.job) });
      }
    }
    const workers: FakeWorker[] = [];
    const spawn = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const job: ProbeJob = { kind: 'robots', agent: 'gptbot', url: PAGE, robots: ROBOTS };
    vi.useFakeTimers();
    const parser = createProbeParser({ spawn, maxQueued: 1 });
    const first = parser.run(job);
    const second = parser.run(job);
    // One running and one waiting: one more is refused at once.
    await expect(parser.run(job)).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    expect(workers[0]!.posted).toEqual([{ id: expect.any(Number), kind: 'probe', job }]);
    workers[0]!.answer();
    await expect(first).resolves.toEqual(runProbeJob(job));
    // A late answer for another job, or garbage, is not an answer.
    workers[0]!.emit('message', { id: 12345, result: { ok: true } });
    workers[0]!.emit('message', { id: workers[0]!.posted.at(-1)!.id, result: { ok: 'yes' } });
    await expect(second).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    // Past the deadline: terminated, `parse-failed`, and the next job spawns a new worker.
    const slow = parser.run(job);
    await vi.advanceTimersByTimeAsync(PROBE_LIMITS.parseTimeoutMs);
    await expect(slow).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    expect(workers[0]!.terminated).toBe(true);
    const next = parser.run(job);
    expect(spawn).toHaveBeenCalledTimes(2);
    // A crash fails the job.
    workers[1]!.emit('error', new Error('boom'));
    await expect(next).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    parser.dispose();
    await expect(parser.run(job)).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    // The worker entry answers probe jobs (beside the SERP analysis), and imports no Electron.
    const port = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void };
    const answers: unknown[] = [];
    port.postMessage = (message) => answers.push(message);
    vi.doMock('node:worker_threads', () => ({ parentPort: port }));
    await import('../serp-worker');
    port.emit('message', { id: 3, kind: 'probe', job });
    port.emit('message', { id: 4, kind: 'probe', job: { kind: 'page', agent: 'nobody' } });
    port.emit('message', { kind: 'probe', job });
    expect(answers).toEqual([
      { id: 3, result: runProbeJob(job) },
      { id: 4, result: { ok: false, reason: 'invalid-job' } },
    ]);
    vi.doUnmock('node:worker_threads');
    for (const file of ['../probe-parse.ts', '../probe-compare.ts', '../probe-parser.ts', '../serp-worker.ts']) expect(readFileSync(path.join(HERE, file), 'utf8'), file).not.toMatch(/from 'electron'|require\('electron'\)/);
  });

  test('probes-robots-per-final-url', async () => {
    const h = harness();
    h.probes.run(1);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    // The browser stays; Googlebot is sent to another origin, whose robots.txt is asked once.
    h.calls[0]!.answer();
    h.calls[1]!.answer({ redirects: 1, chain: [{ url: PAGE, status: 302, location: 'https://m.example.com/shoes' }], finalUrl: 'https://m.example.com/shoes' });
    await vi.waitFor(() => expect(h.calls).toHaveLength(4));
    // Bingbot is sent to a disallowed path on the same origin (judged there), GPTBot to the other origin too.
    h.calls[2]!.answer({ redirects: 1, chain: [{ url: PAGE, status: 301, location: 'https://www.example.com/private' }], finalUrl: 'https://www.example.com/private' });
    h.calls[3]!.answer({ redirects: 1, chain: [{ url: PAGE, status: 302, location: 'https://m.example.com/shoes' }], finalUrl: 'https://m.example.com/shoes' });
    await vi.waitFor(() => expect(h.calls).toHaveLength(6));
    // A final URL on a private host (the page is public): its robots.txt is never asked.
    h.calls[4]!.answer({ finalUrl: 'http://10.0.0.1/shoes' });
    h.calls[5]!.answer();
    await vi.waitFor(() => expect(h.probes.state(1).status).toBe('done'));
    const done = valid(h.probes.state(1));
    expect(h.robots.mock.calls.map(([url]) => url).sort()).toEqual(['https://m.example.com/', 'https://www.example.com/']);
    expect(done.robotsTxt.map((file) => [file.url, file.outcome])).toEqual([
      ['https://www.example.com/robots.txt', 'ok'],
      ['https://m.example.com/robots.txt', 'unavailable'],
    ]);
    expect(rowOf(done, 'googlebot').robots).toMatchObject({ url: 'https://m.example.com/robots.txt', verdict: 'allowed' });
    // GPTBot's own origin file disallows it, but it ended on the other origin, which has none.
    expect(rowOf(done, 'gptbot').robots).toMatchObject({ url: 'https://m.example.com/robots.txt', verdict: 'allowed' });
    expect(rowOf(done, 'claudebot').robots).toMatchObject({ url: null, verdict: 'unknown' });
    expect(rowOf(done, 'perplexitybot').robots).toMatchObject({ url: 'https://www.example.com/robots.txt', verdict: 'allowed' });
    expect(rowOf(done, 'bingbot').robots).toMatchObject({ verdict: 'allowed' });
  });

  test('probes-stop-frees-the-worker', async () => {
    // The real job queue over a worker that answers only when told: Stop then Run, three times.
    class SlowWorker extends EventEmitter implements AnalysisWorker {
      readonly posted: { id: number; job: ProbeJob }[] = [];
      terminated = false;
      postMessage(message: unknown): void {
        this.posted.push(message as never);
      }
      terminate(): Promise<number> {
        this.terminated = true;
        return Promise.resolve(1);
      }
      unref(): void {}
      answer(): void {
        const message = this.posted.at(-1);
        if (message) this.emit('message', { id: message.id, result: runProbeJob(message.job) });
      }
    }
    const workers: SlowWorker[] = [];
    const parser = createProbeParser({
      spawn: () => {
        const worker = new SlowWorker();
        workers.push(worker);
        return worker;
      },
      maxQueued: 4,
    });
    const answering = (request: BoundedFetchRequest) => Promise.resolve(result(request));
    const fetcher: BoundedFetcher = { fetch: vi.fn(answering), load: () => ({ running: 0, queued: 0 }) };
    const h = harness({ fetcher, parse: (job, signal) => parser.run(job, signal) });
    for (let round = 0; round < 3; round++) {
      expect(h.probes.run(1)).toBe(true);
      // Its jobs fill the queue while the worker holds the first.
      await vi.waitFor(() => expect(workers.at(-1)?.posted.length ?? 0).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.probes.stop(1)).toBe(true);
      // The running job's worker is ended; nothing of the stopped run is left waiting.
      expect(workers.at(-1)!.terminated).toBe(true);
    }
    // A fourth run gets the worker and the whole queue: every row is read.
    expect(h.probes.run(1)).toBe(true);
    for (let i = 0; i < 100 && h.probes.state(1).status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      workers.at(-1)?.answer();
    }
    const done = valid(h.probes.state(1));
    expect(done.status).toBe('done');
    expect(done.rows.map((row) => row.outcome)).toEqual(PROBE_AGENTS.map(() => 'ok'));
    // A job whose signal has already aborted never runs; one aborted while queued is dropped.
    const aborted = new AbortController();
    aborted.abort();
    await expect(parser.run({ kind: 'robots', agent: 'browser', url: PAGE, robots: null }, aborted.signal)).resolves.toEqual({ ok: false, reason: 'parse-failed' });
    parser.dispose();
  });
});
