import { SERP_ANALYSIS_TIMEOUT_MS, type SerpUnreadableReason } from '@app/specs/serp.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpSnapshot } from '@app/specs/serp-snapshot.schema';
import type { AnalysisWorker } from '../seo/analysis';

// The SERP analysis off Electron's main thread (spec `serp.spec.ts`, `SERP_ANALYSIS_TIMEOUT_MS`;
// acceptance `serp-overlay.feature.md`, Analysis), as Phase 2's `createAnalyzer` drives the SEO
// worker: main posts each reader answer to one long-lived worker of the SERP's own
// (`serp-worker.ts`, bundled as `serp-analysis.cjs`), one job at a time. Each job has a hard
// timeout, after which the worker is terminated (`timeout`) and the next job spawns a new one; a
// worker that errors or exits ends its job (`invalid-answer`). The worker's answer is checked for a
// snapshot's shape only (it was validated with `SerpSnapshotSchema` in the worker; Zod stays off
// main's thread). Never rejects.

export interface SerpAnalyzerOptions {
  /** Starts a worker running `serp-worker.ts` (main: `new Worker(…/serp-analysis.cjs)`; Task 4). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
}

/** What main knows of the page beside the reader's answer. */
export interface SerpJobContext {
  readonly params: SearchParams;
  readonly packVersion: number;
}

export interface SerpAnalyzer {
  /** Validates and analyses a reader answer in the worker. Never rejects. */
  analyse(raw: unknown, context: SerpJobContext): Promise<SerpSnapshot>;
  /** Ends every job and terminates the worker (the app is quitting). */
  dispose(): void;
}

interface Job {
  readonly id: number;
  readonly raw: unknown;
  readonly context: SerpJobContext;
  readonly settle: (snapshot: SerpSnapshot) => void;
}

/** Whether the worker's answer has a snapshot's shape. */
function isSnapshot(value: unknown): value is SerpSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === 'ready' || status === 'unreadable';
}

export function createSerpAnalyzer(options: SerpAnalyzerOptions): SerpAnalyzer {
  const timeoutMs = options.timeoutMs ?? SERP_ANALYSIS_TIMEOUT_MS;
  const queue: Job[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { job: Job; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;

  const unreadable = (job: Job, reason: SerpUnreadableReason): SerpSnapshot => ({ status: 'unreadable', reason, params: job.context.params, packVersion: job.context.packVersion });

  /** Settles the current job and moves on; `kill` also ends its worker (the next job spawns a new one). */
  const finish = (snapshot: (job: Job) => SerpSnapshot, kill: boolean): void => {
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
      const { id, result } = (message ?? {}) as { id?: unknown; result?: unknown };
      if (!current || current.worker !== created || current.job.id !== id) return;
      finish((job) => (isSnapshot(result) ? result : unreadable(job, 'invalid-answer')), false);
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
      running.postMessage({ id: job.id, raw: job.raw, params: job.context.params, packVersion: job.context.packVersion });
    } catch {
      // Not structured-cloneable: not a reader answer.
      job.settle(unreadable(job, 'invalid-answer'));
      pump();
      return;
    }
    current = { job, worker: running, timer: setTimeout(() => finish((timedOut) => unreadable(timedOut, 'timeout'), true), timeoutMs) };
  }

  return {
    analyse: (raw, context) =>
      new Promise<SerpSnapshot>((settle) => {
        queue.push({ id: nextId++, raw, context, settle });
        pump();
      }),
    dispose() {
      for (const job of queue.splice(0)) job.settle(unreadable(job, 'invalid-answer'));
      if (current) finish((job) => unreadable(job, 'invalid-answer'), true);
      if (worker) void worker.terminate().catch(() => undefined);
      worker = null;
    },
  };
}
