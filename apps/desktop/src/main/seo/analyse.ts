import { runAudit } from '@app/seo-core';
import type { AnalysisResult } from './analysis';
import { parseSnapshot } from './snapshot';

// What the analysis worker does with one extractor answer (acceptance `seo-schema.feature.md`,
// Analysis off the main thread): validate it as a snapshot (`PageSnapshotSchema`, strict, capped)
// and run the audit. Pure, with no Electron: the worker (`analysis-worker.ts`) runs it, never main.

/** The audit of `raw` if it is a valid snapshot; `invalid-snapshot` if not; `analysis-failed` if the audit threw. Never throws. */
export function analyseSnapshot(raw: unknown): AnalysisResult {
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return { ok: false, reason: 'invalid-snapshot' };
  try {
    return { ok: true, audit: runAudit(parsed.snapshot) };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
