import type { LlmsTxtJob, LlmsTxtJobResult } from '@app/specs/ai-readiness.schema';
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
// never fill the queue or hold the worker for the next run. A run's `/llms.txt` (Phase 9) is an
// `llms-txt` job in the same queue (`{ id, kind: 'llms-txt', job }`), under the same deadline and
// limits. After `dispose()` nothing is spawned again. A late answer from a terminated
// worker, or for another job, is dropped; an answer is checked for a job result's shape only (the
// worker validated it with the answer schemas; Zod stays off main's thread). Never rejects.

export interface ProbeParserOptions {
  /** Starts a worker running `serp-worker.ts` (main: `new Worker(…/serp-analysis.cjs)`). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
}

export interface ProbeParser {
  /** Runs `job` in the worker (`runProbeJob` / `runLlmsTxtJob` there); `parse-failed` at once when `signal` aborts. Never rejects. */
  run(job: ProbeJob | LlmsTxtJob, signal?: AbortSignal): Promise<ProbeJobResult | LlmsTxtJobResult>;
  /** Ends every job and terminates the worker (the app is quitting). */
  dispose(): void;
}

type Job = ProbeJob | LlmsTxtJob;
type Result = ProbeJobResult | LlmsTxtJobResult;

interface Pending {
  readonly id: number;
  readonly job: Job;
  readonly settle: (result: Result) => void;
}

const FAILED: Result = { ok: false, reason: 'parse-failed' };

/** Whether the worker's answer has a job result's shape. */
function isResult(value: unknown): value is Result {
  if (typeof value !== 'object' || value === null) return false;
  const { ok, answer, reason } = value as { ok?: unknown; answer?: unknown; reason?: unknown };
  if (ok === false) return reason === 'invalid-job' || reason === 'parse-failed';
  if (ok !== true || typeof answer !== 'object' || answer === null) return false;
  const kind = (answer as { kind?: unknown }).kind;
  return kind === 'robots' || kind === 'page' || kind === 'llms-txt';
}

export function createProbeParser(options: ProbeParserOptions): ProbeParser {
  const timeoutMs = options.timeoutMs ?? PROBE_LIMITS.parseTimeoutMs;
  const maxQueued = options.maxQueued ?? PROBE_LIMITS.maxQueuedJobs;
  const queue: Pending[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { pending: Pending; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;
  let disposed = false;

  const finish = (result: Result, kill: boolean): void => {
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
      running.postMessage({ id: pending.id, kind: pending.job.kind === 'llms-txt' ? 'llms-txt' : 'probe', job: pending.job });
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
      new Promise<Result>((resolve) => {
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
