import { runAudit } from '@app/seo-core';
import { NO_PAGE_CONTEXT } from '@app/specs/seo-snapshot.spec';
import type { AnalysisResult } from './analysis';
import { parseContext, parseSnapshot } from './snapshot';

// What the analysis worker does with one extractor answer (acceptance `seo-schema.feature.md`,
// Analysis off the main thread): validate it as a snapshot (`PageSnapshotSchema`, strict, capped),
// validate what main collected beside it (`PageContextSchema`: the response and robots.txt,
// `seo-indexability.feature.md`), and run the audit on both. Pure, with no Electron: the worker
// (`analysis-worker.ts`) runs it, never main.

/**
 * The audit of `raw` (with `context`, if given) if both are valid; `invalid-snapshot` if not;
 * `analysis-failed` if the audit threw. Never throws.
 */
export function analyseSnapshot(raw: unknown, context: unknown = NO_PAGE_CONTEXT): AnalysisResult {
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return { ok: false, reason: 'invalid-snapshot' };
  const collected = parseContext(context);
  if (collected === null) return { ok: false, reason: 'invalid-snapshot' };
  try {
    return { ok: true, audit: runAudit({ ...parsed.snapshot, ...collected }) };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
