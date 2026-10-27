import { runAudit, speedReport } from '@app/seo-core';
import { NO_PAGE_CONTEXT } from '@app/specs/seo-snapshot.spec';
import { ServedStateSchema, type ServedState } from '@app/specs/seo-javascript.schema';
import { PerformanceMeasurementSchema, type PerformanceMeasurement } from '@app/specs/seo-speed.schema.spec';
import type { AnalysisResult, SpeedAnalysisResult } from './analysis';
import { parseContext, parseSnapshot } from './snapshot';

// What the analysis worker does with one extractor answer (acceptance `seo-schema.feature.md`,
// Analysis off the main thread): validate it as a snapshot (`PageSnapshotSchema`, strict, capped),
// validate what main collected beside it (`PageContextSchema`: the response and robots.txt,
// `seo-indexability.feature.md`; the speed measurement, `seo-speed.feature.md`), and run the audit
// on both. And with one speed measurement (`analyseSpeed`): validate it
// (`PerformanceMeasurementSchema`) and summarise it. The served HTML's state (Phase 2.5 Task 2,
// `seo-javascript.feature.md`) is validated on its own too (`ServedStateSchema`). Pure, with no Electron: the worker
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

/**
 * The served HTML's state (Phase 2.5 Task 2, `ServedStateSchema`, strict, capped); `null` when there
 * is none; `unavailable` / `invalid` when it does not parse. Never throws.
 */
export function parseServedState(raw: unknown): ServedState | null {
  if (raw === undefined || raw === null) return null;
  try {
    const parsed = ServedStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    // A getter that throws: not a served state.
  }
  return { status: 'unavailable', reason: 'invalid', httpStatus: null, finalUrl: null };
}

/**
 * The context without its `performance` and `served` parts, and those parts (each validated on its
 * own: an invalid measurement is dropped, `null`; an invalid served state is `unavailable`).
 */
function splitContext(context: unknown): { rest: unknown; performance: PerformanceMeasurement | null; served: ServedState | null } {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return { rest: context, performance: null, served: null };
  const { performance, served, ...rest } = context as Record<string, unknown>;
  if (!Object.hasOwn(context, 'performance') && !Object.hasOwn(context, 'served')) return { rest: context, performance: null, served: null };
  return { rest, performance: Object.hasOwn(context, 'performance') ? parseMeasurement(performance) : null, served: parseServedState(served) };
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
    return { ok: true, audit: runAudit({ ...parsed.snapshot, ...collected, performance: split.performance, served: split.served }) };
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
