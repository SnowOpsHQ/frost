// Spec: specs/serp.spec.ts (SERP_ANALYSIS_TIMEOUT_MS), specs/serp-snapshot.schema.ts (SerpSnapshotSchema)
// Acceptance: specs/serp-overlay.feature.md (Analysis)
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SERP_ANALYSIS_MAX_QUEUED, SERP_ANALYSIS_TIMEOUT_MS } from '@app/specs/serp.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { makeForgeConfig } from '../../../../forge.config';
import type { AnalysisWorker } from '../../seo/analysis';
import { analyseSerp } from '../serp-analyse';
import { createSerpAnalyzer } from '../serp-analyzer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARAMS: SearchParams = { engine: 'bing', engineLabel: 'Bing', query: 'frost', gl: null, hl: null, device: 'mobile', page: 1, offset: null, url: 'https://www.bing.com/search?q=frost' };
const REDIRECTS = [{ path: '/ck/a', param: 'u', decode: 'bing-a1', hosts: ['www.bing.com'] }] as const;
const CONTEXT = { params: PARAMS, packVersion: 3, redirects: REDIRECTS };
const WRAPPED = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://www.example.com/').toString('base64url')}`;
const READ = { ok: true, blocks: [{ type: 'organic', items: [{ title: 'One', url: WRAPPED }] }], stats: { nodes: 4, elapsedMs: 1, truncated: false, organicCut: false } };

interface Job {
  readonly id: number;
  readonly raw: unknown;
  readonly params: unknown;
  readonly packVersion: unknown;
  readonly redirects: unknown;
}

/** A worker that records its jobs and answers as `serp-worker.ts` does, when told to. */
class FakeWorker extends EventEmitter implements AnalysisWorker {
  readonly posted: Job[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message as Job);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
  unref(): void {}
  answer(result?: unknown): void {
    const job = this.posted.at(-1)!;
    this.emit('message', { id: job.id, result: result ?? analyseSerp(job.raw, { params: job.params, packVersion: job.packVersion, redirects: job.redirects }) });
  }
}

let workers: FakeWorker[];
const spawn = () => {
  const worker = new FakeWorker();
  workers.push(worker);
  return worker;
};

beforeEach(() => {
  workers = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('node:worker_threads');
  vi.resetModules();
});

describe('the SERP worker', () => {
  test('serp-analysis-in-worker', async () => {
    const analyzer = createSerpAnalyzer({ spawn });
    const first = analyzer.analyse(READ, CONTEXT);
    const second = analyzer.analyse({ ok: false, reason: 'no-results', stats: READ.stats }, CONTEXT);
    // One worker, one job at a time, the job as `{ id, raw, params, packVersion, redirects }`.
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ id: 1, raw: READ, params: PARAMS, packVersion: 3, redirects: REDIRECTS }]);
    // A stale id settles nothing.
    workers[0]!.emit('message', { id: 99, result: { status: 'unreadable', reason: 'no-results', params: null, packVersion: null } });
    workers[0]!.answer();
    await expect(first).resolves.toMatchObject({ status: 'ready', params: PARAMS, packVersion: 3, results: [{ rank: 1, type: 'organic', url: 'https://www.example.com/', redirected: true, domain: 'example.com' }] });
    workers[0]!.answer();
    await expect(second).resolves.toEqual({ status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 3 });

    // Past the timeout: the worker is terminated, the job is `timeout`, and the next one spawns a fresh worker.
    const hung = analyzer.analyse(READ, CONTEXT);
    vi.advanceTimersByTime(SERP_ANALYSIS_TIMEOUT_MS);
    await expect(hung).resolves.toEqual({ status: 'unreadable', reason: 'timeout', params: PARAMS, packVersion: 3 });
    expect(workers[0]!.terminated).toBe(true);
    // The terminated worker's late answer is dropped: it settles nothing.
    const next = analyzer.analyse(READ, CONTEXT);
    workers[0]!.emit('message', { id: 3, result: { status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 3 } });
    workers[0]!.emit('message', { id: 4, result: { status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 3 } });
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    await expect(next).resolves.toMatchObject({ status: 'ready' });

    // A crash or an answer that is not a snapshot is `invalid-answer`.
    const crashed = analyzer.analyse(READ, CONTEXT);
    workers[1]!.emit('exit', 1);
    await expect(crashed).resolves.toEqual({ status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: 3 });
    const garbled = analyzer.analyse(READ, CONTEXT);
    expect(workers).toHaveLength(3);
    workers[2]!.answer({ status: 'maybe' });
    await expect(garbled).resolves.toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    // A spawn that throws, or a job that cannot be posted, ends that job only.
    const broken = createSerpAnalyzer({
      spawn: () => {
        throw new Error('no worker');
      },
    });
    await expect(broken.analyse(READ, CONTEXT)).resolves.toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    workers[2]!.postMessage = () => {
      throw new Error('DataCloneError');
    };
    await expect(analyzer.analyse({ fn: () => 1 }, CONTEXT)).resolves.toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    // Disposed: queued and running jobs end, the worker is terminated.
    workers[2]!.postMessage = FakeWorker.prototype.postMessage;
    const pending = analyzer.analyse(READ, CONTEXT);
    analyzer.dispose();
    await expect(pending).resolves.toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    expect(workers[2]!.terminated).toBe(true);
    // Disposed is final: later jobs answer at once and nothing is spawned.
    await expect(analyzer.analyse(READ, CONTEXT)).resolves.toEqual({ status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: 3 });
    expect(workers).toHaveLength(3);

    // The worker's code has no Electron: it only ever sees the reader's answer and the parameters.
    for (const file of ['../serp-analyse.ts', '../serp-worker.ts']) expect(readFileSync(path.join(HERE, file), 'utf8'), file).not.toMatch(/from 'electron'|require\('electron'\)/);
  });

  test('serp-analysis-queue-is-bounded', async () => {
    const analyzer = createSerpAnalyzer({ spawn });
    const running = analyzer.analyse(READ, CONTEXT);
    // One running, `SERP_ANALYSIS_MAX_QUEUED` waiting; one more drops the oldest waiting job (`timeout`).
    const waiting = Array.from({ length: SERP_ANALYSIS_MAX_QUEUED + 2 }, () => analyzer.analyse(READ, CONTEXT));
    await expect(waiting[0]).resolves.toEqual({ status: 'unreadable', reason: 'timeout', params: PARAMS, packVersion: 3 });
    await expect(waiting[1]).resolves.toMatchObject({ status: 'unreadable', reason: 'timeout' });
    workers[0]!.answer();
    await expect(running).resolves.toMatchObject({ status: 'ready' });
    // The rest run in order.
    for (const job of waiting.slice(2)) {
      workers[0]!.answer();
      await expect(job).resolves.toMatchObject({ status: 'ready' });
    }
    expect(workers[0]!.posted).toHaveLength(1 + SERP_ANALYSIS_MAX_QUEUED);
  });

  test('serp-worker-answers-each-job', async () => {
    const port = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void };
    const answers: unknown[] = [];
    port.postMessage = (message) => answers.push(message);
    vi.doMock('node:worker_threads', () => ({ parentPort: port }));
    await import('../serp-worker');
    port.emit('message', { id: 7, raw: READ, params: PARAMS, packVersion: 3, redirects: REDIRECTS });
    port.emit('message', { id: 8, raw: 'garbage', params: PARAMS, packVersion: 3, redirects: REDIRECTS });
    // Not a job: dropped.
    port.emit('message', { raw: READ });
    port.emit('message', null);
    expect(answers).toEqual([
      { id: 7, result: analyseSerp(READ, CONTEXT) },
      { id: 8, result: { status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: 3 } },
    ]);
  });

  test('serp-analysis-build-entry', () => {
    const vite = makeForgeConfig({}).plugins?.find((plugin) => plugin instanceof VitePlugin);
    if (!(vite instanceof VitePlugin)) throw new Error('no VitePlugin');
    // .vite/build/serp-analysis.cjs, beside main.cjs (main starts the worker from there; Task 4).
    expect(vite.config.build).toContainEqual({ entry: { 'serp-analysis': 'src/main/serp/serp-worker.ts' }, config: 'vite.main.config.ts', target: 'main' });
  });
});
