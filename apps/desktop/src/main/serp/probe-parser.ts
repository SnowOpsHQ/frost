import { PROBE_LIMITS } from '@app/specs/visibility-probes.spec';
import type { ProbeJob, ProbeJobResult } from '@app/specs/visibility-probes.schema';
import type { AnalysisWorker } from '../seo/analysis';

// The probes' parse off Electron's main thread (spec `visibility-probes.spec.ts`, `PROBE_LIMITS`
// `parseTimeoutMs` and `maxQueuedJobs`; acceptance `visibility-probes.feature.md`,
// `probes-parse-in-worker`), as the SERP analyzer drives its worker: main posts each probe job
// (`{ id, kind: 'probe', job }`) to one long-lived SERP worker of the probes' own (`serp-worker.ts`,
// bundled as `serp-analysis.cjs`, so a page that is slow to parse never holds a SERP reading back),
// one at a time. Each job has a hard deadline, after which the worker is terminated and the next job
// spawns a new one; a worker that errors or exits fails its job. At most `maxQueued` jobs wait; one
// more fails at once. A job's `signal` (its run's: Stop, a new document, Clear Browsing Data) drops
// it from the queue, or, while it runs, ends it and terminates the worker, so a stopped run's jobs
// never fill the queue or hold the worker for the next run. After `dispose()` nothing is spawned again. A late answer from a terminated
// worker, or for another job, is dropped; an answer is checked for a job result's shape only (the
// worker validated it with the answer schemas; Zod stays off main's thread). Never rejects.

export interface ProbeParserOptions {
  /** Starts a worker running `serp-worker.ts` (main: `new Worker(…/serp-analysis.cjs)`). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
}

export interface ProbeParser {
  /** Runs `job` in the worker (`runProbeJob` there); `parse-failed` at once when `signal` aborts. Never rejects. */
  run(job: ProbeJob, signal?: AbortSignal): Promise<ProbeJobResult>;
  /** Ends every job and terminates the worker (the app is quitting). */
  dispose(): void;
}

interface Pending {
  readonly id: number;
  readonly job: ProbeJob;
  readonly settle: (result: ProbeJobResult) => void;
}

const FAILED: ProbeJobResult = { ok: false, reason: 'parse-failed' };

/** Whether the worker's answer has a job result's shape. */
function isResult(value: unknown): value is ProbeJobResult {
  if (typeof value !== 'object' || value === null) return false;
  const { ok, answer, reason } = value as { ok?: unknown; answer?: unknown; reason?: unknown };
  if (ok === false) return reason === 'invalid-job' || reason === 'parse-failed';
  if (ok !== true || typeof answer !== 'object' || answer === null) return false;
  const kind = (answer as { kind?: unknown }).kind;
  return kind === 'robots' || kind === 'page';
}

export function createProbeParser(options: ProbeParserOptions): ProbeParser {
  const timeoutMs = options.timeoutMs ?? PROBE_LIMITS.parseTimeoutMs;
  const maxQueued = options.maxQueued ?? PROBE_LIMITS.maxQueuedJobs;
  const queue: Pending[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { pending: Pending; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;
  let disposed = false;

  const finish = (result: ProbeJobResult, kill: boolean): void => {
    if (!current) return;
    const { pending, timer, worker: running } = current;
    clearTimeout(timer);
    current = null;
    if (kill) {
      if (worker === running) worker = null;
      void running.terminate().catch(() => undefined);
    }
    pending.settle(result);
    pump();
  };

  const spawn = (): AnalysisWorker => {
    const created = options.spawn();
    created.unref();
    created.on('message', (message) => {
      const { id, result } = (message ?? {}) as { id?: unknown; result?: unknown };
      if (!current || current.worker !== created || current.pending.id !== id) return;
      finish(isResult(result) ? result : FAILED, false);
    });
    const failed = (): void => {
      if (worker === created) worker = null;
      if (current && current.worker === created) finish(FAILED, true);
    };
    created.on('error', failed);
    created.on('exit', failed);
    return created;
  };

  function pump(): void {
    if (current || queue.length === 0) return;
    const pending = queue.shift()!;
    let running: AnalysisWorker;
    try {
      worker ??= spawn();
      running = worker;
      running.postMessage({ id: pending.id, kind: 'probe', job: pending.job });
    } catch {
      pending.settle(FAILED);
      pump();
      return;
    }
    current = { pending, worker: running, timer: setTimeout(() => finish(FAILED, true), timeoutMs) };
  }

  /** The job's run was stopped: out of the queue, or ended (its worker terminated) while it runs. */
  const aborted = (pending: Pending): void => {
    const index = queue.indexOf(pending);
    if (index >= 0) {
      queue.splice(index, 1);
      pending.settle(FAILED);
    } else if (current?.pending === pending) finish(FAILED, true);
  };

  return {
    run: (job, signal) =>
      new Promise<ProbeJobResult>((resolve) => {
        if (disposed || signal?.aborted || queue.length >= maxQueued) {
          resolve(FAILED);
          return;
        }
        const onAbort = (): void => aborted(pending);
        const pending: Pending = {
          id: nextId++,
          job,
          settle: (result) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(pending);
        pump();
      }),
    dispose() {
      disposed = true;
      for (const pending of queue.splice(0)) pending.settle(FAILED);
      if (current) finish(FAILED, true);
      if (worker) void worker.terminate().catch(() => undefined);
      worker = null;
    },
  };
}
