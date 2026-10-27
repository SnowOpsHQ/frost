import { runAudit, speedReport } from '@app/seo-core';
import { NO_PAGE_CONTEXT } from '@app/specs/seo-snapshot.spec';
import { PerformanceMeasurementSchema, type PerformanceMeasurement } from '@app/specs/seo-speed.schema.spec';
import type { AnalysisResult, SpeedAnalysisResult } from './analysis';
import { parseContext, parseSnapshot } from './snapshot';

// What the analysis worker does with one extractor answer (acceptance `seo-schema.feature.md`,
// Analysis off the main thread): validate it as a snapshot (`PageSnapshotSchema`, strict, capped),
// validate what main collected beside it (`PageContextSchema`: the response and robots.txt,
// `seo-indexability.feature.md`; the speed measurement, `seo-speed.feature.md`), and run the audit
// on both. And with one speed measurement (`analyseSpeed`): validate it
// (`PerformanceMeasurementSchema`) and summarise it. Pure, with no Electron: the worker
// (`analysis-worker.ts`) runs it, never main.

/** `raw` as a measurement if it parses with `PerformanceMeasurementSchema` (strict, capped), else `null`; never throws. */
export function parseMeasurement(raw: unknown): PerformanceMeasurement | null {
  try {
    const parsed = PerformanceMeasurementSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The context without its `performance` part, and that part (validated on its own: an invalid one is dropped, `null`). */
function splitContext(context: unknown): { rest: unknown; performance: PerformanceMeasurement | null } {
  if (typeof context !== 'object' || context === null || Array.isArray(context) || !Object.hasOwn(context, 'performance')) return { rest: context, performance: null };
  const { performance, ...rest } = context as Record<string, unknown>;
  return { rest, performance: parseMeasurement(performance) };
}

/**
 * The audit of `raw` (with `context`, if given) if both are valid; `invalid-snapshot` if not;
 * `analysis-failed` if the audit threw. Never throws. The context's speed measurement is checked
 * on its own: an invalid one is left out (no measured rule fails), the audit still runs.
 */
export function analyseSnapshot(raw: unknown, context: unknown = NO_PAGE_CONTEXT): AnalysisResult {
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return { ok: false, reason: 'invalid-snapshot' };
  let split: ReturnType<typeof splitContext>;
  try {
    split = splitContext(context);
  } catch {
    return { ok: false, reason: 'invalid-snapshot' };
  }
  const collected = parseContext(split.rest);
  if (collected === null) return { ok: false, reason: 'invalid-snapshot' };
  try {
    return { ok: true, audit: runAudit({ ...parsed.snapshot, ...collected, performance: split.performance }) };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}

/** The Speed panel's report of `raw` if it is a valid measurement; `invalid-measurement` if not; `analysis-failed` if summarising threw. Never throws. */
export function analyseSpeed(raw: unknown): SpeedAnalysisResult {
  const measurement = parseMeasurement(raw);
  if (measurement === null) return { ok: false, reason: 'invalid-measurement' };
  try {
    return { ok: true, report: speedReport(measurement) };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
