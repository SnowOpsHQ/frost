import type { PerformanceMeasurement, SpeedReport } from './model';
import { measurementFindings, summaryOf } from './rules';

// The page-speed part of the engine (Phase 2 Task 5; acceptance `seo-speed.feature.md`).

/** The Speed panel's report of a (validated) measurement: its summary and the measured `performance` findings. */
export function speedReport(m: PerformanceMeasurement): SpeedReport {
  const summary = summaryOf(m);
  return { ...summary, findings: measurementFindings(summary) };
}

export { extensionOf, fromCache, hostOf, isThirdParty, isUncompressedText, mimeOf, resourceType, siteOf, sizeUnavailable, weightOf } from './classify';
export { formatBytes, formatCls, formatMs, formatVital } from './format';
export { MEASURED_CHECKS, measurementFindings, PERFORMANCE_CHECKS } from './rules';
export { navigationReport, summariseSpeed, vitalBand } from './summary';
export {
  NAVIGATION_PHASES,
  type HostShare,
  type LargeResource,
  type NavigationPhase,
  type NavigationReport,
  type NavigationSpan,
  type NavigationTiming,
  type PerformanceMeasurement,
  type ResourceBreakdown,
  type ResourceRecord,
  type SpeedReport,
  type SpeedResponse,
  type SpeedSummary,
  type UncompressedResource,
  type VitalReading,
} from './model';
