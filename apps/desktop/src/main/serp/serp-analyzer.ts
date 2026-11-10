import type { SerpApiJob } from '@app/specs/serp-api.schema';
import { SERP_ANALYSIS_MAX_QUEUED, SERP_ANALYSIS_TIMEOUT_MS, type SerpUnreadableReason } from '@app/specs/serp.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpSnapshot } from '@app/specs/serp-snapshot.schema';
import type { AnalysisWorker } from '../seo/analysis';
import type { SerpRedirectRule } from './engines';
import type { SerpApiJobAnswer } from './serp-api-parse';

// The SERP analysis off Electron's main thread (spec `serp.spec.ts`, `SERP_ANALYSIS_TIMEOUT_MS`;
// acceptance `serp-overlay.feature.md`, Analysis), as Phase 2's `createAnalyzer` drives the SEO
// worker: main posts each reader answer to one long-lived worker of the SERP's own
// (`serp-worker.ts`, bundled as `serp-analysis.cjs`), one job at a time. Each job has a hard
// timeout, after which the worker is terminated (`timeout`) and the next job spawns a new one; a
// worker that errors or exits ends its job (`invalid-answer`). At most `SERP_ANALYSIS_MAX_QUEUED`
// jobs wait; one more drops the oldest waiting job (`timeout`). After `dispose()` nothing is spawned
// again: every later job answers `invalid-answer` at once. A late answer from a terminated worker,
// or for another job, is dropped. The worker's answer is checked for a
// snapshot's shape only (it was validated with `SerpSnapshotSchema` in the worker; Zod stays off
// main's thread). Never rejects.
//
// A data API's answer (Phase 12 Task 3, `serp-api.spec.ts`) is an `api` job in the same queue
// (`analyseApi`: `{ id, kind: 'api', job }`, answered `{ id, result, skipped, vendorError }`), under
// the same deadline and limits; the vendor's JSON text is parsed only in the worker. Main runs a
// separate analyzer instance for it (`setup.ts`), so a busy tab never drops an API job.

export interface SerpAnalyzerOptions {
  /** Starts a worker running `serp-worker.ts` (main: `new Worker(…/serp-analysis.cjs)`; Task 4). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
}

/** What main knows of the page beside the reader's answer. */
export interface SerpJobContext {
  readonly params: SearchParams;
  readonly packVersion: number;
  /** The engine's click redirects, hosts resolved (`redirectRules(engine)`). */
  readonly redirects: readonly SerpRedirectRule[];
}

export interface SerpAnalyzer {
  /** Validates and analyses a reader answer in the worker. Never rejects. */
  analyse(raw: unknown, context: SerpJobContext): Promise<SerpSnapshot>;
  /** Validates, caps and maps a data API's answer in the worker (`runSerpApiJob`). Never rejects. */
  analyseApi(job: SerpApiJob): Promise<SerpApiJobAnswer>;
  /** Ends every job and terminates the worker (the app is quitting). */
  dispose(): void;
}

interface Job {
  readonly id: number;
  /** What is posted beside the id (a reader answer and its context, or `{ kind: 'api', job }`). */
  readonly message: Readonly<Record<string, unknown>>;
  readonly context: Pick<SerpJobContext, 'params' | 'packVersion'>;
  readonly settle: (answer: SerpApiJobAnswer) => void;
}

/** Whether the worker's answer has a snapshot's shape. */
function isSnapshot(value: unknown): value is SerpSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === 'ready' || status === 'unreadable';
}

export function createSerpAnalyzer(options: SerpAnalyzerOptions): SerpAnalyzer {
  const timeoutMs = options.timeoutMs ?? SERP_ANALYSIS_TIMEOUT_MS;
  const maxQueued = options.maxQueued ?? SERP_ANALYSIS_MAX_QUEUED;
  let disposed = false;
  const queue: Job[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { job: Job; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;

  const unreadable = (job: Job, reason: SerpUnreadableReason): SerpApiJobAnswer => ({ snapshot: { status: 'unreadable', reason, params: job.context.params, packVersion: job.context.packVersion }, skipped: 0, vendorError: false });

  /** Settles the current job and moves on; `kill` also ends its worker (the next job spawns a new one). */
  const finish = (snapshot: (job: Job) => SerpApiJobAnswer, kill: boolean): void => {
    if (!current) return;
    const { job, timer, worker: running } = current;
    clearTimeout(timer);
    current = null;
    if (kill) {
      if (worker === running) worker = null;
      void running.terminate().catch(() => undefined);
    }
    job.settle(snapshot(job));
    pump();
  };

  const spawn = (): AnalysisWorker => {
    const created = options.spawn();
    created.unref();
    created.on('message', (message) => {
      const { id, result, skipped, vendorError } = (message ?? {}) as { id?: unknown; result?: unknown; skipped?: unknown; vendorError?: unknown };
      if (!current || current.worker !== created || current.job.id !== id) return;
      const count = typeof skipped === 'number' && Number.isSafeInteger(skipped) && skipped >= 0 ? skipped : 0;
      finish((job) => (isSnapshot(result) ? { snapshot: result, skipped: count, vendorError: vendorError === true } : unreadable(job, 'invalid-answer')), false);
    });
    const failed = () => {
      if (worker === created) worker = null;
      if (current && current.worker === created) finish((job) => unreadable(job, 'invalid-answer'), true);
    };
    created.on('error', failed);
    created.on('exit', failed);
    return created;
  };

  function pump(): void {
    if (current || queue.length === 0) return;
    const job = queue.shift()!;
    let running: AnalysisWorker;
    try {
      worker ??= spawn();
      running = worker;
    } catch {
      job.settle(unreadable(job, 'invalid-answer'));
      pump();
      return;
    }
    try {
      running.postMessage({ id: job.id, ...job.message });
    } catch {
      // Not structured-cloneable: not a reader answer.
      job.settle(unreadable(job, 'invalid-answer'));
      pump();
      return;
    }
    current = { job, worker: running, timer: setTimeout(() => finish((timedOut) => unreadable(timedOut, 'timeout'), true), timeoutMs) };
  }

  const enqueue = (message: Job['message'], context: Job['context']): Promise<SerpApiJobAnswer> =>
    new Promise<SerpApiJobAnswer>((settle) => {
      const job: Job = { id: nextId++, message, context, settle };
      if (disposed) {
        settle(unreadable(job, 'invalid-answer'));
        return;
      }
      queue.push(job);
      while (queue.length > maxQueued) {
        const dropped = queue.shift()!;
        dropped.settle(unreadable(dropped, 'timeout'));
      }
      pump();
    });

  return {
    analyse: async (raw, context) => (await enqueue({ raw, params: context.params, packVersion: context.packVersion, redirects: context.redirects }, context)).snapshot,
    // Main built the job (`checkSearchViaApi`): its parameters and pack version stand for an answer the worker never gives.
    analyseApi: (job) => enqueue({ kind: 'api', job }, { params: job.params, packVersion: job.packVersion }),
    dispose() {
      disposed = true;
      for (const job of queue.splice(0)) job.settle(unreadable(job, 'invalid-answer'));
      if (current) finish((job) => unreadable(job, 'invalid-answer'), true);
      if (worker) void worker.terminate().catch(() => undefined);
      worker = null;
    },
  };
}
