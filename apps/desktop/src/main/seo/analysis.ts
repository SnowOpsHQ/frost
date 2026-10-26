import type { SeoAudit } from '@app/seo-core';
import { ANALYSIS_TIMEOUT_MS } from '@app/specs/seo-limits.spec';

// Page-derived analysis off the Electron main thread (spec `seo-limits.spec.ts`,
// `ANALYSIS_TIMEOUT_MS`; acceptance `seo-schema.feature.md`, Analysis off the main thread). Main posts
// each extractor answer to one long-lived worker (`analysis-worker.ts`), one at a time; each analysis
// has a hard timeout, after which the worker is terminated and the next analysis spawns a new one.

export type AnalysisResult = { readonly ok: true; readonly audit: SeoAudit } | { readonly ok: false; readonly reason: 'invalid-snapshot' | 'analysis-timeout' | 'analysis-failed' };

/** The parts of a `worker_threads` Worker the analyzer uses. */
export interface AnalysisWorker {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  /** Lets the app quit while the worker idles. */
  unref(): void;
}

export interface AnalyzerOptions {
  /** Starts a worker running `analysis-worker.ts` (main: `new Worker(…/seo-analysis.cjs)`). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
}

export interface Analyzer {
  /** Validates and audits an extractor answer in the worker. Never rejects. */
  analyse(raw: unknown): Promise<AnalysisResult>;
  /** Terminates the worker (the app is quitting). */
  dispose(): void;
}

interface Job {
  readonly id: number;
  readonly raw: unknown;
  readonly settle: (result: AnalysisResult) => void;
}

/** What the worker answered, if it has the shape of an analysis result. */
function asResult(value: unknown): AnalysisResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as { ok?: unknown; audit?: unknown; reason?: unknown };
  if (result.ok === true && typeof result.audit === 'object' && result.audit !== null) return result as AnalysisResult;
  if (result.ok === false && (result.reason === 'invalid-snapshot' || result.reason === 'analysis-failed')) return result as AnalysisResult;
  return null;
}

export function createAnalyzer(options: AnalyzerOptions): Analyzer {
  const timeoutMs = options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
  const queue: Job[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { job: Job; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;

  /** Settles the current job and moves on; `kill` also ends its worker (the next job spawns a new one). */
  const finish = (result: AnalysisResult, kill: boolean): void => {
    if (!current) return;
    const { job, timer, worker: running } = current;
    clearTimeout(timer);
    current = null;
    if (kill) {
      if (worker === running) worker = null;
      void running.terminate().catch(() => undefined);
    }
    job.settle(result);
    pump();
  };

  const spawn = (): AnalysisWorker => {
    const created = options.spawn();
    created.unref();
    created.on('message', (message) => {
      const { id, result } = (message ?? {}) as { id?: unknown; result?: unknown };
      if (!current || current.worker !== created || current.job.id !== id) return;
      finish(asResult(result) ?? { ok: false, reason: 'analysis-failed' }, false);
    });
    const failed = () => {
      if (worker === created) worker = null;
      if (current && current.worker === created) finish({ ok: false, reason: 'analysis-failed' }, true);
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
      job.settle({ ok: false, reason: 'analysis-failed' });
      pump();
      return;
    }
    try {
      running.postMessage({ id: job.id, raw: job.raw });
    } catch {
      // Not structured-cloneable: not a snapshot.
      job.settle({ ok: false, reason: 'invalid-snapshot' });
      pump();
      return;
    }
    current = { job, worker: running, timer: setTimeout(() => finish({ ok: false, reason: 'analysis-timeout' }, true), timeoutMs) };
  }

  return {
    analyse: (raw) =>
      new Promise<AnalysisResult>((settle) => {
        queue.push({ id: nextId++, raw, settle });
        pump();
      }),
    dispose() {
      for (const job of queue.splice(0)) job.settle({ ok: false, reason: 'analysis-failed' });
      if (current) finish({ ok: false, reason: 'analysis-failed' }, true);
      if (worker) void worker.terminate().catch(() => undefined);
      worker = null;
    },
  };
}
