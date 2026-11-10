import { AI_SEARCH_LIMITS } from '@app/specs/ai-search.spec';
import type { AiAnswerJob, AiAnswerJobResult } from '@app/specs/ai-search.schema';
import type { AnalysisWorker } from '../seo/analysis';

// The AI answers' parse off Electron's main thread (Phase 12 Task 8; spec `ai-search.spec.ts`,
// `AI_SEARCH_LIMITS.parseTimeoutMs` / `maxQueuedJobs`; plan Global constraints "Untrusted text"), as
// the probes' parser drives its worker: main posts each `{ id, kind: 'ai-answer', job }` to one
// long-lived SERP worker of AI search's own (`serp-worker.ts`, bundled as `serp-analysis.cjs`), one at
// a time. Each job has a hard deadline, after which the worker is terminated and the next job spawns a
// new one; a worker that errors or exits fails its job. At most `maxQueued` jobs wait; one more fails
// at once. After `dispose()` nothing is spawned again. A late answer, or one for another job, is
// dropped; an answer is checked for a result's shape only (the worker validated it with
// `AiAnswerParsedSchema`; Zod stays off main's thread). Never rejects.

export interface AiAnswerParserOptions {
  /** Starts a worker running `serp-worker.ts` (main: `new Worker(…/serp-analysis.cjs)`). */
  readonly spawn: () => AnalysisWorker;
  readonly timeoutMs?: number;
  readonly maxQueued?: number;
}

export interface AiAnswerParser {
  /** Runs `job` in the worker (`runAiAnswerJob` there). Never rejects. */
  parse(job: AiAnswerJob): Promise<AiAnswerJobResult>;
  /** Ends every job and terminates the worker (the app is quitting). */
  dispose(): void;
}

interface Pending {
  readonly id: number;
  readonly job: AiAnswerJob;
  readonly settle: (result: AiAnswerJobResult) => void;
}

const FAILED: AiAnswerJobResult = { ok: false };

/** Whether the worker's answer has a job result's shape. */
function isResult(value: unknown): value is AiAnswerJobResult {
  if (typeof value !== 'object' || value === null) return false;
  const { ok, answer } = value as { ok?: unknown; answer?: unknown };
  if (ok === false) return true;
  if (ok !== true || typeof answer !== 'object' || answer === null) return false;
  const { answer: text, citations, answerTruncated, citationsTotal } = answer as Record<string, unknown>;
  return typeof text === 'string' && Array.isArray(citations) && typeof answerTruncated === 'boolean' && typeof citationsTotal === 'number';
}

export function createAiAnswerParser(options: AiAnswerParserOptions): AiAnswerParser {
  const timeoutMs = options.timeoutMs ?? AI_SEARCH_LIMITS.parseTimeoutMs;
  const maxQueued = options.maxQueued ?? AI_SEARCH_LIMITS.maxQueuedJobs;
  const queue: Pending[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { pending: Pending; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;
  let disposed = false;

  const finish = (result: AiAnswerJobResult, kill: boolean): void => {
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
      running.postMessage({ id: pending.id, kind: 'ai-answer', job: pending.job });
    } catch {
      pending.settle(FAILED);
      pump();
      return;
    }
    current = { pending, worker: running, timer: setTimeout(() => finish(FAILED, true), timeoutMs) };
  }

  return {
    parse: (job) =>
      new Promise<AiAnswerJobResult>((resolve) => {
        if (disposed || queue.length >= maxQueued) {
          resolve(FAILED);
          return;
        }
        queue.push({ id: nextId++, job, settle: resolve });
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
