import type { SeoAudit, SpeedReport } from '@app/seo-core';
import type { ServedParseInput, ServedParseResult } from '@app/specs/seo-javascript.schema';
import { ANALYSIS_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import type { RobotsVerdictsResult } from '../devtools/robots-verdicts';

// Page-derived analysis off the Electron main thread (spec `seo-limits.spec.ts`,
// `ANALYSIS_TIMEOUT_MS`; acceptance `seo-schema.feature.md`, Analysis off the main thread). Main posts
// each extractor answer to one long-lived worker (`analysis-worker.ts`), one at a time; each analysis
// has a hard timeout, after which the worker is terminated and the next analysis spawns a new one.
// Speed measurements (`seo-speed.feature.md`) go through the same worker and queue, as `speed` jobs,
// and so does the served HTML's parse (`seo-javascript.feature.md`), as `served` jobs, and the
// devtools drawer's robots.txt verdicts (`devtools.feature.md`), as `robots` jobs.

export type AnalysisResult = { readonly ok: true; readonly audit: SeoAudit } | { readonly ok: false; readonly reason: 'invalid-snapshot' | 'analysis-timeout' | 'analysis-failed' };
export type SpeedAnalysisResult = { readonly ok: true; readonly report: SpeedReport } | { readonly ok: false; readonly reason: 'invalid-measurement' | 'analysis-timeout' | 'analysis-failed' };

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
  /** Validates and audits an extractor answer (with what main collected beside it, `PageContext`) in the worker. Never rejects. */
  analyse(raw: unknown, context?: unknown): Promise<AnalysisResult>;
  /** Validates and summarises a speed measurement (`PerformanceMeasurementSchema`) in the worker. Never rejects. */
  analyseSpeed(raw: unknown): Promise<SpeedAnalysisResult>;
  /** Parses served HTML into a served snapshot in the worker (`served-parse.ts`; `parse-timeout` past the timeout). Never rejects. */
  parseServed(input: ServedParseInput): Promise<ServedParseResult>;
  /** Validates a robots.txt verdict job (`RobotsVerdictJobSchema`) and decides its URLs in the worker. Never rejects. */
  robotsVerdicts(raw: unknown): Promise<RobotsVerdictsResult>;
  /** Terminates the worker (the app is quitting). */
  dispose(): void;
}

type JobKind = 'audit' | 'speed' | 'served' | 'robots';
type Settled = { readonly ok: boolean; readonly reason?: string };

interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly raw: unknown;
  readonly context: unknown;
  readonly settle: (result: Settled) => void;
}

/** The reason a job's input is refused with. */
const INVALID: Readonly<Record<JobKind, string>> = { audit: 'invalid-snapshot', speed: 'invalid-measurement', served: 'parse-failed', robots: 'invalid-job' };

/** The field a job kind's successful result carries its payload in. */
const PAYLOAD: Readonly<Record<JobKind, string>> = { audit: 'audit', speed: 'report', served: 'snapshot', robots: 'verdicts' };

/** What the worker answered, if it has the shape of a `kind` job's result. */
function asResult(kind: JobKind, value: unknown): Settled | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as { ok?: unknown; reason?: unknown } & Record<string, unknown>;
  const payload = result[PAYLOAD[kind]];
  if (result.ok === true && typeof payload === 'object' && payload !== null) return result as Settled;
  if (result.ok === false && (result.reason === INVALID[kind] || result.reason === 'analysis-failed')) return result as Settled;
  return null;
}

export function createAnalyzer(options: AnalyzerOptions): Analyzer {
  const timeoutMs = options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
  const queue: Job[] = [];
  let worker: AnalysisWorker | null = null;
  let current: { job: Job; worker: AnalysisWorker; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;

  /** Settles the current job and moves on; `kill` also ends its worker (the next job spawns a new one). */
  const finish = (result: Settled, kill: boolean): void => {
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
      finish(asResult(current.job.kind, result) ?? { ok: false, reason: 'analysis-failed' }, false);
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
      running.postMessage(job.kind === 'audit' ? { id: job.id, raw: job.raw, context: job.context } : { id: job.id, kind: job.kind, raw: job.raw });
    } catch {
      // Not structured-cloneable: not a snapshot (or measurement).
      job.settle({ ok: false, reason: INVALID[job.kind] });
      pump();
      return;
    }
    current = { job, worker: running, timer: setTimeout(() => finish({ ok: false, reason: 'analysis-timeout' }, true), timeoutMs) };
  }

  const enqueue = (kind: JobKind, raw: unknown, context: unknown): Promise<Settled> =>
    new Promise<Settled>((settle) => {
      queue.push({ id: nextId++, kind, raw, context, settle });
      pump();
    });

  return {
    analyse: (raw, context) => enqueue('audit', raw, context) as Promise<AnalysisResult>,
    analyseSpeed: (raw) => enqueue('speed', raw, undefined) as Promise<SpeedAnalysisResult>,
    parseServed: (input) =>
      enqueue('served', input, undefined).then((result): ServedParseResult => (result.ok ? (result as ServedParseResult) : { ok: false, reason: result.reason === 'analysis-timeout' ? 'parse-timeout' : 'parse-failed' })),
    robotsVerdicts: (raw) => enqueue('robots', raw, undefined) as Promise<RobotsVerdictsResult>,
    dispose() {
      for (const job of queue.splice(0)) job.settle({ ok: false, reason: 'analysis-failed' });
      if (current) finish({ ok: false, reason: 'analysis-failed' }, true);
      if (worker) void worker.terminate().catch(() => undefined);
      worker = null;
    },
  };
}
